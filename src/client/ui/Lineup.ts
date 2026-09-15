import { compareRows, type Rankable, type ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { WinnerFacts } from '../../shared/modes/MatchOutcome';

/**
 * Who stands on the podium after a match, and where (M15, D1).
 *
 * Pure: a result, a board, and a ceiling in, a ranked list out — so the rule that decides who
 * is on the stage is a function with a test rather than a branch inside a screen. The screen
 * turns each entry into a body; this decides the entries.
 *
 * **The winning team, in ladder order, the MVP first.** In a team mode the winning side's rows
 * sorted as the board sorts them (`compareRows`), capped at the stage's five. In Free-for-All
 * the board is one ladder, so the podium is the top of it — three, as the brief says — with
 * the crowned winner pinned to first for the reason `personalOutcome` pins them: the mode
 * decides on kills and the ladder on score, and a podium whose centre is not the winner is
 * a podium that disagrees with the headline over it. A draw has no winning side, so the
 * podium is the top of the whole board: the best five, whatever side they were on.
 *
 * **Where each stands** is `slotPositions`: the MVP centre and a step forward, the rest
 * fanning out by rank — second on the viewer's left, third on the right, fourth far left,
 * fifth far right — so the eye reads the podium the way it reads the board.
 */

export interface LineupRow extends Rankable {
  readonly entityId: number;
  readonly displayName: string;
  readonly team: ScoreTeam;
  readonly isLocal: boolean;
}

/** Bodies the platform has room for at 1920. */
export const LINEUP_MAX = 5;
/** Free-for-All's podium: the top three, as the brief asks. */
export const LINEUP_FFA = 3;

/** The rows to stand on the stage, best first. Empty for an empty board. */
export function lineupOf<T extends LineupRow>(result: WinnerFacts, rows: readonly T[], freeForAll: boolean): T[] {
  const ladder = [...rows].sort(compareRows);
  let pool: T[];
  let cap = LINEUP_MAX;
  if (result.winner === 'DRAW') {
    pool = ladder;
  } else if (freeForAll || result.winnerEntityId !== undefined) {
    pool = ladder;
    cap = LINEUP_FFA;
  } else {
    const side = result.winner;
    pool = ladder.filter((row) => row.team === side);
  }
  const crowned = result.winnerEntityId;
  if (crowned !== undefined) {
    const at = pool.findIndex((row) => row.entityId === crowned);
    if (at > 0) {
      const [winner] = pool.splice(at, 1);
      if (winner !== undefined) pool.unshift(winner);
    }
  }
  return pool.slice(0, cap);
}

export interface SlotPosition {
  /** Metres from the platform's centre, across. */
  readonly x: number;
  /** Metres toward the camera. */
  readonly z: number;
  /** Radians. π faces the camera; the flanks turn a little toward the centre. */
  readonly yaw: number;
}

/** Metres between neighbours on the platform. */
const SPACING = 1.25;
/** How far the MVP steps toward the camera. */
const MVP_STEP = 0.45;
/** How far the flanks turn in, per metre off the centre line. */
const FLANK_TURN = 0.11;

/**
 * Where `count` bodies stand, by rank: index 0 is the MVP. The order across the platform is
 * `[5th, 3rd, 1st, 2nd, 4th]` for five — a body's rank grows with its distance from the
 * centre, alternating sides, the second on the viewer's left (−X). With an even count the
 * group is centred rather than the MVP.
 */
export function slotPositions(count: number): SlotPosition[] {
  const n = Math.max(0, Math.min(LINEUP_MAX, Math.round(count)));
  // Offsets by rank: 0, -1, +1, -2, +2 — then shifted so the group is centred.
  const offsets: number[] = [];
  for (let rank = 0; rank < n; rank++) {
    const step = Math.ceil(rank / 2);
    offsets.push(rank === 0 ? 0 : rank % 2 === 1 ? -step : step);
  }
  const mean = offsets.reduce((sum, o) => sum + o, 0) / Math.max(1, n);
  return offsets.map((offset, rank) => {
    const x = (offset - mean) * SPACING;
    // Yaw π + δ faces +X, so a body on +X turns toward the centre by *subtracting* its offset.
    return { x, z: rank === 0 ? MVP_STEP : 0, yaw: Math.PI - x * FLANK_TURN };
  });
}
