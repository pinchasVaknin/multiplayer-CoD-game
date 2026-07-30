import * as THREE from 'three';
import type { SchedulerConfig } from './ai/AiScheduler';
import { BotDirector } from './ai/BotDirector';
import type { BotTeam } from './ai/Combatant';
import type { BotTier, PerceptionConfig, TierTable } from './ai/DifficultyTiers';
import { PlayerCombatant } from './ai/PlayerCombatant';
import { makeSpawnChoice, type SpawnChoice } from './ai/SpawnSelector';
import { DamageSystem, makeDamageRequest, PLAYER_ENTITY_ID, type DamageRequest } from './combat/DamageSystem';
import type { HitZone } from './combat/HitboxRig';
import { TargetRange } from './combat/TargetRange';
import { EV, type GameBus } from './core/Events';
import type { Input } from './core/Input';
import type { InputCommand } from './core/InputCommand';
import { DT } from './core/Loop';
import { angleDelta, DEG2RAD } from './core/MathUtil';
import type { MapDef } from './world/maps/types';
import type { CameraRig } from './engine/CameraRig';
import { Fx } from './engine/Fx';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import { LatencyProbe } from './debug/LatencyProbe';
import { Health, type HealthConfig } from './player/Health';
import type { MovementConfig } from './player/MovementConfig';
import type { PlayerController } from './player/PlayerController';
import type { ViewmodelLayer } from './player/Viewmodel';
import { Hud, makeHudState, type HudState } from './ui/Hud';
import type { CollisionWorld } from './world/CollisionWorld';
import { makeRayHit, type RayHit } from './world/Geometry';
import { ViewmodelAnim, makeViewmodelDrive, type ViewmodelDrive } from './weapons/ViewmodelAnim';
import type { ViewmodelConfig } from './weapons/ViewmodelConfig';
import { WeaponAudio } from './weapons/WeaponAudio';
import type { WeaponDef } from './weapons/WeaponDefs';
import { buildWeaponModel, type WeaponModel } from './weapons/WeaponMesh';
import { WeaponSystem, type WeaponSnapshot } from './weapons/WeaponSystem';

/**
 * Composition root for the MATCH state.
 *
 * `Game.ts` is the state machine; this is everything a match is made of, in one place, so
 * that neither file drifts past the size the architecture allows. It owns the wiring —
 * and wiring is all it does. Every connection here is an EventBus subscription, because
 * S3 says systems must not reach into each other, and the systems that fire, resolve and
 * present a shot genuinely do not know about one another:
 *
 *   WeaponSystem --weapon.fired--> flash, tracer, gunshot, camera shake, latency probe
 *   Ballistics   --bullet.impact-> debris, decal, impact report
 *   DamageSystem --damage.dealt--> hitmarker, hit audio, damage numbers, target read-out
 *
 * That is also what lets the headless harness fire a full magazine with no renderer, no
 * audio context and no DOM: nothing downstream of the sim is required for the sim to run.
 */

export interface MatchDeps {
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly viewmodel: ViewmodelLayer;
  readonly cameraRig: CameraRig;
  readonly audio: ProceduralAudio;
  readonly input: Input;
  readonly world: CollisionWorld;
  readonly player: PlayerController;
  readonly movementConfig: MovementConfig;
  readonly weaponDef: WeaponDef;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly healthConfig: HealthConfig;
  readonly uiHost: HTMLElement;
  readonly anisotropy: number;
  /** M3: the director bakes a navmesh and reads `spawns` and `coverPoints` from this. */
  readonly mapDef: MapDef;
  readonly tiers: TierTable;
  readonly perceptionConfig: PerceptionConfig;
  readonly schedulerConfig: SchedulerConfig;
  readonly seed: number;
}

interface PendingNumber {
  x: number;
  y: number;
  z: number;
  amount: number;
  zone: HitZone;
}

const NUMBER_QUEUE = 8;

/** The player's side. Bots added to 'A' fight alongside them, 'B' against. */
export const PLAYER_TEAM: BotTeam = 'A';

/** Seconds the player spends dead. Matches the bots' timer, because it is the same rule. */
const PLAYER_RESPAWN_SECONDS = 4.5;

/** The default firefight: three alongside the player, four against. */
const DEFAULT_TEAM_A_BOTS = 3;
const DEFAULT_TEAM_B_BOTS = 4;

const DEFAULT_TIER_MIX: readonly BotTier[] = ['REGULAR', 'HARDENED', 'RECRUIT', 'REGULAR'];

/** Reusable position record for "where did that sound come from". Zero allocation. */
const sourceAt = { x: 0, y: 0, z: 0 };

export class Match {
  readonly damage: DamageSystem;
  readonly weapons: WeaponSystem;
  readonly range: TargetRange;
  readonly fx: Fx;
  readonly hud: Hud;
  readonly weaponAudio: WeaponAudio;
  readonly model: WeaponModel;
  readonly anim: ViewmodelAnim;
  readonly latency = new LatencyProbe();
  readonly playerHealth: Health;
  /**
   * The player, as the AI sees it. This replaces M2's local `PlayerTarget`: it is still
   * the same `Damageable` with the same rig, plus the team, facing and stance that
   * perception and spawn safety need. One object, so there is no second pose to drift.
   */
  readonly playerCombatant: PlayerCombatant;
  readonly bots: BotDirector;

  /** Interpolated weapon state for this frame. Read by Game for the camera. */
  readonly visual: WeaponSnapshot = {
    raise: 1,
    adsFraction: 0,
    visualPunch: 0,
    visualLateral: 0,
    aimPitch: 0,
    aimYaw: 0,
    reloadFraction: 0,
  };

  private readonly deps: MatchDeps;
  private readonly drive: ViewmodelDrive = makeViewmodelDrive();
  private readonly hudState: HudState = makeHudState();
  private readonly residual = { yaw: 0, pitch: 0 };
  private readonly selfDamage: DamageRequest;
  private readonly occlusionRay: RayHit = makeRayHit();
  private readonly projectScratch = new THREE.Vector3();
  private readonly numberQueue: PendingNumber[] = [];
  private numberCount = 0;

  private readonly spawnChoice: SpawnChoice = makeSpawnChoice();

  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;
  private shotSinceRender = false;
  private active = false;
  private playerDead = false;
  private playerRespawnTimer = 0;

  constructor(deps: MatchDeps) {
    this.deps = deps;

    this.damage = new DamageSystem(deps.bus);
    this.playerHealth = new Health(deps.healthConfig);
    this.playerCombatant = new PlayerCombatant(
      this.playerHealth,
      PLAYER_TEAM,
      deps.player,
      deps.movementConfig,
    );
    this.damage.register(this.playerCombatant);
    this.selfDamage = makeDamageRequest(deps.weaponDef);
    this.selfDamage.targetId = PLAYER_ENTITY_ID;
    this.selfDamage.sourceId = PLAYER_ENTITY_ID;

    this.weapons = new WeaponSystem(
      deps.weaponDef,
      deps.world,
      this.damage,
      deps.bus,
      deps.viewmodelConfig,
      deps.movementConfig.walkSpeed,
    );

    this.range = new TargetRange(this.damage, deps.bus, deps.healthConfig);
    deps.scene.add(this.range.group);

    // The director bakes the navmesh, so it is built once here rather than per match.
    this.bots = new BotDirector({
      world: deps.world,
      mapDef: deps.mapDef,
      bus: deps.bus,
      damage: this.damage,
      movement: deps.movementConfig,
      healthConfig: deps.healthConfig,
      weaponDef: deps.weaponDef,
      viewmodelConfig: deps.viewmodelConfig,
      tiers: deps.tiers,
      perceptionConfig: deps.perceptionConfig,
      scheduler: deps.schedulerConfig,
      player: this.playerCombatant,
      seed: deps.seed,
    });
    deps.scene.add(this.bots.group);

    this.fx = new Fx(deps.anisotropy);
    deps.scene.add(this.fx.group);

    this.model = buildWeaponModel(deps.anisotropy);
    deps.viewmodel.add(this.model.root);
    this.fx.attachMuzzle(this.model.muzzle);
    this.anim = new ViewmodelAnim(this.model);

    this.hud = new Hud(deps.uiHost);
    this.weaponAudio = new WeaponAudio(deps.audio);

    for (let i = 0; i < NUMBER_QUEUE; i++) {
      this.numberQueue.push({ x: 0, y: 0, z: 0, amount: 0, zone: 'torso' });
    }

    // Occlusion low-pass through the same spatial-hash raycaster the sim uses (S6.7).
    deps.audio.setOccluder((x, y, z) =>
      !deps.world.segmentClear(x, y, z, this.listenerX, this.listenerY, this.listenerZ, this.occlusionRay),
    );

    this.subscribe();
  }

  setActive(on: boolean): void {
    this.active = on;
    this.hud.setVisible(on);
    if (!on) return;
    this.anim.reset(this.deps.input.yaw, this.deps.input.pitch);
    // Deferred to the first time a match actually starts rather than done at construction:
    // the harness wants a different roster and gets to set it before anyone spawns.
    if (this.bots.botCount === 0) this.populateDefault();
  }

  /** The default firefight. The bot-match harness replaces this with its own roster. */
  populateDefault(): void {
    this.bots.populate(DEFAULT_TEAM_A_BOTS, DEFAULT_TEAM_B_BOTS, DEFAULT_TIER_MIX);
  }

  get isPlayerDead(): boolean {
    return this.playerDead;
  }

  get playerRespawnSeconds(): number {
    return this.playerRespawnTimer;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Debug hook: run real damage at the player so regeneration is exercised, not faked. */
  applySelfDamage(amount: number): void {
    const def = this.weapons.definition;
    this.selfDamage.weapon = def;
    this.selfDamage.zone = 'torso';
    // Solve for the request that produces exactly `amount` at the torso.
    this.selfDamage.distance = 0;
    this.selfDamage.penetrationRetain = Math.max(0, Math.min(1, amount / Math.max(def.damage.near, 1)));
    const sim = this.deps.player.sim;
    this.selfDamage.x = sim.x;
    this.selfDamage.y = sim.y + sim.eyeHeight;
    this.selfDamage.z = sim.z;
    this.damage.apply(this.selfDamage);
  }

  // -- loop -----------------------------------------------------------------

  /** One sim tick. Called from Game.simulate after the player has stepped. */
  simulate(cmd: InputCommand): void {
    this.playerHealth.step();
    // The rig follows the capsule on the *tick*, and before anything resolves a shot
    // against it, so a bot's round is tested against where the player was when it fired.
    this.playerCombatant.syncRig();

    if (!this.playerDead) {
      const sim = this.deps.player.sim;
      this.weapons.step(cmd, sim);

      // The residual half of each recoil kick is a real aim change, so it goes where mouse
      // movement goes rather than into a separate offset the player cannot fight.
      if (this.weapons.takeViewResidual(this.residual)) {
        this.deps.input.addViewOffset(this.residual.yaw, this.residual.pitch);
      }
    }

    this.range.step();
    this.bots.simulate(cmd.tickIndex, cmd.sampledAtMs);
    this.stepPlayerRespawn();
    this.latency.expire(performance.now());
  }

  /**
   * The player's side of S6.9. Same timer and the same spawn selector the bots use, so
   * "never within 15 m of a living enemy" is one rule with one implementation rather than
   * one for them and a different one for you.
   */
  private stepPlayerRespawn(): void {
    if (!this.playerDead) return;
    this.playerRespawnTimer = Math.max(0, this.playerRespawnTimer - DT);
    if (this.playerRespawnTimer > 0) return;
    this.respawnPlayer();
  }

  private respawnPlayer(): void {
    const choice = this.spawnChoice;
    if (this.bots.selectSpawn(PLAYER_TEAM, PLAYER_ENTITY_ID, choice)) {
      this.deps.player.spawn(choice.x, choice.y + 0.05, choice.z, choice.yaw);
      this.deps.input.setView(choice.yaw, 0);
    }
    this.playerHealth.reset();
    this.weapons.reset();
    this.playerCombatant.syncRig();
    this.playerDead = false;
    this.playerRespawnTimer = 0;
  }

  /**
   * Interpolate the weapon's visual state. Called before the camera is composed, because
   * the aim-recoil offset it produces is part of where the camera points.
   */
  sampleVisual(alpha: number): void {
    this.weapons.sample(alpha, this.visual);
  }

  /** Render pass. `yaw`/`pitch` already include the interpolated recoil offset. */
  render(alpha: number, camera: THREE.PerspectiveCamera, dt: number, yaw: number, pitch: number): void {
    const sim = this.deps.player.sim;
    const weapon = this.weapons.weapon;
    const def = weapon.definition;

    this.listenerX = camera.position.x;
    this.listenerY = camera.position.y;
    this.listenerZ = camera.position.z;

    const drive = this.drive;
    drive.raise = this.visual.raise;
    drive.adsFraction = this.visual.adsFraction;
    drive.reloading = weapon.reloading;
    drive.reloadFraction = this.visual.reloadFraction;
    drive.reloadEmpty = weapon.reloadEmpty;
    drive.visualPunch = this.visual.visualPunch;
    drive.visualLateral = this.visual.visualLateral;
    drive.tacSprint = sim.tacSprintActive;
    drive.slide = sim.slideActive;
    drive.bobPhase = sim.bobPhase;
    drive.speed = sim.speed;
    drive.speedRef = this.deps.movementConfig.sprintSpeed;
    drive.grounded = sim.grounded;
    drive.yaw = yaw;
    drive.pitch = pitch;
    this.anim.update(drive, this.deps.viewmodelConfig, dt);

    this.range.updateVisuals(alpha, camera);
    this.bots.updateVisuals(alpha, dt);
    this.fx.update(dt);

    // A dead player is not holding a rifle.
    this.model.root.visible = !this.playerDead;

    const state = this.hudState;
    state.mag = weapon.mag;
    state.reserve = weapon.reserve;
    state.magSize = def.magSize;
    state.spreadDeg = this.weapons.spreadDeg;
    state.adsFraction = this.visual.adsFraction;
    state.fovDeg = this.deps.cameraRig.fov;
    state.viewportHeight = window.innerHeight;
    state.reloading = weapon.reloading;
    state.reloadFraction = this.visual.reloadFraction;
    state.health = this.playerHealth.current;
    state.healthMax = this.playerHealth.max;
    state.dead = this.playerDead;
    state.respawnSeconds = this.playerRespawnTimer;
    this.hud.update(state, dt);

    this.flushDamageNumbers(camera);

    if (this.shotSinceRender) {
      this.shotSinceRender = false;
      this.latency.notePresented(performance.now());
    }
  }

  dispose(): void {
    this.bots.dispose();
    this.deps.scene.remove(this.bots.group);
    this.range.dispose();
    this.deps.scene.remove(this.range.group);
    this.fx.dispose();
    this.deps.scene.remove(this.fx.group);
    this.deps.viewmodel.remove(this.model.root);
    this.model.dispose();
    this.hud.dispose();
    this.deps.audio.setOccluder(null);
  }

  // -- wiring ----------------------------------------------------------------

  private subscribe(): void {
    const { bus, cameraRig, input } = this.deps;

    bus.on(EV.WeaponFired, (p) => {
      const def = this.weapons.definition;
      // Flash, tracer and report belong to whoever fired, wherever they are standing.
      this.fx.fireMuzzleFlash(p.x, p.y, p.z, def.muzzleFlashScale);
      if (p.tracer) this.fx.spawnTracer(p.x, p.y, p.z, p.endX, p.endY, p.endZ);
      this.weaponAudio.playGunshot(p.x, p.y, p.z, def.voice);
      // Everything below is about the local player's own hands and must not fire for a
      // bot: a bot shooting across the room shaking your camera is the classic tell.
      if (p.sourceId !== PLAYER_ENTITY_ID) return;
      cameraRig.shake.add(def.shakePerShot);
      this.latency.armFromPress(input.takeFirePress());
      this.shotSinceRender = true;
    });

    bus.on(EV.BulletImpact, (p) => {
      this.fx.spawnImpact(p.x, p.y, p.z, p.nx, p.ny, p.nz, p.material, p.penetrated);
      this.weaponAudio.playImpact(p.x, p.y, p.z, p.material, p.penetrated);
    });

    bus.on(EV.DamageDealt, (p) => {
      if (p.targetId === PLAYER_ENTITY_ID) {
        this.onPlayerHurt(p.sourceId, p.amount);
        return;
      }
      // A round landing on a body is a sound in the room no matter who fired it (S6.8).
      this.weaponAudio.playFleshImpact(p.x, p.y, p.z, p.zone === 'head');
      if (p.sourceId !== PLAYER_ENTITY_ID) return;

      // Timestamped here, at the moment the damage was applied, so the hitmarker latency
      // reported in the overlay is hit-to-visual and not visual-to-visual.
      this.hud.showHitmarker(p.lethal, performance.now());
      this.weaponAudio.playHitmarker(p.lethal);
      // Debris comes back along the shot, so the puff faces the shooter.
      const sim = this.deps.player.sim;
      const bx = sim.x - p.x;
      const by = sim.y + sim.eyeHeight - p.y;
      const bz = sim.z - p.z;
      const inv = 1 / Math.max(1e-4, Math.hypot(bx, by, bz));
      this.fx.spawnHitPuff(p.x, p.y, p.z, bx * inv, by * inv, bz * inv);
      this.queueDamageNumber(p.x, p.y, p.z, p.amount, p.zone);
    });

    bus.on(EV.EntityKilled, (p) => {
      if (p.targetId === PLAYER_ENTITY_ID) {
        this.onPlayerKilled();
        return;
      }
      const victim = this.bots.get(p.targetId);
      if (victim === undefined) return;
      // Slightly off the floor: the sound is the body arriving, not the feet.
      this.weaponAudio.playDeath(victim.px, victim.py + 0.4, victim.pz);
    });

    bus.on(EV.WeaponDryFired, (p) => {
      const at = this.sourcePosition(p.sourceId);
      this.weaponAudio.playDryFire(at.x, at.y, at.z);
    });

    bus.on(EV.WeaponReloadStep, (p) => {
      const at = this.sourcePosition(p.sourceId);
      this.weaponAudio.playReloadStep(at.x, at.y, at.z, p.step);
    });

    bus.on(EV.WeaponAdsChanged, (p) => {
      const at = this.sourcePosition(p.sourceId);
      this.weaponAudio.playAdsRustle(at.x, at.y, at.z, p.aiming);
    });
  }

  /**
   * The player took a round. The vignette says how hard, the chevron says from where —
   * and the chevron is the important one, because being shot from off-screen with no
   * indication of the direction is the single most frustrating way to die.
   */
  private onPlayerHurt(sourceId: number, amount: number): void {
    this.hud.showHurt(amount, this.playerHealth.max);
    cameraShakeForHit(this.deps.cameraRig, amount, this.playerHealth.max);

    const shooter = this.bots.get(sourceId);
    if (shooter === undefined) return;
    const sim = this.deps.player.sim;
    const worldYaw = Math.atan2(-(shooter.px - sim.x), -(shooter.pz - sim.z));
    // Screen-relative: 0 is straight ahead, positive to the right. The view yaw grows
    // anticlockwise, so the bearing is the negated delta.
    this.hud.showHitDirection(-angleDelta(sim.yaw, worldYaw));
  }

  private onPlayerKilled(): void {
    if (this.playerDead) return;
    this.playerDead = true;
    this.playerRespawnTimer = PLAYER_RESPAWN_SECONDS;
    const sim = this.deps.player.sim;
    this.weaponAudio.playDeath(sim.x, sim.y + 0.4, sim.z);
    this.deps.cameraRig.shake.add(0.45);
  }

  /**
   * Where an entity's weapon sounds should come from. The player's own mechanical noises
   * sit at their eye; a bot's sit at the bot, which is what makes hearing one reload
   * behind a crate a usable piece of information rather than a confusing one.
   */
  private sourcePosition(sourceId: number): { x: number; y: number; z: number } {
    if (sourceId === PLAYER_ENTITY_ID) {
      const sim = this.deps.player.sim;
      sourceAt.x = sim.x;
      sourceAt.y = sim.y + sim.eyeHeight;
      sourceAt.z = sim.z;
      return sourceAt;
    }
    const bot = this.bots.get(sourceId);
    if (bot !== undefined) {
      sourceAt.x = bot.px;
      sourceAt.y = bot.py + bot.eyeHeight;
      sourceAt.z = bot.pz;
      return sourceAt;
    }
    // Unregistered source (a range dummy). Put it at the listener so it stays audible
    // rather than being panned to the origin of the world.
    sourceAt.x = this.listenerX;
    sourceAt.y = this.listenerY;
    sourceAt.z = this.listenerZ;
    return sourceAt;
  }

  private queueDamageNumber(x: number, y: number, z: number, amount: number, zone: HitZone): void {
    if (this.numberCount >= NUMBER_QUEUE) return;
    const slot = this.numberQueue[this.numberCount];
    if (slot === undefined) return;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.amount = amount;
    slot.zone = zone;
    this.numberCount++;
  }

  /** Projection needs the camera, which only exists during the render pass. */
  private flushDamageNumbers(camera: THREE.PerspectiveCamera): void {
    if (this.numberCount === 0) return;
    if (this.hud.damageNumbersEnabled) {
      const halfW = window.innerWidth * 0.5;
      const halfH = window.innerHeight * 0.5;
      for (let i = 0; i < this.numberCount; i++) {
        const n = this.numberQueue[i];
        if (n === undefined) continue;
        this.projectScratch.set(n.x, n.y, n.z).project(camera);
        if (this.projectScratch.z > 1) continue;
        this.hud.showDamageNumber(
          halfW + this.projectScratch.x * halfW,
          halfH - this.projectScratch.y * halfH,
          n.amount,
          n.zone,
        );
      }
    }
    this.numberCount = 0;
  }

  /** Radians of interpolated aim recoil, for the camera. */
  get aimYawRad(): number {
    return this.visual.aimYaw * DEG2RAD;
  }

  get aimPitchRad(): number {
    return this.visual.aimPitch * DEG2RAD;
  }
}

/**
 * A jolt proportional to the round that caused it, capped well below the landing shake.
 * Being shot has to register in the body without taking the aim away from the player —
 * a hit that throws the camera is a hit the player cannot answer.
 */
function cameraShakeForHit(rig: CameraRig, amount: number, maxHealth: number): void {
  const severity = Math.min(1, amount / Math.max(maxHealth * 0.3, 1));
  rig.shake.add(0.08 + severity * 0.16);
}
