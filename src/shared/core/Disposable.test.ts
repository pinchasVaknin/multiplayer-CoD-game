import { describe, expect, it } from 'vitest';
import { Disposable } from './Disposable';
import { EventBus } from './EventBus';

/**
 * The lifetime contract: what `own()` took, `dispose()` releases, in order, once — and the
 * process-wide live count the leak instrument reads returns to where it started.
 */

type Events = { ping: { n: number } };

class Owner extends Disposable {
  hits = 0;
  torn = false;

  constructor(bus: EventBus<Events>) {
    super();
    this.own(bus.on('ping', () => this.hits++));
    this.own(bus.on('ping', () => this.hits++));
  }

  override dispose(): void {
    super.dispose();
    this.torn = true;
  }
}

describe('Disposable', () => {
  it('releases every subscription it owns, and the live count returns to its start', () => {
    const before = EventBus.liveSubscriptions;
    const bus = new EventBus<Events>();
    const owner = new Owner(bus);
    expect(EventBus.liveSubscriptions).toBe(before + 2);
    bus.emit('ping', { n: 1 });
    expect(owner.hits).toBe(2);

    owner.dispose();
    expect(owner.torn).toBe(true);
    expect(EventBus.liveSubscriptions).toBe(before);
    bus.emit('ping', { n: 2 });
    expect(owner.hits).toBe(2);
  });

  it('releases in the order taken, and a second dispose() is a no-op', () => {
    const order: string[] = [];
    class Two extends Disposable {
      constructor() {
        super();
        this.own(() => order.push('a'));
        this.own(
          () => order.push('b'),
          () => order.push('c'),
        );
      }
    }
    const two = new Two();
    two.dispose();
    two.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a subscription taken after dispose() waits for the next dispose()', () => {
    const before = EventBus.liveSubscriptions;
    const bus = new EventBus<Events>();
    class Late extends Disposable {
      late(): void {
        this.own(bus.on('ping', () => {}));
      }
    }
    const l = new Late();
    l.dispose();
    l.late();
    expect(EventBus.liveSubscriptions).toBe(before + 1);
    l.dispose();
    expect(EventBus.liveSubscriptions).toBe(before);
  });
});
