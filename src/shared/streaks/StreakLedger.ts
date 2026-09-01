import type { StreakId } from './StreakDefs';

/**
 * The killstreak economy: a balance of kills, what it has been spent on, and what has already
 * been spent this life (M11 Gate B, playtest round 4, B9 + B10).
 *
 * ## Why this is a class and not three fields on `StreakSystem`
 *
 * B9 and B10 are one model change, not two fixes. Streaks used to be **thresholds** on
 * `PlayerScore.streak`: crossing twelve opened everything priced at or below twelve at once,
 * activation spliced an entitlement out of a list and the counter never moved, so twelve kills
 * bought a UAV *and* a sentry *and* a chopper. What the report describes is a **balance** —
 * kills accumulate, activation debits the price, death zeroes it — and the moment spending is
 * a debit, B10 stops being a nicety and becomes the thing that keeps the model from
 * degenerating: without "once per life", twelve kills buys three UAVs.
 *
 * So the balance, the spend and the used set are one fact with one writer, and they live
 * together here rather than as three maps on a class that is also a world simulation.
 *
 * ## The balance is not the score
 *
 * `PlayerScore.kills` is what the match results are made of and nothing here may write it. The
 * balance is credited *from* it — `foldKills` takes the score's own cumulative count and banks
 * the difference, so the score stays the single authority on whether a kill counted at all (a
 * suicide, a team kill in a team mode) and this class never re-decides it — and it is credited
 * *beside* it by `credit`, which is how a care package pays out and how F14's `MO951357` will
 * hand somebody thirty kills of purchasing power without touching what the scoreboard says they
 * did. If the balance were a read of `PlayerScore.kills`, neither of those would be expressible,
 * and that is the signal the model would be wrong.
 *
 * ## Nothing here knows what a streak *does*
 *
 * Prices come in from the caller, already discounted by Hardline. This file has no opinion
 * about perks, entities or the world, which is what lets a harness drive a whole match's
 * economy through it and audit the result — see `report`.
 */

/** A streak this entity has equipped, and what it costs them after Hardline. */
export interface StreakPrice {
  readonly id: StreakId;
  readonly price: number;
}

export interface StreakLedgerDeps {
  /** This entity's equipped streaks and their effective prices. Read once per closed life. */
  readonly pricesOf: (entityId: number) => readonly StreakPrice[];
}

/** The outcome of a purchase. `'ok'` is the only one that debits anything. */
export type StreakPurchase = 'ok' | 'unaffordable' | 'used';

interface LedgerRow {
  /** Kills banked this life from the score. */
  kills: number;
  /** Kills banked this life from somewhere other than the score — a crate, a cheat. */
  credits: number;
  /** Kills debited by activations this life. */
  spent: number;
  /** Streaks activated this life. Each may be bought once, which is B10. */
  used: StreakId[];
  /** Streaks this life has already been told it can afford. Stops a repeated announcement. */
  announced: StreakId[];
  /** `PlayerScore.kills` as of the last fold. The anchor `foldKills` measures against. */
  killMark: number;
  /** Highest balance this life ever reached. Folded into the report at life close. */
  peak: number;
}

/**
 * What a run did to the economy. Every field is a count, and the ones that must be zero say so
 * in their own names.
 */
export interface StreakEconomyReport {
  /** Lives closed by a death, plus the ones still open when the report was taken. */
  lives: number;
  /** New lives observed from the spawn events — a different signal from the reset. */
  lifeStarts: number;
  /**
   * Life-starts that began with a balance or a used set left over from the life before.
   *
   * The reset hangs off death and this is measured off the **spawn**, so a new life that
   * reached the world through some other door shows up here instead of silently inheriting a
   * wallet. In a respawn mode it is zero; a round-based mode starts a survivor's next life
   * without killing them, and those are the rows P5's per-life table has to decide about.
   */
  dirtyLifeStarts: number;
  killsBanked: number;
  credited: number;
  spent: number;
  activations: number;
  refusedUnaffordable: number;
  refusedUsed: number;
  /** Times a balance was observed below zero. Must be 0: it is the model's floor. */
  negativeBalances: number;
  /** Times the score's kill count went backwards under the anchor. Must be 0 inside a match. */
  resyncs: number;
  /**
   * Kills that arrived for somebody already dead, and were therefore not banked.
   *
   * Two doors, one rule. A mutual kill resolves as two events in one tick, and in one of the
   * two orders the loser's credit arrives after their own death has already zeroed the wallet;
   * and an unearned credit — a crate, a cheat, a harness top-up — can be aimed at a corpse just
   * as easily. Banking either would carry a balance across a death, which is precisely what B10
   * says cannot happen. Small and non-zero is the expected shape.
   */
  postMortemKills: number;
  peakBalance: number;
  /**
   * The most streaks any single life bought (round 4, B10).
   *
   * The once-per-life rule, as a number rather than a claim. Under the threshold model a life
   * with the money could activate the same streak as many times as it was granted one; here it
   * is capped by how many *distinct* streaks the class carries, whatever the balance. Run the
   * skirmish harness with `--grant-streak` and the balance is topped up repeatedly on purpose,
   * so a life that could buy the same UAV twice would show it here.
   */
  maxUsedInOneLife: number;
  /**
   * How many of a player's three equipped streaks the **threshold** model would have handed
   * them, summed over every life in the run.
   *
   * The red control, computed from the same run: it is a pure function of the kills a life
   * banked, which is exactly what the old code compared its requirements against. Read it
   * against `balancePurchases`.
   */
  thresholdGrants: number;
  /**
   * How many distinct streaks the **balance** buys for the same kills, cheapest first.
   *
   * A ceiling rather than what was actually spent, so that both numbers answer the same
   * question — what does one life's kills entitle a player to — and the gap between them is
   * the whole of the balance change.
   */
  balancePurchases: number;
}

export class StreakLedger {
  private readonly rows = new Map<number, LedgerRow>();
  private readonly deps: StreakLedgerDeps;
  private readonly totals = blankReport();
  /** Reused by the per-life audit, so closing a life allocates nothing. */
  private readonly priceScratch: number[] = [];

  constructor(deps: StreakLedgerDeps) {
    this.deps = deps;
  }

  // -- the balance -----------------------------------------------------------

  balanceOf(entityId: number): number {
    const row = this.rows.get(entityId);
    if (row === undefined) return 0;
    return row.kills + row.credits - row.spent;
  }

  earnedOf(entityId: number): number {
    const row = this.rows.get(entityId);
    return row === undefined ? 0 : row.kills + row.credits;
  }

  spentOf(entityId: number): number {
    return this.rows.get(entityId)?.spent ?? 0;
  }

  /** B10: this streak has already been bought this life and cannot be bought again. */
  hasUsed(entityId: number, id: StreakId): boolean {
    return this.rows.get(entityId)?.used.includes(id) === true;
  }

  usedBy(entityId: number): readonly StreakId[] {
    return this.rows.get(entityId)?.used ?? EMPTY_IDS;
  }

  /** Whether this streak has already been announced as affordable in the current life. */
  hasAnnounced(entityId: number, id: StreakId): boolean {
    return this.rows.get(entityId)?.announced.includes(id) === true;
  }

  noteAnnounced(entityId: number, id: StreakId): void {
    const row = this.row(entityId);
    if (!row.announced.includes(id)) row.announced.push(id);
  }

  // -- the two credit doors --------------------------------------------------

  /**
   * Bank whatever the score has counted since the last fold, and return it.
   *
   * `kills` is `PlayerScore.kills`, cumulative for the match. The delta is the credit, which
   * leaves the score as the arbiter of what counts: a suicide and a friendly-fire kill never
   * move it, so neither does this. A count that has gone *backwards* is a fresh match on the
   * same roster — re-anchor and credit nothing, because a negative delta would starve the
   * balance for the rest of the run while looking like nothing at all from outside.
   */
  /**
   * Move the anchor forward without banking anything (round 4, B10).
   *
   * For a kill credited to somebody who is already dead. The anchor still has to move, or the
   * same kill would be banked into their *next* life the first time that life folds — a death
   * that hands you a kill you scored while dead is the carry-over the reset exists to stop,
   * arriving one life later and looking like nothing.
   */
  discardKills(entityId: number, kills: number): void {
    const row = this.row(entityId);
    if (kills > row.killMark) this.totals.postMortemKills += kills - row.killMark;
    row.killMark = kills;
  }

  foldKills(entityId: number, kills: number): number {
    const row = this.row(entityId);
    if (kills < row.killMark) {
      this.totals.resyncs++;
      row.killMark = kills;
      return 0;
    }
    const gained = kills - row.killMark;
    row.killMark = kills;
    if (gained === 0) return 0;
    row.kills += gained;
    this.observe(row);
    return gained;
  }

  /**
   * Hand somebody kills they did not score: a care package's payout, a cheat, a harness.
   *
   * Deliberately the same currency rather than a second entitlement list. A crate that granted
   * *its own* streak could drop something the claimant has not equipped — unspendable, because
   * keys 3/4/5 index the class's slots — or launder a second use of a streak already spent this
   * life, straight past B10. Paying out what the roll was worth keeps one currency, one rule
   * and no dead drops.
   */
  /** A credit that was aimed at somebody already dead. Counted, not banked. */
  dropCredit(kills: number): void {
    if (kills > 0) this.totals.postMortemKills += kills;
  }

  credit(entityId: number, kills: number): void {
    if (kills <= 0) return;
    const row = this.row(entityId);
    row.credits += kills;
    this.observe(row);
  }

  // -- spending --------------------------------------------------------------

  /** Whether this purchase would go through, without making it. The HUD's question. */
  canAfford(entityId: number, id: StreakId, price: number): boolean {
    return this.quote(entityId, id, price) === 'ok';
  }

  quote(entityId: number, id: StreakId, price: number): StreakPurchase {
    if (this.hasUsed(entityId, id)) return 'used';
    return this.balanceOf(entityId) < price ? 'unaffordable' : 'ok';
  }

  /**
   * Debit the price and mark the streak spent for this life.
   *
   * The **one door** every activation goes through, humans and bots alike. A caller that
   * reached the world without passing here would be a second economy, and the two would agree
   * right up until they did not.
   */
  charge(entityId: number, id: StreakId, price: number): StreakPurchase {
    const verdict = this.quote(entityId, id, price);
    if (verdict === 'used') {
      this.totals.refusedUsed++;
      return verdict;
    }
    if (verdict === 'unaffordable') {
      this.totals.refusedUnaffordable++;
      return verdict;
    }
    const row = this.row(entityId);
    row.spent += price;
    row.used.push(id);
    this.totals.activations++;
    this.observe(row);
    return 'ok';
  }

  // -- the life boundary -----------------------------------------------------

  /**
   * A life ended. Close it into the report, zero the balance and clear the used set.
   *
   * The rule this replaces said dying costs the streak and everything earned but not spent.
   * That stands, and under the balance model it gains a second half: death is also what makes
   * a streak buyable again, which is the whole of B10's "until death resets it".
   *
   * `kills` re-anchors the fold, so kills scored in the life that just ended can never be
   * banked into the next one.
   */
  resetLife(entityId: number, kills: number): void {
    const row = this.rows.get(entityId);
    if (row === undefined) {
      this.row(entityId).killMark = kills;
      return;
    }
    this.close(entityId, row);
    row.kills = 0;
    row.credits = 0;
    row.spent = 0;
    row.used.length = 0;
    row.announced.length = 0;
    row.killMark = kills;
    row.peak = 0;
  }

  /**
   * A new life reached the world. **An observation, not a write.**
   *
   * Driven from the spawn events, which is a different signal from the death that resets — so
   * a life that arrived through a door the reset does not cover is counted rather than assumed
   * away. See `StreakEconomyReport.dirtyLifeStarts`.
   */
  noteLifeStart(entityId: number): void {
    this.totals.lifeStarts++;
    const row = this.rows.get(entityId);
    if (row === undefined) return;
    if (row.kills + row.credits - row.spent !== 0 || row.used.length > 0) {
      this.totals.dirtyLifeStarts++;
    }
  }

  /** The entity has left. Bank the life it was in the middle of and drop the row. */
  forget(entityId: number): void {
    const row = this.rows.get(entityId);
    if (row === undefined) return;
    this.close(entityId, row);
    this.rows.delete(entityId);
  }

  clear(): void {
    this.rows.clear();
  }

  // -- the report ------------------------------------------------------------

  /**
   * The run so far, with every life still open folded in.
   *
   * Folded rather than closed, so taking the report twice cannot count a life twice and asking
   * for it mid-match does not disturb the match.
   */
  report(): StreakEconomyReport {
    const out = { ...this.totals };
    for (const [entityId, row] of this.rows) this.foldInto(out, entityId, row);
    return out;
  }

  // -- internals -------------------------------------------------------------

  private row(entityId: number): LedgerRow {
    let row = this.rows.get(entityId);
    if (row === undefined) {
      row = { kills: 0, credits: 0, spent: 0, used: [], announced: [], killMark: 0, peak: 0 };
      this.rows.set(entityId, row);
    }
    return row;
  }

  /** Every mutation of a row passes here, so the invariants are sampled rather than asserted. */
  private observe(row: LedgerRow): void {
    const balance = row.kills + row.credits - row.spent;
    if (balance < 0) this.totals.negativeBalances++;
    if (balance > row.peak) row.peak = balance;
    if (balance > this.totals.peakBalance) this.totals.peakBalance = balance;
  }

  private close(entityId: number, row: LedgerRow): void {
    this.foldInto(this.totals, entityId, row);
  }

  private foldInto(out: StreakEconomyReport, entityId: number, row: LedgerRow): void {
    out.lives++;
    if (row.used.length > out.maxUsedInOneLife) out.maxUsedInOneLife = row.used.length;
    out.killsBanked += row.kills;
    out.credited += row.credits;
    out.spent += row.spent;

    // The two models, priced identically and asked the same question: how many of this
    // player's three streaks does one life's kills entitle them to?
    const prices = this.priceScratch;
    prices.length = 0;
    for (const p of this.deps.pricesOf(entityId)) prices.push(p.price);
    prices.sort((a, b) => a - b);

    for (const price of prices) if (price <= row.kills) out.thresholdGrants++;

    let budget = row.kills;
    for (const price of prices) {
      if (price > budget) break;
      budget -= price;
      out.balancePurchases++;
    }
  }
}

function blankReport(): StreakEconomyReport {
  return {
    lives: 0,
    lifeStarts: 0,
    dirtyLifeStarts: 0,
    killsBanked: 0,
    credited: 0,
    spent: 0,
    activations: 0,
    refusedUnaffordable: 0,
    refusedUsed: 0,
    negativeBalances: 0,
    resyncs: 0,
    postMortemKills: 0,
    peakBalance: 0,
    maxUsedInOneLife: 0,
    thresholdGrants: 0,
    balancePurchases: 0,
  };
}

const EMPTY_IDS: readonly StreakId[] = [];
