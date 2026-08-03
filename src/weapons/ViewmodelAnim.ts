import { angleDelta, clamp, clamp01, damp, DEG2RAD, lerp, smoothstep } from '../core/MathUtil';
import type { ViewmodelConfig } from './ViewmodelConfig';
import type * as THREE from 'three';
import type { WeaponModel } from './WeaponMesh';

/**
 * Procedural viewmodel animation (brief S6.6). No imported animations; eased tweens,
 * never linear.
 *
 * This runs at render rate because none of it is gameplay — it reads the interpolated
 * weapon state and writes transforms. The one thing it is not allowed to do is *decide*
 * anything: `raise` comes from `WeaponBase` and is the same number that gates firing, so
 * the sprint-to-fire animation and the sprint-to-fire rule are the same value read twice.
 *
 * Everything composes additively on top of a base pose, so each channel can be tuned or
 * switched off in the debug panel without disturbing the others.
 */

export interface ViewmodelDrive {
  /** 0 = fully lowered, 1 = ready. The authority for both pose and fireability. */
  raise: number;
  /** 0 = hip, 1 = aimed. Linear in time; the easing happens here. */
  adsFraction: number;

  reloading: boolean;
  reloadFraction: number;
  reloadEmpty: boolean;

  /** Degrees of accumulated visual recoil. Separate from the aim change (S6.2). */
  visualPunch: number;
  visualLateral: number;

  tacSprint: boolean;
  slide: boolean;
  /**
   * A grenade is being cooked or has just been released (M7 playtest).
   *
   * Lowers the weapon off screen for the duration. The throw used to read as the grenade
   * leaving the player's chest, because the rifle stayed up the whole time and the projectile
   * simply appeared beside it. `ThrowController.busy` is the same flag that blocks firing, so
   * what you see and what you can do cannot disagree.
   */
  throwing: boolean;
  /**
   * A weapon swap is under way (M5, S6.4).
   *
   * `raise` already carries the *timing* of a put-away and a take-out, because `Inventory`
   * drives it. This says which lowered pose to use: a sprint carries the weapon across the
   * body diagonally, a swap drops it straight down and rolls it out of frame. Same value,
   * two keyframed destinations.
   */
  swapping: boolean;
  /**
   * 0..1 through a knife swing, or 0 (post-M8).
   *
   * A single arc rather than a phase enum, for the same reason `reloadFraction` is a number:
   * the pose is a continuous function of how far through the animation the sim says it is,
   * so the picture cannot disagree with the state machine about whether the blade is out.
   */
  melee: number;

  /** Head-bob phase from the player sim, so the gun and the camera share a footfall. */
  bobPhase: number;
  /** Horizontal speed, m/s, and the speed that counts as "full bob". */
  speed: number;
  speedRef: number;
  grounded: boolean;

  /** Absolute view angles this frame; sway is derived from how fast they change. */
  yaw: number;
  pitch: number;
}

export function makeViewmodelDrive(): ViewmodelDrive {
  return {
    raise: 1,
    throwing: false,
    adsFraction: 0,
    reloading: false,
    reloadFraction: 0,
    reloadEmpty: false,
    visualPunch: 0,
    visualLateral: 0,
    tacSprint: false,
    slide: false,
    swapping: false,
    melee: 0,
    bobPhase: 0,
    speed: 0,
    speedRef: 6.9,
    grounded: true,
    yaw: 0,
    pitch: 0,
  };
}

/** Keyframe times as a fraction of the reload, matching WeaponBase's tracks. */
const TACTICAL_TIMES = { down: 0.17, magOut: 0.36, magIn: 0.5, magSeated: 0.66, raise: 0.78 };
const EMPTY_TIMES = { down: 0.15, magOut: 0.34, magIn: 0.42, magSeated: 0.58, raise: 0.86 };
/**
 * The sight height `ViewmodelConfig.adsY` was tuned against — the M2 carbine's.
 *
 * Every other weapon's ADS pose is derived from it by the difference in sight height, so
 * retuning `adsY` moves all twelve together and nothing has to be re-authored per weapon.
 */
const REFERENCE_SIGHT_HEIGHT = 0.0915;

/** How fast the weapon drops for a throw and comes back. Brisk: this is not a swap. */
const THROW_LOWER_RATE = 14;

const CHARGE_PULL = 0.68;
const CHARGE_PEAK = 0.75;
const CHARGE_HOME = 0.81;

/**
 * The knife swing: three poses and where they land in the swing (round 2).
 *
 * Post-M8 animated this as an offset on the *rifle's* pose, because there was no knife to
 * animate — the melee was a weapon bash. There is a blade now (`weapons/KnifeMesh.ts`), the
 * rifle is hidden for the duration, and the arc below is the knife's own.
 *
 * The two fractions are not free numbers: `Melee` runs a 0.12 s wind-up and a 0.42 s
 * recovery, so the strike tick lands at 0.12 / 0.54 = **0.222** through the swing, and
 * `STRIKE_AT` is that. Anything else and the blade would be somewhere other than extended on
 * the one frame the hitbox test runs — which is the whole contract between an animation and a
 * hit: what you saw is what was tested.
 *
 * `READY` is the lower right of frame. It is where the swing starts and ends, so the blade
 * enters and leaves rather than appearing, and — because the pose is a pure function of a
 * fraction that returns to zero — a swing cut short by a death or a respawn cannot leave the
 * knife stranded on screen.
 *
 * ## These are absolute poses, and round 2 wrote them as if they were offsets
 *
 * The bash they replaced was an *offset* on the rifle's pose, so its numbers were small
 * displacements around a weapon already sitting at `hipZ = -0.33`. The first knife keyframes
 * kept that scale and lost the base, which put the whole wind-up half of the swing outside the
 * viewmodel frustum: at 65° vertical, `READY` sat 13x the half-width off the right edge and
 * `WINDUP` was at **positive Z — behind the camera**. Only the strike instant was ever
 * rasterised, which is exactly the "barely visible" report.
 *
 * Every pose below is checked against the frustum: the fist stays between 0.24 m and 0.46 m
 * deep, where the frame is 0.28-0.53 m wide either side of centre, so the blade is on screen
 * for the whole 0.54 s and crosses the middle of it at the strike.
 */
const WINDUP_AT = 0.13;
const STRIKE_AT = 0.222;

interface KnifePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Degrees, matching every other pose constant in `ViewmodelConfig`. */
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
}

/** Lower right of frame, blade angled in across the view. Where the swing starts and ends. */
const KNIFE_READY: KnifePose = { x: 0.26, y: -0.17, z: -0.30, pitch: 16, yaw: -34, roll: 46 };
/** Cocked back to the right, edge turned in. The tip leaves frame; the fist does not. */
const KNIFE_WINDUP: KnifePose = { x: 0.26, y: -0.08, z: -0.27, pitch: 4, yaw: -60, roll: 60 };
/**
 * Driven forward through the centre of the screen: the frame the hitbox test runs on.
 *
 * The yaw is what makes it read. At `yaw: 0` the blade points straight down -Z and the player
 * sees it end-on, which is a short bright line and nothing else; at 40° it sweeps across the
 * middle of the view broadside, which is the whole picture of a slash.
 */
const KNIFE_STRIKE: KnifePose = { x: -0.05, y: -0.04, z: -0.46, pitch: -6, yaw: 40, roll: -28 };

export class ViewmodelAnim {
  private swayX = 0;
  private swayY = 0;
  private swayYaw = 0;
  private swayPitch = 0;

  private adsPose = 0;
  /** Damped 0..1 throw lower. See `ViewmodelDrive.throwing`. */
  private throwPose = 0;
  private adsRising = false;
  private lastAdsFraction = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private idlePhase = 0;
  private primed = false;

  private model: WeaponModel;
  /**
   * The knife, if this match built one. Posed by `poseKnife`, never by the weapon path.
   *
   * Held here rather than beside the weapon because the swing is *hand* motion, and the sway
   * and idle drift it borrows are this class's state. `Match` owns whether it is visible; this
   * owns where it is.
   */
  private knife: THREE.Object3D | null = null;

  constructor(model: WeaponModel) {
    this.model = model;
  }

  /** Attach the knife viewmodel. Called once per match; null unsets it. */
  setKnife(knife: THREE.Object3D | null): void {
    this.knife = knife;
  }

  /**
   * Point the animator at a different weapon (M5).
   *
   * A swap changes which mesh is on screen, and every pose this class writes is written
   * into that mesh's transforms — so the animator has to move with it rather than each
   * weapon owning an animator. The pose state itself carries over deliberately: sway and
   * the idle phase belong to the *hands*, and resetting them on a swap would make every
   * weapon arrive perfectly still.
   */
  setModel(model: WeaponModel): void {
    this.model = model;
  }

  /** The sight height of the weapon currently posed, so ADS can cancel it. */
  get sightHeight(): number {
    return this.model.sightHeight;
  }

  reset(yaw: number, pitch: number): void {
    this.swayX = 0;
    this.swayY = 0;
    this.swayYaw = 0;
    this.swayPitch = 0;
    this.adsPose = 0;
    this.throwPose = 0;
    this.adsRising = false;
    this.lastAdsFraction = 0;
    this.idlePhase = 0;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.primed = true;
  }

  /** `dt` is a real frame delta: this is presentation, not simulation. */
  update(drive: ViewmodelDrive, cfg: ViewmodelConfig, dtRaw: number): void {
    const dt = Math.min(Math.max(dtRaw, 0), 1 / 20);
    if (!this.primed) this.reset(drive.yaw, drive.pitch);

    this.updateAdsPose(drive.adsFraction, cfg, dt);
    this.updateSway(drive, cfg, dt);
    this.idlePhase += dt * cfg.idleHz * Math.PI * 2;

    const ads = this.adsPose;
    const aimed = clamp01(drive.adsFraction);

    // ---- base pose: hip -> ADS, then blended toward the lowered pose -------
    let px = lerp(cfg.hipX, 0, ads);
    // `adsY` was tuned against the carbine's sight line. A weapon whose sights sit higher
    // has to be held correspondingly lower for them to land on the screen centre, so the
    // difference is applied here rather than being a second tuned constant per weapon —
    // there is one ADS pose and twelve sight heights, not twelve poses (M5).
    const sightOffset = this.model.sightHeight - REFERENCE_SIGHT_HEIGHT;
    let py = lerp(cfg.hipY, cfg.adsY - sightOffset, ads);
    // `adsOffsetZ` is the weapon's own correction to the shared pose: the sight-height
    // compensation puts the sight line on the camera axis but says nothing about how much
    // of the screen a short weapon's body and hands take. Zero on everything but the pistol.
    let pz = lerp(cfg.hipZ, cfg.adsZ + this.model.adsOffsetZ, ads);
    let rx = lerp(cfg.hipPitch, 0, ads);
    let ry = lerp(cfg.hipYaw, 0, ads);
    let rz = lerp(cfg.hipRoll, 0, ads);

    // A throw lowers the weapon the same way a swap does, through a damped factor so the
    // gun swings down and back rather than snapping. Folded into `raise` rather than handled
    // separately, because `raise` is already the one authority for the lowered pose.
    this.throwPose = damp(this.throwPose, drive.throwing ? 1 : 0, THROW_LOWER_RATE, dt);
    const effectiveRaise = clamp01(drive.raise) * (1 - this.throwPose);

    // `raise` is the sprint-to-fire value. Eased so the gun swings rather than slides,
    // but the timing is untouched: at raise = 1 it is exactly on the base pose.
    const lowered = easeInOutQuad(1 - effectiveRaise);
    if (lowered > 0 && (drive.swapping || this.throwPose > 0.01)) {
      // Put-away / take-out (S6.4): straight down and rolled out of frame, which reads as
      // "this weapon is going away" rather than "this weapon is being carried".
      px = lerp(px, cfg.swapX, lowered);
      py = lerp(py, cfg.swapY, lowered);
      pz = lerp(pz, cfg.swapZ, lowered);
      rx = lerp(rx, cfg.swapPitch, lowered);
      ry = lerp(ry, 0, lowered);
      rz = lerp(rz, cfg.swapRoll, lowered);
    } else if (lowered > 0) {
      let sy = cfg.sprintY;
      let sp = cfg.sprintPitch;
      let sr = cfg.sprintRoll;
      if (drive.tacSprint) {
        sy += cfg.tacSprintExtraY;
        sp += cfg.tacSprintExtraPitch;
      }
      if (drive.slide) {
        sy += cfg.slideExtraY;
        sr += cfg.slideExtraRoll;
      }
      px = lerp(px, cfg.sprintX, lowered);
      py = lerp(py, sy, lowered);
      pz = lerp(pz, cfg.sprintZ, lowered);
      rx = lerp(rx, sp, lowered);
      ry = lerp(ry, cfg.sprintYaw, lowered);
      rz = lerp(rz, sr, lowered);
    }

    // ---- reload ------------------------------------------------------------
    if (drive.reloading) {
      const times = drive.reloadEmpty ? EMPTY_TIMES : TACTICAL_TIMES;
      const f = clamp01(drive.reloadFraction);
      const down = smoothstep(0, times.down, f) * (1 - smoothstep(times.raise, 1, f));
      px += cfg.hipX * 0.12 * down;
      py += cfg.reloadDropY * down;
      pz += cfg.reloadDropZ * down;
      rx += cfg.reloadPitch * down;
      ry += cfg.reloadYaw * down;
      rz += cfg.reloadRoll * down;
      this.poseMagazine(f, times, cfg);
      this.poseChargingHandle(drive.reloadEmpty ? f : -1, cfg);
    } else {
      this.model.magazine.position.set(0, 0, 0);
      this.model.magazine.rotation.set(0, 0, 0);
      this.model.chargingHandle.position.set(0, 0, 0);
    }

    // ---- bob ----------------------------------------------------------------
    const bobScale = lerp(1, cfg.bobAdsScale, aimed);
    const speedRatio = drive.grounded ? clamp01(drive.speed / Math.max(drive.speedRef, 0.1)) : 0;
    const bobUp = Math.sin(drive.bobPhase * 2) * cfg.bobAmount * speedRatio * bobScale;
    const bobSide = Math.sin(drive.bobPhase) * cfg.bobLateral * speedRatio * bobScale;
    const bobRoll = Math.sin(drive.bobPhase) * cfg.bobRoll * speedRatio * bobScale;
    px += bobSide;
    py += bobUp;
    rz += bobRoll;

    // ---- idle drift: the gun is never perfectly still --------------------
    const idle = cfg.idleAmplitude * lerp(1, 0.25, aimed);
    px += Math.sin(this.idlePhase) * idle;
    py += Math.sin(this.idlePhase * 1.7) * idle * 0.6;

    // ---- sway ---------------------------------------------------------------
    px += this.swayX;
    py += this.swayY;
    ry += this.swayYaw;
    rx += this.swayPitch;

    // ---- recoil kick --------------------------------------------------------
    const punch = drive.visualPunch;
    const lateral = drive.visualLateral;
    pz += punch * cfg.kickBack;
    py += punch * cfg.kickUp;
    px += lateral * cfg.kickLateral;
    rx += punch * cfg.kickPitch;
    rz += -lateral * cfg.kickRoll;

    const root = this.model.root;
    root.position.set(px, py, pz);
    root.rotation.set(rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD);

    this.poseKnife(drive, cfg);
  }

  /**
   * The knife's own arc (round 2). Three keyframes, blended by where the swing is.
   *
   * Deliberately *not* an offset on the weapon pose the way the M8 bash was: the rifle is
   * hidden while this runs, so there is nothing to offset from, and a knife held in the other
   * hand does not inherit the rifle's ADS, reload or sprint poses.
   *
   * It does inherit the bob, the sway and the idle drift, because those belong to the player
   * rather than to whatever they are holding — a blade that stayed perfectly still while the
   * world bobbed around it would read as a decal on the screen. `drive.melee` is
   * `Melee.fraction`, which is 0 whenever the state machine is idle, so a swing interrupted by
   * a death simply stops being drawn.
   */
  private poseKnife(drive: ViewmodelDrive, cfg: ViewmodelConfig): void {
    const knife = this.knife;
    if (knife === null) return;
    /**
     * No early-out at `t === 0`, and that is a fix rather than an oversight (round 3).
     *
     * `Melee.fraction` is exactly 0 on the first tick of a wind-up — the timer has not been
     * decremented yet — while `Melee.busy`, which is what `Match` shows the mesh on, is
     * already true. Skipping the pose on that tick left the knife on whatever transform it
     * last had, and on the first swing of a match that is the identity: the blade rendered
     * for one frame at the origin, which in viewmodel space is *inside the camera*. The
     * blend below reduces to exactly `KNIFE_READY` at 0, so posing unconditionally is both
     * correct and simpler than a special case.
     */
    const t = clamp01(drive.melee);

    let from: KnifePose;
    let to: KnifePose;
    let k: number;
    if (t < WINDUP_AT) {
      from = KNIFE_READY;
      to = KNIFE_WINDUP;
      k = smoothstep(0, WINDUP_AT, t);
    } else if (t < STRIKE_AT) {
      from = KNIFE_WINDUP;
      to = KNIFE_STRIKE;
      // Deliberately not smoothed on the way in: a slash accelerates into the target and the
      // 0.05 s between these two poses is the only part of the animation the player reads.
      k = (t - WINDUP_AT) / (STRIKE_AT - WINDUP_AT);
    } else {
      from = KNIFE_STRIKE;
      to = KNIFE_READY;
      k = smoothstep(STRIKE_AT, 1, t);
    }

    const speedRatio = drive.grounded ? clamp01(drive.speed / Math.max(drive.speedRef, 0.1)) : 0;
    const bobUp = Math.sin(drive.bobPhase * 2) * cfg.bobAmount * speedRatio;
    const bobSide = Math.sin(drive.bobPhase) * cfg.bobLateral * speedRatio;
    const idle = cfg.idleAmplitude;

    knife.position.set(
      lerp(from.x, to.x, k) + this.swayX + bobSide + Math.sin(this.idlePhase) * idle,
      lerp(from.y, to.y, k) + this.swayY + bobUp + Math.sin(this.idlePhase * 1.7) * idle * 0.6,
      lerp(from.z, to.z, k),
    );
    knife.rotation.set(
      (lerp(from.pitch, to.pitch, k) + this.swayPitch) * DEG2RAD,
      (lerp(from.yaw, to.yaw, k) + this.swayYaw) * DEG2RAD,
      lerp(from.roll, to.roll, k) * DEG2RAD,
    );
  }

  // -- channels -------------------------------------------------------------

  /**
   * ADS easing: a slight overshoot on the way in, none on the way out (S6.6).
   *
   * The overshoot is applied to the *pose* only. `adsFraction` stays linear because it
   * also drives FOV, spread and recoil scaling, and a sight picture that overshot its
   * accuracy would be a lie.
   *
   * The curve is a pure function of `adsFraction`, which is linear in time — so the shape
   * is identical at any frame rate and there is no spring to detune or to blow up on a
   * long frame. The one piece of state is a fast follower, and it exists only to absorb
   * the discontinuity when a player releases the button halfway in and the curve swaps
   * from the overshooting one to the plain one.
   */
  private updateAdsPose(fraction: number, cfg: ViewmodelConfig, dt: number): void {
    const rising = fraction > this.lastAdsFraction + 1e-6;
    const falling = fraction < this.lastAdsFraction - 1e-6;
    if (rising) this.adsRising = true;
    else if (falling) this.adsRising = false;
    this.lastAdsFraction = fraction;

    const t = clamp01(fraction);
    const target = this.adsRising ? easeOutBack(t, cfg.adsOvershoot) : easeInOutQuad(t);
    this.adsPose = damp(this.adsPose, target, 40, dt);
    this.adsPose = clamp(this.adsPose, 0, 1 + cfg.adsOvershoot);
  }

  private updateSway(drive: ViewmodelDrive, cfg: ViewmodelConfig, dt: number): void {
    const inv = dt > 1e-5 ? 1 / dt : 0;
    const dYaw = angleDelta(this.lastYaw, drive.yaw) * inv;
    const dPitch = (drive.pitch - this.lastPitch) * inv;
    this.lastYaw = drive.yaw;
    this.lastPitch = drive.pitch;

    const scale = lerp(1, cfg.swayAdsScale, clamp01(drive.adsFraction));
    const cap = cfg.swayMax;
    const targetX = clamp(dYaw * cfg.swayPosition * scale, -cap, cap);
    const targetY = clamp(-dPitch * cfg.swayPosition * scale, -cap, cap);
    const rotCap = cfg.swayRotation * 4;
    const targetYaw = clamp(-dYaw * cfg.swayRotation * scale, -rotCap, rotCap);
    const targetPitch = clamp(dPitch * cfg.swayRotation * scale, -rotCap, rotCap);

    this.swayX = damp(this.swayX, targetX, cfg.swayRate, dt);
    this.swayY = damp(this.swayY, targetY, cfg.swayRate, dt);
    this.swayYaw = damp(this.swayYaw, targetYaw, cfg.swayRate, dt);
    this.swayPitch = damp(this.swayPitch, targetPitch, cfg.swayRate, dt);
  }

  private poseMagazine(
    f: number,
    times: { magOut: number; magIn: number; magSeated: number; down: number },
    cfg: ViewmodelConfig,
  ): void {
    let drop = 0;
    let tilt = 0;
    if (f < times.down) {
      drop = 0;
    } else if (f < times.magOut) {
      // Out of the well and falling away, tipping as it goes.
      const t = smoothstep(times.down, times.magOut, f);
      drop = t;
      tilt = t * 0.55;
    } else if (f < times.magIn) {
      drop = 1;
      tilt = 0.55;
    } else if (f < times.magSeated) {
      // A fresh magazine comes up from below and seats.
      const t = smoothstep(times.magIn, times.magSeated, f);
      drop = 1 - easeOutCubic(t);
      tilt = (1 - t) * 0.35;
    }
    this.model.magazine.position.set(0, -drop * cfg.magThrow, 0);
    this.model.magazine.rotation.set(tilt, 0, tilt * 0.4);
  }

  /** `f` below zero means "not an empty reload"; the handle stays home. */
  private poseChargingHandle(f: number, cfg: ViewmodelConfig): void {
    let pull = 0;
    if (f >= CHARGE_PULL && f < CHARGE_PEAK) {
      pull = smoothstep(CHARGE_PULL, CHARGE_PEAK, f);
    } else if (f >= CHARGE_PEAK && f < CHARGE_HOME) {
      // Released, not eased back: a charging handle snaps.
      pull = 1 - smoothstep(CHARGE_PEAK, CHARGE_HOME, f) ** 0.5;
    }
    this.model.chargingHandle.position.set(0, 0, pull * cfg.chargeThrow);
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Overshooting ease. Zero at t=0, exactly 1 at t=1, peaking a little above 1 around
 * three-quarters of the way in — `overshoot` is roughly how far above.
 */
function easeOutBack(t: number, overshoot: number): number {
  const c1 = Math.max(0, overshoot) * 10;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}
