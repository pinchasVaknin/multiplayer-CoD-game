import type { Clock } from '../shared/core/Clock';

/**
 * Node's implementation of the shared clock (M9, S3).
 *
 * `process.hrtime.bigint()` rather than `performance.now()`, and not only because S3 forbids
 * naming the browser API on the server. `hrtime` is the monotonic high-resolution source
 * Node actually guarantees: nanosecond resolution, unaffected by wall-clock adjustment, and
 * with no relationship to `Date.now()` — which is exactly the contract `Clock` states.
 *
 * The nanosecond value is converted to fractional milliseconds so both runtimes report the
 * same unit. The division happens in `Number` space after subtracting a fixed origin, so
 * the value stays well inside the exactly-representable integer range for the life of a
 * process: at 1e6 ms per 1e9 ns, a run would need to last about 285 years to lose precision.
 */
const ORIGIN_NS = process.hrtime.bigint();

export const nodeClock: Clock = {
  nowMs(): number {
    return Number(process.hrtime.bigint() - ORIGIN_NS) / 1e6;
  },
};
