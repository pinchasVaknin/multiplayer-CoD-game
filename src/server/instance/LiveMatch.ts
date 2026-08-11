import { nowMs } from '../../shared/core/Clock';
import { DT } from '../../shared/core/Loop';
import { logger } from '../../shared/core/Log';
import type { SummaryInfo, SummaryRow, SummaryXpLine } from '../../shared/net/Messages';
import { InstanceState, type MatchId } from '../../shared/net/Skirmish';
import { findMap, findMode } from '../../shared/modes/ModeRegistry';
import type { BotTier } from '../../shared/ai/DifficultyTiers';
import { ServerMatch } from '../Match';
import type { MapBakery } from '../MapBakery';
import { MatchInstance, type MatchInstanceDeps } from './MatchInstance';

const log = logger('live');

/**
 * A voted match: created on demand, destroyed when it ends (M11, §4.18).
 *
 * ```
 * ALLOCATING -> LOADING -> READY_WAIT -> RUNNING -> ENDED -> DESTROYED
 * ```
 *
 * The states are not decoration. Each one is a place the flow can fail differently, and §4.18
 * specifies a different recovery for each:
 *
 * - **`ALLOCATING`** — the allocator has been asked. Nothing exists yet; players are still in
 *   the arena and still playing. Failure here leaves everyone where they are, with a message.
 *   This instance object does not exist during that state, which is the honest encoding: the
 *   allocator returns a handle or it rejects, and a rejected allocation has nothing to observe.
 * - **`LOADING`** — the sim is constructed over pre-baked map data and bots are spawned.
 *   *"This is instantiation, not baking, and it must not take perceptible time."*
 * - **`READY_WAIT`** — clients build meshes in the background while still playing warmup. The
 *   instance waits, **with a timeout**. *"A server that waits indefinitely on one slow client
 *   is a server that is stuck."*
 * - **`RUNNING`** — the match.
 * - **`ENDED`** — the summary and the XP award are delivered and held for 12-15 s.
 * - **`DESTROYED`** — every player migrated back, the instance released.
 *
 * ## Why the sim is built in the constructor and not in `LOADING`
 *
 * It is built in the constructor and the constructor *is* `LOADING` — the state is set at the
 * top and cleared at the bottom. Splitting them would give this class a window in which it
 * exists and has no world, and every method would have to be written against a `match` that
 * might be null. The pre-bake (§4.19) is what makes that affordable: construction is
 * allocation and spawning, not two flood fills.
 */

export interface LiveMatchOptions {
  readonly id: MatchId;
  readonly bakery: MapBakery;
  readonly mapId: string;
  readonly modeId: string;
  readonly snapshotHz: number;
  readonly interpolationDelayMs: number;
  readonly seed: number;
  readonly startTick: number;
  readonly botTier: BotTier | 'MIX';
  /** How long `READY_WAIT` waits before starting without a slow client, ms (§4.18). */
  readonly readyTimeoutMs: number;
  /** Seconds the summary is held before everybody goes back (§6.9: 12-15 s). */
  readonly summaryHoldSeconds: number;
  /** Shorten both match clocks, seconds. Zero uses the mode's authored length. Harness only. */
  readonly roundSecondsOverride: number;
}

export class LiveMatch extends MatchInstance {
  readonly mapId: string;
  readonly modeId: string;

  private readonly options: LiveMatchOptions;
  private readyWaitStartedMs = 0;
  private endedAtTick = -1;
  private summarySent = false;
  private summary: SummaryInfo | null = null;

  /** Player ids whose background build has reported in. Answers `READY_WAIT`. */
  private readonly ready = new Set<number>();

  /** Player ids that were expected to report and did not, before the timeout. */
  private readonly timedOut = new Set<number>();

  /** The tick the match went live. `RUNNING` starts here, so mode clocks start here. */
  runningSinceTick = -1;

  constructor(options: LiveMatchOptions) {
    super(buildDeps(options));
    this.options = options;
    this.mapId = options.mapId;
    this.modeId = options.modeId;

    // Construction *is* LOADING. See the class comment.
    this.setState(InstanceState.LOADING, 'building the sim over pre-baked map data');
    const entry = findMap(options.mapId);
    const mode = findMode(asModeId(options.modeId));
    log.info(
      `match ${options.id}: ${mode.name} on ${entry.name}, ` +
        `${this.match.bots.bots.length} bots at ${options.botTier}, seed ${options.seed}.`,
    );
    this.setState(InstanceState.READY_WAIT, 'waiting on client background builds');
    this.readyWaitStartedMs = nowMs();
  }

  /** Whether the readiness window is open. The router answers `Ready` only while it is. */
  get awaitingReadiness(): boolean {
    return this.state === InstanceState.READY_WAIT;
  }

  /**
   * A client has finished building this map's meshes and textures (§6.5).
   *
   * Idempotent, because a client that misses a `Prepare` and receives a retransmit will report
   * twice, and because the readiness set is also consulted after the timeout has fired.
   */
  noteReady(playerId: number): void {
    this.ready.add(playerId);
    this.timedOut.delete(playerId);
  }

  /**
   * Whether everybody expected has reported, or the timeout has expired.
   *
   * `expected` is passed in rather than read from `seats`, because during `READY_WAIT` the
   * players are still seated in the **warmup arena** — that is the entire point of the design.
   * Asking this instance who it is waiting for would return zero and start the match instantly.
   */
  readinessSettled(expected: readonly number[]): { settled: boolean; timedOut: number[] } {
    const missing = expected.filter((id) => !this.ready.has(id));
    if (missing.length === 0) return { settled: true, timedOut: [] };

    const waitedMs = nowMs() - this.readyWaitStartedMs;
    if (waitedMs < this.options.readyTimeoutMs) return { settled: false, timedOut: [] };

    /**
     * The timeout fired. Start anyway (§4.18).
     *
     * *"A client that has not reported ready when the timeout expires is migrated anyway and
     * shows its own loading screen until it finishes."* The alternative is a server whose
     * match start is gated on the slowest machine anybody happens to be using, which on
     * integrated graphics is a real and unbounded number.
     */
    for (const id of missing) this.timedOut.add(id);
    log.warn(
      `match ${this.id}: ready timeout after ${Math.round(waitedMs)}ms — ` +
        `starting without ${missing.length} client(s): ${missing.join(', ')}.`,
    );
    return { settled: true, timedOut: missing };
  }

  /** How many readiness timeouts this match fired. Reported by §7's migration log. */
  get timeoutCount(): number {
    return this.timedOut.size;
  }

  /** Move from `READY_WAIT` to `RUNNING`. Called once, by the flow, after migration. */
  begin(absoluteTick: number): void {
    if (this.state !== InstanceState.READY_WAIT) return;
    this.runningSinceTick = absoluteTick;
    this.setState(InstanceState.RUNNING, 'all clients ready or timed out');
  }

  /**
   * Step, and notice the tick the match ends on.
   *
   * The forced snapshot on that exact tick is in `MatchInstance.step` — see the Tier 2 §A
   * comment there. What happens *here* is the state transition, and the order matters: the
   * base class checks `state === RUNNING && match.isOver` to decide whether to force, so this
   * must move to `ENDED` only **after** `super.step` has had its chance to send.
   */
  override step(absoluteTick: number): void {
    super.step(absoluteTick);
    if (this.state === InstanceState.RUNNING && this.match.isOver) {
      this.endedAtTick = absoluteTick;
      this.setState(InstanceState.ENDED, `win condition fired on tick ${absoluteTick}`);
    }
  }

  /**
   * Whether the summary hold has elapsed and everybody can go back to the arena (§6.9).
   *
   * Takes the **master** tick rather than reading this instance's own clock, and that is not a
   * style choice — it is a deadlock fix. An `ENDED` instance is no longer `RUNNING`, so
   * `Server.stepInstance` skips it and `InstanceClock.advance` is never called again. A hold
   * measured against `this.clock.absoluteTick` therefore compares a frozen number against a
   * deadline it can never reach: the summary is sent, and every player sits on it forever with
   * the arena still running underneath them.
   *
   * Found by the flow harness on its first end-to-end run, where the match ended at 32 s and
   * nothing happened for the remaining 70 s of the budget.
   */
  summaryElapsed(masterTick: number): boolean {
    if (this.state !== InstanceState.ENDED || this.endedAtTick < 0) return false;
    return (masterTick - this.endedAtTick) * DT >= this.options.summaryHoldSeconds;
  }

  /**
   * Build the end-of-match summary, once (§6.9).
   *
   * *"XP and challenge progress are awarded by the instance from authoritative events and
   * delivered with the summary, **before teardown**."* Before teardown is not a nicety: the
   * scoreboard rows live in `ScoreSystem`, which `ServerMatch.dispose` releases, so a summary
   * built after `destroy()` would be built from nothing and would report a match of zeroes.
   */
  buildSummary(): SummaryInfo {
    const existing = this.summary;
    if (existing !== null) return existing;

    const outcome = this.match.outcome();
    const rows: SummaryRow[] = [];
    for (const row of this.match.score.rows) {
      rows.push({
        entityId: row.entityId,
        displayName: row.displayName,
        team: row.team === 'B' ? 'B' : 'A',
        kills: row.kills,
        deaths: row.deaths,
        assists: row.assists,
        score: row.score,
        // A bot is anything the roster holds that no session is seated on. Derived rather than
        // stored, so a human who disconnects mid-match is correctly shown as the human they
        // were rather than being relabelled by whatever replaced them.
        isBot: !this.hasSeatOnEntity(row.entityId),
      });
    }
    rows.sort((a, b) => b.score - a.score);

    const built: SummaryInfo = {
      matchId: this.id,
      mapId: this.mapId,
      modeId: this.modeId,
      winner: outcome?.winner ?? 'DRAW',
      reason: outcome?.reason ?? 'Match ended',
      scoreA: outcome?.scoreA ?? 0,
      scoreB: outcome?.scoreB ?? 0,
      rows,
      xp: buildXpLines(outcome?.winner ?? 'DRAW', rows),
      holdSeconds: this.options.summaryHoldSeconds,
    };
    this.summary = built;
    return built;
  }

  get summaryAlreadySent(): boolean {
    return this.summarySent;
  }

  markSummarySent(): void {
    this.summarySent = true;
  }

  private hasSeatOnEntity(entityId: number): boolean {
    for (const seat of this.sessions) {
      if (seat.player.entityId === entityId) return true;
    }
    return false;
  }

  /** Mark this instance unusable after its step threw (§4.18). Its players go back. */
  fail(why: string): void {
    this.setState(InstanceState.FAILED, why);
  }

  override dispose(): void {
    this.ready.clear();
    this.timedOut.clear();
    this.summary = null;
    super.dispose();
  }
}

/**
 * The XP breakdown the M6 bar animates.
 *
 * Computed from the authoritative scoreboard rather than accumulated during the match, which
 * is the difference between a number the server can defend and a counter that drifts. The
 * client persists the total to its own `localStorage` save (§6.9) — there is no server-side
 * database and there will not be one.
 *
 * The per-player half is filled in by the caller, which knows which row belongs to which
 * client; these are the lines every player in the match shares.
 */
function buildXpLines(winner: string, rows: readonly SummaryRow[]): SummaryXpLine[] {
  const lines: SummaryXpLine[] = [];
  lines.push({ label: 'MATCH COMPLETE', amount: 500 });
  if (winner !== 'DRAW') lines.push({ label: 'WIN BONUS', amount: 250 });
  const best = rows[0];
  if (best !== undefined && best.kills > 0) {
    lines.push({ label: 'TOP OPERATOR', amount: 100 });
  }
  return lines;
}

function buildDeps(options: LiveMatchOptions): MatchInstanceDeps {
  const match = new ServerMatch({
    mapId: options.mapId,
    modeId: options.modeId,
    // The mode's authored roster decides the count (§6.7: 10 for TDM/DOM/KC/SND, 8 for FFA).
    // `bots` is the fallback for a mode that authors none, and every mode on the ballot does.
    bots: 10,
    tier: options.botTier,
    seed: options.seed,
    startTick: options.startTick,
    baked: options.bakery.instanceView(options.mapId),
    // Puts S&D on its best-of-5 with the swap at round 3 (§6.4).
    variant: 'SKIRMISH',
    // Zero means "use the authored length". Passed as undefined rather than 0 so `MatchFlow`
    // and every mode take the same "no override" branch they take in a normal build.
    roundSecondsOverride: options.roundSecondsOverride > 0 ? options.roundSecondsOverride : undefined,
  });

  return {
    id: options.id,
    // Index 1: one send interval clear of the arena, so the two instances never serialise on
    // the same tick (§4.19).
    instanceIndex: 1,
    match,
    snapshotHz: options.snapshotHz,
    interpolationDelayMs: options.interpolationDelayMs,
    startTick: options.startTick,
  };
}

function asModeId(id: string): Parameters<typeof findMode>[0] {
  return id as Parameters<typeof findMode>[0];
}
