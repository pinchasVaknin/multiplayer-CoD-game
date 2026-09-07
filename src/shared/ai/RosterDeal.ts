import { BOT_TIERS, type BotTier } from './DifficultyTiers';

/**
 * How a `tierMix` becomes two teams (playtest round 5, B4).
 *
 * The report: *"the only VETERAN in the mix always falls on the opposing team"*, with two
 * matches whose rosters were byte-identical. It was not a seed and not variance.
 * `BotDirector.populate` advanced **one cursor** through the mix and filled team A to
 * completion before team B started, which makes "which side does this tier land on" a pure
 * function of the tier's *index in the mix* against `teamA`. Foundry and Dunes put `VETERAN`
 * at index 4 and a solo 5v5 deals four bots to A, so index 4 was team B's first bot. Every
 * match. The same literal, read against the other two splits, punishes the other side:
 *
 *   solo 5v5      (4 / 5)  VETERAN always on B — the report
 *   live match    (5 / 5)  VETERAN always on A, and B never gets one
 *   live FFA      (4 / 4)  VETERAN always on B
 *
 * ## The rule this file implements, and the decision inside it
 *
 * **Both sides read the mix from the same place.** The long side takes the first `max(a, b)`
 * entries of the cyclic mix; the short side takes the same entries minus the `|a - b|`
 * **weakest** of them. Two consequences, both provable rather than observed:
 *
 *  - When the sides are even they are *identical*. That is every live-server match.
 *  - When they are not, the short side's multiset is contained in the long side's and the two
 *    differ by exactly `|a - b|` entries — the fewest the head-count allows.
 *
 * The brief asked for a decision to be made out loud: *the human seat is not a bot seat*. A
 * side is short a bot precisely because something else occupies that seat — in solo, the
 * player — and a player is on average worse than a REGULAR bot, so mirroring the tiers exactly
 * still hands the other side a real edge. **The short side keeps the stronger half.** That is
 * the brief's second option, generalised so that it needs no knowledge of where the humans
 * are: at `ServerMatch.populate` there are no humans yet and team A is not "the player's
 * side", so a rule phrased in terms of the player could only have been an `if (networked)`
 * branch, which is the shape P0 bans by name. Phrased in terms of *bodies* it is one rule in
 * both runtimes: the side that is a body down keeps the better bodies.
 *
 * The rejected alternative was to vary the deal by seed. It is a non-fix: `MatchWorld.AI_SEED`
 * is a **constant**, deliberately, so every solo match would have drawn the same offset and
 * the report's "two identical rosters" would have survived the fix untouched.
 *
 * Strength order is `BOT_TIERS` itself, which is already authored weakest-first and already
 * the order the difficulty picker offers. Nothing here invents a ranking.
 */

/** Weakest first. `BOT_TIERS` is authored in that order; this is the index into it. */
function strength(tier: BotTier): number {
  const at = BOT_TIERS.indexOf(tier);
  return at < 0 ? 0 : at;
}

export interface RosterDeal {
  readonly a: readonly BotTier[];
  readonly b: readonly BotTier[];
}

/**
 * Deal `teamA` and `teamB` bots from `mix`.
 *
 * Both arrays come back in mix order, so the creation order inside a side is the order the
 * spread was authored in — which is what `BotDirector.removeOne` walks backwards when a human
 * takes a seat.
 */
export function dealTiers(teamA: number, teamB: number, mix: readonly BotTier[]): RosterDeal {
  const a = Math.max(0, Math.trunc(teamA));
  const b = Math.max(0, Math.trunc(teamB));
  const long = Math.max(a, b);
  const short = Math.min(a, b);

  const full: BotTier[] = [];
  for (let i = 0; i < long; i++) {
    // The same fallback `populate` has always had: a mix that is empty is a mix of Regulars,
    // not a crash and not an empty roster.
    full.push(mix[i % Math.max(mix.length, 1)] ?? 'REGULAR');
  }

  /*
   * Which entries the short side does without: the weakest, and among equals the latest, so
   * the bodies it keeps are the earliest occurrences and its order still reads as the mix.
   */
  const dropped = new Set<number>();
  const byWeakest = full
    .map((tier, index) => ({ tier, index }))
    .sort((l, r) => strength(l.tier) - strength(r.tier) || r.index - l.index);
  for (let i = 0; i < long - short; i++) {
    const entry = byWeakest[i];
    if (entry !== undefined) dropped.add(entry.index);
  }
  const shortSide = full.filter((_, index) => !dropped.has(index));

  return a >= b ? { a: full, b: shortSide } : { a: shortSide, b: full };
}

/**
 * The tier for one more bot on a side, mid-match.
 *
 * `ServerMatch.replacePlayerWithBot` is the caller: a human left, their side is a body down,
 * and a bot takes the seat. It used to index the mix by the *total* bot count — a third cursor,
 * next to the two `populate` used, and one that knew nothing about either side's composition —
 * so a replacement could deepen exactly the imbalance the deal exists to prevent.
 *
 * It is not a second rule now, it is the **same** rule asked a different question: deal the
 * roster this side would have had at one body more, and hand back whatever this side is short
 * of. There is one description of a balanced roster in this file and every caller derives from
 * it, which is what stops the two drifting apart the way they did at round 4's F1.
 *
 * The strongest shortfall wins when a roster has drifted far enough to be short of several —
 * a side that is a body down is the side keeping the stronger half, so the body it is owed is
 * the best one it lacks. `auditRosterDeal` holds the pair to the round trip: take a bot off a
 * side the way a joining human does, ask for a replacement, and the roster comes back to what
 * it was dealt.
 */
export function tierForExtraBot(
  mine: readonly BotTier[],
  theirs: readonly BotTier[],
  mix: readonly BotTier[],
): BotTier {
  const target = dealTiers(mine.length + 1, theirs.length, mix).a;

  const count = (roster: readonly BotTier[], tier: BotTier): number => {
    let n = 0;
    for (const t of roster) if (t === tier) n++;
    return n;
  };

  // `BOT_TIERS` is weakest-first, so the last tier still short is the strongest one short.
  let best: BotTier | null = null;
  for (const tier of BOT_TIERS) {
    if (count(target, tier) - count(mine, tier) > 0) best = tier;
  }
  // Nothing short means this side already holds everything the target does and more — a roster
  // that has drifted past the deal. The target's own last seat is still the honest answer.
  return best ?? target[target.length - 1] ?? 'REGULAR';
}

// -- the audit ---------------------------------------------------------------

/** One authored spread, named, for the audit to sweep. */
export interface RosterMix {
  readonly id: string;
  readonly mix: readonly BotTier[];
}

export interface RosterDealAudit {
  /** How many (mix, split) pairs were dealt. */
  readonly deals: number;
  readonly problems: string[];
  /** One line per shipped-shaped split, for the log. */
  readonly rows: readonly RosterDealRow[];
}

export interface RosterDealRow {
  readonly id: string;
  readonly teamA: number;
  readonly teamB: number;
  readonly a: string;
  readonly b: string;
}

function tally(roster: readonly BotTier[]): Record<BotTier, number> {
  const out = { RECRUIT: 0, REGULAR: 0, HARDENED: 0, VETERAN: 0 };
  for (const tier of roster) out[tier]++;
  return out;
}

/**
 * Every authored spread, dealt at every split, checked against four properties.
 *
 * The brief asked for *"over N seeds and every mode, the multiset of tiers on team A and on
 * team B differ by at most one entry"*. Two things about that, and both are the reason this
 * is not what got written:
 *
 *  1. **It was already true.** The shipped one-cursor deal satisfies per-tier parity on all six
 *     shipped configurations, the reported 5v5 included — `A = REGULAR HARDENED RECRUIT
 *     REGULAR` against `B = VETERAN HARDENED REGULAR RECRUIT REGULAR` is parity. An assertion
 *     of that shape would have been green on the build the report was written against, which
 *     makes it a regression guard and not a probe.
 *  2. **There is no seed to sweep.** The deal is a pure function of `(teamA, teamB, mix)`. So
 *     the sweep is over the things that actually vary — every registered spread against every
 *     split up to a full roster — which is a stronger statement than a hundred samples: it is
 *     the whole domain, so one run is a fact rather than an estimate.
 *
 * The four properties, in the order they would fail:
 *
 *  - **Sizes.** Each side gets exactly the count it asked for.
 *  - **Containment.** The short side's multiset is inside the long side's. This is what fails
 *    today on Depot, on the live 5v5 and on FFA — the two sides hold tiers the other does not.
 *  - **Minimality.** They differ by exactly `|teamA - teamB|` entries, which is the fewest the
 *    head-count allows and is zero when the sides are even.
 *  - **The short side keeps the stronger half.** Every body it does without is at least as weak
 *    as every body it keeps. This is the one that fails on the report's own roster, where the
 *    body team A did without was the VETERAN.
 *
 * Per-tier parity — the brief's own assertion — follows from containment and minimality, and is
 * asserted anyway, because a property that is implied is still a property somebody will change.
 */
export function auditRosterDeal(mixes: readonly RosterMix[], maxPerSide = 12): RosterDealAudit {
  const problems: string[] = [];
  const rows: RosterDealRow[] = [];
  let deals = 0;

  for (const entry of mixes) {
    for (let a = 0; a <= maxPerSide; a++) {
      for (let b = 0; b <= maxPerSide; b++) {
        deals++;
        const deal = dealTiers(a, b, entry.mix);
        const where = `${entry.id} ${a}v${b}`;

        if (deal.a.length !== a || deal.b.length !== b) {
          problems.push(
            `${where}: asked for ${a} and ${b} bots, got ${deal.a.length} and ${deal.b.length}.`,
          );
          continue;
        }

        const [short, long] = deal.a.length <= deal.b.length ? [deal.a, deal.b] : [deal.b, deal.a];
        const cs = tally(short);
        const cl = tally(long);

        let differing = 0;
        for (const tier of BOT_TIERS) {
          const s = cs[tier];
          const l = cl[tier];
          if (s > l) {
            problems.push(
              `${where}: the smaller side holds ${s} ${tier} against the larger side's ${l}; ` +
                'a side that is a body down cannot hold more of anything.',
            );
          }
          differing += Math.abs(s - l);
          if (Math.abs(s - l) > 1 && Math.abs(a - b) <= 1) {
            problems.push(
              `${where}: ${tier} is ${cs[tier]} against ${cl[tier]} — the two sides differ by ` +
                'more than one body of a single tier on an evenly split roster.',
            );
          }
        }
        if (differing !== Math.abs(a - b)) {
          problems.push(
            `${where}: the rosters differ by ${differing} entries where the head-count only ` +
              `forces ${Math.abs(a - b)}.`,
          );
        }

        // The bodies the short side does without are the weakest ones dealt.
        const missing: BotTier[] = [];
        for (const tier of BOT_TIERS) {
          for (let i = 0; i < cl[tier] - cs[tier]; i++) missing.push(tier);
        }
        for (const gone of missing) {
          for (const kept of short) {
            if (strength(gone) > strength(kept)) {
              problems.push(
                `${where}: the smaller side does without a ${gone} while keeping a ${kept}. ` +
                  'The side that is a body down keeps the stronger half, not the weaker one.',
              );
            }
          }
        }

        /*
         * A seat taken and given back leaves the roster where it was found.
         *
         * The seam round 4 already found broken once: `replacePlayerWithBot` deals a tier of
         * its own, so it can disagree with the deal and nothing says so — a replacement at the
         * wrong tier produces no error and no divergence, only one bot that is harder or softer
         * than the rest. This walks the whole cycle a human puts a side through:
         * `removeOne` takes the newest bot off a side, and `tierForExtraBot` has to name that
         * same tier when the seat comes back.
         */
        for (const team of ['A', 'B'] as const) {
          const mine = team === 'A' ? deal.a : deal.b;
          const theirs = team === 'A' ? deal.b : deal.a;
          if (mine.length === 0) continue;
          const taken = mine[mine.length - 1];
          const afterJoin = mine.slice(0, -1);
          const back = tierForExtraBot(afterJoin, theirs, entry.mix);
          if (back !== taken) {
            problems.push(
              `${where}: a human took team ${team}'s ${taken} seat and a ${back} came back. ` +
                'A replacement has to restore the roster the deal made, not deal its own.',
            );
          }
        }
      }
    }

    // One readable line per shipped shape: a full even roster, and the same roster with one
    // seat taken by a human.
    for (const [teamA, teamB] of [
      [5, 5],
      [4, 5],
      [4, 4],
      [3, 4],
    ] as const) {
      const deal = dealTiers(teamA, teamB, entry.mix);
      rows.push({
        id: entry.id,
        teamA,
        teamB,
        a: deal.a.join(' '),
        b: deal.b.join(' '),
      });
    }
  }

  return { deals, problems, rows };
}
