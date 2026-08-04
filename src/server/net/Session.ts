import { nowMs } from '../../shared/core/Clock';
import type { MutableInputCommand } from '../../shared/core/InputCommand';
import { DT } from '../../shared/core/Loop';
import { logger } from '../../shared/core/Log';
import {
  decodeHeader,
  readCommand,
  writeBye,
  writePong,
  writeReject,
  writeWelcome,
} from '../../shared/net/Messages';
import {
  CLIENT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_SERVER_FRAME_BYTES,
  PROTOCOL_VERSION,
  RejectCode,
} from '../../shared/net/Protocol';
import { ByteReader, ByteWriter } from '../../shared/net/Wire';
import type { INetLink } from '../../shared/net/Transport';
import type { NetPlayer } from '../NetPlayer';
import { Reject, RejectCounters, validateCommand, type RejectReason } from './Validation';

const log = logger('session');

/**
 * The cadence clients ping at, mirrored from `NetClient`.
 *
 * The server subtracts it from the observed gap between pings to recover the delay. A client
 * that pinged at a different rate would produce a wrong estimate rather than no estimate, so
 * the two constants are deliberately named the same thing on both sides.
 */
const PING_INTERVAL_MS = 250;

/**
 * One client's protocol state (M10, S6.1).
 *
 * The lifecycle S6.1 asks for, in order: handshake, **protocol version check**, entity
 * assignment, initial full snapshot, then deltas — plus a clean disconnect and a timeout for
 * the unclean kind.
 *
 * ## Every path out of here is a close, never a throw
 *
 * S4.16 makes this a hard requirement rather than a style preference: *"Malformed input must
 * never crash the server. A crash is now a denial-of-service vector rather than a friend's
 * bug."* So this class has exactly one way to react to anything it does not like — count it,
 * and close the link with a short reason. There is no path from a decoded byte to an
 * exception, because `ByteReader` does not throw and `decodeHeader` returns `bad` rather
 * than raising.
 *
 * The client is told *that* it was refused and never *why* in any detail: a `RejectCode` and
 * a handful of words. Never a stack trace, never a field name, never a version number beyond
 * the one it already needs to know.
 */

export type SessionState = 'handshaking' | 'playing' | 'closed';

export interface SessionEvents {
  /** A validated `Hello`. Return the player seat, or null to refuse with `ServerFull`. */
  readonly onJoin: (session: Session, name: string) => NetPlayer | null;
  readonly onLeave: (session: Session, reason: string) => void;
}

/** Snapshot ids kept per client so a late ack can still be used as a delta baseline. */
export const BASELINE_HISTORY = 32;

export class Session {
  readonly link: INetLink;
  readonly rejects = new RejectCounters();

  state: SessionState = 'handshaking';

  /** The seat this connection owns, once it has joined. */
  player: NetPlayer | null = null;

  displayName = '';

  /** Round-trip estimate, ms. Smoothed; drives the rewind amount and the client's lead. */
  rttMs = 0;
  /** Jitter estimate: mean absolute deviation of the RTT samples, ms. */
  jitterMs = 0;

  /** Last snapshot id this client acknowledged. 0 means "nothing yet, send a full one". */
  ackedSnapshot = 0;
  /** Newest snapshot id sent. */
  lastSnapshotId = 0;

  /** Set by the client's `Hello` name suffix. Opts into the S7 rewind panel feed. */
  wantsRewindDebug = false;

  /** Commands dropped by validation, for the S7 metrics. */
  commandsRejected = 0;
  commandsAccepted = 0;

  private readonly openedMs: number;
  private readonly cmd: MutableInputCommand = blankCommand();
  private readonly reader = new ByteReader(new Uint8Array(0));
  private readonly out = new ByteWriter(MAX_SERVER_FRAME_BYTES);
  private rttSamples = 0;
  private lastPingAtMs = 0;

  constructor(
    link: INetLink,
    private readonly events: SessionEvents,
    private readonly serverTick: () => number,
  ) {
    this.link = link;
    this.openedMs = nowMs();
  }

  get closed(): boolean {
    return this.state === 'closed' || this.link.state === 'closed';
  }

  /**
   * Drain the socket and apply everything on it.
   *
   * Called once per server tick, from the tick loop — never from an I/O callback. That is
   * what `INetLink.poll` being pull-shaped buys: commands land in the input buffer at a
   * defined point in the tick, and nothing can re-enter the simulation partway through it.
   */
  receive(): void {
    if (this.closed) return;
    this.link.poll((bytes) => this.handleFrame(bytes));
  }

  /**
   * Close a connection that has stopped talking (S6.1).
   *
   * Two different deadlines, because they are two different failures: a connection that never
   * finishes its handshake is a probe or a broken client and is not owed ten seconds, while a
   * player mid-match deserves the full timeout before their body is taken away.
   */
  checkTimeout(): void {
    if (this.closed) return;
    const now = nowMs();
    if (this.state === 'handshaking' && now - this.openedMs > HANDSHAKE_TIMEOUT_MS) {
      this.close('handshake timeout');
      return;
    }
    if (now - this.link.lastRecvMs > CLIENT_TIMEOUT_MS) {
      this.close('timeout');
    }
  }

  /** Send a pre-encoded frame. Snapshots and event batches come through here. */
  send(bytes: Uint8Array): void {
    if (this.closed) return;
    this.link.send(bytes);
  }

  close(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.link.state === 'open') {
      this.link.send(writeBye(this.out, true, reason));
      this.link.close(reason);
    }
    this.events.onLeave(this, reason);
  }

  // -- internals -------------------------------------------------------------

  private handleFrame(bytes: Uint8Array): void {
    this.reader.reuse(bytes);
    const msg = decodeHeader(this.reader);

    switch (msg.kind) {
      case 'hello':
        this.handleHello(msg.version, msg.name);
        return;
      case 'commands':
        this.handleCommands(msg.count, msg.snapshotAck);
        return;
      case 'ping':
        this.handlePing(msg.id, msg.clientMs);
        return;
      case 'bye':
        this.close('client left');
        return;
      case 'bad':
        this.refuse(Reject.Malformed, 'malformed frame');
        return;
      default:
        // A server-to-client message arriving *at* the server. Either a confused client or
        // somebody poking the port; both are the same to us.
        this.refuse(Reject.OutOfOrder, 'unexpected message');
    }
  }

  private handleHello(version: number, name: string): void {
    if (this.state !== 'handshaking') {
      this.refuse(Reject.OutOfOrder, 'duplicate hello');
      return;
    }

    // The version check is the very first thing, before a single gameplay byte is decoded.
    // S6.1: "Reject a version mismatch loudly — silent skew produces bugs that look like
    // physics bugs and cost days."
    if (version !== PROTOCOL_VERSION) {
      log.warn(
        `refusing ${this.link.remoteAddress}: protocol ${version}, server speaks ${PROTOCOL_VERSION}`,
      );
      this.link.send(writeReject(this.out, RejectCode.BadVersion));
      this.state = 'closed';
      this.link.close('version mismatch');
      this.events.onLeave(this, 'version mismatch');
      return;
    }

    const clean = sanitiseName(name);
    this.wantsRewindDebug = clean.endsWith('#rw');
    this.displayName = this.wantsRewindDebug ? clean.slice(0, -3) : clean;
    if (this.displayName === '') this.displayName = 'OPERATOR';

    const player = this.events.onJoin(this, this.displayName);
    if (player === null) {
      this.link.send(writeReject(this.out, RejectCode.ServerFull));
      this.state = 'closed';
      this.link.close('server full');
      this.events.onLeave(this, 'server full');
      return;
    }

    this.player = player;
    this.state = 'playing';
    log.info(
      `${this.displayName} (${this.link.remoteAddress}) joined as entity ${player.entityId} on team ${player.team}.`,
    );
  }

  private handleCommands(count: number, snapshotAck: number): void {
    if (this.state !== 'playing') {
      this.refuse(Reject.OutOfOrder, 'commands before hello');
      return;
    }
    const player = this.player;
    if (player === null) return;

    // A client acks the newest snapshot it has decoded. Monotonic in the id's wrapping
    // sense: an older ack arriving late must not walk the baseline backwards.
    if (snapshotAck !== 0 && isNewerSnapshot(snapshotAck, this.ackedSnapshot)) {
      this.ackedSnapshot = snapshotAck;
    }

    const tick = this.serverTick();
    for (let i = 0; i < count; i++) {
      readCommand(this.reader, this.cmd);
      if (this.reader.overran) {
        this.refuse(Reject.Malformed, 'truncated command batch');
        return;
      }
      const verdict = validateCommand(this.cmd, tick);
      if (verdict !== Reject.None) {
        this.rejects.note(verdict);
        this.commandsRejected++;
        // A single bad command is dropped, not fatal: a clamped move axis or a stale tick is
        // ordinary on a real link. Only structural damage to the frame closes the connection.
        continue;
      }
      if (player.input.accept(this.cmd, tick)) this.commandsAccepted++;
    }
  }

  private handlePing(id: number, clientMs: number): void {
    const now = nowMs();

    /**
     * The server's own RTT estimate, from the gap between a client's pings.
     *
     * The server never sees a round trip of its own — the client measures those. What it can
     * see is how long ago it answered this client's previous ping, and since the client pings
     * on a fixed interval, the *excess* over that interval is the round-trip delay.
     *
     * This matters more than it looks: `Rewind` sizes itself from `session.rttMs`, and while
     * this was left at zero the server was compensating for the interpolation delay alone.
     * Lag compensation was running at 100 ms when it should have been running at
     * 100 + RTT/2 — under-rewinding by half a ping on every shot, which is exactly the
     * half-metre miss S4.13 exists to prevent, just smaller.
     */
    if (this.lastPingAtMs > 0) {
      const gap = now - this.lastPingAtMs;
      const excess = gap - PING_INTERVAL_MS;
      // Only positive excess is signal; a ping that arrived early is jitter, not negative
      // latency. Bounded so a paused client resuming does not inject a huge sample.
      if (excess > 0 && excess < 1000) this.noteRtt(excess);
    }
    this.lastPingAtMs = now;

    this.send(writePong(this.out, id, clientMs, now, this.serverTick()));
  }

  /**
   * Note a rejection and decide whether it is fatal.
   *
   * Frame-level damage — bad magic, an unknown id, a truncated body — closes the connection,
   * because there is no way to resynchronise a binary stream once its framing is in doubt.
   * Field-level problems are handled inline above and only ever drop the one command.
   */
  private refuse(reason: RejectReason, text: string): void {
    this.rejects.note(reason);
    log.warn(`dropping ${this.link.remoteAddress}: ${text}`);
    this.close(text);
  }

  /** The welcome frame. Sent once, immediately after a successful join. */
  welcome(mapId: string, modeId: string, snapshotHz: number): void {
    const player = this.player;
    if (player === null) return;
    this.send(
      writeWelcome(
        this.out,
        player.entityId,
        player.team,
        mapId,
        modeId,
        this.serverTick(),
        nowMs(),
        snapshotHz,
      ),
    );
  }

  /**
   * Fold one round-trip sample into the estimate.
   *
   * Exponential smoothing on the RTT and on the mean absolute deviation. The deviation is
   * what the client's jitter buffer is sized from and what the rewind uses as its margin, so
   * it is tracked rather than inferred — a link with 100 ms flat and one with 100 ms +/- 40 ms
   * need materially different amounts of buffer and would otherwise look identical.
   */
  noteRtt(sampleMs: number): void {
    if (!Number.isFinite(sampleMs) || sampleMs < 0 || sampleMs > 10_000) return;
    if (this.rttSamples === 0) {
      this.rttMs = sampleMs;
      this.jitterMs = 0;
    } else {
      const deviation = Math.abs(sampleMs - this.rttMs);
      this.jitterMs = this.jitterMs * 0.9 + deviation * 0.1;
      this.rttMs = this.rttMs * 0.9 + sampleMs * 0.1;
    }
    this.rttSamples++;
  }

  /** How far in the past this client is looking, in ticks. Drives the rewind (S4.13). */
  viewLagTicks(interpolationDelayMs: number): number {
    return Math.round((this.rttMs * 0.5 + interpolationDelayMs) / (DT * 1000));
  }
}

function blankCommand(): MutableInputCommand {
  return { seq: 0, tickIndex: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, sampledAtMs: 0 };
}

/**
 * A display name, made safe for a scoreboard.
 *
 * Control characters stripped and length capped. This string is rendered into the DOM on
 * every other player's client, so it is attacker-controlled text crossing a trust boundary —
 * the HUD sets it through `textContent`, never `innerHTML`, and this is the second layer.
 */
function sanitiseName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= 20) break;
  }
  return out.trim();
}

/**
 * Snapshot ids wrap at 16 bits, so "newer" is a distance question rather than a comparison.
 * Half the space forward is newer; the rest is older.
 */
function isNewerSnapshot(a: number, b: number): boolean {
  return ((a - b) & 0xffff) < 0x8000 && a !== b;
}
