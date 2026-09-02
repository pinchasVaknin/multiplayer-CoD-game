import { nowMs } from '../../shared/core/Clock';
import type { MutableInputCommand } from '../../shared/core/InputCommand';
import { DT } from '../../shared/core/Loop';
import { logger } from '../../shared/core/Log';
import {
  decodeHeader,
  readCommand,
  writeBomb,
  writeBye,
  writeCheats,
  writeNotice,
  writeObjectives,
  writePong,
  writeTags,
  writeStreaks,
  writeProjectiles,
  writeStateHash,
  writePrepare,
  writeReject,
  writeSummary,
  writeVoteState,
  writeWelcome,
  type SummaryInfo,
  type VoteInfo,
  type WelcomeInfo,
} from '../../shared/net/Messages';
import { CheatState } from '../../shared/cheats/Cheats';
import type { LoadoutSlot } from '../../shared/meta/Loadouts';
import {
  sanitiseNetLoadout,
  type NetLoadout,
  type ObjectiveState,
  type StreakView,
  type ProjectileState,
  type SmokeState,
} from '../../shared/net/Skirmish';
import type { BombInfo, TagInfo } from '../../shared/modes/GameMode';
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

/**
 * `'live'` rather than `'playing'` (M11, handover Tier 2 §C).
 *
 * *"M10's `SessionState` is `'handshaking' | 'playing' | 'closed'`, and the timeout logic
 * assumes `NetClient`'s ping keeps a session alive — true only while the client is in a
 * match. A Skirmish/Warmup flow has exactly this shape: a connected client that is not yet
 * simulating."*
 *
 * The word is the fix. `'playing'` invited the reading that a session in this state is inside
 * a match, and the skirmish flow has a state — seated in the arena, voting, waiting on a
 * background build — where the connection is fully live and the player may not be shooting at
 * all. `'live'` means the connection is up and the seat is real, and says nothing about what
 * the player is doing with it.
 *
 * The timeout half of §C is not a problem here and it is worth saying why rather than
 * assuming it: this flow has no state without a `NetClient`. A player is seated in the warmup
 * arena from the moment the handshake completes, so the ping that keeps the session alive is
 * running from the first tick. That is exactly the shape M11's lobby did *not* have.
 */
export type SessionState = 'handshaking' | 'live' | 'closed';

/**
 * Why a connection ended (M11 Gate B, playtest round 4, F8).
 *
 * The same shape, and for the same reason, as `UnseatCause`: only the caller can tell the two
 * apart, and the consequence differs. A connection that was **lost** may be coming back and its
 * seat is held for the grace; one that **left** said so, with a `Bye` or by being refused, and
 * holding a seat against the player's own statement would put them back in the match they had
 * just quit if they pressed Play again inside thirty seconds.
 *
 * `'lost'` is the default on `close`, deliberately: the timeouts are the paths that reach it
 * without a caller thinking about it, and they are exactly the ones that mean "may be back".
 */
export type LeaveCause = 'left' | 'lost';

/**
 * What `onJoin` returns (M11, handover Tier 2 §D).
 *
 * The `afterIdentity` half is the ordering contract. See `SessionEvents.onJoin`.
 */
export interface JoinResult {
  readonly player: NetPlayer;
  /**
   * Work that must not happen until `Identity` has left the building.
   *
   * A reconnect reseats the session, and reseating sends a seat assignment. Done inside
   * `onHello`, that frame goes out *before* the `Welcome` whose reply it is, and the client's
   * very first frame after a `Hello` is an assignment it has no context for yet — so the
   * handshake drops it.
   *
   * The ordering becomes a property of this contract rather than of the order two functions
   * happen to be called in. `Session` calls it **last**, after the welcome frame has been sent
   * and the log line written.
   */
  readonly afterIdentity?: () => void;
}

export interface SessionEvents {
  /**
   * A validated `Hello`. Return the seat, or null to refuse with `ServerFull`.
   *
   * Anything this handler wants to *send* as a consequence belongs in `afterIdentity`, not in
   * the handler body — see `JoinResult.afterIdentity`.
   *
   * `claim` is what this connection says about a seat it held before (round 4, F8), already
   * length-checked by the decoder and **not** otherwise trusted: it is a lookup key, and the
   * only thing the handler may conclude from it is whichever reservation it happens to match.
   * Null on an ordinary first join, and null is not an error.
   */
  readonly onJoin: (session: Session, name: string, claim: Uint8Array | null) => JoinResult | null;
  readonly onLeave: (session: Session, reason: string, cause: LeaveCause) => void;
  /** The player's class, structurally decoded and not yet validated (Tier 1 #20). */
  readonly onLoadout: (session: Session, loadout: NetLoadout) => void;
  /** A vote for `option` in `phase`. Accepted, ignored or rejected entirely by the cycle. */
  readonly onVote: (session: Session, phase: number, option: number) => void;
  /** "My background build for `matchId` is done" (§6.5). */
  readonly onReady: (session: Session, matchId: number) => void;
  /** "Spend the streak I have earned" (§8.22). The instance decides whether they have. */
  readonly onStreakRequest: (session: Session, kind: number, x: number, z: number) => void;
  /**
   * "I typed this cheat code" (round 4, F14). The server decides, and always answers.
   *
   * The text is unparsed on purpose — see `MsgC.Cheat`. Length has already been bounded by the
   * decoder, and that is the only thing about it this layer is entitled to conclude.
   */
  readonly onCheatRequest: (session: Session, code: string) => void;
}

/** Snapshot ids kept per client so a late ack can still be used as a delta baseline. */
export const BASELINE_HISTORY = 32;

/**
 * A connection's identity, stable across migrations (M11).
 *
 * A plain incrementing number rather than a random token: it is never sent to a client, never
 * used for authentication, and only has to be unique within one process lifetime. It is
 * deliberately **not** an entity id — see `Session.playerId`.
 */
export type PlayerId = number;

let nextPlayerId: PlayerId = 1;

export class Session {
  readonly link: INetLink;
  readonly rejects = new RejectCounters();

  state: SessionState = 'handshaking';

  /**
   * The seat this connection owns **in its current instance**, once it has joined.
   *
   * Reassigned on every migration, because entity ids belong to a `ServerMatch` and two
   * instances hand them out independently. Nothing outside the router and `Migration` should
   * write this field: it is half of the *"exactly one instance on every tick"* invariant, and
   * the other half is `Router.instanceOf`.
   */
  player: NetPlayer | null = null;

  /**
   * A stable id for this connection, unchanged across migrations (M11).
   *
   * `entityId` cannot serve: it is per-instance and is reassigned by every move, so a log
   * line, a vote, a readiness report and a misprediction count would all be keyed to something
   * that means a different player five seconds later. This is the id the router, the vote
   * cycle and the migration log use.
   */
  readonly playerId: PlayerId;

  displayName = '';

  /**
   * The capability this connection presents to get its seat back (round 4, F8).
   *
   * Minted once, when the seat is granted, and sent on **every** seat assignment by
   * `sendSeat` — which is the only writer of the frame and therefore the only place it can be
   * forgotten. A caller-supplied token would be a field four call sites have to remember, and
   * the one that forgot would produce a client that silently cannot reconnect after a
   * migration.
   *
   * Not an identity and not a name: `playerId` is the identity, and it is deliberately never
   * sent to anybody. This is a bearer capability with a short life — see `ReconnectRegistry`
   * for who may redeem it and `RECONNECT_TOKEN_BYTES` for why it is unguessable.
   *
   * **Never logged.** Log lines name the `playerId`, which is meaningless to anyone who does
   * not already have the process's memory.
   */
  reconnectToken: Uint8Array | null = null;

  /**
   * What this connection has been granted by cheat code (playtest round 4, F14).
   *
   * On the **session** rather than on the seat, and for the same reason `loadout` and
   * `reconnectToken` are: it is a fact about the connection, and a `NetPlayer` is thrown away
   * and rebuilt by every migration. A grant that lived on the seat would be lost the moment the
   * player was moved from the arena into the match they typed the code to look at.
   *
   * It dies with the connection, and that is deliberate rather than an omission. A reconnect is
   * a **new** connection with a fresh store, so a returning player comes back clean — the
   * reservation gives back the seat, the score and the side, and nothing else.
   *
   * The server is the sole author of every bit in here: `Cheat.Debug` is client-side and never
   * arrives, so this mask only ever holds `CHEAT_SIMULATION` bits.
   */
  readonly cheats = new CheatState();

  /**
   * The class this client last sent, already validated (Tier 1 #20).
   *
   * Held on the session rather than in the instance, because it must survive migration — it is
   * captured into the `MatchRequest` at migration time and applied *before* the player entity
   * exists in the live instance (§4.18, §6.6). A loadout that lived in the warmup instance
   * would have to be copied across the very boundary it exists to cross correctly.
   */
  loadout: LoadoutSlot | null = null;

  /**
   * The match id this client has reported its background build complete for, or -1.
   *
   * Answers `READY_WAIT` (§6.5). Kept per session rather than per instance because the report
   * arrives while the player is still in warmup, about an instance they are not yet in.
   */
  readyForMatch = -1;

  /** When the `Prepare` went out, so the readiness time per client can be measured (§7). */
  prepareSentAtMs = 0;

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
    this.playerId = nextPlayerId++;
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
    /**
     * `state`, not `closed` (playtest round 4, F8).
     *
     * The two differ in exactly one case and it is the one that matters: `closed` is true when
     * *either* this session or its link has gone, so a link that died since the last tick
     * returned here immediately and everything it had already delivered went unread. That
     * silently ate the `Bye` on every clean disconnect where the socket closed inside the same
     * event-loop batch — see the `close` handler in `WsServer`, which used to throw the frames
     * away as well.
     *
     * Reading them is safe and is the honest thing to do: they arrived. Nothing here can
     * produce a *send* on a dead link (`send` and `close` both check the link's own state), and
     * the ordering is already right — `receive` runs before `checkTimeout` in the same tick, so
     * a `Bye` decoded here closes the session as `'left'` before the link check can close it as
     * `'lost'`.
     */
    if (this.state === 'closed') return;
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
    if (this.state === 'closed') return;

    /**
     * The link died without this session closing it — the pulled cable.
     *
     * This guard used to be `if (this.closed) return`, and `closed` is true when *either* this
     * session or its link has gone. So an abrupt drop returned here immediately and `close()`
     * was never reached, which meant `onLeave` was never called and every consequence of a
     * disconnect was skipped: the reconnect grace never held a seat for the one kind of
     * disconnect it exists to cover, the match kept addressing snapshots to a dead session, and
     * a player who dropped while waiting stayed counted as present.
     *
     * The clean disconnect never had the problem, because a `Bye` goes through `close()` on the
     * way in. That is why it survived M10 and Gate A: both tested the path that works.
     */
    if (this.link.state === 'closed') {
      // A fixed reason rather than the link's own: `INetLink` does not carry one, and widening
      // the shared transport interface to improve one log line is not the trade.
      this.close('connection lost');
      return;
    }

    const now = nowMs();
    if (this.state === 'handshaking' && now - this.openedMs > HANDSHAKE_TIMEOUT_MS) {
      this.close('handshake timeout', 'left');
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

  close(reason: string, cause: LeaveCause = 'lost'): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.link.state === 'open') {
      this.link.send(writeBye(this.out, true, reason));
      this.link.close(reason);
    }
    this.events.onLeave(this, reason, cause);
  }

  // -- internals -------------------------------------------------------------

  private handleFrame(bytes: Uint8Array): void {
    this.reader.reuse(bytes);
    const msg = decodeHeader(this.reader);

    switch (msg.kind) {
      case 'hello':
        this.handleHello(msg.version, msg.name, msg.loadout, msg.reconnectToken);
        return;
      case 'commands':
        this.handleCommands(msg.count, msg.snapshotAck);
        return;
      case 'ping':
        this.handlePing(msg.id, msg.clientMs);
        return;
      case 'bye':
        // A `Bye` is the player saying they are done. Nothing is held for them — see `LeaveCause`.
        this.close('client left', 'left');
        return;
      case 'loadout':
        // Seated clients only. A class arriving before a seat has nowhere to be applied, and
        // accepting it would mean holding attacker-controlled state for an unauthenticated
        // connection — small, but it is state, and the handshake timeout is five seconds.
        if (this.state !== 'live') {
          this.refuse(Reject.OutOfOrder, 'loadout before hello');
          return;
        }
        this.events.onLoadout(this, msg.loadout);
        return;
      case 'vote':
        if (this.state !== 'live') {
          this.refuse(Reject.OutOfOrder, 'vote before hello');
          return;
        }
        this.events.onVote(this, msg.phase, msg.option);
        return;
      case 'ready':
        if (this.state !== 'live') {
          this.refuse(Reject.OutOfOrder, 'ready before hello');
          return;
        }
        this.events.onReady(this, msg.matchId);
        return;
      case 'streakRequest':
        if (this.state !== 'live') {
          this.refuse(Reject.OutOfOrder, 'streak before hello');
          return;
        }
        // Not validated here beyond the ordering. Whether this player has actually earned the
        // streak is a question about the simulation, and the instance is the only thing that
        // can answer it — see `Server.onStreakRequest`. §4.16's boundary validation is about
        // *shape*, and the decoder above has already done that.
        this.events.onStreakRequest(this, msg.streakKind, msg.x, msg.z);
        return;
      case 'cheatRequest':
        if (this.state !== 'live') {
          this.refuse(Reject.OutOfOrder, 'cheat before hello');
          return;
        }
        // Whether the code exists, whether this server honours it and whether there is a seat
        // to apply it to are all questions about the server's own state, so none of them is
        // answered here. §4.16's boundary validation is about *shape*, and the decoder has
        // already bounded the only thing with a shape. The link's `MAX_MESSAGES_PER_SEC` is
        // what stops somebody typing codes at it in a loop.
        this.events.onCheatRequest(this, msg.code);
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

  private handleHello(
    version: number,
    name: string,
    loadout: NetLoadout | null,
    claim: Uint8Array | null,
  ): void {
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
      this.events.onLeave(this, 'version mismatch', 'left');
      return;
    }

    const clean = sanitiseName(name);
    this.wantsRewindDebug = clean.endsWith('#rw');
    this.displayName = this.wantsRewindDebug ? clean.slice(0, -3) : clean;
    if (this.displayName === '') this.displayName = 'OPERATOR';

    /**
     * The class, validated **before** the seat is asked for (Tier 1 #20).
     *
     * `onJoin` builds the entity, and the entity's constructor is what applies the perks. So
     * this has to be on the session by the time that call is made, or the seat is built without
     * it and every tick until the next spawn is a divergence.
     *
     * Never throws and never refuses the connection: an unreadable class from a client one
     * build out of step falls back to the server defaults, which is a working game.
     */
    this.loadout = sanitiseNetLoadout(loadout);

    const joined = this.events.onJoin(this, this.displayName, claim);
    if (joined === null) {
      this.link.send(writeReject(this.out, RejectCode.ServerFull));
      this.state = 'closed';
      this.link.close('server full');
      this.events.onLeave(this, 'server full', 'left');
      return;
    }

    this.player = joined.player;
    this.state = 'live';
    log.info(
      `${this.displayName} (${this.link.remoteAddress}) joined as entity ${joined.player.entityId} ` +
        `on team ${joined.player.team}.`,
    );

    /**
     * Last, and the ordering is the contract (handover Tier 2 §D).
     *
     * By this line the seat assignment has been sent — `onJoin` sends it, because only the
     * caller knows which instance the player landed in — and the log line is written. Anything
     * that produces a *further* frame runs now, so it cannot overtake the assignment it is a
     * consequence of. This makes *"the seat assignment is the first frame after a `Hello`"* a
     * guarantee the server makes on every path rather than an assumption the client hopes for.
     */
    joined.afterIdentity?.();
  }

  private handleCommands(count: number, snapshotAck: number): void {
    if (this.state !== 'live') {
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
    // We threw them out; the seat is not held for a connection the server refused.
    this.close(text, 'left');
  }

  /**
   * The seat assignment: a `Welcome` on a join, a `Migrate` on a move (M11, §4.18).
   *
   * One method for both, because a client that is told about its seat differently depending on
   * how it got there is a client with two code paths where one of them is exercised rarely.
   * The `migrated` flag on the payload picks the message id.
   */
  sendSeat(info: WelcomeInfo): void {
    this.send(writeWelcome(this.out, info, this.reconnectToken));
  }

  /** A short line for the player. Allocation failed, migration failed, the arena was rebuilt. */
  notice(text: string): void {
    this.send(writeNotice(this.out, text));
  }

  /**
   * The answer to a cheat code: what happened, and the whole mask afterwards (round 4, F14).
   *
   * Sent for a refusal exactly as for a grant. A cheat that is silent when refused is a bug that
   * gets reported twice — once as "the code does nothing" and again, later, as "cheats are
   * broken on the server" — and neither report says the true thing, which is that this operator
   * has them switched off.
   */
  sendCheats(outcome: number, mask: number): void {
    this.send(writeCheats(this.out, outcome, mask));
  }

  /**
   * The M11 server-to-client messages, each encoded with **this session's** writer.
   *
   * ## Why these live here rather than on the caller
   *
   * `ByteWriter.bytes()` returns a *view* into the writer's buffer, not a copy. A caller that
   * held one shared writer and encoded into it for every session would hand out several views
   * of the same memory, and the last encode would win — every earlier frame would go out
   * carrying the last one's bytes.
   *
   * It is not hypothetical. `Server` did exactly that, and the symptom was that the `Prepare`
   * starting each client's background build was overwritten by the 4 Hz vote broadcast that
   * followed it on the next tick. No client ever began building, every readiness handshake hit
   * its eight-second timeout, and the transition that the whole milestone exists to make
   * seamless fell back to a synchronous build with a visible hitch — with nothing in either
   * log saying why.
   *
   * One writer per session, owned by the session, makes that unrepresentable.
   */
  sendPrepare(matchId: number, mapId: string, modeId: string): void {
    this.send(writePrepare(this.out, matchId, mapId, modeId));
  }

  sendVoteState(info: VoteInfo): void {
    this.send(writeVoteState(this.out, info));
  }

  sendSummary(info: SummaryInfo): void {
    this.send(writeSummary(this.out, info));
  }

  sendObjectives(states: readonly ObjectiveState[]): void {
    this.send(writeObjectives(this.out, states));
  }

  sendTags(tags: readonly TagInfo[]): void {
    this.send(writeTags(this.out, tags));
  }

  sendBomb(info: BombInfo): void {
    this.send(writeBomb(this.out, info));
  }

  sendStreaks(view: StreakView): void {
    this.send(writeStreaks(this.out, view));
  }

  sendProjectiles(projectiles: readonly ProjectileState[], smoke: readonly SmokeState[]): void {
    this.send(writeProjectiles(this.out, projectiles, smoke));
  }

  sendStateHash(tick: number, hash: number): void {
    this.send(writeStateHash(this.out, tick, hash));
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
