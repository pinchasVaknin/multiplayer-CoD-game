import { describe, expect, it } from 'vitest';
import {
  dequantAngle,
  dequantMove,
  dequantPitch,
  dequantPos,
  dequantVel,
  POS_SCALE,
  quantAngle,
  quantiseCommandInPlace,
  quantMove,
  quantPitch,
  quantPos,
  quantVel,
  RejectCode,
  rejectText,
  VEL_SCALE,
} from './Protocol';

/**
 * Characterisation of the quantisers: each pair is an identity to within half a step, the
 * quantised form is an integer in its wire width, and `quantiseCommandInPlace` is idempotent —
 * the property prediction relies on. Plus `rejectText` for every code.
 */

const HALF_CM = 0.5 / POS_SCALE;
const PITCH_LIMIT = (89 * Math.PI) / 180;

describe('position and velocity', () => {
  it('dequant(quant(x)) is within half a centimetre and the wire form is an int16-range integer', () => {
    for (const x of [0, 0.004, 0.005, 1.234567, -17.891, 36, -36, 327.67]) {
      const q = quantPos(x);
      expect(Number.isInteger(q)).toBe(true);
      expect(Math.abs(q)).toBeLessThanOrEqual(32767);
      expect(Math.abs(dequantPos(q) - x)).toBeLessThanOrEqual(HALF_CM);
    }
    for (const v of [0, 3.2, -12.5, 60.004]) {
      expect(Math.abs(dequantVel(quantVel(v)) - v)).toBeLessThanOrEqual(0.5 / VEL_SCALE);
    }
  });

  it('is exact on whole centimetres', () => {
    expect(dequantPos(quantPos(12.34))).toBe(12.34);
    expect(quantPos(12.34)).toBe(1234);
  });
});

describe('yaw', () => {
  it('quantAngle is a uint16 that wraps', () => {
    for (const a of [0, 1, -1, Math.PI, -Math.PI, 3 * Math.PI, -7 * Math.PI, 100]) {
      const q = quantAngle(a);
      expect(Number.isInteger(q)).toBe(true);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(0xffff);
    }
    expect(quantAngle(0)).toBe(0);
    expect(quantAngle(2 * Math.PI)).toBe(0);
  });

  it('dequantAngle lands in (-pi, pi] and round-trips to within one step', () => {
    const step = (Math.PI * 2) / 65536;
    for (const a of [0, 0.5, -0.5, 3, -3, Math.PI - 0.001, -Math.PI + 0.001]) {
      const back = dequantAngle(quantAngle(a));
      expect(back).toBeGreaterThan(-Math.PI);
      expect(back).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(back - a)).toBeLessThanOrEqual(step / 2 + 1e-12);
    }
    // A turn and a bit comes back as the bit.
    expect(dequantAngle(quantAngle(2 * Math.PI + 0.25))).toBeCloseTo(0.25, 4);
  });
});

describe('pitch', () => {
  it('clamps to +/-89 degrees and round-trips inside the range', () => {
    expect(dequantPitch(quantPitch(10))).toBeCloseTo(PITCH_LIMIT, 12);
    expect(dequantPitch(quantPitch(-10))).toBeCloseTo(-PITCH_LIMIT, 12);
    expect(quantPitch(PITCH_LIMIT)).toBe(32767);
    for (const p of [0, 0.1, -0.7, 1.2, -1.5]) {
      const q = quantPitch(p);
      expect(Number.isInteger(q)).toBe(true);
      expect(Math.abs(q)).toBeLessThanOrEqual(32767);
      expect(Math.abs(dequantPitch(q) - p)).toBeLessThanOrEqual(PITCH_LIMIT / 32767 / 2 + 1e-12);
    }
  });
});

describe('move axes', () => {
  it('quantMove is a signed byte in [-127, 127], clamped', () => {
    expect(quantMove(0)).toBe(0);
    expect(quantMove(1)).toBe(127);
    expect(quantMove(-1)).toBe(-127);
    expect(quantMove(5)).toBe(127);
    expect(quantMove(-5)).toBe(-127);
    expect(quantMove(0.5)).toBe(64);
    expect(dequantMove(127)).toBe(1);
    expect(dequantMove(-127)).toBe(-1);
  });
});

describe('quantiseCommandInPlace', () => {
  it('is idempotent: what the wire carries survives a second pass unchanged', () => {
    const cmd = { moveX: 0.3333, moveZ: -0.71, yaw: 2.345678, pitch: -0.456789 };
    quantiseCommandInPlace(cmd);
    const once = { ...cmd };
    quantiseCommandInPlace(cmd);
    expect(cmd).toEqual(once);
  });

  it('rounds every field the way its own pair does', () => {
    const cmd = { moveX: 0.3333, moveZ: -0.71, yaw: 2.345678, pitch: -0.456789 };
    quantiseCommandInPlace(cmd);
    expect(cmd.moveX).toBe(dequantMove(quantMove(0.3333)));
    expect(cmd.moveZ).toBe(dequantMove(quantMove(-0.71)));
    expect(cmd.yaw).toBe(dequantAngle(quantAngle(2.345678)));
    expect(cmd.pitch).toBe(dequantPitch(quantPitch(-0.456789)));
  });
});

describe('rejectText', () => {
  it('names every RejectCode and falls back to "refused"', () => {
    expect(rejectText(RejectCode.BadVersion)).toBe('protocol version mismatch');
    expect(rejectText(RejectCode.ServerFull)).toBe('server full');
    expect(rejectText(RejectCode.Malformed)).toBe('malformed handshake');
    expect(rejectText(RejectCode.RateLimited)).toBe('rate limited');
    expect(rejectText(RejectCode.MatchOver)).toBe('match is over');
    expect(rejectText(0)).toBe('refused');
    expect(rejectText(99)).toBe('refused');
  });

  it('every code in the table has its own text', () => {
    const texts = new Set(Object.values(RejectCode).map(rejectText));
    expect(texts.size).toBe(Object.keys(RejectCode).length);
    expect(texts.has('refused')).toBe(false);
  });
});
