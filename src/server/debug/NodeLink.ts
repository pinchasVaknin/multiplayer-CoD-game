import { WebSocket } from 'ws';
import { nowMs } from '../../shared/core/Clock';
import { NetSim, NET_PERFECT, type NetConditions } from '../../shared/net/NetSim';
import type { INetLink, LinkState } from '../../shared/net/Transport';

/**
 * An `INetLink` over a Node WebSocket client (M10, S7).
 *
 * The Node-side twin of the browser's link. Its whole reason to exist is S7's last bullet:
 * *"Extend the M9 headless harness to run headless clients against the deployed server, so a
 * networked match can be left running unattended."*
 *
 * Because `NetClient` lives in `shared/` and takes an `INetLink`, a headless client running
 * behind this object executes **the same prediction, reconciliation and interpolation code**
 * a browser does. That is the property that makes an unattended soak worth running: it is not
 * testing a simplified stand-in for the client, it is testing the client.
 *
 * The condition simulator is applied here rather than inside `NetClient`, on both the inbound
 * and outbound sides, so a headless client can be given a 150 ms link on top of whatever the
 * real one is (S7: *"layer on top of the real RTT"*).
 */
export class NodeLink implements INetLink {
  bytesIn = 0;
  bytesOut = 0;
  framesIn = 0;
  framesOut = 0;
  lastRecvMs = 0;
  readonly remoteAddress: string;

  /** Artificial conditions on each direction. Assignable live (S7). */
  readonly inbound: NetSim;
  readonly outbound: NetSim;

  private socket: WebSocket | null = null;
  private state_: LinkState = 'idle';
  private readonly queue: Uint8Array[] = [];
  private closeReason = '';

  constructor(
    private readonly url: string,
    conditions: NetConditions = NET_PERFECT,
    seed = 0x51e5,
  ) {
    this.remoteAddress = url;
    // Separate seeds per direction, or a symmetric loss pattern drops the command and the
    // snapshot that would have corrected it on the same tick — which is not what a real
    // network does and would make loss look worse than it is.
    this.inbound = new NetSim(conditions, seed);
    this.outbound = new NetSim(conditions, seed ^ 0x9e37);
  }

  /**
   * Open the socket. Resolves when connected, rejects on failure.
   *
   * Callable a second time on a link that has closed (playtest round 4, F8): a reconnect is a
   * new socket to the same address for the same client, and the byte counters are deliberately
   * *not* reset, so a run that drops and returns still reports the traffic it actually used.
   * The close reason is, because a stale one would describe the previous socket's death for the
   * whole life of the new one.
   */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state_ = 'connecting';
      this.closeReason = '';
      this.queue.length = 0;
      const socket = new WebSocket(this.url, { maxPayload: 1 << 20 });
      socket.binaryType = 'nodebuffer';
      this.socket = socket;

      const onError = (err: Error): void => {
        this.state_ = 'closed';
        this.closeReason = err.message;
        reject(err);
      };

      socket.once('error', onError);
      socket.once('open', () => {
        socket.off('error', onError);
        socket.on('error', (err: Error) => {
          if (!this.current(socket)) return;
          this.state_ = 'closed';
          this.closeReason = err.message;
        });
        this.state_ = 'open';
        this.lastRecvMs = nowMs();
        resolve();
      });

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (!this.current(socket)) return;
        const bytes = toBytes(data);
        if (bytes === null) return;
        this.bytesIn += bytes.length;
        this.framesIn++;
        this.lastRecvMs = nowMs();
        // Copied before the simulator holds it: `ws` reuses receive buffers.
        if (this.inbound.idle) this.queue.push(bytes.slice());
        else this.inbound.send(bytes);
      });

      socket.on('close', (_code: number, reason: Buffer) => {
        if (!this.current(socket)) return;
        this.state_ = 'closed';
        if (this.closeReason === '') this.closeReason = reason.toString() || 'closed';
      });
    });
  }

  get state(): LinkState {
    return this.state_;
  }

  get reason(): string {
    return this.closeReason;
  }

  send(bytes: Uint8Array): void {
    if (this.state_ !== 'open') return;
    this.bytesOut += bytes.length;
    this.framesOut++;
    if (this.outbound.idle) this.write(bytes);
    else this.outbound.send(bytes);
  }

  poll(handler: (bytes: Uint8Array) => void): void {
    // Release anything the simulators are holding, in both directions, before delivering.
    if (!this.outbound.idle) this.outbound.pump((bytes) => this.write(bytes));
    if (!this.inbound.idle) this.inbound.pump((bytes) => this.queue.push(bytes.slice()));

    if (this.queue.length === 0) return;
    for (const frame of this.queue) handler(frame);
    this.queue.length = 0;
  }

  close(reason: string): void {
    if (this.state_ === 'closed') return;
    this.state_ = 'closed';
    this.closeReason = reason;
    this.queue.length = 0;
    try {
      this.socket?.close(1000, reason.slice(0, 100));
    } catch {
      // Already gone.
    }
  }

  /**
   * Kill the socket without a close frame — the "pulled the network cable" case (S8.11).
   *
   * S8.11 requires both disconnect kinds to be tested, and they are genuinely different:
   * a clean close lets the server free the seat immediately, while this one leaves the
   * server waiting on its own timeout with no notification at all.
   */
  terminate(): void {
    this.state_ = 'closed';
    this.closeReason = 'terminated';
    this.queue.length = 0;
    try {
      this.socket?.terminate();
    } catch {
      // Already gone.
    }
  }

  /**
   * Whether an event belongs to the socket this link is currently using (round 4, F8).
   *
   * `terminate()` returns before `ws` has emitted the socket's `close`, so on a reconnect the
   * previous socket's close arrives *after* the new one has opened — and without this it would
   * put a freshly connected link straight back to `'closed'` with the old reason on it. The
   * same argument covers a late `message` from a socket whose bytes belong to a session that is
   * over. One identity test rather than a flag per handler.
   */
  private current(socket: WebSocket): boolean {
    return this.socket === socket;
  }

  private write(bytes: Uint8Array): void {
    try {
      this.socket?.send(bytes);
    } catch {
      this.state_ = 'closed';
    }
  }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    let total = 0;
    for (const part of data) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of data) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
  return null;
}
