/**
 * Fixed-timestep loop (brief S4.1).
 *
 * `DT` is a constant, not a measured delta. Nothing in gameplay ever multiplies by a
 * variable frame time. Rendering interpolates between the previous and current sim
 * state using `alpha = accumulator / DT`.
 */

export const SIM_HZ = 60;
/** The simulation timestep. Exactly 1/60. This is a constant everywhere downstream. */
export const DT = 1 / 60;

/** Hard cap on catch-up work per frame. Beyond this the backlog is discarded. */
export const MAX_STEPS_PER_FRAME = 5;

/**
 * A frame longer than this (alt-tab, breakpoint, GC pause) is treated as a stall:
 * the wall-clock gap is not owed to the simulation.
 */
const MAX_FRAME_SECONDS = 0.25;

export interface FrameSample {
  /** Wall-clock time between this frame and the previous one, ms. */
  frameMs: number;
  /** Time spent inside sim steps this frame, ms. */
  simMs: number;
  /** Time spent inside the render callback this frame, ms. */
  renderMs: number;
  /** Sim steps executed this frame (0..MAX_STEPS_PER_FRAME). */
  steps: number;
  /** Interpolation factor handed to render. */
  alpha: number;
  /** True if the step cap was hit and a backlog was discarded. */
  starved: boolean;
}

export interface LoopHandlers {
  /** One fixed simulation step. `tickIndex` is monotonic across the session. */
  sim: (tickIndex: number) => void;
  /** Draw. `alpha` is in [0,1) between the previous and current sim state. */
  render: (alpha: number) => void;
  /** Called once per frame after render, with reused stats. Do not retain. */
  onFrame?: (sample: FrameSample) => void;
}

export class Loop {
  private accumulator = 0;
  private tickIndex = 0;
  private lastMs = 0;
  private rafId = 0;
  private running = false;

  /** Reused; never handed out beyond the onFrame callback. */
  private readonly sample: FrameSample = {
    frameMs: 0,
    simMs: 0,
    renderMs: 0,
    steps: 0,
    alpha: 0,
    starved: false,
  };

  /**
   * Debug-only: busy-wait this many milliseconds inside every frame. Used to
   * artificially throttle the render loop and prove that simulation speed is
   * independent of frame rate (acceptance criterion 5). See DEBUG.md.
   */
  syntheticLoadMs = 0;

  /**
   * Debug-only: how many seconds of simulation a second of wall clock is worth (S7).
   *
   * This scales the *number of ticks per frame* and nothing else. `DT` stays exactly
   * 1/60 for every one of them, so no gameplay value is ever multiplied by a different
   * number — a 4x harness run is indistinguishable from a run four times as long, which
   * is the only way a soak test can say anything about the real build.
   */
  simSpeed = 1;

  /**
   * Debug-only companion to `simSpeed`: the catch-up cap has to rise with it, or the
   * extra ticks are discarded as a backlog the moment the multiplier exceeds 5.
   */
  maxStepsPerFrame = MAX_STEPS_PER_FRAME;

  constructor(private readonly handlers: LoopHandlers) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMs = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentTick(): number {
    return this.tickIndex;
  }

  /** Seconds of simulated time elapsed. Derived from ticks, never from wall clock. */
  get simTime(): number {
    return this.tickIndex * DT;
  }

  private readonly frame = (nowMs: number): void => {
    this.rafId = requestAnimationFrame(this.frame);

    const frameMs = nowMs - this.lastMs;
    this.lastMs = nowMs;

    let frameSeconds = frameMs / 1000;
    if (frameSeconds > MAX_FRAME_SECONDS) frameSeconds = MAX_FRAME_SECONDS;
    if (frameSeconds < 0) frameSeconds = 0;

    this.accumulator += frameSeconds * this.simSpeed;

    const simStart = performance.now();
    let steps = 0;
    while (this.accumulator >= DT && steps < this.maxStepsPerFrame) {
      this.handlers.sim(this.tickIndex);
      this.tickIndex++;
      this.accumulator -= DT;
      steps++;
    }
    const simEnd = performance.now();

    // Step cap hit: throw away the whole-tick backlog but keep the sub-tick
    // fraction so interpolation stays smooth. Never spiral.
    const starved = steps === this.maxStepsPerFrame && this.accumulator >= DT;
    if (starved) this.accumulator %= DT;

    const alpha = this.accumulator / DT;

    const renderStart = performance.now();
    this.handlers.render(alpha);
    if (this.syntheticLoadMs > 0) busyWait(this.syntheticLoadMs);
    const renderEnd = performance.now();

    const s = this.sample;
    s.frameMs = frameMs;
    s.simMs = simEnd - simStart;
    s.renderMs = renderEnd - renderStart;
    s.steps = steps;
    s.alpha = alpha;
    s.starved = starved;
    this.handlers.onFrame?.(s);
  };
}

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  // Deliberately hot: this is a debug tool for making frames expensive on purpose.
  while (performance.now() < end) {
    /* spin */
  }
}
