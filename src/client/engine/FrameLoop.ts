import {
  DT,
  MAX_STEPS_PER_FRAME,
  TickAccumulator,
  type FrameSample,
  type LoopHandlers,
} from '../../shared/core/Loop';

/**
 * The browser's frame driver (brief S4.1).
 *
 * `requestAnimationFrame` in, fixed 60 Hz simulation steps out. The rule for turning
 * elapsed time into steps lives in `shared/core/Loop.ts` and is shared with the server,
 * because a client and a server that disagree about how many ticks a slow frame is worth
 * disagree about what tick it is — which at M10 would look like a netcode bug.
 *
 * Everything that made this class browser-specific stayed here: `requestAnimationFrame`,
 * `cancelAnimationFrame` and `performance.now()`. The sim itself never sees any of them.
 */
export class Loop {
  private readonly ticks = new TickAccumulator();
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

  constructor(private readonly handlers: LoopHandlers) {}

  /** See `TickAccumulator.simSpeed`. */
  get simSpeed(): number {
    return this.ticks.simSpeed;
  }

  set simSpeed(v: number) {
    this.ticks.simSpeed = v;
  }

  /** See `TickAccumulator.maxStepsPerFrame`. */
  get maxStepsPerFrame(): number {
    return this.ticks.maxStepsPerFrame;
  }

  set maxStepsPerFrame(v: number) {
    this.ticks.maxStepsPerFrame = v;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMs = performance.now();
    this.ticks.reset();
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
    return this.ticks.currentTick;
  }

  /** Seconds of simulated time elapsed. Derived from ticks, never from wall clock. */
  get simTime(): number {
    return this.ticks.simTime;
  }

  private readonly frame = (nowMs: number): void => {
    this.rafId = requestAnimationFrame(this.frame);

    const frameMs = nowMs - this.lastMs;
    this.lastMs = nowMs;

    const steps = this.ticks.take(frameMs / 1000);

    const simStart = performance.now();
    for (let i = 0; i < steps; i++) {
      this.handlers.sim(this.ticks.nextTick());
    }
    const simEnd = performance.now();

    const alpha = this.ticks.alpha;

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
    s.starved = this.ticks.starved;
    this.handlers.onFrame?.(s);
  };
}

export { DT, MAX_STEPS_PER_FRAME };
export type { FrameSample, LoopHandlers };

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  // Deliberately hot: this is a debug tool for making frames expensive on purpose.
  while (performance.now() < end) {
    /* spin */
  }
}
