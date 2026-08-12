import { nowMs } from '../core/Clock';
import { copyCommand, type InputCommand, type MutableInputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { logger } from '../core/Log';
import type { PlayerController } from '../player/PlayerController';
import { makePlayerSimState, type PlayerSimState } from '../player/PlayerState';
import { ClockSync } from './ClockSync';
import { EntityInterpolator } from './Interpolation';
import {
  decodeHeader,
  makeSnapshotHeader,
  readEntity,
  readEvents,
  readOwnerState,
  readSnapshotHeader,
  readSnapshotOwnerPresent,
  writeBye,
  writeCommands,
  writeHello,
  writeLoadout,
  writePing,
  writeReady,
  writeStreakRequest,
  writeVote,
  SFlag,
  type EventSink,
  type SnapshotHeader,
  type SummaryInfo,
  type VoteInfo,
  type WelcomeInfo,
} from './Messages';
import { Prediction } from './Prediction';
import type {
  NetLoadout,
  ObjectiveState,
  ProjectileState,
  SmokeState,
  StreakView,
} from './Skirmish';
import type { BombInfo, TagInfo } from '../modes/GameMode';
import { COMMAND_REDUNDANCY, quantiseCommandInPlace, rejectText } from './Protocol';
import { copyEntitySnapshot, EFlag, makeEntitySnapshot, type EntitySnapshot } from './Snapshot';
import type { INetLink } from './Transport';
import { ByteReader, ByteWriter } from './Wire';

const log = logger('netclient');

/**
 * The client half of the protocol (M10).
 *
 * ## Why this lives in `shared/`
 *
 * It has no browser in it. It takes an `INetLink` and drives the simulation, and both of
 * those are runtime-agnostic — so the browser client and the headless test client run
 * **exactly this code**, and a bug found by the unattended harness is a bug in the thing
 * players run. If prediction lived in `client/`, the harness could only ever test the
 * server, which is the half that was never going to be the hard part.
 *
 * The boundary check enforces the property that makes this possible: no `WebSocket`, no
 * `window`, no `performance.now()` anywhere in here.
 *
 * ## The tick loop
 *
 * ```
 *   1. poll        decode everything the link has delivered
 *   2. catch up    step the simulation forward to the tick the clock says we should be on
 *   3. send        one batch carrying the newest commands plus redundancy
 *   4. smooth      decay any correction still being eased out
 * ```
 *
 * Step 2 is where S4.11's rule bites: the target tick is **derived from the synced server
 * clock**, never incremented. If a frame took 200 ms, twelve ticks are owed and twelve are
 * run; the client does not quietly fall behind and start stamping commands for ticks the
 * server has already simulated.
 */

export type NetClientState =
  | 'idle'
  | 'connecting'
  | 'joined'
  | 'rejected'
  | 'disconnected';

export interface NetClientDeps {
  readonly link: INetLink;
  /** The local player's controller. Predicted, replayed and corrected.  */
  readonly controller: PlayerController;
  /** Produce the command for `tickIndex`. The caller owns sampling. */
  readonly sample: (tickIndex: number) => InputCommand;
  /**
   * Advance everything that consumes a command but is *not* replayed — the weapon.
   *
   * Separate from the controller for the reason `Prediction` documents at length: replaying
   * a weapon would fire its rounds again. This runs once per real tick and never on a replay.
   */
  readonly applyNonReplayed?: ((cmd: InputCommand) => void) | undefined;
  /** Gameplay events from the server, for presentation. */
  readonly events?: EventSink | undefined;
  readonly displayName: string;
  /**
   * The player's class, sent with the `Hello` (M11, Tier 1 #20).
   *
   * Sent in the handshake rather than after it, because the seat is created *during* the
   * handshake — see `writeHello`. Undefined is legal and means the server defaults.
   */
  readonly loadout?: NetLoadout | null | undefined;
  /** Ask the server for the S7 rewind panel feed. */
  readonly wantRewindDebug?: boolean | undefined;
  /**
   * The server started a *different* match on this same connection (M10, playtest round 2).
   *
   * A dedicated server does not stop when a match ends — it rotates and starts another, and
   * it says so by sending a second `Welcome`. The map may have changed, so the client cannot
   * merely reset: it has to tear the world down and build the new one. That is a decision
   * above this class, so this reports it rather than acting on it.
   */
  readonly onNewMatch?: ((welcome: WelcomeInfo) => void) | undefined;

  /**
   * The M11 skirmish messages (§6.4, §6.5, §6.9).
   *
   * Reported rather than acted on, for the same reason `onNewMatch` is: what to *do* about a
   * `Prepare` is to build meshes and textures, which is a client-only concern this class
   * cannot see from `shared/`. Optional throughout, so the M10 harnesses and any caller that
   * only wants the netcode compile and run unchanged.
   */
  readonly skirmish?: SkirmishSink | undefined;
}

/** Callbacks for the skirmish flow's server-to-client messages. */
export interface SkirmishSink {
  /** The vote cycle's state as the server sees it. Render it; never compute a tally. */
  readonly onVoteState?: ((info: VoteInfo) => void) | undefined;
  /** Start building this map in the background. Answer with `sendReady` when done (§6.5). */
  readonly onPrepare?: ((matchId: number, mapId: string, modeId: string) => void) | undefined;
  /** End-of-match stats and the XP breakdown, delivered before teardown (§6.9). */
  readonly onSummary?: ((info: SummaryInfo) => void) | undefined;
  /** A short line for the player: allocation failed, the arena was rebuilt. */
  readonly onNotice?: ((text: string) => void) | undefined;
  /**
   * Objective state, once per snapshot tick (M11 Gate B, §6.8).
   *
   * Reported rather than applied, like everything else here: *which* zone object a record
   * belongs to is the caller's mode, and `shared/net` has no business reaching into it.
   */
  readonly onObjectives?: ((states: readonly ObjectiveState[]) => void) | undefined;
  /** Kill Confirmed's tag list, once per snapshot tick (M11 Gate B, §6.8). */
  readonly onTags?: ((tags: readonly TagInfo[]) => void) | undefined;
  /** Search & Destroy's bomb, once per snapshot tick (M11 Gate B, §6.8). */
  readonly onBomb?: ((info: BombInfo) => void) | undefined;
  /**
   * Killstreaks — live entities, this player's earn state, this team's intel (§8.22).
   *
   * The one per-recipient message in the protocol. What arrives has already been filtered by
   * the server to what this seat is entitled to; there is nothing here for the client to
   * narrow, and narrowing in the client is what a UAV must never depend on.
   */
  readonly onStreaks?: ((view: StreakView) => void) | undefined;
  /** Grenades in flight and smoke on the ground (M11 Gate B, §8.24). Broadcast, not filtered. */
  /** The §7 mode-state hash for `tick`. Compare against your own; see `ModeStateHash`. */
  readonly onStateHash?: ((tick: number, hash: number) => void) | undefined;
  readonly onProjectiles?:
    | ((projectiles: readonly ProjectileState[], smoke: readonly SmokeState[]) => void)
    | undefined;
  /**
   * This client has been moved to another instance, effective on `welcome.effectiveTick`.
   *
   * Distinct from `onNewMatch`, which M10 fires for a rotation on the same connection. A
   * migration additionally means the *map* may differ and the client may already have built
   * it — so the two are reported separately rather than the caller having to infer which
   * happened from the payload.
   */
  readonly onMigrated?: ((welcome: WelcomeInfo) => void) | undefined;
}

/** Everything the S7 network and prediction panels display. */
export interface NetClientStats {
  rttMs: number;
  jitterMs: number;
  clockOffsetMs: number;
  serverTick: number;
  clientTick: number;
  /** How far ahead of the server this client is running, in ticks. */
  leadTicks: number;
  /** The jitter buffer in ms, and the part of it earned from reported starvation (S4.11). */
  marginMs: number;
  adaptiveMs: number;
  snapshotsReceived: number;
  snapshotsPerSecond: number;
  lastSnapshotBytes: number;
  meanSnapshotBytes: number;
  bytesIn: number;
  bytesOut: number;
  bytesInPerSecond: number;
  bytesOutPerSecond: number;
  /** Snapshots the server sent that never arrived, inferred from id gaps. */
  snapshotsLost: number;
  lossPct: number;
}

/** Ping cadence. Four a second is plenty to track a link and costs 13 bytes each. */
const PING_INTERVAL_MS = 250;

/** Most ticks simulated in one catch-up. Matches S4.1's cap for the same reason. */
const MAX_CATCHUP_STEPS = 5;

export class NetClient {
  state: NetClientState = 'idle';

  /** Entity id the server assigned. -1 until the welcome arrives. */
  entityId = -1;
  team: 'A' | 'B' = 'A';
  mapId = '';
  modeId = '';
  /** Why the connection ended, if it did. Shown to the player rather than swallowed. */
  closeReason = '';

  readonly clock = new ClockSync();
  readonly prediction = new Prediction();

  /** Remote entities by id, each with its own interpolation buffer (S4.12). */
  readonly remotes = new Map<number, EntityInterpolator>();

  /** Latest authoritative header: score, time, tick. */
  readonly header: SnapshotHeader = makeSnapshotHeader();

  /**
   * Whether a snapshot has ever carried `SFlag.MatchOver`.
   *
   * Makes *"this client finished a match"* distinguishable from *"this client was **told** the
   * match finished"*. Without it a headless client acks the summary and requeues, sailing
   * happily through a match whose `MATCH_END` phase never arrived — precisely the state that
   * left a browser walking around a finished match with no summary screen.
   *
   * A latch, set during decode, because the header is a *live* record and the moment a match
   * ends is the moment the server stops sending — so by the time anything downstream looks, the
   * last snapshot may be several frames old.
   */
  sawMatchOver = false;

  /**
   * Which instance this client is seated in (M11). `WARMUP_MATCH_ID` until told otherwise.
   *
   * Read by the client's flow to decide whether a `MATCH_END` belongs to the match it is
   * playing, and by the migration log to attribute mispredictions to the right instance.
   */
  matchId = 0;

  /** The server tick this seat became live. The named tick from §4.18. */
  effectiveTick = 0;

  /** How many migrations this connection has been through. Instrumentation. */
  migrations = 0;

  /**
   * Set on every seat assignment, cleared by the first owner block that follows it.
   *
   * See the branch it guards in `onSnapshot`. Starts true because a fresh connection is in
   * exactly the same position as a migrated one: a controller at the origin and no idea where
   * the server thinks it is.
   */
  private awaitingFirstAuthoritativePose = true;

  readonly stats: NetClientStats = {
    rttMs: 0,
    jitterMs: 0,
    clockOffsetMs: 0,
    serverTick: 0,
    clientTick: 0,
    leadTicks: 0,
    marginMs: 0,
    adaptiveMs: 0,
    snapshotsReceived: 0,
    snapshotsPerSecond: 0,
    lastSnapshotBytes: 0,
    meanSnapshotBytes: 0,
    bytesIn: 0,
    bytesOut: 0,
    bytesInPerSecond: 0,
    bytesOutPerSecond: 0,
    snapshotsLost: 0,
    lossPct: 0,
  };

  /** The tick this client is currently simulating. Derived, never incremented (S4.11). */
  private currentTick = 0;

  private readonly deps: NetClientDeps;

  /**
   * The controller prediction runs through. Swappable — see `swapController`.
   *
   * Held here rather than read off `deps` on every use, because a migration to another map
   * replaces it and `NetClientDeps.controller` is readonly by design: the dependency is what
   * this client was *built* with, and this field is what it is *using*.
   */
  private controller: PlayerController;
  private readonly reader = new ByteReader(new Uint8Array(0));
  private readonly writer = new ByteWriter(1024);
  private readonly owner: PlayerSimState = makePlayerSimState();
  private readonly entityScratch: EntitySnapshot = makeEntitySnapshot();

  /**
   * The newest commands, oldest first, resent every tick for redundancy against loss.
   *
   * S6.2 requires commands to survive a dropped packet, and at thirteen bytes each the
   * cheapest way to do that is to keep sending the last sixteen. A single lost frame then
   * costs nothing at all, and no acknowledgement protocol is needed for the one message type
   * where a retransmit would arrive too late to be worth anything.
   */
  private readonly pending: MutableInputCommand[] = [];

  private lastPingMs = 0;
  private pingId = 1;
  private readonly pingSentAt = new Map<number, number>();

  private lastSnapshotId = 0;
  private ackSnapshot = 0;

  /** Neutralised command scratch. See `neutralise`. */
  private readonly neutral: MutableInputCommand = blank();

  /**
   * Whether this client's own entity is alive, from the snapshot.
   *
   * Public because the HUD wants it, and read by `neutralise` because a dead player's
   * commands are not applied by the server.
   */
  localAlive = true;

  /** Set when this client's own entity reports a new spawn serial. */
  private respawned = false;
  /** The spawn serial last seen for our own entity. */
  private ownSpawnSerial = -1;
  private snapshotBytesTotal = 0;

  private rateWindowMs = 0;
  private rateSnapshots = 0;
  private rateBytesIn = 0;
  private rateBytesOut = 0;

  constructor(deps: NetClientDeps) {
    this.deps = deps;
    this.controller = deps.controller;
    for (let i = 0; i < COMMAND_REDUNDANCY; i++) this.pending.push(blank());
  }

  /**
   * Replace the predicted controller after a migration to a different map (M11, §4.18).
   *
   * A `PlayerController` is bound to one `CollisionWorld` for its lifetime, and prediction
   * sweeps a capsule against that geometry — so a client that migrated from the greybox arena
   * to Foundry and kept its controller would predict against the arena's walls while the
   * server simulated Foundry's. That is not a subtle divergence: it is a misprediction on
   * every tick that touches geometry, and it would read as the netcode having broken at
   * exactly the moment the match started.
   *
   * Safe only immediately after a seat assignment, which is why it is called from
   * `onMigrated`: `onWelcome` has just reset the prediction ring and cleared the interpolation
   * buffers, so there is no recorded state left that belonged to the old world. `Prediction`
   * takes the controller as a per-call argument rather than holding it, so nothing else needs
   * to be told.
   */
  swapController(next: PlayerController): void {
    this.controller = next;
    this.prediction.reset();
  }

  /** Begin the handshake. The link must already be open. */
  connect(): void {
    if (this.state !== 'idle' && this.state !== 'disconnected') return;
    this.state = 'connecting';
    this.closeReason = '';
    // The `#rw` suffix is how a client opts into the rewind debug feed without the protocol
    // growing a field only a debug panel reads.
    const name = this.deps.wantRewindDebug === true ? `${this.deps.displayName}#rw` : this.deps.displayName;
    // The class rides the handshake, so the seat is built with it rather than reconfigured
    // afterwards. See `writeHello` for the measured cost of the alternative.
    this.deps.link.send(writeHello(this.writer, name, this.deps.loadout ?? null));
    this.lastPingMs = 0;
    this.rateWindowMs = nowMs();
  }

  /**
   * Adopt a handshake somebody else already completed (M10, playtest round 2).
   *
   * The client cannot build its world until it knows which map the server is running, and it
   * cannot construct a `NetClient` until the world exists — prediction runs through the
   * `PlayerController`, which needs the map's collision. That circle is cut by doing the
   * handshake *first*, on a bare link, and handing the answer here.
   *
   * The link is already open and the `Hello` has already been sent and answered, so this must
   * not send a second one: a duplicate `Hello` is `Reject.OutOfOrder` and the server drops the
   * connection. See `client/net/Handshake.ts`.
   *
   * `receivedAtMs` is when the `Welcome` actually landed, not now. Between the two the client
   * loaded a map, which takes long enough to matter: seeding the clock with the current time
   * against a server timestamp from before the load would put the initial tick estimate that
   * far into the past. It is corrected by the first pong regardless, but starting right means
   * the first commands sent are for ticks the server has not already simulated.
   */
  adopt(welcome: WelcomeInfo, receivedAtMs: number): void {
    this.state = 'connecting';
    this.closeReason = '';
    this.lastPingMs = 0;
    this.rateWindowMs = nowMs();
    this.onWelcome(welcome, receivedAtMs);
  }

  // -- M11: the skirmish messages ---------------------------------------------

  /**
   * Send the player's class (Tier 1 #20).
   *
   * Ids only — see `writeLoadout`. Call after joining and again whenever the loadout editor
   * closes; the server applies it on the next spawn and locks it into the `MatchRequest` at
   * migration, which is what makes the perk the client predicts with the perk the server
   * simulates with.
   */
  sendLoadout(loadout: NetLoadout): void {
    if (this.state !== 'joined') return;
    this.deps.link.send(writeLoadout(this.writer, loadout));
  }

  /** Vote for `option` in `phase`. Rejected server-side if the window has closed (§4.20). */
  sendVote(phase: number, option: number): void {
    if (this.state !== 'joined') return;
    this.deps.link.send(writeVote(this.writer, phase, option));
  }

  /**
   * Ask to spend a streak (M11 Gate B, §8.22).
   *
   * A request. The server checks that this player actually holds it — the pending list the HUD
   * draws from is a replica, and a replica can be a frame behind a death that cleared it.
   */
  sendStreak(kind: number, markX: number, markZ: number): void {
    if (this.state !== 'joined') return;
    this.deps.link.send(writeStreakRequest(this.writer, kind, markX, markZ));
  }

  /** Report that the background build for `matchId` is finished (§6.5). */
  sendReady(matchId: number): void {
    if (this.state !== 'joined') return;
    this.deps.link.send(writeReady(this.writer, matchId));
  }

  /** Leave cleanly, so the server frees the seat without waiting for a timeout (S6.1). */
  disconnect(reason = 'left'): void {
    if (this.state === 'joined' || this.state === 'connecting') {
      this.deps.link.send(writeBye(this.writer, false, reason));
    }
    this.deps.link.close(reason);
    this.state = 'disconnected';
    this.closeReason = reason;
  }

  /**
   * One update. Call once per rendered frame in the browser, or per timer tick headless.
   *
   * Returns how many simulation steps were run, so the caller can drive interpolation alpha
   * from the same number.
   */
  update(): number {
    this.receive();

    if (this.deps.link.state === 'closed' && this.state === 'joined') {
      this.state = 'disconnected';
      if (this.closeReason === '') this.closeReason = 'connection lost';
    }

    if (this.state !== 'joined') return 0;

    this.maybePing();
    const steps = this.stepSimulation();
    if (steps > 0) this.sendCommands();
    this.updateRates();
    return steps;
  }

  /** Interpolated pose lookup for a remote entity, or undefined if it is not known. */
  interpolatorFor(entityId: number): EntityInterpolator | undefined {
    return this.remotes.get(entityId);
  }

  /**
   * Server time to render remote entities at, ms (S4.12).
   *
   * **The axis is tick-derived, not wall-clock.** Snapshots are timestamped
   * `serverTick * DT * 1000` and this is on the same scale, so the two cannot drift apart.
   * Using the server's `nowMs()` for one and ticks for the other would put the interpolation
   * timeline on a different origin from the samples it indexes — the process start offset —
   * and everything would be drawn a constant, invisible, wrong amount into the past.
   *
   * S4.11 already says the tick is the clock; this is that rule applied to interpolation.
   *
   * Everything remote is drawn at this instant, which is also the instant the server rewinds
   * to when resolving this client's shots (S4.13). The two being the same number is what
   * makes hit registration agree with what the player saw.
   */
  renderTimeMs(interpolationDelayMs: number): number {
    return this.clock.serverTickFractional() * DT * 1000 - interpolationDelayMs;
  }

  get tick(): number {
    return this.currentTick;
  }

  // -- receive ----------------------------------------------------------------

  /**
   * Apply frames the handshake drained before this client existed.
   *
   * `BrowserLink.poll` hands over the whole queue and then clears it, so anything sharing a
   * batch with the `Welcome` never reaches `receive`. See `HandshakeResult.pending`: ordinarily
   * empty, and on a reconnect it is the seat assignment that says we are already back in.
   */
  replay(frames: readonly Uint8Array[]): void {
    for (const bytes of frames) this.handleFrame(bytes);
  }

  private receive(): void {
    this.deps.link.poll((bytes) => this.handleFrame(bytes));
  }

  private handleFrame(bytes: Uint8Array): void {
    this.rateBytesIn += bytes.length;
    this.reader.reuse(bytes);
    const msg = decodeHeader(this.reader);

    switch (msg.kind) {
      case 'welcome':
        this.onWelcome(msg);
        return;
      case 'migrate':
        // Same handler, and that is the point: a migration and a join say the same thing
        // about this seat, so there is one path that resets prediction and interpolation
        // rather than two that must be kept in step. See `onWelcome`.
        this.onWelcome(msg);
        this.deps.skirmish?.onMigrated?.(this.matchInfo());
        return;
      case 'voteState':
        this.deps.skirmish?.onVoteState?.(msg);
        return;
      case 'prepare':
        // Logged because it is the starting gun for the background build (§6.5), it happens
        // once a cycle, and "did the client ever hear about the map" is the first question
        // when a transition hitches.
        log.info(`prepare: match ${msg.matchId} on ${msg.mapId} (${msg.modeId}).`);
        this.deps.skirmish?.onPrepare?.(msg.matchId, msg.mapId, msg.modeId);
        return;
      case 'summary':
        this.deps.skirmish?.onSummary?.(msg);
        return;
      case 'notice':
        this.deps.skirmish?.onNotice?.(msg.text);
        return;
      case 'objectives':
        this.deps.skirmish?.onObjectives?.(msg.states);
        return;
      case 'tags':
        this.deps.skirmish?.onTags?.(msg.tags);
        return;
      case 'bomb':
        this.deps.skirmish?.onBomb?.(msg.bomb);
        return;
      case 'streaks':
        this.deps.skirmish?.onStreaks?.(msg.view);
        return;
      case 'projectiles':
        this.deps.skirmish?.onProjectiles?.(msg.projectiles, msg.smoke);
        return;
      case 'stateHash':
        this.deps.skirmish?.onStateHash?.(msg.tick, msg.hash);
        return;
      case 'reject':
        this.state = 'rejected';
        this.closeReason = rejectText(msg.code);
        log.error(`server refused the connection: ${this.closeReason}`);
        this.deps.link.close('rejected');
        return;
      case 'pong':
        this.onPong(msg.id, msg.clientMs, msg.serverMs, msg.serverTick);
        return;
      case 'snapshot':
        this.onSnapshot(bytes.length);
        return;
      case 'events':
        if (this.deps.events !== undefined) readEvents(this.reader, msg.count, this.deps.events);
        return;
      case 'bye':
        this.state = 'disconnected';
        this.closeReason = msg.reason;
        log.info(`server closed the connection: ${msg.reason}`);
        this.deps.link.close('server bye');
        return;
      default:
        // A frame this client cannot parse. The server is the trusted end here, so this is
        // a version skew the handshake should have caught — say so rather than ignoring it.
        log.warn('undecodable frame from server; ignoring.');
    }
  }

  /**
   * A seat assignment — a join, a rotation, or an M11 migration.
   *
   * All three are the same event from this class's point of view: *"your entity id, team, map
   * and mode are now these, in this instance."* §4.18 lists what the client must do on a
   * migration — flush unacked commands, discard the prediction ring, resync the clock and
   * clear interpolation — and every item on that list is something a rejoin already had to do
   * for the M10 rotation path. Sharing the path is what stops the two drifting: a migration
   * that skipped one of them produces corrections that read as netcode bugs and are not.
   */
  private onWelcome(info: WelcomeInfo, receivedAtMs = nowMs()): void {
    const { entityId, team, mapId, modeId, serverTick, serverMs } = info;
    const rejoin = this.state === 'joined';
    this.entityId = entityId;
    this.team = team;
    this.mapId = mapId;
    this.modeId = modeId;
    this.matchId = info.matchId;
    this.effectiveTick = info.effectiveTick;
    this.state = 'joined';
    if (info.migrated) this.migrations++;
    // Whatever this controller currently believes about its position belongs to the instance
    // we have just left. Nothing it predicts counts until the server has said where we are.
    this.awaitingFirstAuthoritativePose = true;

    /**
     * A second `Welcome` means the server started a new match (M10, playtest round 2).
     *
     * Everything keyed to the old match has to go, and the entity table is the one that
     * matters: ids are reassigned per match, so a stale interpolator would put a body from
     * the previous map at coordinates that mean something different on this one. The owner
     * state and the prediction history go with it — they describe a player who no longer
     * exists.
     */
    if (rejoin) {
      this.remotes.clear();
      this.lastSnapshotId = 0;
      this.ackSnapshot = 0;
      this.localAlive = true;
      this.respawned = false;
      this.ownSpawnSerial = -1;
      for (const cmd of this.pending) blankInto(cmd);
    }

    /**
     * Seed the clock from the welcome, as a *guess* rather than as a sample.
     *
     * This used to call `sample(receivedAtMs, receivedAtMs, ...)`, which claims a zero round
     * trip — and `ClockSync` elects its offset from the lowest-RTT sample in the window, so a
     * fabricated zero won for four seconds and held the client half a round trip behind the
     * server. That is the rubberbanding-at-spawn the M11 playtest reported. See `ClockSync.seed`.
     */
    this.clock.seed(serverMs, serverTick, receivedAtMs);
    this.currentTick = this.clock.targetTick();
    this.prediction.reset();
    log.info(
      `${rejoin ? 'rejoined' : 'joined'} as entity ${entityId} on team ${team}, ${modeId} on ${mapId}.`,
    );
    /**
     * A rotation reports through `onNewMatch`; a migration reports through `onMigrated`.
     *
     * Never both. They mean the same thing to the layer above — *"rebuild your world"* — so a
     * client told twice rebuilds twice: two teardowns, two map loads, and on the second one the
     * background build has already been consumed by the first, so it builds synchronously and
     * hitches. Observed in the browser as the world being built twice per migration, with the
     * second build warning that no prebuilt map was ready.
     */
    if (rejoin && !info.migrated) this.deps.onNewMatch?.(this.matchInfo());
  }

  /** The `Welcome`'s payload, for a caller that needs to build a world from it. */
  matchInfo(): WelcomeInfo {
    return {
      entityId: this.entityId,
      team: this.team,
      mapId: this.mapId,
      modeId: this.modeId,
      serverTick: this.stats.serverTick,
      serverMs: 0,
      snapshotHz: 0,
      matchId: this.matchId,
      effectiveTick: this.effectiveTick,
      migrated: this.migrations > 0,
    };
  }

  private onPong(id: number, clientMs: number, serverMs: number, serverTick: number): void {
    const sentAt = this.pingSentAt.get(id) ?? clientMs;
    this.pingSentAt.delete(id);
    this.clock.sample(sentAt, nowMs(), serverMs, serverTick);
  }

  private onSnapshot(byteLength: number): void {
    readSnapshotHeader(this.reader, this.header);
    // Latched here rather than polled by a caller. See `sawMatchOver`.
    if ((this.header.flags & SFlag.MatchOver) !== 0) this.sawMatchOver = true;
    if (this.reader.overran) return;

    // Ids are 16-bit and wrap. A gap means snapshots were lost in flight, which is the
    // client's only direct measure of downstream packet loss.
    if (this.lastSnapshotId !== 0) {
      const gap = (this.header.snapshotId - this.lastSnapshotId) & 0xffff;
      if (gap > 1 && gap < 0x8000) this.stats.snapshotsLost += gap - 1;
    }
    this.lastSnapshotId = this.header.snapshotId;
    this.ackSnapshot = this.header.snapshotId;
    this.stats.snapshotsReceived++;
    this.clock.noteStarvation(this.header.starvation);
    this.stats.lastSnapshotBytes = byteLength;
    this.snapshotBytesTotal += byteLength;
    this.rateSnapshots++;

    // ---- the owner block ----------------------------------------------------
    // Decoded here because that is where it sits in the frame, but *applied* after the
    // entities below — the entity list is what carries this client's own spawn serial, and
    // a respawn has to be recognised before the state it produced is reconciled against.
    const hasOwner = readSnapshotOwnerPresent(this.reader);
    if (hasOwner) readOwnerState(this.reader, this.owner);
    if (this.reader.overran) return;

    // ---- removals ------------------------------------------------------------
    const removedCount = this.reader.u8v();
    for (let i = 0; i < removedCount; i++) {
      const id = this.reader.u8v();
      // A removed entity's buffer is dropped entirely rather than left to age out. Ids are
      // reused, and a stale buffer would make a freshly joined player interpolate from the
      // last position of whoever previously held that id — a body sliding in from across
      // the map on every join.
      this.remotes.delete(id);
    }

    // ---- entities ------------------------------------------------------------
    const count = this.reader.u8v();
    const serverMs = this.headerServerMs();
    for (let i = 0; i < count; i++) {
      // Peek the id so the delta is decoded *into this entity's own baseline*, which is the
      // contract `readEntity` documents: an absent field means unchanged, so decoding into a
      // blank record would put an unchanged entity at the origin.
      const id = this.reader.peekU8();
      if (this.reader.overran) return;

      let interp = this.remotes.get(id);
      if (interp === undefined) {
        interp = new EntityInterpolator();
        this.remotes.set(id, interp);
      }
      copyEntitySnapshot(interp.latest, this.entityScratch);
      readEntity(this.reader, this.entityScratch);
      if (this.reader.overran) return;

      // Our own entity's spawn serial is how the client learns it has been put somewhere new.
      // Read before `push` so the flag is set for the *next* owner block, which is the one
      // carrying the post-spawn state.
      if (id === this.entityId) {
        // The first sighting of our own entity counts as a spawn too. The client's controller
        // is sitting at the origin until the server says otherwise, and treating that as a
        // failed prediction would charge the join itself as a misprediction — a 30 m one, the
        // width of the map.
        if (this.entityScratch.spawnSerial !== this.ownSpawnSerial) this.respawned = true;
        this.ownSpawnSerial = this.entityScratch.spawnSerial;
        this.localAlive = (this.entityScratch.flags & EFlag.Alive) !== 0;
      }

      interp.push(this.entityScratch, serverMs);
    }

    // ---- now apply the owner block -------------------------------------------
    if (!hasOwner) return;

    if (this.awaitingFirstAuthoritativePose) {
      /**
       * Nothing to be wrong about yet (M11, §4.18).
       *
       * A seat assignment — a join, a rotation or a migration — leaves the client holding a
       * `PlayerController` that has never been told where it is. On a migration to another map
       * it is a *brand new* controller sitting at the origin, which in the greybox room is
       * inside geometry: the ticks before the first owner block arrives are spent predicting a
       * de-penetration the server never performed, and every one of them is later compared
       * against an authoritative state from somewhere else entirely.
       *
       * `respawned` below handles the same idea for a death, and this is the same argument one
       * step earlier: *"this is not the client having been wrong, it is the client having had
       * nothing to be wrong about."* Measured before this latch: 1-3 mispredictions in the 60
       * ticks after every return to the arena, on every client, at the same tick offsets —
       * which is the signature of a shared sim event rather than a link problem, and is what
       * gave it away.
       *
       * Cleared here, so exactly one adopt is exempted and ordinary prediction resumes on the
       * next snapshot. A latch that stayed set would be a client that never reconciles.
       */
      this.awaitingFirstAuthoritativePose = false;
      this.respawned = false;
      /**
       * Adopt without replaying.
       *
       * Replaying the unacked commands here was tried and measured, on the theory that the
       * client is two ticks behind its own input at this point. It moved the residual
       * misprediction from the arena-return transition onto the into-match transition instead
       * of removing it — 1 and 1 where there had been 0 and 1 — because the first snapshot
       * from a freshly seated instance carries an `ackSeq` from a command buffer that has only
       * just started filling, so the replay depth it implies is not the real one.
       *
       * Left as the plain adopt, which is what M10 shipped and what the respawn path below
       * uses. See PLAN.md for the residual this leaves and its measured size.
       */
      this.prediction.adopt(this.owner, this.controller);
      return;
    }

    if (this.respawned) {
      /**
       * A respawn is not a misprediction.
       *
       * The server teleports a dead player to a spawn point of its own choosing. No client
       * could have predicted that, and counting it would make S8.4's "zero mispredictions"
       * unreachable by construction — every death would add one, and the p99 would be
       * dominated by the diameter of the map rather than by anything the netcode does.
       * (Measured before this was handled: p99 of 30 m, which is the length of Foundry.)
       *
       * So the prediction history is discarded and the authoritative state adopted outright.
       * The distinction is a real one: this is not the client having been *wrong*, it is the
       * client having had nothing to be wrong about.
       */
      this.respawned = false;
      this.prediction.reset();
      this.prediction.adopt(this.owner, this.controller);
      return;
    }

    this.prediction.reconcile(this.header.ackSeq, this.owner, this.controller);
  }

  // -- simulate ---------------------------------------------------------------

  /**
   * Advance to the tick the clock says we should be on.
   *
   * Bounded, exactly as S4.1 bounds the render loop: a client that alt-tabbed for a minute
   * owes 3,600 ticks and running them would freeze the tab for seconds. Past the cap the
   * client resynchronises to the clock's target rather than grinding through the backlog —
   * the server has already simulated those ticks with repeated commands, and the next
   * snapshot corrects whatever that produced.
   */
  private stepSimulation(): number {
    const target = this.clock.targetTick();
    if (target <= 0) return 0;

    if (this.currentTick === 0) this.currentTick = target;

    const owed = target - this.currentTick;
    if (owed > MAX_CATCHUP_STEPS) {
      log.warn(`${owed} ticks behind the server clock; resynchronising.`);
      this.currentTick = target;
      this.prediction.reset();
      return 0;
    }

    let steps = 0;
    while (this.currentTick < target && steps < MAX_CATCHUP_STEPS) {
      const cmd = this.neutralise(this.deps.sample(this.currentTick));
      this.controller.step(cmd);
      this.deps.applyNonReplayed?.(cmd);
      this.prediction.record(cmd, this.controller);
      this.queue(cmd);
      this.currentTick++;
      steps++;
    }

    this.prediction.step();
    return steps;
  }

  /**
   * Apply the server's own input rules to a sampled command, before predicting with it.
   *
   * The client must neutralise a command in **exactly** the cases the server does, or it
   * predicts motion the server never applies and corrects itself out of it a moment later.
   * Two cases, and both were real divergences before this existed:
   *
   * - **Frozen** (`SFlag.InputFrozen`): the pre-match countdown and the post-round pause.
   *   `ServerMatch.stepPlayer` strips the movement axes and every action bit and keeps the
   *   view angles, so looking around still works. This does the same thing to the same
   *   fields.
   * - **Dead**: `NetPlayer.step` returns before consuming a command at all, so the corpse
   *   just falls. A client predicting a dead player walking is the same divergence in a
   *   different costume.
   *
   * The view angles survive in both cases, which is what makes a countdown feel like a
   * starting gun and a death screen feel like a camera rather than a freeze frame.
   *
   * Every command passes through here, suppressed or not, because this is also where the
   * command is rounded to wire precision.
   *
   * This is the netcode-side statement of a rule the single-player build already had
   * (`Input.sampleSpectating`). Neither side owns it alone: it lives here so both halves of
   * a networked match read it from one place.
   */
  private neutralise(cmd: InputCommand): InputCommand {
    const frozen = (this.header.flags & SFlag.InputFrozen) !== 0;
    const suppress = frozen || !this.localAlive;

    const out = this.neutral;
    out.seq = cmd.seq;
    out.tickIndex = cmd.tickIndex;
    out.moveX = suppress ? 0 : cmd.moveX;
    out.moveZ = suppress ? 0 : cmd.moveZ;
    out.yaw = cmd.yaw;
    out.pitch = cmd.pitch;
    out.buttons = suppress ? 0 : cmd.buttons;
    out.sampledAtMs = cmd.sampledAtMs;

    // Predict with exactly what the wire will carry. See `quantiseCommandInPlace` — without
    // this the client and the server simulate subtly different commands and the divergence
    // accumulates in one direction whenever the player is turning.
    quantiseCommandInPlace(out);
    return out;
  }

  /** Keep the newest commands for the redundant batch. */
  private queue(cmd: InputCommand): void {
    // Shift left and append. The array is `MAX_COMMANDS_PER_BATCH` long and this runs at most
    // five times a frame, so the copy is cheaper than the bookkeeping a ring would need.
    for (let i = 0; i < this.pending.length - 1; i++) {
      const dst = this.pending[i];
      const src = this.pending[i + 1];
      if (dst !== undefined && src !== undefined) copyCommand(src, dst);
    }
    const last = this.pending[this.pending.length - 1];
    if (last !== undefined) copyCommand(cmd, last);
  }

  private sendCommands(): void {
    const frame = writeCommands(this.writer, this.pending, this.pending.length, this.ackSnapshot);
    this.rateBytesOut += frame.length;
    this.deps.link.send(frame);
  }

  private maybePing(): void {
    const now = nowMs();
    if (now - this.lastPingMs < PING_INTERVAL_MS) return;
    this.lastPingMs = now;
    const id = this.pingId++;
    this.pingSentAt.set(id, now);
    // Bound the outstanding set: a link that drops every pong must not grow a map forever.
    if (this.pingSentAt.size > 32) {
      const oldest = this.pingSentAt.keys().next();
      if (!oldest.done) this.pingSentAt.delete(oldest.value);
    }
    const frame = writePing(this.writer, id, now);
    this.rateBytesOut += frame.length;
    this.deps.link.send(frame);
  }

  // -- stats ------------------------------------------------------------------

  private updateRates(): void {
    const s = this.stats;
    s.rttMs = this.clock.rttMs;
    s.jitterMs = this.clock.jitterMs;
    s.clockOffsetMs = this.clock.offsetMs;
    s.serverTick = this.clock.estimatedServerTick();
    s.clientTick = this.currentTick;
    s.leadTicks = this.currentTick - s.serverTick;
    s.marginMs = this.clock.marginMs();
    s.adaptiveMs = this.clock.adaptiveMs;
    s.bytesIn = this.deps.link.bytesIn;
    s.bytesOut = this.deps.link.bytesOut;
    s.meanSnapshotBytes =
      s.snapshotsReceived === 0 ? 0 : this.snapshotBytesTotal / s.snapshotsReceived;

    const now = nowMs();
    const elapsed = now - this.rateWindowMs;
    if (elapsed < 1000) return;
    const seconds = elapsed / 1000;
    s.snapshotsPerSecond = this.rateSnapshots / seconds;
    s.bytesInPerSecond = this.rateBytesIn / seconds;
    s.bytesOutPerSecond = this.rateBytesOut / seconds;
    const expected = this.rateSnapshots + this.lostThisWindow();
    s.lossPct = expected === 0 ? 0 : (this.lostThisWindow() / expected) * 100;
    this.rateWindowMs = now;
    this.rateSnapshots = 0;
    this.rateBytesIn = 0;
    this.rateBytesOut = 0;
    this.lostAtWindowStart = this.stats.snapshotsLost;
  }

  private lostAtWindowStart = 0;

  private lostThisWindow(): number {
    return this.stats.snapshotsLost - this.lostAtWindowStart;
  }

  /**
   * The time axis snapshots are placed on: the tick they describe, in milliseconds.
   *
   * Derived from the tick rather than carried as a timestamp, because the tick is the
   * canonical clock (S4.11) and a second time source would be a second thing to keep in sync.
   */
  private headerServerMs(): number {
    return this.header.serverTick * DT * 1000;
  }
}

function blank(): MutableInputCommand {
  return { seq: 0, tickIndex: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, sampledAtMs: 0 };
}

/** Wipe a command in place. The redundancy buffer is preallocated and never reallocated. */
function blankInto(cmd: MutableInputCommand): void {
  cmd.seq = 0;
  cmd.tickIndex = 0;
  cmd.moveX = 0;
  cmd.moveZ = 0;
  cmd.yaw = 0;
  cmd.pitch = 0;
  cmd.buttons = 0;
  cmd.sampledAtMs = 0;
}
