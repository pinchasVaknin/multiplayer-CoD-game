import type { SkylineDef } from './maps/types';

/**
 * The distant ridge line, as elevation against azimuth (playtest round 5, F2).
 *
 * ## Why this is in `shared/` and not beside the shader
 *
 * It produces numbers, not pixels: an array of elevations, one per azimuth sample, that the
 * client uploads as a one-dimensional texture and the sky shader reads. `shared/` compiles
 * without the DOM and without `three`, so `npm run readability` can run this and assert the
 * two things about a horizon that are silently wrong rather than loudly wrong — that it joins
 * up where it wraps, and that it does not stand so high it reads as a wall. Same argument as
 * `MapLuminance`'s, and the same reason: a claim about a picture needs a browser, a claim
 * about a curve does not.
 *
 * ## What the curve is
 *
 * `count` features are spaced evenly around the circle, each given a height by a hash of its
 * index and the map's seed. Between them the curve is either interpolated — a ridge — or held
 * flat to the feature's own value and stepped at its edge — a skyline of blocks. `hardness`
 * blends the two, so one generator covers Dunes' dunes and Depot's rooftops without a second
 * code path or a per-map `kind` to switch on.
 *
 * The floor is deliberately not zero. A profile that touched the horizon between every pair
 * of features would show the gap as a notch of open sky at eye level, which reads as a hole
 * rather than as distance; `MIN_FRACTION` keeps the lowest saddle a third of the way up.
 */

/** Samples around the full circle. 512 is 0.7 degrees of azimuth — finer than any edge here. */
export const SKY_PROFILE_SAMPLES = 512;

/** The lowest a saddle between two features may fall, as a fraction of `heightDeg`. */
const MIN_FRACTION = 0.34;

/** How much of a block's cell is spent turning over into the next one. */
const EDGE_RAMP = 0.06;

/**
 * A hash, not a random number generator.
 *
 * §4.14 bans `Math.random` in gameplay and this is not gameplay, but the reason applies here
 * anyway and more strongly: a horizon that differed between two loads of the same map would
 * be a map that is not one place. Integer mixing on the index and the seed gives the same
 * ridge for ever, and gives it without threading a generator's state through the loop.
 */
/**
 * One feature's height, 0..1, exposed for the probe's red control and for nothing else.
 *
 * `npm run readability` asserts that the profile joins up where it wraps. An assertion nobody
 * has watched fail is not an assertion, so the probe builds the same curve with the modulo
 * taken out — the line-shaped generator, which is the bug — and shows the seam it leaves. That
 * control is only a control if it uses *this* hash rather than one that resembles it.
 */
export function skylineFeatureHeight(index: number, seed: number): number {
  return hash01(index, seed);
}

function hash01(index: number, seed: number): number {
  let h = (index * 0x27d4eb2d) ^ (seed * 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 0x100000000;
}

/** Smoothstep between two control points, so a ridge has no visible corners. */
function smoothMix(a: number, b: number, t: number): number {
  const s = t * t * (3 - 2 * t);
  return a + (b - a) * s;
}

/**
 * The elevation at one sample index, in **radians**.
 *
 * Written per index rather than only as a loop for one reason, and it is the assertion:
 * **this is a function of `index` modulo `samples`, and nothing else.** A horizon is a circle,
 * so `skylineAt(def, i)` and `skylineAt(def, i + samples)` must be the same number — and a
 * generator that indexes its control points without the modulo, which is the mistake, breaks
 * that equality exactly rather than approximately. `npm run readability` compares the two,
 * with no threshold in the comparison and none needed.
 */
export function skylineAt(def: SkylineDef, index: number, samples = SKY_PROFILE_SAMPLES): number {
  const peak = (def.heightDeg * Math.PI) / 180;
  const count = Math.max(1, Math.round(def.count));
  const hardness = Math.min(1, Math.max(0, def.hardness));

  // Position around the circle in units of features, so wrapping is a modulo on an integer
  // rather than an angle comparison that can miss by a float.
  const t = (index / samples) * count;
  const cell = Math.floor(t);
  const frac = t - cell;

  const here = hash01(wrap(cell, count), def.seed);
  const next = hash01(wrap(cell + 1, count), def.seed);

  // Two readings of the same two control points: one interpolated, one held. `hardness`
  // chooses between them, and every value in between is a legal horizon.
  const ridge = smoothMix(here, next, frac);
  // A block holds its own height across the cell and turns over at the edge. The turn is a
  // ramp rather than a step because the profile is sampled by a linear filter across a whole
  // screen: a true discontinuity is one texel wide and reads as a staircase.
  const blocks = frac < 1 - EDGE_RAMP ? here : smoothMix(here, next, (frac - (1 - EDGE_RAMP)) / EDGE_RAMP);

  const shape = ridge + (blocks - ridge) * hardness;
  return peak * (MIN_FRACTION + (1 - MIN_FRACTION) * shape);
}

/** Modulo that is still a modulo for a negative index. `%` in JS is a remainder. */
function wrap(index: number, count: number): number {
  return ((index % count) + count) % count;
}

/**
 * The profile, in radians of elevation, one sample per azimuth step from -pi to +pi.
 *
 * Returned as a plain array so this file needs no typed-array assumptions on either side of
 * the partition; the client copies it into a `DataTexture` and the probe reads it directly.
 */
export function skylineProfile(def: SkylineDef, samples = SKY_PROFILE_SAMPLES): number[] {
  const out: number[] = new Array<number>(samples);
  for (let i = 0; i < samples; i++) out[i] = skylineAt(def, i, samples);
  return out;
}

/**
 * What a horizon reads at, and whether it is a circle.
 *
 * **`worstPeriodicityDeg` is the rule and everything else is a reading.** The profile wraps —
 * sample 511 is adjacent to sample 0 — and a generator that treats the array as a line rather
 * than as a circle leaves a vertical step at exactly one azimuth: a crack in the horizon, in
 * one direction, which a playtester will find and nobody will reproduce from the description.
 * Comparing the two ends *by size* cannot catch it on a hard-edged skyline, where a step the
 * size of a building is the point; comparing `skylineAt(i)` with `skylineAt(i + samples)` can,
 * because a circular generator answers those identically and a line-shaped one never does.
 *
 * The heights are readings. A ridge is distance and a ridge tall enough to close the view is a
 * box, but where that line falls is a judgement about a picture and this file does not make
 * those — `heightDeg` is authored per map and the browser is where it is looked at.
 */
export interface SkylineReading {
  /**
   * Largest disagreement between one turn of the circle and the next, in degrees. Zero on a
   * generator that is a function of azimuth; a whole feature's height on one that is not.
   */
  readonly worstPeriodicityDeg: number;
  /** Largest step between adjacent samples, including the wrap. A reading, not a bound. */
  readonly worstStepDeg: number;
  /** The wrap step alone, for the same reason: it is worth seeing, it is not a rule. */
  readonly seamStepDeg: number;
  readonly minDeg: number;
  readonly maxDeg: number;
}

export function readSkyline(def: SkylineDef, samples = SKY_PROFILE_SAMPLES): SkylineReading {
  const profile = skylineProfile(def, samples);
  const deg = (r: number): number => (r * 180) / Math.PI;

  let worst = 0;
  let min = Infinity;
  let max = -Infinity;
  let periodicity = 0;
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i] ?? 0;
    const b = profile[(i + 1) % profile.length] ?? 0;
    worst = Math.max(worst, Math.abs(deg(b) - deg(a)));
    min = Math.min(min, deg(a));
    max = Math.max(max, deg(a));
    // One full turn on: the same azimuth, a different index. Identical, or the curve is not a
    // function of the direction it is drawn in.
    periodicity = Math.max(periodicity, Math.abs(deg(skylineAt(def, i + samples, samples)) - deg(a)));
  }

  const first = profile[0] ?? 0;
  const last = profile[profile.length - 1] ?? 0;
  return {
    worstPeriodicityDeg: periodicity,
    worstStepDeg: worst,
    seamStepDeg: Math.abs(deg(first) - deg(last)),
    minDeg: min,
    maxDeg: max,
  };
}
