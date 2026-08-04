import type { Bot } from '../shared/ai/Bot';
import { nowMs } from '../shared/core/Clock';
import { Btn, isDown } from '../shared/core/InputCommand';
import { logger } from '../shared/core/Log';
import { metric } from './log';
import { makeSnapshotHeader, phaseIndex, SFlag, type SnapshotHeader } from '../shared/net/Messages';
import { EFlag, makeEntitySnapshot, weaponIndexOf, type EntitySnapshot } from '../shared/net/Snapshot';
import { describeConfig, type ServerConfig } from './Config';
import { ServerLoop, type TickJitter } from './Loop';
import { ServerMatch } from './Match';
import type { NetPlayer } from './NetPlayer';
import { Session } from './net/Session';
import { SnapshotEncoder } from './net/SnapshotEncoder';
import { WsServer, type WsLink } from './net/WsServer';

const log = logger('server');

/**
 * The authoritative process: one match, one loop, N connections (M10).
 *
 * ## Order of operations in a tick, and why it is this order
 *
 * ```
 *   1. receive     drain every socket into the input buffers
 *   2. simulate    one fixed 60 Hz step of the shared simulation
 *   3. snapshot    every Nth tick, encode and send world state per client
 *   4. events      send the tick's replicated gameplay events
 *   5. flush       release anything the condition simulator is holding
 *   6. reap        time out silent connections, remove departed players
 * ```
 *
 * Receive **before** simulate, because a command that arrived during the last frame is for a
 * tick that has not run yet, and holding it one more tick would add 16 ms of latency to every
 * input for no reason. Snapshot **after** simulate, because a snapshot describes the world
 * after the tick, not before it — sending it first would put every client permanently one
 * tick in the past on top of every other delay they already have.
 *
 * ## One match, deliberately
 *
 * S4.9: *"one match instance per server process, 10 connected clients. The match instance is
 * a class so multiple instances per process remain possible later. Do not build that now."*
 * `ServerMatch` is that class and this owns exactly one of them.
 */

export class GameServer {
  private readonly match: ServerMatch;
  private readonly loop: ServerLoop;
  private readonly wss: WsServer;

  private readonly sessions: Session[] = [];
  private readonly encoders = new Map<number, SnapshotEncoder>();
  private readonly header: SnapshotHeader = makeSnapshotHeader();

  /** Reused snapshot records, one per entity slot. Nothing allocates per tick (S4.7). */
  private readonly entities: EntitySnapshot[] = [];
  private entityCount = 0;

  private readonly snapshotEveryTicks: number;
  private lastMetricsMs = 0;
  private stopping = false;

  constructor(private readonly cfg: ServerConfig) {
    this.match = new ServerMatch({
      mapId: cfg.mapId,
      modeId: cfg.modeId,
      bots: cfg.bots,
      tier: 'MIX',
      seed: cfg.seed,
    });

    // The match asks how stale each shooter's view is; the session knows, because it owns
    // the RTT estimate. This is the only wire between the simulation and the network layer,
    // and it points the right way — the sim asks a question, it is not told an answer.
    this.match.rewindDisabled = cfg.rewindDisabled;
    if (cfg.rewindDisabled) {
      log.warn('REWIND_DISABLED=1 — lag compensation is OFF. Diagnostic only (S8.6).');
    }

    this.match.viewLagMsFor = (entityId) => {
      const session = this.sessionFor(entityId);
      if (session === null) return 0;
      return session.rttMs * 0.5 + cfg.interpolationDelayMs;
    };

    // 60 / 20 = every third tick. Integer by construction so the send cadence is even
    // rather than beating against the tick rate.
    this.snapshotEveryTicks = Math.max(1, Math.round(60 / cfg.snapshotHz));

    for (let i = 0; i < 64; i++) this.entities.push(makeEntitySnapshot());

    this.loop = new ServerLoop({
      tick: (tickIndex) => this.tick(tickIndex),
      shouldContinue: () => !this.stopping,
    });

    this.wss = new WsServer({
      port: cfg.port,
      host: cfg.host,
      tlsCertPath: cfg.tlsCertPath,
      tlsKeyPath: cfg.tlsKeyPath,
      conditions: cfg.conditions,
      onConnection: (link) => this.accept(link),
    });
  }

  async start(): Promise<void> {
    await this.wss.listen();
    log.info(`listening — ${describeConfig(this.cfg)}`);
    this.lastMetricsMs = nowMs();
    this.loop.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.loop.stop();
    for (const s of this.sessions) s.close('server shutting down');
    this.sessions.length = 0;
    this.match.dispose();
    await this.wss.close();
  }

  get jitter(): TickJitter {
    return this.loop.jitter();
  }

  // -- connections ------------------------------------------------------------

  private accept(link: WsLink): void {
    const session = new Session(
      link,
      {
        onJoin: (s, name) => {
          const player = this.match.addPlayer(name);
          if (player === null) return null;
          this.encoders.set(player.entityId, new SnapshotEncoder());
          // The welcome carries the entity assignment and the server clock; the first
          // snapshot after it is a full one, because the new encoder has no baseline.
          queueMicrotask(() => s.welcome(this.cfg.mapId, this.cfg.modeId, this.cfg.snapshotHz));
          return player;
        },
        onLeave: (s, reason) => this.onLeave(s, reason),
      },
      () => this.loop.currentTick,
    );
    this.sessions.push(session);
  }

  private onLeave(session: Session, reason: string): void {
    const player = session.player;
    if (player !== null) {
      this.match.removePlayer(player.entityId);
      this.encoders.delete(player.entityId);
      session.player = null;
    }
    log.info(`connection from ${session.link.remoteAddress} closed: ${reason}`);
  }

  private sessionFor(entityId: number): Session | null {
    for (const s of this.sessions) {
      if (s.player !== null && s.player.entityId === entityId) return s;
    }
    return null;
  }

  // -- the tick ---------------------------------------------------------------

  private tick(tickIndex: number): void {
    // 1. Drain sockets. Commands land in input buffers before anything simulates.
    for (const s of this.sessions) s.receive();

    // 2. One authoritative step.
    this.match.step(tickIndex);

    // 3 and 4. State, then events.
    const sendSnapshot = tickIndex % this.snapshotEveryTicks === 0;
    if (sendSnapshot) {
      this.buildEntities();
      this.sendSnapshots(tickIndex);
    }
    this.sendEvents();

    // 5. Release whatever the per-link condition simulator has been holding.
    for (const s of this.sessions) {
      const link = s.link;
      if (isWsLink(link)) link.pumpOutbound();
    }

    // 6. Reap. Done last so a connection that died this tick still had its commands applied.
    for (const s of this.sessions) s.checkTimeout();
    this.reap();

    this.maybeLogMetrics();
  }

  /**
   * Flatten the roster into replicable records.
   *
   * Built once per snapshot tick and shared by every client: the *content* is the same for
   * everyone in TDM, and only the delta baseline differs. (M11's Ghost perk is where that
   * stops being true, and it will need a per-client filter here — S9 keeps it out of M10.)
   */
  private buildEntities(): void {
    let n = 0;

    for (const player of this.match.players) {
      const e = this.entities[n];
      if (e === undefined) break;
      writePlayer(e, player);
      n++;
    }

    for (const bot of this.match.bots.bots) {
      const e = this.entities[n];
      if (e === undefined) break;
      writeBot(e, bot);
      n++;
    }

    this.entityCount = n;
  }

  private sendSnapshots(tickIndex: number): void {
    const flow = this.match.flow;
    const mode = this.match.mode;

    for (const session of this.sessions) {
      const player = session.player;
      if (player === null || session.closed) continue;
      const encoder = this.encoders.get(player.entityId);
      if (encoder === undefined) continue;

      const h = this.header;
      h.serverTick = tickIndex;
      h.ackSeq = player.ackSeq;
      h.ackTick = player.ackTick;
      h.scoreA = mode.teamScore('A');
      h.scoreB = mode.teamScore('B');
      h.timeLeft = Math.round(flow.secondsRemaining);
      h.flags =
        (this.match.inputFrozen ? SFlag.InputFrozen : 0) | (flow.isOver ? SFlag.MatchOver : 0);
      h.starvation = player.input.takeStarvation();
      h.phase = phaseIndex(flow.currentPhase);
      h.phaseSeconds = flow.phaseSecondsRemaining;
      h.round = flow.round;

      const frame = encoder.encode(
        h,
        session.ackedSnapshot,
        // The owner block is this client's own authoritative sim state, at full precision.
        // A dead player still gets one: their corpse is still being simulated and their
        // client is still predicting it.
        player.simState,
        this.entities,
        this.entityCount,
      );
      if (frame.length === 0) continue;
      session.lastSnapshotId = h.snapshotId;
      session.send(frame);
    }
  }

  private sendEvents(): void {
    const frame = this.match.outgoing.finish();
    if (frame === null) return;
    for (const session of this.sessions) {
      if (session.player === null || session.closed) continue;
      session.send(frame);
    }
  }

  private reap(): void {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      if (s === undefined) continue;
      if (!s.closed) continue;
      // `close` already ran `onLeave`, which removed the entity. This only drops the
      // now-inert session object so the per-tick loops stay short.
      if (s.player !== null) {
        this.match.removePlayer(s.player.entityId);
        this.encoders.delete(s.player.entityId);
        s.player = null;
      }
      this.sessions.splice(i, 1);
    }
  }

  /**
   * Structured metrics, on an interval (S7).
   *
   * S7 asks for tick jitter, connected clients, bytes per client, dropped commands and
   * validation rejections by reason, *"exposed on a local admin endpoint or in structured
   * logs"*. Logs, not an endpoint: an admin port on an internet-facing process is one more
   * thing to secure, and the log is already structured, already collected and already the
   * thing somebody reads when a match went wrong.
   */
  private maybeLogMetrics(): void {
    if (this.cfg.metricsSeconds <= 0) return;
    const now = nowMs();
    if (now - this.lastMetricsMs < this.cfg.metricsSeconds * 1000) return;
    this.lastMetricsMs = now;

    const j = this.loop.jitter();
    const clients = this.sessions
      .filter((s) => s.player !== null)
      .map((s) => {
        const encoder = s.player === null ? undefined : this.encoders.get(s.player.entityId);
        const buffer = s.player?.input.stats();
        return {
          entity: s.player?.entityId ?? -1,
          name: s.displayName,
          rttMs: round(s.rttMs),
          jitterMs: round(s.jitterMs),
          bytesIn: s.link.bytesIn,
          bytesOut: s.link.bytesOut,
          cmdsAccepted: s.commandsAccepted,
          cmdsRejected: s.commandsRejected,
          cmdsRepeated: buffer?.repeated ?? 0,
          cmdsOutOfWindow: buffer?.outOfWindow ?? 0,
          snapshotBytesMean: round(encoder?.meanBytes ?? 0),
          rejects: s.rejects.report(),
        };
      });

    metric('server', 'metrics', {
      tick: this.loop.currentTick,
      simMsMean: round(this.loop.meanSimMs),
      jitterP50: j.p50,
      jitterP99: j.p99,
      ticksLate: j.late,
      ticksDropped: j.dropped,
      hz: j.hz,
      clients: clients.length,
      bots: this.match.bots.bots.length,
      rewindMeanMs: round(this.match.rewind.meanAppliedMs),
      rewindClamped: this.match.rewind.clampedShots,
      perClient: clients,
    });
  }
}

// -- entity flattening --------------------------------------------------------

function writePlayer(e: EntitySnapshot, p: NetPlayer): void {
  const sim = p.controller.sim;
  const weapon = p.weapons.weapon;
  e.entityId = p.entityId;
  e.displayName = p.displayName;
  e.x = sim.x;
  e.y = sim.y;
  e.z = sim.z;
  e.yaw = sim.yaw;
  e.pitch = sim.pitch;
  e.vx = sim.vx;
  e.vz = sim.vz;
  e.stance = sim.stance;
  e.heightScale = p.rig.heightScale;
  e.health = clampByte(p.health.current);
  e.weaponIndex = weaponIndexOf(p.weapons.definition.id);
  e.flags =
    (p.alive ? EFlag.Alive : 0) |
    (isDown(p.lastButtons, Btn.Fire) ? EFlag.Firing : 0) |
    (weapon.reloading ? EFlag.Reloading : 0) |
    (weapon.adsFraction > 0.5 ? EFlag.Ads : 0) |
    (sim.sprintActive || sim.tacSprintActive ? EFlag.Sprinting : 0) |
    (sim.grounded ? EFlag.Grounded : 0) |
    (p.team === 'B' ? EFlag.TeamB : 0);
  copyVisual(e, p.visual);
}

function writeBot(e: EntitySnapshot, b: Bot): void {
  const sim = b.controller.sim;
  const weapon = b.weapons.weapon;
  e.entityId = b.entityId;
  e.displayName = b.displayName;
  e.x = sim.x;
  e.y = sim.y;
  e.z = sim.z;
  e.yaw = sim.yaw;
  e.pitch = sim.pitch;
  e.vx = sim.vx;
  e.vz = sim.vz;
  e.stance = sim.stance;
  e.heightScale = b.rig.heightScale;
  e.health = clampByte(b.health.current);
  e.weaponIndex = weaponIndexOf(b.weapons.definition.id);
  e.flags =
    (b.health.alive ? EFlag.Alive : 0) |
    (isDown(b.lastCommand.buttons, Btn.Fire) ? EFlag.Firing : 0) |
    (weapon.reloading ? EFlag.Reloading : 0) |
    (weapon.adsFraction > 0.5 ? EFlag.Ads : 0) |
    (sim.sprintActive || sim.tacSprintActive ? EFlag.Sprinting : 0) |
    (sim.grounded ? EFlag.Grounded : 0) |
    EFlag.Bot |
    (b.team === 'B' ? EFlag.TeamB : 0);
  copyVisual(e, b.visual);
}

/**
 * The M3 visual serials, verbatim.
 *
 * Directions become a single angle on the wire: a fall or a flinch only ever uses the
 * horizontal direction, so two components carrying a normalised vector is two bytes spent
 * saying what one angle says exactly.
 */
function copyVisual(
  e: EntitySnapshot,
  v: { deathSerial: number; deathDirX: number; deathDirZ: number; spawnSerial: number; flinchSerial: number; flinchDirX: number; flinchDirZ: number },
): void {
  e.deathSerial = v.deathSerial;
  e.deathAngle = Math.atan2(v.deathDirX, v.deathDirZ);
  e.spawnSerial = v.spawnSerial;
  e.flinchSerial = v.flinchSerial;
  e.flinchAngle = Math.atan2(v.flinchDirX, v.flinchDirZ);
}

function clampByte(v: number): number {
  const i = Math.round(v);
  return i < 0 ? 0 : i > 255 ? 255 : i;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** `pumpOutbound` is a `WsLink` concern, not part of the `INetLink` contract. */
function isWsLink(link: unknown): link is WsLink {
  return typeof (link as { pumpOutbound?: unknown }).pumpOutbound === 'function';
}
