/**
 * Monotonic time, abstracted away from the runtime that provides it (M9, S3).
 *
 * `shared/` may not reference `performance.now()`, and `server/` may not either. Both
 * runtimes install their own implementation at boot and everything downstream asks here.
 *
 * **This clock never drives simulation.** Gameplay time is `tickIndex * DT` and nothing
 * else — that is S4.1 and it did not change at M9. The audit found every pre-M9 use of
 * `performance.now()` in shared code to be instrumentation: AI budget, navmesh bake
 * duration, map build stats, streak system cost, damage-report timestamps. Those are the
 * only callers, which is why a single installed clock is proportionate here rather than
 * threading a `Clock` through six constructors.
 *
 * Reading before installation throws rather than falling back. A silent fallback is how a
 * headless run ends up quietly measuring the wrong thing for an hour.
 */

export interface Clock {
  /**
   * Milliseconds since an arbitrary fixed origin. Monotonic: never goes backwards, never
   * adjusts for wall-clock changes. Only differences between two readings are meaningful.
   */
  nowMs(): number;
}

let installed: Clock | null = null;

/** Install the runtime's clock. Called once, at boot, by the client and by the server. */
export function installClock(clock: Clock): void {
  installed = clock;
}

/** True once a runtime has installed a clock. */
export function clockInstalled(): boolean {
  return installed !== null;
}

/** Monotonic milliseconds. Throws if no runtime installed a clock. */
export function nowMs(): number {
  if (installed === null) {
    throw new Error(
      'Clock not installed. Call installClock() from the client or server entry point before running any simulation.',
    );
  }
  return installed.nowMs();
}
