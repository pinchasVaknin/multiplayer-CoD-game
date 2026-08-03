/**
 * Input-latency probe (brief S7).
 *
 * Measures the interval from the `mousedown` DOM event to the end of the render callback
 * that first draws the shot it caused. Target is under two frames.
 *
 * What this does *not* include is the compositor: the browser gives a page no way to
 * observe when its pixels reach the panel, so the honest reading is "mousedown to the
 * frame we handed to the GPU", and one further frame of presentation sits on top of every
 * number here. That caveat is the reason the read-out is labelled in frames as well as
 * milliseconds — the frame count is what is actually actionable.
 *
 * The probe is the only thing in the project allowed to look at both sides of the input
 * seam, because `InputCommand` is locked by S4.2 and must not grow a debug field.
 */

const CAPACITY = 512;
const FRAME_MS = 1000 / 60;
/** Anything slower than this is a stall, not a latency sample. */
const OUTLIER_MS = 250;

export class LatencyProbe {
  private readonly samples = new Float32Array(CAPACITY);
  private head = 0;
  private filled = 0;

  private pendingPressMs = -1;
  private pendingSince = 0;

  p50 = 0;
  p95 = 0;
  p99 = 0;
  worst = 0;
  mean = 0;
  /** Presses that produced a shot but never a frame, e.g. the tab lost focus. */
  dropped = 0;

  private readonly scratch = new Float32Array(CAPACITY);

  get count(): number {
    return this.filled;
  }

  get armed(): boolean {
    return this.pendingPressMs >= 0;
  }

  /**
   * A shot was fired in the sim. `pressMs` is the timestamp taken from `Input`, or -1
   * when the shot came from a held trigger rather than a fresh press — only fresh
   * presses measure anything, because a held trigger's timing is set by the fire rate.
   */
  armFromPress(pressMs: number): void {
    if (pressMs < 0) return;
    if (this.pendingPressMs >= 0) this.dropped++;
    this.pendingPressMs = pressMs;
    this.pendingSince = performance.now();
  }

  /** Called at the end of the render callback for the frame that drew the shot. */
  notePresented(nowMs: number): void {
    if (this.pendingPressMs < 0) return;
    const delta = nowMs - this.pendingPressMs;
    this.pendingPressMs = -1;
    if (delta < 0 || delta > OUTLIER_MS) {
      this.dropped++;
      return;
    }
    this.samples[this.head] = delta;
    this.head = (this.head + 1) % CAPACITY;
    if (this.filled < CAPACITY) this.filled++;
  }

  /** Drop a press that never produced a frame within a reasonable window. */
  expire(nowMs: number): void {
    if (this.pendingPressMs < 0) return;
    if (nowMs - this.pendingSince < OUTLIER_MS) return;
    this.pendingPressMs = -1;
    this.dropped++;
  }

  recompute(): void {
    const n = this.filled;
    if (n === 0) return;
    const view = this.scratch.subarray(0, n);
    view.set(this.samples.subarray(0, n));
    view.sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += view[i] ?? 0;
    this.mean = sum / n;
    this.p50 = pick(view, n, 0.5);
    this.p95 = pick(view, n, 0.95);
    this.p99 = pick(view, n, 0.99);
    this.worst = view[n - 1] ?? 0;
  }

  reset(): void {
    this.samples.fill(0);
    this.head = 0;
    this.filled = 0;
    this.dropped = 0;
    this.pendingPressMs = -1;
    this.p50 = 0;
    this.p95 = 0;
    this.p99 = 0;
    this.worst = 0;
    this.mean = 0;
  }

  static frames(ms: number): number {
    return ms / FRAME_MS;
  }

  /** Bucketed histogram, one bucket per half frame out to four frames. */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number, colors: LatencyColors): void {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const buckets = 16;
    const counts = new Int32Array(buckets);
    const bucketMs = FRAME_MS * 0.5;
    for (let i = 0; i < this.filled; i++) {
      const v = this.samples[i] ?? 0;
      const b = Math.min(buckets - 1, Math.floor(v / bucketMs));
      counts[b] = (counts[b] ?? 0) + 1;
    }
    let peak = 1;
    for (let i = 0; i < buckets; i++) peak = Math.max(peak, counts[i] ?? 0);

    const barW = width / buckets;
    for (let i = 0; i < buckets; i++) {
      const h = ((counts[i] ?? 0) / peak) * (height - 12);
      // Two frames is the target; anything past it is coloured as a miss.
      ctx.fillStyle = i < 4 ? colors.good : colors.bad;
      ctx.fillRect(i * barW + 1, height - h, barW - 2, h);
    }

    // Frame gridlines at 1, 2 and 3 frames.
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    for (let f = 1; f <= 3; f++) {
      const x = Math.round((f * FRAME_MS) / bucketMs) * barW + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }
}

export interface LatencyColors {
  background: string;
  good: string;
  bad: string;
  grid: string;
}

function pick(sorted: Float32Array, n: number, q: number): number {
  const idx = Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))));
  return sorted[idx] ?? 0;
}
