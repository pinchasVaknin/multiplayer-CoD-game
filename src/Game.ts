import * as THREE from 'three';
import { EV, createGameBus, type GameBus } from './core/Events';
import { Input } from './core/Input';
import { Btn, isDown, type InputCommand } from './core/InputCommand';
import { Loop, MAX_STEPS_PER_FRAME, type FrameSample } from './core/Loop';
import { SaveStore, type Versioned } from './core/SaveStore';
import { LocalBotTransport, type INetworkTransport } from './core/Transport';
import { CameraRig, type CameraDrive } from './engine/CameraRig';
import { ProceduralAudio } from './engine/ProceduralAudio';
import { ProceduralTextures } from './engine/ProceduralTextures';
import { Renderer } from './engine/Renderer';
import { CollisionDebug } from './debug/CollisionDebug';
import { DebugOverlay } from './debug/DebugOverlay';
import { Harness } from './debug/Harness';
import { isLegalGameTransition, type GameStateId } from './GameStates';
import { DEFAULT_CAMERA_CONFIG, FOV_MAX, FOV_MIN, type CameraConfig } from './player/CameraConfig';
import { DEFAULT_MOVEMENT_CONFIG, cloneMovementConfig, type MovementConfig } from './player/MovementConfig';
import { PlayerController } from './player/PlayerController';
import { ViewmodelLayer } from './player/Viewmodel';
import { Screens } from './ui/Screens';
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

export class Game {
  readonly bus: GameBus = createGameBus();
  readonly movementConfig: MovementConfig = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
  readonly cameraConfig: CameraConfig = { ...DEFAULT_CAMERA_CONFIG };

  private readonly scene = new THREE.Scene();
  private readonly renderer: Renderer;
  private readonly textures: ProceduralTextures;
  private readonly viewmodel: ViewmodelLayer;
  private readonly cameraRig: CameraRig;
  private readonly audio = new ProceduralAudio();
  private readonly screens: Screens;
  private readonly settings: SaveStore<Settings>;
  private readonly transport: INetworkTransport = new LocalBotTransport(64);
  private readonly input: Input;
  private readonly loop: Loop;

  private map: LoadedMap | null = null;
  private player: PlayerController | null = null;
  private collisionDebug: CollisionDebug | null = null;
  private overlay: DebugOverlay | null = null;
  private harness: Harness | null = null;

  private readonly states = new Map<GameStateId, StateHandlers>();
  private state: GameStateId = 'BOOT';

  private readonly drainBuffer: InputCommand[] = [];
  private readonly drive: CameraDrive = { sprint: false, tacSprint: false, slide: false, ads: false };
  private lastRenderMs = performance.now();
  private lastButtons = 0;

  constructor(canvas: HTMLCanvasElement, uiHost: HTMLElement, debugHost: HTMLElement) {
    this.settings = new SaveStore<Settings>('operator.settings', 1, DEFAULT_SETTINGS, (raw, from) => {
      console.warn(`[Game] settings v${from} has no migration path; falling back to defaults.`, raw);
      return null;
    });
    this.cameraConfig.fov = clampFov(this.settings.value.fov);

    this.renderer = new Renderer(canvas);
    this.renderer.setSize(window.innerWidth, window.innerHeight, this.settings.value.renderScale);
    this.textures = new ProceduralTextures(this.renderer.three);
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
        this.screens.setReticleVisible(false);
        this.input.clearHeld();
      },
      exit: () => this.screens.hide(),
    });

    this.states.set('MATCH', {
      enter: () => {
        this.audio.start();
        this.screens.setReticleVisible(true);
        this.input.requestPointerLock();
      },
      exit: () => {
        this.input.exitPointerLock();
        this.screens.setReticleVisible(false);
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

    this.harness = new Harness(this.movementConfig);

    this.overlay = new DebugOverlay(debugHost, {
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

    this.bus.on(EV.PlayerLanded, (p) => {
      this.cameraRig.applyLanding(this.cameraConfig, p.impactSpeed);
      this.audio.playLanding(p.x, p.y, p.z, p.impactSpeed);
    });
    this.bus.on(EV.PlayerFootstep, (p) => {
      this.audio.playFootstep(p.x, p.y, p.z, p.speed, p.heavy);
    });

    this.transport.open();
    this.loop.start();
    this.exposeDebugApi();
  }

  private onConfigChanged(): void {
    this.player?.setConfig(this.movementConfig);
    this.map?.collision.configure(this.movementConfig.maxSlopeDeg, this.movementConfig.collisionSkin);
    this.cameraConfig.fov = clampFov(this.cameraConfig.fov);
    this.settings.patch({ fov: this.cameraConfig.fov });
  }

  // -- loop ----------------------------------------------------------------

  private simulate(tick: number): void {
    const player = this.player;
    if (player === null) return;

    // Input crosses the netcode boundary even in single player: the sim only ever
    // sees command data, which is what keeps INetworkTransport real (S4.2).
    const now = performance.now();
    const cmd = this.state === 'MATCH' ? this.input.sample(tick, now) : this.input.sampleNeutral(tick, now);
    this.transport.submit(cmd);
    const count = this.transport.drain(this.drainBuffer, MAX_STEPS_PER_FRAME);
    for (let i = 0; i < count; i++) {
      const drained = this.drainBuffer[i];
      if (drained === undefined) continue;
      this.lastButtons = drained.buttons;
      player.step(drained);
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
    this.drive.sprint = sim.sprintActive;
    this.drive.tacSprint = sim.tacSprintActive;
    this.drive.slide = sim.slideActive;
    this.drive.ads = isDown(this.lastButtons, Btn.Ads);

    this.cameraRig.update(
      player.prev,
      player.curr,
      alpha,
      this.input.yaw,
      this.input.pitch,
      this.drive,
      this.cameraConfig,
      dt,
      this.viewmodel,
    );

    const cam = this.cameraRig.camera;
    if (this.audio.isRunning) {
      const fx = -Math.sin(this.input.yaw);
      const fz = -Math.cos(this.input.yaw);
      this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, fx, 0, fz, 0, 1, 0);
      this.audio.update();
    }

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
    if (locked) {
      if (this.state === 'MATCH') this.screens.setReticleVisible(true);
      return;
    }
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
      speedometer: () => this.overlay?.speedo,
      stats: () => this.overlay?.stats,
      sim: () => this.player?.sim,
      setSyntheticLoad: (ms: number) => {
        this.loop.syntheticLoadMs = ms;
      },
      report: () => this.harness?.report(),
    };
    Object.defineProperty(window, '__operator', { value: api, configurable: true });
  }
}

function clampFov(v: number): number {
  return Math.min(FOV_MAX, Math.max(FOV_MIN, v));
}
