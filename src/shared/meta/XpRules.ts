import type { CamoId } from './Camos';

/**
 * What earns XP, and how much (brief S6.1).
 *
 * S3 says every number that affects feel lives in a config. Progression is nothing *but*
 * those numbers, so the whole award table is here and nothing downstream hardcodes a
 * value — `MatchProgression` counts events and multiplies by a row from this file, and
 * the XP simulator reads the same rows to project the curve.
 *
 * The four rates come straight from S6.1: 100 a kill, 50 an assist, 200 an objective,
 * plus match bonuses. The bonuses are this file's own decision, and each one is chosen to
 * reward something a player can actually pursue: winning, being the best player on the
 * board, and not dying.
 */

/**
 * Every distinct line the end-of-match breakdown can show.
 *
 * The union is closed on purpose: the summary bar draws one row per source in this order,
 * and a source that could arrive without a row would be XP the player is never told about.
 */
export type XpSourceId =
  | 'kill'
  | 'headshot'
  | 'assist'
  | 'objective'
  | 'longshot'
  | 'win'
  | 'mvp'
  | 'streak'
  | 'challenge'
  | 'weaponLevel';

export interface XpSource {
  readonly id: XpSourceId;
  readonly label: string;
  /** XP per unit. Bonuses that are not per-unit carry their whole value here. */
  readonly value: number;
  /**
   * How the breakdown phrases the count. `each` prints "12 x 100"; `flat` prints the
   * bonus alone, because "1 x 500" for a match win reads as a bug.
   */
  readonly kind: 'each' | 'flat';
}

/**
 * The award table.
 *
 * Order is the order the summary animates them in, which is deliberately
 * during-the-match first and end-of-match second — the bar fills the way the match
 * happened.
 */
export const XP_SOURCES: readonly XpSource[] = [
  { id: 'kill', label: 'Kills', value: 100, kind: 'each' },
  { id: 'headshot', label: 'Headshots', value: 25, kind: 'each' },
  { id: 'assist', label: 'Assists', value: 50, kind: 'each' },
  { id: 'objective', label: 'Objectives', value: 200, kind: 'each' },
  { id: 'longshot', label: 'Longshots', value: 30, kind: 'each' },
  { id: 'challenge', label: 'Challenges', value: 1, kind: 'each' },
  { id: 'weaponLevel', label: 'Weapon levels', value: 250, kind: 'each' },
  { id: 'win', label: 'Match win', value: 500, kind: 'flat' },
  { id: 'mvp', label: 'MVP', value: 300, kind: 'flat' },
  { id: 'streak', label: 'Best streak', value: 25, kind: 'each' },
];

const BY_ID = new Map<XpSourceId, XpSource>(XP_SOURCES.map((s) => [s.id, s]));

export function xpSource(id: XpSourceId): XpSource {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`Unknown XP source "${id}"`);
  return found;
}

/**
 * `challenge` is the one row whose value is not fixed: a challenge carries its own XP
 * award, so the tally accumulates the awarded totals and the row's `value` of 1 makes the
 * multiplication a no-op. Recorded here rather than special-cased at the call site.
 */
export const XP_SOURCES_WITH_OWN_VALUE: ReadonlySet<XpSourceId> = new Set<XpSourceId>(['challenge']);

/** Metres beyond which a kill counts as a longshot. Also the challenge threshold. */
export const LONGSHOT_METRES = 38;

/**
 * Seconds of grace on an assist: damage this recently before a death counts toward it.
 *
 * Long enough that softening somebody up and losing the trade still credits you, short
 * enough that a hit landed at the start of the lane does not.
 */
export const ASSIST_WINDOW_SECONDS = 8;

/**
 * Per-weapon XP is a fraction of what the *player* earns with that weapon in hand.
 *
 * Deriving it rather than giving weapons a second award table means a weapon can never
 * level from something the player was not rewarded for, and there is one place to tune
 * how fast attachments arrive relative to the account.
 */
export const WEAPON_XP_FRACTION = 0.6;

/**
 * One row of the end-of-match breakdown.
 *
 * `count` is how many of the thing happened and `xp` is what it was worth in total, so
 * the summary can print "12 x 100 = 1200" without recomputing anything and without
 * being able to disagree with the total that was banked.
 */
export interface XpLine {
  readonly id: XpSourceId;
  readonly label: string;
  readonly count: number;
  readonly xp: number;
  readonly kind: 'each' | 'flat';
}

/** A finished match's XP, ready for the summary screen and for the profile to bank. */
export interface XpReport {
  readonly lines: readonly XpLine[];
  readonly total: number;
  /** Lifetime XP before this match was banked. */
  readonly xpBefore: number;
  readonly levelBefore: number;
  readonly levelAfter: number;
  /** Weapon ids that gained a level this match, in the order they did. */
  readonly weaponLevelUps: readonly string[];
  /** Challenge ids completed this match. */
  readonly challengesCompleted: readonly string[];
  /** Camo ids unlocked this match. */
  readonly camosUnlocked: readonly CamoId[];
}

export function emptyXpReport(): XpReport {
  return {
    lines: [],
    total: 0,
    xpBefore: 0,
    levelBefore: 1,
    levelAfter: 1,
    weaponLevelUps: [],
    challengesCompleted: [],
    camosUnlocked: [],
  };
}
