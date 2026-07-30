import type * as THREE from 'three';
import type { PerceptionConfig, TierTable } from '../ai/DifficultyTiers';
import type { SchedulerConfig } from '../ai/AiScheduler';
import type { GameBus } from '../core/Events';
import type { CameraRig } from '../engine/CameraRig';
import type { Loop } from '../core/Loop';
import type { ProceduralAudio } from '../engine/ProceduralAudio';
import type { Renderer } from '../engine/Renderer';
import type { Match } from '../Match';
import type { MapEntry } from '../modes/ModeRegistry';
import type { CameraConfig } from '../player/CameraConfig';
import type { HealthConfig } from '../player/Health';
import type { MovementConfig } from '../player/MovementConfig';
import type { PlayerController } from '../player/PlayerController';
import type { ViewmodelConfig } from '../weapons/ViewmodelConfig';
import type { WeaponDef } from '../weapons/WeaponDefs';
import type { LoadedMap } from '../world/MapLoader';
import { AiDebug } from './AiDebug';
import { AiPanel } from './AiPanel';
import { CollisionDebug } from './CollisionDebug';
import { DebugOverlay } from './DebugOverlay';
import type { FrameStats } from './FrameStats';
import { HitboxDebug } from './HitboxDebug';
import type { MatchHarness } from './MatchHarness';
import { ModePanel } from './ModePanel';
import type { Speedometer } from './Speedometer';
import { WeaponDebug } from './WeaponDebug';
import { WeaponHarness } from './WeaponHarness';

/**
 * All of a match's debug tooling, built and destroyed together.
 *
 * Nine objects with the same lifetime — the F1 overlay, four world-space visualisers, three
 * panels and the weapon harness — all of which hold references to the match and the map. From
 * M4 those are per-match, so the tooling is too, and building and tearing it down was ninety
 * lines of `Game.ts` that had nothing to do with the state machine. Bundling it here is what
 * keeps `buildWorld` and `teardownWorld` readable as the mirror images they have to be.
 *
 * `FrameStats` and `Speedometer` are deliberately *not* owned here: they are handed in, because
 * the three-match heap run needs one continuous frame-time history across the boundaries it is
 * measuring, and an overlay that owned it would reset it on every teardown.
 */

/** What the suite needs to build itself. One object, so `Game` hands over one thing. */
export interface DebugSuiteContext {
  readonly host: HTMLElement;
  readonly bus: GameBus;
  readonly loop: Loop;
  readonly renderer: Renderer;
  readonly scene: THREE.Scene;
  readonly audio: ProceduralAudio;
  readonly player: PlayerController;
  readonly cameraRig: CameraRig;
  readonly map: LoadedMap;
  readonly mapEntry: MapEntry;
  readonly match: Match;
  readonly movementConfig: MovementConfig;
  readonly cameraConfig: CameraConfig;
  readonly weaponDef: WeaponDef;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly healthConfig: HealthConfig;
  readonly tiers: TierTable;
  readonly perceptionConfig: PerceptionConfig;
  readonly schedulerConfig: SchedulerConfig;
  readonly stats: FrameStats;
  readonly speedo: Speedometer;
  readonly matchHarness: MatchHarness;
  readonly onConfigChanged: () => void;
  readonly onWeaponConfigChanged: () => void;
}

export class DebugSuite {
  readonly overlay: DebugOverlay;
  readonly collisionDebug: CollisionDebug;
  readonly hitboxDebug: HitboxDebug;
  readonly aiDebug: AiDebug;
  readonly aiPanel: AiPanel;
  readonly modePanel: ModePanel;
  readonly weaponDebug: WeaponDebug;
  readonly weaponHarness: WeaponHarness;

  private readonly scene: THREE.Scene;

  constructor(ctx: DebugSuiteContext) {
    this.scene = ctx.scene;

    this.collisionDebug = new CollisionDebug(ctx.map.collision);
    ctx.scene.add(this.collisionDebug.group);

    this.hitboxDebug = new HitboxDebug(ctx.match.damage);
    ctx.scene.add(this.hitboxDebug.group);

    this.weaponHarness = new WeaponHarness(
      ctx.movementConfig,
      ctx.weaponDef,
      ctx.viewmodelConfig,
      ctx.healthConfig,
    );

    this.overlay = new DebugOverlay(ctx.host, {
      bus: ctx.bus,
      loop: ctx.loop,
      renderer: ctx.renderer,
      player: ctx.player,
      cameraRig: ctx.cameraRig,
      collisionDebug: this.collisionDebug,
      audio: ctx.audio,
      movementConfig: ctx.movementConfig,
      cameraConfig: ctx.cameraConfig,
      mapStats: ctx.map.stats,
      stats: ctx.stats,
      speedo: ctx.speedo,
      onConfigChanged: ctx.onConfigChanged,
    });

    this.aiDebug = new AiDebug(ctx.match.bots);
    ctx.scene.add(this.aiDebug.group);
    this.aiPanel = new AiPanel(
      this.overlay,
      ctx.match.bots,
      this.aiDebug,
      ctx.tiers,
      ctx.perceptionConfig,
      ctx.schedulerConfig,
      ctx.host,
    );

    this.modePanel = new ModePanel(
      this.overlay,
      ctx.match,
      ctx.mapEntry,
      ctx.matchHarness,
      this.aiDebug,
      ctx.bus,
    );

    this.weaponDebug = new WeaponDebug(
      this.overlay,
      ctx.match,
      ctx.weaponDef,
      ctx.viewmodelConfig,
      ctx.healthConfig,
      this.hitboxDebug,
      ctx.audio,
      ctx.bus,
      ctx.onWeaponConfigChanged,
    );
  }

  /** Per-tick: the collision visualisation follows the player. */
  simulate(player: PlayerController, movement: MovementConfig): void {
    this.collisionDebug.update(player.sim, movement);
  }

  /** Per-frame, after the sim. `dt` paces the spawn-score visualisation's rescoring. */
  render(camera: THREE.PerspectiveCamera, alpha: number, dt: number): void {
    this.hitboxDebug.update();
    this.aiDebug.update(dt);
    this.aiPanel.updateLabels(camera, alpha);
  }

  /** Called once per rendered frame, last, so the overlay measures a finished frame. */
  update(dt: number): void {
    this.overlay.update(dt);
  }

  /**
   * The exact mirror of the constructor. Anything added above and not released here shows up as
   * a step in `usedJSHeapSize` at the next match boundary.
   */
  dispose(): void {
    this.weaponDebug.dispose();
    this.modePanel.dispose();
    this.aiPanel.dispose();
    this.scene.remove(this.aiDebug.group);
    this.aiDebug.dispose();
    this.overlay.dispose();
    this.scene.remove(this.hitboxDebug.group);
    this.hitboxDebug.dispose();
    this.scene.remove(this.collisionDebug.group);
    this.collisionDebug.dispose();
  }
}
