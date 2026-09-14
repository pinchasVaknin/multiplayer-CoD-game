import { describe, expect, it } from 'vitest';
import { eventSeed, Rng } from './Rng';

/** Characterisation of the seeded generator: determinism, range, and the state round-trip. */

function draw(rng: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.nextUint32());
  return out;
}

describe('Rng', () => {
  it('produces the same sequence from the same seed', () => {
    expect(draw(new Rng(1), 32)).toEqual(draw(new Rng(1), 32));
    expect(draw(new Rng(0xdeadbeef), 32)).toEqual(draw(new Rng(0xdeadbeef), 32));
  });

  it('diverges between adjacent seeds, including 0 and 1', () => {
    expect(draw(new Rng(0), 8)).not.toEqual(draw(new Rng(1), 8));
    expect(draw(new Rng(1), 8)).not.toEqual(draw(new Rng(2), 8));
  });

  it('works from seed 0', () => {
    const rng = new Rng(0);
    const first = rng.nextUint32();
    expect(Number.isInteger(first)).toBe(true);
    expect(draw(rng, 4).some((v) => v !== 0)).toBe(true);
  });

  it('reseed restarts the sequence', () => {
    const rng = new Rng(7);
    const first = draw(rng, 5);
    rng.reseed(7);
    expect(draw(rng, 5)).toEqual(first);
  });

  it('nextUint32 stays within the unsigned 32-bit range', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextUint32();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('float is in [0, 1)', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 1000; i++) {
      const v = rng.float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('range and spread map float onto their intervals', () => {
    const a = new Rng(9);
    const b = new Rng(9);
    for (let i = 0; i < 100; i++) {
      const f = a.float();
      expect(b.range(-3, 5)).toBe(-3 + 8 * f);
    }
    const c = new Rng(11);
    for (let i = 0; i < 1000; i++) {
      const v = c.spread();
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });

  it('int is an integer in [min, max) and returns min on an empty span', () => {
    const rng = new Rng(13);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(2, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(6);
    }
    expect(rng.int(4, 4)).toBe(4);
    expect(rng.int(4, 1)).toBe(4);
  });

  it('chance is always false at 0 and always true at 1', () => {
    const rng = new Rng(17);
    for (let i = 0; i < 100; i++) expect(rng.chance(0)).toBe(false);
    for (let i = 0; i < 100; i++) expect(rng.chance(1)).toBe(true);
  });

  it('saveState / loadState replays the sequence exactly', () => {
    const rng = new Rng(21);
    draw(rng, 10);
    const state = new Int32Array(4);
    rng.saveState(state);
    const expected = draw(rng, 20);
    const other = new Rng(999);
    other.loadState(state);
    expect(draw(other, 20)).toEqual(expected);
  });
});

describe('eventSeed', () => {
  it('is a pure function of its four inputs', () => {
    expect(eventSeed(1, 400, 7, 0)).toBe(eventSeed(1, 400, 7, 0));
  });

  it('changes when any one input changes', () => {
    const base = eventSeed(1, 400, 7, 0);
    expect(eventSeed(2, 400, 7, 0)).not.toBe(base);
    expect(eventSeed(1, 401, 7, 0)).not.toBe(base);
    expect(eventSeed(1, 400, 8, 0)).not.toBe(base);
    expect(eventSeed(1, 400, 7, 1)).not.toBe(base);
  });

  it('is an unsigned 32-bit integer', () => {
    for (let t = 0; t < 200; t++) {
      const v = eventSeed(0x5eed, t, t % 11, t % 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
