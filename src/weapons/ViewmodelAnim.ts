import { angleDelta, clamp, clamp01, damp, DEG2RAD, lerp, smoothstep } from '../core/MathUtil';
import type { ViewmodelConfig } from './ViewmodelConfig';
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
   * A weapon swap is under way (M5, S6.4).
   *
   * `raise` already carries the *timing* of a put-away and a take-out, because `Inventory`
   * drives it. This says which lowered pose to use: a sprint carries the weapon across the
   * body diagonally, a swap drops it straight down and rolls it out of frame. Same value,
   * two keyframed destinations.
   */
  swapping: boolean;

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
    adsFraction: 0,
    reloading: false,
    reloadFraction: 0,
    reloadEmpty: false,
    visualPunch: 0,
    visualLateral: 0,
    tacSprint: false,
    slide: false,
    swapping: false,
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

const CHARGE_PULL = 0.68;
const CHARGE_PEAK = 0.75;
const CHARGE_HOME = 0.81;

export class ViewmodelAnim {
  private swayX = 0;
  private swayY = 0;
  private swayYaw = 0;
  private swayPitch = 0;

  private adsPose = 0;
  private adsRising = false;
  private lastAdsFraction = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private idlePhase = 0;
  private primed = false;

  private model: WeaponModel;

  constructor(model: WeaponModel) {
    this.model = model;
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
    let pz = lerp(cfg.hipZ, cfg.adsZ, ads);
    let rx = lerp(cfg.hipPitch, 0, ads);
    let ry = lerp(cfg.hipYaw, 0, ads);
    let rz = lerp(cfg.hipRoll, 0, ads);

    // `raise` is the sprint-to-fire value. Eased so the gun swings rather than slides,
    // but the timing is untouched: at raise = 1 it is exactly on the base pose.
    const lowered = easeInOutQuad(1 - clamp01(drive.raise));
    if (lowered > 0 && drive.swapping) {
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
