import { describe, expect, it } from 'vitest';
import { LINEUP_FFA, LINEUP_MAX, lineupOf, slotPositions, type LineupRow } from './Lineup';

function row(entityId: number, team: 'A' | 'B', score: number, kills = 0): LineupRow {
  return { entityId, displayName: `P${entityId}`, team, isLocal: entityId === 1, score, kills, deaths: 0 };
}

const board: LineupRow[] = [
  row(1, 'A', 900, 9),
  row(2, 'A', 1500, 12),
  row(3, 'A', 300, 3),
  row(4, 'A', 1200, 10),
  row(5, 'A', 700, 7),
  row(6, 'A', 100, 1),
  row(7, 'B', 2000, 20),
  row(8, 'B', 50, 0),
];

describe('lineupOf', () => {
  it('stands the winning side on the platform in ladder order, capped at five', () => {
    const podium = lineupOf({ winner: 'A' }, board, false);
    expect(podium.map((r) => r.entityId)).toEqual([2, 4, 1, 5, 3]);
    expect(podium).toHaveLength(LINEUP_MAX);
  });

  it('shows the other side when they won, however the ladder reads', () => {
    expect(lineupOf({ winner: 'B' }, board, false).map((r) => r.entityId)).toEqual([7, 8]);
  });

  it('takes the top three of the whole ladder in Free-for-All, the crowned winner first', () => {
    // The mode decided on kills: entity 4 with fewer points than 7 and 2 is still the winner.
    const podium = lineupOf({ winner: 'A', winnerEntityId: 4 }, board, true);
    expect(podium.map((r) => r.entityId)).toEqual([4, 7, 2]);
    expect(podium).toHaveLength(LINEUP_FFA);
  });

  it('gives a draw the best five of both sides', () => {
    expect(lineupOf({ winner: 'DRAW' }, board, false).map((r) => r.entityId)).toEqual([7, 2, 4, 1, 5]);
  });

  it('is empty for an empty board', () => {
    expect(lineupOf({ winner: 'A' }, [], false)).toEqual([]);
  });
});

describe('slotPositions', () => {
  it('puts the MVP at the centre and a step forward, the rest fanning out by rank', () => {
    const slots = slotPositions(5);
    expect(slots[0]?.x).toBeCloseTo(0);
    expect(slots[0]?.z).toBeGreaterThan(0);
    expect(slots.slice(1).every((s) => s.z === 0)).toBe(true);
    // Second on the viewer's left (−X), third on the right, fourth and fifth outside them.
    expect(slots[1]!.x).toBeLessThan(0);
    expect(slots[2]!.x).toBeGreaterThan(0);
    expect(slots[3]!.x).toBeLessThan(slots[1]!.x);
    expect(slots[4]!.x).toBeGreaterThan(slots[2]!.x);
    expect(slots[2]!.x).toBeCloseTo(-slots[1]!.x);
  });

  it('centres an even group rather than the MVP', () => {
    const two = slotPositions(2);
    expect(two[0]!.x + two[1]!.x).toBeCloseTo(0);
    expect(two[0]!.x).toBeGreaterThan(0);
  });

  it('turns the flanks toward the centre', () => {
    const slots = slotPositions(3);
    // Yaw π + δ faces +X, so a body on −X turns toward +X with a yaw above π, and vice versa.
    expect(slots[1]!.yaw).toBeGreaterThan(Math.PI);
    expect(slots[2]!.yaw).toBeLessThan(Math.PI);
    expect(slots[0]!.yaw).toBeCloseTo(Math.PI);
  });

  it('never exceeds the platform', () => {
    expect(slotPositions(9)).toHaveLength(LINEUP_MAX);
    expect(slotPositions(0)).toEqual([]);
  });
});
