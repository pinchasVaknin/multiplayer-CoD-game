import type { LightDef, MapDef } from './maps/types';

/**
 * How bright a map actually is, as a number (playtest round 4, F9).
 *
 * ## Why this exists
 *
 * Depot has been reported as too dark three times, and each fix raised a number in
 * `depot.ts` because that is the file the word "lighting" lives in. Nobody could say by how
 * much the picture had moved, because the only instrument was a pair of eyes in front of a
 * browser and the preview pane in this project never fires `requestAnimationFrame`. So each
 * pass shipped, the report came back unchanged, and the next pass raised the same lever again.
 *
 * This is that missing instrument. It reproduces the four multiplications the renderer
 * performs between an authored hex and a pixel — sRGB decode, irradiance, Lambert, ACES and
 * exposure — so a claim about a map's darkness is arithmetic rather than an impression. It
 * lives in `shared/` for the same reason `HudSurfaces` does: `shared/` compiles without the
 * DOM and without `three`, so this process can run it.
 *
 * ## What it models, and what it deliberately does not
 *
 * Modelled, because these are what the numbers are made of:
 *
 *  - **sRGB -> linear** on every authored colour. This is the whole of F9: `0x24262b` looks
 *    like usable dark asphalt in a swatch and is 0.019 in the space the renderer multiplies in.
 *  - **Hemisphere, directional and point irradiance**, in three.js' own formulations,
 *    including `getDistanceAttenuation`'s `(1 - (d/cutoff)^4)^2` window — which is the lever
 *    round 2 correctly identified as the one that lifts the gaps between mast pools.
 *  - **Lambert** (`albedo / PI`), which is what `MeshLambertMaterial` does.
 *  - **ACES filmic and exposure 1.25**, from `Renderer`, then the sRGB encode. Without these
 *    the output is a linear number nobody can compare to what they saw on a screen.
 *
 * Not modelled, and every one of these makes the answer here an **upper bound**:
 *
 *  - **Shadowing and occlusion.** Every light is treated as visible from every sample. A yard
 *    sample beside a container stack gets its full key term here and does not on screen.
 *  - **The baked vertex AO**, whose floor is 0.32 (`MapMesher.DEFAULT_AO`), so an enclosed
 *    corner is up to three times darker than this reports.
 *  - **Fog**, which mixes toward `fogColor` with distance and is what actually decides the far
 *    half of a lane.
 *  - **Texture detail.** The base colour is the fill a painter starts from; the grain,
 *    aggregate and paint over it move individual texels either way.
 *
 * Stating that plainly matters more than it looks: this says a surface is *at most* this
 * bright, so a number that is already too low here is conclusively too low, which is exactly
 * the claim F9 needs. It cannot be used the other way round to declare a map bright enough.
 */

/** One channel, sRGB 0..255, to linear 0..1. The IEC 61966-2-1 curve, as three.js uses it. */
export function srgbChannelToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** The inverse, for reporting a linear result as something an editor would show. */
export function linearChannelToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

export function linearRgb(hex: number): LinearRgb {
  return {
    r: srgbChannelToLinear((hex >> 16) & 0xff),
    g: srgbChannelToLinear((hex >> 8) & 0xff),
    b: srgbChannelToLinear(hex & 0xff),
  };
}

/** Rec. 709 relative luminance of a linear triple. */
export function luminanceOf(c: LinearRgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Linear luminance of an authored sRGB hex — the one number F9 turns on.
 *
 * `linearLuminance(0x24262b)` is 0.019 and `linearLuminance(0x555a63)` is 0.101. Those two
 * colours look like near neighbours in a palette and are a factor of five apart in the space
 * the renderer works in.
 */
export function linearLuminance(hex: number): number {
  return luminanceOf(linearRgb(hex));
}

export interface Sample {
  /** Where, in world metres. */
  x: number;
  y: number;
  z: number;
  /** Surface normal. Unit length; the floor is (0, 1, 0). */
  nx: number;
  ny: number;
  nz: number;
}

/** Irradiance arriving at one point on one surface, per channel, in linear units. */
export function irradianceAt(lights: readonly LightDef[], s: Sample): LinearRgb {
  const out: LinearRgb = { r: 0, g: 0, b: 0 };
  for (const light of lights) addLight(out, light, s);
  return out;
}

function addLight(out: LinearRgb, light: LightDef, s: Sample): void {
  switch (light.kind) {
    case 'hemisphere': {
      /**
       * three.js `getHemisphereLightIrradiance`: the weight is `0.5 * dot(N, up) + 0.5`, so a
       * floor takes the sky colour outright, a wall takes the average of the two, and a
       * downward-facing surface takes the ground colour. Both colours are pre-multiplied by
       * intensity in `WebGLLights`, which is why the multiply is outside the mix here.
       */
      const weight = 0.5 * s.ny + 0.5;
      const sky = linearRgb(light.skyColor);
      const ground = linearRgb(light.groundColor);
      out.r += (ground.r + (sky.r - ground.r) * weight) * light.intensity;
      out.g += (ground.g + (sky.g - ground.g) * weight) * light.intensity;
      out.b += (ground.b + (sky.b - ground.b) * weight) * light.intensity;
      break;
    }
    case 'directional': {
      // `direction` is the direction the light travels, so the vector *toward* the light is
      // its negation — the same sign convention `MapRender` uses when it places the light.
      const len = Math.hypot(light.direction.x, light.direction.y, light.direction.z) || 1;
      const lx = -light.direction.x / len;
      const ly = -light.direction.y / len;
      const lz = -light.direction.z / len;
      const ndotl = Math.max(0, s.nx * lx + s.ny * ly + s.nz * lz);
      if (ndotl <= 0) break;
      const c = linearRgb(light.color);
      const k = light.intensity * ndotl;
      out.r += c.r * k;
      out.g += c.g * k;
      out.b += c.b * k;
      break;
    }
    case 'point': {
      const dx = light.position.x - s.x;
      const dy = light.position.y - s.y;
      const dz = light.position.z - s.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-4) break;
      const ndotl = Math.max(0, (s.nx * dx + s.ny * dy + s.nz * dz) / d);
      if (ndotl <= 0) break;
      /**
       * three.js `getDistanceAttenuation`, both halves.
       *
       * The inverse-square term is the light; the windowing term is the `distance` cutoff, and
       * it is the one Depot's round-2 pass moved from 30 to 36 m. It is ~1 near the mast and
       * collapses to 0 at the cutoff, so widening it lifts the band between two masts without
       * touching the pool centres — which is exactly what the comment in `depot.ts` claims and
       * what this reproduces.
       */
      let falloff = 1 / Math.max(Math.pow(d, light.decay), 0.01);
      if (light.distance > 0) {
        const t = Math.min(1, Math.max(0, 1 - Math.pow(d / light.distance, 4)));
        falloff *= t * t;
      }
      const c = linearRgb(light.color);
      const k = light.intensity * ndotl * falloff;
      out.r += c.r * k;
      out.g += c.g * k;
      out.b += c.b * k;
      break;
    }
  }
}

/**
 * Outgoing radiance from a Lambert surface: `albedo / PI * irradiance`.
 *
 * `MeshLambertMaterial` is `BRDF_Lambert`, which is that and nothing else, so this is the
 * whole of the material response. Returned per channel because the tone mapper is per channel.
 */
export function lambertRadiance(baseColor: number, irradiance: LinearRgb): LinearRgb {
  const a = linearRgb(baseColor);
  const k = 1 / Math.PI;
  return {
    r: a.r * k * irradiance.r,
    g: a.g * k * irradiance.g,
    b: a.b * k * irradiance.b,
  };
}

/** Exposure the client renders at. `Renderer` sets `toneMappingExposure` to this. */
export const TONE_MAPPING_EXPOSURE = 1.25;

/**
 * three.js' ACES filmic approximation, per channel.
 *
 * Copied in arithmetic rather than imported, because `three` is banned in `shared/` by
 * `check-boundaries` and for good reason. It is Narkowicz's fit, which is what
 * `ACESFilmicToneMapping` compiles to; the RRT/ODT matrices around it are the same on both
 * sides, so a value that comes out of here matches what the renderer would produce for the
 * same input to within the fit's own error.
 */
export function acesFilmic(v: number): number {
  const x = Math.max(0, v * 0.6);
  const out = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.max(0, Math.min(1, out));
}

/**
 * The whole chain: a surface colour and the light on it, to the 0..255 the monitor shows.
 *
 * This is the number to quote at a human, because it is the only one in this file that is in
 * units they have an opinion about. 20/255 is "I cannot see anything"; 79/255 is a lit floor.
 */
export function screenValue(baseColor: number, irradiance: LinearRgb): number {
  const radiance = lambertRadiance(baseColor, irradiance);
  const l = luminanceOf(radiance);
  return linearChannelToSrgb(acesFilmic(l * TONE_MAPPING_EXPOSURE));
}

export interface FloorReading {
  /** Screen value 0..255 at the darkest sample taken. */
  min: number;
  /** At the brightest. */
  max: number;
  /** Mean over all samples. */
  mean: number;
  /** How many samples the reading is made of, so a zero cannot mean "never looked". */
  samples: number;
  /**
   * Irradiance luminance at the darkest and brightest samples, before any albedo.
   *
   * This is the pair that says how *pooled* a map's lighting is, and it is deliberately
   * separate from the screen values above: albedo multiplies both ends equally, so this ratio
   * is a property of the lights alone. It is the number that settles whether raising a ground's
   * base colour would "flatten the pools", which is the claim two failed Depot passes rested on.
   */
  irradianceMin: number;
  irradianceMax: number;
}

/**
 * Walk a map's floor on a grid and report what the ground reads at.
 *
 * The grid is `navBounds` at `y = 0` with an up-facing normal, which is the surface the player
 * spends the whole match looking at and the one that covers the most of the screen. The
 * denominator is carried for the reason every probe in this project carries one: a zero that
 * means *"the grid was empty"* has to fail as loudly as a zero that means *"it is black"*.
 */
export function readFloor(def: MapDef, baseColor: number, step = 2): FloorReading {
  const { min: lo, max: hi } = def.navBounds;
  let min = Infinity;
  let max = -Infinity;
  let irradianceMin = Infinity;
  let irradianceMax = -Infinity;
  let total = 0;
  let samples = 0;
  for (let x = lo.x; x <= hi.x; x += step) {
    for (let z = lo.z; z <= hi.z; z += step) {
      const irradiance = irradianceAt(def.lights, { x, y: 0, z, nx: 0, ny: 1, nz: 0 });
      const e = luminanceOf(irradiance);
      if (e < irradianceMin) irradianceMin = e;
      if (e > irradianceMax) irradianceMax = e;
      const v = screenValue(baseColor, irradiance);
      if (v < min) min = v;
      if (v > max) max = v;
      total += v;
      samples++;
    }
  }
  if (samples === 0) {
    return { min: 0, max: 0, mean: 0, samples: 0, irradianceMin: 0, irradianceMax: 0 };
  }
  return { min, max, mean: total / samples, samples, irradianceMin, irradianceMax };
}
