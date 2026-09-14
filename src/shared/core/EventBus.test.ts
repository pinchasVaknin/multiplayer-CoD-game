import { describe, expect, it } from 'vitest';
import { EventBus } from './EventBus';

/**
 * Characterisation of the three promises the bus makes: dispatch order, safe re-entrancy, and
 * the process-wide live count that `npm run leak` watches returning to where it started.
 */

type Events = {
  ping: { n: number };
  pong: { n: number };
};

describe('EventBus', () => {
  it('dispatches to listeners in subscription order with the same payload', () => {
    const bus = new EventBus<Events>();
    const order: string[] = [];
    bus.on('ping', (p) => order.push(`a${p.n}`));
    bus.on('ping', (p) => order.push(`b${p.n}`));
    bus.on('pong', (p) => order.push(`pong${p.n}`));
    bus.emit('ping', { n: 1 });
    expect(order).toEqual(['a1', 'b1']);
    bus.clear();
  });

  it('on() returns an unsubscriber; the live count goes back to zero', () => {
    const before = EventBus.liveSubscriptions;
    const bus = new EventBus<Events>();
    const off = bus.on('ping', () => {});
    expect(EventBus.liveSubscriptions).toBe(before + 1);
    expect(bus.subscriptionCount).toBe(1);
    off();
    expect(EventBus.liveSubscriptions).toBe(before);
    expect(bus.subscriptionCount).toBe(0);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('calling the unsubscriber twice is a no-op, not a double decrement', () => {
    const before = EventBus.liveSubscriptions;
    const bus = new EventBus<Events>();
    const off = bus.on('ping', () => {});
    off();
    off();
    expect(EventBus.liveSubscriptions).toBe(before);
  });

  it('once() fires for exactly one dispatch and counts itself out', () => {
    const before = EventBus.liveSubscriptions;
    const bus = new EventBus<Events>();
    let calls = 0;
    bus.once('ping', () => calls++);
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(calls).toBe(1);
    expect(EventBus.liveSubscriptions).toBe(before);
  });

  it('unsubscribing from inside a handler does not skip the next listener', () => {
    const bus = new EventBus<Events>();
    const seen: string[] = [];
    const offA = bus.on('ping', () => {
      seen.push('a');
      offA();
    });
    bus.on('ping', () => seen.push('b'));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(seen).toEqual(['a', 'b', 'b']);
    expect(bus.listenerCount('ping')).toBe(1);
    bus.clear();
  });

  it('a listener added mid-dispatch is called in that same dispatch', () => {
    const bus = new EventBus<Events>();
    const seen: string[] = [];
    bus.on('ping', () => {
      seen.push('a');
      if (seen.length === 1) bus.on('ping', () => seen.push('late'));
    });
    bus.emit('ping', { n: 1 });
    expect(seen).toEqual(['a', 'late']);
    bus.clear();
  });

  it('a nested emit from a handler completes before the outer dispatch compacts', () => {
    const bus = new EventBus<Events>();
    const seen: string[] = [];
    const offPing = bus.on('ping', () => {
      seen.push('ping');
      offPing();
      bus.emit('pong', { n: 0 });
    });
    bus.on('pong', () => seen.push('pong'));
    bus.emit('ping', { n: 1 });
    expect(seen).toEqual(['ping', 'pong']);
    expect(bus.listenerCount('ping')).toBe(0);
    expect(bus.listenerCount('pong')).toBe(1);
    bus.clear();
  });

  it('clear() drops every subscription and counts them out of the live total', () => {
    const before = EventBus.liveSubscriptions;
    const bus = new EventBus<Events>();
    bus.on('ping', () => {});
    bus.on('ping', () => {});
    bus.on('pong', () => {});
    expect(bus.subscribedTypes).toBe(2);
    expect(bus.subscriptionCount).toBe(3);
    bus.clear();
    expect(bus.subscriptionCount).toBe(0);
    expect(bus.subscribedTypes).toBe(0);
    expect(EventBus.liveSubscriptions).toBe(before);
  });

  it('clear() from inside a dispatch throws', () => {
    const bus = new EventBus<Events>();
    bus.on('ping', () => bus.clear());
    expect(() => bus.emit('ping', { n: 1 })).toThrow(/inside a dispatch/);
  });

  it('emitting a type nobody listens to is a no-op', () => {
    const bus = new EventBus<Events>();
    expect(() => bus.emit('pong', { n: 1 })).not.toThrow();
    expect(bus.listenerCount('pong')).toBe(0);
  });
});
