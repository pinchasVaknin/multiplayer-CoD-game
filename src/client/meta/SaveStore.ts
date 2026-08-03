/**
 * Versioned localStorage wrapper with a migration hook.
 *
 * M1 stores settings only. M6 fills this out with progression, loadouts, challenges
 * and prestige, which is exactly why the version/migration seam exists now: the
 * first schema break must not cost anyone their unlocks.
 *
 * If storage is unavailable (private browsing, blocked cookies, quota) the store
 * silently degrades to in-memory. The game must not break because a save failed.
 */

export interface Versioned {
  version: number;
}

/**
 * Convert persisted data from an older schema. Return `null` to reject the payload
 * and fall back to defaults. Called once, at construction, before any read.
 */
export type Migrator<T extends Versioned> = (raw: unknown, fromVersion: number) => T | null;

export class SaveStore<T extends Versioned> {
  /**
   * How many times this store has actually written to storage.
   *
   * M6's acceptance criterion 8 asks for the write frequency across a full match, and the
   * only honest way to answer is to count the writes at the point they happen rather than
   * to count the calls that might have caused one. Coalesced bursts are one write.
   */
  writes = 0;
  /** `performance.now()` of the last write, for the same read-out. */
  lastWriteMs = 0;

  private data: T;
  private storage: Storage | null;
  private dirty = false;
  private flushHandle = 0;

  constructor(
    private readonly key: string,
    private readonly version: number,
    private readonly defaults: T,
    private readonly migrate: Migrator<T>,
  ) {
    this.storage = probeStorage();
    this.data = this.load();
  }

  /** The live document. Mutate through `patch`, not directly. */
  get value(): Readonly<T> {
    return this.data;
  }

  /** True when persistence is actually happening. */
  get isPersistent(): boolean {
    return this.storage !== null;
  }

  patch(changes: Partial<T>): void {
    let changed = false;
    for (const k of Object.keys(changes) as Array<keyof T>) {
      const next = changes[k];
      if (next === undefined) continue;
      if (this.data[k] !== next) {
        this.data[k] = next;
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  /**
   * Mark the document changed after mutating it in place.
   *
   * `patch` compares by identity, which is right for the flat settings record M1 shipped
   * and useless for M6's save, whose interesting state lives inside nested objects and
   * arrays that are edited rather than replaced. `touch` is the explicit "I changed
   * something, coalesce a write" that a nested edit needs, and it is the *only* way M6
   * writes — so "never every frame" is a property of the call sites, all of which are
   * events.
   */
  touch(): void {
    this.scheduleFlush();
  }

  /** Force a write now, e.g. on pagehide. */
  flush(): void {
    if (this.flushHandle !== 0) {
      clearTimeout(this.flushHandle);
      this.flushHandle = 0;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const store = this.storage;
    if (store === null) return;
    try {
      store.setItem(this.key, JSON.stringify(this.data));
      this.writes++;
      this.lastWriteMs = performance.now();
    } catch (err) {
      console.warn(`[SaveStore:${this.key}] write failed; continuing in memory.`, err);
      this.storage = null;
    }
  }

  /** Replace the whole document, e.g. an imported JSON blob from the save inspector. */
  replace(next: T): void {
    this.data = next;
    this.data.version = this.version;
    this.scheduleFlush();
  }

  /** The raw string currently in storage, for the inspector. Null when not persisted. */
  readRaw(): string | null {
    const store = this.storage;
    if (store === null) return null;
    try {
      return store.getItem(this.key);
    } catch {
      return null;
    }
  }

  reset(): void {
    this.data = structuredClone(this.defaults);
    this.data.version = this.version;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushHandle !== 0) return;
    // Coalesce bursts (a slider drag is dozens of patches per second).
    this.flushHandle = window.setTimeout(() => {
      this.flushHandle = 0;
      this.flush();
    }, 250);
  }

  private load(): T {
    const fresh = (): T => {
      const d = structuredClone(this.defaults);
      d.version = this.version;
      return d;
    };

    const store = this.storage;
    if (store === null) return fresh();

    let raw: string | null = null;
    try {
      raw = store.getItem(this.key);
    } catch (err) {
      console.warn(`[SaveStore:${this.key}] read failed; using defaults.`, err);
      return fresh();
    }
    if (raw === null) return fresh();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[SaveStore:${this.key}] corrupt JSON; resetting to defaults.`);
      return fresh();
    }

    if (typeof parsed !== 'object' || parsed === null) return fresh();
    const found = parsed as Partial<Versioned>;
    const foundVersion = typeof found.version === 'number' ? found.version : 0;

    if (foundVersion === this.version) {
      // Union with defaults so a field added since the save was written exists.
      return { ...structuredClone(this.defaults), ...(parsed as T), version: this.version };
    }

    const migrated = this.migrate(parsed, foundVersion);
    if (migrated === null) {
      console.warn(
        `[SaveStore:${this.key}] no migration path from v${foundVersion} to v${this.version}; resetting.`,
      );
      return fresh();
    }
    migrated.version = this.version;
    this.dirty = true;
    this.scheduleFlush();
    return migrated;
  }
}

function probeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__operator_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
