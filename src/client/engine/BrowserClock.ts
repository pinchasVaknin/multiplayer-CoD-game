import type { Clock } from '../../shared/core/Clock';

/**
 * The browser's implementation of the shared clock (M9, S3).
 *
 * `performance.now()` is already monotonic and already relative to an arbitrary origin,
 * so this is the whole adapter. It lives in `client/` because `shared/` may not name the
 * API — see `shared/core/Clock.ts` for why the indirection exists at all.
 */
export const browserClock: Clock = {
  nowMs(): number {
    return performance.now();
  },
};
