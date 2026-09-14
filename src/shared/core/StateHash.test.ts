import { describe, expect, it } from 'vitest';
import { StateHasher } from './StateHash';

/**
 * Characterisation of the FNV-1a state hash: the empty hash is the offset basis, every fold
 * changes it, the same folds give the same hash, and floats are hashed by their bits rather
 * than by their value.
 */

describe('StateHasher', () => {
  it('starts at the FNV-1a 32-bit offset basis and resets to it', () => {
    const h = new StateHasher();
    expect(h.hex).toBe('811c9dc5');
    expect(h.value).toBe(0x811c9dc5);
    h.int(1);
    expect(h.hex).not.toBe('811c9dc5');
    h.reset();
    expect(h.hex).toBe('811c9dc5');
  });

  it('is deterministic over the same folds', () => {
    const a = new StateHasher();
    const b = new StateHasher();
    for (const h of [a, b]) {
      h.int(42);
      h.float(1.5);
      h.bool(true);
      h.str('sprint');
    }
    expect(a.hex).toBe(b.hex);
    expect(a.value).toBe(b.value);
  });

  it('hashes a single byte as FNV-1a does', () => {
    // FNV-1a of the one byte 0x61 ('a') is 0xe40c292c; `str` folds the low byte of each code.
    const h = new StateHasher();
    h.str('a');
    expect(h.hex).toBe('e40c292c');
  });

  it('distinguishes +0 from -0, because it hashes the bits', () => {
    const pos = new StateHasher();
    const neg = new StateHasher();
    pos.float(0);
    neg.float(-0);
    expect(pos.hex).not.toBe(neg.hex);
  });

  it('is order-sensitive', () => {
    const ab = new StateHasher();
    const ba = new StateHasher();
    ab.int(1);
    ab.int(2);
    ba.int(2);
    ba.int(1);
    expect(ab.hex).not.toBe(ba.hex);
  });

  it('bool folds as the integers 1 and 0', () => {
    const b = new StateHasher();
    const i = new StateHasher();
    b.bool(true);
    i.int(1);
    expect(b.hex).toBe(i.hex);
    b.bool(false);
    i.int(0);
    expect(b.hex).toBe(i.hex);
  });

  it('hex is always eight lowercase digits', () => {
    const h = new StateHasher();
    for (let i = 0; i < 64; i++) {
      h.int(i * 7919);
      expect(h.hex).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
