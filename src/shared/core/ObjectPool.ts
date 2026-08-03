import { logger } from './Log';
/**
 * Generic free-list pool.
 *
 * Used from M1 onward for anything recurring: tracers, decals, particles, damage
 * numbers, audio nodes. The pool never shrinks; `acquire` past the high-water mark
 * grows it and warns once so the initial size can be tuned rather than silently
 * allocating during play.
 */
export class ObjectPool<T> {
  private readonly free: T[] = [];
  private readonly factory: () => T;
  private readonly reset: (item: T) => void;
  private created = 0;
  private liveCount = 0;
  private highWater = 0;
  private grewAt = -1;

  constructor(factory: () => T, reset: (item: T) => void, initialSize: number, private readonly label = 'pool') {
    this.factory = factory;
    this.reset = reset;
    for (let i = 0; i < initialSize; i++) {
      this.free.push(factory());
      this.created++;
    }
    this.highWater = initialSize;
  }

  acquire(): T {
    const item = this.free.pop();
    this.liveCount++;
    if (this.liveCount > this.highWater) this.highWater = this.liveCount;
    if (item !== undefined) return item;

    // Exhausted. Grow, but complain once so the initial size gets fixed.
    if (this.grewAt < 0) {
      this.grewAt = this.created;
      logger(`ObjectPool:${this.label}`).warn(
        `exhausted at ${this.created} items and grew. ` +
          `Raise its initial size to avoid mid-frame allocation.`,
      );
    }
    this.created++;
    return this.factory();
  }

  release(item: T): void {
    this.reset(item);
    this.free.push(item);
    this.liveCount--;
  }

  /** Items currently checked out. */
  get live(): number {
    return this.liveCount;
  }

  /** Total objects ever constructed by this pool. */
  get size(): number {
    return this.created;
  }

  /** Largest simultaneous checkout seen. Tune `initialSize` to this. */
  get peak(): number {
    return this.highWater;
  }
}
