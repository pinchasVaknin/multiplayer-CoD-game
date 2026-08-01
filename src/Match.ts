import * as THREE from 'three';
import type { SchedulerConfig } from './ai/AiScheduler';
import { BotDirector } from './ai/BotDirector';
import type { BotTeam } from './ai/Combatant';
import type { PerceptionConfig, TierTable } from './ai/DifficultyTiers';
import { PlayerCombatant } from './ai/PlayerCombatant';
import { makeSpawnChoice, type SpawnChoice } from './ai/SpawnSelector';
import { DamageSystem, makeDamageRequest, PLAYER_ENTITY_ID, type DamageRequest } from './combat/DamageSystem';
import { ScoreSystem } from './combat/ScoreSystem';
import { Rng } from './core/Rng';
import { TargetRange } from './combat/TargetRange';
import { EV, type GameBus } from './core/Events';
import type { Input } from './core/Input';
import { Btn, isDown, justPressed, type InputCommand } from './core/InputCommand';
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
import { MatchMeta } from './MatchMeta';
import { StreakAudio } from './streaks/StreakAudio';
import { StreakSystem } from './streaks/StreakSystem';
import { DEFAULT_STREAK_CONFIG, type StreakConfig } from './streaks/StreakDefs';
import type { CamoId } from './meta/Camos';
import type { ResolvedLoadout } from './meta/Loadouts';
import type { Profile } from './meta/Profile';
import type { XpReport } from './meta/XpRules';
import type { GameMode } from './modes/GameMode';
import type { ObjectiveProvider } from './ai/ObjectiveIntent';
import { MatchFlow } from './modes/MatchFlow';
import type { MapEntry, ModeEntry } from './modes/ModeRegistry';
import { Health, type HealthConfig } from './player/Health';
import type { MovementConfig } from './player/MovementConfig';
import type { PlayerController } from './player/PlayerController';
import type { ViewmodelLayer } from './player/Viewmodel';
import { LOW_HEALTH_THRESHOLD } from './ui/Hud';
import { SCOPE_VIEWMODEL_HIDDEN } from './ui/HudTactical';
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
  /**
   * The player's live primary — resolved from the loadout, so it already carries the
   * attachments and the perks. The tuning panel writes into this object.
   */
  readonly weaponDef: WeaponDef;
  /** M5: the player's sidearm. Bots do not carry one — see `WeaponSystem`. */
  readonly secondaryDef: WeaponDef;
  /**
   * The *base* of the player's primary: no attachments, no perks.
   *
   * M6 introduced this as `botWeaponDef` to stop the enemy team being issued the player's
   * Quickdraw, and M7 renamed it because the name was describing a bug. Bots never read it —
   * they draw their own weapons in `BotArsenal` — and its one remaining job is the M6
   * modifier panel, which shows perks and attachments as a before-and-after and must read
   * the *same* base the match was built from rather than looking one up in the registry.
   */
  readonly playerBaseDef: WeaponDef;
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
  /** M6: the equipped class, already resolved and sanitised by `Profile`. */
  readonly loadout: ResolvedLoadout;
  readonly profile: Profile;
  /** False in the Shooting Range: a testbed does not write to the save. */
  readonly banksProgress: boolean;
  /** M7: killstreak tuning. Live-editable from the debug panel. */
  readonly streakConfig?: StreakConfig;
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
  /** The camo each slot is wearing, so a rebuild does not lose it. */
  private readonly slotCamos: Array<CamoId | null> = [];
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
  /** M6: XP, challenges, perks and the field upgrade. */
  readonly meta: MatchMeta;
  /** M7: killstreaks. Owns every streak entity in the world. */
  readonly streaks: StreakSystem;

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
  /** Previous tick's buttons, for edge detection in the sim (S4.2). */
  private prevButtons = 0;
  /**
   * Where a mortar will land if one is called in.
   *
   * Defaults to the map centre and is moved by the targeting overlay. Held here rather than in
   * the overlay so a mortar called from the console — or, later, by a bot — still has a mark.
   */
  mortarMarkX = 0;
  mortarMarkZ = 0;
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

    // The player holds the *resolved* loadout — base plus attachments plus perks — which
    // `Game` has already copied into `weaponDef` so the tuning panel keeps its reference.
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
    // No weapon is handed over: each bot draws its own (M7, `ai/BotArsenal.ts`).
    this.bots = new BotDirector({
      world: deps.world,
      mapDef: deps.map.def,
      bus: deps.bus,
      damage: this.damage,
      movement: deps.movementConfig,
      healthConfig: deps.healthConfig,
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
    this.mode = deps.mode.create({
      bus: deps.bus,
      score: this.score,
      roster: this.bots.roster,
      mapDef: deps.map.def,
    });
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
    // M7: if the mode has objectives, hand the director the provider. `ai/` asks and the
    // mode answers; nothing in `ai/` knows a flag from a bomb site (see `ObjectiveIntent`).
    this.bots.objectives = isObjectiveProvider(this.mode) ? this.mode : null;
    this.bots.freeForAll = deps.mode.freeForAll === true;
    this.bots.pushAggressionScale = deps.mode.pushAggressionScale ?? 1;

    this.fx = new Fx(deps.anisotropy);
    deps.scene.add(this.fx.group);

    // One mesh per inventory slot, both built up front and toggled by visibility. Building
    // on demand would put a geometry merge and a GPU upload on the frame the player presses
    // the swap key, which is the one frame that must not stutter.
    this.slotCamos[0] = deps.loadout.primaryCamo;
    this.slotCamos[1] = deps.loadout.secondaryCamo;
    this.models = [
      buildWeaponModel(deps.weaponDef.id, deps.anisotropy, deps.loadout.primaryCamo),
      buildWeaponModel(deps.secondaryDef.id, deps.anisotropy, deps.loadout.secondaryCamo),
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

    // The loadout's grenades, not the M5 defaults. Set before the first refill so a
    // spawning player is handed what their class actually carries.
    this.equipment.inventory.lethal = deps.loadout.lethal;
    this.equipment.inventory.tactical = deps.loadout.tactical;
    EquipmentSystem.refill(this.equipment.inventory);

    // M6, last: it hooks into the bots, the flash field and the player controller, all of
    // which have to exist first.
    this.meta = new MatchMeta({
      bus: deps.bus,
      scene: deps.scene,
      profile: deps.profile,
      loadout: deps.loadout,
      score: this.score,
      player: deps.player,
      playerHealth: this.playerHealth,
      weapons: this.weapons,
      bots: this.bots,
      equipment: this.equipment.system,
      equipmentInventory: this.equipment.inventory,
      localTeam: PLAYER_TEAM,
      banksProgress: deps.banksProgress,
    });

    /**
     * M7, last of all: it asks `MatchMeta` for perk state and `MatchEquipment` for its blast,
     * so both have to exist first.
     *
     * The three predicates below are the whole of the M6 hook activation. `streaks/` never
     * learns what a perk is — it asks three questions and this is where they are answered:
     * Cold-Blooded refuses to be targeted, Ghost refuses to appear on a sweep, and Hardline
     * discounts every requirement.
     */
    this.streaks = new StreakSystem({
      bus: deps.bus,
      score: this.score,
      roster: this.bots.roster,
      localId: PLAYER_ENTITY_ID,
      targetable: (id) => (id === PLAYER_ENTITY_ID ? this.meta.state.targetedByStreaks : true),
      visibleToUav: (id) => (id === PLAYER_ENTITY_ID ? this.meta.state.visibleToUav : true),
      streakDiscount: (id) => (id === PLAYER_ENTITY_ID ? this.meta.state.streakDiscount : 0),
      context: {
        bus: deps.bus,
        scene: deps.scene,
        world: deps.world,
        damage: this.damage,
        bots: this.bots,
        audio: new StreakAudio(deps.audio),
        fx: this.fx,
        cameraRig: deps.cameraRig,
        mapDef: deps.map.def,
        cfg: deps.streakConfig ?? DEFAULT_STREAK_CONFIG,
        rng: new Rng(deps.seed ^ 0x5bd1_e995),
        tiers: deps.tiers,
        blast: (x, y, z, radius, bright) => this.equipment.fx.spawnBlast(x, y, z, radius, bright),
        roster: this.bots.roster,
      },
    });
    // Care packages are contestable in every mode, so they ride the second provider slot
    // rather than the mode's (see `BotDirector.streakObjectives`).
    this.bots.streakObjectives = this.streaks;

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
    // The range populates nothing: S9's testbed has no enemies by design, and the
    // registry says so rather than this file guessing from the map.
    if (this.bots.botCount === 0 && this.deps.mode.populatesRoster) this.populateDefault();
    this.registerRoster();
    if (this.flow.currentPhase === 'WARMUP' && this.flow.round === 1 && this.score.rows.length > 0) {
      this.flow.start();
    }
  }

  /**
   * The default firefight: the map's team size, the player counting as one of their side.
   *
   * A mode may override the roster size (M7): Free-for-All is eight operators on any map, and
   * they are split evenly across the two substrate sides so perception, spawn safety and the
   * aim model keep working — see `modes/FreeForAll.ts` for why the two-team substrate stays.
   */
  populateDefault(): void {
    const override = this.deps.mode.rosterSize;
    if (override !== undefined) {
      const bots = Math.max(0, override - 1);
      const teamB = Math.ceil(bots / 2);
      this.bots.populate(bots - teamB, teamB, this.deps.map.tierMix);
      return;
    }
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

  /** The unmodified base of the player's primary. See `MatchDeps.playerBaseDef`. */
  get playerBaseDef(): WeaponDef {
    return this.deps.playerBaseDef;
  }

  /** The class this match was built with. */
  get loadout(): ResolvedLoadout {
    return this.deps.loadout;
  }

  /**
   * Put a different weapon in a slot (M5).
   *
   * Rebuilds that slot's mesh, because a weapon is its silhouette as much as its numbers.
   * Used by the debug weapon picker; M6's loadout editor is the real caller.
   */
  equip(slotIndex: number, def: WeaponDef, camo?: CamoId | null): void {
    const old = this.models[slotIndex];
    if (old === undefined) return;
    const wasVisible = old.root.visible;
    this.deps.viewmodel.remove(old.root);
    old.dispose();

    // `undefined` keeps whatever finish the slot already had; `null` strips it. The
    // distinction matters because M5's debug weapon picker calls this with two arguments
    // and has no idea camos exist — without it, opening the arsenal panel would silently
    // return a gold rifle to grey.
    const nextCamo = camo === undefined ? (this.slotCamos[slotIndex] ?? null) : camo;
    this.slotCamos[slotIndex] = nextCamo;
    const model = buildWeaponModel(def.id, this.deps.anisotropy, nextCamo);
    this.models[slotIndex] = model;
    this.deps.viewmodel.add(model.root);
    model.root.visible = wasVisible;

    this.weapons.equip(slotIndex, def);
    if (wasVisible) this.showSlot(slotIndex);
  }

  /**
   * Swap the whole class over on a live match (M6).
   *
   * Called when the player edits their loadout from the pause screen, which is S6.3's
   * "reachable… between spawns". Both weapons are rebuilt (a class change is a different
   * silhouette as much as different numbers), the grenades are replaced and refilled, and
   * the perks are re-derived. Ammunition resets with the weapons, which is the honest
   * behaviour: you did not keep the magazine, you picked up a different gun.
   */
  applyLoadout(loadout: ResolvedLoadout): void {
    this.equip(0, loadout.primary, loadout.primaryCamo);
    this.equip(1, loadout.secondary, loadout.secondaryCamo);
    this.equipment.inventory.lethal = loadout.lethal;
    this.equipment.inventory.tactical = loadout.tactical;
    EquipmentSystem.refill(this.equipment.inventory);
    this.meta.setLoadout(loadout);
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
    this.meta.simulate(cmd, this.deps.player.sim, !this.playerDead);
    this.bots.simulate(cmd.tickIndex, cmd.sampledAtMs);
    // Streaks tick after the bots that may have just shot one down, and before the flow that
    // may declare the match over and end them all.
    this.streaks.simulate(cmd.tickIndex, cmd);
    if (!this.playerDead) this.stepStreakInput(cmd);
    this.stepPlayerRespawn();
    this.stepLowHealthAudio();

    // The mode clock is a gameplay timer and runs on ticks like everything else (S4.1).
    const t0 = performance.now();
    this.flow.simulate(cmd.tickIndex);
    this.lastModeMs = performance.now() - t0;

    // Held Tab, read from the command rather than from the DOM (S4.2).
    this.ui.setScoreboardOpen(isDown(cmd.buttons, Btn.Scoreboard));

    this.prevButtons = cmd.buttons;
    this.latency.expire(performance.now());
  }

  /**
   * Spend a killstreak on the player's say-so (M7).
   *
   * Three absolute keys rather than a cycle, and edge-detected in the sim from the bitfield
   * exactly as S4.2 requires — there is no DOM handler anywhere near this.
   *
   * Where a streak lands is decided here rather than by the streak, because "in front of the
   * player" is a fact about the player: a sentry goes a couple of metres ahead so it does not
   * spawn inside them, a package drops on the spot, and a mortar marks wherever the overlay
   * left its cursor.
   */
  private stepStreakInput(cmd: InputCommand): void {
    const bits = [Btn.Streak1, Btn.Streak2, Btn.Streak3] as const;
    for (let i = 0; i < bits.length; i++) {
      const bit = bits[i];
      if (bit === undefined) continue;
      if (!justPressed(cmd.buttons, this.prevButtons, bit)) continue;
      const held = this.streaks.pendingFor(PLAYER_ENTITY_ID);
      const id = held[i];
      if (id === undefined) continue;

      const sim = this.deps.player.sim;
      // Two metres along the facing, so a sentry is placed rather than worn.
      const ahead = 2;
      const px = sim.x - Math.sin(sim.yaw) * ahead;
      const pz = sim.z - Math.cos(sim.yaw) * ahead;
      const useAhead = id === 'sentry';
      this.streaks.activate(
        PLAYER_ENTITY_ID,
        id,
        id === 'mortar' ? this.mortarMarkX : useAhead ? px : sim.x,
        sim.y,
        id === 'mortar' ? this.mortarMarkZ : useAhead ? pz : sim.z,
        sim.yaw,
      );
      return;
    }
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
    this.meta.render(dt);
    this.streaks.render(dt, alpha);

    // A dead player is not holding a rifle — and a scoped one is looking through an optic
    // rather than at a weapon, so the viewmodel hands off to the scope overlay (M7). See
    // `SCOPE_VIEWMODEL_HIDDEN`: the tube is a solid cylinder on the sight line and would
    // otherwise fill the middle of the scope picture.
    const scoped = def.scope !== undefined && this.visual.adsFraction >= SCOPE_VIEWMODEL_HIDDEN;
    this.model.root.visible = !this.playerDead && !scoped;

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

    tac.fieldUpgradeName = this.meta.fieldUpgrade.name;
    tac.fieldUpgradeCharge = this.meta.fieldUpgrade.charge;
  }

  /**
   * Take the match apart.
   *
   * Everything constructed in the constructor is undone here, in the reverse order, and
   * every subscription is dropped — this is the method acceptance criterion 1 and the heap
   * harness are really testing. Anything added to `Match` that is not released here shows up
   * as a step in `usedJSHeapSize` at the next match boundary.
   */
  /**
   * Close progression out and hand back the summary's XP report.
   *
   * Called by `Game` on the way into SUMMARY rather than from the mode, because banking a
   * match is a *state machine* event: the mode declares a winner, and the profile is
   * written once the match is genuinely over and nothing else is going to change.
   */
  bankProgression(won: boolean): XpReport {
    return this.meta.finish(won);
  }

  dispose(): void {
    // First: a live Chopper Gunner has the camera, and nothing else may run until it is back.
    this.streaks.dispose();
    this.meta.dispose();
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

/**
 * Whether a mode also plays the objective-provider role.
 *
 * A structural test rather than an `instanceof` chain: `Match` composes modes it is handed by
 * the registry and has no business importing four concrete classes to ask them what they are.
 */
function isObjectiveProvider(mode: GameMode): mode is GameMode & ObjectiveProvider {
  const candidate = mode as Partial<ObjectiveProvider>;
  return typeof candidate.assign === 'function' && typeof candidate.onArrived === 'function';
}
