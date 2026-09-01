import {
  STREAK_DEFS,
  streakDef,
  type StreakDef,
  type StreakId,
} from '../../shared/streaks/StreakDefs';
import type { StreakEntityState, StreakView, UavContactState } from '../../shared/net/Skirmish';

/** One of this player's keys, as the server prices and gates it. Shaped like `StreakPrice`. */
export interface ReplicatedOffer {
  readonly id: StreakId;
  readonly price: number;
  /** Bought this life (B10). The fourth state the streak strip paints. */
  readonly used: boolean;
}

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
  /** The class's streaks, priced and gated. Empty until the first frame arrives. */
  private offers_: readonly ReplicatedOffer[] = [];
  private balance_ = 0;
  private nextKind = -1;
  private nextPrice_ = 0;
  private scrambled_ = false;
  private sweepAngle_ = -1;
  private contacts_: readonly UavContactState[] = [];
  private entities_: readonly StreakEntityState[] = [];

  /** Whether a frame has ever arrived. Distinguishes "nothing yet" from "nothing to report". */
  private seen = false;

  apply(view: StreakView): void {
    // Resolved to ids here rather than at every read, because the wire's kind index is a
    // detail of the wire and three of this class's four readers ask by streak id.
    const offers: ReplicatedOffer[] = [];
    for (const offer of view.offers) {
      const def = STREAK_DEFS[offer.kind];
      if (def === undefined) continue;
      offers.push({ id: def.id, price: offer.price, used: offer.used });
    }
    this.offers_ = offers;
    this.balance_ = view.balance;
    this.nextKind = view.nextKind;
    this.nextPrice_ = view.nextPrice;
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
    this.offers_ = [];
    this.balance_ = 0;
    this.nextKind = -1;
    this.nextPrice_ = 0;
    this.scrambled_ = false;
    this.sweepAngle_ = -1;
    this.contacts_ = [];
    this.entities_ = [];
    this.seen = false;
  }

  get hasState(): boolean {
    return this.seen;
  }

  /** This player's three keys, priced and gated. Shaped like `StreakSystem.pricesFor`. */
  get offers(): readonly ReplicatedOffer[] {
    return this.offers_;
  }

  /** What this streak costs, or 0 when the server has not offered it. */
  priceOf(id: StreakId): number {
    return this.offerFor(id)?.price ?? 0;
  }

  /** B10: already bought this life. */
  hasUsed(id: StreakId): boolean {
    return this.offerFor(id)?.used === true;
  }

  /**
   * Whether pressing this key would do anything.
   *
   * Derived from the offer rather than from a list of what is held, because a balance has no
   * such list — and derived here rather than in `ClientMatch` so the local and networked
   * answers are the same shape and the HUD cannot be told two different stories.
   */
  canAfford(id: StreakId): boolean {
    const offer = this.offerFor(id);
    return offer !== undefined && !offer.used && offer.price <= this.balance_;
  }

  /** The cheapest streak not yet affordable, and its price, or null. Shaped like `nextFor`. */
  get next(): { def: StreakDef; price: number } | null {
    const def = STREAK_DEFS[this.nextKind];
    if (def === undefined) return null;
    return { def: streakDef(def.id), price: this.nextPrice_ };
  }

  /** Kills banked and not yet spent. Was `streakCount`, which is a different number now. */
  get balance(): number {
    return this.balance_;
  }

  private offerFor(id: StreakId): ReplicatedOffer | undefined {
    for (const offer of this.offers_) if (offer.id === id) return offer;
    return undefined;
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
