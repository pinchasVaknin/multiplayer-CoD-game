import { nowMs } from '../../shared/core/Clock';
import { DT } from '../../shared/core/Loop';
import { logger } from '../../shared/core/Log';
import { compareRows } from '../../shared/combat/ScoreSystem';
import type { SummaryInfo, SummaryRow, SummaryXpLine } from '../../shared/net/Messages';
import { InstanceState, type MatchId } from '../../shared/net/Skirmish';
import { findMap, findMode } from '../../shared/modes/ModeRegistry';
import { isMvp, wonBy } from '../../shared/modes/MatchOutcome';
import { MatchLedger } from '../../shared/meta/MatchLedger';
import { xpSourceIndex } from '../../shared/meta/XpRules';
import type { BotDifficulty } from '../../shared/ai/DifficultyTiers';
import { ServerMatch } from '../Match';
import type { MapBakery } from '../MapBakery';
import type { Session } from '../net/Session';
import { MatchInstance, type MatchInstanceDeps, type Seat, type UnseatCause } from './MatchInstance';

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
  readonly botTier: BotDifficulty;
  /** How long `READY_WAIT` waits before starting without a slow client, ms (§4.18). */
  readonly readyTimeoutMs: number;
  /** Seconds the summary is held before everybody goes back (§6.9: 12-15 s). */
  readonly summaryHoldSeconds: number;
  /** Shorten both match clocks, seconds. Zero uses the mode's authored length. Harness only. */
  readonly roundSecondsOverride: number;
}

export class LiveMatch extends MatchInstance {
  /** A match a ballot elected, however much it looks like the arena. See `MatchInstance.isArena`. */
  override readonly isArena = false;

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

  /**
   * Whether a human has ever been seated here (§4.9, capacity).
   *
   * The teardown rule below is *"a match that has lost all its humans is a match nobody is
   * playing"*, and that is a different statement from *"a match with no humans in it"* — the
   * second is also true of an instance in the seconds between allocation and migration, and of
   * the one `allocateAndDestroyForLeakTest` builds deliberately empty. Latching on the first
   * seat is what separates *emptied* from *not yet filled*, without a timer that would have to
   * be tuned against migration latency.
   */
  private everSeated = false;

  /** True once every human who was here has gone. See `Server.stepFlow`. */
  get abandoned(): boolean {
    return this.everSeated && this.playerCount === 0;
  }

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
    return masterTick >= this.summaryEndsTick;
  }

  /**
   * The master tick the hold expires on — the deadline the summary screen counts down to
   * (playtest round 4, B4).
   *
   * The same number `summaryElapsed` decides on, rather than a second expression of it. The
   * client used to be sent `holdSeconds` and integrate a local `dt` against it, which is a
   * second clock for the one fact the server already owns: it could start late, drift, keep
   * counting through a lost connection, and had no way of being right for a player who reached
   * the screen a frame after the message that opened it.
   */
  get summaryEndsTick(): number {
    return this.endedAtTick + Math.round(this.options.summaryHoldSeconds / DT);
  }

  /**
   * Build the end-of-match summary's common half, once (§6.9).
   *
   * *"XP and challenge progress are awarded by the instance from authoritative events and
   * delivered with the summary, **before teardown**."* Before teardown is not a nicety: the
   * scoreboard rows live in `ScoreSystem`, which `ServerMatch.dispose` releases, so a summary
   * built after `destroy()` would be built from nothing and would report a match of zeroes.
   *
   * The rows are the board as it stands — the same set every client has been replicated all
   * match (M13 Phase B) — so there is no filtering left to do here: a bot replaced before the
   * first shot lost its row when it lost its seat. The XP is *not* here; it is per recipient,
   * see `buildSummaryFor`.
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
    rows.sort(compareRows);

    const built: SummaryInfo = {
      matchId: this.id,
      mapId: this.mapId,
      modeId: this.modeId,
      winner: outcome?.winner ?? 'DRAW',
      winnerEntityId: outcome?.winnerEntityId,
      reason: outcome?.reason ?? 'Match ended',
      scoreA: outcome?.scoreA ?? 0,
      scoreB: outcome?.scoreB ?? 0,
      rows,
      // The common half carries no XP. A recipient's lines are theirs alone.
      xp: [],
      endsTick: this.summaryEndsTick,
    };
    this.summary = built;
    return built;
  }

  /**
   * The summary as one seat receives it (M13 Phase B, bug 4.2).
   *
   * The common half plus this seat's own XP: the lines its `MatchLedger` counted, with the win
   * and the MVP decided for *this* entity — `wonBy` over the result, which in Free-for-All names
   * one individual, and `isMvp` over the final rows, ties to nobody. Before this every seat was
   * sent one list: `MATCH COMPLETE`, a `WIN BONUS` to everybody and a `TOP OPERATOR` to everybody,
   * and nothing for a kill.
   *
   * `seconds` is the match's length rather than this seat's stay — B6's decision, kept: a player
   * who dropped and returned is not docked the minutes before the drop.
   */
  buildSummaryFor(seat: Seat): SummaryInfo {
    const common = this.buildSummary();
    const entityId = seat.player.entityId;
    const ledger = this.ledgers.get(entityId);
    const row = common.rows.find((r) => r.entityId === entityId);
    const won =
      row !== undefined &&
      wonBy(
        { winner: common.winner as 'A' | 'B' | 'DRAW', winnerEntityId: common.winnerEntityId },
        row.team,
        entityId,
      );
    const mvp = isMvp(common.rows, entityId);
    const seconds = this.match.tickCount * DT;
    const lines = ledger === undefined ? [] : ledger.lines(won, mvp, seconds);
    const xp: SummaryXpLine[] = lines.map((line) => ({
      source: xpSourceIndex(line.id),
      count: line.count,
      amount: Math.round(line.xp),
    }));
    return { ...common, xp };
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

  /**
   * One XP ledger per human who has ever been seated, keyed by entity (M13 Phase B, bug 4.2).
   *
   * Created when a seat is first granted and kept for the match rather than for the seat: a
   * return inside the grace reclaims the same entity and finds its ledger waiting, and a
   * return after it — a new entity — has the ledger re-keyed beside the score row it follows
   * (`adoptRowAndLedger`). Subscribed *after* `MatchFlow`, which `ServerMatch`'s constructor
   * subscribed first, so the streak the ledger reads off a row includes the kill being counted.
   */
  private readonly ledgers = new Map<number, MatchLedger>();

  /**
   * Whose row a lost connection's token opens (M13 Phase B, bug 4.3).
   *
   * `ReconnectRegistry` holds a seat for `RECONNECT_GRACE_MS` and forgets it on claim, expired
   * or not. This holds the *row* for the match: a token recorded when a seat is lost, so a
   * player who comes back after the grace — seated fresh, as a new entity, possibly on the other
   * side — adopts the row with their kills on it rather than standing beside it. Keyed by the
   * hex form for the reason the registry is.
   */
  private readonly rowOwners = new Map<string, number>();

  /** The row and the ledger of `fromEntityId` become `toEntityId`'s. See `ScoreSystem.adopt`. */
  private adoptRowAndLedger(fromEntityId: number, toEntityId: number, team: 'A' | 'B'): void {
    const adopted = this.match.score.adopt(fromEntityId, toEntityId, team);
    if (adopted === undefined) return;
    const ledger = this.ledgers.get(fromEntityId);
    if (ledger !== undefined && fromEntityId !== toEntityId) {
      this.ledgers.delete(fromEntityId);
      ledger.adopt(toEntityId);
      this.ledgers.set(toEntityId, ledger);
    }
    log.info(`entity ${fromEntityId}'s row and ledger now belong to entity ${toEntityId}.`);
  }

  /** Mark this instance unusable after its step threw (§4.18). Its players go back. */
  fail(why: string): void {
    this.setState(InstanceState.FAILED, why);
  }

  /**
   * A human takes a bot's place rather than being added beside it (§6.7, §8.27).
   *
   * §6.7: *"Bots fill to the mode's target player count — 10 for TDM / Domination / Kill
   * Confirmed / S&D, 8 for FFA — at the tier configured"*, and *"a human joining a running
   * match replaces a bot rather than adding a player, so team sizes stay fixed."*
   *
   * A live match spawns the mode's full authored roster at construction, before anybody has
   * migrated in, because it has no way of knowing how many will make it through the readiness
   * handshake. So every seat granted afterwards has to take a bot with it — otherwise three
   * humans joining a ten-bot Team Deathmatch make it a thirteen-body match, with one side two
   * players heavier than the other.
   *
   * The bot comes off **the team the human actually landed on**, which is why this runs after
   * `super.seat` rather than before: `ServerMatch.addPlayer` balances the sides, and guessing
   * the team in advance is how the count stays right in aggregate and wrong per side.
   *
   * `removeBotForSeat` rather than `bots.removeOne` — the director cannot unregister from
   * `Rewind`, and a bot removed the short way leaves a phantom in the lag-compensation path
   * that is written every tick for the rest of the match.
   *
   * ## A reconnect needs no new rule here, and that is the point (round 4, F8)
   *
   * A returning player is a seat granted on the team they left, so the line below takes a bot
   * off that team — the same bot-for-human swap a fresh join gets, run in the opposite direction
   * from the one `releaseEntity` performed when they dropped. One out, one in, roster unchanged,
   * without a "was this a reconnect" branch anywhere: F8 asks for the return to *"take the seat
   * back without changing the player count mid-match"*, and §6.7's existing rule already says
   * exactly that about every seat.
   */
  override seat(
    session: Session,
    loadout: Parameters<MatchInstance['seat']>[1],
    reclaim?: Parameters<MatchInstance['seat']>[2],
    previousToken?: Uint8Array | null,
  ) {
    const player = super.seat(session, loadout, reclaim);
    if (player === null) return null;
    this.everSeated = true;
    /**
     * A returning player's row and ledger follow them (M13 Phase B, bug 4.3).
     *
     * Inside the grace `reclaim` gave them their old entity back and the row is already theirs.
     * Past it they are a new entity, and the token they presented — expired to the registry,
     * but still the token this instance recorded when their seat was lost — names the row.
     */
    const previous = tokenKey(previousToken);
    const owned = previous === null ? undefined : this.rowOwners.get(previous);
    if (previous !== null && owned !== undefined) {
      this.rowOwners.delete(previous);
      // Inside the grace `reclaim` already put them back on this entity; nothing to move.
      if (owned !== player.entityId) this.adoptRowAndLedger(owned, player.entityId, player.team);
    }
    // The row was registered by `addPlayer`; the ledger is created beside it, once, and every
    // later seat on this entity (a reclaim) finds it. An adopted ledger is already keyed here.
    if (!this.ledgers.has(player.entityId)) {
      this.ledgers.set(
        player.entityId,
        new MatchLedger({ bus: this.match.bus, score: this.match.score, entityId: player.entityId }),
      );
    }
    if (!this.match.removeBotForSeat(player.team)) {
      // Not an error: a mode may have fewer bots than seats, and a match filled entirely with
      // humans has none left to displace. Worth saying, because it is also what a bot-fill
      // that silently did nothing would look like.
      log.info(
        `no bot on team ${player.team} to make room for ${session.displayName} — ` +
          'the side is one body larger.',
      );
    }
    return player;
  }

  /**
   * A leaver's seat goes back to a bot, so their side is not left a body down (§6.7).
   *
   * Only on a **disconnect**, and only while the match is actually running. A migration is not
   * a departure — the player is being seated one instance over in the same synchronous call —
   * and treating it as one would add a bot on every cycle, in a process where the whole point
   * of §8.13 is that a hundred cycles change nothing.
   *
   * It matters most in Search & Destroy, where `anyAlive` decides the round and nobody comes
   * back: the last human on a side dropping out ends the round for everybody, scored as an
   * elimination no one achieved.
   */
  protected override releaseEntity(entityId: number, cause: UnseatCause): void {
    if (cause === 'disconnected' && this.state === InstanceState.RUNNING) {
      this.match.replacePlayerWithBot(entityId);
    }
    // Unconditional, and safe either way: `removePlayer` no-ops on an entity already gone, so
    // the path where no bot was available still releases the seat.
    super.releaseEntity(entityId, cause);
  }

  /**
   * A seat was lost: remember whose row its token opens (M13 Phase B, bug 4.3).
   *
   * Only a **lost** connection, for the reason `Server.holdSeatForReturn` gives — a `Bye` is
   * the player saying they are done, and a migration is the match ending. Recorded before
   * `unseat` destroys the seat, while the entity is still known.
   */
  override unseat(playerId: number, cause: UnseatCause = 'disconnected'): void {
    const seat = this.seatOf(playerId);
    if (seat !== null && cause === 'disconnected') {
      const key = tokenKey(seat.session.reconnectToken);
      if (key !== null) this.rowOwners.set(key, seat.player.entityId);
    }
    super.unseat(playerId, cause);
  }

  override dispose(): void {
    this.ready.clear();
    this.timedOut.clear();
    this.summary = null;
    for (const ledger of this.ledgers.values()) ledger.dispose();
    this.ledgers.clear();
    this.rowOwners.clear();
    super.dispose();
  }
}

/** A token as a map key, in the hex form `ReconnectRegistry` keys by, or null for none. */
function tokenKey(token: Uint8Array | null | undefined): string | null {
  if (token == null || token.length === 0) return null;
  let out = '';
  for (const b of token) out += b.toString(16).padStart(2, '0');
  return out;
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
