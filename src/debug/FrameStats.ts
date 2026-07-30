/**
 * Rolling frame-time history and the percentiles that actually matter.
 *
 * Average FPS hides everything interesting. A build that renders at 90 FPS with a
 * 40 ms hitch every second feels worse than a locked 60, and only p99 tells you that.
 * This is the number the milestone reports.
 */

export const HISTORY_LENGTH = 600;

export class FrameStats {
  private readonly frames = new Float32Array(HISTORY_LENGTH);
  private readonly sim = new Float32Array(HISTORY_LENGTH);
  private readonly render = new Float32Array(HISTORY_LENGTH);
  private readonly scratch = new Float32Array(HISTORY_LENGTH);

  private head = 0;
  private filled = 0;

  p50 = 0;
  p95 = 0;
  p99 = 0;
  worst = 0;
  mean = 0;
  /** Smoothed frames per second, for the big readout. */
  fps = 0;
  /** Frames in the buffer that exceeded 16.7 ms. */
  overBudget = 0;

  lastSimMs = 0;
  lastRenderMs = 0;
  lastFrameMs = 0;
  lastSteps = 0;
  starvedFrames = 0;

  /**
   * M4 breakdown (brief S7): time inside the game mode, and time inside the HUD.
   *
   * Both are carved out of the numbers above rather than added to them — mode time is part of
   * `simMs` and HUD time is part of `renderMs`. They are broken out because they are the two
   * costs M4 introduced that are easy to get wrong: a mode that walks the roster every tick,
   * and DOM writes that happen every frame instead of only on change.
   */
  lastModeMs = 0;
  lastHudMs = 0;
  peakModeMs = 0;
  peakHudMs = 0;

  push(frameMs: number, simMs: number, renderMs: number, steps: number, starved: boolean): void {
    this.frames[this.head] = frameMs;
    this.sim[this.head] = simMs;
    this.render[this.head] = renderMs;
    this.head = (this.head + 1) % HISTORY_LENGTH;
    if (this.filled < HISTORY_LENGTH) this.filled++;

    this.lastFrameMs = frameMs;
    this.lastSimMs = simMs;
    this.lastRenderMs = renderMs;
    this.lastSteps = steps;
    if (starved) this.starvedFrames++;

    // Long exponential average: the headline FPS should not flicker.
    const instant = frameMs > 0 ? 1000 / frameMs : 0;
    this.fps = this.fps === 0 ? instant : this.fps + (instant - this.fps) * 0.08;
  }

  /** The M4 sub-costs for this frame. Peaks are held until `reset`. */
  pushBreakdown(modeMs: number, hudMs: number): void {
    this.lastModeMs = modeMs;
    this.lastHudMs = hudMs;
    if (modeMs > this.peakModeMs) this.peakModeMs = modeMs;
    if (hudMs > this.peakHudMs) this.peakHudMs = hudMs;
  }

  /** Recompute percentiles. Sorts a copy; call at a few Hz, not per frame. */
  recompute(): void {
    const n = this.filled;
    if (n === 0) return;
    const view = this.scratch.subarray(0, n);
    view.set(this.frames.subarray(0, n));
    view.sort();

    let sum = 0;
    let over = 0;
    for (let i = 0; i < n; i++) {
      const v = view[i] ?? 0;
      sum += v;
      if (v > 16.7) over++;
    }
    this.mean = sum / n;
    this.overBudget = over;
    this.p50 = pick(view, n, 0.5);
    this.p95 = pick(view, n, 0.95);
    this.p99 = pick(view, n, 0.99);
    this.worst = view[n - 1] ?? 0;
  }

  reset(): void {
    this.frames.fill(0);
    this.sim.fill(0);
    this.render.fill(0);
    this.head = 0;
    this.filled = 0;
    this.starvedFrames = 0;
    this.p50 = 0;
    this.p95 = 0;
    this.p99 = 0;
    this.worst = 0;
    this.mean = 0;
    this.overBudget = 0;
    this.peakModeMs = 0;
    this.peakHudMs = 0;
  }

  get sampleCount(): number {
    return this.filled;
  }

  /**
   * Draw the rolling buffer. Oldest on the left, newest on the right, with the 16.7 ms
   * budget line and the p99 marker overlaid.
   */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number, styles: HistogramStyles): void {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = styles.background;
    ctx.fillRect(0, 0, width, height);

    const n = this.filled;
    if (n === 0) return;

    const ceilingMs = Math.max(33.4, Math.min(120, this.worst * 1.15));
    const toY = (ms: number): number => height - Math.min(1, ms / ceilingMs) * height;

    // Budget lines first, so the trace sits over them.
    ctx.strokeStyle = styles.budget;
    ctx.lineWidth = 1;
    for (const ms of [16.7, 33.4]) {
      if (ms > ceilingMs) continue;
      const y = Math.round(toY(ms)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Frame trace. One column per sample, clamped to the canvas width.
    const step = width / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + HISTORY_LENGTH * 2) % HISTORY_LENGTH;
      const ms = this.frames[idx] ?? 0;
      const x = i * step;
      const y = toY(ms);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = styles.trace;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Sim time underneath, filled, so a sim spike is distinguishable from a GPU stall.
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + HISTORY_LENGTH * 2) % HISTORY_LENGTH;
      ctx.lineTo(i * step, toY(this.sim[idx] ?? 0));
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = styles.sim;
    ctx.fill();

    if (this.p99 > 0 && this.p99 <= ceilingMs) {
      const y = Math.round(toY(this.p99)) + 0.5;
      ctx.strokeStyle = styles.p99;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

export interface HistogramStyles {
  background: string;
  trace: string;
  sim: string;
  budget: string;
  p99: string;
}

function pick(sorted: Float32Array, n: number, q: number): number {
  const idx = Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))));
  return sorted[idx] ?? 0;
}
