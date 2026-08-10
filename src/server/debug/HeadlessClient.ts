import { createGameBus, type GameBus } from '../../shared/core/Events';
import { Btn, CommandRing, type InputCommand } from '../../shared/core/InputCommand';
import { DT } from '../../shared/core/Loop';
import { Rng } from '../../shared/core/Rng';
import { simSin } from '../../shared/core/SimMath';
import { NetClient, type NetClientStats } from '../../shared/net/NetClient';
import type { NetConditions } from '../../shared/net/NetSim';
import { DEFAULT_INTERPOLATION_DELAY_MS, makeInterpolatedPose } from '../../shared/net/Interpolation';
import { EFlag } from '../../shared/net/Snapshot';
import {
  cloneMovementConfig,
  DEFAULT_MOVEMENT_CONFIG,
} from '../../shared/player/MovementConfig';
import { PlayerController } from '../../shared/player/PlayerController';
import { findMap } from '../../shared/modes/ModeRegistry';
import { loadMapCollision } from '../../shared/world/MapLoader';
import { NodeLink } from './NodeLink';

/**
 * A client with no browser (M10, S7).
 *
 * Runs the **real** client netcode — `NetClient`, `Prediction`, `ClockSync`,
 * `EntityInterpolator` — against a real socket, driven by a scripted input pattern instead of
 * a keyboard. What it does not have is a renderer, an audio graph or a viewmodel, none of
 * which affect a single number this milestone is measured on.
 *
 * ## What it is for
 *
 * Three things, and they are the reason it was worth building before the browser client:
 *
 * 1. **Verification.** S8's criteria 4, 5, 6, 10 and 12 are all measurements, and a
 *    measurement taken by hand in a browser is a measurement taken once. This takes them
 *    repeatedly and identically.
 * 2. **Soak.** S7 asks for a networked match that can be left running unattended.
 * 3. **Proving the prediction code is runtime-agnostic.** If `NetClient` ever reaches for a
 *    browser API, this stops compiling — which is a better guarantee than a rule.
 *
 * ## The input script
 *
 * Deliberately not a `BotBrain`. A bot's job is to play well; this one's job is to exercise
 * the netcode, which means doing the things that are *hard* to predict and replicate:
 * strafing hard enough that lag compensation matters, jumping, crouching, sprinting into
 * walls, and firing in bursts. It is seeded, so two runs at different simulated latencies are
 * driving the identical input and their numbers are comparable.
 */

export type ClientBehaviour = 'strafe' | 'idle' | 'runner' | 'shooter' | 'seeker';

export interface HeadlessClientOptions {
  readonly url: string;
  readonly name: string;
  readonly mapId: string;
  readonly conditions: NetConditions;
  readonly behaviour: ClientBehaviour;
  readonly seed: number;
  /** Ask the server for the rewind debug feed. */
  readonly wantRewindDebug?: boolean;
}

export interface HeadlessClientReport {
  readonly name: string;
  readonly entityId: number;
  readonly state: string;
  readonly closeReason: string;
  readonly stats: NetClientStats;
  readonly mispredictions: number;
  readonly comparisons: number;
  readonly mispredictionP50: number;
  readonly mispredictionP99: number;
  readonly maxReplayDepth: number;
  readonly ticksSimulated: number;
  /** Damage events in which this client was the shooter. */
  readonly hitsDealt: number;
  readonly shotsFired: number;
  readonly killsDealt: number;
  readonly deaths: number;
  /** Remote entities currently tracked. */
  readonly remotes: number;
  /** Deaths this client has been through. */
  readonly deathCycles: number;
  /**
   * Metres travelled **since the most recent respawn**.
   *
   * The unattended detector for a frozen player. A client that dies and comes back unable to
   * move looks completely healthy on every other number here — it is connected, its RTT is
   * fine, it is receiving snapshots and mispredicting nothing — because standing still is
   * something a client does correctly. This is the one figure that goes to zero and stays
   * there, which is exactly the M10 playtest bug.
   */
  readonly metresSinceRespawn: number;
}

export class HeadlessClient {
  readonly link: NodeLink;
  readonly net: NetClient;
  readonly bus: GameBus = createGameBus();

  private readonly controller: PlayerController;
  private readonly ring = new CommandRing(64);
  private readonly rng: Rng;
  private readonly opts: HeadlessClientOptions;
  private readonly pose = makeInterpolatedPose();

  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private ticks = 0;

  /** Distance to the nearest enemy at the last aim update, metres. */
  private targetDistance = Infinity;

  private hitsDealt = 0;
  private shotsFired = 0;
  private killsDealt = 0;
  private deaths = 0;

  /** Live state of this client's own entity, from the snapshot. */
  private alive = true;
  private deathCycles = 0;
  private metresSinceRespawn = 0;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;

  constructor(opts: HeadlessClientOptions) {
    this.opts = opts;
    this.rng = new Rng(opts.seed);

    // The same collision world the server loaded, from the same shared loader. Prediction
    // needs it: `PlayerController.step` sweeps a capsule against it, and a client predicting
    // against different geometry would mispredict on every wall.
    const map = findMap(opts.mapId);
    const world = loadMapCollision(map.def).collision;

    const movement = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
    this.controller = new PlayerController(movement, world, this.bus, 0);

    this.link = new NodeLink(opts.url, opts.conditions, opts.seed);
    this.net = new NetClient({
      link: this.link,
      controller: this.controller,
      sample: (tick) => this.sample(tick),
      events: {
        onDamage: (e) => {
          if (e.sourceId === this.net.entityId) {
            this.hitsDealt++;
            if (e.lethal) this.killsDealt++;
          }
          if (e.targetId === this.net.entityId && e.lethal) this.deaths++;
        },
        onFired: (e) => {
          if (e.sourceId === this.net.entityId) this.shotsFired++;
        },
      },
      displayName: opts.name,
      wantRewindDebug: opts.wantRewindDebug,
    });

    // No `DamageSystem` here, deliberately. This client resolves no damage — the server does,
    // and a client-side damage system would be a second opinion on a question with exactly
    // one authority (S4.9). Hits arrive as replicated `damage.dealt` events and are counted.
  }

  async connect(): Promise<void> {
    await this.link.open();
    this.net.connect();
  }

  /**
   * Whether the server ever told this client its match was over.
   *
   * Assert on it **per match, not latched once** — a churn run plays several, and one silent
   * ending among four is still the bug.
   */
  get sawMatchEnd(): boolean {
    return this.net.sawMatchOver;
  }

  /** One update. Call at roughly frame rate. */
  update(): void {
    const steps = this.net.update();
    this.ticks += steps;
    this.readOwnEntity();
  }

  disconnect(clean: boolean): void {
    if (clean) this.net.disconnect('done');
    else this.link.terminate();
  }

  report(): HeadlessClientReport {
    const p = this.net.prediction.percentiles();
    return {
      name: this.opts.name,
      entityId: this.net.entityId,
      state: this.net.state,
      closeReason: this.net.closeReason,
      stats: this.net.stats,
      mispredictions: this.net.prediction.stats.mispredictions,
      comparisons: this.net.prediction.stats.comparisons,
      mispredictionP50: round(p.p50),
      mispredictionP99: round(p.p99),
      maxReplayDepth: this.net.prediction.stats.maxReplayDepth,
      ticksSimulated: this.ticks,
      hitsDealt: this.hitsDealt,
      shotsFired: this.shotsFired,
      killsDealt: this.killsDealt,
      deaths: this.deaths,
      remotes: this.net.remotes.size,
      deathCycles: this.deathCycles,
      metresSinceRespawn: Math.round(this.metresSinceRespawn * 10) / 10,
    };
  }

  // -- the input script -------------------------------------------------------

  /**
   * Produce this tick's command.
   *
   * The shape of the motion matters more than its quality. Strafing is the case S4.13's
   * half-metre error was measured against, so the default behaviour reverses direction on a
   * cadence fast enough that lag compensation is doing real work rather than correcting a
   * body that was standing still.
   */
  private sample(tick: number): InputCommand {
    const cmd = this.ring.next();
    cmd.seq = this.seq++;
    cmd.tickIndex = tick;
    cmd.sampledAtMs = 0;

    let moveX = 0;
    let moveZ = 0;
    let buttons = 0;

    if (this.alive) {
      switch (this.opts.behaviour) {
        case 'strafe': {
          // Reverse every ~0.6 s. Fast enough to matter, slow enough to reach full speed.
          moveX = simSin(tick / 36) > 0 ? 1 : -1;
          // Turn slowly so the view is never static, which exercises the yaw quantisation
          // and the validation's yaw-rate check on every tick rather than never.
          this.yaw += 0.004;
          break;
        }
        case 'runner': {
          moveZ = 1;
          buttons |= Btn.Sprint;
          this.yaw += 0.02;
          // Jump occasionally: airborne state has its own speed cap and its own replay path.
          if (tick % 90 === 0) buttons |= Btn.Jump;
          if (tick % 240 < 30) buttons |= Btn.Crouch;
          break;
        }
        case 'shooter': {
          moveX = simSin(tick / 48) > 0 ? 0.7 : -0.7;
          // Aim at the nearest visible remote and hold the trigger in bursts.
          this.aimAtNearest();
          if (tick % 30 < 12) buttons |= Btn.Fire;
          if (tick % 600 === 0) buttons |= Btn.Reload;
          break;
        }

        /**
         * Close to engagement range, then hold it and shoot.
         *
         * The hit-registration experiment (S8.6) needs the shooter to actually be able to see
         * the target, and two clients dropped on opposite team spawns of Foundry never can —
         * the first run of the test scored 0/38 at every latency for exactly that reason, and
         * the number was measuring the map rather than the netcode.
         *
         * So this walks toward the nearest enemy until it is at `ENGAGE_RANGE_M` and then
         * stops advancing and strafes. Holding a known range is also what makes the S8.7 TTK
         * comparison meaningful, since damage falls off with distance.
         */
        case 'seeker': {
          this.aimAtNearest();
          if (this.targetDistance > ENGAGE_RANGE_M + 2) {
            moveZ = 1;
          } else if (this.targetDistance < ENGAGE_RANGE_M - 2) {
            moveZ = -1;
          }
          moveX = simSin(tick / 40) > 0 ? 0.6 : -0.6;
          // Only shoot once there is something in range to shoot at. A burst cadence rather
          // than a held trigger, so recoil recovers between groups the way a player's does.
          if (this.targetDistance < 25 && tick % 24 < 10) buttons |= Btn.Fire;
          break;
        }
        case 'idle':
          break;
      }
    }

    this.pitch += (this.rng.spread() * 0.002);
    if (this.pitch > 1.4) this.pitch = 1.4;
    if (this.pitch < -1.4) this.pitch = -1.4;

    cmd.moveX = moveX;
    cmd.moveZ = moveZ;
    cmd.yaw = wrap(this.yaw);
    cmd.pitch = this.pitch;
    cmd.buttons = buttons;
    return cmd;
  }

  /**
   * Point at the nearest living remote entity.
   *
   * Read out of the **interpolation buffer at the client's own render time**, which is the
   * point: this is exactly what a human aims at, so a shot fired here is a shot the server
   * must rewind to make land. Aiming at the entity's newest replicated position instead would
   * quietly test a case no real player is ever in.
   */
  private aimAtNearest(): void {
    const renderMs = this.net.renderTimeMs(DEFAULT_INTERPOLATION_DELAY_MS);
    const sim = this.controller.sim;
    let bestDistance = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;

    for (const [id, interp] of this.net.remotes) {
      if (id === this.net.entityId) continue;
      if ((interp.latest.flags & EFlag.Alive) === 0) continue;
      interp.sample(renderMs, this.pose);
      const dx = this.pose.x - sim.x;
      const dz = this.pose.z - sim.z;
      const d = Math.hypot(dx, dz);
      if (d < bestDistance) {
        bestDistance = d;
        bestX = this.pose.x;
        bestY = this.pose.y;
        bestZ = this.pose.z;
      }
    }

    this.targetDistance = bestDistance;
    if (bestDistance === Infinity) {
      this.yaw += 0.01;
      return;
    }

    const dx = bestX - sim.x;
    const dz = bestZ - sim.z;
    // Chest height, matching where `HitboxRig`'s torso box actually is.
    const dy = bestY + 1.26 - (sim.y + sim.eyeHeight);
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  /**
   * Track our own liveness, and how far we have moved since coming back.
   *
   * The distance is measured off the *predicted* controller rather than the snapshot,
   * because that is what the player would see and it is what stops moving when the input
   * pipeline is suppressed.
   */
  private readOwnEntity(): void {
    const own = this.net.remotes.get(this.net.entityId);
    if (own === undefined) return;
    const alive = (own.latest.flags & EFlag.Alive) !== 0;

    if (alive && !this.alive) {
      // Respawned: start the odometer again from wherever the server put us.
      this.deathCycles++;
      this.metresSinceRespawn = 0;
      this.lastX = Number.NaN;
      this.lastZ = Number.NaN;
    }
    this.alive = alive;

    if (!alive) return;
    const sim = this.controller.sim;
    if (Number.isFinite(this.lastX) && Number.isFinite(this.lastZ)) {
      const step = Math.hypot(sim.x - this.lastX, sim.z - this.lastZ);
      // Ignore the metre-scale jump a correction can produce; this is an odometer, not a
      // displacement, and a teleport is not distance the player walked.
      if (step < 1) this.metresSinceRespawn += step;
    }
    this.lastX = sim.x;
    this.lastZ = sim.z;
  }
}

/**
 * Range the seeker holds, metres.
 *
 * Ten, because S8.7 specifies TTK *"at 10 m"* and using the same distance for both
 * measurements means the hit-rate number and the TTK number describe the same engagement.
 */
const ENGAGE_RANGE_M = 10;

function wrap(a: number): number {
  const t = Math.PI * 2;
  let v = a % t;
  if (v > Math.PI) v -= t;
  if (v < -Math.PI) v += t;
  return v;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Seconds one headless tick represents. Exported so the harness paces itself honestly. */
export const HEADLESS_DT = DT;
