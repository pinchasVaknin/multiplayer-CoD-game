import * as THREE from 'three';
import { damp, DEG2RAD, lerp } from '../core/MathUtil';
import type { CameraConfig } from '../player/CameraConfig';
import { CameraShake } from '../player/CameraShake';
import type { PlayerSnapshot } from '../player/PlayerState';
import type { ViewmodelLayer } from '../player/Viewmodel';

/**
 * Turns an interpolated player snapshot into a camera transform.
 *
 * Position and eye height are interpolated between the previous and current sim state
 * with `alpha`. View angles are NOT interpolated — they come straight from the input
 * layer at render rate, which is the one exception in S4.1 and the reason looking
 * around has zero added latency.
 *
 * Everything additive (bob, landing dip, shake, roll) is layered on top so each can be
 * tuned, or switched off, without touching the others.
 */

export interface CameraDrive {
  sprint: boolean;
  tacSprint: boolean;
  slide: boolean;
  /**
   * 0..1 from the weapon's ADS animation, not a boolean from the mouse button. The FOV
   * has to travel with the sights; snapping it on the press and letting the viewmodel
   * catch up is the single most common way an ADS transition ends up feeling cheap.
   */
  adsFraction: number;
  /** World FOV multiplier at full ADS, from the equipped weapon. */
  adsFovScale: number;
  /** Viewmodel FOV multiplier at full ADS, from the equipped weapon. */
  adsViewmodelFovScale: number;
}

/** Visual state, kept out of the sim: none of this affects gameplay. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly shake = new CameraShake();

  /** Current FOV after smoothing. Surfaced by the debug overlay. */
  fov: number;

  private dipPos = 0;
  private dipVel = 0;
  private roll = 0;
  private readonly right = new THREE.Vector3();

  constructor(cfg: CameraConfig, aspect: number) {
    this.fov = cfg.fov;
    /**
     * Near 0.12 m, raised from 0.05 (round 2). Depth precision, not framing.
     *
     * A perspective depth buffer resolves about `z² · (far − near) / (near · far · (2^bits − 1))`
     * metres at distance `z`, so the *near* plane is the whole term: at 0.05 m it made this
     * an 8000:1 depth range, and on a driver that hands back a 16-bit buffer — which is
     * allowed, and more likely with `stencil: false`, see `Renderer` — that is 3 cm of
     * resolution at 10 m. Every decorative trim in every map sits 1-2 cm proud of the surface
     * it marks. That is the "structures jitter and shake" report: not one bad brush, a depth
     * buffer too coarse to separate a lip from its wall.
     *
     * 0.12 m is 2.4x the precision everywhere for nothing, and it costs no visible framing:
     * the capsule radius is 0.35 m, so the eye can never be within 12 cm of a wall face, and
     * the gun is drawn by the viewmodel pass with its own 0.008 near plane.
     */
    this.camera = new THREE.PerspectiveCamera(cfg.fov, aspect, 0.12, 400);
    this.camera.rotation.order = 'YXZ';
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Called from the landing event. `impactSpeed` is downward m/s at contact. */
  applyLanding(cfg: CameraConfig, impactSpeed: number): void {
    const strength = Math.min(1, impactSpeed / Math.max(cfg.landDipRefSpeed, 0.1));
    if (strength <= 0.02) return;
    this.dipVel -= strength * cfg.landDipMax * cfg.landDipSpring * 0.06;
    // A hard landing also earns a little shake; a step off a kerb does not.
    if (strength > 0.35) this.shake.add((strength - 0.35) * 0.55);
  }

  reset(cfg: CameraConfig): void {
    this.dipPos = 0;
    this.dipVel = 0;
    this.roll = 0;
    this.fov = cfg.fov;
    this.shake.reset();
  }

  update(
    prev: PlayerSnapshot,
    curr: PlayerSnapshot,
    alpha: number,
    yaw: number,
    pitch: number,
    drive: CameraDrive,
    cfg: CameraConfig,
    dtRaw: number,
    viewmodel: ViewmodelLayer | null,
  ): void {
    // Visual springs run at render rate; clamp so a stalled frame cannot explode them.
    const dt = Math.min(dtRaw, 1 / 30);

    const px = lerp(prev.x, curr.x, alpha);
    const py = lerp(prev.y, curr.y, alpha);
    const pz = lerp(prev.z, curr.z, alpha);
    const eye = lerp(prev.eyeHeight, curr.eyeHeight, alpha);
    const speed = lerp(prev.speed, curr.speed, alpha);
    const phase = interpolatePhase(prev.bobPhase, curr.bobPhase, alpha);

    // ---- FOV ------------------------------------------------------------
    let targetFov = cfg.fov;
    if (drive.tacSprint) targetFov += cfg.fovTacSprintAdd;
    else if (drive.sprint) targetFov += cfg.fovSprintAdd;
    if (drive.slide) targetFov += cfg.fovSlideAdd;
    const ads = drive.adsFraction < 0 ? 0 : drive.adsFraction > 1 ? 1 : drive.adsFraction;
    targetFov *= lerp(1, drive.adsFovScale, ads);
    this.fov = damp(this.fov, targetFov, cfg.fovRate, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    // Pulling the viewmodel FOV in with the world FOV is what makes the sights appear to
    // grow rather than the whole gun sliding toward the camera.
    viewmodel?.setFov(cfg.viewmodelFov * lerp(1, drive.adsViewmodelFovScale, ads));

    // ---- bob -------------------------------------------------------------
    const speedRatio = Math.min(1, speed / Math.max(cfg.bobRefSpeed, 0.1));
    const grounded = curr.grounded && curr.stance !== 'MANTLE';
    const bobAmount = grounded ? cfg.bobAmplitude * speedRatio : 0;
    // Two vertical dips per stride, one lateral sway: the classic footfall shape.
    const bobUp = Math.sin(phase * 2) * bobAmount;
    const bobSide = Math.sin(phase) * bobAmount * cfg.bobLateralScale;
    const bobRoll = Math.sin(phase) * cfg.bobRollDeg * DEG2RAD * speedRatio;

    // ---- landing dip (critically damped spring) --------------------------
    this.dipVel += (-this.dipPos * cfg.landDipSpring - this.dipVel * cfg.landDipDamping) * dt;
    this.dipPos += this.dipVel * dt;
    if (this.dipPos < -cfg.landDipMax) {
      this.dipPos = -cfg.landDipMax;
      if (this.dipVel < 0) this.dipVel = 0;
    }

    // ---- roll ------------------------------------------------------------
    const strafe = lerp(prev.strafe, curr.strafe, alpha);
    const rollDeg = drive.slide ? cfg.slideRollDeg : cfg.strafeRollDeg;
    const rollTarget = -strafe * rollDeg * DEG2RAD + bobRoll;
    this.roll = damp(this.roll, rollTarget, cfg.rollRate, dt);

    // ---- shake -----------------------------------------------------------
    this.shake.update(cfg, dt);

    // ---- compose ----------------------------------------------------------
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this.camera.position.set(
      px + this.right.x * bobSide,
      py + eye + bobUp + this.dipPos,
      pz + this.right.z * bobSide,
    );
    this.camera.rotation.set(pitch + this.shake.pitch, yaw + this.shake.yaw, this.roll + this.shake.roll);

    if (viewmodel !== null) {
      viewmodel.camera.position.copy(this.camera.position);
      viewmodel.camera.rotation.copy(this.camera.rotation);
    }
  }
}

/** Bob phase wraps at TAU; interpolate the short way around. */
function interpolatePhase(a: number, b: number, alpha: number): number {
  const TAU = Math.PI * 2;
  let delta = b - a;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return a + delta * alpha;
}
