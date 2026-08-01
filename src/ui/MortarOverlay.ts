import { PROP_SHAPES } from '../world/maps/props';
import type { Brush, MapDef } from '../world/maps/types';

/**
 * The mortar targeting overlay (M7, brief S6.1).
 *
 * *"The player marks a zone on a map overlay… The overlay is drawn from `MapDef`, reusing the
 * minimap renderer."*
 *
 * Both halves of that are load-bearing. **From `MapDef`** means the thing you aim at is the
 * geometry you collide with — a wall that moves in the map file moves here, and the strike
 * cannot land somewhere the picture said was open. **Reusing the minimap renderer** means the
 * same brush-classification and footprint code, so the overlay and the minimap agree about
 * what a wall is; two rasterisers would eventually disagree and the disagreement would be
 * invisible until somebody called a strike into a building that was not there.
 *
 * The raster is built once when the overlay is first opened rather than at match start,
 * because most matches never call in a mortar and a 300 x 250 px canvas is not free.
 *
 * ## Input
 *
 * Mouse move steers the cursor and click confirms, but the cursor is *also* driven by the
 * player's look direction while pointer lock is held — under lock there is no mouse position
 * to read, and taking the lock away to open a map would drop the player's aim. So the overlay
 * accepts a relative nudge each frame and the click is the confirm.
 */

/** Pixels per metre in the overlay raster. Denser than the minimap: this is a big canvas. */
const PX_PER_M = 9;

const COLOR_WALL = '#2b313b';
const COLOR_WALL_EDGE = '#3d4552';
const COLOR_DECK = '#4a5462';
const COLOR_CURSOR = '#e8604c';
const COLOR_GRID = 'rgba(232, 234, 238, 0.06)';

export interface MortarOverlayDeps {
  readonly host: HTMLElement;
  readonly mapDef: MapDef;
  /** Called with world coordinates when the player confirms a target. */
  readonly onConfirm: (x: number, z: number) => void;
  readonly onCancel: () => void;
}

export class MortarOverlay {
  readonly element: HTMLElement;

  /** World-space cursor. Read by `Match` so a confirm lands where the ring is. */
  markX = 0;
  markZ = 0;

  private readonly deps: MortarOverlayDeps;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private raster: HTMLCanvasElement | null = null;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly spanX: number;
  private readonly spanZ: number;
  private readonly widthPx: number;
  private readonly heightPx: number;
  private open = false;
  private phase = 0;

  constructor(deps: MortarOverlayDeps) {
    this.deps = deps;
    const bounds = deps.mapDef.navBounds;
    this.minX = bounds.min.x;
    this.minZ = bounds.min.z;
    this.spanX = bounds.max.x - bounds.min.x;
    this.spanZ = bounds.max.z - bounds.min.z;
    this.widthPx = Math.round(this.spanX * PX_PER_M);
    this.heightPx = Math.round(this.spanZ * PX_PER_M);

    this.element = document.createElement('div');
    this.element.className = 'hud-mortar';
    this.element.hidden = true;

    const frame = document.createElement('div');
    frame.className = 'hud-mortar__frame';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-mortar__canvas';
    this.canvas.width = this.widthPx;
    this.canvas.height = this.heightPx;
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('Mortar overlay needs a 2D context');
    this.ctx = ctx;
    frame.appendChild(this.canvas);

    const hint = document.createElement('p');
    hint.className = 'hud-mortar__hint';
    hint.textContent = 'MOVE TO AIM · FIRE TO CONFIRM · ESC TO CANCEL';
    frame.appendChild(hint);

    this.element.appendChild(frame);
    deps.host.appendChild(this.element);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Open over the player's own position, which is the least surprising starting cursor. */
  show(playerX: number, playerZ: number): void {
    if (this.raster === null) this.raster = this.buildRaster();
    this.markX = playerX;
    this.markZ = playerZ;
    this.open = true;
    this.element.hidden = false;
  }

  hide(): void {
    this.open = false;
    this.element.hidden = true;
  }

  /**
   * Nudge the cursor. `dx`/`dz` are metres, already scaled by the caller from the look delta.
   *
   * Clamped to the map bounds, because a mark outside the navmesh is a strike on nothing.
   */
  moveBy(dx: number, dz: number): void {
    this.markX = clamp(this.markX + dx, this.minX, this.minX + this.spanX);
    this.markZ = clamp(this.markZ + dz, this.minZ, this.minZ + this.spanZ);
  }

  confirm(): void {
    this.deps.onConfirm(this.markX, this.markZ);
    this.hide();
  }

  cancel(): void {
    this.deps.onCancel();
    this.hide();
  }

  /** One frame. Only runs while open, so a closed overlay costs nothing. */
  update(dt: number, scatterRadius: number): void {
    if (!this.open || this.raster === null) return;
    this.phase = (this.phase + dt * 2.4) % (Math.PI * 2);

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.widthPx, this.heightPx);
    ctx.fillStyle = 'rgba(9, 11, 14, 0.88)';
    ctx.fillRect(0, 0, this.widthPx, this.heightPx);
    ctx.drawImage(this.raster, 0, 0);

    // The strike zone, at the real scatter radius — what you see is what lands.
    const cx = (this.markX - this.minX) * PX_PER_M;
    const cz = (this.markZ - this.minZ) * PX_PER_M;
    const r = scatterRadius * PX_PER_M;

    ctx.strokeStyle = COLOR_CURSOR;
    ctx.fillStyle = 'rgba(232, 96, 76, 0.14)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cz, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // A pulsing inner ring, so the cursor is findable on a busy map.
    ctx.globalAlpha = 0.45 + Math.sin(this.phase) * 0.3;
    ctx.beginPath();
    ctx.arc(cx, cz, r * 0.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Crosshairs out to the frame edge: precise placement needs a reference line.
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, this.heightPx);
    ctx.moveTo(0, cz);
    ctx.lineTo(this.widthPx, cz);
    ctx.strokeStyle = 'rgba(232, 96, 76, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  dispose(): void {
    this.element.remove();
  }

  // -- internals --------------------------------------------------------------

  /**
   * Rasterise the map once, the same way `Minimap` does.
   *
   * Same classification thresholds, same footprint projection for pitched brushes, so the two
   * pictures cannot disagree about what a wall is.
   */
  private buildRaster(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.widthPx;
    canvas.height = this.heightPx;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Mortar overlay raster needs a 2D context');

    ctx.setTransform(PX_PER_M, 0, 0, PX_PER_M, -this.minX * PX_PER_M, -this.minZ * PX_PER_M);
    ctx.lineWidth = 0.1;

    // A ten-metre grid, so distances are readable rather than guessed.
    ctx.strokeStyle = COLOR_GRID;
    for (let x = Math.ceil(this.minX / 10) * 10; x < this.minX + this.spanX; x += 10) {
      ctx.beginPath();
      ctx.moveTo(x, this.minZ);
      ctx.lineTo(x, this.minZ + this.spanZ);
      ctx.stroke();
    }
    for (let z = Math.ceil(this.minZ / 10) * 10; z < this.minZ + this.spanZ; z += 10) {
      ctx.beginPath();
      ctx.moveTo(this.minX, z);
      ctx.lineTo(this.minX + this.spanX, z);
      ctx.stroke();
    }

    for (const pass of ['wall', 'deck'] as const) {
      for (const brush of this.deps.mapDef.brushes) {
        if (brush.solid === false) continue;
        if (classify(brush) !== pass) continue;
        ctx.fillStyle = pass === 'deck' ? COLOR_DECK : COLOR_WALL;
        ctx.strokeStyle = COLOR_WALL_EDGE;
        const planX = brush.size.x * Math.cos(brush.rotationZ ?? 0);
        const planZ = brush.size.z * Math.cos(brush.rotationX ?? 0);
        footprint(ctx, brush.position.x, brush.position.z, planX, planZ, brush.rotationY);
      }
    }

    ctx.fillStyle = COLOR_WALL;
    ctx.strokeStyle = COLOR_WALL_EDGE;
    for (const placement of this.deps.mapDef.props) {
      const shape = PROP_SHAPES[placement.shape];
      for (const part of shape.parts) {
        if (!part.solid) continue;
        const c = Math.cos(placement.rotationY);
        const s = Math.sin(placement.rotationY);
        const wx = placement.position.x + part.offset.x * c + part.offset.z * s;
        const wz = placement.position.z - part.offset.x * s + part.offset.z * c;
        footprint(ctx, wx, wz, part.size.x, part.size.z, placement.rotationY);
      }
    }
    return canvas;
  }
}

/** The same thresholds `Minimap` classifies by; see its header for the reasoning. */
function classify(brush: Brush): 'skip' | 'wall' | 'deck' {
  const top = brush.position.y + brush.size.y * 0.5;
  const bottom = brush.position.y - brush.size.y * 0.5;
  if (top <= 0.1) return 'skip';
  if (bottom > 5.5) return 'skip';
  if (bottom > 3.0) return 'deck';
  return 'wall';
}

function footprint(
  ctx: CanvasRenderingContext2D,
  x: number,
  z: number,
  sx: number,
  sz: number,
  yaw: number,
): void {
  ctx.save();
  ctx.translate(x, z);
  ctx.rotate(-yaw);
  ctx.beginPath();
  ctx.rect(-sx * 0.5, -sz * 0.5, sx, sz);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
