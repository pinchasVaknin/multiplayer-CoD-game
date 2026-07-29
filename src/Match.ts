import * as THREE from 'three';
import { DamageSystem, makeDamageRequest, PLAYER_ENTITY_ID, type Damageable, type DamageRequest } from './combat/DamageSystem';
import { HitboxRig, HUMANOID_RIG, type HitZone } from './combat/HitboxRig';
import { TargetRange } from './combat/TargetRange';
import { EV, type GameBus } from './core/Events';
import type { Input } from './core/Input';
import type { InputCommand } from './core/InputCommand';
import { DEG2RAD } from './core/MathUtil';
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
}

/** The local player as a damage target: same rig M3's bots will carry. */
class PlayerTarget implements Damageable {
  readonly entityId = PLAYER_ENTITY_ID;
  readonly displayName = 'OPERATOR';
  readonly rig = new HitboxRig(HUMANOID_RIG);

  constructor(readonly health: Health) {}
}

interface PendingNumber {
  x: number;
  y: number;
  z: number;
  amount: number;
  zone: HitZone;
}

const NUMBER_QUEUE = 8;

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
  readonly playerTarget: PlayerTarget;

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

  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;
  private shotSinceRender = false;
  private active = false;

  constructor(deps: MatchDeps) {
    this.deps = deps;

    this.damage = new DamageSystem(deps.bus);
    this.playerHealth = new Health(deps.healthConfig);
    this.playerTarget = new PlayerTarget(this.playerHealth);
    this.damage.register(this.playerTarget);
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
    if (on) this.anim.reset(this.deps.input.yaw, this.deps.input.pitch);
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
    const sim = this.deps.player.sim;

    this.playerHealth.step();
    // The player's own rig follows the capsule so M3 can shoot back without new plumbing.
    this.playerTarget.rig.setTransform(sim.x, sim.y, sim.z, sim.yaw);

    this.weapons.step(cmd, sim);

    // The residual half of each recoil kick is a real aim change, so it goes where mouse
    // movement goes rather than into a separate offset the player cannot fight.
    if (this.weapons.takeViewResidual(this.residual)) {
      this.deps.input.addViewOffset(this.residual.yaw, this.residual.pitch);
    }

    this.range.step();
    this.latency.expire(performance.now());
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
    this.fx.update(dt);

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
    this.hud.update(state, dt);

    this.flushDamageNumbers(camera);

    if (this.shotSinceRender) {
      this.shotSinceRender = false;
      this.latency.notePresented(performance.now());
    }
  }

  dispose(): void {
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
      this.fx.fireMuzzleFlash(p.x, p.y, p.z, def.muzzleFlashScale);
      if (p.tracer) this.fx.spawnTracer(p.x, p.y, p.z, p.endX, p.endY, p.endZ);
      this.weaponAudio.playGunshot(p.x, p.y, p.z, def.voice);
      cameraRig.shake.add(def.shakePerShot);
      this.latency.armFromPress(input.takeFirePress());
      this.shotSinceRender = true;
    });

    bus.on(EV.BulletImpact, (p) => {
      this.fx.spawnImpact(p.x, p.y, p.z, p.nx, p.ny, p.nz, p.material, p.penetrated);
      this.weaponAudio.playImpact(p.x, p.y, p.z, p.material, p.penetrated);
    });

    bus.on(EV.DamageDealt, (p) => {
      if (p.sourceId !== PLAYER_ENTITY_ID || p.targetId === PLAYER_ENTITY_ID) return;
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

    bus.on(EV.WeaponDryFired, () => {
      const sim = this.deps.player.sim;
      this.weaponAudio.playDryFire(sim.x, sim.y + sim.eyeHeight, sim.z);
    });

    bus.on(EV.WeaponReloadStep, (p) => {
      const sim = this.deps.player.sim;
      this.weaponAudio.playReloadStep(sim.x, sim.y + sim.eyeHeight, sim.z, p.step);
    });

    bus.on(EV.WeaponAdsChanged, (p) => {
      const sim = this.deps.player.sim;
      this.weaponAudio.playAdsRustle(sim.x, sim.y + sim.eyeHeight, sim.z, p.aiming);
    });
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
