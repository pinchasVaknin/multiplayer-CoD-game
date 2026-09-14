import { describe, expect, it } from 'vitest';
import type { MatchResult } from './GameMode';
import { isMvp, personalOutcome, wonBy, type PlaceableRow } from './MatchOutcome';

/**
 * Characterisation of the one comparison that used to be written four times: who won, and
 * what the headline says for everybody else — VICTORY or DEFEAT in a team mode, a place where
 * the mode crowned an individual, with the winner pinned to first whatever the ladder says.
 */

function result(winner: MatchResult['winner'], winnerEntityId?: number): MatchResult {
  const base = { kind: 'match' as const, reason: 'Score limit', scoreA: 75, scoreB: 60, roundsA: 1, roundsB: 0, winner };
  return winnerEntityId === undefined ? base : { ...base, winnerEntityId };
}

function row(entityId: number, score: number, kills = 0, deaths = 0): PlaceableRow {
  return { entityId, score, kills, deaths };
}

describe('wonBy', () => {
  it('a draw is nobody\'s win', () => {
    expect(wonBy(result('DRAW'), 'A', 1)).toBe(false);
    expect(wonBy(result('DRAW', 1), 'A', 1)).toBe(false);
  });

  it('in a team mode the side decides', () => {
    expect(wonBy(result('A'), 'A', 1)).toBe(true);
    expect(wonBy(result('A'), 'B', 1)).toBe(false);
  });

  it('where the mode named an individual, only that individual won — not their side', () => {
    expect(wonBy(result('A', 7), 'A', 7)).toBe(true);
    expect(wonBy(result('A', 7), 'A', 8)).toBe(false);
    expect(wonBy(result('A', 7), 'B', 7)).toBe(true);
  });
});

describe('personalOutcome', () => {
  it('VICTORY, DEFEAT and DRAW for a team result', () => {
    expect(personalOutcome(result('A'), 'A', 1, [])).toEqual({ kind: 'WIN', label: 'VICTORY' });
    expect(personalOutcome(result('A'), 'B', 1, [])).toEqual({ kind: 'LOSS', label: 'DEFEAT' });
    expect(personalOutcome(result('DRAW'), 'A', 1, [])).toEqual({ kind: 'DRAW', label: 'DRAW' });
  });

  it('gives everybody but the winner a place from the ladder', () => {
    const rows = [row(1, 500), row(2, 400), row(3, 300), row(4, 200)];
    const r = result('A', 1);
    expect(personalOutcome(r, 'A', 1, rows).label).toBe('VICTORY');
    expect(personalOutcome(r, 'A', 2, rows)).toEqual({ kind: 'LOSS', label: '2ND' });
    expect(personalOutcome(r, 'B', 3, rows).label).toBe('3RD');
    expect(personalOutcome(r, 'B', 4, rows).label).toBe('4TH');
  });

  it('pins the winner to first even when the ladder ranks them lower', () => {
    // The mode decides on kills, the ladder on score: 2 outscores the winner 1 here.
    const rows = [row(2, 900), row(1, 500), row(3, 300)];
    const r = result('A', 1);
    expect(personalOutcome(r, 'A', 2, rows).label).toBe('2ND');
    expect(personalOutcome(r, 'A', 3, rows).label).toBe('3RD');
  });

  it('a reader with no row is placed last plus one', () => {
    const rows = [row(1, 500), row(2, 400)];
    expect(personalOutcome(result('A', 1), 'A', 99, rows).label).toBe('3RD');
  });

  it('spells the ordinals the way the summary shows them', () => {
    const rows: PlaceableRow[] = [];
    for (let i = 1; i <= 23; i++) rows.push(row(i, 1000 - i));
    const r = result('A', 1);
    const label = (id: number): string => personalOutcome(r, 'A', id, rows).label;
    expect(label(11)).toBe('11TH');
    expect(label(12)).toBe('12TH');
    expect(label(13)).toBe('13TH');
    expect(label(21)).toBe('21ST');
    expect(label(22)).toBe('22ND');
    expect(label(23)).toBe('23RD');
  });
});

describe('isMvp', () => {
  it('is the unique top score, with ties going to nobody', () => {
    expect(isMvp([row(1, 500), row(2, 400)], 1)).toBe(true);
    expect(isMvp([row(1, 500), row(2, 400)], 2)).toBe(false);
    expect(isMvp([row(1, 500), row(2, 500)], 1)).toBe(false);
    expect(isMvp([row(1, 500), row(2, 500)], 2)).toBe(false);
  });

  it('a zero score, or no row, is never MVP', () => {
    expect(isMvp([row(1, 0)], 1)).toBe(false);
    expect(isMvp([row(1, 500)], 2)).toBe(false);
  });
});
