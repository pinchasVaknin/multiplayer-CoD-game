import * as THREE from 'three';
import { Rng } from '../core/Rng';
import { MATERIAL_KEYS, type MaterialKey } from '../world/maps/types';

/**
 * All surface detail is generated in code (brief S2): no texture packs, no CDN.
 *
 * Each material is a tiling CanvasTexture built from seeded value noise plus a small
 * amount of authored structure (panel lines, floor grid, hazard stripes). Seeds are
 * fixed so a build always looks identical — decoration must not depend on Math.random.
 */

export interface MaterialProfile {
  /** Metres of world space per texture repeat. */
  readonly worldScale: number;
  readonly texture: THREE.Texture;
}

const TEX_SIZE = 256;

export class ProceduralTextures {
  private readonly cache = new Map<MaterialKey, MaterialProfile>();
  private readonly maxAnisotropy: number;

  constructor(renderer: THREE.WebGLRenderer) {
    this.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    for (const key of MATERIAL_KEYS) this.cache.set(key, this.build(key));
  }

  /** Shared with anything else that builds a CanvasTexture: the weapon, decals, Fx. */
  get anisotropy(): number {
    return this.maxAnisotropy;
  }

  get(key: MaterialKey): MaterialProfile {
    const found = this.cache.get(key);
    if (found === undefined) throw new Error(`No procedural material for "${key}"`);
    return found;
  }

  dispose(): void {
    for (const profile of this.cache.values()) profile.texture.dispose();
    this.cache.clear();
  }

  private build(key: MaterialKey): MaterialProfile {
    const canvas = document.createElement('canvas');
    canvas.width = TEX_SIZE;
    canvas.height = TEX_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('2D canvas context unavailable; cannot build textures.');

    // A distinct but fixed seed per material.
    const rng = new Rng(0x0be7a704 ^ hashString(key));
    let worldScale = 2;

    switch (key) {
      case 'concrete':
        paintConcrete(ctx, rng, 0x6a6f78, 0.13);
        worldScale = 2;
        break;
      case 'concreteDark':
        paintConcrete(ctx, rng, 0x3d424b, 0.16);
        worldScale = 2;
        break;
      case 'floor':
        paintFloor(ctx, rng);
        worldScale = 2;
        break;
      case 'metal':
        paintMetal(ctx, rng);
        worldScale = 1;
        break;
      case 'hazard':
        paintHazard(ctx, rng);
        worldScale = 1;
        break;
      case 'accent':
        paintAccent(ctx, rng);
        worldScale = 1;
        break;
      case 'rubber':
        paintRubber(ctx, rng);
        worldScale = 1;
        break;
      case 'brick':
        paintBrick(ctx, rng);
        // 2 m per repeat gives four courses of brick a metre, which reads at running speed.
        worldScale = 2;
        break;
      case 'rust':
        paintRust(ctx, rng);
        worldScale = 2.4;
        break;
      case 'grate':
        paintGrate(ctx, rng);
        worldScale = 1;
        break;
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.maxAnisotropy;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    return { worldScale, texture };
  }
}

// -- painters ---------------------------------------------------------------

function paintConcrete(ctx: CanvasRenderingContext2D, rng: Rng, base: number, grain: number): void {
  fill(ctx, base);
  // Large soft blotches, then fine grain, then a few pits. Cheap but reads as concrete.
  blotches(ctx, rng, 26, 22, 70, 0.06);
  grainNoise(ctx, rng, grain);
  speckle(ctx, rng, 900, 0.35, 1.6);
}

function paintFloor(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x555a63);
  blotches(ctx, rng, 18, 30, 90, 0.05);
  grainNoise(ctx, rng, 0.1);

  // 1 m grid inside a 2 m tile: one interior line plus the tile edges.
  ctx.strokeStyle = 'rgba(12,14,17,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 2; i++) {
    const p = (i / 2) * TEX_SIZE;
    line(ctx, p, 0, p, TEX_SIZE);
    line(ctx, 0, p, TEX_SIZE, p);
  }
  // A lighter inner bevel so the grid does not read as a flat decal.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const p = (i / 2) * TEX_SIZE + 2;
    line(ctx, p, 0, p, TEX_SIZE);
    line(ctx, 0, p, TEX_SIZE, p);
  }
  speckle(ctx, rng, 500, 0.25, 1.4);
}

function paintMetal(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x4c515a);
  // Brushed streaks.
  for (let i = 0; i < 700; i++) {
    const y = rng.float() * TEX_SIZE;
    const w = rng.range(20, 140);
    const x = rng.float() * TEX_SIZE;
    const a = rng.range(0.02, 0.08);
    ctx.fillStyle = rng.chance(0.5) ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, w, 1);
  }
  // Panel seams.
  ctx.strokeStyle = 'rgba(10,12,15,0.7)';
  ctx.lineWidth = 3;
  strokeRect(ctx, 4, 4, TEX_SIZE - 8, TEX_SIZE - 8);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  strokeRect(ctx, 6, 6, TEX_SIZE - 12, TEX_SIZE - 12);
  // Bolts in the corners.
  for (const [bx, by] of [
    [16, 16],
    [TEX_SIZE - 16, 16],
    [16, TEX_SIZE - 16],
    [TEX_SIZE - 16, TEX_SIZE - 16],
  ] as const) {
    ctx.fillStyle = 'rgba(20,22,26,0.85)';
    disc(ctx, bx, by, 4);
    ctx.fillStyle = 'rgba(180,186,196,0.35)';
    disc(ctx, bx - 0.8, by - 0.8, 2.4);
  }
  grainNoise(ctx, rng, 0.06);
}

function paintHazard(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x14171c);
  ctx.save();
  ctx.fillStyle = '#ffb340';
  // 45-degree stripes, drawn wide enough to survive the rotation.
  ctx.translate(TEX_SIZE / 2, TEX_SIZE / 2);
  ctx.rotate(Math.PI / 4);
  ctx.translate(-TEX_SIZE, -TEX_SIZE);
  const band = TEX_SIZE / 4;
  for (let i = 0; i < 8; i++) {
    ctx.fillRect(i * band * 2, 0, band, TEX_SIZE * 2);
  }
  ctx.restore();
  // Wear: knock the stripes back so they are not screaming.
  ctx.fillStyle = 'rgba(20,23,28,0.28)';
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  grainNoise(ctx, rng, 0.1);
  speckle(ctx, rng, 700, 0.4, 2);
}

function paintAccent(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x14171c);
  grainNoise(ctx, rng, 0.08);
  ctx.fillStyle = '#ffb340';
  ctx.fillRect(0, TEX_SIZE * 0.46, TEX_SIZE, TEX_SIZE * 0.08);
  ctx.fillStyle = 'rgba(255,179,64,0.18)';
  ctx.fillRect(0, TEX_SIZE * 0.4, TEX_SIZE, TEX_SIZE * 0.2);
}

function paintRubber(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x24272d);
  grainNoise(ctx, rng, 0.14);
  // Studded mat.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  const pitch = TEX_SIZE / 16;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      disc(ctx, (x + 0.5) * pitch, (y + 0.5) * pitch, pitch * 0.24);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      disc(ctx, (x + 0.5) * pitch - 0.7, (y + 0.5) * pitch - 0.7, pitch * 0.16);
    }
  }
}

/**
 * Running bond brickwork, eight courses to the tile.
 *
 * Every brick is tinted individually from the seeded stream, which is what stops a
 * repeating texture from reading as a repeating texture: the eye finds the wrong-coloured
 * brick before it finds the tile boundary.
 */
function paintBrick(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x4a3a34);
  const courses = 8;
  const courseH = TEX_SIZE / courses;
  const brickW = TEX_SIZE / 4;
  const mortar = 2;

  for (let row = 0; row < courses; row++) {
    const y = row * courseH;
    // Running bond: alternate courses shift by half a brick.
    const offset = row % 2 === 0 ? 0 : brickW * 0.5;
    for (let col = -1; col < 5; col++) {
      const x = col * brickW + offset;
      const shade = rng.range(0.78, 1.18);
      const warm = rng.chance(0.22);
      const r = Math.round((warm ? 150 : 118) * shade);
      const g = Math.round((warm ? 92 : 82) * shade);
      const b = Math.round((warm ? 70 : 72) * shade);
      ctx.fillStyle = `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`;
      ctx.fillRect(x + mortar, y + mortar, brickW - mortar * 2, courseH - mortar * 2);
    }
  }
  // Soot and damp, heavier low down: an industrial wall is dirtiest at its base.
  const grad = ctx.createLinearGradient(0, 0, 0, TEX_SIZE);
  grad.addColorStop(0, 'rgba(12,14,17,0.04)');
  grad.addColorStop(1, 'rgba(12,14,17,0.30)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  blotches(ctx, rng, 14, 26, 74, 0.07);
  grainNoise(ctx, rng, 0.09);
  speckle(ctx, rng, 500, 0.28, 1.5);
}

/** Corroded container plate: ribs, bloom rust, and paint that lost the argument. */
function paintRust(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x6d4a35);
  blotches(ctx, rng, 22, 20, 64, 0.12);

  // Vertical corrugation. The ribs are what make a container a container.
  const pitch = TEX_SIZE / 8;
  for (let i = 0; i < 8; i++) {
    const x = i * pitch;
    ctx.fillStyle = 'rgba(255,255,255,0.055)';
    ctx.fillRect(x, 0, pitch * 0.34, TEX_SIZE);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(x + pitch * 0.62, 0, pitch * 0.30, TEX_SIZE);
  }

  // Rust bloom: warm patches eating through, with darker pitting inside them.
  for (let i = 0; i < 34; i++) {
    const x = rng.float() * TEX_SIZE;
    const y = rng.float() * TEX_SIZE;
    const r = rng.range(6, 26);
    ctx.fillStyle = `rgba(${Math.round(rng.range(120, 176))},${Math.round(rng.range(62, 96))},34,${rng.range(0.18, 0.42).toFixed(3)})`;
    disc(ctx, x, y, r);
    ctx.fillStyle = 'rgba(46,26,16,0.30)';
    disc(ctx, x + rng.spread() * r * 0.4, y + rng.spread() * r * 0.4, r * 0.35);
  }
  grainNoise(ctx, rng, 0.13);
  speckle(ctx, rng, 900, 0.4, 2.2);
}

/**
 * Catwalk grating: a steel lattice over near-black.
 *
 * Painted rather than modelled with holes, because the collision scheme is capsule versus
 * oriented box (S4.3) and a deck whose silhouette disagreed with what you can stand on
 * would be worse than an opaque one. What the holes buy is the *read*: you can tell you are
 * above something.
 */
function paintGrate(ctx: CanvasRenderingContext2D, rng: Rng): void {
  fill(ctx, 0x101317);
  const bars = 8;
  const pitch = TEX_SIZE / bars;
  // Load-bearing bars: thicker, brighter on their top edge.
  for (let i = 0; i < bars; i++) {
    const x = i * pitch;
    ctx.fillStyle = 'rgba(122,130,142,0.92)';
    ctx.fillRect(x, 0, pitch * 0.30, TEX_SIZE);
    ctx.fillStyle = 'rgba(198,206,218,0.35)';
    ctx.fillRect(x, 0, pitch * 0.10, TEX_SIZE);
  }
  // Cross ties: thinner, and set back so the lattice reads as having depth.
  for (let i = 0; i < bars; i++) {
    const y = i * pitch;
    ctx.fillStyle = 'rgba(88,95,106,0.80)';
    ctx.fillRect(0, y, TEX_SIZE, pitch * 0.16);
  }
  // Frame edge, so a deck panel has a boundary rather than fading into the next one.
  ctx.strokeStyle = 'rgba(140,148,160,0.55)';
  ctx.lineWidth = 3;
  strokeRect(ctx, 2, 2, TEX_SIZE - 4, TEX_SIZE - 4);
  grainNoise(ctx, rng, 0.1);
  speckle(ctx, rng, 400, 0.35, 1.8);
}

// -- primitives -------------------------------------------------------------

function fill(ctx: CanvasRenderingContext2D, hex: number): void {
  ctx.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function strokeRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.stroke();
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Per-pixel value noise. Drawn wrapped so the tile is seamless: the lattice indexes
 * modulo the tile size, so opposite edges sample the same corners.
 */
function grainNoise(ctx: CanvasRenderingContext2D, rng: Rng, amount: number): void {
  const img = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  const data = img.data;
  const lattice = 32;
  const cells = TEX_SIZE / lattice;
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rng.float();
  // Wrap the far edge onto the near edge.
  for (let i = 0; i <= cells; i++) {
    grid[i * (cells + 1) + cells] = grid[i * (cells + 1)] ?? 0;
    grid[cells * (cells + 1) + i] = grid[i] ?? 0;
  }

  for (let y = 0; y < TEX_SIZE; y++) {
    const gy = y / lattice;
    const y0 = Math.floor(gy);
    const fy = smooth(gy - y0);
    for (let x = 0; x < TEX_SIZE; x++) {
      const gx = x / lattice;
      const x0 = Math.floor(gx);
      const fx = smooth(gx - x0);
      const a = grid[y0 * (cells + 1) + x0] ?? 0;
      const b = grid[y0 * (cells + 1) + x0 + 1] ?? 0;
      const c = grid[(y0 + 1) * (cells + 1) + x0] ?? 0;
      const d = grid[(y0 + 1) * (cells + 1) + x0 + 1] ?? 0;
      const n = a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
      // High-frequency dither on top of the smooth field.
      const fine = rng.float() * 0.35;
      const delta = ((n * 0.65 + fine) - 0.5) * 2 * amount * 255;
      const p = (y * TEX_SIZE + x) * 4;
      data[p] = clamp255((data[p] ?? 0) + delta);
      data[p + 1] = clamp255((data[p + 1] ?? 0) + delta);
      data[p + 2] = clamp255((data[p + 2] ?? 0) + delta);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function blotches(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  count: number,
  rMin: number,
  rMax: number,
  alpha: number,
): void {
  for (let i = 0; i < count; i++) {
    const x = rng.float() * TEX_SIZE;
    const y = rng.float() * TEX_SIZE;
    const r = rng.range(rMin, rMax);
    const dark = rng.chance(0.6);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tint = dark ? '0,0,0' : '255,255,255';
    grad.addColorStop(0, `rgba(${tint},${alpha})`);
    grad.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    // Wrap: redraw across each edge so the tile stays seamless.
    for (const [ox, oy] of [
      [-TEX_SIZE, 0],
      [TEX_SIZE, 0],
      [0, -TEX_SIZE],
      [0, TEX_SIZE],
    ] as const) {
      const g2 = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g2.addColorStop(0, `rgba(${tint},${alpha})`);
      g2.addColorStop(1, `rgba(${tint},0)`);
      ctx.fillStyle = g2;
      ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
}

function speckle(ctx: CanvasRenderingContext2D, rng: Rng, count: number, alpha: number, size: number): void {
  for (let i = 0; i < count; i++) {
    const x = rng.float() * TEX_SIZE;
    const y = rng.float() * TEX_SIZE;
    const a = rng.float() * alpha;
    ctx.fillStyle = rng.chance(0.65) ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`;
    ctx.fillRect(x, y, rng.range(0.6, size), rng.range(0.6, size));
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
