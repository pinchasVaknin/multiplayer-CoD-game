import type { StanceId } from './Stance';

/** The renderable slice of player state, sampled once per sim tick and interpolated. */
export interface PlayerSnapshot {
  x: number;
  y: number;
  z: number;
  eyeHeight: number;
  /** Head-bob phase in radians; advanced in the sim so it is frame-rate independent. */
  bobPhase: number;
  /** Horizontal speed, m/s. */
  speed: number;
  vy: number;
  stance: StanceId;
  grounded: boolean;
  /** -1..1 lateral lean authority from slide direction. */
  slideRoll: number;
  /** -1..1 strafe input, drives the small strafe roll. */
  strafe: number;
}

export function makeSnapshot(): PlayerSnapshot {
  return {
    x: 0,
    y: 0,
    z: 0,
    eyeHeight: 1.65,
    bobPhase: 0,
    speed: 0,
    vy: 0,
    stance: 'STAND',
    grounded: false,
    slideRoll: 0,
    strafe: 0,
  };
}

export function copySnapshot(src: PlayerSnapshot, dst: PlayerSnapshot): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.eyeHeight = src.eyeHeight;
  dst.bobPhase = src.bobPhase;
  dst.speed = src.speed;
  dst.vy = src.vy;
  dst.stance = src.stance;
  dst.grounded = src.grounded;
  dst.slideRoll = src.slideRoll;
  dst.strafe = src.strafe;
}

/**
 * Full simulation state for the local player.
 *
 * Everything here is a plain number or flag: the whole struct is snapshot-able, which
 * is what a server-authoritative rewind will need later. No Three.js types.
 */
export class PlayerSim {
  // pose (feet position)
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  yaw = 0;
  pitch = 0;

  stance: StanceId = 'STAND';
  grounded = false;
  wasGrounded = false;
  groundNx = 0;
  groundNy = 1;
  groundNz = 0;
  /**
   * Material index of the surface underfoot. Footsteps, landings and (from M3) bot
   * audibility read this, so the sound the player makes matches what they are standing
   * on rather than being one generic thud.
   */
  groundMaterial = 0;

  /** Collision capsule height for the current stance. Snaps; never smoothed. */
  capsuleHeight = 1.8;
  /** Camera height above the feet. Smoothed toward the stance target. */
  eyeHeight = 1.65;

  // -- sprint / tactical sprint ------------------------------------------
  sprintActive = false;
  sprintHeldTime = 0;
  tacSprintActive = false;
  tacSprintElapsed = 0;
  tacSprintCooldown = 0;
  /** Set to slideTacLockout whenever a slide ends, by any route. */
  tacLockout = 0;
  lastSprintPressTick = -1000;

  // -- slide --------------------------------------------------------------
  slideActive = false;
  slideElapsed = 0;
  slideCooldown = 0;
  slideDirX = 0;
  slideDirZ = 1;
  slideSpeed = 0;
  slideAirTime = 0;

  // -- jump ---------------------------------------------------------------
  coyote = 0;
  jumpBuffer = 0;
  jumpedThisTick = false;
  /**
   * Horizontal speed ceiling while airborne, latched at take-off.
   *
   * Without this, strafing in mid-air adds speed perpendicular to existing momentum
   * and the total grows every jump — the Quake air-strafe. That is not the CoD feel,
   * and it would break the bound in S5.2, so air control may redirect momentum but
   * never increase its magnitude past what left the ground.
   */
  airSpeedCap = 0;

  // -- mantle -------------------------------------------------------------
  mantleActive = false;
  mantleElapsed = 0;
  mantleFromX = 0;
  mantleFromY = 0;
  mantleFromZ = 0;
  mantleToX = 0;
  mantleToY = 0;
  mantleToZ = 0;
  mantleDirX = 0;
  mantleDirZ = 0;
  mantleEndStance: StanceId = 'STAND';
  mantleCooldown = 0;

  // -- bookkeeping --------------------------------------------------------
  prevButtons = 0;
  tick = 0;
  bobPhase = 0;
  distanceSinceStep = 0;
  /** Downward speed captured the tick before a landing was resolved. */
  landImpact = 0;
  /** True for exactly the tick a landing was detected. */
  justLanded = false;
  /** Debug: last horizontal blocked-move flag from the collision pass. */
  blockedHorizontally = false;
  steppedUp = false;

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  reset(x: number, y: number, z: number, yaw: number, standHeight: number, standEye: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.stance = 'STAND';
    this.grounded = false;
    this.wasGrounded = false;
    this.groundNx = 0;
    this.groundNy = 1;
    this.groundNz = 0;
    this.groundMaterial = 0;
    this.capsuleHeight = standHeight;
    this.eyeHeight = standEye;

    this.sprintActive = false;
    this.sprintHeldTime = 0;
    this.tacSprintActive = false;
    this.tacSprintElapsed = 0;
    this.tacSprintCooldown = 0;
    this.tacLockout = 0;
    this.lastSprintPressTick = -1000;

    this.slideActive = false;
    this.slideElapsed = 0;
    this.slideCooldown = 0;
    this.slideDirX = 0;
    this.slideDirZ = 1;
    this.slideSpeed = 0;
    this.slideAirTime = 0;

    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpedThisTick = false;
    this.airSpeedCap = 0;

    this.mantleActive = false;
    this.mantleElapsed = 0;
    this.mantleCooldown = 0;

    this.prevButtons = 0;
    this.bobPhase = 0;
    this.distanceSinceStep = 0;
    this.landImpact = 0;
    this.justLanded = false;
    this.blockedHorizontally = false;
    this.steppedUp = false;
  }

  writeSnapshot(out: PlayerSnapshot, strafe: number): void {
    out.x = this.x;
    out.y = this.y;
    out.z = this.z;
    out.eyeHeight = this.eyeHeight;
    out.bobPhase = this.bobPhase;
    out.speed = this.speed;
    out.vy = this.vy;
    out.stance = this.stance;
    out.grounded = this.grounded;
    out.slideRoll = this.slideActive ? 1 : 0;
    out.strafe = strafe;
  }
}
