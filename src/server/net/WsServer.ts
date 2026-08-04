import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { nowMs } from '../../shared/core/Clock';
import { logger } from '../../shared/core/Log';
import { NetSim, NET_PERFECT, type NetConditions } from '../../shared/net/NetSim';
import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_CONNECTIONS_PER_IP,
  MAX_MESSAGES_PER_SEC,
} from '../../shared/net/Protocol';
import type { INetLink, LinkState } from '../../shared/net/Transport';
import { RateLimiter } from './Validation';

const log = logger('net');

/**
 * The WebSocket listener and one link per connection (M10, S4.9 and S6.1).
 *
 * ## Hardening is not a later pass
 *
 * S6.1 says *"Hardening per S4.16 from the first line of transport code, not as a later
 * pass"*, and this file is where that is either true or false. The server is internet-facing
 * and a crash is now a denial-of-service vector rather than a friend's bug report, so every
 * limit is applied **before** the bytes reach a decoder:
 *
 * - `maxPayload` on the `ws` server itself, so an oversized frame is refused by the library
 *   and never allocated by us.
 * - Text frames rejected outright. The protocol is binary; a text frame is either a probe or
 *   a broken client, and either way there is nothing to do with it.
 * - Connections per IP capped, so one host cannot occupy every seat.
 * - Messages per second capped per connection, so a flood costs the flooder a socket.
 * - Nothing from an exception path ever reaches a client. Close codes and short reasons only.
 *
 * ## TLS
 *
 * S4.9 requires `wss://` when the page is served over HTTPS, and S6.6 permits terminating at
 * a reverse proxy. Both are supported and neither is hardcoded: with `TLS_CERT` and `TLS_KEY`
 * set this listens as HTTPS directly; without them it listens as plain HTTP for a proxy or a
 * tunnel to terminate in front of. The deployment doc in `README.md` covers both.
 */

export interface WsServerOptions {
  readonly port: number;
  readonly host: string;
  /** PEM paths. Both or neither; without them the listener is plain HTTP. */
  readonly tlsCertPath?: string | undefined;
  readonly tlsKeyPath?: string | undefined;
  /** Applied to every new connection. The debug endpoint can change it per link later. */
  readonly conditions?: NetConditions | undefined;
  readonly onConnection: (link: WsLink) => void;
}

/**
 * One client connection as an `INetLink`.
 *
 * Received frames are queued and handed over in `poll()` rather than dispatched from the
 * socket's own event. That is the whole reason `INetLink` is pull-shaped: a `message` handler
 * firing mid-tick would be re-entrancy into the simulation from an I/O callback, and the
 * fixed timestep exists precisely so nothing can do that.
 */
export class WsLink implements INetLink {
  bytesIn = 0;
  bytesOut = 0;
  framesIn = 0;
  framesOut = 0;

  /** Monotonic ms of the last frame received. The timeout clock (S6.1). */
  lastRecvMs = 0;

  /** Set when the connection is dropped for abuse, so the reason survives into the log. */
  dropReason = '';

  readonly remoteAddress: string;

  /** Per-link condition simulator, so one client can be given latency and others not (S7). */
  readonly outbound: NetSim;

  private readonly socket: WsSocketLike;
  private readonly queue: Uint8Array[] = [];
  private state_: LinkState = 'open';
  private readonly limiter = new RateLimiter(MAX_MESSAGES_PER_SEC);

  constructor(socket: WsSocketLike, remoteAddress: string, conditions: NetConditions) {
    this.socket = socket;
    this.remoteAddress = remoteAddress;
    this.outbound = new NetSim(conditions);
    this.lastRecvMs = nowMs();

    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (!isBinary) {
        this.drop('text frame');
        return;
      }
      const bytes = toBytes(data);
      if (bytes === null) {
        this.drop('undecodable frame');
        return;
      }
      if (bytes.length > MAX_CLIENT_FRAME_BYTES) {
        this.drop('oversize frame');
        return;
      }
      const now = nowMs();
      if (!this.limiter.allow(now)) {
        this.drop('message flood');
        return;
      }
      this.lastRecvMs = now;
      this.bytesIn += bytes.length;
      this.framesIn++;
      // Copied: `ws` reuses its receive buffers, and this frame is consumed on a later tick.
      this.queue.push(bytes.slice());
    });

    socket.on('close', () => {
      this.state_ = 'closed';
      this.queue.length = 0;
      this.outbound.clear();
    });

    // A socket error is ordinary on the internet — a client's wifi drops, a NAT entry
    // expires. It closes the link and is never allowed to reach the process as an unhandled
    // 'error' event, which in Node would terminate it.
    socket.on('error', (err: Error) => {
      log.warn(`socket error from ${this.remoteAddress}: ${err.message}`);
      this.state_ = 'closed';
    });
  }

  get state(): LinkState {
    return this.state_;
  }

  send(bytes: Uint8Array): void {
    if (this.state_ !== 'open') return;
    this.bytesOut += bytes.length;
    this.framesOut++;
    if (this.outbound.idle) {
      this.write(bytes);
      return;
    }
    // Held by the condition simulator and written when its delay expires. `pumpOutbound`
    // below is what releases them.
    this.outbound.send(bytes);
  }

  /** Release any frames the condition simulator is holding. Called once per tick. */
  pumpOutbound(): void {
    if (this.outbound.idle) return;
    this.outbound.pump((bytes) => this.write(bytes));
  }

  poll(handler: (bytes: Uint8Array) => void): void {
    if (this.queue.length === 0) return;
    for (const frame of this.queue) handler(frame);
    this.queue.length = 0;
  }

  close(reason: string): void {
    if (this.state_ === 'closed') return;
    this.state_ = 'closed';
    this.queue.length = 0;
    this.outbound.clear();
    try {
      // 1000 is a normal closure. The reason is short and carries nothing internal (S4.16).
      this.socket.close(1000, reason.slice(0, 100));
    } catch {
      // Already gone. Nothing to do and nothing worth logging.
    }
  }

  /** Close for cause and record why, for the connection log. */
  drop(reason: string): void {
    if (this.dropReason === '') this.dropReason = reason;
    log.warn(`dropping ${this.remoteAddress}: ${reason}`);
    this.close(reason);
  }

  private write(bytes: Uint8Array): void {
    try {
      this.socket.send(bytes);
    } catch (err) {
      // A send on a socket that closed between the state check and here. Ordinary.
      this.state_ = 'closed';
      log.warn(`send failed to ${this.remoteAddress}: ${errText(err)}`);
    }
  }
}

/**
 * The minimum of a `ws` socket this file uses.
 *
 * Structural rather than importing `ws`'s own `WebSocket` type: it keeps the surface this
 * code depends on to five members, and it documents that surface where a reader will look for
 * it. A real `ws` socket satisfies it without a cast.
 */
export interface WsSocketLike {
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export class WsServer {
  private readonly wss: WebSocketServer;
  private readonly http: HttpServer;
  private readonly perIp = new Map<string, number>();
  readonly secure: boolean;

  constructor(private readonly opts: WsServerOptions) {
    const cert = opts.tlsCertPath;
    const key = opts.tlsKeyPath;
    this.secure = cert !== undefined && key !== undefined && cert !== '' && key !== '';

    this.http = this.secure
      ? (createHttpsServer({
          cert: readFileSync(cert ?? ''),
          key: readFileSync(key ?? ''),
        }) as unknown as HttpServer)
      : createHttpServer();

    // A plain HTTP request to this port gets a flat 426 and nothing else. It is not a web
    // server and saying so in four words is the whole correct response.
    this.http.on('request', (_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('upgrade required\n');
    });

    this.wss = new WebSocketServer({
      server: this.http,
      // The library refuses anything larger before allocating it. This is the first and
      // cheapest of the S4.16 limits and the only one that costs us nothing at all.
      maxPayload: MAX_CLIENT_FRAME_BYTES,
      // No compression: snapshots are already packed binary, and permessage-deflate on
      // small frames costs CPU per client to make them slightly bigger.
      perMessageDeflate: false,
      clientTracking: false,
    });

    this.wss.on('connection', (socket, req) => {
      const ip = normaliseIp(req.socket.remoteAddress ?? 'unknown');
      const open = this.perIp.get(ip) ?? 0;
      if (open >= MAX_CONNECTIONS_PER_IP) {
        log.warn(`refusing ${ip}: ${open} connections already open`);
        try {
          socket.close(1013, 'too many connections');
        } catch {
          // Nothing to clean up.
        }
        return;
      }
      this.perIp.set(ip, open + 1);
      socket.on('close', () => {
        const n = (this.perIp.get(ip) ?? 1) - 1;
        if (n <= 0) this.perIp.delete(ip);
        else this.perIp.set(ip, n);
      });

      const link = new WsLink(socket, ip, this.opts.conditions ?? NET_PERFECT);
      this.opts.onConnection(link);
    });

    this.wss.on('error', (err: Error) => {
      log.error(`listener error: ${err.message}`);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.http.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.http.off('error', onError);
        resolve();
      };
      this.http.once('error', onError);
      this.http.once('listening', onListening);
      this.http.listen(this.opts.port, this.opts.host);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.http.close(() => resolve());
      });
    });
  }
}

/**
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) collapsed to the v4 form.
 *
 * Without this the same host counts twice against the per-IP cap depending on how it
 * connected, which makes the limit unreliable in exactly the case it exists for.
 */
function normaliseIp(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** Whatever `ws` handed us, as bytes, or null if it is not something we can read. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    // `ws` delivers a fragmented message as an array of buffers.
    let total = 0;
    for (const part of data) {
      if (!(part instanceof Uint8Array)) return null;
      total += part.length;
    }
    if (total > MAX_CLIENT_FRAME_BYTES) return null;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of data) {
      if (!(part instanceof Uint8Array)) return null;
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
  return null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
