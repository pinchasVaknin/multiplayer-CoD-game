import { beforeEach, describe, expect, it } from 'vitest';
import { installClock } from './Clock';
import { timed } from './Decorators';
import { installLogSink, type LogLevel } from './Log';

/**
 * The transform seam, proved in the runner (M14, Phase B): a legacy method decorator written
 * with `@` in a `.ts` file is lowered by the same oxc option the two builds use, and the
 * wrapper actually runs — the call is timed on the installed clock and reported once.
 *
 * The toy method is `double`, not `step`: `check:decorators` refuses a decorated `step` anywhere
 * in `src/`, tests included, and a test is not the place to open an exemption in that rule.
 */

let fakeNow = 0;
const lines: Array<{ level: LogLevel; tag: string; message: string }> = [];

class Worker {
  factor = 2;

  @timed('worker.double')
  double(n: number): number {
    fakeNow += 21;
    return n * this.factor;
  }

  @timed('worker.fail')
  fail(): never {
    fakeNow += 3;
    throw new Error('boom');
  }
}

beforeEach(() => {
  fakeNow = 0;
  lines.length = 0;
  installClock({ nowMs: () => fakeNow });
  installLogSink({ log: (level, tag, message) => lines.push({ level, tag, message }) });
});

describe('@timed', () => {
  it('runs the wrapper: the value passes through, `this` is preserved, one line is logged', () => {
    const w = new Worker();
    expect(w.double(21)).toBe(42);
    expect(lines).toEqual([{ level: 'info', tag: 'timed', message: 'worker.double 21.00ms' }]);
  });

  it('logs on every call, with that call\'s own elapsed time', () => {
    const w = new Worker();
    w.double(1);
    w.double(2);
    expect(lines.map((l) => l.message)).toEqual(['worker.double 21.00ms', 'worker.double 21.00ms']);
  });

  it('an exception propagates and is still accounted for', () => {
    const w = new Worker();
    expect(() => w.fail()).toThrow('boom');
    expect(lines).toEqual([{ level: 'info', tag: 'timed', message: 'worker.fail 3.00ms' }]);
  });

  it('decorates the prototype, not the instance', () => {
    expect(Object.prototype.hasOwnProperty.call(Worker.prototype, 'double')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(new Worker(), 'double')).toBe(false);
  });
});
