import type { BotDifficulty } from '../shared/ai/DifficultyTiers';
import type { LoadoutSlot } from '../shared/meta/Loadouts';
import { logger } from '../shared/core/Log';
import type { InstanceStateId, MatchId } from '../shared/net/Skirmish';
import { LiveMatch, type LiveMatchOptions } from './instance/LiveMatch';
import type { MapBakery } from './MapBakery';
import type { PlayerId } from './net/Session';

const log = logger('allocator');

/**
 * Match allocation, behind one interface (M11, §4.17).
 *
 * §4.17: *"Every match is created and destroyed through one interface. Matchmaking never
 * constructs a `MatchInstance` directly."*
 *
 * ## Why `allocate` is async and fallible when it does not need to be
 *
 * The in-process implementation could return synchronously and could never fail. It does
 * neither, and the brief is unusually direct about why:
 *
 * > `INetworkTransport` was this same move in M1 and it did not survive contact with a real
 * > implementation, because its only implementation was a synchronous pass-through that
 * > modelled nothing. An allocator that cannot be slow and cannot fail will need rewriting the
 * > first time a match runs anywhere but in-process.
 *
 * So the seam is kept honest by force: `FaultyMatchAllocator` wraps the shipping one and
 * injects latency, failure and capacity exhaustion, and the harness runs against it. A caller
 * written against `allocate` that only ever resolved instantly would break the first time the
 * fault injector ran, which is the point — the failure paths in `VoteCycle` are *exercised*
 * rather than merely written.
 */

/** A player being carried into a new match, with their class already resolved (§4.18). */
export interface PlayerSlot {
  readonly playerId: PlayerId;
  readonly displayName: string;
  /**
   * The class, **locked at migration time** (§4.18, §6.6, Tier 1 #20).
   *
   * Captured into the request rather than read from the session when the entity is created.
   * The difference is the whole fix: a loadout read later is a loadout that can change between
   * the request and the spawn, and a movement perk arriving after the player is already being
   * simulated guarantees a client/server disagreement about speed for the first ticks of the
   * match. Null means the player never sent one and gets the server defaults.
   */
  readonly loadout: LoadoutSlot | null;
}

export interface MatchRequest {
  readonly modeId: string;
  readonly mapId: string;
  readonly players: readonly PlayerSlot[];
  /**
   * How many bots, and how hard. `tier` is `BOT_DIFFICULTY` (F1), and it is the **one** path
   * from the operator's configuration to `BotDirector` — see `tiersFor`.
   */
  readonly botFill: { readonly count: number; readonly tier: BotDifficulty };
}

export interface MatchHandle {
  readonly id: MatchId;
  readonly state: InstanceStateId;
  /** The instance itself. In-process, so there is nothing to marshal across. */
  readonly instance: LiveMatch;
}

export interface IMatchAllocator {
  allocate(req: MatchRequest): Promise<MatchHandle>;
  destroy(handle: MatchHandle): Promise<void>;
  readonly capacity: { readonly max: number; readonly inUse: number };
}

/** Thrown by an allocator that cannot satisfy a request. Never reaches a client verbatim. */
export class AllocationError extends Error {
  constructor(
    message: string,
    readonly kind: 'capacity' | 'failure' | 'invalid',
  ) {
    super(message);
    this.name = 'AllocationError';
  }
}

export interface InProcessAllocatorOptions {
  readonly bakery: MapBakery;
  readonly snapshotHz: number;
  readonly interpolationDelayMs: number;
  readonly readyTimeoutMs: number;
  readonly summaryHoldSeconds: number;
  /**
   * Bot difficulty was here too, as `botTier`, and it was **never read** (playtest round 4, F1).
   *
   * `allocate` takes it from `MatchRequest.botFill.tier` — the per-request value, which is the
   * right one, because a difficulty is a property of the match being asked for rather than of
   * the allocator asking. The construction-time copy was set to `'MIX'` at the one call site and
   * went nowhere, so it read as a wired knob and was one. Deleted rather than made authoritative:
   * one fact, one path, and the path is the request.
   */
  /** The master's current tick, so a new instance is stamped correctly before its first step. */
  readonly currentTick: () => number;
  readonly seed: number;
  /** Shorten every allocated match's round, seconds. Zero uses the mode's authored length. */
  readonly roundSecondsOverride?: number;
}

/**
 * The allocator that ships: one live match at a time, in this process (§4.9).
 *
 * The cap is one rather than a configurable number because §4.9 fixes it: *"Hard cap: two live
 * instances — the warmup arena plus at most one live match."* The arena is not allocated
 * through here (it is created at boot and never destroyed), so this allocator's own capacity is
 * one.
 */
export class InProcessMatchAllocator implements IMatchAllocator {
  private live: MatchHandle | null = null;
  private nextId: MatchId = 1;
  private allocations = 0;

  constructor(private readonly options: InProcessAllocatorOptions) {}

  get capacity(): { max: number; inUse: number } {
    return { max: 1, inUse: this.live === null ? 0 : 1 };
  }

  async allocate(req: MatchRequest): Promise<MatchHandle> {
    if (this.live !== null) {
      throw new AllocationError('a live match already exists', 'capacity');
    }

    const id = this.nextId++;
    /**
     * The seed varies per allocation but is derived from the configured one.
     *
     * A soak run stays reproducible end to end rather than only within its first match, and a
     * disputed match can be replayed from `(configured seed, match id)` — which is the same
     * discipline §4.20 applies to the vote's random tie-break.
     */
    const seed = (this.options.seed + id * 0x9e37) & 0x7fff_ffff;

    const instance = new LiveMatch({
      id,
      bakery: this.options.bakery,
      mapId: req.mapId,
      modeId: req.modeId,
      snapshotHz: this.options.snapshotHz,
      interpolationDelayMs: this.options.interpolationDelayMs,
      seed,
      startTick: this.options.currentTick(),
      botTier: req.botFill.tier,
      readyTimeoutMs: this.options.readyTimeoutMs,
      summaryHoldSeconds: this.options.summaryHoldSeconds,
      roundSecondsOverride: this.options.roundSecondsOverride ?? 0,
    } satisfies LiveMatchOptions);

    const handle: MatchHandle = {
      id,
      get state() {
        return instance.state;
      },
      instance,
    };
    this.live = handle;
    this.allocations++;
    log.info(`allocated match ${id}: ${req.modeId} on ${req.mapId} for ${req.players.length} human(s).`);
    return handle;
  }

  async destroy(handle: MatchHandle): Promise<void> {
    if (this.live === null || this.live.id !== handle.id) {
      // Not an error worth throwing over: a double-destroy is exactly what a failure path and
      // a normal end will both try to do, and the second one should be a no-op rather than a
      // second failure landing on top of the first.
      log.warn(`destroy(${handle.id}) but that match is not the live one; ignoring.`);
      return;
    }
    handle.instance.dispose();
    this.live = null;
    log.info(`destroyed match ${handle.id}.`);
  }

  /** Total allocations this process has made. The leak harness counts cycles with it. */
  get allocationCount(): number {
    return this.allocations;
  }
}

/**
 * Fault injection over a real allocator (§4.17, test-only).
 *
 * §4.17 requires this and is specific about what it must prove: *"The vote cycle must handle
 * all three by leaving every player in the warmup arena with a message, never by dropping them,
 * stranding them, or leaking a half-built instance."*
 *
 * The three faults are separate knobs because they fail at different points and the recoveries
 * are not the same:
 *
 * - **latency** — allocation succeeds, late. The cycle must not assume it has an instance
 *   before the promise resolves, and must not start a second cycle on top of the first.
 * - **failure** — allocation rejects. Everybody stays in the arena with a message.
 * - **capacity** — allocation rejects with a different reason, and the message differs.
 *
 * It wraps rather than replaces, so what is under test is the real allocator's behaviour with
 * a fault in front of it rather than a second implementation that might be wrong in its own
 * way.
 */
export interface FaultConfig {
  /** Milliseconds to stall before delegating. Zero is no stall. */
  latencyMs: number;
  /** Reject the next N allocations outright. Decremented on each use. */
  failuresRemaining: number;
  /** Report zero capacity and reject, regardless of the real allocator's state. */
  exhausted: boolean;
}

export class FaultyMatchAllocator implements IMatchAllocator {
  readonly faults: FaultConfig = { latencyMs: 0, failuresRemaining: 0, exhausted: false };

  constructor(private readonly inner: IMatchAllocator) {}

  get capacity(): { max: number; inUse: number } {
    if (this.faults.exhausted) return { max: 0, inUse: 0 };
    return this.inner.capacity;
  }

  async allocate(req: MatchRequest): Promise<MatchHandle> {
    if (this.faults.latencyMs > 0) {
      log.warn(`fault injection: stalling allocation ${this.faults.latencyMs}ms.`);
      await delay(this.faults.latencyMs);
    }
    if (this.faults.exhausted) {
      log.warn('fault injection: reporting capacity exhausted.');
      throw new AllocationError('injected capacity exhaustion', 'capacity');
    }
    if (this.faults.failuresRemaining > 0) {
      this.faults.failuresRemaining--;
      log.warn('fault injection: failing allocation.');
      throw new AllocationError('injected allocation failure', 'failure');
    }
    return this.inner.allocate(req);
  }

  destroy(handle: MatchHandle): Promise<void> {
    return this.inner.destroy(handle);
  }
}

/**
 * A promise that resolves after `ms`.
 *
 * `unref` so a pending stall cannot hold the process open at shutdown. §4.18 counts *"every
 * timer and pending promise"* as part of the teardown surface, and a fault injector that kept
 * a soak run alive after it was told to stop would be a leak in the tool built to find leaks.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
