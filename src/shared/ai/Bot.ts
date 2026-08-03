import { HitboxRig, HUMANOID_RIG } from '../combat/HitboxRig';
import type { DamageSystem } from '../combat/DamageSystem';
import { EV, type GameBus } from '../core/Events';
import type { MutableInputCommand, InputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { Rng } from '../core/Rng';
import { Health, type HealthConfig } from '../player/Health';
import type { MovementConfig } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import type { CollisionWorld } from '../world/CollisionWorld';
import type { ViewmodelConfig } from '../weapons/ViewmodelConfig';
import type { WeaponDef } from '../weapons/WeaponDefs';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { BotBlackboard } from './BotBlackboard';
import { BotBrain, type BrainDeps } from './BotBrain';
import { BotMesh, DEATH_VARIANTS, type BotMaterials } from '../../client/ai/BotMesh';
import type { BotState } from './BotStates';
import type { BotTeam, Combatant } from './Combatant';
import { CombatBehaviour } from './CombatBehaviour';
import type { BotTier, PerceptionConfig, TierConfig, TierTable } from './DifficultyTiers';
import { Path, type PathClient } from './Pathing';
import { weaponProfileFor, type WeaponCombatProfile } from './WeaponProfile';

/**
 * One bot (brief S6.1).
 *
 * A bot is not a special case, and this file is where that stops being a slogan. It owns
 * the *same* three things the player owns — a `HitboxRig`, a `Health` and a
 * `WeaponSystem` — plus a real `PlayerController`. The only difference between a bot and
 * the human is where the `InputCommand` comes from: the player's arrives from
 * `core/Input`, and a bot's is written by its `BotBrain`.
 *
 * Everything falls out of that. Bots collide with the swept capsule, obey the same speed
 * table and the same 8.2 m/s bound, step up the same 0.35 m, make the same footstep
 * sounds through the same positional audio, and take and deal damage through the one door
 * in `DamageSystem` — so time-to-kill is symmetric by construction rather than by two
 * implementations agreeing. It also means the netcode seam in `INetworkTransport` is real:
 * a bot already *is* a remote command source.
 *
 * The recoil residual is the detail worth calling out. `WeaponSystem` hands back the
 * unrecovered part of each kick, and for the player that goes into the view angles. Here
 * it goes into the bot's aim, which is why a bot holding the trigger climbs off target and
 * has to fight its way back down — with exactly the numbers in the weapon def.
 */

export interface BotSpec {
  readonly entityId: number;
  readonly displayName: string;
  readonly team: BotTeam;
  readonly tier: BotTier;
  readonly seed: number;
}

export interface BotDeps {
  readonly world: CollisionWorld;
  readonly bus: GameBus;
  readonly damage: DamageSystem;
  readonly movement: MovementConfig;
  readonly healthConfig: HealthConfig;
  readonly weaponDef: WeaponDef;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly tiers: TierTable;
  readonly perceptionConfig: PerceptionConfig;
  readonly brain: BrainDeps;
  readonly materials: BotMaterials;
  /** Post-M8: Free-for-All draws every bot in the enemy colour. See `BotMesh`. */
  readonly hostileLook?: boolean;
}

const evBotState = { entityId: 0, from: 'IDLE' as BotState, to: 'IDLE' as BotState, tier: 'REGULAR' as BotTier };

export class Bot implements Combatant, PathClient {
  readonly entityId: number;
  readonly displayName: string;
  readonly team: BotTeam;
  readonly health: Health;
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly controller: PlayerController;
  readonly weapons: WeaponSystem;
  readonly blackboard = new BotBlackboard();
  readonly combat = new CombatBehaviour();
  readonly brain: BotBrain;
  readonly path = new Path();
  readonly mesh: BotMesh;
  readonly rng: Rng;

  /** Live-tunable: the debug panel can promote a bot mid-match. */
  tierName: BotTier;

  /** Seconds until this bot may respawn. Owned by `BotDirector`. */
  respawnTimer = 0;
  /** Seconds since the fall started, so the corpse is not recycled mid-animation. */
  deadTime = 0;

  // -- match statistics, for the acceptance measurements -------------------
  kills = 0;
  deaths = 0;
  shotsFired = 0;
  shotsHit = 0;
  damageDealt = 0;

  private readonly deps: BotDeps;
  private readonly cmd: MutableInputCommand = {
    seq: 0,
    tickIndex: 0,
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    sampledAtMs: 0,
  };
  private readonly residual = { yaw: 0, pitch: 0 };

  /** Interpolation snapshots. Bots move in the sim and render between ticks. */
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private prevYaw = 0;
  private prevScale = 1;
  private currX = 0;
  private currY = 0;
  private currZ = 0;
  private currYaw = 0;
  private currScale = 1;

  private seq = 0;
  private alive = true;

  constructor(spec: BotSpec, deps: BotDeps) {
    this.entityId = spec.entityId;
    this.displayName = spec.displayName;
    this.team = spec.team;
    this.tierName = spec.tier;
    this.deps = deps;

    this.rng = new Rng(spec.seed);
    this.health = new Health(deps.healthConfig);
    this.controller = new PlayerController(deps.movement, deps.world, deps.bus, spec.entityId);
    this.weapons = new WeaponSystem(
      deps.weaponDef,
      // No secondary: nothing in `ai/` swaps weapons, and a holstered pistol a bot will
      // never draw is a second magazine to keep in sync for nothing.
      null,
      deps.world,
      deps.damage,
      deps.bus,
      deps.viewmodelConfig,
      deps.movement.walkSpeed,
      spec.entityId,
      'world',
    );
    // Separate stream from the player's and from every other bot's, so two bots firing at
    // the same target do not share a spread sequence.
    this.weapons.reseed(spec.seed ^ 0x5bf0_3d17);
    this.brain = new BotBrain(deps.brain);
    this.mesh = new BotMesh(spec.team, deps.materials, deps.hostileLook === true);
  }

  // -- Combatant ------------------------------------------------------------

  get px(): number {
    return this.controller.sim.x;
  }
  get py(): number {
    return this.controller.sim.y;
  }
  get pz(): number {
    return this.controller.sim.z;
  }
  get yaw(): number {
    return this.controller.sim.yaw;
  }
  get vx(): number {
    return this.controller.sim.vx;
  }
  get vz(): number {
    return this.controller.sim.vz;
  }
  get eyeHeight(): number {
    return this.controller.sim.eyeHeight;
  }
  get aimHeight(): number {
    // The chest box of the rig it is actually wearing, so aiming and hitting agree.
    return 1.26 * this.rig.heightScale;
  }
  get quiet(): boolean {
    const stance = this.controller.sim.stance;
    return stance === 'CROUCH' || stance === 'SLIDE';
  }
  get participating(): boolean {
    return this.alive;
  }
  get glinting(): boolean {
    return this.weapons.glinting;
  }

  // -- PathClient -----------------------------------------------------------

  get pathClientId(): number {
    return this.entityId;
  }

  onPathReady(found: boolean): void {
    this.path.cursor = 0;
    if (!found) this.brain.onPathFailed();
  }

  // -- state the brain reads ------------------------------------------------

  get tier(): TierConfig {
    return this.deps.tiers[this.tierName];
  }

  /**
   * How this bot should fight with what it is carrying (M7).
   *
   * Derived rather than stored: `applyWeaponDef` can change the weapon under a live bot for
   * a controlled measurement, and a cached profile would then describe the previous gun.
   */
  get weaponProfile(): WeaponCombatProfile {
    return weaponProfileFor(this.weapons.definition.class);
  }

  get state(): BotState {
    return this.brain.state;
  }

  get speed(): number {
    return this.controller.sim.speed;
  }

  get grounded(): boolean {
    return this.controller.sim.grounded;
  }

  get magazine(): number {
    return this.weapons.weapon.mag;
  }

  get reserve(): number {
    return this.weapons.weapon.reserve;
  }

  get reloading(): boolean {
    return this.weapons.weapon.reloading;
  }

  get canFire(): boolean {
    return this.weapons.weapon.canFire;
  }

  get healthFraction(): number {
    return this.health.fraction;
  }

  /** The command this bot produced on the last tick. Read by the debug panel. */
  get lastCommand(): InputCommand {
    return this.cmd;
  }

  // -- lifecycle ------------------------------------------------------------

  spawn(x: number, y: number, z: number, yaw: number): void {
    // `DEAD -> IDLE` is the single door back into the machine (S6.2), so a respawn is
    // announced as the transition it is. Setting the brain's state silently would leave
    // the one legal edge out of DEAD decorative and invisible to the debug overlay.
    const previous = this.brain.state;

    this.alive = true;
    this.health.reset();
    this.controller.spawn(x, y, z, yaw);
    this.weapons.reset();
    this.blackboard.reset();
    this.blackboard.noiseCursor = this.deps.brain.perception.noise.currentSerial;
    this.combat.reset(yaw, 0);
    this.brain.reset();
    this.path.clear();
    this.respawnTimer = 0;
    this.deadTime = 0;
    this.mesh.endDeath();
    this.mesh.setVisible(true);
    this.rig.heightScale = 1;
    this.rig.setTransform(x, y, z, yaw);
    this.prevX = x;
    this.prevY = y;
    this.prevZ = z;
    this.prevYaw = yaw;
    this.currX = x;
    this.currY = y;
    this.currZ = z;
    this.currYaw = yaw;
    this.prevScale = 1;
    this.currScale = 1;

    if (previous !== 'IDLE') this.noteStateChange(previous, 'IDLE');
  }

  /**
   * The bot died. `dx/dz` is the direction the killing round was travelling, which is what
   * gives the fall its direction (S6.8).
   */
  onKilled(dx: number, dz: number, respawnSeconds: number): void {
    if (!this.alive) return;
    this.alive = false;
    this.deaths++;
    this.respawnTimer = respawnSeconds;
    this.deadTime = 0;
    this.path.clear();
    this.deps.brain.cover.release(this.entityId);
    this.deps.brain.pathfinder.cancel(this);
    this.mesh.beginDeath(dx, dz, this.rng.int(0, DEATH_VARIANTS));
    this.noteStateChange(this.brain.state, 'DEAD');
    this.brain.state = 'DEAD';
  }

  /** A non-fatal hit: flinch away from the impact and remember the direction (S6.8). */
  onHurt(fromX: number, fromZ: number, dx: number, dz: number, amount: number): void {
    this.blackboard.noteDamage(fromX, fromZ, this.px, this.pz, amount);
    // Being shot from somewhere you were not looking is a reason to look there.
    if (!this.blackboard.hasLos) {
      this.blackboard.noteInvestigate(fromX, this.py + 1.2, fromZ);
    }
    this.mesh.flinch(dx, dz);
  }

  noteStateChange(from: BotState, to: BotState): void {
    evBotState.entityId = this.entityId;
    evBotState.from = from;
    evBotState.to = to;
    evBotState.tier = this.tierName;
    this.deps.bus.emit(EV.BotStateChanged, evBotState);
  }

  // -- per-tick -------------------------------------------------------------

  /** Snapshot the render pose and age everything that ages. Every tick, alive or not. */
  beginTick(): void {
    this.prevX = this.currX;
    this.prevY = this.currY;
    this.prevZ = this.currZ;
    this.prevYaw = this.currYaw;
    this.prevScale = this.currScale;

    this.health.step();

    if (!this.alive) {
      this.deadTime += DT;
      if (this.respawnTimer > 0) this.respawnTimer = Math.max(0, this.respawnTimer - DT);
      return;
    }
    this.blackboard.age(this.deps.perceptionConfig.confidenceDecay, this.deps.perceptionConfig.noiseMemory);
  }

  /**
   * Produce this tick's command and advance the simulation with it.
   *
   * `frozen` is the pre-match countdown (post-M8). The brain still steers — the command it
   * writes is the command it wanted — and then the movement axes and every action bit are
   * stripped before the controller sees it. Doing it here rather than skipping `advance`
   * outright matters: the controller still runs, so gravity, the ground probe and the render
   * snapshots all keep ticking, and a bot standing on a ramp during the countdown does not
   * hang in the air. The look angles survive, so a frozen bot still tracks what it can see —
   * which is what makes the moment the round goes live read as a starting gun rather than a
   * room full of statues booting up.
   */
  advance(tick: number, nowMs: number, roster: readonly Bot[], frozen = false): void {
    if (!this.alive) return;

    const cmd = this.cmd;
    cmd.seq = this.seq++;
    cmd.tickIndex = tick;
    cmd.sampledAtMs = nowMs;
    this.brain.steer(this, cmd, roster);
    if (frozen) {
      cmd.moveX = 0;
      cmd.moveZ = 0;
      cmd.buttons = 0;
    }

    this.controller.step(cmd);
    const sim = this.controller.sim;
    this.weapons.step(cmd, sim);

    // The unrecovered half of each kick is a real aim change for a bot too (S6.4).
    if (this.weapons.takeViewResidual(this.residual)) {
      this.combat.applyRecoilResidual(this.residual.yaw, this.residual.pitch);
    }

    // The rig tracks the *simulation* pose on the tick the shot resolves, and compresses
    // with the stance so cover actually covers.
    this.currScale = sim.capsuleHeight / Math.max(this.deps.movement.standHeight, 1e-3);
    this.rig.heightScale = this.currScale;
    this.rig.setTransform(sim.x, sim.y, sim.z, sim.yaw);

    this.currX = sim.x;
    this.currY = sim.y;
    this.currZ = sim.z;
    this.currYaw = sim.yaw;
  }

  /** Render pass: interpolate the pose and advance the death / flinch animations. */
  updateVisual(alpha: number, dt: number): void {
    this.mesh.advance(dt);
    const yawDelta = shortestAngle(this.prevYaw, this.currYaw);
    this.mesh.apply(
      this.prevX + (this.currX - this.prevX) * alpha,
      this.prevY + (this.currY - this.prevY) * alpha,
      this.prevZ + (this.currZ - this.prevZ) * alpha,
      this.prevYaw + yawDelta * alpha,
      this.prevScale + (this.currScale - this.prevScale) * alpha,
    );
  }

  /** Interpolated render position, for debug labels and the minimap later. */
  renderX(alpha: number): number {
    return this.prevX + (this.currX - this.prevX) * alpha;
  }

  renderY(alpha: number): number {
    return this.prevY + (this.currY - this.prevY) * alpha;
  }

  renderZ(alpha: number): number {
    return this.prevZ + (this.currZ - this.prevZ) * alpha;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}
