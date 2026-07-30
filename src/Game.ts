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
import { SaveStore, type Versioned } from './core/SaveStore';
import { LocalBotTransport, type INetworkTransport } from './core/Transport';
import { CameraRig, type CameraDrive } from './engine/CameraRig';
import { ProceduralAudio } from './engine/ProceduralAudio';
import { ProceduralTextures } from './engine/ProceduralTextures';
import { Renderer } from './engine/Renderer';
import { BotHarness, parseHarnessOptions } from './debug/BotHarness';
import { DebugSuite } from './debug/DebugSuite';
import { FrameStats } from './debug/FrameStats';
import { installConsoleApi } from './debug/ConsoleApi';
import { Harness } from './debug/Harness';
import { MatchHarness } from './debug/MatchHarness';
import { Speedometer } from './debug/Speedometer';
import { isLegalGameTransition, type GameStateId } from './GameStates';
import { Match } from './Match';
import { PLAYER_TEAM } from './Match';
import type { GameModeId } from './modes/GameMode';
import { DEFAULT_MAP_ID, DEFAULT_MODE_ID, findMap, findMode } from './modes/ModeRegistry';
import { DEFAULT_CAMERA_CONFIG, FOV_MAX, FOV_MIN, type CameraConfig } from './player/CameraConfig';
import { DEFAULT_HEALTH_CONFIG, type HealthConfig } from './player/Health';
import { DEFAULT_MOVEMENT_CONFIG, cloneMovementConfig, type MovementConfig } from './player/MovementConfig';
import { PlayerController } from './player/PlayerController';
import { ViewmodelLayer } from './player/Viewmodel';
import { EndOfMatch } from './ui/EndOfMatch';
import { Menus, type MenuSelection } from './ui/Menus';
import { PauseMenu } from './ui/PauseMenu';
import {
  cloneEquipmentConfig,
  DEFAULT_EQUIPMENT_CONFIG,
  type EquipmentConfig,
} from './equipment/EquipmentConfig';
import { AR_DEFAULT, cloneWeaponDef, PISTOL_DEFAULT, type WeaponDef } from './weapons/WeaponDefs';
import { cloneViewmodelConfig, DEFAULT_VIEWMODEL_CONFIG, type ViewmodelConfig } from './weapons/ViewmodelConfig';
import { applyAmbient, loadMap, type LoadedMap } from './world/MapLoader';

/**
 * Application root and the top-level state machine (S6.3): BOOT -> MENU -> MATCH -> SUMMARY.
 *
 * `LOADOUT` is declared in `GameStates.ts` because the shape is fixed but has no handler
 * until M6; `transitionTo` refuses to enter a state that nothing implements rather than
 * silently doing nothing.
 *
 * ## The world is per-match, and that is the whole point
 *
 * M1-M3 built the map, the player and the match once at boot and kept them for the life of
 * the page, because there was only ever one of each. M4 has a map *choice* and a summary
 * screen you come back from, so the world is built on entering MATCH and **fully disposed on
 * leaving SUMMARY** — S6.3's "loading a map twice must not double anything".
 *
 * That is a real constraint on this file, and it is why `buildWorld` and `teardownWorld` are
 * exact mirrors: every field one sets, the other clears; every group one adds to the scene,
 * the other removes. What survives a match is only what is genuinely process-wide — the
 * renderer, the textures, the audio graph, the input listener, the frame-stats buffer and the
 * config objects the tuning panel holds references to. `MatchHarness` runs the cycle
 * repeatedly and logs the heap at each boundary, which is the test that this is true.
 */

interface Settings extends Versioned {
  version: 2;
  fov: number;
  sensitivity: number;
  invertY: boolean;
  masterVolume: number;
  renderScale: number;
  /** M4: remembered menu selection. */
  modeId: GameModeId;
  mapId: string;
}

const DEFAULT_SETTINGS: Settings = {
  version: 2,
  fov: DEFAULT_CAMERA_CONFIG.fov,
  sensitivity: 1,
  invertY: false,
  masterVolume: 0.8,
  renderScale: 1,
  modeId: DEFAULT_MODE_ID,
  mapId: DEFAULT_MAP_ID,
};

interface StateHandlers {
  enter?: (from: GameStateId) => void;
  exit?: (to: GameStateId) => void;
}

const stateChangePayload = { from: 'BOOT' as GameStateId, to: 'BOOT' as GameStateId };

/**
 * Seed for everything in `ai/`. Fixed, so two runs of the harness with the same roster
 * produce the same firefight and a regression in bot behaviour is reproducible.
 */
const AI_SEED = 0x0fe7_a105;

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
  private readonly menus: Menus;
  private readonly pauseMenu: PauseMenu;
  private readonly summary: EndOfMatch;
  private readonly uiHost: HTMLElement;
  private readonly debugHost: HTMLElement;
  private readonly settings: SaveStore<Settings>;
  private readonly transport: INetworkTransport = new LocalBotTransport(64);
  private readonly input: Input;
  private readonly loop: Loop;
  private readonly selection: MenuSelection;

  // ---- per-match. Every one of these is nulled by `teardownWorld` ---------
  private map: LoadedMap | null = null;
  private player: PlayerController | null = null;
  private match: Match | null = null;
  /** The F1 overlay and every visualiser and panel that hangs off it. */
  private debug: DebugSuite | null = null;
  private botHarness: BotHarness | null = null;
  private matchEndedSubscription: (() => void) | null = null;

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

  constructor(canvas: HTMLCanvasElement, uiHost: HTMLElement, debugHost: HTMLElement) {
    this.settings = new SaveStore<Settings>('operator.settings', 2, DEFAULT_SETTINGS, (raw, from) => {
      console.info(`[Game] settings v${from} predates the mode/map selection; using defaults.`, raw);
      return null;
    });
    this.cameraConfig.fov = clampFov(this.settings.value.fov);
    this.selection = {
      modeId: this.settings.value.modeId,
      mapId: this.settings.value.mapId,
    };

    this.renderer = new Renderer(canvas);
    this.renderer.setSize(window.innerWidth, window.innerHeight, this.settings.value.renderScale);
    this.textures = new ProceduralTextures(this.renderer.three);
    this.uiHost = uiHost;
    this.debugHost = debugHost;
    this.viewmodel = new ViewmodelLayer(this.cameraConfig);
    this.viewmodel.resize(this.renderer.aspect);
    this.cameraRig = new CameraRig(this.cameraConfig, this.renderer.aspect);

    this.menus = new Menus({
      host: uiHost,
      selection: this.selection,
      onLaunch: () => this.transitionTo('MATCH'),
      statusLine: () => this.statusLine(),
    });
    this.pauseMenu = new PauseMenu({
      host: uiHost,
      onResume: () => this.resumeFromPause(),
      onToggleDebug: () => {
        const overlay = this.debug?.overlay;
        overlay?.setVisible(!overlay.isVisible);
      },
      onQuit: () => this.transitionTo('MENU'),
      statusLine: () => this.pauseStatusLine(),
    });
    this.summary = new EndOfMatch({
      // Sized to the largest roster any map asks for, so the board never has to grow.
      rowsPerTeam: 8,
      onContinue: () => this.transitionTo('MENU'),
    });
    uiHost.appendChild(this.summary.element);

    this.input = new Input({
      canvas,
      sensitivity: this.settings.value.sensitivity,
      invertY: this.settings.value.invertY,
    });
    this.input.onLockChange((locked) => this.onPointerLockChange(locked));
    this.input.onEscape(() => this.onEscape());

    this.audio.setMasterVolume(this.settings.value.masterVolume);

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
    return this.match;
  }

  get menuSelection(): MenuSelection {
    return this.selection;
  }

  get loadedMap(): LoadedMap | null {
    return this.map;
  }

  /** The per-match debug tooling, or null outside a match. */
  get debugSuite(): DebugSuite | null {
    return this.debug;
  }

  get activeBotHarness(): BotHarness | null {
    return this.botHarness;
  }

  /** The live player simulation state, or undefined outside a match. */
  get playerSim(): PlayerController['sim'] | undefined {
    return this.player?.sim;
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
        this.menus.showBoot('Loading…');
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
        this.menus.show();
        this.input.clearHeld();
      },
      exit: () => this.menus.hide(),
    });

    this.states.set('MATCH', {
      enter: () => {
        this.audio.start();
        this.buildWorld();
        this.match?.setActive(true);
        // The click that started the match must not also pull the trigger.
        this.input.clearHeld();
        // The AFK harness has nobody to capture the cursor for, and asking for it without
        // a user gesture logs a rejection — which would put noise in the console the soak
        // run is there to prove is quiet.
        if (this.botHarness === null && !this.matchHarness.isRunning) {
          this.input.requestPointerLock();
          // Only bites while the page is fullscreen; see Input.lockKeyboard and PLAN.md.
          this.input.lockKeyboard();
        }
      },
      exit: (to) => {
        this.input.unlockKeyboard();
        this.audio.setSlide(false, 0, 0, 0, 0);
        // Pausing keeps the match active and the world built: it is the same match, simply
        // not advancing. Only leaving for good deactivates it.
        if (to === 'PAUSED') return;
        this.input.exitPointerLock();
        this.match?.setActive(false);
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
        this.input.exitPointerLock();
        this.pauseMenu.show();
      },
      exit: (to) => {
        this.pauseMenu.hide();
        if (to === 'MENU') {
          this.match?.setActive(false);
          this.teardownWorld();
        }
      },
    });

    this.states.set('SUMMARY', {
      enter: () => {
        const match = this.match;
        const result = match?.flow.result;
        if (match === null || match === undefined || result === undefined || result === null) {
          // Nothing to summarise: this can only happen if SUMMARY is entered by hand.
          this.transitionTo('MENU');
          return;
        }
        this.summary.setColumns(match.mode.getScoreboardColumns(), match.mode.name, this.mapEntry().name);
        this.summary.show(
          result.winner,
          PLAYER_TEAM,
          result.reason,
          result.scoreA,
          result.scoreB,
          match.score,
        );
      },
      exit: () => {
        this.summary.hide();
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
    return findMap(this.selection.mapId);
  }

  /**
   * Build everything a match needs. The exact mirror of `teardownWorld`.
   *
   * Called on entering MATCH, so the map the player picked is the map that loads and a second
   * match starts from nothing rather than from whatever the first one left behind.
   */
  private buildWorld(): void {
    if (this.map !== null) return;
    const mapEntry = this.mapEntry();
    const modeEntry = findMode(this.selection.modeId);

    const map = loadMap(mapEntry.def, this.textures);
    this.map = map;
    this.scene.add(map.root);
    applyAmbient(this.scene, map.def);
    map.collision.configure(this.movementConfig.maxSlopeDeg, this.movementConfig.collisionSkin);

    const player = new PlayerController(this.movementConfig, map.collision, this.bus);
    this.player = player;

    const spawn = map.spawns[0];
    if (spawn === undefined) throw new Error('Map has no spawn zones');
    player.spawn(spawn.position.x, spawn.position.y, spawn.position.z, spawn.facingYaw);
    this.input.setView(spawn.facingYaw, 0);

    const match = new Match({
      bus: this.bus,
      scene: this.scene,
      viewmodel: this.viewmodel,
      cameraRig: this.cameraRig,
      cameraConfig: this.cameraConfig,
      audio: this.audio,
      input: this.input,
      world: map.collision,
      player,
      movementConfig: this.movementConfig,
      weaponDef: this.weaponDef,
      secondaryDef: this.secondaryDef,
      viewmodelConfig: this.viewmodelConfig,
      healthConfig: this.healthConfig,
      equipmentConfig: this.equipmentConfig,
      uiHost: this.uiHost,
      anisotropy: this.textures.anisotropy,
      map: mapEntry,
      mode: modeEntry,
      tiers: this.tiers,
      perceptionConfig: this.perceptionConfig,
      schedulerConfig: this.schedulerConfig,
      seed: AI_SEED,
    });
    this.match = match;

    // The match declaring itself over is what moves the state machine on. Deferred to the
    // render pass rather than transitioned from inside a sim tick: tearing the HUD down
    // half-way through the tick that produced the winning kill is how you get a null
    // dereference in the middle of an event dispatch.
    this.matchEndedSubscription = this.bus.on(EV.MatchEnded, () => {
      this.pendingSummary = true;
    });

    this.debug = new DebugSuite({
      host: this.debugHost,
      bus: this.bus,
      loop: this.loop,
      renderer: this.renderer,
      scene: this.scene,
      audio: this.audio,
      player,
      cameraRig: this.cameraRig,
      map,
      mapEntry,
      match,
      movementConfig: this.movementConfig,
      cameraConfig: this.cameraConfig,
      weaponDef: this.weaponDef,
      viewmodelConfig: this.viewmodelConfig,
      healthConfig: this.healthConfig,
      equipmentConfig: this.equipmentConfig,
      tiers: this.tiers,
      perceptionConfig: this.perceptionConfig,
      schedulerConfig: this.schedulerConfig,
      stats: this.stats,
      speedo: this.speedo,
      matchHarness: this.matchHarness,
      onConfigChanged: () => this.onConfigChanged(),
      onWeaponConfigChanged: () => this.onWeaponConfigChanged(),
    });
  }

  /**
   * Take the world apart. The exact mirror of `buildWorld`.
   *
   * Order matters only in that the debug tooling holds references to the match and the map,
   * so it goes first. Everything that was added to the scene is removed and everything with
   * a `dispose` gets it — including the map's geometries and materials, which are the largest
   * thing a match allocates.
   */
  private teardownWorld(): void {
    this.pendingSummary = false;

    this.matchEndedSubscription?.();
    this.matchEndedSubscription = null;

    this.debug?.dispose();
    this.debug = null;
    this.botHarness?.stop();
    this.botHarness = null;

    this.match?.dispose();
    this.match = null;
    this.player = null;

    if (this.map !== null) {
      this.scene.remove(this.map.root);
      this.map.dispose();
      this.map = null;
    }
    this.scene.fog = null;
    this.scene.background = null;
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

    this.transitionTo('MATCH');
    const match = this.match;
    if (match === null) return;

    const harness = new BotHarness(options, match, this.loop, this.stats);
    this.botHarness = harness;
    harness.start();
  }

  private onConfigChanged(): void {
    this.player?.setConfig(this.movementConfig);
    this.map?.collision.configure(this.movementConfig.maxSlopeDeg, this.movementConfig.collisionSkin);
    this.cameraConfig.fov = clampFov(this.cameraConfig.fov);
    this.settings.patch({ fov: this.cameraConfig.fov });
  }

  private onWeaponConfigChanged(): void {
    this.match?.weapons.setDefinition(this.weaponDef);
    this.match?.playerHealth.setConfig(this.healthConfig);
    for (const dummy of this.match?.range?.dummies ?? []) {
      dummy.health.setConfig(this.healthConfig);
      dummy.markLabelDirty();
    }
    // Bots carry the same weapon and the same health, so a retune has to reach them or
    // the two sides stop sharing the damage maths that makes TTK symmetric.
    this.match?.bots.applyWeaponDef(this.weaponDef);
    this.match?.bots.applyHealthConfig(this.healthConfig);
  }

  // -- loop ----------------------------------------------------------------

  private simulate(tick: number): void {
    const player = this.player;
    if (player === null) return;
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
    const dead = this.match?.isPlayerDead === true;
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
      player.step(drained);
      // The weapon consumes the same command the player did, one tick at a time, so
      // fire rate and reload timing are as frame-rate independent as movement is (S4.1).
      this.match?.simulate(drained);
    }
    this.debug?.simulate(player, this.movementConfig);
  }

  private draw(alpha: number): void {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastRenderMs) / 1000);
    this.lastRenderMs = now;

    const player = this.player;
    if (player === null) {
      // No world: the menu is DOM over an empty canvas, and the canvas still has to be
      // cleared or it holds the last frame of the previous match behind the front end.
      this.renderer.clear();
      return;
    }

    const sim = player.sim;
    const match = this.match;
    const def = this.weaponDef;

    // Sampled before the camera is composed: the interpolated aim-recoil offset is part
    // of where the camera points, so it cannot be produced after the fact (S6.2).
    match?.sampleVisual(alpha);
    const aimYaw = match === null ? 0 : match.visual.aimYaw * DEG2RAD;
    const aimPitch = match === null ? 0 : match.visual.aimPitch * DEG2RAD;
    const yaw = this.input.yaw + aimYaw;
    const pitch = this.input.pitch + aimPitch;

    this.drive.sprint = sim.sprintActive;
    this.drive.tacSprint = sim.tacSprintActive;
    this.drive.slide = sim.slideActive;
    this.drive.adsFraction = match === null ? 0 : match.visual.adsFraction;
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

    match?.render(alpha, cam, dt, yaw, pitch);
    this.debug?.render(cam, alpha, dt);

    this.renderer.render(this.scene, cam, this.viewmodel);
    this.debug?.update(dt);

    // The match ended during a sim tick this frame. Transition now, between frames, with
    // nothing part-way through a dispatch. A paused match cannot end, so PAUSED is not a
    // case here; the flag survives until the match resumes.
    if (this.pendingSummary && this.state === 'MATCH') {
      this.pendingSummary = false;
      this.transitionTo('SUMMARY');
    }
  }

  private onFrame(sample: FrameSample): void {
    this.stats.push(sample.frameMs, sample.simMs, sample.renderMs, sample.steps, sample.starved);
    this.stats.pushBreakdown(this.match?.lastModeMs ?? 0, this.match?.ui.lastUpdateMs ?? 0);
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
    if (this.state === 'PAUSED') {
      this.resumeFromPause();
      return;
    }
    if (this.state === 'MATCH' && !this.input.isLocked) this.transitionTo('PAUSED');
  }

  private resumeFromPause(): void {
    if (this.state !== 'PAUSED') return;
    this.transitionTo('MATCH');
  }

  private pauseStatusLine(): string {
    const match = this.match;
    if (match === null) return this.mapEntry().name;
    const mode = match.mode;
    return `${mode.name} · ${this.mapEntry().name} · ${mode.teamScore('A')} – ${mode.teamScore('B')}`;
  }

  private readonly onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, this.settings.value.renderScale);
    this.cameraRig.resize(this.renderer.aspect);
    this.viewmodel.resize(this.renderer.aspect);
  };

  private readonly onPageHide = (): void => {
    this.settings.patch({ modeId: this.selection.modeId, mapId: this.selection.mapId });
    this.settings.flush();
    this.audio.suspend();
  };
}

function clampFov(v: number): number {
  return Math.min(FOV_MAX, Math.max(FOV_MIN, v));
}
