import { copyCommand, type InputCommand, type MutableInputCommand } from '../core/InputCommand';
import { logger } from '../core/Log';

const log = logger('LocalBotTransport');

/**
 * The netcode seam, after contact with a real socket (M10, S5.1).
 *
 * ## What was here before, and why it went
 *
 * M1 shipped `INetworkTransport`: `submit(cmd)` / `drain(out, max)` / `pending` / `rttMs`,
 * with one pass-through implementation. S5.1 asked M10 to *"report whether it holds, and if
 * it does not, propose the real interface"*. It does not hold, for four reasons:
 *
 * 1. **It is one-directional.** It carries `InputCommand` client-to-sim and has nowhere to
 *    put a snapshot, an ack, a handshake or an event.
 * 2. **It sits on the wrong side of prediction.** `drain()` returns "commands ready to
 *    simulate", which is a queue the local player would have to *wait in*. S4.11 makes
 *    prediction mandatory precisely so the local player never waits, so the shape encodes
 *    the round trip the milestone exists to remove.
 * 3. **It has no connection state.** No connecting, no closed, no error, no protocol
 *    version, no entity assignment, no close reason. All of those are S6.1 requirements.
 * 4. **It moves object references, not bytes.** `drain` even hands out live ring slots.
 *    Correct for a pass-through; meaningless over a wire.
 *
 * What it got *right* is worth keeping and is the reason this milestone was tractable: it
 * forced the simulation to only ever see command data. That is why a bot, the headless
 * harness and a remote human all feed one pipeline. **The interface goes; the discipline
 * stays.**
 *
 * ## What replaced it
 *
 * `INetLink` below — bidirectional, byte-oriented and connection-stateful. The queueing job
 * did not disappear; it moved to `server/net/InputBuffer.ts`, which is where it always
 * belonged, because only the authority has a reason to buffer commands and reorder them by
 * `seq` (S6.2).
 *
 * `LocalBotTransport` survives unchanged under a name that describes what it always was.
 * Single-player still runs through it, and S HARD RULE 8 says the browser build must not
 * regress — so the local path is exactly the code that shipped at M8.
 */

/** Connection state of a link. */
export type LinkState = 'idle' | 'connecting' | 'open' | 'closed';

/**
 * A bidirectional byte channel to one peer.
 *
 * Deliberately dumb: it knows about bytes, connection state and how many of each have gone
 * by. It knows nothing about commands, snapshots, ticks or the protocol — those live in
 * `Messages.ts`, which both sides compile against. Anything a WebSocket cannot do is not on
 * this interface.
 */
export interface INetLink {
  readonly state: LinkState;

  /**
   * Queue a frame. Fire and forget.
   *
   * The implementation copies before returning: callers hand in a view over a reused encode
   * buffer. Sending on a link that is not open is a silent no-op rather than an error,
   * because every caller would otherwise have to guard a race it cannot win — the socket can
   * close between the check and the call.
   */
  send(bytes: Uint8Array): void;

  /**
   * Deliver every frame received since the last call.
   *
   * Pull, not push. The simulation decides when it is ready to consume input, and a callback
   * firing in the middle of a tick would be re-entrancy into the sim from an I/O event — the
   * exact hazard the fixed timestep exists to prevent.
   *
   * The handler's view is valid for the duration of the call only.
   */
  poll(handler: (bytes: Uint8Array) => void): void;

  /** Close, with a reason the peer receives where the transport allows it. */
  close(reason: string): void;

  /**
   * Monotonic ms at which the last frame arrived.
   *
   * On the interface rather than on the implementation because the *timeout* is a protocol
   * decision, not a transport one — S6.1 requires a timeout for the unclean disconnect, and
   * the thing that knows what a reasonable silence is is the session, not the socket.
   */
  readonly lastRecvMs: number;

  /** Who the peer is, for logs and the per-IP cap. Never shown to another client. */
  readonly remoteAddress: string;

  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly framesIn: number;
  readonly framesOut: number;
}

/**
 * A queue of commands waiting to be simulated.
 *
 * This is what `INetworkTransport` actually was. Single-player uses it as a pass-through so
 * the sim only ever sees command data (S4.2); nothing about it is networked and nothing about
 * it ever was.
 */
export interface ICommandQueue {
  readonly kind: 'local' | 'remote';
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  submit(cmd: InputCommand): void;
  drain(out: InputCommand[], max: number): number;
  readonly pending: number;
  readonly rttMs: number;
}

/**
 * Single-player queue. Commands submitted on a tick are available to drain on the same tick —
 * zero latency, zero loss, zero reordering.
 *
 * It is still a real queue rather than a direct function call, because that is the property
 * that keeps the sim honest about only seeing command data.
 */
export class LocalBotTransport implements ICommandQueue {
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
        log.warn('queue overflow; dropping oldest commands.');
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
