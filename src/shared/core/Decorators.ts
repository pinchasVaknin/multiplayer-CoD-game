import { nowMs } from './Clock';
import { logger } from './Log';

/**
 * Decorators for concerns that were being written out by hand (M14).
 *
 * ## What kind of decorator, and why
 *
 * These are **legacy** (TypeScript `experimentalDecorators`) decorators, with the
 * `(target, key, descriptor)` signature. The standard TC39 form typechecks on TypeScript 7 but
 * does not run here: oxc leaves the `@name` line verbatim in the bundle at every `build.target`
 * tried, and Node 24 rejects the syntax, so the result is a `SyntaxError` in every browser and
 * in `dist-server/`. oxc lowers the legacy form (`oxc.decorator.legacy` in both Vite configs
 * and in `vitest.config.ts`), which is what makes this file possible at all.
 *
 * ## The rules this file is under
 *
 * - **Methods and classes only. Never a field.** With `useDefineForClassFields: true` a field
 *   is [[Define]]d on the instance and shadows whatever a decorator put on the prototype, so a
 *   legacy property decorator silently does nothing. `check:decorators` refuses one.
 * - **Never on the simulation tick.** Nothing reached from `simulate`, `step`, `onTick` or
 *   `tick` in `shared/`, nor `shared/net` encode/decode, `shared/player`, `shared/combat` or
 *   `shared/ai`. A wrapper call per entity per tick is an allocation on a path the contract
 *   froze (S4.7); a concern that lives there stays hand-written.
 * - **A decorator replaces repetition; it never adds behaviour.** Each one here exists because
 *   three or more hand-written sites changed together, and it takes no flag or mode parameter
 *   to serve them.
 */

const log = logger('timed');

/**
 * A method decorator that measures one call with the installed clock and reports it.
 *
 * `nowMs()` from `shared/core/Clock`, never `performance.now()`: the two runtimes must measure
 * through the same abstraction or the numbers are not comparable, and the boundary check
 * refuses the native in `shared/` and `server/` anyway. The line is logged after the call
 * returns or throws, so a method that fails is still accounted for, and the return value and
 * the exception pass through untouched.
 *
 * Synchronous methods only. An `async` method returns its promise immediately and this would
 * time the call, not the work; nothing in the tree needed the other shape.
 */
export function timed(label: string) {
  return function <T extends (...args: never[]) => unknown>(
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): TypedPropertyDescriptor<T> {
    const original = descriptor.value;
    if (typeof original !== 'function') {
      throw new Error(`@timed('${label}') decorates a method; nothing else has a call to time.`);
    }
    descriptor.value = function (this: unknown, ...args: never[]): unknown {
      const t0 = nowMs();
      try {
        return original.apply(this, args);
      } finally {
        log.info(`${label} ${(nowMs() - t0).toFixed(2)}ms`);
      }
    } as T;
    return descriptor;
  };
}
