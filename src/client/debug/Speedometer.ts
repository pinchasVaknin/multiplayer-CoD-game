/**
 * Wall-clock speed measurement.
 *
 * This exists for acceptance criteria 5 and 6, and it deliberately measures against
 * `performance.now()` rather than sim ticks. Measuring sim ticks against sim ticks
 * would prove nothing about frame-rate independence — of course the sim agrees with
 * itself. Real distance over real seconds is the honest test.
 *
 * `sustained` is the average speed over the last full second. `sustainedPeak` is the
 * highest such window seen.
 *
 * KNOWN LIMIT, and the reason the S5.2 bound is NOT checked with this class: position
 * only advances on 60 Hz sim ticks, so a wall-clock window of length T contains
 * round(T / DT) +/- 1 ticks. Averages are unbiased, but taking the *peak* over many
 * windows systematically selects the one that caught the extra tick, which reads about
 * +1/N high — roughly +1.7% at a one-second window. A correctly bounded 8.2 m/s
 * therefore shows a sustained peak near 8.3 here.
 *
 * That is a property of measuring a discrete process against a continuous clock, not a
 * movement bug, and it is not worth "fixing" by measuring sim time against sim time:
 * wall clock is exactly what makes this instrument able to answer acceptance criterion
 * 5 (does frame rate change my speed?). The bound in criterion 6 is verified instead by
 * debug/Harness.ts, which measures whole ticks and is exact.
 */

const CAPACITY = 512;
const INSTANT_WINDOW_S = 0.25;
const SUSTAINED_WINDOW_S = 1;

export class Speedometer {
  private readonly time = new Float64Array(CAPACITY);
  private readonly arc = new Float64Array(CAPACITY);
  private head = 0;
  private count = 0;

  private lastX = 0;
  private lastZ = 0;
  private totalArc = 0;
  private primed = false;

  instant = 0;
  sustained = 0;
  sustainedPeak = 0;
  instantPeak = 0;

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.totalArc = 0;
    this.primed = false;
    this.instant = 0;
    this.sustained = 0;
    this.sustainedPeak = 0;
    this.instantPeak = 0;
  }

  /** Feed the player's horizontal position once per frame. `nowMs` is wall clock. */
  sample(x: number, z: number, nowMs: number): void {
    const t = nowMs / 1000;
    if (!this.primed) {
      this.primed = true;
      this.lastX = x;
      this.lastZ = z;
      this.push(t, 0);
      return;
    }

    // Horizontal path length only: falling into the pit is not speed.
    this.totalArc += Math.hypot(x - this.lastX, z - this.lastZ);
    this.lastX = x;
    this.lastZ = z;
    this.push(t, this.totalArc);

    this.instant = this.windowSpeed(t, INSTANT_WINDOW_S);
    this.sustained = this.windowSpeed(t, SUSTAINED_WINDOW_S);
    if (this.instant > this.instantPeak) this.instantPeak = this.instant;
    // Only trust the sustained figure once a full window of history exists.
    if (this.spanSeconds(t) >= SUSTAINED_WINDOW_S && this.sustained > this.sustainedPeak) {
      this.sustainedPeak = this.sustained;
    }
  }

  private push(t: number, arc: number): void {
    this.time[this.head] = t;
    this.arc[this.head] = arc;
    this.head = (this.head + 1) % CAPACITY;
    if (this.count < CAPACITY) this.count++;
  }

  private spanSeconds(now: number): number {
    if (this.count < 2) return 0;
    const oldest = (this.head - this.count + CAPACITY) % CAPACITY;
    return now - (this.time[oldest] ?? now);
  }

  /**
   * Average speed over exactly the last `window` seconds, or 0 without enough history.
   *
   * The window start is interpolated between the two samples that straddle it rather
   * than snapped to the nearest older sample. Snapping makes the window slightly
   * longer than requested and, because position only advances on 60 Hz sim ticks, the
   * number of ticks captured varies by one — so taking a *peak* over many windows
   * systematically picks the luckiest one and over-reports by roughly 1/N. At a 1 s
   * window that is +1.7%, which is enough to make a correctly bounded 8.2 m/s read as
   * 8.32 and fail its own acceptance check.
   */
  private windowSpeed(now: number, window: number): number {
    if (this.count < 2) return 0;
    const target = now - window;

    let older = -1;
    let newer = -1;
    for (let i = 1; i <= this.count; i++) {
      const idx = (this.head - i + CAPACITY) % CAPACITY;
      if ((this.time[idx] ?? 0) <= target) {
        older = idx;
        newer = (idx + 1) % CAPACITY;
        break;
      }
    }
    if (older < 0 || newer < 0) return 0;

    const t0 = this.time[older] ?? 0;
    const t1 = this.time[newer] ?? 0;
    const a0 = this.arc[older] ?? 0;
    const a1 = this.arc[newer] ?? 0;
    const span = t1 - t0;
    const arcAtTarget = span > 1e-9 ? a0 + ((a1 - a0) * (target - t0)) / span : a0;

    const newest = (this.head - 1 + CAPACITY) % CAPACITY;
    const dt = (this.time[newest] ?? 0) - target;
    if (dt <= 1e-4) return 0;
    return ((this.arc[newest] ?? 0) - arcAtTarget) / dt;
  }
}
