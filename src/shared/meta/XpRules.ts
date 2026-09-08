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
  /**
   * Playing a match, and how long it ran (playtest round 5, B6).
   *
   * Every other row in this table is contingent on succeeding, so a player who went 0-6 and
   * lost earned **nothing** — the game's answer to a full match was that it had not happened,
   * and the summary panel under the bar rendered as an empty box because there were no rows to
   * put in it. These two are the floor: `matchComplete` is a flat award for reaching the end of
   * a match, `matchTime` a per-minute term so that a long match pays more than a short one.
   *
   * They are rows in the same table rather than a special case at the summing site, which means
   * they animate, sum and display exactly like the nine below them and there is nothing for a
   * renderer to know about.
   */
  | 'matchComplete'
  | 'matchTime'
  | 'kill'
  | 'headshot'
  | 'assist'
  | 'objective'
  | 'longshot'
  | 'win'
  | 'mvp'
  | 'streak'
  | 'challenge'
  | 'weaponLevel'
  /**
   * A flat award issued by a server instance (M11, §6.9).
   *
   * The dedicated server computes its own XP breakdown from authoritative events and sends it
   * with the summary. Those lines are already labelled for display, so they carry this one id
   * rather than being reverse-engineered back into the client-side source taxonomy above —
   * which the server has no view of and could only be guessed at from the label text.
   */
  | 'match';

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
  /**
   * The floor, first, and the order is the argument.
   *
   * The rest of the table is during-the-match then end-of-match, so the bar fills the way the
   * match happened. These sit ahead of all of it because they are what the match was worth
   * *before* anybody did anything in it — and because B6's complaint is precisely that a bad
   * match moved nothing at all, so the first row to land should be the one that always lands.
   *
   * 500 is the number a dedicated server has already been paying as `MATCH COMPLETE` since
   * M11 — kept rather than rechosen, so making one table authoritative is not also a balance
   * argument. 25 a minute is deliberately the smallest per-unit award here except a headshot:
   * ten minutes of standing still pays 250, which is less than three kills.
   */
  { id: 'matchComplete', label: 'Match complete', value: 500, kind: 'flat' },
  { id: 'matchTime', label: 'Time played', value: 25, kind: 'each' },
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

/**
 * Whole minutes of match, which is what `matchTime` is counted in (round 5, B6).
 *
 * Floored rather than rounded, and exported rather than written twice: single-player counts
 * these off `MatchProgression`'s own per-tick sampler and a dedicated server counts them off
 * `ServerMatch.tickCount`, and two runtimes disagreeing about what a minute is would be the
 * same class of defect B5 and B7 were. A match under a minute pays the flat award and no time
 * row at all, which is the honest answer rather than a rounded-up one.
 */
export function matchMinutes(seconds: number): number {
  return Math.max(0, Math.floor(seconds / 60));
}

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

/**
 * A match's breakdown, which is never empty (playtest round 5, B6).
 *
 * The tuple is the point. B6's second half was the summary panel rendering as an empty box for
 * a match that paid nothing, and the fix asked for is that the renderer *cannot be handed* an
 * empty tally rather than that it defends against one. `matchComplete` is awarded to every
 * match that reaches a summary, so there is always a head — and building the list as
 * `[floor, ...rest]` is what makes the compiler agree.
 */
export type XpLines = readonly [XpLine, ...XpLine[]];

/**
 * The row every finished match has.
 *
 * Both entry points build their list on top of this one: `MatchProgression` for a match this
 * client simulated, and `Game.bankServerXp` for one a server scored. Shared rather than written
 * twice, because it is the row that makes the type non-empty and two spellings of it would be
 * two floors.
 */
export function matchFloorLine(): XpLine {
  const source = xpSource('matchComplete');
  return { id: source.id, label: source.label, count: 1, xp: source.value, kind: source.kind };
}

/** A finished match's XP, ready for the summary screen and for the profile to bank. */
export interface XpReport {
  readonly lines: XpLines;
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

/*
 * There is deliberately no `emptyXpReport` (round 5, B6).
 *
 * There was one, and its only caller was `MatchProgression.finish`'s idempotence guard: a
 * second call returned a report of zeroes. That is not idempotent, it is a lie told the second
 * time — the match did pay something, and a caller asking twice should be told the same thing
 * twice. `finish` caches what it produced and hands it back, which is both idempotent and true,
 * and it is what lets `XpLines` be non-empty without an exception carved out for it.
 */
