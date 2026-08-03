/**
 * Typed publish/subscribe. Systems talk through this, never to each other.
 *
 * Design constraints:
 *  - Zero allocation in `emit`. No array copies, no closures, no iterator objects.
 *  - Safe re-entrancy: unsubscribing (or subscribing) from inside a handler cannot
 *    corrupt the dispatch that is currently running. Removals are tombstoned and
 *    compacted once the outermost dispatch unwinds.
 *  - The payload object handed to `emit` is only guaranteed valid for the duration
 *    of the dispatch. Hot events reuse a single payload instance; a listener that
 *    needs to keep the data must copy it out.
 */

export type EventMap = Record<string, object>;

type Listener<P> = (payload: P) => void;
type Slot = Listener<never> | null;

export class EventBus<M extends EventMap> {
  private readonly slots = new Map<keyof M, Slot[]>();
  private readonly dirty = new Set<keyof M>();
  private depth = 0;

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof M>(type: K, listener: Listener<M[K]>): () => void {
    let list = this.slots.get(type);
    if (list === undefined) {
      list = [];
      this.slots.set(type, list);
    }
    list.push(listener as Listener<never>);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.off(type, listener);
    };
  }

  /** Subscribe for exactly one dispatch. */
  once<K extends keyof M>(type: K, listener: Listener<M[K]>): () => void {
    const wrapper = (payload: M[K]): void => {
      dispose();
      listener(payload);
    };
    const dispose = this.on(type, wrapper);
    return dispose;
  }

  off<K extends keyof M>(type: K, listener: Listener<M[K]>): void {
    const list = this.slots.get(type);
    if (list === undefined) return;
    const target = listener as Listener<never>;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === target) {
        list[i] = null;
        this.dirty.add(type);
        break;
      }
    }
    if (this.depth === 0) this.compact();
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const list = this.slots.get(type);
    if (list === undefined || list.length === 0) return;
    this.depth++;
    // Length is read fresh each iteration: listeners added mid-dispatch are also
    // called, which is what "systems react to what just happened" should mean.
    for (let i = 0; i < list.length; i++) {
      const fn = list[i];
      if (fn === null || fn === undefined) continue;
      (fn as Listener<M[K]>)(payload);
    }
    this.depth--;
    if (this.depth === 0) this.compact();
  }

  /** Number of live listeners for a type. Diagnostics only. */
  listenerCount<K extends keyof M>(type: K): number {
    const list = this.slots.get(type);
    if (list === undefined) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) if (list[i] !== null) n++;
    return n;
  }

  /** Drop every subscription. Used when tearing a match down. */
  clear(): void {
    if (this.depth !== 0) {
      throw new Error('EventBus.clear() called from inside a dispatch');
    }
    this.slots.clear();
    this.dirty.clear();
  }

  private compact(): void {
    if (this.dirty.size === 0) return;
    for (const type of this.dirty) {
      const list = this.slots.get(type);
      if (list === undefined) continue;
      let write = 0;
      for (let read = 0; read < list.length; read++) {
        const fn = list[read];
        if (fn === null || fn === undefined) continue;
        list[write++] = fn;
      }
      list.length = write;
    }
    this.dirty.clear();
  }
}
