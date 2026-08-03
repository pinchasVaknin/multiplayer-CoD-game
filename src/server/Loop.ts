import { nowMs } from '../shared/core/Clock';
import { DT, SIM_HZ } from '../shared/core/Loop';
import { logger } from '../shared/core/Log';

const log = logger('Loop');

/**
 * The server's fixed 60 Hz tick (brief S4.10).
 *
 * ## Why this is not `TickAccumulator`
 *
 * The client's loop (`shared/core/Loop.ts`) banks elapsed frame time, runs whole ticks out of
 * it, and **discards the backlog** past five steps rather than spiralling. That is right for a
 * renderer whose frame rate is not its own business.
 *
 * It is wrong here, and S4.11 says why: *"the server tick is the clock."* A server that
 * quietly dropped a tick under load would run its match slower than the clock every client
 * derives its own tick number from, and the two would diverge permanently with nothing
 * reporting it. So this loop shares `DT` and the meaning of a tick with the client, and
 * nothing else.
 *
 * ## Drift correction
 *
 * S4.10 is blunt that `setInterval(fn, 16)` does not give 60 Hz. It gives roughly 58-62 Hz
 * with excursions, and — the part that actually matters — **its error accumulates**, because
 * each interval is measured from when the last one happened to fire rather than from when it
 * was due.
 *
 * The fix is to schedule against an **absolute** timetable: tick *n* is due at
 * `startMs + n * TICK_MS`, forever, and a late tick does not move the ones after it. A timer
 * that fires 4 ms late costs one 4 ms excursion instead of shifting the entire remaining run.
 *
 * The timer is asked to wake slightly *early* (`WAKE_MARGIN_MS`) because Node's timers round
 * up and are readily a millisecond or two late; the loop then runs every tick whose due time
 * has actually passed. There is no spin: S4.10 says not to busy-wait a core, and a sub-
 * millisecond scheduling error is not worth a hot CPU on a box that will host a match.
 *
 * ## Catch-up, bounded
 *
 * If the process stalls — GC, a blocked I/O call, the host descheduling us — several ticks
 * come due at once and are run back to back. That is the correct response: the match clock
 * must not slow down. It is capped at `MAX_CATCHUP_TICKS` so a long stall cannot turn into an
 * unbounded burst that stalls the process further; past the cap the schedule is *rebased* to
 * now and the skipped ticks are counted and logged. Rebasing rather than silently continuing
 * matters, because the alternative is a loop that spends the next minute trying to catch up
 * on a two-second stall and delivers nothing on time while it does.
 */

export const TICK_MS = 1000 / SIM_HZ;

/**
 * How early to ask the timer to wake, in ms.
 *
 * Node's `setTimeout` never fires early but is regularly late. Waking a whisker early and
 * finding nothing due yet costs one cheap re-arm; waking late costs jitter on every tick.
 */
const WAKE_MARGIN_MS = 1;

/**
 * Ticks that may be run back to back to catch up after a stall.
 *
 * 250 ms of simulation. Long enough to absorb a GC pause or a slow first frame, short enough
 * that the loop cannot disappear into a catch-up burst.
 */
const MAX_CATCHUP_TICKS = 15;

/** Delivered intervals kept for the jitter percentiles. 30 s at 60 Hz. */
const JITTER_WINDOW = 1800;

export interface TickJitter {
  /** Delivered interval between consecutive ticks, ms. */
  readonly p50: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  /** Mean delivered interval, ms. 16.667 is exact. */
  readonly mean: number;
  /** Ticks that ran more than a tick after they were due. */
  readonly late: number;
  /** Ticks abandoned because the catch-up cap was hit. A non-zero value is a real problem. */
  readonly dropped: number;
  /** Ticks delivered in total. */
  readonly ticks: number;
  /** Delivered rate over the whole run, Hz. */
  readonly hz: number;
}

export interface ServerLoopOptions {
  /** One fixed simulation step. `tickIndex` is monotonic across the process. */
  readonly tick: (tickIndex: number) => void;
  /**
   * Called after each tick. Return false to stop the loop.
   *
   * Separate from `tick` so the stop condition is not tangled with the simulation, and so a
   * match that ends mid-catch-up still stops on the tick it ended rather than after the burst.
   */
  readonly shouldContinue?: (tickIndex: number) => boolean;
  /** Called once, after the loop stops. */
  readonly onStop?: () => void;
}

export class ServerLoop {
  private readonly opts: ServerLoopOptions;

  private startMs = 0;
  private tickIndex = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private lastTickMs = 0;
  private readonly intervals = new Float64Array(JITTER_WINDOW);
  private intervalCount = 0;
  private intervalHead = 0;
  private lateTicks = 0;
  private droppedTicks = 0;
  private simMsTotal = 0;

  constructor(opts: ServerLoopOptions) {
    this.opts = opts;
  }

  get currentTick(): number {
    return this.tickIndex;
  }

  /** Seconds of simulated time delivered. Derived from ticks, never from the wall clock. */
  get simTime(): number {
    return this.tickIndex * DT;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Mean milliseconds spent inside `tick`. The AI-plus-sim cost, against S4.7's 3.0 ms. */
  get meanSimMs(): number {
    return this.tickIndex === 0 ? 0 : this.simMsTotal / this.tickIndex;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startMs = nowMs();
    this.lastTickMs = this.startMs;
    this.arm();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opts.onStop?.();
  }

  /**
   * Jitter over the trailing window (S4.10: *"a first-class metric, not a debug curiosity"*).
   *
   * S4.10's reasoning is worth keeping in view: every timing bug from here on will be blamed
   * on the network first, and this is the number that says whether it was.
   */
  jitter(): TickJitter {
    const n = this.intervalCount;
    if (n === 0) {
      return { p50: 0, p99: 0, min: 0, max: 0, mean: 0, late: 0, dropped: 0, ticks: 0, hz: 0 };
    }
    const sample = Array.from(this.intervals.subarray(0, n));
    sample.sort((a, b) => a - b);
    const at = (p: number): number => sample[Math.min(n - 1, Math.floor(p * n))] ?? 0;
    let sum = 0;
    for (const v of sample) sum += v;
    const elapsed = nowMs() - this.startMs;
    return {
      p50: round3(at(0.5)),
      p99: round3(at(0.99)),
      min: round3(sample[0] ?? 0),
      max: round3(sample[n - 1] ?? 0),
      mean: round3(sum / n),
      late: this.lateTicks,
      dropped: this.droppedTicks,
      ticks: this.tickIndex,
      hz: elapsed > 0 ? round3((this.tickIndex / elapsed) * 1000) : 0,
    };
  }

  // -- internals ------------------------------------------------------------

  private arm(): void {
    if (!this.running) return;
    const dueMs = this.startMs + this.tickIndex * TICK_MS;
    const delay = dueMs - nowMs() - WAKE_MARGIN_MS;
    this.timer = setTimeout(this.wake, delay > 0 ? delay : 0);
  }

  private readonly wake = (): void => {
    this.timer = null;
    if (!this.running) return;

    let ran = 0;
    while (this.running) {
      const now = nowMs();
      const dueMs = this.startMs + this.tickIndex * TICK_MS;
      if (now < dueMs) break;

      if (ran >= MAX_CATCHUP_TICKS) {
        // Too far behind to catch up without starving the event loop. Skip the backlog and
        // rebase the timetable to now, so the run continues on time from here rather than
        // chasing a debt it will never repay.
        const behind = now - dueMs;
        const skipped = Math.floor(behind / TICK_MS);
        this.droppedTicks += skipped;
        this.startMs += skipped * TICK_MS;
        log.warn(
          `stalled ${behind.toFixed(0)}ms; skipped ${skipped} tick(s) and rebased the schedule.`,
        );
        break;
      }

      if (now - dueMs > TICK_MS) this.lateTicks++;
      this.record(now);

      const t0 = nowMs();
      this.opts.tick(this.tickIndex);
      this.simMsTotal += nowMs() - t0;
      this.tickIndex++;
      ran++;

      if (this.opts.shouldContinue !== undefined && !this.opts.shouldContinue(this.tickIndex)) {
        this.stop();
        return;
      }
    }

    this.arm();
  };

  private record(now: number): void {
    this.intervals[this.intervalHead] = now - this.lastTickMs;
    this.lastTickMs = now;
    this.intervalHead = (this.intervalHead + 1) % JITTER_WINDOW;
    if (this.intervalCount < JITTER_WINDOW) this.intervalCount++;
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
