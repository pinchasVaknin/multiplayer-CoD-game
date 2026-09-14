import { describe, expect, it } from 'vitest';
import { rotateHalf, rotateHalfProps, rotateHalfSpawns } from './build';
import type { Brush, PropDef, SpawnZone } from './types';

/**
 * Characterisation of the half-map rotation: `(x, z) -> (-x, -z)`, `yaw -> yaw + pi`, `y`
 * untouched, applied to a two-element input; and the one refusal — a pitched brush throws.
 */

const BRUSHES: readonly Brush[] = [
  { position: { x: 3, y: 1, z: -4 }, size: { x: 2, y: 2, z: 2 }, rotationY: 0.5, material: 'concrete', solid: true },
  { position: { x: -1, y: 0.5, z: 2 }, size: { x: 4, y: 1, z: 1 }, rotationY: 0, material: 'metal', shadows: false, uvScale: 2 },
];

const PROPS: readonly PropDef[] = [
  { shape: 'crate', position: { x: 5, y: 0, z: 6 }, rotationY: 1 },
  { shape: 'pillar', position: { x: -2, y: 0, z: -3 }, rotationY: -1 },
];

const SPAWNS: readonly SpawnZone[] = [
  { team: 'A', position: { x: 10, y: 0, z: 20 }, facingYaw: 0, radius: 3 },
  { team: 'A', position: { x: -10, y: 1, z: 20 }, facingYaw: 1.5, radius: 2 },
];

describe('rotateHalf', () => {
  it('negates x and z, keeps y, adds pi to the yaw, and keeps every other field', () => {
    const out = rotateHalf(BRUSHES);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ ...BRUSHES[0], position: { x: -3, y: 1, z: 4 }, rotationY: 0.5 + Math.PI });
    expect(out[1]).toEqual({ ...BRUSHES[1], position: { x: 1, y: 0.5, z: -2 }, rotationY: Math.PI });
  });

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(BRUSHES));
    rotateHalf(BRUSHES);
    expect(BRUSHES).toEqual(copy);
  });

  it('refuses a pitched brush', () => {
    const pitched: Brush = { ...BRUSHES[0]!, rotationX: 0.2 };
    expect(() => rotateHalf([pitched])).toThrow(/pitched brush/);
    const rolled: Brush = { ...BRUSHES[0]!, rotationZ: 0.2 };
    expect(() => rotateHalf([rolled])).toThrow(/pitched brush/);
  });
});

describe('rotateHalfProps', () => {
  it('rotates each placement and keeps the shape', () => {
    expect(rotateHalfProps(PROPS)).toEqual([
      { shape: 'crate', position: { x: -5, y: 0, z: -6 }, rotationY: 1 + Math.PI },
      { shape: 'pillar', position: { x: 2, y: 0, z: 3 }, rotationY: -1 + Math.PI },
    ]);
  });
});

describe('rotateHalfSpawns', () => {
  it('hands the rotated half to team B', () => {
    expect(rotateHalfSpawns(SPAWNS)).toEqual([
      { team: 'B', position: { x: -10, y: 0, z: -20 }, facingYaw: Math.PI, radius: 3 },
      { team: 'B', position: { x: 10, y: 1, z: -20 }, facingYaw: 1.5 + Math.PI, radius: 2 },
    ]);
  });

  it('rotating twice returns to the original positions, on the other team', () => {
    const twice = rotateHalfSpawns(rotateHalfSpawns(SPAWNS));
    expect(twice.map((z) => z.position)).toEqual(SPAWNS.map((z) => z.position));
    expect(twice[0]?.facingYaw).toBeCloseTo(2 * Math.PI, 12);
    expect(twice.every((z) => z.team === 'B')).toBe(true);
  });
});
