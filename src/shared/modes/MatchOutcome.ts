import { compareRows, type Rankable, type ScoreTeam } from '../combat/ScoreSystem';
import type { MatchResult } from './GameMode';

/**
 * What a match result means to one player (M13 Phase A, bug 4.4).
 *
 * ## The report
 *
 * *"In Free-for-All everybody on the winner's side reads VICTORY."* `MatchResult.winner` is a
 * `ScoreTeam`, FFA keeps the two-team substrate, and every surface that said VICTORY or DEFEAT
 * compared the winner's side to the reader's — `EndOfMatch.show`, `MatchFlow.endMatch`'s
 * announcer cue, and `Game`'s `won` that decides the WIN BONUS line and the profile's win
 * tally. Four readers, one comparison, all of them wrong for three players out of every four.
 *
 * ## One function
 *
 * `MatchResult` now carries `winnerEntityId` where the mode crowns an individual, and this is
 * the one reader of it. Every surface asks this rather than comparing sides itself, so a fifth
 * surface cannot re-introduce the bug by writing `winner === localTeam` — there is no reason to,
 * because the answer it wants is already a function.
 *
 * ## Places
 *
 * In a mode with one winner everybody else gets a *place*, which is what the reference games
 * show and what the human asked for: "2ND", "3RD", not DEFEAT. The place is the reader's rank on
 * the ladder — `compareRows`, the same order the board draws — with the winner pinned to first
 * whatever the ladder says. The pin matters: the mode decides the winner on **kills** and the
 * ladder ranks on **score** first, and in single-player a headshot is worth half a kill in
 * points, so the two orders can disagree at the top. A board that shows the winner second is a
 * cosmetic oddity; a summary that shows two players "1ST" is a lie, and the pin is what stops it.
 */

type OutcomeKind = 'WIN' | 'LOSS' | 'DRAW';

export interface PersonalOutcome {
  readonly kind: OutcomeKind;
  /** The headline: VICTORY, DEFEAT, DRAW, or an ordinal place. */
  readonly label: string;
}

/** A row that can be placed: who it is, and what it ranks by. */
export interface PlaceableRow extends Rankable {
  readonly entityId: number;
}

/** The two facts a result carries about who won. `MatchResult` has them; so does the server's. */
export type WinnerFacts = Pick<MatchResult, 'winner' | 'winnerEntityId'>;

/**
 * Whether the player seated on `team` as `entityId` won `result`.
 *
 * The one comparison that used to be written four times. Where the mode named an individual,
 * only that individual won; otherwise the side decides, as it always has.
 */
export function wonBy(result: WinnerFacts, team: ScoreTeam, entityId: number): boolean {
  if (result.winner === 'DRAW') return false;
  if (result.winnerEntityId !== undefined) return result.winnerEntityId === entityId;
  return result.winner === team;
}

/**
 * The headline for one reader.
 *
 * `rows` is whatever ladder the reader has — the local `ScoreSystem`'s rows in the browser, the
 * summary's rows on the wire — and only matters when the mode crowned an individual and this
 * reader is not them.
 */
export function personalOutcome(
  result: MatchResult,
  team: ScoreTeam,
  entityId: number,
  rows: readonly PlaceableRow[],
): PersonalOutcome {
  if (result.winner === 'DRAW') return { kind: 'DRAW', label: 'DRAW' };
  if (wonBy(result, team, entityId)) return { kind: 'WIN', label: 'VICTORY' };
  const winnerId = result.winnerEntityId;
  if (winnerId === undefined) return { kind: 'LOSS', label: 'DEFEAT' };
  return { kind: 'LOSS', label: ordinal(placeOf(rows, entityId, winnerId)) };
}

/**
 * 1-based rank of `entityId` on the ladder, with `winnerId` pinned to first.
 *
 * A reader with no row — a spectator, a client whose replicated rows never arrived — is last
 * plus one, which is honest about what the reader knows rather than a guess at a place.
 */
function placeOf(rows: readonly PlaceableRow[], entityId: number, winnerId: number): number {
  let mine: PlaceableRow | undefined;
  for (const row of rows) if (row.entityId === entityId) mine = row;
  if (mine === undefined) return rows.length + 1;
  // The winner outranks everybody by decree; among the rest, the ladder decides.
  let above = entityId === winnerId ? 0 : 1;
  for (const row of rows) {
    if (row.entityId === entityId || row.entityId === winnerId) continue;
    if (compareRows(row, mine) < 0) above++;
  }
  return above + 1;
}

/**
 * Whether `entityId` is the match's MVP: the top score on the board, with ties going to nobody
 * (M13 Phase B, lifted from `MatchMeta`).
 *
 * An XP rule rather than a scoreboard fact, and one rule: the client decided it for the local
 * player and the server now decides it per seat, and two MVPs is not what the word means.
 */
export function isMvp(rows: readonly PlaceableRow[], entityId: number): boolean {
  let mine: PlaceableRow | undefined;
  for (const row of rows) if (row.entityId === entityId) mine = row;
  if (mine === undefined || mine.score <= 0) return false;
  for (const row of rows) {
    if (row === mine) continue;
    if (row.score >= mine.score) return false;
  }
  return true;
}

/** `1ST`, `2ND`, `3RD`, `4TH` ... `11TH`, `12TH`, `13TH`, `21ST`. */
function ordinal(place: number): string {
  const n = Math.max(1, Math.round(place));
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? 'TH' : n % 10 === 1 ? 'ST' : n % 10 === 2 ? 'ND' : n % 10 === 3 ? 'RD' : 'TH';
  return `${n}${suffix}`;
}
