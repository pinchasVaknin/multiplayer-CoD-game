import * as THREE from 'three';
import type { ViewerContext } from '../shared/ui/TeamColour';
import type { SchedulerConfig } from '../shared/ai/AiScheduler';
import { BotDirector, RESPAWN_SECONDS } from '../shared/ai/BotDirector';
import { BotRenderer } from './ai/BotRenderer';
import type { RenderableActor } from '../shared/ai/BotVisualState';
import type { BotTeam } from '../shared/ai/Combatant';
import type { PerceptionConfig, TierTable } from '../shared/ai/DifficultyTiers';
import { PlayerCombatant } from '../shared/ai/PlayerCombatant';
import { makeSpawnChoice, type SpawnChoice } from '../shared/ai/SpawnSelector';
import { DamageSystem, makeDamageRequest, type DamageRequest } from '../shared/combat/DamageSystem';
import { LocalIdentity } from '../shared/combat/LocalIdentity';
import { ScoreSystem } from '../shared/combat/ScoreSystem';
import { Rng } from '../shared/core/Rng';
import { TargetRange } from './combat/TargetRange';
import { EV, type GameBus } from '../shared/core/Events';
import type { Input } from './input/Input';
import { inputLabel } from '../shared/core/Keybinds';
import { Btn, isDown, justPressed, type InputCommand } from '../shared/core/InputCommand';
import { DT } from '../shared/core/Loop';
import { DEG2RAD } from '../shared/core/MathUtil';
import type { CameraRig } from './engine/CameraRig';
import type { CameraConfig } from './player/CameraConfig';
import { Fx } from './engine/Fx';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import { LatencyProbe } from './debug/LatencyProbe';
import type { EquipmentConfig } from '../shared/equipment/EquipmentConfig';
import { EquipmentSystem } from '../shared/equipment/EquipmentSystem';
import { MatchEquipment } from './MatchEquipment';
import { MatchFeedback, type BodyPose } from './MatchFeedback';
import { MatchMeta } from './MatchMeta';
import { MatchObjectives } from './MatchObjectives';
import { MortarOverlay } from './ui/MortarOverlay';
import { Domination } from '../shared/modes/Domination';
import { SearchAndDestroy } from '../shared/modes/SearchAndDestroy';
import { StreakAudio } from './streaks/StreakAudio';
import { ClientStreakPresentation } from './streaks/ClientStreakPresentation';
import { StreakRenderer } from './streaks/StreakRenderer';
import { StreakSystem } from '../shared/streaks/StreakSystem';
import { ReplicatedStreaks } from './streaks/ReplicatedStreaks';
import {
  NO_SPECTATOR_TARGET,
  nextSpectatorTarget,
  pickSpectatorTarget,
  type SpectatorCandidate,
} from '../shared/modes/SpectatorTarget';


import type { ProjectileState, SmokeState, StreakView } from '../shared/net/Skirmish';

/** Shared empties, so clearing replicated equipment allocates nothing. */
const EMPTY_PROJECTILES: readonly ProjectileState[] = [];
const EMPTY_SMOKE: readonly SmokeState[] = [];
import {
  ALL_STREAK_IDS,
  DEFAULT_STREAK_CONFIG,
  streakDef,
  type StreakConfig,
  type StreakDef,
  type StreakId,
} from '../shared/streaks/StreakDefs';
import type { CamoId } from '../shared/meta/Camos';
import type { ResolvedLoadout } from '../shared/meta/Loadouts';
import type { Profile } from './meta/Profile';
import type { XpReport } from '../shared/meta/XpRules';
import type { GameMode } from '../shared/modes/GameMode';
import { isObjectiveProvider } from '../shared/ai/ObjectiveIntent';
import { MatchFlow } from '../shared/modes/MatchFlow';
import type { MapEntry, ModeEntry } from '../shared/modes/ModeRegistry';
import { Health, type HealthConfig } from '../shared/player/Health';
import type { MovementConfig } from '../shared/player/MovementConfig';
import type { PlayerController } from '../shared/player/PlayerController';
import type { ViewmodelLayer } from './player/Viewmodel';
import { LOW_HEALTH_THRESHOLD } from './ui/Hud';
import { SCOPE_VIEWMODEL_HIDDEN } from './ui/HudTactical';
import { MatchHud } from './ui/MatchHud';
import type { CollisionWorld } from '../shared/world/CollisionWorld';
import { makeRayHit, type RayHit } from '../shared/world/Geometry';
import type { ObjectiveKind } from '../shared/world/maps/types';
import { ViewmodelAnim, makeViewmodelDrive, type ViewmodelDrive } from './weapons/ViewmodelAnim';
import type { ViewmodelConfig } from '../shared/weapons/ViewmodelConfig';
import { WeaponAudio } from './weapons/WeaponAudio';
import { Melee } from '../shared/weapons/Melee';
import type { WeaponDef } from '../shared/weapons/WeaponDefs';
import { buildWeaponModel, type WeaponModel } from './weapons/WeaponMesh';
import { buildKnifeModel, type KnifeModel } from './weapons/KnifeMesh';
import { WeaponSystem, type WeaponSnapshot } from '../shared/weapons/WeaponSystem';

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

  /**
   * The match is driven by a server (M10).
   *
   * A flag rather than a subclass, and deliberately narrow: it turns off the three things
   * this file does that a **dedicated server owns instead** (S4.9), and touches nothing else.
   *
   * 1. **No local bot roster.** The server has the bots. `BotDirector` is still constructed —
   *    the navmesh it bakes is what the spawn selector and the debug tools read — it is
   *    simply never populated and never stepped.
   * 2. **No local mode clock.** Score, round state and the match result arrive replicated.
   * 3. **No local respawn.** The server decides when a body comes back and where.
   *
   * Everything else runs exactly as it does in single-player: the weapon, the viewmodel, the
   * camera, the HUD, the audio, the hitmarkers. That is the point of S3's *"a networked event
   * and a local one must be indistinguishable to the client"* — the presentation layer never
   * learns which kind of match it is in.
   */
  readonly networked?: boolean;

  /**
   * Ask the server to spend a streak (M11 Gate B, §8.22).
   *
   * Supplied only by a networked match; single-player activates locally and never calls it.
   * The coordinates are the mortar's marked point — every other streak is placed by the server
   * from its own copy of where this player is standing, because the position a streak lands at
   * is not a thing an untrusted client gets to choose (§4.16).
   */
  readonly onStreakRequest?: ((id: StreakId, markX: number, markZ: number) => void) | undefined;

  /**
   * Where the drawable bodies come from (M10, S6.5).
   *
   * Defaults to the local bot roster, which is what single-player has always drawn. A
   * networked match supplies the remote actors rebuilt from snapshots instead — same mesh,
   * same animations, same renderer, because both satisfy `RenderableActor`.
   */
  readonly actors?: (() => Iterable<RenderableActor>) | undefined;
  /** M7: killstreak tuning. Live-editable from the debug panel. */
  readonly streakConfig?: StreakConfig;

  /**
   * Which entity this client is (M10, playtest round 2).
   *
   * Absent in single-player, where it is `PLAYER_ENTITY_ID` and always was. On a dedicated
   * server the seat is assigned in the `Welcome` and is 1 or above, and every "was that me?"
   * test in this file and in `MatchFeedback` reads it — see `LocalIdentity` for the list of
   * things that silently did nothing while they were all comparing against 0.
   */
  readonly identity?: LocalIdentity;

  /**
   * The side the server put this client on. Single-player is always `PLAYER_TEAM`.
   *
   * It decides whether the announcer calls the result a victory or a defeat, which is the one
   * place a networked client would otherwise congratulate the player for losing.
   */
  readonly localTeam?: BotTeam;

  /**
   * The name this client is known by. `PLAYER_NAME` in single-player.
   *
   * The scoreboard registers the local row before the first snapshot arrives, so without this
   * the player's own row read `OPERATOR` while every other client — and the killfeed, which
   * resolves names from the snapshot — called them by the name they joined with.
   */
  readonly localName?: string;
}

/** The player's side. Bots added to 'A' fight alongside them, 'B' against. */
export const PLAYER_TEAM: BotTeam = 'A';

/** Reused every frame by the objective-bearing bridge below (S4.7: no render allocation). */
const bombBearingScratch = { active: false, x: 0, z: 0 };

/**
 * Standing eye height, for a remote body whose exact stance eye is not on the wire.
 *
 * Matches `PlayerSimState`'s standing value. Only ever used to lift a positional sound off
 * the floor, never for anything the simulation reads.
 */
const DEFAULT_EYE_HEIGHT = 1.65;

/** Reused by `bodyAt`; the callers read it during the call and never keep it. */
const bodyScratch: BodyPose = { x: 0, y: 0, z: 0, eyeHeight: DEFAULT_EYE_HEIGHT };

export const PLAYER_NAME = 'OPERATOR';

/**
 * Seconds the player spends dead.
 *
 * **The server's number, not a copy of it** (playtest round 4). It was a local `4.5` beside
 * `BotDirector.RESPAWN_SECONDS`'s `4.5` — the same fact written twice, and the death screen's
 * countdown is what the quick class selector's window is derived from, so the day the two
 * drifted the panel would have closed early or late with nothing to point at. Reading the one
 * the server actually respawns on is also what lets `HeadlessClient` step the same display
 * timer and measure the same window.
 */
const PLAYER_RESPAWN_SECONDS = RESPAWN_SECONDS;

/** Heartbeat rate at the low-health threshold and at zero, beats per minute (S6.4). */
const HEARTBEAT_BPM_CALM = 74;
const HEARTBEAT_BPM_PANIC = 152;

/** Radius the mortar overlay draws its strike zone at. Matches the streak's own scatter. */
const MORTAR_MARK_RADIUS = DEFAULT_STREAK_CONFIG.mortarScatter;

/**
 * Metres the mortar mark travels per radian of look.
 *
 * Tuned so a quarter-turn crosses Foundry's long axis: precise enough to pick a doorway,
 * quick enough that marking does not feel like dragging.
 */
const MORTAR_STEER_M_PER_RAD = 42;

/** Every streak, for entities that have no loadout to narrow it — which is every bot. */

export class Match {
  readonly damage: DamageSystem;
  readonly weapons: WeaponSystem;
  /**
   * The knife (post-M8). Alongside the weapon rather than inside it — see `weapons/Melee.ts`
   * for why a melee is not an inventory slot.
   */
  readonly melee: Melee;
  /** Only on the grey-box testbed: a firing range does not belong on a TDM map. */
  readonly range: TargetRange | null;
  readonly fx: Fx;
  readonly weaponAudio: WeaponAudio;
  /** One per inventory slot; only the active one is visible. */
  readonly models: WeaponModel[];
  /** The knife viewmodel. Alongside the weapons rather than among them — see the constructor. */
  private readonly knifeModel: KnifeModel;
  /** The camo each slot is wearing, so a rebuild does not lose it. */
  private readonly slotCamos: Array<CamoId | null> = [];
  /** The visible one. Reassigned on a swap. */
  model: WeaponModel;
  readonly anim: ViewmodelAnim;
  readonly latency = new LatencyProbe();
  readonly playerHealth: Health;
  readonly playerCombatant: PlayerCombatant;
  readonly bots: BotDirector;
  /** The bodies. Client-only from M9 — the director owns the roster, not the meshes. */
  readonly botRenderer: BotRenderer;

  // ---- M4: the match, as opposed to the firefight -------------------------
  readonly score: ScoreSystem;

  /**
   * Which entity this client is. `PLAYER_ENTITY_ID` unless a server said otherwise.
   *
   * Read through `localId` at the point of use rather than copied into a field, because the
   * assignment arrives over a socket and may land after any given object was constructed.
   */
  private readonly identity: LocalIdentity;
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
  /** The sentry and care-package bodies. Client-only from M9 — see `StreakRenderer`. */
  readonly streakRenderer: StreakRenderer;
  /** M7: flags, capture rings, dog tags and the bomb, as things in the world. */
  readonly objectives: MatchObjectives;
  /** M7: the mortar targeting map. Built once; only rasterises when first opened. */
  readonly mortarOverlay: MortarOverlay;

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
  private roundResetSubscription: (() => void) | null = null;

  private active = false;
  private playerDead = false;
  /**
   * The last replicated spawn serial this client acted on. `-1` before the first snapshot.
   *
   * The networked half of "a new life started" (playtest round 4, B3). See
   * `applyReplicatedSelf`.
   */
  private lastSpawnSerial = -1;
  /** Previous tick's buttons, for edge detection in the sim (S4.2). */
  private prevButtons = 0;
  /**
   * The command this tick, for the Chopper Gunner (M11 Gate B).
   *
   * `StreakSystem` pulls per-owner commands now rather than being handed one, so that a server
   * with two gunners does not fly both off the same stick. The client's answer is the local
   * player's current command, stashed here immediately before `simulate`.
   */
  private lastStreakCommand: InputCommand | null = null;

  /**
   * Who this player is watching while dead (§6.8).
   *
   * Cleared on every round start — the §4.18 discard rule applied to a round boundary. Without
   * it a spectator returns from the round they died in still pointed at a body that has since
   * respawned somewhere else, which reads as the camera being stuck.
   */
  private spectatorTarget = NO_SPECTATOR_TARGET;

  /**
   * The server's streak state (M11 Gate B, §8.22).
   *
   * Populated only in a networked match, where `this.streaks` is constructed but never
   * simulated. See `ReplicatedStreaks` for why the client does not simply fold its own
   * replicated kill events into its own counter.
   */
  private readonly replicatedStreaks = new ReplicatedStreaks();
  /**
   * Where a mortar will land if one is called in.
   *
   * Defaults to the map centre and is moved by the targeting overlay. Held here rather than in
   * the overlay so a mortar called from the console — or, later, by a bot — still has a mark.
   */
  mortarMarkX = 0;
  mortarMarkZ = 0;
  /** The player's three equipped streaks, refreshed whenever the class changes. */
  private equippedStreakIds: readonly StreakId[] = [];
  /**
   * The three equipped streaks **in key order**, nulls kept (M11 Gate B playtest).
   *
   * `equippedStreakIds` drops the empty slots because `StreakSystem` wants a set to decide what
   * this player may earn. The keys want the opposite: position is the whole meaning, because key
   * 3 is slot 0 and key 5 is slot 2 whatever is or is not in between. Packing the two together
   * is what made key 5 dead for a player carrying one streak.
   */
  private streakSlots: readonly (StreakId | null)[] = [null, null, null];
  /** Look angles when the overlay opened, so the mark is steered by the delta. */
  private overlayYaw = 0;
  private overlayPitch = 0;
  private playerRespawnTimer = 0;
  private heartbeatTimer = 0;
  private rosterRegistered = false;

  constructor(deps: MatchDeps) {
    this.deps = deps;
    // First, because almost everything below is handed it.
    this.identity = deps.identity ?? new LocalIdentity();

    this.damage = new DamageSystem(deps.bus);
    this.playerHealth = new Health(deps.healthConfig);
    this.playerCombatant = new PlayerCombatant(
      this.playerHealth,
      deps.localTeam ?? PLAYER_TEAM,
      deps.player,
      deps.movementConfig,
      /**
       * The server's seat, not the constant (M11 Gate B playtest).
       *
       * The same eighth-argument fix `WeaponSystem` documents below, applied to the body the
       * weapon shoots *past*. `Ballistics.nearestTarget` excludes the shooter by id, so a rig
       * registered as entity 0 while the weapon fires as entity 3 is a rig the shooter's own
       * rounds are entitled to hit — and they hit it at t = 0, because the muzzle ray starts
       * inside it. See `PlayerCombatant.entityId` for the three faults that produced.
       */
      this.identity.entityId,
    );
    this.damage.register(this.playerCombatant);
    this.selfDamage = makeDamageRequest(deps.weaponDef);
    // Both ends are this client's own seat: `applySelfDamage` is the debug lever that runs
    // real damage at the player, and a request addressed to entity 0 would land on nobody.
    this.selfDamage.targetId = this.identity.entityId;
    this.selfDamage.sourceId = this.identity.entityId;

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
      /**
       * The **eighth** argument, and it is the whole fix.
       *
       * `WeaponSystem` defaults `sourceId` to `PLAYER_ENTITY_ID`, which is 0 — right in
       * single-player, wrong the moment a server assigns an entity id. `Inventory` stamps that
       * id onto `EV.WeaponSwapped` and the subscription filters on `identity.is(sourceId)`, so
       * over the network the swap event announced entity 0, the filter rejected it, and
       * `showSlot` never ran: the mechanics changed weapon and the model in your hands did not.
       *
       * Captured at construction rather than read per event, which is safe because a
       * reassignment tears the world down and builds a fresh `Match` around the new identity.
       */
      this.identity.entityId,
    );

    this.melee = new Melee({
      world: deps.world,
      damage: this.damage,
      bus: deps.bus,
      // The knife swings as whoever this client is, for the same reason the rifle fires as
      // them: the swing excludes its own source, and a mismatch stabs the swinger.
      sourceId: this.identity.entityId,
    });

    // The world is handed over so each dummy is dropped onto the geometry actually beneath
    // it rather than trusting the authored `y` (post-M8; see `TargetRange`).
    this.range = deps.map.targetRange
      ? new TargetRange(this.damage, deps.bus, deps.healthConfig, deps.world)
      : null;
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
    // M9: the bodies are the client's, not the director's. `BotRenderer` reconciles its
    // mesh set against the roster each frame and drives the animations off `BotVisualState`.
    this.botRenderer = new BotRenderer(
      deps.actors ?? (() => this.bots.bots),
      () => this.bots.freeForAll,
    );
    deps.scene.add(this.botRenderer.group);

    // ---- the mode ---------------------------------------------------------
    this.score = new ScoreSystem(deps.bus, this.identity);
    // See `ScoreSystem.freeForAll`. The replicated path records kills here too, so a client
    // that dropped same-side kills showed a personal counter that stalled while the server's
    // ladder moved — which is the FFA scoreboard the playtest reported as "not working".
    this.score.freeForAll = deps.mode.freeForAll === true;
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
      // The server put us on a side; in single-player there is only one to be on.
      localTeam: deps.localTeam ?? PLAYER_TEAM,
      identity: this.identity,
      /**
       * A networked client's flow is **replicated, not simulated** (M10, playtest round 2).
       *
       * `simulate` is already skipped for it, so the mode was never going to score — but the
       * kill subscription inside `MatchFlow` ran regardless and resolved against an empty
       * roster, which is why the killfeed was silently blank all milestone. Saying so here
       * makes the two drive modes a property of the object rather than an accident of which
       * methods the caller remembers not to invoke.
       */
      authoritative: deps.networked !== true,
      onSidesSwapped: (swapped) => this.bots.spawns.setSideSwap(swapped),
    });
    this.bots.respawnPolicy = {
      allowed: (id) => this.flow.respawnAllowed(id),
      noted: (id) => this.flow.noteRespawn(id),
    };
    // M7: if the mode has objectives, hand the director the provider. `ai/` asks and the
    // mode answers; nothing in `ai/` knows a flag from a bomb site (see `ObjectiveIntent`).
    this.bots.objectives = isObjectiveProvider(this.mode) ? this.mode : null;
    // Post-M8: the player collects the bomb with the Use key rather than by walking over it.
    // The mode is told *which* entity drives itself; it never learns that one of them is human.
    if (this.mode instanceof SearchAndDestroy) {
      this.mode.manualPickup = (id) => id === this.localId;
    }
    this.bots.freeForAll = deps.mode.freeForAll === true;
    // There is no such thing as a teammate in FFA, so the friendly-fire gate at the damage
    // door has to come off or half the lobby is unkillable by the other half.
    if (deps.mode.freeForAll === true) this.damage.friendlyFire = true;
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

    /**
     * The knife (round 2). One static model, built with the weapons and hidden until it swings.
     *
     * Not an entry in `models`: that array is the inventory, indexed by slot, and everything
     * that walks it — `equip`, `showSlot`, the camo bookkeeping — would have to special-case a
     * third element that is not a weapon. A knife is a thing you *do*, which is the same reason
     * `Melee` is not a `Weapon`; see the header of `weapons/Melee.ts`.
     */
    this.knifeModel = buildKnifeModel(deps.anisotropy);
    this.knifeModel.root.visible = false;
    this.knifeModel.arm.visible = false;
    deps.viewmodel.add(this.knifeModel.root);
    deps.viewmodel.add(this.knifeModel.arm);
    this.anim.setKnife(this.knifeModel.root, this.knifeModel.arm);

    this.ui = new MatchHud({
      bus: deps.bus,
      uiHost: deps.uiHost,
      mapDef: deps.map.def,
      mapName: deps.map.name,
      modeName: this.mode.name,
      columns: this.mode.getScoreboardColumns(),
      score: this.score,
      audio: deps.audio,
      localTeam: this.localTeam,
      roster: this.bots.roster,
      teamSize: deps.map.teamSize,
      freeForAll: deps.mode.freeForAll === true,
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
      identity: this.identity,
      bodyAt: (entityId) => this.bodyAt(entityId),
      onPlayerKilled: () => this.onPlayerKilled(),
      listener: () => this.listenerAt,
    });

    // The mesh follows the inventory. `weapon.swapped` fires at the hand-over, which is the
    // exact tick the old weapon has finished going down and the new one starts coming up.
    this.swapSubscription = deps.bus.on(EV.WeaponSwapped, (p) => {
      if (!this.identity.is(p.sourceId)) return;
      this.showSlot(this.weapons.inventory.activeSlotIndex);
    });

    /**
     * A new round puts everybody back where they started (post-M8 playtest).
     *
     * Only for modes that actually have rounds, which in practice is Search & Destroy: a
     * single-round mode fires this once, at the start, where it is a no-op against a world
     * that has just spawned everyone anyway.
     *
     * Subscribed rather than called from `MatchFlow`, because respawning is not the flow's
     * job — it owns *whether* somebody may come back and this owns *putting them there*, and
     * merging the two would put the roster and the spawn selector inside the round machine.
     */
    this.roundResetSubscription = deps.bus.on(EV.RoundStarted, () => {
      if (this.deps.mode.usesRoundReset !== true) return;
      // No state leaks across a round boundary, the camera's included. True in both runtimes:
      // where the player is put is the server's business, where the camera looks is not.
      this.spectatorTarget = NO_SPECTATOR_TARGET;
      /**
       * The **server** puts everybody back in a networked match (playtest round 4, B3).
       *
       * This ran in both runtimes, and over the network it was a second writer against the one
       * fact a client may not decide: `hardResetRound` calls `respawnPlayer`, which runs
       * `selectSpawn` and teleports the local controller to a point the client chose while the
       * server was putting the body somewhere else — a guaranteed misprediction of up to the
       * width of the map, every round, corrected a snapshot later by a camera lurch.
       *
       * It also concealed B3 by accident: the local `player.spawn` emits `player.spawned`, so
       * the grenades did come back, as a side effect of the teleport rather than because
       * anything had decided a life had started. Removing the teleport without the serial above
       * would have turned an intermittent bug into a certain one.
       */
      if (this.isNetworked) return;
      this.hardResetRound();
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
      localTeam: this.localTeam,
      localId: this.identity.entityId,
      seed: deps.seed,
      // The server resolves every blast in a networked match (S4.15). This system stays for
      // the prediction and the drawing of the player's own throw.
      authoritative: deps.networked !== true,
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
      localTeam: this.localTeam,
      localId: this.identity.entityId,
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
      // One HUD, one player: the client's answer to both of these is "is this me" (M11 Gate B).
      reportProgressTo: (id) => this.identity.is(id),
      commandFor: (id) => (this.identity.is(id) ? this.lastStreakCommand : null),
      targetable: (id) => (this.identity.is(id) ? this.meta.state.targetedByStreaks : true),
      visibleToUav: (id) => (this.identity.is(id) ? this.meta.state.visibleToUav : true),
      streakDiscount: (id) => (this.identity.is(id) ? this.meta.state.streakDiscount : 0),
      // The player earns only what their class equips; bots have no class, so they keep the
      // full list and behave exactly as they did before.
      equippedStreaks: (id) => (this.identity.is(id) ? this.equippedStreakIds : ALL_STREAK_IDS),
      context: {
        bus: deps.bus,
        world: deps.world,
        damage: this.damage,
        bots: this.bots,
        // M9: one port instead of a scene, an Fx pool, a camera rig and an audio graph.
        // The server hands the same streaks `SILENT_PRESENTATION` and they do not notice.
        present: new ClientStreakPresentation(
          new StreakAudio(deps.audio),
          this.fx,
          deps.cameraRig,
          (x, y, z, radius, bright) => this.equipment.fx.spawnBlast(x, y, z, radius, bright),
        ),
        mapDef: deps.map.def,
        cfg: deps.streakConfig ?? DEFAULT_STREAK_CONFIG,
        rng: new Rng(deps.seed ^ 0x5bd1_e995),
        tiers: deps.tiers,
        roster: this.bots.roster,
      },
    });
    this.streakRenderer = new StreakRenderer(this.streaks);
    deps.scene.add(this.streakRenderer.group);
    // Care packages are contestable in every mode, so they ride the second provider slot
    // rather than the mode's (see `BotDirector.streakObjectives`).
    this.bots.streakObjectives = this.streaks;
    this.setStreakLoadout(deps.loadout.streaks);

    this.objectives = new MatchObjectives({
      bus: deps.bus,
      scene: deps.scene,
      mode: this.mode,
      localTeam: this.localTeam,
    });
    this.mortarOverlay = new MortarOverlay({
      host: deps.uiHost,
      mapDef: deps.map.def,
      onConfirm: (x, z) => {
        this.mortarMarkX = x;
        this.mortarMarkZ = z;
        /**
         * Through `spendStreak`, not straight into the local system (M11 Gate B playtest).
         *
         * This called `streaks.activate` directly, which on a networked client fires a streak
         * into the copy of `StreakSystem` that is deliberately never simulated — so the mark
         * was confirmed, the streak left the pending list, and no shell ever fell. The server
         * was never asked. `spendStreak` is the one door that knows which of the two a match is.
         */
        this.spendStreak('mortar', x, z);
      },
      onCancel: () => {
        /* The streak stays pending: cancelling a mark must not spend it. */
      },
    });
    // Flags and bomb sites are worth drawing on the minimap; a TDM map is not (M4's note).
    // The *kinds* matter too: Foundry authors flags and bomb sites together, so a mode that
    // does not filter shows both at once.
    const kinds = objectiveKindsFor(this.mode);
    this.ui.hud.minimap.objectiveKinds = kinds;
    this.ui.hud.minimap.showObjectives = kinds.length > 0;

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
    // A networked match's roster lives on the server (S4.15). Populating one here would put
    // ten bots in the world that only this client can see, fighting nobody.
    if (!this.isNetworked && this.bots.botCount === 0 && this.deps.mode.populatesRoster) {
      this.populateDefault();
    }
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
    this.score.register(this.localId, this.deps.localName ?? PLAYER_NAME, this.deps.localTeam ?? PLAYER_TEAM);
    for (const bot of this.bots.bots) this.score.register(bot.entityId, bot.displayName, bot.team);
  }

  get isPlayerDead(): boolean {
    return this.playerDead;
  }

  /**
   * The side the server put this client on; `PLAYER_TEAM` in single-player.
   *
   * A getter rather than the `deps.localTeam ?? PLAYER_TEAM` expression repeated at each use,
   * because "which team am I" being answered by a constant is precisely how the alive counter
   * came to label a team-B player's own side as the enemy.
   */
  get localTeam(): BotTeam {
    return this.deps.localTeam ?? PLAYER_TEAM;
  }

  /**
   * Which seat is looking at the HUD, as one value (playtest round 4, B12).
   *
   * `localTeam` alone is not enough to decide a colour, because Free-for-All keeps the
   * two-team substrate and half of an FFA lobby therefore shares the viewer's side without
   * being on their team. Both facts travel together or the killfeed paints four opponents
   * green, which is the seam post-M8 closed in the minimap and left open everywhere else.
   */
  get viewer(): ViewerContext {
    return { team: this.localTeam, freeForAll: this.deps.mode.freeForAll === true };
  }

  /**
   * How many of a side are still standing, from whichever body source this match has.
   *
   * Single-player holds `Bot`s on a roster; a networked match holds `RemoteActor`s rebuilt from
   * snapshots. A caller that wants a number should not have to know which — and
   * `SearchAndDestroy.aliveCount` walks `ModeDeps.roster`, which on a networked client is
   * **empty**, so it returned 0 for both sides for the whole match. The local player is counted
   * separately because they are in neither list.
   */
  countAlive(team: BotTeam): number {
    let n = 0;
    if (this.isNetworked) {
      const actors = this.deps.actors;
      if (actors !== undefined) {
        for (const actor of actors()) {
          if (actor.team === team && actor.participating) n++;
        }
      }
      // A client's own entity is not among its remote actors, so it is never double-counted.
      if (this.localTeam === team && !this.playerDead) n++;
      return n;
    }
    for (const c of this.bots.roster) {
      if (c.team === team && c.participating) n++;
    }
    return n;
  }

  /**
   * The entity id this client's own player occupies.
   *
   * `PLAYER_ENTITY_ID` in single-player and the server's assignment in a networked match.
   * Everything that used to compare against the constant compares against this.
   */
  get localId(): number {
    return this.identity.entityId;
  }

  /**
   * Find a body by entity id, whichever kind of match this is (M10, playtest round 2).
   *
   * Single-player has one place to look and a networked match has another: the roster holds
   * `Bot`s here and `RemoteActor`s there, and only one of the two is ever populated. Callers
   * that want to put a sound on a body or point a chevron at one should not have to know
   * which — that is exactly the knowledge that leaked into `MatchFeedback` and made every
   * positional cue silent over the network.
   *
   * The remote pose is sampled at `alpha` 1, the newest interpolated position. A sound is a
   * one-shot placed at the instant it fires; blending it against the previous frame would
   * buy nothing audible.
   */
  private bodyAt(entityId: number): Readonly<BodyPose> | null {
    const bot = this.bots.get(entityId);
    if (bot !== undefined) {
      bodyScratch.x = bot.px;
      bodyScratch.y = bot.py;
      bodyScratch.z = bot.pz;
      bodyScratch.eyeHeight = bot.eyeHeight;
      return bodyScratch;
    }

    const actors = this.deps.actors;
    if (actors !== undefined) {
      for (const actor of actors()) {
        if (actor.entityId !== entityId) continue;
        bodyScratch.x = actor.renderX(1);
        bodyScratch.y = actor.renderY(1);
        bodyScratch.z = actor.renderZ(1);
        // The rig's own eye height is not replicated; the standing default is close enough
        // for a sound and is what the local case uses for a standing bot.
        bodyScratch.eyeHeight = DEFAULT_EYE_HEIGHT;
        return bodyScratch;
      }
    }
    return null;
  }

  /**
   * Nobody may move or shoot right now (post-M8 playtest).
   *
   * True through the 3-2-1 and through the hold between rounds. The brief asks for movement
   * and shooting to be locked during the countdown and for the camera to stay free, which is
   * exactly the split `Input.sampleSpectating` already produces — it zeroes the axes and the
   * buttons and stamps the live view angles — so `Game` reads this and picks that sampler
   * rather than a fourth one being written.
   *
   * `ROUND_END` is included on purpose. It is the same situation as the warm-up with the
   * clock running the other way: the round is decided, and letting people keep shooting into
   * it is how a Search & Destroy round that has already been won produces another death on
   * the scoreboard.
   */
  get inputFrozen(): boolean {
    // Networked: the server says so, through the snapshot header. Its own `MatchFlow` is the
    // one running, and this client's is inert.
    if (this.isNetworked) return this.netFrozen;
    const phase = this.flow.currentPhase;
    return phase === 'WARMUP' || phase === 'ROUND_END';
  }

  /**
   * Whether the player's command should be neutered this tick. Read by both samplers.
   *
   * It used to be `uiFocus || inputFrozen`, where `uiFocus` meant *a front-end surface has the
   * keyboard and the cursor* — built for the Create-a-Class overlay, which was opened over a
   * running match because there is no pausing a dedicated server. Playtest round 4 (B8) made
   * the editor a front-end screen again, and that left `uiFocus` a boolean with **no writer**:
   * dead state sitting in the input path, indistinguishable from a flag somebody forgot to
   * set. The quick class selector never needed it — it is offered only in the two windows
   * where the body is already frozen, which is what `inputFrozen` says.
   */
  get inputSuppressed(): boolean {
    return this.inputFrozen;
  }

  /** True when this match is driven by a server. See `MatchDeps.networked`. */
  get isNetworked(): boolean {
    return this.deps.networked === true;
  }

  /**
   * Adopt the local player's replicated health and liveness (M10 playtest fix).
   *
   * The server owns whether this player is alive; before this the client decided for itself
   * and got it wrong in the only way that matters. `onPlayerKilled` keys on
   * `PLAYER_ENTITY_ID`, which is entity **0** — the server's empty spectator seat — while a
   * connected human is entity 1 or above. So the death path never fired, the death screen
   * never appeared, and `stepPlayerRespawn` (the only thing that clears `playerDead`) is
   * skipped in networked matches anyway. Three separate notions of "am I dead", one of them
   * authoritative and none of them talking to each other.
   *
   * Now there is one: this. Called on every change to the replicated health or alive bit.
   */
  applyReplicatedSelf(health: number, alive: boolean, spawnSerial: number): void {
    if (!this.isNetworked) return;

    /**
     * The life boundary is the **spawn serial**, and it is not the alive bit (round 4, B3).
     *
     * This used to read `alive && this.playerDead` — a life starts when a dead player stops
     * being dead — and that is true of a respawn and of nothing else. A Search & Destroy
     * survivor's next round is a new life the server spawns without ever having killed them,
     * and so is a class change cashed during the pre-match freeze (`applyPendingLoadoutNow`):
     * in both the server picks a spawn point, refills its own copy of the hand and bumps the
     * serial, while the client's alive bit never moves and its own per-life reset never runs.
     * The report's *"in certain modes"* is exactly that set — the modes where a life can begin
     * without a death.
     *
     * The serial covers both, because it is what `PlayerController.spawn` moves and every new
     * life on the server goes through that one door. It is also strictly stronger than what it
     * replaces: a respawn bumps it too, so the ordinary case is the same event seen through a
     * signal that does not have a hole in it.
     *
     * Derived by comparison rather than by a flag on the wire: the serial is state, it stays
     * true after the snapshot that carried it, and comparing it with the last one acted on
     * cannot miss an edge by arriving late.
     */
    if (spawnSerial !== this.lastSpawnSerial) {
      this.lastSpawnSerial = spawnSerial;
      this.beginLife();
    }

    // After the reset, deliberately: `beginLife` puts the local `Health` back to full, and the
    // server's answer has to be the last word on this even in the frame a life starts.
    this.playerHealth.setReplicated(health, alive);

    if (!alive && !this.playerDead) this.onPlayerKilled();
  }

  /**
   * A new life, where the server already put us. The networked per-life reset, entire.
   *
   * Everything `respawnPlayer` does **except choose a position**: no `selectSpawn`, no
   * `player.spawn`, no `setView`. The server picked the spawn point, the snapshot carried it,
   * and prediction has already adopted it — re-spawning locally would fight the authoritative
   * position and yank the camera somewhere the server disagrees with.
   *
   * What it does do is the per-life reset the rest of the client depends on: full health, a
   * reloaded weapon on the right slot, the sights down, the knife put away, grenades back.
   *
   * Called from one place, off one signal — see `applyReplicatedSelf`. It was named
   * `respawnNetworked` while a respawn was the only way it could be reached; a round start is
   * the other way, and naming it after the death it no longer needs is what let the round start
   * be forgotten.
   */
  private beginLife(): void {
    // Before the weapon reset, so the reset puts the *new* class's primary in hand rather than
    // the old one's and then having it swapped out from under the animation.
    this.applyPendingLoadout();
    this.playerHealth.reset();
    this.weapons.reset();
    /**
     * The grenades, explicitly (M11 Gate B playtest, and round 4's B3).
     *
     * `MatchEquipment` refills on `player.spawned`, and this path deliberately never emits one
     * — the server chose the position, so `PlayerController.spawn` is not called. So the one
     * event the refill hangs off does not exist over the network, and a networked player came
     * back with whatever the previous life had left. The server refilled its own copy on the
     * same spawn all along, which is why nothing desynced and nothing logged — only the HUD and
     * the local hand were wrong.
     *
     * Round two's fix was this call; round four's is *what reaches it*. The call was right and
     * the trigger was half a signal.
     */
    this.equipment.refillForLife();
    // A reset is not a swap and emits no `weapon.swapped`, so the visible model has to be
    // told separately or it keeps whatever was in frame when the player died.
    this.showSlot(this.weapons.inventory.activeSlotIndex);
    this.melee.reset();
    this.playerCombatant.syncRig();
    this.playerDead = false;
    this.playerRespawnTimer = 0;
  }

  /**
   * Replicated freeze state, written by the net session from the snapshot header.
   *
   * Held here rather than read from the session because `inputFrozen` is consulted from the
   * sampler in `Game.simulate`, which has a `Match` and no reason to learn about sockets.
   */
  netFrozen = false;

  /**
   * Debug spectator state (post-M8, `debug/Spectator.ts`).
   *
   * Held here rather than in the debug suite because two of the three things it does are
   * facts about the *match* — whether the player can be hurt and whether anybody is looking
   * for them — and both are already expressed on `PlayerCombatant`. The suite owns the
   * toggle and the panel; this owns what the toggle means.
   */
  godMode = false;
  hiddenFromBots = false;

  get playerRespawnSeconds(): number {
    return this.playerRespawnTimer;
  }

  /**
   * Held Tab, as of the last command this match consumed (S4.2, playtest round 4).
   *
   * Derived from `prevButtons` rather than latched into a field of its own: the bit is already
   * kept for edge detection, and a second copy of it would be the second writer this session
   * exists to remove. The scoreboard's visibility is a pure function of this and the screen —
   * see `shared/ui/HudSurfaces.ts`.
   */
  get scoreboardHeld(): boolean {
    return isDown(this.prevButtons, Btn.Scoreboard);
  }

  /** The scoreboard's one writer, called once per frame from `Game.updateHudSurfaces`. */
  setScoreboardOpen(on: boolean): void {
    this.ui.setScoreboardOpen(on);
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
    /**
     * **On the next spawn, unless there is not going to be one to wait for** (M11 Gate B).
     *
     * This used to apply unconditionally, which is Tier 1 #20 arriving from the client's side:
     * `meta.setLoadout` re-runs the perk hooks and one of them writes `PlayerController
     * .speedScale`, so a class swapped on a *standing* body changed how fast this client
     * predicted itself moving while the server — which defers to the next spawn by rule
     * (`ServerMatch.setPendingLoadout`) — kept simulating the old figure. A constant per-tick
     * disagreement about speed, which is what rubberbanding is.
     *
     * It mattered little when the editor was a screen you had to pause to reach. The quick
     * selector puts it one keypress away, so the two sides now follow the same rule: deferred
     * for a living player mid-match, immediate when the player is dead (their next spawn is the
     * one being waited for) or during the pre-match freeze (where the server applies it at once
     * too — see `ServerMatch.applyPendingLoadoutNow` — and nobody can move regardless).
     */
    if (this.canApplyLoadoutNow()) {
      this.pendingLoadout = null;
      this.applyLoadoutNow(loadout);
      return;
    }
    this.pendingLoadout = loadout;
  }

  /** Whether a class change lands immediately rather than waiting for a body. */
  private canApplyLoadoutNow(): boolean {
    if (this.playerDead) return true;
    return this.flow.currentPhase === 'WARMUP' && this.flow.round <= 1;
  }

  /** The actual swap. Both weapons rebuilt, grenades replaced and refilled, perks re-derived. */
  private applyLoadoutNow(loadout: ResolvedLoadout): void {
    this.setStreakLoadout(loadout.streaks);
    this.equip(0, loadout.primary, loadout.primaryCamo);
    this.equip(1, loadout.secondary, loadout.secondaryCamo);
    this.equipment.inventory.lethal = loadout.lethal;
    this.equipment.inventory.tactical = loadout.tactical;
    EquipmentSystem.refill(this.equipment.inventory);
    this.meta.setLoadout(loadout);
  }

  /**
   * Cash a deferred class change, on the spawn it was waiting for.
   *
   * Called from both respawn paths, so the local and networked halves cannot develop different
   * ideas about when a class takes effect.
   */
  private applyPendingLoadout(): void {
    const pending = this.pendingLoadout;
    if (pending === null) return;
    this.pendingLoadout = null;
    this.applyLoadoutNow(pending);
  }

  /** A class change waiting for this player's next body. See `applyLoadout`. */
  private pendingLoadout: ResolvedLoadout | null = null;

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
    // Health is server-owned in a networked match (S4.15) and arrives replicated. Stepping it
    // here as well would run a *second* regeneration curve against the authoritative one and
    // the bar would visibly disagree with the damage the player is taking.
    if (!this.isNetworked) this.playerHealth.step();
    // The rig follows the capsule on the *tick*, and before anything resolves a shot
    // against it, so a bot's round is tested against where the player was when it fired.
    this.playerCombatant.syncRig();

    // The targeting map owns the input while it is up — firing confirms the mark rather
    // than pulling the trigger.
    const mortarOpen = this.stepMortarOverlay(cmd);
    /**
     * A live Chopper Gunner takes the player's weapon out of the loop entirely (post-M8).
     *
     * Until now the takeover consumed the command *and left the rifle consuming it too*, so
     * holding the trigger in the gunship emptied the magazine on the ground below — reported
     * as "the chopper drains my primary ammo". It also meant the ADS button drove the rifle's
     * `adsFraction` up while the player was a kilometre away from it, which is what hid the
     * crosshair: the scope overlay saw a scoped sniper and took the reticle away.
     *
     * Both are the same bug and this is the one fix. The chopper has always had its own
     * `Ballistics` and its own `WeaponDef` — an infinite pool by construction, because it
     * spends no magazine — and now nothing else is spending one on its behalf.
     */
    const flyingChopper = this.streaks.activeChopperFor(this.localId) !== null;
    // A hand on a grenade — or on the knife — is a hand off the rifle. One flag, read by the
    // weapon and by the viewmodel, so the gun cannot be fired while it is visibly lowered.
    //
    // The held button is part of the test, not just the thrower state. `equipment.simulate`
    // runs *after* the weapon this tick, so on the very first tick of a cook `busy` is still
    // last tick's answer and exactly one round escaped - measured, not theorised.
    /**
     * Reaching for something else cancels a reload (post-M8 playtest).
     *
     * The report was that grenades can be thrown mid-reload, and the fix the brief allows is
     * either blocking the throw or cancelling the reload. Cancelling is the right one: a
     * blocked throw is an input the player made that the game silently ate, and the magazine
     * is not lost either way — `Weapon` only banks ammunition on completion, so an interrupted
     * reload leaves the count exactly as it was. It is the same rule a swap already follows.
     *
     * Tested on the *press edge* rather than on `busy`, so it fires once, on the tick the hand
     * leaves the rifle, and a held cook does not keep re-cancelling nothing.
     */
    const meleePressed = justPressed(cmd.buttons, this.prevButtons, Btn.Melee);
    const reachedThisTick =
      justPressed(cmd.buttons, this.prevButtons, Btn.Lethal) ||
      justPressed(cmd.buttons, this.prevButtons, Btn.Tactical) ||
      meleePressed;
    if (!this.playerDead && reachedThisTick) this.weapons.weapon.cancelReload();

    const reachingForEquipment = isDown(cmd.buttons, Btn.Lethal) || isDown(cmd.buttons, Btn.Tactical);
    // `meleePressed` is part of the test and not just `melee.busy`, for the reason the
    // equipment note above gives: `melee.step` runs *after* the weapon this tick, so on the
    // first tick of a swing `busy` is still last tick's answer — which is exactly how the
    // grenade path let one round escape before it was measured and fixed.
    this.weapons.fireBlocked =
      this.equipment.thrower.busy || reachingForEquipment || this.melee.busy || meleePressed;
    this.weapons.suspended = flyingChopper;

    if (!this.playerDead && !mortarOpen) {
      const sim = this.deps.player.sim;
      this.weapons.step(cmd, sim);

      // The residual half of each recoil kick is a real aim change, so it goes where mouse
      // movement goes rather than into a separate offset the player cannot fight.
      if (this.weapons.takeViewResidual(this.residual)) {
        this.deps.input.addViewOffset(this.residual.yaw, this.residual.pitch);
      }
    }

    /**
     * The knife (post-M8). Edge-detected here, in the sim, from the bitfield — S4.2, and the
     * reason there is no DOM handler anywhere near it.
     *
     * Blocked while a grenade is in hand or the gunship has the camera, both of which are
     * "something else owns the hands" cases the weapon already respects.
     */
    const swing = meleePressed && !mortarOpen && !flyingChopper && !this.equipment.thrower.busy;
    this.melee.step(swing, this.deps.player.sim, !this.playerDead);

    // The glint an enemy can see is a property of the weapon, and `PlayerCombatant` is
    // built before the weapon exists — so it is stamped here, once a tick, before
    // perception runs against it.
    this.playerCombatant.glinting = !this.playerDead && this.weapons.glinting;

    this.range?.step();
    this.equipment.simulate(cmd, this.deps.player.sim, !this.playerDead);
    this.meta.simulate(cmd, this.deps.player.sim, !this.playerDead);
    // Nobody moves or shoots during the 3-2-1 (post-M8). The player's half is handled at the
    // sampler in `Game.simulate`; this is the other half, and both sides freezing is the
    // point — a countdown one side can use to take an angle is not a countdown.
    this.bots.inputFrozen = this.inputFrozen;
    if (!this.isNetworked) this.bots.simulate(cmd.tickIndex, cmd.sampledAtMs);
    // Streaks tick after the bots that may have just shot one down, and before the flow that
    // may declare the match over and end them all.
    /**
     * The server owns every live streak in a networked match (S4.15).
     *
     * Simulating here as well would put a second sentry, with its own aim and its own damage,
     * on top of the one the server is already resolving shots against — the Domination flag bug
     * with a trigger. The client keeps the object because the HUD and the renderer are written
     * against it, and feeds them from `replicatedStreaks` instead.
     */
    if (!this.isNetworked) {
      this.lastStreakCommand = cmd;
      this.streaks.simulate(cmd.tickIndex);
    }
    this.syncChopperBody();
    if (!this.playerDead && !this.mortarOverlay.isOpen) this.stepStreakInput(cmd);
    // Local matches only (M11 Gate B). A networked client's Use key is already in the command
    // it just sent, and `ServerMatch.stepBombInteractions` acts on it there; running this as
    // well would make the client a second authority over a plant timer the server owns, and
    // §6.8 gives that to exactly one of them.
    if (!this.isNetworked && !this.playerDead) this.stepBombInteraction(cmd);
    this.stepInteractPose();
    // The server owns when and where a body comes back (S4.15); the client is told. But
    // `stepPlayerRespawn` also *decrements the display timer*, and skipping the whole method
    // left the death screen frozen on the number `onPlayerKilled` set — see
    // `stepRespawnDisplay`.
    if (!this.isNetworked) this.stepPlayerRespawn();
    else this.stepRespawnDisplay();
    this.stepLowHealthAudio();

    // The mode clock is a gameplay timer and runs on ticks like everything else (S4.1) —
    // except when a server is running it, in which case score and round state arrive
    // replicated and a second clock here would disagree with the first one that matters.
    const t0 = performance.now();
    if (!this.isNetworked) this.flow.simulate(cmd.tickIndex);
    this.lastModeMs = performance.now() - t0;

    /**
     * The scoreboard used to be written from here, and that was the whole of B6.
     *
     * A tick is not a frame. `Game.simulate` stops calling this the moment the screen leaves
     * `MATCH`, so the board kept whatever the last tick had put there — up, over the pause
     * screen, holding a key `Input.clearHeld` had already dropped into a loop that was no
     * longer running. It is derived once per frame in `Game.updateHudSurfaces` now, from
     * `scoreboardHeld` below and from state that outlives the tick.
     */
    this.prevButtons = cmd.buttons;
    this.latency.expire(performance.now());
  }

  /**
   * Take the player's body out of play while they are flying a Chopper Gunner, and put it
   * back the moment they are not (M7 playtest).
   *
   * Driven from the live streak rather than from the activate/expire events, so there is no
   * state to get stuck: if there is no chopper, the body is in play, every tick, unarguably.
   * That is the same reasoning the chopper's single-exit rule uses.
   *
   * Both flags are needed and they do different jobs. `active` false removes the body from
   * perception, spawn scoring and bot target selection — nobody comes looking. `invulnerable`
   * is checked at the damage door and stops anything already in flight (a grenade, a mortar,
   * a sentry burst) from resolving against a player who is not there.
   *
   * This reverses M7's original reading of S6.1's "not invulnerable to a lucky mortar":
   * playtesting found being killed by something you cannot see, react to or avoid reads as
   * broken rather than as risk.
   */
  private syncChopperBody(): void {
    const flying = this.streaks.activeChopperFor(this.localId) !== null;
    // Post-M8: the QA spectator uses the same two levers, so it is folded in here rather
    // than written from a second place. Driven from state every tick means there is still
    // nothing to get stuck — turning god mode off puts the body back on the next tick,
    // unarguably, which is the property this method was built for.
    this.playerCombatant.active = !flying && !this.hiddenFromBots;
    this.playerCombatant.invulnerable = flying || this.godMode;
  }

  /**
   * Hold to plant, hold to defuse (M7 playtest).
   *
   * Held rather than tapped, and re-tested every tick: stepping off the site, releasing the
   * key or dying all cancel, which is what makes a plant something the other side can
   * interrupt. The mode owns the timer and the rules; this only reports that the player is
   * standing in the right place with the key down.
   */
  private stepBombInteraction(cmd: InputCommand): void {
    const mode = this.mode;
    if (!(mode instanceof SearchAndDestroy)) return;

    const holding = isDown(cmd.buttons, Btn.Use);
    if (!holding) {
      // Only cancel what *this* player started; a bot's plant is not the player's to stop.
      if (mode.interactEntity === this.localId) mode.cancelInteract();
      return;
    }

    const me = this.playerCombatant;
    if (mode.bomb === 'PLANTED') {
      if (me.team !== mode.defenders) return;
      const site = mode.plantedSite;
      if (site === null || !site.contains(me)) return;
      mode.beginInteract(me, true);
      return;
    }
    if (mode.bomb !== 'CARRIED') return;
    if (me.team !== mode.attackers) return;
    // Picking the bomb up is now the same key as planting it (post-M8 playtest): walking
    // over it does nothing. Tested before the plant branch because you cannot plant a bomb
    // you are not carrying, and one press should be able to do the first of the two.
    if (!mode.isCarrier(this.localId)) {
      mode.tryPickup(me);
      return;
    }
    if (mode.siteContaining(me) === null) return;
    mode.beginInteract(me, false);
  }

  /**
   * Whoever is planting or defusing kneels over the bomb (post-M8, S6.3's visual indicator).
   *
   * Driven from mode state every tick rather than latched on start and cleared on finish,
   * for the same reason `syncChopperBody` is: an interaction can end four ways — completed,
   * stepped off, key released, killed — and a latch would have to be cleared correctly on
   * all four. Asked every tick, there is nothing to get stuck, and a player who dies
   * mid-defuse does not respawn permanently crouched.
   *
   * It applies to bots as well as the player, which is the half that actually matters: the
   * crouch is how the *other* side can tell at a glance that somebody is on the bomb.
   */
  private stepInteractPose(): void {
    const mode = this.mode;
    if (!(mode instanceof SearchAndDestroy)) return;
    const busy = mode.interactingEntity;

    this.deps.player.forceCrouch = busy === this.localId;
    for (const bot of this.bots.bots) bot.controller.forceCrouch = bot.entityId === busy;
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
  /**
   * Drive the mortar overlay while it is open. Returns true when it owns the input.
   *
   * Steered by the *look delta* rather than a mouse position, because pointer lock means
   * there is no cursor to read and releasing the lock to open a map would drop the player's
   * aim. The player moves the mark exactly as they would move their view.
   */
  private stepMortarOverlay(cmd: InputCommand): boolean {
    if (!this.mortarOverlay.isOpen) return false;

    const dYaw = angleDeltaRad(this.overlayYaw, cmd.yaw);
    const dPitch = cmd.pitch - this.overlayPitch;
    this.overlayYaw = cmd.yaw;
    this.overlayPitch = cmd.pitch;
    // Yaw sweeps the mark east/west, pitch north/south. Scaled so a comfortable flick
    // crosses the map rather than nudging it a metre.
    //
    // The yaw term is **negated**: a view yaw increase turns the player left, and the map is
    // drawn in world axes rather than view axes, so passing it through unchanged sent the
    // cursor the wrong way. Reported from a live match as inverted X.
    this.mortarOverlay.moveBy(-dYaw * MORTAR_STEER_M_PER_RAD, -dPitch * MORTAR_STEER_M_PER_RAD);

    if (justPressed(cmd.buttons, this.prevButtons, Btn.Fire)) this.mortarOverlay.confirm();
    // The same key that opened it closes it, and the streak stays in hand.
    else if (justPressed(cmd.buttons, this.prevButtons, Btn.Streak1) ||
             justPressed(cmd.buttons, this.prevButtons, Btn.Streak2) ||
             justPressed(cmd.buttons, this.prevButtons, Btn.Streak3)) {
      this.mortarOverlay.cancel();
    }
    return true;
  }

  /**
   * Keys 3, 4 and 5 spend **the class's** first, second and third streak (M11 Gate B playtest).
   *
   * They used to index the *earned* list, packed from zero, so which key fired a given streak
   * depended on how many others happened to be in hand at that moment: a player who had earned
   * only their Chopper Gunner found it on key 3, and key 5 — the key the loadout editor labels
   * "Killstreak · key 5", the key it is bound to — did nothing at all. Reported as the chopper
   * not responding to 5, and it is really the mapping moving underneath the player.
   *
   * Position is now fixed by the class and the earned list only decides whether the press is
   * *honoured*, which is the same rule the HUD paints.
   */
  private stepStreakInput(cmd: InputCommand): void {
    const bits = [Btn.Streak1, Btn.Streak2, Btn.Streak3] as const;
    for (let i = 0; i < bits.length; i++) {
      const bit = bits[i];
      if (bit === undefined) continue;
      if (!justPressed(cmd.buttons, this.prevButtons, bit)) continue;
      const id = this.streakSlots[i];
      if (id === undefined || id === null) continue;
      // Affordable and not already bought this life, or the press is simply not honoured. The
      // slot has already said which of the two it is — the price, or USED — so a press that
      // does nothing is a press the player was told about before they made it.
      if (!this.canAffordStreak(id)) continue;

      const sim = this.deps.player.sim;
      // A mortar is *marked* before it is spent: the overlay opens, and the streak is only
      // consumed when the player confirms. Cancelling must not cost them the streak.
      if (id === 'mortar') {
        this.mortarOverlay.show(sim.x, sim.z);
        this.overlayYaw = cmd.yaw;
        this.overlayPitch = cmd.pitch;
        return;
      }
      this.spendStreak(id, sim.x, sim.z);
      return;
    }
  }

  /**
   * Spend a streak — locally, or by asking the server (M11 Gate B, §8.22).
   *
   * The networked path sends a **request** and changes nothing locally. There is deliberately no
   * optimistic activation: §4.15 puts killstreak activation on the replicated side, and a client
   * that put a sentry down and then had it taken away by the next frame would be showing a
   * correction for a thing that was never true. The round trip is one frame at any playable
   * ping, and a sentry that appears a frame late is not something a player can perceive — a
   * sentry that appears and vanishes is.
   *
   * The coordinates sent are the mortar's mark and nothing else; the server places every other
   * streak from its own copy of where the player is standing.
   */
  private spendStreak(id: StreakId, markX: number, markZ: number): void {
    if (this.isNetworked) {
      this.deps.onStreakRequest?.(id, markX, markZ);
      return;
    }
    const sim = this.deps.player.sim;
    // Two metres along the facing, so a sentry is placed rather than worn.
    const ahead = 2;
    const px = sim.x - Math.sin(sim.yaw) * ahead;
    const pz = sim.z - Math.cos(sim.yaw) * ahead;
    const useAhead = id === 'sentry';
    this.streaks.activate(
      this.localId,
      id,
      id === 'mortar' ? markX : useAhead ? px : sim.x,
      sim.y,
      id === 'mortar' ? markZ : useAhead ? pz : sim.z,
      sim.yaw,
    );
  }

  /** Record the class's streaks, in both the shapes the rest of the match asks for. */
  private setStreakLoadout(streaks: ReadonlyArray<StreakId | null>): void {
    this.streakSlots = [streaks[0] ?? null, streaks[1] ?? null, streaks[2] ?? null];
    this.equippedStreakIds = this.streakSlots.filter((id): id is StreakId => id !== null);
  }

  /**
   * The three questions the streak strip and the keys ask, each behind one accessor.
   *
   * The server's answer in a networked match and the local system's otherwise. Routed through
   * these rather than branched at each call site, because the failure when one of them is
   * missed is a HUD that offers a streak the server will refuse, or a key that charges a price
   * the screen never showed. There were two of these before round 4; the balance model adds
   * price and availability, which is what a currency needs on screen to be playable at all.
   */
  private streakBalance(): number {
    return this.isNetworked ? this.replicatedStreaks.balance : this.streaks.balanceOf(this.localId);
  }

  private streakPrice(id: StreakId): number {
    return this.isNetworked ? this.replicatedStreaks.priceOf(id) : this.streaks.priceOf(id, this.localId);
  }

  private streakUsed(id: StreakId): boolean {
    return this.isNetworked ? this.replicatedStreaks.hasUsed(id) : this.streaks.usedBy(this.localId).includes(id);
  }

  private canAffordStreak(id: StreakId): boolean {
    return this.isNetworked ? this.replicatedStreaks.canAfford(id) : this.streaks.canAfford(this.localId, id);
  }

  private nextStreak(): { def: StreakDef; price: number } | null {
    return this.isNetworked ? this.replicatedStreaks.next : this.streaks.nextFor(this.localId);
  }

  /**
   * The body this dead player is watching, or null (M11 Gate B, §6.8).
   *
   * Only in a **one-life** mode, which is what makes this a spectator rather than a death cam:
   * in Team Deathmatch a corpse is looking at the floor for four seconds and then playing again,
   * and taking the camera somewhere else would be a worse experience than the wait. In Search &
   * Destroy the wait is the rest of the round.
   *
   * Recomputed every frame rather than latched on death. A target can die, disconnect or be
   * replaced by a bot at any moment, and a latch would have to be invalidated correctly on all
   * three — asked every frame, there is nothing to get stuck.
   */
  get spectatorTargetId(): number {
    if (!this.playerDead) return NO_SPECTATOR_TARGET;
    if (this.deps.mode.usesRoundReset !== true) return NO_SPECTATOR_TARGET;
    const chosen = pickSpectatorTarget(
      this.localId,
      this.localTeam,
      this.spectatorCandidates(),
      this.spectatorTarget,
    );
    this.spectatorTarget = chosen;
    return chosen;
  }

  /**
   * Where the spectator camera should sit, or null to leave it on the local body.
   *
   * The followed body's **feet** and its facing — `PlayerSnapshot` carries an eye height of its
   * own, so adding one here would raise the camera twice. A first-person framing rather than a
   * chase camera, deliberately: a third-person spectator needs collision of its own, and one
   * that clips through a wall while the player is already waiting out a round is a worse answer
   * than looking through a teammate's eyes.
   */
  spectatorView(alpha: number): { x: number; y: number; z: number; yaw: number } | null {
    const id = this.spectatorTargetId;
    if (id === NO_SPECTATOR_TARGET) return null;
    for (const actor of this.deps.actors?.() ?? []) {
      const a = actor as {
        entityId?: number;
        renderX?: (t: number) => number;
        renderY?: (t: number) => number;
        renderZ?: (t: number) => number;
        renderYaw?: (t: number) => number;
      };
      if (a.entityId !== id) continue;
      if (a.renderX === undefined || a.renderY === undefined || a.renderZ === undefined) return null;
      return {
        x: a.renderX(alpha),
        y: a.renderY(alpha),
        z: a.renderZ(alpha),
        yaw: a.renderYaw?.(alpha) ?? 0,
      };
    }
    return null;
  }

  /** Cycle to the next living teammate. Bound to the fire key while dead (M7's verb). */
  cycleSpectatorTarget(): void {
    if (!this.playerDead) return;
    this.spectatorTarget = nextSpectatorTarget(
      this.localId,
      this.localTeam,
      this.spectatorCandidates(),
      this.spectatorTarget,
    );
  }

  /**
   * Everything this client could watch.
   *
   * The **remote actors** in a networked match and the bot roster in single-player — the same
   * split `actors` makes for rendering, and for the same reason: a networked client has no
   * roster, only bodies rebuilt from snapshots.
   */
  private *spectatorCandidates(): Generator<SpectatorCandidate> {
    if (this.isNetworked) {
      for (const actor of this.deps.actors?.() ?? []) {
        const remote = actor as { entityId?: number; team?: BotTeam; participating?: boolean };
        if (typeof remote.entityId !== 'number' || remote.team === undefined) continue;
        yield { entityId: remote.entityId, team: remote.team, alive: remote.participating === true };
      }
      return;
    }
    for (const bot of this.bots.bots) {
      yield { entityId: bot.entityId, team: bot.team, alive: bot.participating };
    }
  }

  /** Adopt one `Projectiles` frame (§8.24). Own grenades are skipped — they are predicted. */
  applyReplicatedProjectiles(
    projectiles: readonly ProjectileState[],
    smoke: readonly SmokeState[],
  ): void {
    this.equipment.applyReplicated(projectiles, smoke, this.localId);
  }

  /** Drop every replicated grenade. Called on migration, per §4.18's obligation list. */
  clearReplicatedProjectiles(): void {
    this.equipment.applyReplicated(EMPTY_PROJECTILES, EMPTY_SMOKE, this.localId);
  }

  /** Adopt one `Streaks` frame (§8.22). Called by `MatchWorld` from the net session. */
  applyReplicatedStreaks(view: StreakView): void {
    this.replicatedStreaks.apply(view);
  }

  /** Drop every replicated streak. Called on migration, per §4.18's obligation list. */
  clearReplicatedStreaks(): void {
    this.replicatedStreaks.clear();
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
    if (!this.flow.respawnAllowed(this.localId)) return;
    this.respawnPlayer();
  }

  /**
   * Count the death-screen timer down, and **only** that.
   *
   * `stepPlayerRespawn` does two things — it decrements the timer *and* it brings the body back
   * — and over the network the second belongs to the server, so the whole method was skipped.
   * The timer was therefore set once by `onPlayerKilled` and never moved: the death screen
   * showed a frozen 4.5 for the entire wait and then the player simply reappeared. The wait was
   * always correct; the only thing broken was the number describing it.
   *
   * Purely presentational, and clamped at zero rather than allowed to run negative: the
   * authoritative "you are alive again" is the replicated `EFlag.Alive` arriving through
   * `applyReplicatedSelf`, and this must never be mistaken for a second opinion about it. If the
   * server is slower than the local estimate the display sits at zero and waits, which reads as
   * "any moment now" — the honest thing for a client that does not decide.
   */
  private stepRespawnDisplay(): void {
    if (!this.playerDead || this.playerRespawnTimer <= 0) return;
    this.playerRespawnTimer = Math.max(0, this.playerRespawnTimer - DT);
  }

  /**
   * Everybody back to a spawn, the bomb back at the attackers' base (post-M8 playtest).
   *
   * The bomb half is already done by the time this runs — `SearchAndDestroy.onRoundStart`
   * calls `resetBomb`, and the flow emits `round.started` after it — so this is the *people*
   * half, which nothing owned. Rounds two and three previously began with whoever survived
   * round one standing wherever they had finished it, which on a bomb site is a free plant.
   *
   * The player is reset through the same `respawnPlayer` a death uses, so a round start and a
   * respawn cannot disagree about what a fresh life is: full health, full magazines, primary
   * in hand, sights down, equipment refilled.
   *
   * **Single-player only** since round 4. Over the network the server owns the round reset and
   * announces it by bumping the spawn serial; see the subscription that calls this.
   */
  private hardResetRound(): void {
    this.bots.respawnAll();
    this.playerDead = false;
    this.playerRespawnTimer = 0;
    this.respawnPlayer();
  }

  private respawnPlayer(): void {
    const choice = this.spawnChoice;
    // This path is single-player only — a networked respawn is `respawnNetworked`, where the
    // server chose the point — but the side and the id are read from the match rather than
    // from the two constants, so the local-only claim is not also a hidden assumption.
    if (this.bots.selectSpawn(this.localTeam, this.localId, choice)) {
      this.deps.player.spawn(choice.x, choice.y + 0.05, choice.z, choice.yaw);
      this.deps.input.setView(choice.yaw, 0);
    }
    this.applyPendingLoadout();
    this.playerHealth.reset();
    this.weapons.reset();
    /**
     * The mesh follows the reset, explicitly (post-M8 playtest).
     *
     * `weapons.reset()` puts the *logic* back on slot 0, and the visible model normally
     * follows the inventory through the `weapon.swapped` subscription in the constructor —
     * but a reset is not a swap and emits no such event. So a player who died holding the
     * pistol came back holding a pistol that fired the rifle's ballistics and reported the
     * rifle's ammo: the two halves of "which weapon am I holding" had drifted apart.
     *
     * Asking the inventory which slot is live rather than hard-coding 0 keeps the two facts
     * in the same place — if `Inventory.reset` ever comes back on a different slot, the
     * viewmodel comes back with it.
     */
    this.showSlot(this.weapons.inventory.activeSlotIndex);
    this.melee.reset();
    // Equipment is per life (S6.3). `MatchEquipment` refills on `player.spawned`, which
    // `PlayerController.spawn` above has already emitted.
    this.playerCombatant.syncRig();
    this.playerDead = false;
    this.playerRespawnTimer = 0;
    this.flow.noteRespawn(this.localId);
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
    drive.throwing = this.equipment.thrower.busy;
    drive.swapping = this.weapons.inventory.swapping;
    drive.melee = this.melee.fraction;
    drive.bobPhase = sim.bobPhase;
    drive.speed = sim.speed;
    drive.speedRef = this.deps.movementConfig.sprintSpeed;
    drive.grounded = sim.grounded;
    drive.yaw = yaw;
    drive.pitch = pitch;
    this.anim.update(drive, this.deps.viewmodelConfig, dt);

    this.range?.updateVisuals(alpha, camera);
    this.botRenderer.update(alpha, dt);
    this.fx.update(dt);
    this.equipment.render(alpha, dt, camera);
    this.meta.render(dt);
    /**
     * One source of streaks, chosen once (M11 Gate B).
     *
     * `streaks.render` advances presentation state on locally-owned streak objects, of which a
     * networked client has none — and `streakRenderer.update()` reconciles against that same
     * empty local list, so calling it here as well would delete every replicated mesh the line
     * above just built.
     */
    if (this.isNetworked) {
      this.streakRenderer.updateReplicated(this.replicatedStreaks.entities);
    } else {
      this.streaks.render(dt, alpha);
      this.streakRenderer.update();
    }

    // A dead player is not holding a rifle — and a scoped one is looking through an optic
    // rather than at a weapon, so the viewmodel hands off to the scope overlay (M7). See
    // `SCOPE_VIEWMODEL_HIDDEN`: the tube is a solid cylinder on the sight line and would
    // otherwise fill the middle of the scope picture.
    const scoped = def.scope !== undefined && this.visual.adsFraction >= SCOPE_VIEWMODEL_HIDDEN;
    /**
     * A knife swing takes the rifle off screen entirely (round 2).
     *
     * `melee.busy` is the same flag that sets `weapons.fireBlocked` in `simulate`, so what is
     * in frame and what the player can do are one fact read twice — the contract the throw
     * animation already follows. It is deliberately `busy` and not `fraction > 0`: the
     * fraction is zero on the first tick of a wind-up, and swapping the meshes a tick late
     * would show the rifle for one frame after the blade should have replaced it.
     */
    const knifing = !this.playerDead && this.melee.busy;
    this.model.root.visible = !this.playerDead && !scoped && !knifing;
    this.knifeModel.root.visible = knifing;
    this.knifeModel.arm.visible = knifing;

    const state = this.ui.state;
    /**
     * The ammunition readout follows whichever gun the player is actually holding (round 2).
     *
     * A gunship belt is the same four facts a rifle magazine is — how many, out of how many,
     * is it being fed, and how far through — so it goes through the same four fields rather
     * than growing a second ammo widget that would have to be positioned, styled and hidden.
     * The grounded rifle's numbers are *wrong* to show during a takeover for the same reason
     * `weapons.suspended` exists: the player is not holding it, and the last thing they need
     * while flying is a magazine count that never moves.
     */
    const chopper = this.streaks.activeChopperFor(this.localId);
    if (chopper !== null) {
      state.mag = chopper.mag;
      state.magSize = chopper.magSize;
      state.reserve = 0;
      state.reserveInfinite = true;
      state.reloading = chopper.reloading;
      state.reloadFraction = chopper.reloadFraction;
    } else {
      state.mag = weapon.mag;
      state.magSize = def.magSize;
      state.reserve = weapon.reserve;
      state.reserveInfinite = false;
      state.reloading = weapon.reloading;
      state.reloadFraction = this.visual.reloadFraction;
    }
    state.spreadDeg = this.weapons.spreadDeg;
    state.adsFraction = this.visual.adsFraction;
    state.fovDeg = this.deps.cameraRig.fov;
    state.viewportHeight = window.innerHeight;
    state.health = this.playerHealth.current;
    state.healthMax = this.playerHealth.max;
    state.dead = this.playerDead;
    state.respawnSeconds = this.playerRespawnTimer;
    // One life: there is no timer to show, because nobody is coming back until the round does.
    state.awaitingRound = this.playerDead && !this.flow.respawnAllowed(this.localId);
    this.fillTacticalState();
    this.fillStreakHud();
    this.fillMinimapStreaks();
    this.objectives.update(dt);
    // Straight from the pass that just decided where the bomb mesh goes, so the arrow and
    // the object it points at are the same frame's answer (round 4, F2).
    this.objectives.readBombBearing(bombBearingScratch);
    this.ui.hud.setObjectiveBearing(bombBearingScratch.active, bombBearingScratch.x, bombBearingScratch.z);
    this.mortarOverlay.update(dt, MORTAR_MARK_RADIUS);
    this.ui.update(this.flow, sim.x, sim.z, sim.yaw, dt);
    this.feedback.render(camera);
  }

  /**
   * The streak strip and the objective banner (M7).
   *
   * Everything here is read straight off `StreakSystem` and the mode. The requirement shown is
   * already Hardline-discounted, so the HUD never learns that a perk exists.
   */
  private fillStreakHud(): void {
    const hud = this.ui.streakState;
    for (let i = 0; i < hud.slots.length; i++) {
      const slot = hud.slots[i];
      if (slot === undefined) continue;
      const id = this.streakSlots[i] ?? null;
      slot.name = id === null ? '' : streakDef(id).name;
      // Four states now, not three (round 4, B9 + B10). A slot that is dark because the
      // player cannot afford it and a slot that is dark because they already spent it are
      // different sentences, and the key does nothing in both — so the strip has to say which.
      slot.price = id === null ? 0 : this.streakPrice(id);
      slot.used = id !== null && this.streakUsed(id);
      slot.ready = id !== null && this.canAffordStreak(id);
    }
    // The **balance**, and the server's when there is one: it is the number a purchase is
    // charged against, and two opinions about it is two opinions about whether a key works.
    hud.balance = this.streakBalance();
    const next = this.nextStreak();
    hud.nextName = next?.def.name ?? '';
    hud.nextPrice = next?.price ?? 0;

    this.fillObjectiveBanner(hud);
    this.fillFreeForAllBanner();
  }

  /**
   * Free-for-All shows the leader and you, not team A and team B.
   *
   * Driven from `ScoreSystem.rows`, which is populated on a networked client the same way the
   * scoreboard is. Recomputed per frame rather than cached on a score event — it is a scan of
   * ten rows on a screen that is already walking them for the scoreboard.
   */
  private fillFreeForAllBanner(): void {
    const banner = this.ui.state.banner;
    banner.ffa = this.deps.mode.freeForAll === true;
    if (!banner.ffa) return;

    /**
     * **Kills, not points** (M11 Gate B playtest).
     *
     * This read `row.score`, and over the network that column is zero for everybody, for ever:
     * `MatchFlow`'s replicated branch records kills with **zero points** on purpose — what a
     * kill is worth is a mode decision and the mode is not running on a client. So the banner
     * showed `0` against a leader of `0` for the whole match, which is the reported "the kill
     * counter isn't working in FFA over the network".
     *
     * Kills are the right number anyway, and not merely the available one: `checkWinCondition`
     * decides Free-for-All on `row.kills` and the bar counts toward `scoreLimit`, which is a
     * kill count. Showing points beside a limit measured in kills was a bar that could not
     * reach its own end.
     */
    let leader: { name: string; score: number } | null = null;
    let self = 0;
    for (const row of this.score.rows) {
      if (row.entityId === this.localId) self = row.kills;
      if (leader === null || row.kills > leader.score) {
        leader = { name: row.displayName, score: row.kills };
      }
    }
    banner.leaderName = leader?.name ?? '';
    banner.leaderScore = leader?.score ?? 0;
    banner.selfScore = self;
  }

  /**
   * The bomb timer, the plant/defuse ring and the capture prompt.
   *
   * Only one thing is ever shown, and the order is by urgency: a ticking bomb outranks an
   * interaction, which outranks standing on a flag. A banner that tried to show all three
   * would show none of them.
   */
  private fillObjectiveBanner(hud: import('./ui/HudStreaks').StreakHudState): void {
    hud.showAlive = false;
    hud.objectiveLabel = '';
    hud.objectiveSeconds = -1;
    hud.interactFraction = -1;
    hud.interactLabel = '';
    hud.urgent = false;

    const mode = this.mode;
    if (mode instanceof SearchAndDestroy) {
      // Alive counts, top of screen, every round (M7 playtest). Counted here rather than by
      // the mode, and against the side the server actually assigned rather than the constant.
      const friendly = this.localTeam;
      hud.aliveFriendly = this.countAlive(friendly);
      hud.aliveEnemy = this.countAlive(friendly === 'A' ? 'B' : 'A');
      hud.showAlive = true;

      if (mode.bomb === 'PLANTED') {
        hud.objectiveLabel = `BOMB · SITE ${mode.plantedSite?.label ?? ''}`;
        hud.objectiveSeconds = mode.bombSecondsLeft;
        hud.urgent = true;
      }
      if (mode.interactEntity === this.localId && mode.interactFraction > 0) {
        hud.interactFraction = mode.interactFraction;
        hud.interactLabel = mode.bomb === 'PLANTED' ? 'DEFUSING' : 'PLANTING';
        if (hud.objectiveLabel.length === 0) hud.objectiveLabel = 'OBJECTIVE';
        return;
      }
      /**
       * Somebody else already has it (post-M8 playtest).
       *
       * Telling a second defender to "hold T to defuse" while a team-mate is three seconds
       * into the defuse is telling them to do something the mode will refuse —
       * `beginInteract` ignores a newcomer while a live actor owns the interaction. The
       * prompt is replaced by what is actually happening, which is the thing worth knowing:
       * somebody is on it, so go and cover them.
       */
      const busyWith = mode.interactingEntity;
      if (busyWith >= 0 && busyWith !== this.localId) {
        hud.interactFraction = mode.interactFraction;
        hud.interactLabel = mode.interactIsDefusing ? 'TEAMMATE DEFUSING' : 'PLANT IN PROGRESS';
        if (hud.objectiveLabel.length === 0) hud.objectiveLabel = 'OBJECTIVE';
        return;
      }
      if (mode.bomb === 'PLANTED' && this.playerCombatant.team === mode.defenders) {
        const site = mode.plantedSite;
        if (site !== null && site.contains(this.playerCombatant)) {
          hud.interactFraction = 0;
          hud.interactLabel = `HOLD ${this.useKeyLabel()} TO DEFUSE`;
        }
        return;
      }
      if (mode.bomb !== 'CARRIED') return;
      if (this.playerCombatant.team !== mode.attackers) return;
      if (!mode.isCarrier(this.localId)) {
        // Tell them where the bomb is, because without it the round cannot be won.
        if (mode.carrierId < 0) {
          hud.objectiveLabel = 'RECOVER THE BOMB';
          // Standing on it: the pick-up is a key press now, so it needs a prompt like any
          // other interaction. Without one, "auto-pickup is off" reads as "the bomb is broken".
          if (mode.tryPickupPrompt(this.playerCombatant)) {
            hud.interactFraction = 0;
            hud.interactLabel = `HOLD ${this.useKeyLabel()} TO TAKE THE BOMB`;
          }
        } else {
          hud.objectiveLabel = 'BOMB CARRIER OUT';
        }
        return;
      }
      const site = mode.siteContaining(this.playerCombatant);
      hud.objectiveLabel = site === null ? 'CARRYING THE BOMB' : `SITE ${site.label}`;
      if (site !== null) {
        hud.interactFraction = 0;
        hud.interactLabel = `HOLD ${this.useKeyLabel()} TO PLANT`;
      }
      return;
    }

    if (mode instanceof Domination) {
      for (const zone of mode.zones) {
        if (!zone.contains(this.playerCombatant)) continue;
        hud.objectiveLabel = `FLAG ${zone.label}`;
        hud.interactFraction = zone.progress;
        hud.interactLabel = zone.contested
          ? 'CONTESTED'
          : zone.owner === this.localTeam
            ? 'HELD'
            : 'CAPTURING';
        return;
      }
    }
  }

  /**
   * What the Use key is actually bound to, for the objective prompts (post-M8).
   *
   * The prompts used to read "HOLD P", hard-coded, which was wrong the moment M8 shipped
   * rebinding and wrong again when the default moved to T. Asked of the live binding table
   * so the HUD says the key the player will actually press, whatever they set it to.
   */
  private useKeyLabel(): string {
    const bound = this.deps.input.keybinds.inputsFor('use')[0];
    return bound === undefined ? 'USE' : inputLabel(bound).toUpperCase();
  }

  /**
   * Push UAV contacts, the sweep bearing, the scramble flag and flag ownership at the minimap.
   *
   * Written into preallocated records rather than rebuilt, so a UAV costs no allocation per
   * frame — the minimap sizes both arrays at construction for exactly this.
   */
  private fillMinimapStreaks(): void {
    const map = this.ui.hud.minimap;
    // Whose UAV this is, and whose minimap is being scrambled, is "which side am I on".
    const friendly = this.localTeam;
    for (const slot of map.contacts) slot.active = false;
    map.contactFadeSeconds = this.streaks.contactFadeSeconds;

    if (this.isNetworked) {
      /**
       * The server's intel, and only ever this team's (M11 Gate B, §8.22).
       *
       * The client is not filtering here — there is nothing to filter. `MatchInstance` sends
       * each seat only the contacts its own team's UAV recorded, and a Ghost player was never
       * recorded in the first place. What arrives is already the whole truth this player is
       * entitled to, which is the point: a client that received both teams' contacts and chose
       * to draw one would be one edited line away from a wallhack.
       */
      const rep = this.replicatedStreaks;
      map.sweepAngle = rep.sweepAngle < 0 ? null : rep.sweepAngle;
      map.scrambled = rep.scrambled;
      let n = 0;
      for (const contact of rep.contacts) {
        if (n >= map.contacts.length) break;
        const slot = map.contacts[n];
        if (slot === undefined) continue;
        slot.x = contact.x;
        slot.z = contact.z;
        slot.age = contact.ageCs / 100;
        slot.active = true;
        n++;
      }
    } else {
      const uav = this.streaks.uavFor(friendly);
      map.sweepAngle = uav === null ? null : uav.sweepAngle;
      map.scrambled = this.streaks.minimapScrambledFor(friendly);
      if (uav !== null) {
        let i = 0;
        for (const contact of uav.contacts) {
          if (!contact.active || i >= map.contacts.length) continue;
          const slot = map.contacts[i];
          if (slot === undefined) continue;
          slot.x = contact.x;
          slot.z = contact.z;
          slot.age = contact.age;
          slot.active = true;
          i++;
        }
      }
    }

    if (!(this.mode instanceof Domination)) return;
    const states = map.objectiveStates;
    if (states.length !== this.mode.zones.length) {
      states.length = 0;
      for (const zone of this.mode.zones) {
        states.push({ id: zone.id, owner: 'NONE', progress: 0, contested: false });
      }
    }
    for (let i = 0; i < this.mode.zones.length; i++) {
      const zone = this.mode.zones[i];
      const state = states[i];
      if (zone === undefined || state === undefined) continue;
      // The constant is team A, so a networked player the server put on team B had every flag
      // on their minimap coloured backwards: their own held zones read as enemy and the
      // enemy's as theirs.
      const friendly = this.localTeam;
      state.owner = zone.owner === 'NONE' ? 'NONE' : zone.owner === friendly ? 'FRIENDLY' : 'ENEMY';
      state.progress = zone.progress;
      state.contested = zone.contested;
    }
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
    // The streaks are gone, so the body is unconditionally back in play.
    this.playerCombatant.active = true;
    this.playerCombatant.invulnerable = false;
    this.objectives.dispose();
    this.mortarOverlay.dispose();
    this.meta.dispose();
    this.equipment.dispose();
    this.feedback.dispose();
    this.flow.dispose();
    this.score.dispose();
    this.ui.dispose();
    this.bots.dispose();
    this.botRenderer.dispose();
    this.streakRenderer.dispose();
    if (this.range !== null) {
      this.range.dispose();
      this.deps.scene.remove(this.range.group);
    }
    this.fx.dispose();
    this.deps.scene.remove(this.fx.group);
    this.swapSubscription?.();
    this.swapSubscription = null;
    this.roundResetSubscription?.();
    this.roundResetSubscription = null;
    for (const model of this.models) {
      this.deps.viewmodel.remove(model.root);
      model.dispose();
    }
    this.models.length = 0;
    this.anim.setKnife(null, null);
    this.deps.viewmodel.remove(this.knifeModel.root);
    this.deps.viewmodel.remove(this.knifeModel.arm);
    this.knifeModel.dispose();
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
    /**
     * Out of the sights, on the tick of death (post-M8 playtest).
     *
     * A dead player's weapon is not stepped — `simulate` skips it — so `adsFraction` freezes
     * at whatever it held when the round landed, and `Game` keeps feeding that to the camera
     * as an FOV scale. With a sniper that is a scoped picture the player is stuck inside for
     * the whole death screen. Forcing it down here is the only place that works, because
     * every other candidate is code that has just stopped running.
     */
    this.weapons.clearAim();
    this.melee.reset();
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
 * Which objective kinds the minimap should draw for this mode (M7).
 *
 * Empty for a mode with none, which also switches the objective layer off entirely — a
 * Domination flag on a Team Deathmatch minimap is noise, and an S&D bomb site on a Domination
 * one is worse than noise because it looks like something you can capture.
 */
function objectiveKindsFor(mode: GameMode): readonly ObjectiveKind[] {
  if (mode instanceof Domination) return ['flag'];
  if (mode instanceof SearchAndDestroy) return ['bombsite'];
  return [];
}

/** Shortest signed angle from `a` to `b`, radians. */
function angleDeltaRad(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
