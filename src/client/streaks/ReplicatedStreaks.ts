import {
  STREAK_DEFS,
  streakDef,
  type StreakDef,
  type StreakId,
} from '../../shared/streaks/StreakDefs';
import type { StreakEntityState, StreakView, UavContactState } from '../../shared/net/Skirmish';

/**
 * The server's answer to every streak question a networked client used to answer itself
 * (M11 Gate B, §6.8, §8.22).
 *
 * ## Why this exists rather than the client's own `StreakSystem`
 *
 * A networked client still constructs a `StreakSystem` — it is the object the HUD, the minimap
 * and the renderer were all written against — and in a networked match it is **not simulated**.
 * That leaves every one of its readers asking a system that will never advance: what have I
 * earned, is my minimap scrambled, where is the sweep, what is on the floor.
 *
 * This is the replica those readers are pointed at instead. §4.15 puts *"killstreak earn,
 * activation, entity state"* on the replicated side of the line, and a client that folded its
 * own kill events into its own streak counter would be a second authority that agrees with the
 * first right up until it does not — the same shape as the Domination flags, arriving from the
 * other direction.
 *
 * ## What it deliberately does not hold
 *
 * No timers, no expiry, no sweep advance. Everything here is overwritten wholesale by the next
 * `Streaks` frame at the snapshot rate, and a value interpolated between two of them would be a
 * number this client invented. The sweep bearing is the one place that shows — the beam steps at
 * 20 Hz rather than 60 — and that is the correct trade: a beam that is a frame stale is
 * invisible, and a beam the client advanced on its own would drift away from the contacts the
 * server recorded against it.
 */
export class ReplicatedStreaks {
  /** Kind indices this player holds, newest last. Empty until the first frame arrives. */
  private pendingKinds: readonly number[] = [];
  private streakCount_ = 0;
  private nextKind = -1;
  private nextRequirement_ = 0;
  private scrambled_ = false;
  private sweepAngle_ = -1;
  private contacts_: readonly UavContactState[] = [];
  private entities_: readonly StreakEntityState[] = [];

  /** Whether a frame has ever arrived. Distinguishes "nothing yet" from "nothing to report". */
  private seen = false;

  apply(view: StreakView): void {
    this.pendingKinds = view.pending;
    this.streakCount_ = view.streakCount;
    this.nextKind = view.nextKind;
    this.nextRequirement_ = view.nextRequirement;
    this.scrambled_ = view.scrambled;
    this.sweepAngle_ = view.sweepAngle;
    this.contacts_ = view.contacts;
    this.entities_ = view.entities;
    this.seen = true;
  }

  /**
   * Forget everything (migration, §4.18).
   *
   * A migration means a different instance with different streaks, and the client's obligation
   * list on receiving one is to discard everything it was told by the instance it is leaving.
   * A sentry from the arena still standing in the live match's first frame is exactly the class
   * of stale-state bug that list exists to prevent.
   */
  clear(): void {
    this.pendingKinds = [];
    this.streakCount_ = 0;
    this.nextKind = -1;
    this.nextRequirement_ = 0;
    this.scrambled_ = false;
    this.sweepAngle_ = -1;
    this.contacts_ = [];
    this.entities_ = [];
    this.seen = false;
  }

  get hasState(): boolean {
    return this.seen;
  }

  /** The streaks this player may spend, in key order — the same shape `pendingFor` returns. */
  get pending(): readonly StreakId[] {
    const out: StreakId[] = [];
    for (const kind of this.pendingKinds) {
      const def = STREAK_DEFS[kind];
      if (def !== undefined) out.push(def.id);
    }
    return out;
  }

  /** The streak being worked toward and what it costs, or null. Shaped like `nextFor`. */
  get next(): { def: StreakDef; requirement: number } | null {
    const def = STREAK_DEFS[this.nextKind];
    if (def === undefined) return null;
    return { def: streakDef(def.id), requirement: this.nextRequirement_ };
  }

  get streakCount(): number {
    return this.streakCount_;
  }

  get scrambled(): boolean {
    return this.scrambled_;
  }

  /** Bearing of a friendly UAV's beam, or -1 when this team has none up. */
  get sweepAngle(): number {
    return this.sweepAngle_;
  }

  get contacts(): readonly UavContactState[] {
    return this.contacts_;
  }

  get entities(): readonly StreakEntityState[] {
    return this.entities_;
  }
}
