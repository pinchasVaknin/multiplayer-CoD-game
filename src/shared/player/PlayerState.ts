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

/**
 * The complete mutable state of a `PlayerSim`, as a flat record (M10, S4.11).
 *
 * `PlayerSnapshot` above is the *render* view — eleven fields, enough to draw a frame.
 * This is the *simulation* view: every field `step()` reads or writes, and nothing else.
 * Reconciliation needs the second kind. S4.11 requires the client to *"snap to the
 * authoritative state and replay every unacked command"*, and a replay that restored only
 * the pose would resume with the wrong slide timer, the wrong coyote window and the wrong
 * `prevButtons` — so the first replayed tick would produce a different result than the
 * server got, and the correction would never converge.
 *
 * The rule when adding a field to `PlayerSim`: **add it here too.** A field that is not
 * saved is a field that silently resets on every correction, and the symptom is a movement
 * bug that only appears under packet loss.
 */
export interface PlayerSimState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;

  stance: StanceId;
  grounded: boolean;
  wasGrounded: boolean;
  groundNx: number;
  groundNy: number;
  groundNz: number;
  groundMaterial: number;

  capsuleHeight: number;
  eyeHeight: number;

  sprintActive: boolean;
  sprintHeldTime: number;
  tacSprintActive: boolean;
  tacSprintElapsed: number;
  tacSprintCooldown: number;
  tacLockout: number;
  lastSprintPressTick: number;

  slideActive: boolean;
  slideElapsed: number;
  slideCooldown: number;
  slideDirX: number;
  slideDirZ: number;
  slideSpeed: number;
  slideAirTime: number;

  coyote: number;
  jumpBuffer: number;
  jumpedThisTick: boolean;
  airSpeedCap: number;

  mantleActive: boolean;
  mantleElapsed: number;
  mantleFromX: number;
  mantleFromY: number;
  mantleFromZ: number;
  mantleToX: number;
  mantleToY: number;
  mantleToZ: number;
  mantleDirX: number;
  mantleDirZ: number;
  mantleEndStance: StanceId;
  mantleCooldown: number;

  prevButtons: number;
  tick: number;
  bobPhase: number;
  distanceSinceStep: number;
  landImpact: number;
  justLanded: boolean;
  blockedHorizontally: boolean;
  steppedUp: boolean;
}

export function makePlayerSimState(): PlayerSimState {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    stance: 'STAND',
    grounded: false,
    wasGrounded: false,
    groundNx: 0,
    groundNy: 1,
    groundNz: 0,
    groundMaterial: 0,
    capsuleHeight: 1.8,
    eyeHeight: 1.65,
    sprintActive: false,
    sprintHeldTime: 0,
    tacSprintActive: false,
    tacSprintElapsed: 0,
    tacSprintCooldown: 0,
    tacLockout: 0,
    lastSprintPressTick: -1000,
    slideActive: false,
    slideElapsed: 0,
    slideCooldown: 0,
    slideDirX: 0,
    slideDirZ: 1,
    slideSpeed: 0,
    slideAirTime: 0,
    coyote: 0,
    jumpBuffer: 0,
    jumpedThisTick: false,
    airSpeedCap: 0,
    mantleActive: false,
    mantleElapsed: 0,
    mantleFromX: 0,
    mantleFromY: 0,
    mantleFromZ: 0,
    mantleToX: 0,
    mantleToY: 0,
    mantleToZ: 0,
    mantleDirX: 0,
    mantleDirZ: 0,
    mantleEndStance: 'STAND',
    mantleCooldown: 0,
    prevButtons: 0,
    tick: 0,
    bobPhase: 0,
    distanceSinceStep: 0,
    landImpact: 0,
    justLanded: false,
    blockedHorizontally: false,
    steppedUp: false,
  };
}

/** Read a live sim into a caller-owned record. Allocation free (S4.7). */
export function savePlayerSim(sim: PlayerSim, out: PlayerSimState): void {
  out.x = sim.x;
  out.y = sim.y;
  out.z = sim.z;
  out.vx = sim.vx;
  out.vy = sim.vy;
  out.vz = sim.vz;
  out.yaw = sim.yaw;
  out.pitch = sim.pitch;
  out.stance = sim.stance;
  out.grounded = sim.grounded;
  out.wasGrounded = sim.wasGrounded;
  out.groundNx = sim.groundNx;
  out.groundNy = sim.groundNy;
  out.groundNz = sim.groundNz;
  out.groundMaterial = sim.groundMaterial;
  out.capsuleHeight = sim.capsuleHeight;
  out.eyeHeight = sim.eyeHeight;
  out.sprintActive = sim.sprintActive;
  out.sprintHeldTime = sim.sprintHeldTime;
  out.tacSprintActive = sim.tacSprintActive;
  out.tacSprintElapsed = sim.tacSprintElapsed;
  out.tacSprintCooldown = sim.tacSprintCooldown;
  out.tacLockout = sim.tacLockout;
  out.lastSprintPressTick = sim.lastSprintPressTick;
  out.slideActive = sim.slideActive;
  out.slideElapsed = sim.slideElapsed;
  out.slideCooldown = sim.slideCooldown;
  out.slideDirX = sim.slideDirX;
  out.slideDirZ = sim.slideDirZ;
  out.slideSpeed = sim.slideSpeed;
  out.slideAirTime = sim.slideAirTime;
  out.coyote = sim.coyote;
  out.jumpBuffer = sim.jumpBuffer;
  out.jumpedThisTick = sim.jumpedThisTick;
  out.airSpeedCap = sim.airSpeedCap;
  out.mantleActive = sim.mantleActive;
  out.mantleElapsed = sim.mantleElapsed;
  out.mantleFromX = sim.mantleFromX;
  out.mantleFromY = sim.mantleFromY;
  out.mantleFromZ = sim.mantleFromZ;
  out.mantleToX = sim.mantleToX;
  out.mantleToY = sim.mantleToY;
  out.mantleToZ = sim.mantleToZ;
  out.mantleDirX = sim.mantleDirX;
  out.mantleDirZ = sim.mantleDirZ;
  out.mantleEndStance = sim.mantleEndStance;
  out.mantleCooldown = sim.mantleCooldown;
  out.prevButtons = sim.prevButtons;
  out.tick = sim.tick;
  out.bobPhase = sim.bobPhase;
  out.distanceSinceStep = sim.distanceSinceStep;
  out.landImpact = sim.landImpact;
  out.justLanded = sim.justLanded;
  out.blockedHorizontally = sim.blockedHorizontally;
  out.steppedUp = sim.steppedUp;
}

/**
 * Write a saved record back over a live sim. The other half of a correction.
 *
 * The target is typed as `PlayerSimState` rather than `PlayerSim` on purpose: `PlayerSim`
 * has every field of the record plus its own extras, so it satisfies the interface
 * structurally and no cast is needed — and the same function then copies record-to-record,
 * which is what the prediction ring buffer needs.
 */
export function loadPlayerSim(src: PlayerSimState, sim: PlayerSimState): void {
  sim.x = src.x;
  sim.y = src.y;
  sim.z = src.z;
  sim.vx = src.vx;
  sim.vy = src.vy;
  sim.vz = src.vz;
  sim.yaw = src.yaw;
  sim.pitch = src.pitch;
  sim.stance = src.stance;
  sim.grounded = src.grounded;
  sim.wasGrounded = src.wasGrounded;
  sim.groundNx = src.groundNx;
  sim.groundNy = src.groundNy;
  sim.groundNz = src.groundNz;
  sim.groundMaterial = src.groundMaterial;
  sim.capsuleHeight = src.capsuleHeight;
  sim.eyeHeight = src.eyeHeight;
  sim.sprintActive = src.sprintActive;
  sim.sprintHeldTime = src.sprintHeldTime;
  sim.tacSprintActive = src.tacSprintActive;
  sim.tacSprintElapsed = src.tacSprintElapsed;
  sim.tacSprintCooldown = src.tacSprintCooldown;
  sim.tacLockout = src.tacLockout;
  sim.lastSprintPressTick = src.lastSprintPressTick;
  sim.slideActive = src.slideActive;
  sim.slideElapsed = src.slideElapsed;
  sim.slideCooldown = src.slideCooldown;
  sim.slideDirX = src.slideDirX;
  sim.slideDirZ = src.slideDirZ;
  sim.slideSpeed = src.slideSpeed;
  sim.slideAirTime = src.slideAirTime;
  sim.coyote = src.coyote;
  sim.jumpBuffer = src.jumpBuffer;
  sim.jumpedThisTick = src.jumpedThisTick;
  sim.airSpeedCap = src.airSpeedCap;
  sim.mantleActive = src.mantleActive;
  sim.mantleElapsed = src.mantleElapsed;
  sim.mantleFromX = src.mantleFromX;
  sim.mantleFromY = src.mantleFromY;
  sim.mantleFromZ = src.mantleFromZ;
  sim.mantleToX = src.mantleToX;
  sim.mantleToY = src.mantleToY;
  sim.mantleToZ = src.mantleToZ;
  sim.mantleDirX = src.mantleDirX;
  sim.mantleDirZ = src.mantleDirZ;
  sim.mantleEndStance = src.mantleEndStance;
  sim.mantleCooldown = src.mantleCooldown;
  sim.prevButtons = src.prevButtons;
  sim.tick = src.tick;
  sim.bobPhase = src.bobPhase;
  sim.distanceSinceStep = src.distanceSinceStep;
  sim.landImpact = src.landImpact;
  sim.justLanded = src.justLanded;
  sim.blockedHorizontally = src.blockedHorizontally;
  sim.steppedUp = src.steppedUp;
}

/** Record to record. Same field set, so it is the same copy. */
export function copyPlayerSimState(src: PlayerSimState, dst: PlayerSimState): void {
  loadPlayerSim(src, dst);
}
