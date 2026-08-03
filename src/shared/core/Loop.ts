/**
 * Fixed-timestep simulation clock (brief S4.1).
 *
 * `DT` is a constant, not a measured delta. Nothing in gameplay ever multiplies by a
 * variable frame time. Rendering interpolates between the previous and current sim
 * state using `alpha = accumulator / DT`.
 *
 * **M9.** This file used to be the browser's `requestAnimationFrame` loop as well. The
 * driver moved out — `client/engine/FrameLoop.ts` in the browser, `server/Loop.ts` in
 * Node — and what stayed is the part that decides *how many fixed steps a given stretch
 * of elapsed time is worth*. Both runtimes step through `TickAccumulator`, so the
 * catch-up cap and the discard rule are one implementation rather than two that drift.
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
export const MAX_FRAME_SECONDS = 0.25;

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

/**
 * Turns elapsed wall-clock time into a whole number of fixed simulation steps.
 *
 * Pure: it holds no timer, reads no clock and calls nothing. The caller measures the
 * elapsed time however its runtime allows and hands it in. That is the whole reason this
 * class exists separately from the two drivers — the browser measures with
 * `requestAnimationFrame`'s timestamp and Node measures with `process.hrtime`, but the
 * rule for converting that measurement into ticks must be identical or the two runtimes
 * disagree about what tick it is.
 */
export class TickAccumulator {
  private accumulator = 0;
  private tickIndex_ = 0;
  private starved_ = false;

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

  get currentTick(): number {
    return this.tickIndex_;
  }

  /** Seconds of simulated time elapsed. Derived from ticks, never from wall clock. */
  get simTime(): number {
    return this.tickIndex_ * DT;
  }

  /** Interpolation factor between the previous and current sim state, in [0, 1). */
  get alpha(): number {
    return this.accumulator / DT;
  }

  /** True if the last `take` hit the step cap and discarded a whole-tick backlog. */
  get starved(): boolean {
    return this.starved_;
  }

  /** Drop any banked sub-tick time. Does not touch the tick counter. */
  reset(): void {
    this.accumulator = 0;
    this.starved_ = false;
  }

  /**
   * Bank `frameSeconds` of elapsed time and return how many fixed steps are now owed.
   *
   * The caller runs exactly that many steps, taking a tick index from `nextTick()` for
   * each one.
   */
  take(frameSeconds: number): number {
    let s = frameSeconds;
    if (s > MAX_FRAME_SECONDS) s = MAX_FRAME_SECONDS;
    if (s < 0) s = 0;

    this.accumulator += s * this.simSpeed;

    let steps = 0;
    while (this.accumulator >= DT && steps < this.maxStepsPerFrame) {
      this.accumulator -= DT;
      steps++;
    }

    // Step cap hit: throw away the whole-tick backlog but keep the sub-tick
    // fraction so interpolation stays smooth. Never spiral.
    this.starved_ = steps === this.maxStepsPerFrame && this.accumulator >= DT;
    if (this.starved_) this.accumulator %= DT;

    return steps;
  }

  /** The tick index for the next step, incrementing the counter. */
  nextTick(): number {
    return this.tickIndex_++;
  }
}
