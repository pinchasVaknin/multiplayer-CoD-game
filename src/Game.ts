import * as THREE from 'three';
import { DEFAULT_SCHEDULER, type SchedulerConfig } from './ai/AiScheduler';
import {
  cloneTierTable,
  DEFAULT_PERCEPTION,
  DEFAULT_TIERS,
  type PerceptionConfig,
  type TierTable,
} from './ai/DifficultyTiers';
import { PLAYER_ENTITY_ID } from './combat/DamageSystem';
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
import { AiDebug } from './debug/AiDebug';
import { AiPanel } from './debug/AiPanel';
import { BotHarness, parseHarnessOptions } from './debug/BotHarness';
import { CollisionDebug } from './debug/CollisionDebug';
import { DebugOverlay } from './debug/DebugOverlay';
import { Harness } from './debug/Harness';
import { HitboxDebug } from './debug/HitboxDebug';
import { WeaponDebug } from './debug/WeaponDebug';
import { WeaponHarness } from './debug/WeaponHarness';
import { isLegalGameTransition, type GameStateId } from './GameStates';
import { Match } from './Match';
import { DEFAULT_CAMERA_CONFIG, FOV_MAX, FOV_MIN, type CameraConfig } from './player/CameraConfig';
import { DEFAULT_HEALTH_CONFIG, type HealthConfig } from './player/Health';
import { DEFAULT_MOVEMENT_CONFIG, cloneMovementConfig, type MovementConfig } from './player/MovementConfig';
import { PlayerController } from './player/PlayerController';
import { ViewmodelLayer } from './player/Viewmodel';
import { Screens } from './ui/Screens';
import { AR_DEFAULT, cloneWeaponDef, type WeaponDef } from './weapons/WeaponDefs';
import { cloneViewmodelConfig, DEFAULT_VIEWMODEL_CONFIG, type ViewmodelConfig } from './weapons/ViewmodelConfig';
import { applyAmbient, loadMap, type LoadedMap } from './world/MapLoader';
import { GREYBOX_MAP } from './world/maps/greybox';

/**
 * Application root and the top-level state machine (S3): BOOT -> MENU -> MATCH.
 *
 * LOADOUT and SUMMARY are declared in GameStates.ts because the shape is fixed, but
 * they have no handler registered in M1 and `transitionTo` refuses to enter a state
 * that nothing implements. That is deliberate: an empty state handler that silently
 * does nothing is the kind of scaffolding this project does not ship.
 */

interface Settings extends Versioned {
  version: 1;
  fov: number;
  sensitivity: number;
  invertY: boolean;
  masterVolume: number;
  renderScale: number;
}

const DEFAULT_SETTINGS: Settings = {
  version: 1,
  fov: DEFAULT_CAMERA_CONFIG.fov,
  sensitivity: 1,
  invertY: false,
  masterVolume: 0.8,
  renderScale: 1,
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
  readonly weaponDef: WeaponDef = cloneWeaponDef(AR_DEFAULT);
  readonly viewmodelConfig: ViewmodelConfig = cloneViewmodelConfig(DEFAULT_VIEWMODEL_CONFIG);
  readonly healthConfig: HealthConfig = { ...DEFAULT_HEALTH_CONFIG };
  /**
   * M3 config. These are held here and handed to `Match` by reference, so a slider in the
   * debug panel retunes the live bots rather than the next ones to spawn.
   */
  readonly tiers: TierTable = cloneTierTable(DEFAULT_TIERS);
  readonly perceptionConfig: PerceptionConfig = { ...DEFAULT_PERCEPTION };
  readonly schedulerConfig: SchedulerConfig = { ...DEFAULT_SCHEDULER };

  private readonly scene = new THREE.Scene();
  private readonly renderer: Renderer;
  private readonly textures: ProceduralTextures;
  private readonly viewmodel: ViewmodelLayer;
  private readonly cameraRig: CameraRig;
  private readonly audio = new ProceduralAudio();
  private readonly screens: Screens;
  private readonly uiHost: HTMLElement;
  private readonly settings: SaveStore<Settings>;
  private readonly transport: INetworkTransport = new LocalBotTransport(64);
  private readonly input: Input;
  private readonly loop: Loop;

  private map: LoadedMap | null = null;
  private player: PlayerController | null = null;
  private match: Match | null = null;
  private collisionDebug: CollisionDebug | null = null;
  private hitboxDebug: HitboxDebug | null = null;
  private aiDebug: AiDebug | null = null;
  private aiPanel: AiPanel | null = null;
  private overlay: DebugOverlay | null = null;
  /** Retained so its window-level key handler can be removed on teardown. */
  private weaponDebug: WeaponDebug | null = null;
  private harness: Harness | null = null;
  private weaponHarness: WeaponHarness | null = null;
  private botHarness: BotHarness | null = null;

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

  constructor(canvas: HTMLCanvasElement, uiHost: HTMLElement, debugHost: HTMLElement) {
    this.settings = new SaveStore<Settings>('operator.settings', 1, DEFAULT_SETTINGS, (raw, from) => {
      console.warn(`[Game] settings v${from} has no migration path; falling back to defaults.`, raw);
      return null;
    });
    this.cameraConfig.fov = clampFov(this.settings.value.fov);

    this.renderer = new Renderer(canvas);
    this.renderer.setSize(window.innerWidth, window.innerHeight, this.settings.value.renderScale);
    this.textures = new ProceduralTextures(this.renderer.three);
    this.uiHost = uiHost;
    this.viewmodel = new ViewmodelLayer(this.cameraConfig);
    this.viewmodel.resize(this.renderer.aspect);
    this.cameraRig = new CameraRig(this.cameraConfig, this.renderer.aspect);
    this.screens = new Screens(uiHost);

    this.input = new Input({
      canvas,
      sensitivity: this.settings.value.sensitivity,
      invertY: this.settings.value.invertY,
    });
    this.input.onLockChange((locked) => this.onPointerLockChange(locked));

    this.audio.setMasterVolume(this.settings.value.masterVolume);

    this.loop = new Loop({
      sim: (tick) => this.simulate(tick),
      render: (alpha) => this.draw(alpha),
      onFrame: (sample) => this.onFrame(sample),
    });

    this.registerStates(debugHost);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pagehide', this.onPageHide);
  }

  get currentState(): GameStateId {
    return this.state;
  }

  /** Kick the machine. BOOT builds the map, then hands over to MENU. */
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

  private registerStates(debugHost: HTMLElement): void {
    this.states.set('BOOT', {
      enter: () => {
        this.screens.showBoot('Building map…');
        // Give the boot screen one paint before the synchronous bake. Deliberately a
        // timeout rather than requestAnimationFrame: rAF never fires in a background
        // tab, and booting into a tab the user has not focused yet would hang forever.
        window.setTimeout(() => {
          this.buildWorld(debugHost);
          this.transitionTo('MENU');
          this.startBotHarnessIfRequested();
        }, 32);
      },
    });

    this.states.set('MENU', {
      enter: () => {
        const stats = this.map?.stats;
        const detail =
          stats === undefined
            ? 'Testbed'
            : `Testbed · ${stats.colliders} colliders · ${stats.drawCalls} draws · built in ${stats.buildMs.toFixed(0)} ms`;
        this.screens.showMenu(detail, () => this.transitionTo('MATCH'));
        this.input.clearHeld();
      },
      exit: () => this.screens.hide(),
    });

    this.states.set('MATCH', {
      enter: () => {
        this.audio.start();
        this.match?.setActive(true);
        // The click that started the match must not also pull the trigger.
        this.input.clearHeld();
        // The AFK harness has nobody to capture the cursor for, and asking for it without
        // a user gesture logs a rejection — which would put noise in the console the soak
        // run is there to prove is quiet.
        if (this.botHarness === null) {
          this.input.requestPointerLock();
          // Only bites while the page is fullscreen; see Input.lockKeyboard and PLAN.md.
          this.input.lockKeyboard();
        }
      },
      exit: () => {
        this.input.exitPointerLock();
        this.input.unlockKeyboard();
        this.match?.setActive(false);
        this.audio.setSlide(false, 0, 0, 0, 0);
      },
    });
  }

  private enterState(id: GameStateId): void {
    this.state = id;
    this.states.get(id)?.enter?.(id);
  }

  // -- world ---------------------------------------------------------------

  private buildWorld(debugHost: HTMLElement): void {
    const map = loadMap(GREYBOX_MAP, this.textures);
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

    const collisionDebug = new CollisionDebug(map.collision);
    this.collisionDebug = collisionDebug;
    this.scene.add(collisionDebug.group);

    const match = new Match({
      bus: this.bus,
      scene: this.scene,
      viewmodel: this.viewmodel,
      cameraRig: this.cameraRig,
      audio: this.audio,
      input: this.input,
      world: map.collision,
      player,
      movementConfig: this.movementConfig,
      weaponDef: this.weaponDef,
      viewmodelConfig: this.viewmodelConfig,
      healthConfig: this.healthConfig,
      uiHost: this.uiHost,
      anisotropy: this.textures.anisotropy,
      mapDef: map.def,
      tiers: this.tiers,
      perceptionConfig: this.perceptionConfig,
      schedulerConfig: this.schedulerConfig,
      seed: AI_SEED,
    });
    this.match = match;

    const hitboxDebug = new HitboxDebug(match.damage);
    this.hitboxDebug = hitboxDebug;
    this.scene.add(hitboxDebug.group);

    this.harness = new Harness(this.movementConfig);
    this.weaponHarness = new WeaponHarness(this.movementConfig, this.weaponDef, this.viewmodelConfig, this.healthConfig);

    const overlay = new DebugOverlay(debugHost, {
      bus: this.bus,
      loop: this.loop,
      renderer: this.renderer,
      player,
      cameraRig: this.cameraRig,
      collisionDebug,
      audio: this.audio,
      movementConfig: this.movementConfig,
      cameraConfig: this.cameraConfig,
      mapStats: map.stats,
      onConfigChanged: () => this.onConfigChanged(),
    });
    this.overlay = overlay;

    const aiDebug = new AiDebug(match.bots);
    this.aiDebug = aiDebug;
    this.scene.add(aiDebug.group);
    this.aiPanel = new AiPanel(
      overlay,
      match.bots,
      aiDebug,
      this.tiers,
      this.perceptionConfig,
      this.schedulerConfig,
      debugHost,
    );

    this.weaponDebug = new WeaponDebug(
      overlay,
      match,
      this.weaponDef,
      this.viewmodelConfig,
      this.healthConfig,
      hitboxDebug,
      this.audio,
      this.bus,
      () => this.onWeaponConfigChanged(),
    );

    // From M3 these fire for bots too, which is exactly how you hear one coming. The
    // *camera* dip is the one part that is not shared: only the local player's own
    // landing moves the local player's view.
    this.bus.on(EV.PlayerLanded, (p) => {
      if (p.entityId === PLAYER_ENTITY_ID) {
        this.cameraRig.applyLanding(this.cameraConfig, p.impactSpeed);
      }
      this.audio.playLanding(p.x, p.y, p.z, p.impactSpeed, p.material);
    });
    this.bus.on(EV.PlayerFootstep, (p) => {
      this.audio.playFootstep(p.x, p.y, p.z, p.speed, p.heavy, p.material);
    });

    this.transport.open();
    this.loop.start();
    this.exposeDebugApi();
  }

  /**
   * `?harness=botmatch` boots straight into an AFK bot match (S7).
   *
   * The roster is populated *before* entering MATCH so `Match.setActive` sees a non-empty
   * one and skips the default firefight — otherwise seven bots would be built and thrown
   * away on the same frame.
   */
  private startBotHarnessIfRequested(): void {
    const options = parseHarnessOptions(window.location.search);
    if (options === null) return;
    const match = this.match;
    if (match === null) return;

    const overlay = this.overlay;
    if (overlay === null) return;

    const harness = new BotHarness(options, match, this.loop, overlay.stats);
    this.botHarness = harness;
    harness.start();
    this.transitionTo('MATCH');
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
    for (const dummy of this.match?.range.dummies ?? []) {
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

    // Input crosses the netcode boundary even in single player: the sim only ever
    // sees command data, which is what keeps INetworkTransport real (S4.2).
    //
    // A dead player submits neutral commands rather than being skipped: the sim still
    // runs for them, the corpse still collides, and the seam stays honest — which is
    // exactly what a real server would send while waiting on a respawn.
    const now = performance.now();
    const live = this.state === 'MATCH' && this.match?.isPlayerDead !== true;
    const cmd = live ? this.input.sample(tick, now) : this.input.sampleNeutral(tick, now);
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
    this.collisionDebug?.update(player.sim, this.movementConfig);
  }

  private draw(alpha: number): void {
    const player = this.player;
    if (player === null) return;

    const now = performance.now();
    const dt = Math.max(0, (now - this.lastRenderMs) / 1000);
    this.lastRenderMs = now;

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
    this.hitboxDebug?.update();
    this.aiDebug?.update();
    this.aiPanel?.updateLabels(cam, alpha);

    this.renderer.render(this.scene, cam, this.viewmodel);
    this.overlay?.update(dt);
  }

  private onFrame(sample: FrameSample): void {
    this.overlay?.recordFrame(
      sample.frameMs,
      sample.simMs,
      sample.renderMs,
      sample.steps,
      sample.starved,
    );
  }

  // -- events --------------------------------------------------------------

  private onPointerLockChange(locked: boolean): void {
    if (locked) return;
    // Esc released the cursor. Drop back to MENU so re-clicking re-acquires lock
    // without the view jumping (acceptance criterion 1).
    if (this.state === 'MATCH') this.transitionTo('MENU');
  }

  private readonly onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, this.settings.value.renderScale);
    this.cameraRig.resize(this.renderer.aspect);
    this.viewmodel.resize(this.renderer.aspect);
  };

  private readonly onPageHide = (): void => {
    this.settings.flush();
    this.audio.suspend();
  };

  /**
   * Console surface for the acceptance-criteria measurements. Documented in DEBUG.md.
   * Read-only handles plus the headless harness; nothing here mutates gameplay.
   */
  private exposeDebugApi(): void {
    const api = {
      game: this,
      harness: this.harness,
      weaponHarness: this.weaponHarness,
      weaponDebug: () => this.weaponDebug,
      match: () => this.match,
      weapon: () => this.match?.weapons,
      weaponDef: this.weaponDef,
      viewmodelConfig: this.viewmodelConfig,
      speedometer: () => this.overlay?.speedo,
      stats: () => this.overlay?.stats,
      latency: () => this.match?.latency,
      sim: () => this.player?.sim,
      setSyntheticLoad: (ms: number) => {
        this.loop.syntheticLoadMs = ms;
      },
      report: () => this.harness?.report(),
      weaponReport: () => this.weaponHarness?.report(),
      bots: () => this.match?.bots,
      botReport: () => this.match?.bots.report(),
      botHarness: () => this.botHarness,
      harnessReport: () => this.botHarness?.report(),
      tiers: this.tiers,
      perceptionConfig: this.perceptionConfig,
      schedulerConfig: this.schedulerConfig,
    };
    Object.defineProperty(window, '__operator', { value: api, configurable: true });
  }
}

function clampFov(v: number): number {
  return Math.min(FOV_MAX, Math.max(FOV_MIN, v));
}
