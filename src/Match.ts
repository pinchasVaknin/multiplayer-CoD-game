import * as THREE from 'three';
import type { SchedulerConfig } from './ai/AiScheduler';
import { BotDirector } from './ai/BotDirector';
import type { BotTeam } from './ai/Combatant';
import type { PerceptionConfig, TierTable } from './ai/DifficultyTiers';
import { PlayerCombatant } from './ai/PlayerCombatant';
import { makeSpawnChoice, type SpawnChoice } from './ai/SpawnSelector';
import { DamageSystem, makeDamageRequest, PLAYER_ENTITY_ID, type DamageRequest } from './combat/DamageSystem';
import { ScoreSystem } from './combat/ScoreSystem';
import { TargetRange } from './combat/TargetRange';
import { EV, type GameBus } from './core/Events';
import type { Input } from './core/Input';
import { Btn, isDown, type InputCommand } from './core/InputCommand';
import { DT } from './core/Loop';
import { DEG2RAD } from './core/MathUtil';
import type { CameraRig } from './engine/CameraRig';
import type { CameraConfig } from './player/CameraConfig';
import { Fx } from './engine/Fx';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import { LatencyProbe } from './debug/LatencyProbe';
import type { EquipmentConfig } from './equipment/EquipmentConfig';
import { EquipmentSystem } from './equipment/EquipmentSystem';
import { MatchEquipment } from './MatchEquipment';
import { MatchFeedback } from './MatchFeedback';
import type { GameMode } from './modes/GameMode';
import { MatchFlow } from './modes/MatchFlow';
import type { MapEntry, ModeEntry } from './modes/ModeRegistry';
import { Health, type HealthConfig } from './player/Health';
import type { MovementConfig } from './player/MovementConfig';
import type { PlayerController } from './player/PlayerController';
import type { ViewmodelLayer } from './player/Viewmodel';
import { LOW_HEALTH_THRESHOLD } from './ui/Hud';
import { MatchHud } from './ui/MatchHud';
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
 * that neither file drifts past the size the architecture allows. It owns the wiring — and
 * wiring is all it does. Every connection here is an EventBus subscription, because S3 says
 * systems must not reach into each other, and the systems that fire, resolve and present a
 * shot genuinely do not know about one another:
 *
 *   WeaponSystem --weapon.fired--> flash, tracer, gunshot, camera shake, latency probe
 *   Ballistics   --bullet.impact-> debris, decal, impact report
 *   DamageSystem --damage.dealt--> hitmarker, hit audio, damage numbers, target read-out
 *   MatchFlow    --killfeed/score/announcer--> the HUD
 *
 * That is also what lets the headless harness run a full match with no renderer, no audio
 * context and no DOM: nothing downstream of the sim is required for the sim to run.
 *
 * M4 added the mode above it. `ScoreSystem`, the `GameMode` and `MatchFlow` are constructed
 * here and the flow's respawn gate is handed to both the bot director and the player's own
 * respawn timer, so "nobody comes back once the match is over" is one rule.
 */

export interface MatchDeps {
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly viewmodel: ViewmodelLayer;
  readonly cameraRig: CameraRig;
  readonly cameraConfig: CameraConfig;
  readonly audio: ProceduralAudio;
  readonly input: Input;
  readonly world: CollisionWorld;
  readonly player: PlayerController;
  readonly movementConfig: MovementConfig;
  readonly weaponDef: WeaponDef;
  /** M5: the player's sidearm. Bots do not carry one — see `WeaponSystem`. */
  readonly secondaryDef: WeaponDef;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly healthConfig: HealthConfig;
  readonly equipmentConfig: EquipmentConfig;
  readonly uiHost: HTMLElement;
  readonly anisotropy: number;
  /** M4: the map and mode this match is. The director bakes a navmesh from the map def. */
  readonly map: MapEntry;
  readonly mode: ModeEntry;
  readonly tiers: TierTable;
  readonly perceptionConfig: PerceptionConfig;
  readonly schedulerConfig: SchedulerConfig;
  readonly seed: number;
}

/** The player's side. Bots added to 'A' fight alongside them, 'B' against. */
export const PLAYER_TEAM: BotTeam = 'A';

export const PLAYER_NAME = 'OPERATOR';

/** Seconds the player spends dead. Matches the bots' timer, because it is the same rule. */
const PLAYER_RESPAWN_SECONDS = 4.5;

/** Heartbeat rate at the low-health threshold and at zero, beats per minute (S6.4). */
const HEARTBEAT_BPM_CALM = 74;
const HEARTBEAT_BPM_PANIC = 152;

export class Match {
  readonly damage: DamageSystem;
  readonly weapons: WeaponSystem;
  /** Only on the grey-box testbed: a firing range does not belong on a TDM map. */
  readonly range: TargetRange | null;
  readonly fx: Fx;
  readonly weaponAudio: WeaponAudio;
  /** One per inventory slot; only the active one is visible. */
  readonly models: WeaponModel[];
  /** The visible one. Reassigned on a swap. */
  model: WeaponModel;
  readonly anim: ViewmodelAnim;
  readonly latency = new LatencyProbe();
  readonly playerHealth: Health;
  readonly playerCombatant: PlayerCombatant;
  readonly bots: BotDirector;

  // ---- M4: the match, as opposed to the firefight -------------------------
  readonly score: ScoreSystem;
  readonly mode: GameMode;
  readonly flow: MatchFlow;
  readonly ui: MatchHud;
  /** Turns the events a shot produces into what the player sees and hears. */
  readonly feedback: MatchFeedback;
  /** M5: grenades, smoke, flashes and the bots that throw them. */
  readonly equipment: MatchEquipment;

  /** Interpolated weapon state for this frame. Read by Game for the camera. */
  readonly visual: WeaponSnapshot = {
    raise: 1,
    adsFraction: 0,
    visualPunch: 0,
    visualLateral: 0,
    aimPitch: 0,
    aimYaw: 0,
    reloadFraction: 0,
    swapFraction: 1,
  };

  /** Wall time inside the last `flow.simulate`, ms. Reported in F1 (S7). */
  lastModeMs = 0;

  private readonly deps: MatchDeps;
  private readonly drive: ViewmodelDrive = makeViewmodelDrive();
  private readonly residual = { yaw: 0, pitch: 0 };
  private readonly selfDamage: DamageRequest;
  private readonly occlusionRay: RayHit = makeRayHit();
  private readonly listenerAt = { x: 0, y: 0, z: 0 };

  private readonly spawnChoice: SpawnChoice = makeSpawnChoice();
  private swapSubscription: (() => void) | null = null;

  private active = false;
  private playerDead = false;
  private playerRespawnTimer = 0;
  private heartbeatTimer = 0;
  private rosterRegistered = false;

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
      deps.secondaryDef,
      deps.world,
      this.damage,
      deps.bus,
      deps.viewmodelConfig,
      deps.movementConfig.walkSpeed,
    );

    this.range = deps.map.targetRange ? new TargetRange(this.damage, deps.bus, deps.healthConfig) : null;
    if (this.range !== null) deps.scene.add(this.range.group);

    // The director bakes the navmesh, so it is built once here rather than per match.
    this.bots = new BotDirector({
      world: deps.world,
      mapDef: deps.map.def,
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

    // ---- the mode ---------------------------------------------------------
    this.score = new ScoreSystem(deps.bus);
    this.mode = deps.mode.create({ bus: deps.bus, score: this.score, roster: this.bots.roster });
    this.flow = new MatchFlow({
      bus: deps.bus,
      score: this.score,
      roster: this.bots.roster,
      mode: this.mode,
      mapId: deps.map.id,
      mapName: deps.map.name,
      localTeam: PLAYER_TEAM,
      onSidesSwapped: (swapped) => this.bots.spawns.setSideSwap(swapped),
    });
    this.bots.respawnPolicy = {
      allowed: (id) => this.flow.respawnAllowed(id),
      noted: (id) => this.flow.noteRespawn(id),
    };

    this.fx = new Fx(deps.anisotropy);
    deps.scene.add(this.fx.group);

    // One mesh per inventory slot, both built up front and toggled by visibility. Building
    // on demand would put a geometry merge and a GPU upload on the frame the player presses
    // the swap key, which is the one frame that must not stutter.
    this.models = [
      buildWeaponModel(deps.weaponDef.id, deps.anisotropy),
      buildWeaponModel(deps.secondaryDef.id, deps.anisotropy),
    ];
    for (const model of this.models) {
      deps.viewmodel.add(model.root);
      model.root.visible = false;
    }
    this.model = this.requireModel(0);
    this.model.root.visible = true;
    this.fx.attachMuzzle(this.model.muzzle);
    this.anim = new ViewmodelAnim(this.model);

    this.ui = new MatchHud({
      bus: deps.bus,
      uiHost: deps.uiHost,
      mapDef: deps.map.def,
      mapName: deps.map.name,
      modeName: this.mode.name,
      columns: this.mode.getScoreboardColumns(),
      score: this.score,
      audio: deps.audio,
      localTeam: PLAYER_TEAM,
      roster: this.bots.roster,
      teamSize: deps.map.teamSize,
    });
    this.weaponAudio = new WeaponAudio(deps.audio);

    this.feedback = new MatchFeedback({
      bus: deps.bus,
      cameraRig: deps.cameraRig,
      cameraConfig: deps.cameraConfig,
      audio: deps.audio,
      input: deps.input,
      player: deps.player,
      playerHealth: this.playerHealth,
      weapons: this.weapons,
      weaponAudio: this.weaponAudio,
      fx: this.fx,
      hud: this.ui.hud,
      bots: this.bots,
      latency: this.latency,
      onPlayerKilled: () => this.onPlayerKilled(),
      listener: () => this.listenerAt,
    });

    // The mesh follows the inventory. `weapon.swapped` fires at the hand-over, which is the
    // exact tick the old weapon has finished going down and the new one starts coming up.
    this.swapSubscription = deps.bus.on(EV.WeaponSwapped, (p) => {
      if (p.sourceId !== PLAYER_ENTITY_ID) return;
      this.showSlot(this.weapons.inventory.activeSlotIndex);
    });

    // M5. Built after the HUD because it pushes the flash and the threat indicator into it,
    // and after the director because it hands the smoke field to `Perception` as an occluder.
    this.equipment = new MatchEquipment({
      bus: deps.bus,
      scene: deps.scene,
      world: deps.world,
      damage: this.damage,
      bots: this.bots,
      audio: deps.audio,
      cameraRig: deps.cameraRig,
      hud: this.ui.hud,
      cfg: deps.equipmentConfig,
      tiers: deps.tiers,
      localTeam: PLAYER_TEAM,
      seed: deps.seed,
    });

    // Occlusion low-pass through the same spatial-hash raycaster the sim uses (S6.7).
    deps.audio.setOccluder((x, y, z) =>
      !deps.world.segmentClear(
        x,
        y,
        z,
        this.listenerAt.x,
        this.listenerAt.y,
        this.listenerAt.z,
        this.occlusionRay,
      ),
    );
    // The room, into the one convolver that already exists (S6.6).
    deps.audio.setReverb(deps.map.def.reverb ?? null);
  }

  /**
   * Bring the match up. Builds the roster on the first activation, registers everybody with
   * the score system, and starts the flow's clock.
   */
  setActive(on: boolean): void {
    this.active = on;
    this.ui.setVisible(on);
    if (!on) return;
    this.anim.reset(this.deps.input.yaw, this.deps.input.pitch);
    // Deferred to the first time a match actually starts rather than done at construction:
    // the harness wants a different roster and gets to set it before anyone spawns.
    if (this.bots.botCount === 0) this.populateDefault();
    this.registerRoster();
    if (this.flow.currentPhase === 'WARMUP' && this.flow.round === 1 && this.score.rows.length > 0) {
      this.flow.start();
    }
  }

  /** The default firefight: the map's team size, the player counting as one of their side. */
  populateDefault(): void {
    const size = this.deps.map.teamSize;
    this.bots.populate(Math.max(0, size - 1), size, this.deps.map.tierMix);
  }

  /**
   * Put every roster member on the scoreboard.
   *
   * Deferred until the roster exists and done once: the bots are built by `populate`, which
   * the harness may call with its own numbers before the match goes live.
   */
  registerRoster(): void {
    if (this.rosterRegistered) return;
    this.rosterRegistered = true;
    this.score.register(PLAYER_ENTITY_ID, PLAYER_NAME, PLAYER_TEAM);
    for (const bot of this.bots.bots) this.score.register(bot.entityId, bot.displayName, bot.team);
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

  /** The live player simulation, for tooling that needs a pose and a facing. */
  get playerSim(): PlayerController['sim'] {
    return this.deps.player.sim;
  }

  /** The collision world this match is being played in. */
  get world(): CollisionWorld {
    return this.deps.world;
  }

  /**
   * Put a different weapon in a slot (M5).
   *
   * Rebuilds that slot's mesh, because a weapon is its silhouette as much as its numbers.
   * Used by the debug weapon picker; M6's loadout editor is the real caller.
   */
  equip(slotIndex: number, def: WeaponDef): void {
    const old = this.models[slotIndex];
    if (old === undefined) return;
    const wasVisible = old.root.visible;
    this.deps.viewmodel.remove(old.root);
    old.dispose();

    const model = buildWeaponModel(def.id, this.deps.anisotropy);
    this.models[slotIndex] = model;
    this.deps.viewmodel.add(model.root);
    model.root.visible = wasVisible;

    this.weapons.equip(slotIndex, def);
    if (wasVisible) this.showSlot(slotIndex);
  }

  private showSlot(slotIndex: number): void {
    const model = this.models[slotIndex];
    if (model === undefined) return;
    for (const m of this.models) m.root.visible = m === model;
    this.model = model;
    this.anim.setModel(model);
    this.fx.attachMuzzle(model.muzzle);
  }

  private requireModel(index: number): WeaponModel {
    const model = this.models[index];
    if (model === undefined) throw new Error(`Match has no viewmodel for slot ${index}`);
    return model;
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

    // The glint an enemy can see is a property of the weapon, and `PlayerCombatant` is
    // built before the weapon exists — so it is stamped here, once a tick, before
    // perception runs against it.
    this.playerCombatant.glinting = !this.playerDead && this.weapons.glinting;

    this.range?.step();
    this.equipment.simulate(cmd, this.deps.player.sim, !this.playerDead);
    this.bots.simulate(cmd.tickIndex, cmd.sampledAtMs);
    this.stepPlayerRespawn();
    this.stepLowHealthAudio();

    // The mode clock is a gameplay timer and runs on ticks like everything else (S4.1).
    const t0 = performance.now();
    this.flow.simulate(cmd.tickIndex);
    this.lastModeMs = performance.now() - t0;

    // Held Tab, read from the command rather than from the DOM (S4.2).
    this.ui.setScoreboardOpen(isDown(cmd.buttons, Btn.Scoreboard));

    this.latency.expire(performance.now());
  }

  /**
   * The player's side of S6.9. Same timer and the same spawn selector the bots use, and the
   * same respawn gate — so "nobody comes back once the match is over" is one rule with one
   * implementation rather than one for them and a different one for you.
   */
  private stepPlayerRespawn(): void {
    if (!this.playerDead) return;
    this.playerRespawnTimer = Math.max(0, this.playerRespawnTimer - DT);
    if (this.playerRespawnTimer > 0) return;
    if (!this.flow.respawnAllowed(PLAYER_ENTITY_ID)) return;
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
    // Equipment is per life (S6.3). `MatchEquipment` refills on `player.spawned`, which
    // `PlayerController.spawn` above has already emitted.
    this.playerCombatant.syncRig();
    this.playerDead = false;
    this.playerRespawnTimer = 0;
    this.flow.noteRespawn(PLAYER_ENTITY_ID);
  }

  /**
   * The audible half of the low-health state (brief S6.4).
   *
   * Driven from the same intensity the vignette uses, so what you see and what you hear
   * cannot disagree. The muffle is a state and is set every tick; the heartbeat is an event
   * and is scheduled on a tick timer that speeds up as health falls — 74 BPM at the
   * threshold, 152 at nothing left.
   */
  private stepLowHealthAudio(): void {
    const intensity = this.playerDead ? 0 : this.ui.lowHealthIntensity;
    this.deps.audio.setMuffle(intensity);

    if (intensity <= 0) {
      this.heartbeatTimer = 0;
      return;
    }
    const bpm = HEARTBEAT_BPM_CALM + (HEARTBEAT_BPM_PANIC - HEARTBEAT_BPM_CALM) * intensity;
    this.heartbeatTimer -= DT;
    if (this.heartbeatTimer > 0) return;
    this.heartbeatTimer = 60 / bpm;
    this.deps.audio.playHeartbeat(intensity);
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

    this.listenerAt.x = camera.position.x;
    this.listenerAt.y = camera.position.y;
    this.listenerAt.z = camera.position.z;

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
    drive.swapping = this.weapons.inventory.swapping;
    drive.bobPhase = sim.bobPhase;
    drive.speed = sim.speed;
    drive.speedRef = this.deps.movementConfig.sprintSpeed;
    drive.grounded = sim.grounded;
    drive.yaw = yaw;
    drive.pitch = pitch;
    this.anim.update(drive, this.deps.viewmodelConfig, dt);

    this.range?.updateVisuals(alpha, camera);
    this.bots.updateVisuals(alpha, dt);
    this.fx.update(dt);
    this.equipment.render(alpha, dt, camera);

    // A dead player is not holding a rifle.
    this.model.root.visible = !this.playerDead;

    const state = this.ui.state;
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
    this.fillTacticalState();
    this.ui.update(this.flow, sim.x, sim.z, sim.yaw, dt);
    this.feedback.render(camera);
  }

  /**
   * The M5 half of the HUD state: which weapons are in hand, what equipment is left, the
   * scope, and the cook timer. Read straight off the systems that own them.
   */
  private fillTacticalState(): void {
    const tac = this.ui.state.tactical;
    const inventory = this.weapons.inventory;
    const def = inventory.active.definition;
    const otherIndex = inventory.activeSlotIndex === 0 ? 1 : 0;

    tac.weaponName = def.name;
    tac.slotIndex = inventory.activeSlotIndex;
    tac.otherName = inventory.at(otherIndex)?.definition.name ?? '';

    const inv = this.equipment.inventory;
    tac.lethalId = inv.lethal;
    tac.lethalCount = inv.lethalCount;
    tac.tacticalId = inv.tactical;
    tac.tacticalCount = inv.tacticalCount;

    const thrower = this.equipment.thrower;
    tac.cookRemaining = thrower.remainingFuse(inv);
    tac.cookTotal = EquipmentSystem.slotDef(inv, thrower.slot).fuseSeconds;

    tac.hasScope = def.scope !== undefined;
    tac.scopeFraction = tac.hasScope ? this.visual.adsFraction : 0;
    tac.breath = this.weapons.scope.breath;
    tac.breathHeld = this.weapons.scope.holding;
  }

  /**
   * Take the match apart.
   *
   * Everything constructed in the constructor is undone here, in the reverse order, and
   * every subscription is dropped — this is the method acceptance criterion 1 and the heap
   * harness are really testing. Anything added to `Match` that is not released here shows up
   * as a step in `usedJSHeapSize` at the next match boundary.
   */
  dispose(): void {
    this.equipment.dispose();
    this.feedback.dispose();
    this.flow.dispose();
    this.score.dispose();
    this.ui.dispose();
    this.bots.dispose();
    this.deps.scene.remove(this.bots.group);
    if (this.range !== null) {
      this.range.dispose();
      this.deps.scene.remove(this.range.group);
    }
    this.fx.dispose();
    this.deps.scene.remove(this.fx.group);
    this.swapSubscription?.();
    this.swapSubscription = null;
    for (const model of this.models) {
      this.deps.viewmodel.remove(model.root);
      model.dispose();
    }
    this.models.length = 0;
    this.deps.audio.setOccluder(null);
    this.deps.audio.resetMatchState();
  }

  /**
   * The local player died. Owned here rather than in `MatchFeedback` because what follows is
   * gameplay: the respawn timer, and the respawn gate the mode controls.
   */
  private onPlayerKilled(): void {
    if (this.playerDead) return;
    this.playerDead = true;
    this.playerRespawnTimer = PLAYER_RESPAWN_SECONDS;
    const sim = this.deps.player.sim;
    this.weaponAudio.playDeath(sim.x, sim.y + 0.4, sim.z);
    this.deps.cameraRig.shake.add(0.45);
    // Dying clears the low-health state: the muffle belongs to being nearly dead, not to being
    // dead, and holding it through a respawn is state leaking across a life.
    this.deps.audio.setMuffle(0);
  }

  /** Radians of interpolated aim recoil, for the camera. */
  get aimYawRad(): number {
    return this.visual.aimYaw * DEG2RAD;
  }

  get aimPitchRad(): number {
    return this.visual.aimPitch * DEG2RAD;
  }

  /** The threshold the low-health state begins at. Exposed for the debug read-out. */
  get lowHealthThreshold(): number {
    return LOW_HEALTH_THRESHOLD;
  }
}
