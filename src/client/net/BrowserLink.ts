import { nowMs } from '../../shared/core/Clock';
import { logger } from '../../shared/core/Log';
import { NetSim, NET_PERFECT, type NetConditions } from '../../shared/net/NetSim';
import type { INetLink, LinkState } from '../../shared/net/Transport';

const log = logger('link');

/**
 * `INetLink` over a browser WebSocket (M10, S4.9).
 *
 * The browser twin of `server/debug/NodeLink.ts`. Everything above it — the handshake,
 * prediction, reconciliation, interpolation — lives in `shared/net/` and does not know which
 * of the two it is talking through. That is what lets the headless harness test the client
 * netcode rather than a stand-in for it.
 *
 * ## `wss://` is not optional from an HTTPS page
 *
 * S4.9 is blunt about this and it is worth repeating where the socket is actually opened: a
 * browser refuses a plaintext `ws://` connection from a secure page, with a console error and
 * no connection. `resolveServerUrl` below therefore *upgrades* the scheme to match the page
 * rather than letting it fail at deploy time — S4.9 calls discovering this at deployment "an
 * avoidable afternoon", and this is how it is avoided.
 */

export class BrowserLink implements INetLink {
  bytesIn = 0;
  bytesOut = 0;
  framesIn = 0;
  framesOut = 0;
  lastRecvMs = 0;
  readonly remoteAddress: string;

  /**
   * Artificial conditions layered on top of the real link (S7).
   *
   * Public and assignable so the debug panel can change them live, mid-match, without
   * reconnecting — a toggle that tore the connection down would reset every measurement it
   * exists to take.
   */
  readonly inbound: NetSim;
  readonly outbound: NetSim;

  private socket: WebSocket | null = null;
  private state_: LinkState = 'idle';
  private readonly queue: Uint8Array[] = [];
  private closeReason = '';

  constructor(
    private readonly url: string,
    conditions: NetConditions = NET_PERFECT,
  ) {
    this.remoteAddress = url;
    // Independent seeds per direction. A shared stream would drop the command and the
    // snapshot that would have corrected it in the same instant, which is not how a real
    // network behaves and would make loss look worse than it is.
    this.inbound = new NetSim(conditions, 0x51e5);
    this.outbound = new NetSim(conditions, 0xc0de);
  }

  /** Open the socket. Resolves on connect, rejects on failure. */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state_ = 'connecting';
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        this.state_ = 'closed';
        this.closeReason = errText(err);
        reject(new Error(this.closeReason));
        return;
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      const onOpenError = (): void => {
        this.state_ = 'closed';
        // A browser deliberately withholds the reason a WebSocket handshake failed — it is a
        // cross-origin information leak — so there is genuinely nothing more specific to say
        // here than that it did not connect. Saying so plainly beats inventing a cause.
        this.closeReason = 'could not reach the server';
        reject(new Error(this.closeReason));
      };

      socket.addEventListener('error', onOpenError, { once: true });

      socket.addEventListener(
        'open',
        () => {
          socket.removeEventListener('error', onOpenError);
          socket.addEventListener('error', () => {
            log.warn('socket error');
            this.state_ = 'closed';
          });
          this.state_ = 'open';
          this.lastRecvMs = nowMs();
          resolve();
        },
        { once: true },
      );

      socket.addEventListener('message', (ev: MessageEvent) => {
        const data: unknown = ev.data;
        if (!(data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(data);
        this.bytesIn += bytes.length;
        this.framesIn++;
        this.lastRecvMs = nowMs();
        // The buffer is ours already (the browser allocated it per message), so no copy is
        // needed on the direct path. The simulator copies internally when it holds one.
        if (this.inbound.idle) this.queue.push(bytes);
        else this.inbound.send(bytes);
      });

      socket.addEventListener('close', (ev: CloseEvent) => {
        this.state_ = 'closed';
        if (this.closeReason === '') this.closeReason = ev.reason || 'connection closed';
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
    // Release whatever the simulators are holding before delivering anything.
    if (!this.outbound.idle) this.outbound.pump((b) => this.write(b));
    if (!this.inbound.idle) this.inbound.pump((b) => this.queue.push(b.slice()));

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

  private write(bytes: Uint8Array): void {
    try {
      // `send` wants an ArrayBuffer-backed view; a subarray of a larger buffer would send the
      // whole backing store. `slice` on a typed array copies, which is what is wanted here.
      this.socket?.send(bytes.slice().buffer);
    } catch (err) {
      this.state_ = 'closed';
      log.warn(`send failed: ${errText(err)}`);
    }
  }
}

/**
 * Turn a configured address into a URL this page is allowed to open (S4.9, S6.6).
 *
 * The address is **configuration, never hardcoded** (S4.9): it comes from `?server=` on the
 * URL, then from the Vite-injected `VITE_SERVER_URL`, then from the page's own origin. The
 * last of those is what makes the common deployment — client and server behind the same
 * reverse proxy — need no configuration at all.
 *
 * The scheme is forced to match the page. A secure page may only open `wss://`, and a plain
 * one opening `wss://` to a server with no certificate fails just as hard in the other
 * direction. Neither failure says anything useful in the console, so neither is left possible.
 */
export function resolveServerUrl(explicit: string | null): string {
  const secure = window.location.protocol === 'https:';
  const raw = (explicit ?? '').trim();

  if (raw === '') {
    // Same origin as the page. `/ws` is the path the documented reverse-proxy config maps to
    // the game server — see README.
    return `${secure ? 'wss' : 'ws'}://${window.location.host}/ws`;
  }

  // A bare host, or host:port.
  if (!raw.includes('://')) {
    return `${secure ? 'wss' : 'ws'}://${raw}`;
  }

  const upgraded = raw.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  if (secure && upgraded.startsWith('ws://')) {
    // The page is https and this is a plaintext socket: the browser will refuse it outright.
    // Upgrading is the only thing that can possibly work, so do it and say so.
    log.warn(`upgrading ${upgraded} to wss:// — a secure page cannot open a plaintext socket.`);
    return `wss://${upgraded.slice('ws://'.length)}`;
  }
  return upgraded;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
