/** Small numeric helpers. No allocation; everything takes and returns primitives. */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach. `rate` is roughly "per second". */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Linear approach with a hard per-second speed limit. Reaches the target exactly. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Shortest signed angular difference, radians, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  return angleDelta(0, a);
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/**
 * Signed shortest angular distance from `from` to `to`, radians.
 *
 * Result is in (-pi, pi], so interpolating with it always turns the short way: a body facing
 * 359 degrees and turning to 1 degree moves two degrees, not three hundred and fifty-eight.
 *
 * Lived in `ai/Bot.ts` until M10, where remote-player interpolation needed the identical
 * function. Two copies of an angle-wrapping helper is exactly the kind of duplication that
 * ends with one of them fixed and the other not.
 */
export function shortestAngle(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}
