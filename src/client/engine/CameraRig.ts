import * as THREE from 'three';
import { clamp, damp, DEG2RAD, lerp } from '../../shared/core/MathUtil';
import type { CameraConfig } from '../player/CameraConfig';
import { CameraShake } from '../player/CameraShake';
import { SKY_LAYER } from './Renderer';
import type { PlayerSnapshot } from '../../shared/player/PlayerState';
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

/**
 * Taken off the capsule radius before it is used as eye-to-wall clearance (round 4).
 *
 * The eye does not sit exactly on the capsule axis: `bobLateralScale` swings it sideways by
 * `bobAmplitude * bobLateralScale` — 21 mm at the shipped values — and the collision skin lets
 * the capsule rest 5 mm inside a surface. 50 mm covers both with room for a heavier bob than
 * anyone would tune, and it is subtracted rather than measured because `resize` has no
 * `CameraConfig` to read and a near plane that changed with the bob phase would be worse than
 * one that is slightly conservative.
 */
const CLEARANCE_ALLOWANCE = 0.05;
/** How much of the geometric limit to actually use. The rest is margin. */
const NEAR_SAFETY = 0.8;
const NEAR_MIN = 0.01;
/**
 * Ceiling on the derived near plane.
 *
 * 0.12 is the value round 2 shipped and round 4 was asked to return to, and at the default
 * 90° / 16:9 the derivation lands on it anyway. Keeping it as a cap rather than a constant is
 * what stops a narrow FOV from pushing the plane out far enough to clip something else.
 */
const NEAR_MAX = 0.12;

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

  /** Metres of wall the eye is guaranteed to be behind. See `nearFor`. */
  private readonly clearance: number;

  constructor(cfg: CameraConfig, aspect: number, capsuleRadius: number) {
    this.fov = cfg.fov;
    this.clearance = Math.max(0.05, capsuleRadius - CLEARANCE_ALLOWANCE);
    this.camera = new THREE.PerspectiveCamera(cfg.fov, aspect, 0.12, 400);
    this.camera.near = this.nearFor(cfg.fov, aspect);
    this.camera.rotation.order = 'YXZ';
    /**
     * The one camera that sees the sky (round 5, F2).
     *
     * `SkyDome` sits on its own layer, and a camera's default mask is layer 0 alone. This is
     * the enable; the *absence* of it everywhere else is what keeps a dome pinned to the far
     * plane out of the Chopper Gunner's three-pass thermal draw, where an override material
     * would render it as a grey wall over the whole optic, and out of every shadow camera,
     * where it would be a caster the size of the world.
     */
    this.camera.layers.enable(SKY_LAYER);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    // The horizontal field of view is a function of the aspect, and the near plane is a
    // function of that — a window dragged wider must move it. See `nearFor`.
    this.camera.near = this.nearFor(this.camera.fov, aspect);
    this.camera.updateProjectionMatrix();
  }

  /**
   * The largest near plane that cannot clip a wall the player is standing against (round 4).
   *
   * Round 3 raised this to a constant 0.20 m for depth precision and put a grey wedge through
   * the geometry at the edge of the screen. The mistake was geometric: the capsule radius
   * bounds how close the eye gets to a wall **along the wall's normal**, and the near plane
   * clips on **view-space depth**. A point on that wall out at the corner of the screen is at
   * `clearance · cos(halfHorizontalFov)`, which is a lot less than `clearance`:
   *
   * ```
   *                                        hFOV    min view depth
   *   90 FOV, 16:9 (the default)           121°       0.159 m      <- 0.20 clipped
   *   90 + tac sprint + slide              140°       0.111 m      <- 0.12 clips too
   *   FOV 120, 16:9                        144°       0.100 m
   *   FOV 120 + adds, 21:9                 164°       0.045 m
   * ```
   *
   * So reverting to 0.12 fixes the screenshot and leaves the same bug latent for anyone who
   * slides, tac-sprints or plays at a wide FOV — which is not a fix, it is the same fix that
   * has come back twice. The number is derived instead, from the two things that actually
   * decide it, and recomputed wherever either changes. At the shipped defaults it evaluates to
   * the 0.12 the report asked for; it only ever goes *down* from there, and 24-bit depth has
   * the headroom to spare (0.6 mm at 10 m even at the 0.01 floor).
   */
  private nearFor(fovDeg: number, aspect: number): number {
    const halfHorizontal = Math.atan(Math.tan(fovDeg * 0.5 * DEG2RAD) * Math.max(aspect, 0.1));
    const limit = this.clearance * Math.cos(halfHorizontal);
    return clamp(limit * NEAR_SAFETY, NEAR_MIN, NEAR_MAX);
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
      // Sprinting and sliding widen the lens by up to 24°, which pulls the corner of the
      // screen closer to the wall beside you. The near plane follows it — see `nearFor`.
      this.camera.near = this.nearFor(this.fov, this.camera.aspect);
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
