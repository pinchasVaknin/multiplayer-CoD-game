import * as THREE from 'three';
import { DEFAULT_SCHEDULER, type SchedulerConfig } from './ai/AiScheduler';
import {
  cloneTierTable,
  DEFAULT_PERCEPTION,
  DEFAULT_TIERS,
  type PerceptionConfig,
  type TierTable,
} from './ai/DifficultyTiers';
import { EV, createGameBus, type GameBus } from './core/Events';
import { Input } from './core/Input';
import type { InputCommand } from './core/InputCommand';
import { Loop, MAX_STEPS_PER_FRAME, type FrameSample } from './core/Loop';
import { DEG2RAD } from './core/MathUtil';
import { LocalBotTransport, type INetworkTransport } from './core/Transport';
import { CameraRig, type CameraDrive } from './engine/CameraRig';
import { ProceduralAudio } from './engine/ProceduralAudio';
import { ProceduralTextures } from './engine/ProceduralTextures';
import { Renderer } from './engine/Renderer';
import { parseHarnessOptions } from './debug/BotHarness';
import type { BotHarness } from './debug/BotHarness';
import type { DebugSuite } from './debug/DebugSuite';
import { FrameStats } from './debug/FrameStats';
import { installConsoleApi } from './debug/ConsoleApi';
import { Harness } from './debug/Harness';
import { MatchHarness } from './debug/MatchHarness';
import { Speedometer } from './debug/Speedometer';
import { isLegalGameTransition, type GameStateId } from './GameStates';
import type { Match } from './Match';
import { PLAYER_TEAM } from './Match';
import { PLAYER_ENTITY_ID } from './combat/DamageSystem';
import { MatchWorld } from './MatchWorld';
import { GameScreens } from './GameScreens';
import { applyEquippedLoadout, asModeId } from './GameLoadout';
import type { ResolvedLoadout } from './meta/Loadouts';
import { Profile } from './meta/Profile';
import { defaultSettings } from './meta/SaveData';
import { DEFAULT_MAP_ID, DEFAULT_MODE_ID, findMap, findMode } from './modes/ModeRegistry';
import { DEFAULT_CAMERA_CONFIG, FOV_MAX, FOV_MIN, type CameraConfig } from './player/CameraConfig';
import { DEFAULT_HEALTH_CONFIG, type HealthConfig } from './player/Health';
import { DEFAULT_MOVEMENT_CONFIG, cloneMovementConfig, type MovementConfig } from './player/MovementConfig';
import type { PlayerController } from './player/PlayerController';
import { ViewmodelLayer } from './player/Viewmodel';
import type { MenuSelection } from './ui/Menus';
import {
  cloneEquipmentConfig,
  DEFAULT_EQUIPMENT_CONFIG,
  type EquipmentConfig,
} from './equipment/EquipmentConfig';
import { AR_DEFAULT, cloneWeaponDef, PISTOL_DEFAULT, type WeaponDef } from './weapons/WeaponDefs';
import { cloneViewmodelConfig, DEFAULT_VIEWMODEL_CONFIG, type ViewmodelConfig } from './weapons/ViewmodelConfig';
import type { LoadedMap } from './world/MapLoader';

/**
 * Application root and the top-level state machine (S6.3): BOOT -> MENU -> MATCH -> SUMMARY.
 *
 * ## The world is per-match, and it lives next door
 *
 * M1-M3 built the map, the player and the match once at boot and kept them for the life of
 * the page, because there was only ever one of each. M4 has a map *choice* and a summary
 * screen you come back from, so the world is built on entering MATCH and **fully disposed on
 * leaving SUMMARY** — S6.3's "loading a map twice must not double anything".
 *
 * M4 put that in this file as `buildWorld` / `teardownWorld` plus six nullable fields, and by
 * M6 those fields were threaded through `simulate`, `draw`, five state handlers and eight
 * getters. M7 moved the whole lifecycle to `MatchWorld`, so what is left here is the state
 * machine, the loop and the front end — and the six fields that were always null together
 * became one field that is sometimes null. Every method below asks once, at the top.
 *
 * What survives a match is what is genuinely process-wide: the renderer, the textures, the
 * audio graph, the input listener, the frame-stats buffer, the profile and the config objects
 * the tuning panel holds references to. All of them are fields here and are handed to
 * `MatchWorld` rather than owned by it. `MatchHarness` runs the build/teardown cycle
 * repeatedly and logs the heap at each boundary, which is the test that the split is honest.
 */

interface StateHandlers {
  enter?: (from: GameStateId) => void;
  exit?: (to: GameStateId) => void;
}

const stateChangePayload = { from: 'BOOT' as GameStateId, to: 'BOOT' as GameStateId };

export class Game {
  readonly bus: GameBus = createGameBus();
  readonly movementConfig: MovementConfig = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
  readonly cameraConfig: CameraConfig = { ...DEFAULT_CAMERA_CONFIG };
  /**
   * The live primary and secondary.
   *
   * These are *mutable clones* the tuning panel writes into, which is why they are fields
   * rather than the shipped defs. M5's weapon picker replaces their contents wholesale by
   * copying a different `WeaponDef` over them (`setPrimary`), so the tuning panel keeps
   * pointing at the same two objects across a weapon change and nothing has to resubscribe.
   */
  readonly weaponDef: WeaponDef = cloneWeaponDef(AR_DEFAULT);
  readonly secondaryDef: WeaponDef = cloneWeaponDef(PISTOL_DEFAULT);
  /**
   * The base of the player's primary: the resolved loadout with attachments and perks
   * stripped back off. Read by the M6 modifier panel; see `MatchDeps.playerBaseDef`.
   */
  readonly playerBaseDef: WeaponDef = cloneWeaponDef(AR_DEFAULT);
  readonly viewmodelConfig: ViewmodelConfig = cloneViewmodelConfig(DEFAULT_VIEWMODEL_CONFIG);
  readonly healthConfig: HealthConfig = { ...DEFAULT_HEALTH_CONFIG };
  readonly equipmentConfig: EquipmentConfig = cloneEquipmentConfig(DEFAULT_EQUIPMENT_CONFIG);
  readonly tiers: TierTable = cloneTierTable(DEFAULT_TIERS);
  readonly perceptionConfig: PerceptionConfig = { ...DEFAULT_PERCEPTION };
  readonly schedulerConfig: SchedulerConfig = { ...DEFAULT_SCHEDULER };

  /**
   * Frame statistics and the speedometer outlive a match deliberately: the three-match heap
   * run needs one continuous frame-time history across the boundaries it is measuring.
   */
  readonly stats = new FrameStats();
  readonly speedo = new Speedometer();

  private readonly scene = new THREE.Scene();
  private readonly renderer: Renderer;
  private readonly textures: ProceduralTextures;
  private readonly viewmodel: ViewmodelLayer;
  private readonly cameraRig: CameraRig;
  private readonly audio = new ProceduralAudio();
  private readonly screens: GameScreens;
  private readonly uiHost: HTMLElement;
  private readonly debugHost: HTMLElement;
  /** M6: the one save object. Owns settings, progression, loadouts and challenges. */
  readonly profile: Profile;
  private readonly transport: INetworkTransport = new LocalBotTransport(64);
  private readonly input: Input;
  private readonly loop: Loop;
  private readonly selection: MenuSelection;

  /**
   * The per-match world: the map, the player, the match and its debug tooling.
   *
   * One nullable field rather than six, because they were only ever all present or all
   * absent. Null outside a match; `MatchWorld` itself has no optional members.
   */
  private world: MatchWorld | null = null;

  // ---- process-wide -------------------------------------------------------
  private readonly harness: Harness;
  private readonly matchHarness: MatchHarness;

  private readonly states = new Map<GameStateId, StateHandlers>();
  private state: GameStateId = 'BOOT';

  private readonly drainBuffer: InputCommand[] = [];
  private readonly drive: CameraDrive = {
    sprint: false,
    tacSprint: false,
    slide: false,
    adsFraction: 0,
    adsFovScale: 1,
    adsViewmodelFovScale: 1,
  };
  private lastRenderMs = performance.now();
  /** Set when the mode declares the match over; SUMMARY is entered from the render pass. */
  private pendingSummary = false;
  /** Whether F1 was open when the match was paused, so resuming can put it back. */
  private overlayWasOpenBeforePause = false;

  constructor(canvas: HTMLCanvasElement, uiHost: HTMLElement, debugHost: HTMLElement) {
    // M6: one save object for everything (S6.6). Settings used to live in their own store;
    // `Profile` carries the old blob across on first load so nobody's FOV resets.
    this.profile = new Profile({
      fallbackSettings: defaultSettings(DEFAULT_MODE_ID, DEFAULT_MAP_ID, DEFAULT_CAMERA_CONFIG.fov),
    });
    const settings = this.profile.settings;
    this.cameraConfig.fov = clampFov(settings.fov);
    this.selection = {
      modeId: asModeId(settings.modeId),
      mapId: settings.mapId,
    };

    this.renderer = new Renderer(canvas);
    this.renderer.setSize(window.innerWidth, window.innerHeight, settings.renderScale);
    this.textures = new ProceduralTextures(this.renderer.three);
    this.uiHost = uiHost;
    this.debugHost = debugHost;
    this.viewmodel = new ViewmodelLayer(this.cameraConfig);
    this.viewmodel.resize(this.renderer.aspect);
    this.cameraRig = new CameraRig(this.cameraConfig, this.renderer.aspect);

    this.screens = new GameScreens({
      host: uiHost,
      profile: this.profile,
      audio: this.audio,
      selection: this.selection,
      onLaunch: () => this.transitionTo('MATCH'),
      onLoadout: () => this.transitionTo('LOADOUT'),
      onLoadoutBack: () => this.transitionTo('MENU'),
      onQuitToMenu: () => this.transitionTo('MENU'),
      onResume: () => this.resumeFromPause(),
      onToggleOverlay: () => this.toggleOverlayFromPause(),
      onLeaveSummary: () => this.transitionTo('MENU'),
      statusLine: () => this.statusLine(),
      pauseStatusLine: () => this.pauseStatusLine(),
      unrestricted: () => findMode(this.selection.modeId).unrestricted,
    });

    this.input = new Input({
      canvas,
      sensitivity: settings.sensitivity,
      invertY: settings.invertY,
    });
    this.input.onLockChange((locked) => this.onPointerLockChange(locked));
    this.input.onEscape(() => this.onEscape());

    this.audio.setMasterVolume(settings.masterVolume);

    this.loop = new Loop({
      sim: (tick) => this.simulate(tick),
      render: (alpha) => this.draw(alpha),
      onFrame: (sample) => this.onFrame(sample),
    });

    this.harness = new Harness(this.movementConfig);
    this.matchHarness = new MatchHarness({
      game: this,
      loop: this.loop,
      stats: this.stats,
    });

    this.registerStates();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pagehide', this.onPageHide);
  }

  get currentState(): GameStateId {
    return this.state;
  }

  get activeMatch(): Match | null {
    return this.world?.match ?? null;
  }

  get menuSelection(): MenuSelection {
    return this.selection;
  }

  /**
   * The loaded map, or null outside a match.
   *
   * Public because `public/verify/*.js` reach for `game.map` and `game.player` to drive the
   * real collision world and the real controller. Until M7 those were private fields the
   * scripts read anyway — TypeScript's `private` is compile-time only — so the refactor that
   * moved them into `MatchWorld` would have silently broken six shipped acceptance suites.
   * They are getters now, which is what they always were in practice.
   */
  get map(): LoadedMap | null {
    return this.world?.map ?? null;
  }

  get player(): PlayerController | null {
    return this.world?.player ?? null;
  }

  /** The per-match debug tooling, or null outside a match. */
  get debugSuite(): DebugSuite | null {
    return this.world?.debug ?? null;
  }

  /**
   * The input seam, for the console API and the verification scripts.
   *
   * Read-only in practice: nothing outside `Game` drives it, and the two things a script
   * wants to know — whether the cursor is captured and whether a click would recapture it —
   * are not observable any other way.
   */
  get inputState(): Input {
    return this.input;
  }

  get activeBotHarness(): BotHarness | null {
    return this.world?.botHarness ?? null;
  }

  /** The live player simulation state, or undefined outside a match. */
  get playerSim(): PlayerController['sim'] | undefined {
    return this.world?.player.sim;
  }

  /** Debug lever: burn this many milliseconds inside every frame (S7). */
  setSyntheticLoad(ms: number): void {
    this.loop.syntheticLoadMs = ms;
  }

  /** Kick the machine. BOOT starts the loop, then hands over to MENU. */
  start(): void {
    this.enterState('BOOT');
  }

  transitionTo(next: GameStateId): void {
    if (next === this.state) return;
    if (!isLegalGameTransition(this.state, next)) {
      throw new Error(`Illegal game transition ${this.state} -> ${next}`);
    }
    const handlers = this.states.get(next);
    if (handlers === undefined) {
      throw new Error(
        `Game state "${next}" has no handler registered. It is declared in GameStates.ts ` +
          `but not implemented in this milestone.`,
      );
    }
    const from = this.state;
    this.states.get(from)?.exit?.(next);
    this.state = next;
    handlers.enter?.(from);
    stateChangePayload.from = from;
    stateChangePayload.to = next;
    this.bus.emit(EV.GameStateChanged, stateChangePayload);
  }

  // -- state wiring --------------------------------------------------------

  private registerStates(): void {
    this.states.set('BOOT', {
      enter: () => {
        this.screens.menus.showBoot('Loading…');
        // The loop runs from boot so the menu is composited and the frame source is live
        // before any map exists. Deliberately a timeout rather than requestAnimationFrame:
        // rAF never fires in a background tab, and booting into a tab the user has not
        // focused yet would hang forever.
        this.loop.start();
        this.transport.open();
        installConsoleApi(this, this.harness, this.matchHarness);
        window.setTimeout(() => {
          this.transitionTo('MENU');
          this.startBotHarnessIfRequested();
        }, 32);
      },
    });

    this.states.set('MENU', {
      enter: () => {
        this.screens.menus.show();
        this.input.clearHeld();
      },
      exit: () => this.screens.menus.hide(),
    });

    /**
     * LOADOUT (M6). Declared in `GameStates.ts` since M1 with no handler; this is it.
     *
     * No world is built and no simulation runs — Create-a-Class is a front-end screen that
     * reads and writes the profile, and every edit persists through `Profile` as it is
     * made rather than on the way out. It is reachable from the menu and from the pause
     * screen, which is S6.3's "between spawns".
     */
    this.states.set('LOADOUT', {
      enter: () => {
        this.input.clearHeld();
        this.screens.loadoutEditor.show();
      },
      exit: (to) => {
        this.screens.loadoutEditor.hide();
        if (to === 'MENU') this.teardownWorld();
        // Back into a match that is still standing: hand the new class over live. A world
        // that was never torn down is the paused case, and `buildWorld` would no-op.
        else if (this.world !== null) this.world.match.applyLoadout(this.applyLoadout());
      },
    });

    this.states.set('MATCH', {
      enter: () => {
        this.audio.start();
        this.buildWorld();
        this.world?.match.setActive(true);
        // The click that started the match must not also pull the trigger.
        this.input.clearHeld();
        // The AFK harness has nobody to capture the cursor for, and asking for it without
        // a user gesture logs a rejection — which would put noise in the console the soak
        // run is there to prove is quiet.
        if (this.world?.botHarness == null && !this.matchHarness.isRunning) {
          // Armed rather than merely requested: resuming from the pause screen with Escape
          // has no user gesture, and resuming with the button can land inside Chrome's
          // post-Escape cooldown. Armed, the next click gets the cursor back either way.
          this.input.armPointerLock(true);
          // Only bites while the page is fullscreen; see Input.lockKeyboard and PLAN.md.
          this.input.lockKeyboard();
        }
      },
      exit: (to) => {
        this.input.unlockKeyboard();
        this.input.armPointerLock(false);
        this.audio.setSlide(false, 0, 0, 0, 0);
        // Pausing keeps the match active and the world built: it is the same match, simply
        // not advancing. Only leaving for good deactivates it.
        if (to === 'PAUSED') return;
        this.input.exitPointerLock();
        this.world?.match.setActive(false);
        // Going back to the menu without a result tears down here; going to SUMMARY keeps
        // the world alive so the scene is still behind the summary screen.
        if (to === 'MENU') this.teardownWorld();
      },
    });

    /**
     * PAUSED (M5). The world stays built and `simulate` stops advancing it.
     *
     * Deliberately not a `Loop.stop()`: the render pass still has to run so the pause
     * screen is composited over a live scene, and `FrameStats` should keep sampling so the
     * histogram does not develop a hole every time somebody pauses.
     */
    this.states.set('PAUSED', {
      enter: () => {
        this.input.clearHeld();
        // Disarmed while paused: a click belongs to the pause menu's buttons, not to
        // recapturing the cursor the player just released.
        this.input.armPointerLock(false);
        this.input.exitPointerLock();
        // Everything else on screen goes away. The overlay is interactive DOM over a
        // modal screen, which is exactly the clash the pause menu was reported for; the
        // pause menu has a button to bring it back deliberately.
        this.hideOverlayForPause();
        this.screens.pauseMenu.show();
      },
      exit: (to) => {
        this.screens.pauseMenu.hide();
        if (to === 'MENU') {
          this.world?.match.setActive(false);
          this.teardownWorld();
        }
      },
    });

    this.states.set('SUMMARY', {
      enter: () => {
        const match = this.world?.match ?? null;
        const result = match?.flow.result ?? null;
        if (match === null || result === null) {
          // Nothing to summarise: this can only happen if SUMMARY is entered by hand.
          this.transitionTo('MENU');
          return;
        }
        // Bank the match here rather than in `MatchEnded`: by this point nothing else is
        // going to change, and the profile is written exactly once (S6.6). `bankProgression`
        // is idempotent, so a harness that re-enters SUMMARY cannot double-count.
        const banks = findMode(this.selection.modeId).banksProgress;
        const report = match.bankProgression(result.winner === PLAYER_TEAM);
        this.screens.showSummary(
          match,
          result,
          this.mapEntry().name,
          banks ? report : null,
          this.profile.prestige,
        );
      },
      exit: () => {
        this.screens.hideSummary();
        this.teardownWorld();
      },
    });
  }

  private enterState(id: GameStateId): void {
    this.state = id;
    this.states.get(id)?.enter?.(id);
  }

  // -- world ---------------------------------------------------------------

  private mapEntry(): ReturnType<typeof findMap> {
    // A mode may pin its map — the Shooting Range only exists on the grey-box testbed,
    // because that is where the target dummies are built.
    const forced = findMode(this.selection.modeId).forcedMapId;
    return findMap(forced ?? this.selection.mapId);
  }

  /** Resolve the equipped class into the three long-lived weapon objects. */
  private applyLoadout(): ResolvedLoadout {
    return applyEquippedLoadout(this.profile, this.selection.modeId, {
      primary: this.weaponDef,
      secondary: this.secondaryDef,
      playerBase: this.playerBaseDef,
    });
  }

  /**
   * Build the world this match is played in. Called on entering MATCH, so the map the player
   * picked is the map that loads and a second match starts from nothing rather than from
   * whatever the first one left behind.
   */
  private buildWorld(): void {
    if (this.world !== null) return;
    const modeEntry = findMode(this.selection.modeId);
    this.world = new MatchWorld({
      bus: this.bus,
      scene: this.scene,
      renderer: this.renderer,
      textures: this.textures,
      viewmodel: this.viewmodel,
      cameraRig: this.cameraRig,
      audio: this.audio,
      input: this.input,
      loop: this.loop,
      uiHost: this.uiHost,
      debugHost: this.debugHost,
      stats: this.stats,
      speedo: this.speedo,
      matchHarness: this.matchHarness,
      profile: this.profile,
      movementConfig: this.movementConfig,
      cameraConfig: this.cameraConfig,
      viewmodelConfig: this.viewmodelConfig,
      healthConfig: this.healthConfig,
      equipmentConfig: this.equipmentConfig,
      weaponDef: this.weaponDef,
      secondaryDef: this.secondaryDef,
      playerBaseDef: this.playerBaseDef,
      tiers: this.tiers,
      perceptionConfig: this.perceptionConfig,
      schedulerConfig: this.schedulerConfig,
      mapEntry: this.mapEntry(),
      modeEntry,
      loadout: this.applyLoadout(),
      onMatchEnded: () => {
        this.pendingSummary = true;
      },
      onConfigChanged: () => this.onConfigChanged(),
      onWeaponConfigChanged: () => this.onWeaponConfigChanged(),
    });
  }

  /** Drop the world. `MatchWorld.dispose` is the mirror of its own constructor. */
  private teardownWorld(): void {
    this.pendingSummary = false;
    this.world?.dispose();
    this.world = null;
    this.speedo.reset();
  }

  /**
   * `?harness=botmatch` boots straight into an AFK bot match (S7).
   *
   * The roster is populated *before* the flow starts so `Match.setActive` sees a non-empty
   * one and skips the default firefight — otherwise a full roster would be built and thrown
   * away on the same frame.
   */
  private startBotHarnessIfRequested(): void {
    const options = parseHarnessOptions(window.location.search);
    if (options === null) return;
    if (options.map !== null) this.selection.mapId = options.map;
    // M7: the harness can run any mode. Applied before the transition, so the world is built
    // from the same registry entry a player's choice would have produced.
    if (options.mode !== null) this.selection.modeId = options.mode;

    this.transitionTo('MATCH');
    this.world?.startBotHarness(options);
  }

  private onConfigChanged(): void {
    this.world?.applyMovementConfig();
    this.cameraConfig.fov = clampFov(this.cameraConfig.fov);
    this.profile.patchSettings({ fov: this.cameraConfig.fov });
  }

  private onWeaponConfigChanged(): void {
    this.world?.applyWeaponConfig();
  }

  // -- loop ----------------------------------------------------------------

  private simulate(tick: number): void {
    const world = this.world;
    if (world === null) return;
    // A paused match does not advance. The render pass still runs, so the pause screen is
    // composited over a live scene and the frame histogram keeps sampling.
    if (this.state === 'PAUSED') return;

    // Input crosses the netcode boundary even in single player: the sim only ever
    // sees command data, which is what keeps INetworkTransport real (S4.2).
    //
    // A dead player submits neutral commands rather than being skipped: the sim still
    // runs for them, the corpse still collides, and the seam stays honest — which is
    // exactly what a real server would send while waiting on a respawn. Tab is the one
    // exception, so the scoreboard is reachable from the death screen (M5).
    const now = performance.now();
    const inMatch = this.state === 'MATCH';
    const dead = world.match.isPlayerDead;
    const cmd = !inMatch
      ? this.input.sampleNeutral(tick, now)
      : dead
        ? this.input.sampleSpectating(tick, now)
        : this.input.sample(tick, now);
    this.transport.submit(cmd);
    const count = this.transport.drain(this.drainBuffer, MAX_STEPS_PER_FRAME);
    for (let i = 0; i < count; i++) {
      const drained = this.drainBuffer[i];
      if (drained === undefined) continue;
      world.player.step(drained);
      // The weapon consumes the same command the player did, one tick at a time, so
      // fire rate and reload timing are as frame-rate independent as movement is (S4.1).
      world.match.simulate(drained);
    }
    world.debug.simulate(world.player, this.movementConfig);
  }

  private draw(alpha: number): void {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastRenderMs) / 1000);
    this.lastRenderMs = now;

    const world = this.world;
    if (world === null) {
      // No world: the menu is DOM over an empty canvas, and the canvas still has to be
      // cleared or it holds the last frame of the previous match behind the front end.
      this.renderer.clear();
      return;
    }

    const player = world.player;
    const sim = player.sim;
    const match = world.match;
    const def = this.weaponDef;

    // Sampled before the camera is composed: the interpolated aim-recoil offset is part
    // of where the camera points, so it cannot be produced after the fact (S6.2).
    match.sampleVisual(alpha);
    const yaw = this.input.yaw + match.visual.aimYaw * DEG2RAD;
    const pitch = this.input.pitch + match.visual.aimPitch * DEG2RAD;

    this.drive.sprint = sim.sprintActive;
    this.drive.tacSprint = sim.tacSprintActive;
    this.drive.slide = sim.slideActive;
    this.drive.adsFraction = match.visual.adsFraction;
    this.drive.adsFovScale = def.adsFovScale;
    this.drive.adsViewmodelFovScale = def.adsViewmodelFovScale;

    this.cameraRig.update(
      player.prev,
      player.curr,
      alpha,
      yaw,
      pitch,
      this.drive,
      this.cameraConfig,
      dt,
      this.viewmodel,
    );

    const cam = this.cameraRig.camera;
    if (this.audio.isRunning) {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, fx, 0, fz, 0, 1, 0);
      // The slide scrape is a sustained source, so it is driven per frame from the
      // stance rather than fired from an event (see PLAN.md, M1 playtest note).
      this.audio.setSlide(sim.slideActive, sim.x, sim.y, sim.z, sim.speed, sim.groundMaterial);
    }
    // Recycling runs whatever the context is doing. Skipping it while suspended is how
    // voices used to accumulate: nothing was freeing them, and something still had to.
    this.audio.update();

    match.render(alpha, cam, dt, yaw, pitch);
    world.debug.render(cam, alpha, dt);

    /**
     * A live Chopper Gunner owns the view (M7).
     *
     * Asked rather than pushed: the streak hands back a camera while it is running and null
     * once it has been restored, so there is nothing for `Game` to undo and no state here that
     * could disagree with the streak about whose camera it is. That is what makes acceptance
     * criterion 2 — "returns control cleanly, including if the player is killed or the match
     * ends" — a property of one method rather than of four call sites.
     */
    const chopper = match.streaks.activeChopperFor(PLAYER_ENTITY_ID);
    const takeover = chopper?.activeCamera(this.renderer.aspect) ?? null;
    if (takeover !== null) {
      // Thermal is a render pass over the world with the bodies drawn hot, not a filter over
      // the ordinary image (S6.1). No viewmodel: the player is not holding anything.
      this.renderer.renderThermal(this.scene, takeover, match.bots.group);
    } else {
      this.renderer.render(this.scene, cam, this.viewmodel);
    }
    world.debug.update(dt);

    // The match ended during a sim tick this frame. Transition now, between frames, with
    // nothing part-way through a dispatch. A paused match cannot end, so PAUSED is not a
    // case here; the flag survives until the match resumes.
    if (this.pendingSummary && this.state === 'MATCH') {
      this.pendingSummary = false;
      this.transitionTo('SUMMARY');
    }
  }

  private onFrame(sample: FrameSample): void {
    const match = this.world?.match;
    this.stats.push(sample.frameMs, sample.simMs, sample.renderMs, sample.steps, sample.starved);
    this.stats.pushBreakdown(match?.lastModeMs ?? 0, match?.ui.lastUpdateMs ?? 0);
  }

  // -- events --------------------------------------------------------------

  private statusLine(): string {
    const map = this.mapEntry();
    return `${map.name} · ${map.def.brushes.length} brushes · ${map.def.props.length} props`;
  }


  /**
   * The cursor was released — almost always Esc (M5, from the M4 playtest notes).
   *
   * M4 quit the match outright here, which is why Esc lost your game. It now pauses: the
   * world stays built, the sim stops, and the pause screen goes over the top. Quitting is a
   * button on that screen rather than a side effect of a key the browser owns.
   */
  private onPointerLockChange(locked: boolean): void {
    if (locked) return;
    if (this.state === 'MATCH') this.transitionTo('PAUSED');
  }

  /**
   * Escape, when the browser did *not* consume it to release pointer lock.
   *
   * That is the paused case, and the un-paused-but-not-locked case (the AFK harness, or a
   * player who clicked away). Pausing from a locked match arrives through
   * `onPointerLockChange` instead, so exactly one of the two fires.
   */
  private onEscape(): void {
    // The Esc stack, from the M5 playtest notes: with the overlay open, Esc closes the
    // overlay and stops. It used to fall straight through to "resume", which meant a
    // player closing a panel was thrown back into a firefight.
    const overlay = this.world?.debug.overlay;
    if (overlay !== undefined && overlay.isVisible) {
      overlay.setVisible(false);
      this.overlayWasOpenBeforePause = false;
      return;
    }
    if (this.state === 'LOADOUT') {
      this.transitionTo(this.world === null ? 'MENU' : 'PAUSED');
      return;
    }
    if (this.state === 'PAUSED') {
      this.resumeFromPause();
      return;
    }
    if (this.state === 'MATCH' && !this.input.isLocked) this.transitionTo('PAUSED');
  }

  /**
   * The pause screen's debug button. Once the overlay has been opened on purpose it stays
   * open through the resume, rather than being closed again by the pause book-keeping.
   */
  private toggleOverlayFromPause(): void {
    const overlay = this.world?.debug.overlay;
    if (overlay === undefined) return;
    overlay.setVisible(!overlay.isVisible);
    this.overlayWasOpenBeforePause = overlay.isVisible;
  }

  private resumeFromPause(): void {
    if (this.state !== 'PAUSED') return;
    this.transitionTo('MATCH');
    this.restoreOverlayAfterPause();
  }

  /**
   * Take the F1 overlay off screen for the duration of the pause.
   *
   * It is a large, interactive, full-screen panel and the pause screen is modal; two of
   * those on top of each other is the "UI bugs" the pause menu was reported for. Whether
   * it was open is remembered so resuming puts the player back where they were.
   */
  private hideOverlayForPause(): void {
    const overlay = this.world?.debug.overlay;
    if (overlay === undefined) return;
    this.overlayWasOpenBeforePause = overlay.isVisible;
    overlay.setVisible(false);
  }

  private restoreOverlayAfterPause(): void {
    if (!this.overlayWasOpenBeforePause) return;
    this.world?.debug.overlay.setVisible(true);
  }

  private pauseStatusLine(): string {
    const match = this.world?.match;
    if (match === undefined) return this.mapEntry().name;
    const mode = match.mode;
    return `${mode.name} · ${this.mapEntry().name} · ${mode.teamScore('A')} – ${mode.teamScore('B')}`;
  }

  private readonly onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, this.profile.settings.renderScale);
    this.cameraRig.resize(this.renderer.aspect);
    this.viewmodel.resize(this.renderer.aspect);
  };

  private readonly onPageHide = (): void => {
    this.profile.patchSettings({ modeId: this.selection.modeId, mapId: this.selection.mapId });
    this.profile.flush();
    this.audio.suspend();
  };
}

function clampFov(v: number): number {
  return Math.min(FOV_MAX, Math.max(FOV_MIN, v));
}
