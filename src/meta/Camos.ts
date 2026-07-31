import * as THREE from 'three';
import { Rng } from '../core/Rng';

/**
 * Weapon camouflages (brief S6.5): six, generated as `CanvasTexture` patterns.
 *
 * Zero external assets (S2), so every one of these is drawn with 2D canvas calls from a
 * seeded `Rng` — which also means they are reproducible: the same camo is byte-identical
 * across reloads, and a pattern that looked wrong can be tuned by changing one number
 * rather than by re-exporting an image.
 *
 * They are *not* six recolourings of the same noise. Each generator is a different
 * construction, because the whole point of a camo unlock is that the reward is visibly a
 * different thing:
 *
 * | Camo     | Construction                                                  |
 * |----------|---------------------------------------------------------------|
 * | DIGITAL  | Aligned pixel grid, three-tone, blocks biased by a value field |
 * | SPLINTER | Straight-edged angular shards from a random half-plane cut     |
 * | TIGER    | Sinusoidally warped horizontal stripes with broken ends        |
 * | FRACTAL  | Summed octaves of value noise, posterised to four bands        |
 * | GOLD     | Vertical brushed metal with a specular sweep and an edge burn  |
 * | OBSIDIAN | Voronoi facets lit from one direction, over an ink base        |
 *
 * OBSIDIAN is S6.5's "one that requires the others" — its challenge is completing the
 * five camo challenges below it, so it cannot be reached any other way.
 */

export type CamoId = 'digital' | 'splinter' | 'tiger' | 'fractal' | 'gold' | 'obsidian';

export interface CamoDef {
  readonly id: CamoId;
  readonly name: string;
  /** How it is earned, in one line. The challenge itself lives in `Challenges.ts`. */
  readonly requirement: string;
  /** Drawn into the picker as a swatch, and the base tint of the pattern. */
  readonly swatch: string;
}

export const CAMOS: Readonly<Record<CamoId, CamoDef>> = {
  digital: {
    id: 'digital',
    name: 'DIGITAL',
    requirement: '25 kills with the weapon',
    swatch: '#5c6350',
  },
  splinter: {
    id: 'splinter',
    name: 'SPLINTER',
    requirement: '15 headshots with the weapon',
    swatch: '#6d6152',
  },
  tiger: {
    id: 'tiger',
    name: 'TIGER',
    requirement: '10 longshot kills with the weapon',
    swatch: '#7a6234',
  },
  fractal: {
    id: 'fractal',
    name: 'FRACTAL',
    requirement: '5 one-magazine multikills with the weapon',
    swatch: '#4d5560',
  },
  gold: {
    id: 'gold',
    name: 'GOLD',
    requirement: '100 kills with the weapon',
    swatch: '#c9a13c',
  },
  obsidian: {
    id: 'obsidian',
    name: 'OBSIDIAN',
    requirement: 'Earn every other camo',
    swatch: '#1b1d24',
  },
};

export const CAMO_IDS = Object.keys(CAMOS) as CamoId[];

/** The five OBSIDIAN is built on. Read by the challenge that awards it. */
export const CAMO_PREREQUISITES: readonly CamoId[] = ['digital', 'splinter', 'tiger', 'fractal', 'gold'];

export function camoDef(id: CamoId): CamoDef {
  return CAMOS[id];
}

export function isCamoId(value: string): value is CamoId {
  return Object.prototype.hasOwnProperty.call(CAMOS, value);
}

// -- generation ---------------------------------------------------------------

const TEX = 256;

/**
 * Textures are built once per process and shared by every model wearing that camo.
 *
 * The same reasoning `WeaponMesh.sharedSurfaces` uses: a weapon is rebuilt on every match
 * and on every loadout change, and regenerating a 256px canvas each time would be a
 * GPU upload on the frame the player presses a button.
 */
const cache = new Map<CamoId, THREE.Texture>();

export function camoTexture(id: CamoId, anisotropy: number): THREE.Texture {
  const existing = cache.get(id);
  if (existing !== undefined) return existing;
  const texture = finish(draw(id), anisotropy);
  cache.set(id, texture);
  return texture;
}

/** Release every generated camo. Only a page teardown has business calling it. */
export function disposeCamoTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}

/** A small swatch for the loadout editor, as a data URL. Cached alongside the textures. */
const swatchCache = new Map<CamoId, string>();

export function camoSwatchUrl(id: CamoId): string {
  const existing = swatchCache.get(id);
  if (existing !== undefined) return existing;
  const url = draw(id).canvas.toDataURL('image/png');
  swatchCache.set(id, url);
  return url;
}

function makeCanvas(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = TEX;
  canvas.height = TEX;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable; cannot build camo textures.');
  return ctx;
}

function finish(ctx: CanvasRenderingContext2D, anisotropy: number): THREE.Texture {
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  // Twice around a receiver: large enough for the pattern to read at viewmodel distance,
  // small enough that a barrel is not one flat colour.
  texture.repeat.set(2, 2);
  texture.needsUpdate = true;
  return texture;
}

function draw(id: CamoId): CanvasRenderingContext2D {
  switch (id) {
    case 'digital':
      return drawDigital();
    case 'splinter':
      return drawSplinter();
    case 'tiger':
      return drawTiger();
    case 'fractal':
      return drawFractal();
    case 'gold':
      return drawGold();
    case 'obsidian':
      return drawObsidian();
  }
}

/** Aligned blocks, three tones, chosen by a coarse value field so patches cluster. */
function drawDigital(): CanvasRenderingContext2D {
  const ctx = makeCanvas();
  const rng = new Rng(0x0d1_9174);
  const tones = ['#3f4536', '#5c6350', '#767c63', '#282c22'];
  const cell = 8;
  const coarse = 4;
  ctx.fillStyle = tones[1] ?? '#5c6350';
  ctx.fillRect(0, 0, TEX, TEX);
  const field = new Float32Array((TEX / cell / coarse + 2) ** 2);
  for (let i = 0; i < field.length; i++) field[i] = rng.float();
  const stride = TEX / cell / coarse + 2;

  for (let y = 0; y < TEX; y += cell) {
    for (let x = 0; x < TEX; x += cell) {
      const fx = Math.floor(x / cell / coarse);
      const fy = Math.floor(y / cell / coarse);
      const base = field[fy * stride + fx] ?? 0.5;
      const jitter = base + rng.range(-0.3, 0.3);
      const index = jitter < 0.2 ? 3 : jitter < 0.45 ? 0 : jitter < 0.78 ? 1 : 2;
      ctx.fillStyle = tones[index] ?? '#5c6350';
      ctx.fillRect(x, y, cell, cell);
    }
  }
  return ctx;
}

/** Angular shards: repeated half-plane cuts, each filling one side with the next tone. */
function drawSplinter(): CanvasRenderingContext2D {
  const ctx = makeCanvas();
  const rng = new Rng(0x5217_e300);
  const tones = ['#4a4437', '#6d6152', '#332f27', '#8a7c66'];
  ctx.fillStyle = tones[1] ?? '#6d6152';
  ctx.fillRect(0, 0, TEX, TEX);

  for (let i = 0; i < 34; i++) {
    const cx = rng.float() * TEX;
    const cy = rng.float() * TEX;
    // Eight directions only. Splinter is defined by its straight, repeated angles; a free
    // rotation reads as broken glass rather than as a pattern.
    const angle = (Math.floor(rng.float() * 8) * Math.PI) / 4 + rng.range(-0.12, 0.12);
    const len = TEX * 1.6;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    ctx.fillStyle = tones[Math.floor(rng.float() * tones.length)] ?? '#4a4437';
    ctx.beginPath();
    ctx.moveTo(cx - nx * len, cy - ny * len);
    ctx.lineTo(cx + nx * len, cy + ny * len);
    ctx.lineTo(cx + nx * len - ny * len, cy + ny * len + nx * len);
    ctx.lineTo(cx - nx * len - ny * len, cy - ny * len + nx * len);
    ctx.closePath();
    ctx.globalAlpha = rng.range(0.35, 0.85);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return ctx;
}

/** Warped stripes: a sine-displaced band per row, with the ends eaten away. */
function drawTiger(): CanvasRenderingContext2D {
  const ctx = makeCanvas();
  const rng = new Rng(0x71_6e12);
  ctx.fillStyle = '#7a6234';
  ctx.fillRect(0, 0, TEX, TEX);
  ctx.fillStyle = '#3a2f1c';

  for (let i = 0; i < 16; i++) {
    const y = (i / 16) * TEX + rng.range(-6, 6);
    const thickness = rng.range(5, 15);
    const amp = rng.range(4, 14);
    const phase = rng.float() * Math.PI * 2;
    const freq = rng.range(1.2, 2.8);
    const start = rng.chance(0.45) ? rng.range(0, TEX * 0.4) : 0;
    const end = rng.chance(0.45) ? rng.range(TEX * 0.6, TEX) : TEX;
    ctx.beginPath();
    for (let x = start; x <= end; x += 4) {
      const yy = y + Math.sin(phase + (x / TEX) * freq * Math.PI * 2) * amp;
      if (x === start) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    for (let x = end; x >= start; x -= 4) {
      const taper = 1 - Math.abs((x - (start + end) / 2) / ((end - start) / 2 + 1e-3)) ** 3;
      const yy = y + Math.sin(phase + (x / TEX) * freq * Math.PI * 2) * amp + thickness * taper;
      ctx.lineTo(x, yy);
    }
    ctx.closePath();
    ctx.fill();
  }
  return ctx;
}

/** Four octaves of value noise, posterised into four bands. */
function drawFractal(): CanvasRenderingContext2D {
  const ctx = makeCanvas();
  const rng = new Rng(0xf7_ac1a);
  const image = ctx.createImageData(TEX, TEX);
  const octaves = [4, 8, 16, 32];
  const fields = octaves.map((size) => {
    const f = new Float32Array((size + 1) * (size + 1));
    for (let i = 0; i < f.length; i++) f[i] = rng.float();
    return f;
  });
  const bands: readonly (readonly [number, number, number])[] = [
    [30, 34, 40],
    [58, 66, 78],
    [92, 102, 116],
    [140, 150, 166],
  ];

  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      let value = 0;
      let amplitude = 1;
      let total = 0;
      for (let o = 0; o < octaves.length; o++) {
        const size = octaves[o] ?? 4;
        const field = fields[o];
        if (field === undefined) continue;
        value += sampleField(field, size, (x / TEX) * size, (y / TEX) * size) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
      }
      value /= total;
      const band = bands[Math.min(bands.length - 1, Math.floor(value * bands.length))] ?? bands[0];
      const i = (y * TEX + x) * 4;
      image.data[i] = band?.[0] ?? 0;
      image.data[i + 1] = band?.[1] ?? 0;
      image.data[i + 2] = band?.[2] ?? 0;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return ctx;
}

/** Bilinear sample of a `(size+1)^2` value grid, wrapping at the edge. */
function sampleField(field: Float32Array, size: number, fx: number, fy: number): number {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const stride = size + 1;
  const at = (x: number, y: number): number => field[(y % stride) * stride + (x % stride)] ?? 0;
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Brushed vertical metal with a bright diagonal sweep and darkened edges. */
function drawGold(): CanvasRenderingContext2D {
  const ctx = makeCanvas();
  const rng = new Rng(0x9_01dd);
  const base = ctx.createLinearGradient(0, 0, 0, TEX);
  base.addColorStop(0, '#8a6a1c');
  base.addColorStop(0.42, '#e0be5e');
  base.addColorStop(0.55, '#fff0bd');
  base.addColorStop(0.72, '#c9a13c');
  base.addColorStop(1, '#6d5215');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX, TEX);

  // Brushing: fine vertical streaks, which is what stops flat gold reading as plastic.
  for (let i = 0; i < 2200; i++) {
    const x = rng.float() * TEX;
    const y = rng.float() * TEX;
    const a = rng.range(0.02, 0.1);
    ctx.fillStyle = rng.chance(0.5) ? `rgba(255,247,214,${a})` : `rgba(60,42,6,${a})`;
    ctx.fillRect(x, y, 1, rng.range(6, 40));
  }

  const sweep = ctx.createLinearGradient(0, TEX, TEX, 0);
  sweep.addColorStop(0, 'rgba(255,255,255,0)');
  sweep.addColorStop(0.48, 'rgba(255,255,255,0.22)');
  sweep.addColorStop(0.52, 'rgba(255,255,255,0)');
  ctx.fillStyle = sweep;
  ctx.fillRect(0, 0, TEX, TEX);
  return ctx;
}

/** Voronoi facets over ink, each lit by its own normal so the surface reads as faceted. */
function drawObsidian(): CanvasRenderingContext2D {
  const ctx = makeCanvas();
  const rng = new Rng(0x0b_51d1);
  ctx.fillStyle = '#12141a';
  ctx.fillRect(0, 0, TEX, TEX);

  const count = 44;
  const sites: Array<{ x: number; y: number; shade: number }> = [];
  for (let i = 0; i < count; i++) {
    sites.push({ x: rng.float() * TEX, y: rng.float() * TEX, shade: rng.float() });
  }

  const image = ctx.getImageData(0, 0, TEX, TEX);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      let best = Infinity;
      let second = Infinity;
      let shade = 0;
      for (const s of sites) {
        // Toroidal distance, so the pattern tiles without a visible seam.
        const dx = Math.min(Math.abs(s.x - x), TEX - Math.abs(s.x - x));
        const dy = Math.min(Math.abs(s.y - y), TEX - Math.abs(s.y - y));
        const d = dx * dx + dy * dy;
        if (d < best) {
          second = best;
          best = d;
          shade = s.shade;
        } else if (d < second) {
          second = d;
        }
      }
      // Distance to the facet boundary, as a bright edge.
      const edge = Math.sqrt(second) - Math.sqrt(best);
      const lit = 14 + shade * 34 + Math.max(0, 26 - edge * 5);
      const i = (y * TEX + x) * 4;
      image.data[i] = Math.min(255, lit * 0.82);
      image.data[i + 1] = Math.min(255, lit * 0.88);
      image.data[i + 2] = Math.min(255, lit * 1.15 + 8);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return ctx;
}
