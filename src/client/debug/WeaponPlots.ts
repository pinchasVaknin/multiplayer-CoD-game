import { RAD2DEG } from '../../shared/core/MathUtil';
import { accumulatePattern } from '../../shared/weapons/Recoil';
import type { WeaponDef } from '../../shared/weapons/WeaponDefs';

/**
 * The recoil-pattern plot and the spread ring (brief S7).
 *
 * The pattern plot is the piece that earns its place in the overlay. It draws three
 * things in one space: the authored pattern, the burst you just fired, and the burst
 * before it. Acceptance criterion 2 — "fire a full mag twice with input held and confirm
 * the shot placements match" — stops being an assertion and becomes something you look
 * at: two identical magazines land exactly on top of each other.
 *
 * Placements are recorded in screen space (degrees right, degrees up) relative to the
 * first round of the burst, which is how a player experiences the pattern.
 */

const BURST_CAP = 128;
export const PLOT_WIDTH = 300;
export const PLOT_HEIGHT = 190;
export const RING_WIDTH = 300;
export const RING_HEIGHT = 150;

interface Burst {
  x: Float32Array;
  y: Float32Array;
  count: number;
}

function makeBurst(): Burst {
  return { x: new Float32Array(BURST_CAP), y: new Float32Array(BURST_CAP), count: 0 };
}

export class WeaponPlots {
  private readonly patternX = new Float32Array(BURST_CAP);
  private readonly patternY = new Float32Array(BURST_CAP);

  private current = makeBurst();
  private previous = makeBurst();
  private yaw0 = 0;
  private pitch0 = 0;

  constructor(
    private readonly plot: CanvasRenderingContext2D,
    private readonly ring: CanvasRenderingContext2D,
    def: WeaponDef,
  ) {
    this.rebuildPattern(def);
  }

  get currentCount(): number {
    return this.current.count;
  }

  get previousCount(): number {
    return this.previous.count;
  }

  /** Re-derive the authored trace after a live retune of the recoil scalars. */
  rebuildPattern(def: WeaponDef): void {
    accumulatePattern(def, BURST_CAP, this.patternX, this.patternY);
  }

  reset(): void {
    this.current.count = 0;
    this.previous.count = 0;
  }

  /** Angular placement of a shot relative to the first round of its burst. */
  record(dx: number, dy: number, dz: number, shotIndex: number): void {
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy)));
    const yaw = Math.atan2(-dx, -dz);

    if (shotIndex === 0) {
      const finished = this.current;
      this.current = this.previous;
      this.previous = finished;
      this.current.count = 0;
      this.yaw0 = yaw;
      this.pitch0 = pitch;
    }

    const b = this.current;
    if (b.count >= BURST_CAP) return;
    // Screen space: right is positive, and yaw decreases to the right.
    let dYaw = yaw - this.yaw0;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    b.x[b.count] = -dYaw * RAD2DEG;
    b.y[b.count] = (pitch - this.pitch0) * RAD2DEG;
    b.count++;
  }

  draw(def: WeaponDef, spreadDeg: number): void {
    this.drawPattern(def);
    this.drawRing(def, spreadDeg);
  }

  /**
   * Authored trace in grey, the burst you just fired in accent, the burst before it in
   * green. Two identical magazines overlay exactly.
   */
  private drawPattern(def: WeaponDef): void {
    const ctx = this.plot;
    ctx.clearRect(0, 0, PLOT_WIDTH, PLOT_HEIGHT);
    ctx.fillStyle = '#0c0e11';
    ctx.fillRect(0, 0, PLOT_WIDTH, PLOT_HEIGHT);

    let span = 1;
    for (let i = 0; i < BURST_CAP; i++) {
      span = Math.max(span, Math.abs(this.patternX[i] ?? 0), Math.abs(this.patternY[i] ?? 0));
    }
    for (const b of [this.current, this.previous]) {
      for (let i = 0; i < b.count; i++) {
        span = Math.max(span, Math.abs(b.x[i] ?? 0), Math.abs(b.y[i] ?? 0));
      }
    }
    span *= 1.12;

    const cx = PLOT_WIDTH / 2;
    const cy = PLOT_HEIGHT - 14;
    const scale = Math.min((PLOT_WIDTH / 2 - 8) / span, (PLOT_HEIGHT - 24) / span);

    ctx.strokeStyle = '#262b33';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, 0);
    ctx.lineTo(cx + 0.5, PLOT_HEIGHT);
    ctx.moveTo(0, cy + 0.5);
    ctx.lineTo(PLOT_WIDTH, cy + 0.5);
    ctx.stroke();

    const patternCount = Math.min(def.recoil.kicks.length * 2, BURST_CAP);
    strokeTrace(ctx, this.patternX, this.patternY, patternCount, cx, cy, scale, '#39404b', 1.5);
    strokeTrace(ctx, this.previous.x, this.previous.y, this.previous.count, cx, cy, scale, '#6fd08c', 1.5);
    strokeTrace(ctx, this.current.x, this.current.y, this.current.count, cx, cy, scale, '#ffb340', 2);

    ctx.fillStyle = '#626a77';
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.fillText(`+/-${span.toFixed(1)} deg   grey=pattern  amber=burst  green=previous`, 6, 11);
  }

  /** The spread cone against the weapon's authored bounds, plus where rounds landed. */
  private drawRing(def: WeaponDef, spreadDeg: number): void {
    const ctx = this.ring;
    ctx.clearRect(0, 0, RING_WIDTH, RING_HEIGHT);
    ctx.fillStyle = '#0c0e11';
    ctx.fillRect(0, 0, RING_WIDTH, RING_HEIGHT);

    const maxDeg = Math.max(def.spread.hipMove * def.spread.airScale, spreadDeg, 0.5) * 1.1;
    const cx = RING_WIDTH / 2;
    const cy = RING_HEIGHT / 2;
    const radiusPx = Math.min(cx, cy) - 10;
    const scale = radiusPx / maxDeg;

    for (const [deg, color] of [
      [def.spread.hipMove, '#39404b'],
      [def.spread.hipStand, '#8fa6c4'],
      [def.spread.ads, '#6fd08c'],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, deg * scale), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = '#ffb340';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, spreadDeg * scale), 0, Math.PI * 2);
    ctx.stroke();

    const b = this.current;
    ctx.fillStyle = 'rgba(232,234,238,0.75)';
    for (let i = Math.max(0, b.count - 30); i < b.count; i++) {
      const px = cx + (b.x[i] ?? 0) * scale;
      const py = cy - (b.y[i] ?? 0) * scale;
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }

    ctx.fillStyle = '#626a77';
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.fillText(`cone ${spreadDeg.toFixed(2)} deg   ring max ${maxDeg.toFixed(2)} deg`, 6, 12);
  }
}

function strokeTrace(
  ctx: CanvasRenderingContext2D,
  xs: Float32Array,
  ys: Float32Array,
  count: number,
  cx: number,
  cy: number,
  scale: number,
  color: string,
  width: number,
): void {
  if (count === 0) return;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const px = cx + (xs[i] ?? 0) * scale;
    const py = cy - (ys[i] ?? 0) * scale;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  for (let i = 0; i < count; i++) {
    const px = cx + (xs[i] ?? 0) * scale;
    const py = cy - (ys[i] ?? 0) * scale;
    ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
  }
}
