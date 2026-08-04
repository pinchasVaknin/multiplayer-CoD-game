import type { HitboxRig } from '../../shared/combat/HitboxRig';
import { DT } from '../../shared/core/Loop';
import { MAX_REWIND_MS } from '../../shared/net/Protocol';
import {
  makeRigSnapshot,
  restoreRig,
  saveRig,
  RigHistory,
  type RigSnapshot,
} from './RigHistory';

/**
 * Server-side rewind: lag compensation for hitscan (M10, S4.13).
 *
 * ## Why this is not optional
 *
 * S4.13 leads with the arithmetic and it is worth keeping in front of you: at 60 ms RTT, a
 * target moving at the movement config's ceiling has travelled **roughly half a metre**
 * between the moment the shooter saw them and the moment the server processes the shot. Half
 * a metre is wider than a player. Without rewind, every shot at a strafing target at ordinary
 * ping misses, and it does not read as latency — it reads as the game being broken.
 *
 * ## What it does
 *
 * The shooter fired at what they were *looking at*, which is not the present. Their client
 * renders remote players interpolated ~100 ms in the past (S4.12), and their command took
 * RTT/2 to arrive. So the world they aimed into was
 *
 * ```
 *   viewTick = serverTick - (RTT/2 + interpolationDelay) / tickMs
 * ```
 *
 * This moves every *other* entity's rig back to that tick, lets the existing `Ballistics`
 * trace run against it, and puts everything back. `Ballistics`, `HitboxRig` and `DamageSystem`
 * are untouched and unaware — which is the point. S6.4 requires damage to resolve through the
 * **existing shared `DamageSystem`**, and it does, because all this changes is where the
 * boxes are when the ray is cast.
 *
 * ## The cap, and what it costs
 *
 * S4.13 caps rewind at 200 ms and is explicit about why: *"An unbounded rewind lets a
 * high-ping client shoot people who have been behind cover for a quarter of a second."* Past
 * the cap the rewind clamps, and a genuinely high-ping player starts having to lead their
 * targets. That is the correct trade and the clamp rate is reported so it is visible rather
 * than mysterious.
 *
 * **Peeker's advantage is a consequence of this, not a defect.** S4.13 says not to try to
 * remove it, and this makes no attempt to: whoever peeks first sees the defender before the
 * defender sees them, bounded by the cap and the interpolation delay.
 */

/** The cap in ticks, which is what the history is indexed by. */
export const MAX_REWIND_TICKS = Math.floor(MAX_REWIND_MS / (DT * 1000));

export { MAX_REWIND_MS };

/**
 * One entity's rewindable state.
 *
 * Only the identity and the rig. The *history* is owned by `Rewind` rather than by the
 * entity, and that is a deliberate placement: a `Bot` lives in `shared/` and runs in the
 * browser too, where nothing ever rewinds anything. Hanging a 60-tick buffer off it would
 * make every client allocate and fill history for ten bots to serve a server-only feature.
 * Both `Bot` and `NetPlayer` satisfy this interface with the two fields they already have.
 */
export interface Rewindable {
  readonly entityId: number;
  readonly rig: HitboxRig;
}

/** What one shot's rewind actually did, for the S7 rewind panel and the per-shot log. */
export interface RewindRecord {
  /** Milliseconds of rewind requested, before the cap. */
  requestedMs: number;
  /** Milliseconds actually applied. */
  appliedMs: number;
  appliedTicks: number;
  /** True when the 200 ms cap bit. */
  clamped: boolean;
  /** Entities whose rig was actually moved. */
  moved: number;
  /** Entities whose history did not hold the tick, so they stayed in the present. */
  missed: number;
  /** The tick the world was rewound to. */
  viewTick: number;
  serverTick: number;
}

export function makeRewindRecord(): RewindRecord {
  return {
    requestedMs: 0,
    appliedMs: 0,
    appliedTicks: 0,
    clamped: false,
    moved: 0,
    missed: 0,
    viewTick: 0,
    serverTick: 0,
  };
}

export class Rewind {
  /** Shots whose rewind hit the cap, since process start. Reported by the metrics (S7). */
  clampedShots = 0;
  /** Shots for which any rewind at all was applied. */
  rewoundShots = 0;
  /** Sum of applied milliseconds, for the mean. */
  private appliedMsTotal = 0;

  /** The last shot's record. Read by the session to build the S7 rewind panel event. */
  readonly last: RewindRecord = makeRewindRecord();

  private readonly entities: Rewindable[] = [];
  private readonly histories = new Map<number, RigHistory>();
  private readonly saved = new Map<number, RigSnapshot>();
  private readonly pool: RigSnapshot[] = [];
  private active = false;

  /** Mean rewind applied across every shot that was rewound, ms. */
  get meanAppliedMs(): number {
    return this.rewoundShots === 0 ? 0 : this.appliedMsTotal / this.rewoundShots;
  }

  register(entity: Rewindable): void {
    if (this.entities.some((e) => e.entityId === entity.entityId)) return;
    this.entities.push(entity);
    this.histories.set(entity.entityId, new RigHistory());
  }

  unregister(entityId: number): void {
    const at = this.entities.findIndex((e) => e.entityId === entityId);
    if (at >= 0) this.entities.splice(at, 1);
    this.histories.delete(entityId);
  }

  /**
   * Record every registered rig's transform for this tick.
   *
   * Called once per tick, **after** the simulation has moved everyone and before any
   * snapshot goes out. One call for the whole roster rather than each entity recording
   * itself, so there is no way for an entity to be stepped and not recorded — which would
   * leave a hole in the history that a later rewind would silently fall through.
   */
  record(tick: number): void {
    for (const e of this.entities) {
      this.histories.get(e.entityId)?.push(e.rig, tick);
    }
  }

  /**
   * Fill an entity's whole history with its current pose.
   *
   * Called on spawn. Without it, a shot rewound into the window before a player existed
   * resolves against whatever the buffer happened to hold — for a fresh entity that is the
   * origin, so a round fired across the map would score a hit on somebody standing at world
   * zero.
   */
  resetAt(entityId: number, tick: number): void {
    const entity = this.entities.find((e) => e.entityId === entityId);
    if (entity === undefined) return;
    this.histories.get(entityId)?.fill(entity.rig, tick);
  }

  /**
   * Rewind the world to the shooter's view time, excluding the shooter themselves.
   *
   * The shooter is excluded because they are not lag compensated against — they are exactly
   * where the server says they are, and their own client predicted that position. Rewinding
   * the shooter would move the origin of their own ray.
   *
   * Returns the record so the caller can log and replicate it. **Always pair with `end()`.**
   */
  begin(shooterId: number, serverTick: number, viewLagMs: number): RewindRecord {
    const rec = this.last;
    rec.serverTick = serverTick;
    rec.requestedMs = viewLagMs;
    rec.clamped = viewLagMs > MAX_REWIND_MS;
    const appliedMs = rec.clamped ? MAX_REWIND_MS : Math.max(0, viewLagMs);
    rec.appliedMs = appliedMs;
    rec.appliedTicks = Math.round(appliedMs / (DT * 1000));
    rec.viewTick = serverTick - rec.appliedTicks;
    rec.moved = 0;
    rec.missed = 0;

    if (rec.clamped) this.clampedShots++;

    // Nothing to do at zero rewind, which is the local and LAN case. Skipping keeps the
    // no-latency path free of pointless work and, more usefully, keeps it obviously
    // identical to the single-player path.
    if (rec.appliedTicks <= 0) {
      this.active = false;
      return rec;
    }

    this.active = true;
    this.rewoundShots++;
    this.appliedMsTotal += appliedMs;

    for (const e of this.entities) {
      if (e.entityId === shooterId) continue;
      const slot = this.take();
      saveRig(e.rig, slot);
      this.saved.set(e.entityId, slot);
      const history = this.histories.get(e.entityId);
      if (history !== undefined && history.applyAt(e.rig, rec.viewTick)) rec.moved++;
      else rec.missed++;
    }
    return rec;
  }

  /** Put every rewound rig back where it was. Safe to call when `begin` did nothing. */
  end(): void {
    if (!this.active) return;
    for (const e of this.entities) {
      const slot = this.saved.get(e.entityId);
      if (slot === undefined) continue;
      restoreRig(slot, e.rig);
      this.pool.push(slot);
    }
    this.saved.clear();
    this.active = false;
  }

  /** Where a given entity is right now, versus where the last rewind put it (S7 panel). */
  presentOf(entityId: number): RigSnapshot | undefined {
    return this.saved.get(entityId);
  }

  private take(): RigSnapshot {
    return this.pool.pop() ?? makeRigSnapshot();
  }
}

/**
 * How far back a shooter was looking, in milliseconds.
 *
 * `RTT/2` is how long their command took to arrive; `interpolationDelay` is how far in the
 * past their client renders everyone else (S4.12). The sum is the age of the world they were
 * actually aiming at, and it is the whole of the lag compensation calculation.
 *
 * Clamped at zero because a clock estimate can go slightly negative on a very fast link, and
 * a negative rewind would be an extrapolation into a future the server has not simulated.
 */
export function viewLagMsFor(rttMs: number, interpolationDelayMs: number): number {
  const lag = rttMs * 0.5 + interpolationDelayMs;
  return lag > 0 ? lag : 0;
}
