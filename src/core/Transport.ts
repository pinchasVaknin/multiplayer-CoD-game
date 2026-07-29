import { copyCommand, type InputCommand, type MutableInputCommand } from './InputCommand';

/**
 * The netcode boundary (brief S2).
 *
 * Commands leave the client through a transport and arrive at the simulation through
 * the same transport. Today the only implementation is a local pass-through, but the
 * seam is load-bearing: the sim already consumes exactly the bytes a wire would carry,
 * so making it authoritative later is a transport swap, not a rewrite.
 *
 * Networking itself is explicitly out of scope. Do not implement it here.
 */
export interface INetworkTransport {
  readonly kind: 'local' | 'remote';

  /** Begin accepting commands. Idempotent. */
  open(): void;

  /** Stop accepting commands and drop anything queued. Idempotent. */
  close(): void;

  readonly isOpen: boolean;

  /**
   * Hand a command to the transport. The caller's object is copied, never retained:
   * `InputCommand` instances come from a reused ring and would be overwritten.
   */
  submit(cmd: InputCommand): void;

  /**
   * Move every command that is ready to simulate into `out`, up to `max`.
   * Returns the number written. `out` is caller-owned and reused; entries beyond the
   * returned count are stale.
   */
  drain(out: InputCommand[], max: number): number;

  /** Commands accepted but not yet drained. */
  readonly pending: number;

  /** Round-trip estimate in ms. Zero for the local transport. */
  readonly rttMs: number;
}

/**
 * Single-player transport. Commands submitted on a tick are available to drain on the
 * same tick — zero latency, zero loss, zero reordering.
 *
 * It is still a real queue rather than a direct function call, because that is the
 * property that keeps the sim honest about only seeing command data.
 */
export class LocalBotTransport implements INetworkTransport {
  readonly kind = 'local' as const;
  readonly rttMs = 0;

  private readonly queue: MutableInputCommand[] = [];
  private readonly capacity: number;
  private head = 0;
  private tail = 0;
  private count = 0;
  private open_ = false;
  private overflowWarned = false;

  constructor(capacity = 64) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      this.queue.push({
        seq: 0,
        tickIndex: 0,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        pitch: 0,
        buttons: 0,
        sampledAtMs: 0,
      });
    }
  }

  open(): void {
    this.open_ = true;
  }

  close(): void {
    this.open_ = false;
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  get pending(): number {
    return this.count;
  }

  submit(cmd: InputCommand): void {
    if (!this.open_) return;
    if (this.count === this.capacity) {
      // The consumer is not draining. Drop the oldest so input stays fresh rather
      // than replaying a stale backlog, and say so once.
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        console.warn('[LocalBotTransport] queue overflow; dropping oldest commands.');
      }
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
    const slot = this.queue[this.tail];
    if (slot === undefined) throw new Error('LocalBotTransport queue corrupted');
    copyCommand(cmd, slot);
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
  }

  drain(out: InputCommand[], max: number): number {
    let written = 0;
    while (this.count > 0 && written < max) {
      const slot = this.queue[this.head];
      if (slot === undefined) throw new Error('LocalBotTransport queue corrupted');
      out[written] = slot;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
      written++;
    }
    return written;
  }
}
