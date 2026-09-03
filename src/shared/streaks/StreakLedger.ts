import type { StreakId } from './StreakDefs';

/**
 * The killstreak economy: a balance of kills, what it has been spent on, and how long each
 * streak is locked out for (M11 Gate B, playtest round 4, B9 + B10 and the pivot that followed).
 *
 * ## Why this is a class and not three fields on `StreakSystem`
 *
 * B9 and B10 arrived as one model change. Streaks used to be **thresholds** on
 * `PlayerScore.streak`: crossing twelve opened everything priced at or below twelve at once,
 * activation spliced an entitlement out of a list and the counter never moved, so twelve kills
 * bought a UAV *and* a sentry *and* a chopper. What the report described is a **balance** —
 * kills accumulate, activation debits the price, death zeroes it.
 *
 * ## What replaced "once per life", and why the balance did not change with it
 *
 * B10's answer to a balance degenerating — twelve kills buying the same four-kill UAV three
 * times — was to allow each streak once per life. That rule is **gone**. It was the blunt
 * version of the thing it was protecting: it capped a life at one of each *whatever the pace*,
 * so a player who went on to earn the price a second time over the following two minutes was
 * refused for a reason that had nothing to do with the two minutes. What replaced it is a rule
 * about time rather than about a life:
 *
 *  - **the price is still charged** — re-using a streak means earning it again, in the same
 *    life, which is what makes the wallet the thing that bounds the economy;
 *  - **a cooldown**, `STREAK_COOLDOWN_SECONDS` after the streak's *effect* ends, so the second
 *    UAV of a life is separated from the first by its own duration plus the cooldown;
 *  - **no two of the same at once** — a streak whose previous instance is still in the world
 *    cannot be called in again, which is the rule that stops two choppers and two sentries.
 *
 * The wallet's own rules are untouched by that pivot, and this is the part worth being explicit
 * about because it is where the two models could have been confused: the balance still zeroes
 * on death, still cannot go negative and still cannot cross a life. **The cooldowns
 * deliberately do not** — dying is not a way to shorten a wait — so they are the one thing on a
 * row that `resetLife` leaves alone, and `cooldownsCrossingDeath` is that decision counted
 * rather than asserted.
 *
 * ## The balance is not the score
 *
 * `PlayerScore.kills` is what the match results are made of and nothing here may write it. The
 * balance is credited *from* it — `foldKills` takes the score's own cumulative count and banks
 * the difference, so the score stays the single authority on whether a kill counted at all (a
 * suicide, a team kill in a team mode) and this class never re-decides it — and it is credited
 * *beside* it by `credit`, which is how a care package pays out and how F14's `MO951357` hands
 * somebody thirty kills of purchasing power without touching what the scoreboard says they did.
 * If the balance were a read of `PlayerScore.kills`, neither of those would be expressible, and
 * that is the signal the model would be wrong.
 *
 * ## Nothing here knows what a streak *does*
 *
 * Prices come in from the caller, already discounted by Hardline; so does the tick a cooldown
 * ends on, and so does the answer to "is one of these already flying". This file has no opinion
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
  /**
   * Sim ticks left on this entity's own live instance of this streak, or 0 when none is in the
   * world (round 4, the concurrency rule).
   *
   * A question rather than a flag this class keeps, because `StreakSystem.active` is already
   * the authority on what is alive and a second copy of that list would be a second answer. It
   * is also what lets the refusal be *counted* here: the one door tests it, so a request that
   * bounced off a live sentry is a number rather than a silence at the call site.
   */
  readonly liveTicksFor: (entityId: number, id: StreakId) => number;
}

/**
 * The outcome of a purchase. `'ok'` is the only one that debits anything.
 *
 * `'live'` and `'cooling'` are one thing to a player — the key does nothing and the strip shows
 * the same fill — and two things to a log: one says the last one is still up, the other says it
 * is not up yet. Separate here so a run can report which of the two new rules is doing the
 * work, and collapsed into one number, `lockoutTicks`, everywhere either is displayed.
 */
export type StreakPurchase = 'ok' | 'unaffordable' | 'cooling' | 'live';

interface LedgerRow {
  /** Kills banked this life from the score. */
  kills: number;
  /** Kills banked this life from somewhere other than the score — a crate, a cheat. */
  credits: number;
  /** Kills debited by activations this life. */
  spent: number;
  /**
   * Activations this life, per streak. Measurement only; nothing gameplay-facing reads it.
   *
   * It is what `used` became. Under B10 the same map *was* the rule and could only ever hold
   * ones; now that a life may buy the same streak twice, a count is the shape that can show it,
   * and a count is also a claim nobody has to take on trust.
   */
  buys: Map<StreakId, number>;
  /**
   * Per streak, the sim tick this entity may activate it on again.
   *
   * **Survives a death**, which is the one thing on this row a life boundary does not touch: a
   * player who could clear a cooldown by dying would be a player for whom dying is sometimes
   * the fast way to the next chopper. Cleared only when the entity leaves.
   */
  cooldowns: Map<StreakId, number>;
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
   * Life-starts that began holding a **wallet** left over from the life before.
   *
   * Was `dirtyLifeStarts`, which reads like a per-life stock probe and is not one — that is
   * `LifeStockAudit`, a different object counting grenades off the same spawns. This counter
   * has only ever been about the wallet: the reset hangs off death and this is measured off the
   * **spawn**, so a new life that reached the world through some other door shows up here
   * instead of silently inheriting a balance. In a respawn mode it must be **0**.
   *
   * In a round-based mode it must equal `walletsAtRoundBoundary` instead, and that is a decision
   * rather than a defect: playtest round 4 settled that a Search & Destroy survivor keeps the
   * kills they banked, so surviving a round is worth something. Read the two together — see
   * `walletsAtRoundBoundary`.
   *
   * Cooldowns are deliberately **not** part of this test. They are meant to cross a death, so
   * counting them here would be a counter built to fail; `cooldownsCrossingDeath` is where that
   * decision is measured instead.
   */
  walletsAtLifeStart: number;
  /**
   * Wallets that were legitimately still full when a round started (round 4, B3/P5).
   *
   * Counted at the round boundary itself, from the other side of the same fact: how many rows
   * were holding a balance at the moment the round turned over. Every one of them is about to
   * produce a `walletsAtLifeStart` when its owner is spawned into the new round, so
   * **`walletsAtLifeStart === walletsAtRoundBoundary` is the invariant**, and it fails in both
   * directions — a wallet that survived a death shows up on the left with nothing to match it,
   * and a survivor whose wallet was wrongly cleared shows up on the right.
   *
   * Deliberately not a flag that suppresses the count. A measurement that silences its own
   * failure case is a measurement that cannot fail.
   */
  walletsAtRoundBoundary: number;
  /**
   * Cooldowns that were still running when their owner died (round 4, the pivot).
   *
   * The decision, from the same angle the wallet's is measured from. Cooldowns survive a death
   * on purpose, so nothing can assert this is zero — what it is for is the opposite reading: a
   * run in which streaks were spent and this is **0** is a run where either nobody died inside a
   * cooldown or the life reset is clearing them, and the second is a bug that would otherwise
   * look exactly like the first.
   */
  cooldownsCrossingDeath: number;
  killsBanked: number;
  credited: number;
  spent: number;
  activations: number;
  refusedUnaffordable: number;
  /** Refused because the cooldown had not run out. */
  refusedCooling: number;
  /** Refused because this entity's own previous instance was still in the world. */
  refusedLive: number;
  /** Times a balance was observed below zero. Must be 0: it is the model's floor. */
  negativeBalances: number;
  /** Times the score's kill count went backwards under the anchor. Must be 0 inside a match. */
  resyncs: number;
  /**
   * Kills that arrived for somebody already dead, and were therefore not banked.
   *
   * Two doors, one rule. A mutual kill resolves as two events in one tick, and in one of the two
   * orders the loser's credit arrives after their own death has already zeroed the wallet; and
   * an unearned credit — a crate, a cheat, a harness top-up — can be aimed at a corpse just as
   * easily. Banking either would carry a balance across a death, which is the one thing the
   * wallet's own rule forbids. Small and non-zero is the expected shape.
   */
  postMortemKills: number;
  peakBalance: number;
  /**
   * The most streaks any single life bought, of any kind (round 4).
   *
   * Was `maxUsedInOneLife`, and under B10 it was capped by how many *distinct* streaks a class
   * carried. It is bounded by the wallet and the cooldown now, which is the point of the pivot:
   * read it against `maxRepeatsInOneLife`.
   */
  maxBuysInOneLife: number;
  /**
   * The most times one life bought **the same** streak (round 4, the pivot).
   *
   * The rule that was removed, as a number rather than a claim. Under B10 this could not exceed
   * 1 by construction; a 2 here is a life that earned a streak's price twice, waited out its
   * cooldown and spent it again, which is the whole of the change. A run where it stays at 1 has
   * not exercised the model — read `refusedCooling` before believing anything else in the row.
   */
  maxRepeatsInOneLife: number;
  /**
   * How many of a player's three equipped streaks the **threshold** model would have handed
   * them, summed over every life in the run.
   *
   * The oldest of the three controls, computed from the same run: it is a pure function of the
   * kills a life banked, which is exactly what the pre-B9 code compared its requirements
   * against.
   */
  thresholdGrants: number;
  /**
   * What one life's kills bought under **B9 + B10** — cheapest first, each streak once.
   *
   * Kept after the pivot removed the rule it models, because it is the middle column of the
   * pacing table: threshold, then once-per-life, then repeats. Two of the three are history now
   * and all three are recomputed from the live run rather than remembered from an old one.
   */
  balancePurchases: number;
  /**
   * What the same kills buy **now**: cheapest first, repeats allowed.
   *
   * A ceiling on the wallet alone. It deliberately does **not** model the cooldown, because the
   * cooldown is a fact about how long the life lasted and this is a fact about the kills — so
   * the two together bracket the answer: purchases actually made can never exceed this, and the
   * gap is what the cooldown took out. The measured number is `activations`, and that is the one
   * the pacing question is settled on.
   */
  balanceRepeatPurchases: number;
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

  // -- the lockout -----------------------------------------------------------

  /**
   * Ticks until this entity may activate this streak again. Zero means the key works.
   *
   * **One number for both new rules**, and that is deliberate rather than convenient: to a
   * player, "the last one is still up" and "the cooldown has not run out" are the same event —
   * the key does nothing — and the HUD is asked to say so without text. Two numbers would be two
   * things for the strip to draw and a decision about which of them wins; one number answers
   * "when does this work again", which is the only question either rule is ever asked.
   *
   * The live instance is folded in by taking the larger of the two rather than by adding: a
   * lasting streak's cooldown is armed at activation for its own duration *plus* the cooldown,
   * so it already contains the time its instance has left, and adding would count that stretch
   * twice.
   */
  lockoutTicks(entityId: number, id: StreakId, tick: number): number {
    const readyAt = this.rows.get(entityId)?.cooldowns.get(id) ?? 0;
    return Math.max(0, readyAt - tick, this.deps.liveTicksFor(entityId, id));
  }

  /**
   * The streak's effect is over: it may be pressed again on `readyAtTick`.
   *
   * Written by assignment rather than by taking the later of the two, and that assignment is the
   * whole of "the clock starts when the effect ends". A lasting streak arms an *estimate* at
   * activation — its duration plus the cooldown — so the strip is honest about the wait from the
   * first frame; when the instance actually leaves the world the estimate is **replaced** by the
   * fact. The two agree when it ran its full duration, and the fact is earlier when it did not,
   * which is a sentry that was shot down taking its cooldown from the moment it stopped shooting
   * rather than from the ninety seconds it was never going to see.
   */
  armCooldown(entityId: number, id: StreakId, readyAtTick: number): void {
    this.row(entityId).cooldowns.set(id, readyAtTick);
  }

  /** Every streak this entity is locked out of, and by how many ticks. The debug panel's read. */
  lockoutsOf(entityId: number, tick: number): Array<{ id: StreakId; ticks: number }> {
    const out: Array<{ id: StreakId; ticks: number }> = [];
    const row = this.rows.get(entityId);
    if (row === undefined) return out;
    for (const id of row.cooldowns.keys()) {
      const ticks = this.lockoutTicks(entityId, id, tick);
      if (ticks > 0) out.push({ id, ticks });
    }
    return out;
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

  /**
   * Bank whatever the score has counted since the last fold, and return it.
   *
   * `kills` is `PlayerScore.kills`, cumulative for the match. The delta is the credit, which
   * leaves the score as the arbiter of what counts: a suicide and a friendly-fire kill never
   * move it, so neither does this. A count that has gone *backwards* is a fresh match on the
   * same roster — re-anchor and credit nothing, because a negative delta would starve the
   * balance for the rest of the run while looking like nothing at all from outside.
   *
   * **Nothing about a purchase stops this**, and that is what "earn it again in the same life"
   * means: spending moves `spent` and leaves `kills` alone, so the count goes on climbing from
   * where it was and the balance is the difference between the two.
   */
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

  /** A credit that was aimed at somebody already dead. Counted, not banked. */
  dropCredit(kills: number): void {
    if (kills > 0) this.totals.postMortemKills += kills;
  }

  /**
   * Hand somebody kills they did not score: a care package's payout, a cheat, a harness.
   *
   * Deliberately the same currency rather than a second entitlement list. A crate that granted
   * *its own* streak could drop something the claimant has not equipped — unspendable, because
   * keys 3/4/5 index the class's slots — and it would hand over an activation that paid no price
   * and started no cooldown, which is a second door into an economy with one. Paying out what
   * the roll was worth keeps one currency and no dead drops.
   */
  credit(entityId: number, kills: number): void {
    if (kills <= 0) return;
    const row = this.row(entityId);
    row.credits += kills;
    this.observe(row);
  }

  // -- spending --------------------------------------------------------------

  /** Whether this purchase would go through, without making it. The HUD's question. */
  canAfford(entityId: number, id: StreakId, price: number, tick: number): boolean {
    return this.quote(entityId, id, price, tick) === 'ok';
  }

  quote(entityId: number, id: StreakId, price: number, tick: number): StreakPurchase {
    if (this.deps.liveTicksFor(entityId, id) > 0) return 'live';
    if (this.lockoutTicks(entityId, id, tick) > 0) return 'cooling';
    return this.balanceOf(entityId) < price ? 'unaffordable' : 'ok';
  }

  /**
   * Debit the price, count the buy and drop the announcement.
   *
   * The **one door** every activation goes through, humans and bots alike. A caller that reached
   * the world without passing here would be a second economy, and the two would agree right up
   * until they did not. It is also the only place a refusal is counted, which is why the caller
   * asks it rather than asking `canAfford` first and charging afterwards — two questions is how
   * a refusal goes unrecorded.
   *
   * The cooldown is **not** armed here. Charging is the moment the money moves; the cooldown
   * runs from the moment the effect ends, and only the caller knows when that is for this
   * streak — see `armCooldown`.
   *
   * Dropping the announcement is what lets the same streak be announced again once its price has
   * been earned a second time. Under B10 there was never a second time.
   */
  charge(entityId: number, id: StreakId, price: number, tick: number): StreakPurchase {
    const verdict = this.quote(entityId, id, price, tick);
    if (verdict === 'live') {
      this.totals.refusedLive++;
      return verdict;
    }
    if (verdict === 'cooling') {
      this.totals.refusedCooling++;
      return verdict;
    }
    if (verdict === 'unaffordable') {
      this.totals.refusedUnaffordable++;
      return verdict;
    }
    const row = this.row(entityId);
    row.spent += price;
    row.buys.set(id, (row.buys.get(id) ?? 0) + 1);
    const at = row.announced.indexOf(id);
    if (at >= 0) row.announced.splice(at, 1);
    this.totals.activations++;
    this.observe(row);
    return 'ok';
  }

  // -- the life boundary -----------------------------------------------------

  /**
   * A life ended. Close it into the report and zero the wallet.
   *
   * The rule this keeps is B9's: dying costs the balance and everything earned but not spent.
   * The rule it no longer has is B10's — there is no set of streaks to un-forbid, because
   * nothing was forbidden for the life in the first place.
   *
   * **The cooldowns are left running**, and this is the line that says so. A player who could
   * shorten a wait by dying would have a reason to die, and a streak's lockout is measured from
   * the moment its effect ended rather than from the life it was spent in.
   *
   * `kills` re-anchors the fold, so kills scored in the life that just ended can never be banked
   * into the next one. `tick` is read only to count the cooldowns crossing.
   */
  resetLife(entityId: number, kills: number, tick: number): void {
    const row = this.rows.get(entityId);
    if (row === undefined) {
      this.row(entityId).killMark = kills;
      return;
    }
    for (const readyAt of row.cooldowns.values()) {
      if (readyAt > tick) this.totals.cooldownsCrossingDeath++;
    }
    this.close(entityId, row);
    row.kills = 0;
    row.credits = 0;
    row.spent = 0;
    row.buys.clear();
    row.announced.length = 0;
    row.killMark = kills;
    row.peak = 0;
  }

  /**
   * A round turned over. Count the wallets that are about to survive it, and change nothing.
   *
   * The other end of `walletsAtLifeStart`: this is what those carry-overs *should* be, counted
   * from the round boundary rather than from the spawns it causes. Ordering against those spawns
   * does not matter, because spawning does not touch a row — `noteLifeStart` only observes — so
   * the same rows are counted whichever runs first.
   */
  noteRoundBoundary(): void {
    for (const row of this.rows.values()) {
      if (row.kills + row.credits - row.spent !== 0) this.totals.walletsAtRoundBoundary++;
    }
  }

  /**
   * A new life reached the world. **An observation, not a write.**
   *
   * Driven from the spawn events, which is a different signal from the death that resets — so a
   * life that arrived through a door the reset does not cover is counted rather than assumed
   * away. See `StreakEconomyReport.walletsAtLifeStart`.
   */
  noteLifeStart(entityId: number): void {
    this.totals.lifeStarts++;
    const row = this.rows.get(entityId);
    if (row === undefined) return;
    if (row.kills + row.credits - row.spent !== 0) this.totals.walletsAtLifeStart++;
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
      row = {
        kills: 0,
        credits: 0,
        spent: 0,
        buys: new Map(),
        cooldowns: new Map(),
        announced: [],
        killMark: 0,
        peak: 0,
      };
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
    let buys = 0;
    for (const n of row.buys.values()) {
      buys += n;
      if (n > out.maxRepeatsInOneLife) out.maxRepeatsInOneLife = n;
    }
    if (buys > out.maxBuysInOneLife) out.maxBuysInOneLife = buys;
    out.killsBanked += row.kills;
    out.credited += row.credits;
    out.spent += row.spent;

    // The three models, priced identically and asked the same question: what does one life's
    // kills entitle this player to? A threshold hands over everything it reaches, all at once;
    // the once-per-life balance buys each of them at most one time; the balance as it stands now
    // buys the cheapest as often as the kills allow.
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

    const cheapest = prices[0];
    if (cheapest !== undefined && cheapest > 0) {
      out.balanceRepeatPurchases += Math.floor(row.kills / cheapest);
    }
  }
}

function blankReport(): StreakEconomyReport {
  return {
    lives: 0,
    lifeStarts: 0,
    walletsAtLifeStart: 0,
    walletsAtRoundBoundary: 0,
    cooldownsCrossingDeath: 0,
    killsBanked: 0,
    credited: 0,
    spent: 0,
    activations: 0,
    refusedUnaffordable: 0,
    refusedCooling: 0,
    refusedLive: 0,
    negativeBalances: 0,
    resyncs: 0,
    postMortemKills: 0,
    peakBalance: 0,
    maxBuysInOneLife: 0,
    maxRepeatsInOneLife: 0,
    thresholdGrants: 0,
    balancePurchases: 0,
    balanceRepeatPurchases: 0,
  };
}
