import { describe, expect, it } from 'vitest';
import type { PlayerScore, ScoreTeam } from '../combat/ScoreSystem';
import { COL_ACC, COL_BEST, COL_DEATHS, COL_KD, COL_KILLS, COL_SCORE, teamScoreWinCondition } from './GameMode';

/**
 * Characterisation of the two pure pieces of `GameMode`: the shared win condition over the
 * same score grid `npm run content` prints for TDM (limit 75), and the six shared columns over
 * the same three fixed rows. The expected strings are the probe's own output on 2026-09-14, so
 * this and the probe cannot drift apart without one of them going red.
 */

function row(
  entityId: number,
  displayName: string,
  team: ScoreTeam,
  kills: number,
  deaths: number,
  assists: number,
  score: number,
  bestStreak: number,
  shotsFired: number,
  shotsHit: number,
  objective: number,
): PlayerScore {
  return {
    entityId, displayName, team, isLocal: false, kills, deaths, assists, score, streak: 0, bestStreak,
    shotsFired, shotsHit, damageDealt: kills * 100, headshots: 0,
    captures: objective, defends: objective, plants: objective, defuses: objective, tags: objective,
  };
}

const EMPTY = row(1, 'EMPTY', 'A', 0, 0, 0, 0, 0, 0, 0, 0);
const FULL = row(2, 'FULL', 'B', 12, 4, 3, 1450, 7, 40, 25, 2);
const THIRDS = row(3, 'THIRDS', 'A', 1, 3, 0, 100, 1, 3, 1, 0);
const ROWS = [EMPTY, FULL, THIRDS];

describe('teamScoreWinCondition', () => {
  const LIMIT = 75;
  const RUNNING = 1000;
  const OUT = 0;

  it('is null while nobody is at the limit and the clock is running', () => {
    for (const [a, b] of [[0, 0], [74, 0], [40, 30], [30, 40], [1, 1]]) {
      expect(teamScoreWinCondition(a ?? 0, b ?? 0, LIMIT, RUNNING, 'Score limit')).toBeNull();
    }
  });

  it('crowns the side that reaches the limit, and credits it with the one round', () => {
    expect(teamScoreWinCondition(75, 0, LIMIT, RUNNING, 'Score limit')).toEqual({
      kind: 'match', winner: 'A', reason: 'Score limit', scoreA: 75, scoreB: 0, roundsA: 1, roundsB: 0,
    });
    expect(teamScoreWinCondition(0, 75, LIMIT, RUNNING, 'Score limit')).toEqual({
      kind: 'match', winner: 'B', reason: 'Score limit', scoreA: 0, scoreB: 75, roundsA: 0, roundsB: 1,
    });
    expect(teamScoreWinCondition(80, 75, LIMIT, RUNNING, 'Score limit')?.winner).toBe('A');
  });

  it('a tie at the limit is a draw with no round to either side', () => {
    expect(teamScoreWinCondition(75, 75, LIMIT, RUNNING, 'Score limit')).toEqual({
      kind: 'match', winner: 'DRAW', reason: 'Score limit', scoreA: 75, scoreB: 75, roundsA: 0, roundsB: 0,
    });
  });

  it('when the clock runs out the leader wins on time, and a tie is "Time — draw"', () => {
    expect(teamScoreWinCondition(74, 0, LIMIT, OUT, 'Score limit')).toEqual({
      kind: 'match', winner: 'A', reason: 'Time limit', scoreA: 74, scoreB: 0, roundsA: 1, roundsB: 0,
    });
    expect(teamScoreWinCondition(30, 40, LIMIT, OUT, 'Score limit')?.winner).toBe('B');
    expect(teamScoreWinCondition(30, 40, LIMIT, OUT, 'Score limit')?.reason).toBe('Time limit');
    expect(teamScoreWinCondition(0, 0, LIMIT, OUT, 'Score limit')).toEqual({
      kind: 'match', winner: 'DRAW', reason: 'Time — draw', scoreA: 0, scoreB: 0, roundsA: 0, roundsB: 0,
    });
    expect(teamScoreWinCondition(1, 1, LIMIT, OUT, 'Score limit')?.reason).toBe('Time — draw');
  });

  it('the limit outranks the clock, and the limit reason is the caller\'s word', () => {
    expect(teamScoreWinCondition(75, 0, LIMIT, OUT, 'Score limit')?.reason).toBe('Score limit');
    expect(teamScoreWinCondition(74, 0, 50, RUNNING, 'Tag limit')?.reason).toBe('Tag limit');
  });
});

describe('the shared scoreboard columns', () => {
  it('have the widths and alignment the probe prints', () => {
    const shape = (c: typeof COL_SCORE): [string, string, number, string] => [c.key, c.label, c.width, c.align];
    expect(shape(COL_SCORE)).toEqual(['score', 'Score', 6, 'right']);
    expect(shape(COL_KILLS)).toEqual(['kills', 'K', 4, 'right']);
    expect(shape(COL_DEATHS)).toEqual(['deaths', 'D', 4, 'right']);
    expect(shape(COL_KD)).toEqual(['kd', 'K/D', 5, 'right']);
    expect(shape(COL_ACC)).toEqual(['acc', 'Acc', 6, 'right']);
    expect(shape(COL_BEST)).toEqual(['streak', 'Best', 5, 'right']);
  });

  it('render the three fixed rows as the probe prints them', () => {
    expect(ROWS.map(COL_SCORE.value)).toEqual(['0', '1450', '100']);
    expect(ROWS.map(COL_KILLS.value)).toEqual(['0', '12', '1']);
    expect(ROWS.map(COL_DEATHS.value)).toEqual(['0', '4', '3']);
    expect(ROWS.map(COL_KD.value)).toEqual(['0.00', '3.00', '0.33']);
    expect(ROWS.map(COL_ACC.value)).toEqual(['—', '63%', '33%']);
    expect(ROWS.map(COL_BEST.value)).toEqual(['0', '7', '1']);
  });
});
