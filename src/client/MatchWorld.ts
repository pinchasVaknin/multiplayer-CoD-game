import * as THREE from 'three';
import type { SchedulerConfig } from '../shared/ai/AiScheduler';
import type { PerceptionConfig, TierTable } from '../shared/ai/DifficultyTiers';
import { EV, type GameBus } from '../shared/core/Events';
import type { Input } from './input/Input';
import type { Loop } from './engine/FrameLoop';
import type { CameraRig } from './engine/CameraRig';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import type { ProceduralTextures } from './engine/ProceduralTextures';
import type { Renderer } from './engine/Renderer';
import { BotHarness, type BotHarnessOptions } from './debug/BotHarness';
import { DebugSuite } from './debug/DebugSuite';
import type { FrameStats } from './debug/FrameStats';
import type { MatchHarness } from './debug/MatchHarness';
import type { Speedometer } from './debug/Speedometer';
import { Match } from './ClientMatch';
import type { EquipmentConfig } from '../shared/equipment/EquipmentConfig';
import type { ResolvedLoadout } from '../shared/meta/Loadouts';
import type { Profile } from './meta/Profile';
import type { MapEntry, ModeEntry } from '../shared/modes/ModeRegistry';
import type { CameraConfig } from './player/CameraConfig';
import type { HealthConfig } from '../shared/player/Health';
import type { MovementConfig } from '../shared/player/MovementConfig';
import { PlayerController } from '../shared/player/PlayerController';
import type { ViewmodelLayer } from './player/Viewmodel';
import type { ViewmodelConfig } from '../shared/weapons/ViewmodelConfig';
import type { WeaponDef } from '../shared/weapons/WeaponDefs';
import { applyAmbient, loadMap, type LoadedMap } from './world/MapRender';
import { Particulate } from './world/Particulate';

/**
 * The world a match is played in, as one object with one lifetime (M7).
 *
 * ## Why this file exists
 *
 * M4 made the world per-match: the map, the player, the match and all of its debug tooling
 * are built on entering MATCH and **fully disposed on leaving SUMMARY**, because S6.3 says
 * loading a map twice must not double anything. That was implemented as `buildWorld` and
 * `teardownWorld` inside `Game.ts` plus six nullable fields, and by M6 those six fields were
 * woven through `simulate`, `draw`, five state handlers and eight getters — around thirty
 * call sites, every one of them an optional chain on a field that is either all present or
 * all absent. `Game.ts` reached 905 lines and PLAN.md named the split as the first M7 job.
 *
 * The fix is not to move code, it is to move the *nullability*. Six fields that are always
 * null together are one field that is sometimes null, so `Game` now holds a single
 * `MatchWorld | null` and asks once. Inside here nothing is optional: a `MatchWorld` that
 * exists has a map, a player, a match and a debug suite, which is why this file has no `?.`
 * in it and why `Game.simulate` no longer has four.
 *
 * ## The mirror rule still holds
 *
 * The constructor and `dispose` are exact mirrors — every field the one sets, the other
 * clears; every group the one adds to the scene, the other removes. That is the property
 * `MatchHarness` is really testing when it runs three matches and logs the heap at each
 * boundary, and it is easier to check now that both halves are adjacent in one file instead
 * of ninety lines apart in the state machine.
 *
 * What deliberately does **not** live here is anything genuinely process-wide: the renderer,
 * the textures, the audio graph, the input listener, the frame-stats buffer, the profile and
 * the config objects the tuning panel holds references to. Those are handed in.
 */

/**
 * Seed for everything in `ai/`. Fixed, so two runs of the harness with the same roster
 * produce the same firefight and a regression in bot behaviour is reproducible.
 */
export const AI_SEED = 0x0fe7_a105;

export interface MatchWorldDeps {
  // ---- process-wide handles ------------------------------------------------
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly renderer: Renderer;
  readonly textures: ProceduralTextures;
  readonly viewmodel: ViewmodelLayer;
  readonly cameraRig: CameraRig;
  readonly audio: ProceduralAudio;
  readonly input: Input;
  readonly loop: Loop;
  readonly uiHost: HTMLElement;
  readonly debugHost: HTMLElement;
  readonly stats: FrameStats;
  readonly speedo: Speedometer;
  readonly matchHarness: MatchHarness;
  readonly profile: Profile;

  // ---- the long-lived config objects the tuning panel writes into ----------
  readonly movementConfig: MovementConfig;
  readonly cameraConfig: CameraConfig;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly healthConfig: HealthConfig;
  readonly equipmentConfig: EquipmentConfig;
  readonly weaponDef: WeaponDef;
  readonly secondaryDef: WeaponDef;
  readonly playerBaseDef: WeaponDef;
  readonly tiers: TierTable;
  readonly perceptionConfig: PerceptionConfig;
  readonly schedulerConfig: SchedulerConfig;

  // ---- what this particular match is --------------------------------------
  readonly mapEntry: MapEntry;
  readonly modeEntry: ModeEntry;
  readonly loadout: ResolvedLoadout;

  /**
   * The match declared itself over. `Game` defers the SUMMARY transition to the render pass
   * rather than transitioning from inside a sim tick: tearing the HUD down half-way through
   * the tick that produced the winning kill is how you get a null dereference in the middle
   * of an event dispatch.
   */
  readonly onMatchEnded: () => void;
  readonly onConfigChanged: () => void;
  readonly onWeaponConfigChanged: () => void;
}

export class MatchWorld {
  readonly map: LoadedMap;
  readonly player: PlayerController;
  readonly match: Match;
  /** The F1 overlay and every visualiser and panel that hangs off it. */
  readonly debug: DebugSuite;
  /** M8. Airborne dust or haze, or null on a map that authors none. */
  readonly particulate: Particulate | null;

  /** The AFK bot-match driver, when `?harness=botmatch` asked for one. */
  private harness: BotHarness | null = null;

  private readonly deps: MatchWorldDeps;
  private readonly matchEndedSubscription: () => void;

  constructor(deps: MatchWorldDeps) {
    this.deps = deps;

    const map = loadMap(deps.mapEntry.def, deps.textures, deps.profile.settings.shadowQuality);
    this.map = map;
    deps.scene.add(map.root);
    applyAmbient(deps.scene, map.def);

    // Added to the map's own root rather than to the scene, so the one `scene.remove` in
    // `dispose` takes it with everything else and there is no second thing to forget.
    const particulateDef = map.def.particulate;
    this.particulate = particulateDef === undefined ? null : new Particulate(particulateDef);
    if (this.particulate !== null) map.root.add(this.particulate.points);
    map.collision.configure(deps.movementConfig.maxSlopeDeg, deps.movementConfig.collisionSkin);

    const player = new PlayerController(deps.movementConfig, map.collision, deps.bus);
    this.player = player;

    const spawn = map.spawns[0];
    if (spawn === undefined) throw new Error('Map has no spawn zones');
    player.spawn(spawn.position.x, spawn.position.y, spawn.position.z, spawn.facingYaw);
    deps.input.setView(spawn.facingYaw, 0);

    this.match = new Match({
      bus: deps.bus,
      scene: deps.scene,
      viewmodel: deps.viewmodel,
      cameraRig: deps.cameraRig,
      cameraConfig: deps.cameraConfig,
      audio: deps.audio,
      input: deps.input,
      world: map.collision,
      player,
      movementConfig: deps.movementConfig,
      weaponDef: deps.weaponDef,
      secondaryDef: deps.secondaryDef,
      playerBaseDef: deps.playerBaseDef,
      viewmodelConfig: deps.viewmodelConfig,
      healthConfig: deps.healthConfig,
      equipmentConfig: deps.equipmentConfig,
      uiHost: deps.uiHost,
      anisotropy: deps.textures.anisotropy,
      map: deps.mapEntry,
      mode: deps.modeEntry,
      tiers: deps.tiers,
      perceptionConfig: deps.perceptionConfig,
      schedulerConfig: deps.schedulerConfig,
      seed: AI_SEED,
      loadout: deps.loadout,
      profile: deps.profile,
      banksProgress: deps.modeEntry.banksProgress,
    });

    this.matchEndedSubscription = deps.bus.on(EV.MatchEnded, () => deps.onMatchEnded());

    this.debug = new DebugSuite({
      host: deps.debugHost,
      bus: deps.bus,
      loop: deps.loop,
      renderer: deps.renderer,
      scene: deps.scene,
      audio: deps.audio,
      player,
      cameraRig: deps.cameraRig,
      map,
      mapEntry: deps.mapEntry,
      match: this.match,
      movementConfig: deps.movementConfig,
      cameraConfig: deps.cameraConfig,
      weaponDef: deps.weaponDef,
      viewmodelConfig: deps.viewmodelConfig,
      healthConfig: deps.healthConfig,
      equipmentConfig: deps.equipmentConfig,
      tiers: deps.tiers,
      perceptionConfig: deps.perceptionConfig,
      schedulerConfig: deps.schedulerConfig,
      stats: deps.stats,
      speedo: deps.speedo,
      matchHarness: deps.matchHarness,
      profile: deps.profile,
      onConfigChanged: deps.onConfigChanged,
      onWeaponConfigChanged: deps.onWeaponConfigChanged,
    });
  }

  get botHarness(): BotHarness | null {
    return this.harness;
  }

  /**
   * Attach the AFK bot-match driver (`?harness=botmatch`).
   *
   * Built here rather than in `Game` so the harness has the same lifetime as the world it is
   * driving — a harness that outlived a teardown would be holding a match that no longer
   * exists, which is the exact shape of leak the heap run is built to catch.
   */
  startBotHarness(options: BotHarnessOptions): BotHarness {
    const harness = new BotHarness(options, this.match, this.deps.loop, this.deps.stats);
    this.harness = harness;
    harness.start();
    return harness;
  }

  /**
   * Live retune from the tuning panel: push movement config into the two things that cached
   * it at construction. The FOV and the profile write are `Game`'s, because they outlive the
   * world.
   */
  applyMovementConfig(): void {
    const cfg = this.deps.movementConfig;
    this.player.setConfig(cfg);
    this.map.collision.configure(cfg.maxSlopeDeg, cfg.collisionSkin);
  }

  /**
   * Live retune of the weapon and health numbers.
   *
   * Health still reaches the bots, because both sides regenerating differently would break
   * the damage maths that makes TTK legible. The *weapon* deliberately does not: from M7 each
   * bot draws its own from `BotArsenal`, so pushing the player's def across the roster would
   * undo the variety the draw exists to create. `BotDirector.applyWeaponDef` is still there
   * for the controlled measurements that want a flat roster.
   */
  applyWeaponConfig(): void {
    const deps = this.deps;
    this.match.weapons.setDefinition(deps.weaponDef);
    this.match.playerHealth.setConfig(deps.healthConfig);
    for (const dummy of this.match.range?.dummies ?? []) {
      dummy.health.setConfig(deps.healthConfig);
      dummy.markLabelDirty();
    }
    this.match.bots.applyHealthConfig(deps.healthConfig);
  }

  /**
   * Take the world apart. The exact mirror of the constructor.
   *
   * Order matters only in that the debug tooling holds references to the match and the map,
   * so it goes first. Everything added to the scene is removed and everything with a
   * `dispose` gets it — including the map's geometries and materials, which are the largest
   * thing a match allocates.
   */
  dispose(): void {
    this.matchEndedSubscription();

    this.debug.dispose();
    this.harness?.stop();
    this.harness = null;

    this.match.dispose();

    this.deps.scene.remove(this.map.root);
    this.particulate?.dispose();
    this.map.dispose();

    this.deps.scene.fog = null;
    this.deps.scene.background = null;
  }
}
