/**
 * Bit-deterministic trigonometry for the simulation (M9, S6.6 and S4.14).
 *
 * ## Why this exists
 *
 * The M9 cross-runtime check found the simulation diverging between Node and Chrome at tick
 * 149 of a 3600-tick run, on `vz`, by one unit in the last place. Probing the maths surface
 * with 20,000 arguments each found the cause precisely:
 *
 * | `Math.hypot` | `sqrt` | `exp` | `pow` | `atan2` | `log` | **`sin`** | **`cos`** |
 * |---|---|---|---|---|---|---|---|
 * | same | same | same | same | same | same | **differs** | **differs** |
 *
 * Node 24 (V8 13.6) and Chrome 148 (V8 14.x) do not agree bit-for-bit on `Math.sin` and
 * `Math.cos`. They are not required to: ECMA-262 says the trigonometric functions are
 * *implementation-approximated*, and V8 has changed its kernels between versions.
 *
 * This is not a curiosity. S4.11 makes client prediction mandatory and reconciliation
 * replays unacked commands through the same `PlayerController.step` the server ran — and
 * yaw-to-direction is `sin`/`cos` on every single tick. A client on a different Chrome build
 * from the server's Node would drift from the server continuously, in a way that looks
 * exactly like packet loss and is not. Pinning versions is not available: players run
 * whatever browser they have.
 *
 * ## The implementation
 *
 * Cody-Waite argument reduction onto [-π/4, π/4], then the fdlibm minimax kernels. **Every
 * operation is `+`, `-`, `*` or `Math.round` on doubles**, all of which IEEE 754 specifies
 * exactly and every conformant engine must round identically. There is no library call left
 * to disagree about.
 *
 * Accuracy is within one ULP of the platform's own `Math.sin`/`Math.cos` over the range a
 * game uses, which is verified rather than asserted — see `verifyAgainstNative` below and
 * the M9 verification table in PLAN.md. A one-ULP change to a yaw cannot be felt; a
 * divergent one can be, eventually, as rubberbanding.
 *
 * ## Scope
 *
 * `shared/` uses these instead of `Math.sin`/`Math.cos`, and the boundary check enforces it.
 * `client/` may keep using the natives freely: a camera angle, a muzzle flash or a bob curve
 * is not simulation state and nobody replays it.
 */

const PI = Math.PI;
const TWO_OVER_PI = 2 / PI;

/**
 * π/2, split so that `n * PIO2_HI` is exact for the `n` a game produces.
 *
 * `PIO2_HI` has its low 33 bits cleared, so multiplying it by a modest integer loses nothing;
 * `PIO2_LO` carries the rest. Subtracting the two parts separately is what keeps the reduced
 * argument accurate near a multiple of π/2, where cancellation would otherwise destroy it.
 */
const PIO2_HI = 1.5707963267341256; // 0x3FF921FB54400000
const PIO2_LO = 6.077100506506192e-11; // π/2 - PIO2_HI

// fdlibm __kernel_sin coefficients. Minimax for sin(x)/x - 1 on [-π/4, π/4].
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

// fdlibm __kernel_cos coefficients.
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

/** sin on [-π/4, π/4]. */
function kernelSin(x: number): number {
  const z = x * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + x * z * (S1 + z * r);
}

/** cos on [-π/4, π/4]. */
function kernelCos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  // Written as fdlibm writes it: the 0.5*z term is split out so the cancellation near
  // |x| ~ π/4 happens between two exactly representable pieces.
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + z * r);
}

/**
 * Reduce `x` to `r` in [-π/4, π/4] and return the quadrant `n & 3`.
 *
 * The reduced value is written to `reduced` rather than returned as a pair, because S4.7
 * bans allocation in the per-tick path and this is squarely in it.
 */
const reduced = { r: 0 };

function reduce(x: number): number {
  const n = Math.round(x * TWO_OVER_PI);
  reduced.r = x - n * PIO2_HI - n * PIO2_LO;
  return n & 3;
}

/**
 * Deterministic sine. Same bits in every conformant engine.
 *
 * Non-finite input returns `NaN`, matching `Math.sin`, rather than looping in the reduction.
 */
export function simSin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const q = reduce(x);
  const r = reduced.r;
  switch (q) {
    case 0:
      return kernelSin(r);
    case 1:
      return kernelCos(r);
    case 2:
      return -kernelSin(r);
    default:
      return -kernelCos(r);
  }
}

/** Deterministic cosine. Same bits in every conformant engine. */
export function simCos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const q = reduce(x);
  const r = reduced.r;
  switch (q) {
    case 0:
      return kernelCos(r);
    case 1:
      return -kernelSin(r);
    case 2:
      return -kernelCos(r);
    default:
      return kernelSin(r);
  }
}

/** Deterministic tangent. Only a handful of call sites; derived rather than given a kernel. */
export function simTan(x: number): number {
  const c = simCos(x);
  return c === 0 ? NaN : simSin(x) / c;
}

export interface AccuracyReport {
  /** Samples compared. */
  readonly samples: number;
  /** Largest difference from the platform's own function, in units in the last place. */
  readonly maxUlpSin: number;
  readonly maxUlpCos: number;
  /** Largest absolute difference. */
  readonly maxAbsSin: number;
  readonly maxAbsCos: number;
}

/**
 * Compare against the host's `Math.sin`/`Math.cos` over the range a match uses.
 *
 * Not a test framework — a function the harness calls and reports, so the claim "within one
 * ULP" in PLAN.md is a measurement rather than a hope. Run in both runtimes: each compares
 * against *its own* natives, and both should agree with them to the same tolerance while
 * agreeing with each other exactly.
 */
export function verifyAgainstNative(samples = 200000, span = 64): AccuracyReport {
  let maxUlpSin = 0;
  let maxUlpCos = 0;
  let maxAbsSin = 0;
  let maxAbsCos = 0;

  // Deterministic sweep rather than random, so two runtimes compare identical arguments.
  for (let i = 0; i < samples; i++) {
    const x = ((i / (samples - 1)) * 2 - 1) * span;

    const ns = Math.sin(x);
    const ms = simSin(x);
    const as = Math.abs(ns - ms);
    if (as > maxAbsSin) maxAbsSin = as;
    const us = as / Math.max(ulp(ns), Number.MIN_VALUE);
    if (us > maxUlpSin) maxUlpSin = us;

    const nc = Math.cos(x);
    const mc = simCos(x);
    const ac = Math.abs(nc - mc);
    if (ac > maxAbsCos) maxAbsCos = ac;
    const uc = ac / Math.max(ulp(nc), Number.MIN_VALUE);
    if (uc > maxUlpCos) maxUlpCos = uc;
  }

  return {
    samples,
    maxUlpSin: Math.round(maxUlpSin * 1000) / 1000,
    maxUlpCos: Math.round(maxUlpCos * 1000) / 1000,
    maxAbsSin,
    maxAbsCos,
  };
}

/** The gap between `v` and the next representable double. */
function ulp(v: number): number {
  const a = Math.abs(v);
  if (a === 0) return Number.MIN_VALUE;
  const exp = Math.floor(Math.log2(a));
  return Math.pow(2, exp - 52);
}
