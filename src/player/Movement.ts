import { DT } from '../core/Loop';
import {
  makeGroundProbe,
  makeMoveOutput,
  type CollisionWorld,
  type MoveOutput,
} from '../world/CollisionWorld';
import type { MovementConfig } from './MovementConfig';
import type { PlayerSim } from './PlayerState';

/**
 * Movement integration: friction, acceleration, and the collision pass.
 *
 * `dt` is the constant from Loop.ts. Nothing in this file reads a frame delta.
 * All scratch state is module-level so the per-tick path allocates nothing (S4.7).
 */

const moveOut = makeMoveOutput();
const stepRise = makeMoveOutput();
const stepForward = makeMoveOutput();
const stepDrop = makeMoveOutput();
const probe = makeGroundProbe();

const DEBUG_CONTACT_CAP = 16;

/**
 * How far the capsule must actually rise before a step-up is worth attempting, metres.
 *
 * An absolute floor rather than a fraction of `stepHeight`: see `integrateMotion`. Small
 * enough that a 5 cm kerb under a low ceiling still steps, large enough that a capsule
 * pinned flush against a wall does not run three extra sweeps every tick to discover it
 * cannot move.
 */
const MIN_STEP_RISE = 0.04;

/**
 * Contact capture for the collision visualiser. Off by default and costing one
 * branch per pass when off; the debug overlay flips `capture` on.
 */
export const movementDebug = {
  capture: false,
  count: 0,
  normals: new Float32Array(DEBUG_CONTACT_CAP * 3),
  points: new Float32Array(DEBUG_CONTACT_CAP * 3),
};

function captureContacts(out: MoveOutput): void {
  for (let i = 0; i < out.contactCount && movementDebug.count < DEBUG_CONTACT_CAP; i++) {
    const src = i * 3;
    const dst = movementDebug.count * 3;
    movementDebug.normals[dst] = out.normals[src] ?? 0;
    movementDebug.normals[dst + 1] = out.normals[src + 1] ?? 0;
    movementDebug.normals[dst + 2] = out.normals[src + 2] ?? 0;
    movementDebug.points[dst] = out.points[src] ?? 0;
    movementDebug.points[dst + 1] = out.points[src + 1] ?? 0;
    movementDebug.points[dst + 2] = out.points[src + 2] ?? 0;
    movementDebug.count++;
  }
}

/**
 * Ground friction, applied to what the player is NOT asking for.
 *
 * The obvious implementation — scale the whole velocity down every tick, then
 * accelerate back toward the target — has a terminal speed of `groundAccel / friction`
 * regardless of the target. With the brief's 60 and 12 that is 5.0 m/s, which silently
 * caps sprint (6.9) and tactical sprint (8.2) and makes the whole speed table in S5.1
 * unreachable. That is a real inconsistency in the brief; see PLAN.md.
 *
 * So friction is decomposed against the commanded direction:
 *
 *   - the component across the command always gets full friction, which is what makes
 *     changing direction crisp rather than skatey;
 *   - the component along the command only loses the *excess* above the target speed,
 *     so a slide-jump's 8 m/s bleeds back to sprint speed at the friction rate while
 *     ordinary running reaches exactly the number in the config;
 *   - with no command at all, everything is "across" and the player stops at the
 *     friction rate, which is the behaviour the constant was chosen for.
 *
 * `wishX/wishZ` must be unit length or zero.
 */
export function applyFriction(
  sim: PlayerSim,
  cfg: MovementConfig,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
): void {
  const speed = Math.hypot(sim.vx, sim.vz);
  if (speed < 1e-5) {
    sim.vx = 0;
    sim.vz = 0;
    return;
  }

  const commanded = (wishX !== 0 || wishZ !== 0) && wishSpeed > 0;
  if (!commanded) {
    sim.vx = bleed(speed, cfg) * (sim.vx / speed);
    sim.vz = bleed(speed, cfg) * (sim.vz / speed);
    return;
  }

  const along = sim.vx * wishX + sim.vz * wishZ;
  let acrossX = sim.vx - wishX * along;
  let acrossZ = sim.vz - wishZ * along;

  const acrossSpeed = Math.hypot(acrossX, acrossZ);
  if (acrossSpeed > 1e-5) {
    const scale = bleed(acrossSpeed, cfg) / acrossSpeed;
    acrossX *= scale;
    acrossZ *= scale;
  } else {
    acrossX = 0;
    acrossZ = 0;
  }

  let forward = along;
  if (forward > wishSpeed) {
    forward = wishSpeed + bleed(forward - wishSpeed, cfg);
  } else if (forward < 0) {
    // Running backwards relative to the command: friction helps the turn.
    forward = -bleed(-forward, cfg);
  }

  sim.vx = wishX * forward + acrossX;
  sim.vz = wishZ * forward + acrossZ;
}

/**
 * One tick of friction on a scalar speed. Below `stopSpeed` the drop goes linear so
 * the player actually reaches zero instead of asymptotically creeping.
 */
function bleed(speed: number, cfg: MovementConfig): number {
  const control = speed < cfg.stopSpeed ? cfg.stopSpeed : speed;
  const next = speed - control * cfg.friction * DT;
  return next <= 0 ? 0 : next;
}

/**
 * Add speed toward `wish` up to `wishSpeed`, never past it.
 *
 * The `addSpeed <= 0` early-out is what bounds the whole movement system: a player
 * already moving at 8 m/s out of a slide gains nothing by holding forward in the air,
 * so momentum is preserved but never compounded (brief S5.2).
 */
export function accelerate(
  sim: PlayerSim,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
): void {
  if (wishSpeed <= 0) return;
  const current = sim.vx * wishX + sim.vz * wishZ;
  const addSpeed = wishSpeed - current;
  if (addSpeed <= 0) return;
  let amount = accel * DT;
  if (amount > addSpeed) amount = addSpeed;
  sim.vx += wishX * amount;
  sim.vz += wishZ * amount;
}

/**
 * Hard-limit horizontal speed.
 *
 * Acceleration alone does not bound speed once a surface is involved: sliding along a
 * wall with the stick held diagonally leaves the along-wish component free to reach
 * the full cap while the velocity actually parallel to the wall is `cap / cos(theta)`.
 * At sprint speed that is a scruffy 7.5 m/s; at tactical sprint it is 9.6, which breaks
 * the bound in S5.2 outright.
 *
 * The limit passed in is `max(speedCap, speedBeforeAccelerating)`, so momentum the
 * player already had — a slide-jump landing at 8 m/s — is left for friction to bleed
 * off, and only *gaining* speed past the cap is forbidden.
 */
export function clampHorizontalSpeed(sim: PlayerSim, limit: number): void {
  const speed = Math.hypot(sim.vx, sim.vz);
  if (speed <= limit || speed < 1e-5) return;
  const scale = limit / speed;
  sim.vx *= scale;
  sim.vz *= scale;
}

/** True when a capsule of `height` fits at this position without intersecting geometry. */
export function capsuleFits(
  world: CollisionWorld,
  cfg: MovementConfig,
  x: number,
  y: number,
  z: number,
  height: number,
): boolean {
  return !world.overlapCapsule(x, y, z, cfg.capsuleRadius, height);
}

/**
 * Move the capsule by its current velocity and resolve collisions.
 *
 * Horizontal and vertical are integrated separately. That decomposition is what makes
 * step-up, ground detection and slope handling tractable: the horizontal pass follows
 * the ground plane, the vertical pass owns gravity and the ceiling, and each knows
 * exactly which contacts it is allowed to interpret as "floor".
 */
export function integrateMotion(sim: PlayerSim, cfg: MovementConfig, world: CollisionWorld): void {
  const r = cfg.capsuleRadius;
  const h = sim.capsuleHeight;

  sim.wasGrounded = sim.grounded;
  sim.steppedUp = false;
  sim.blockedHorizontally = false;
  if (movementDebug.capture) movementDebug.count = 0;

  const startX = sim.x;
  const startY = sim.y;
  const startZ = sim.z;

  // ---- horizontal, projected onto the ground plane -----------------------
  const dx = sim.vx * DT;
  const dz = sim.vz * DT;
  let slopeDy = 0;
  if (sim.grounded && sim.groundNy > 0.2 && sim.vy <= 0) {
    // Follow the surface instead of driving into it: no bumping up ramps, no
    // launching off the top of one, no phantom airtime on the way down.
    slopeDy = -(dx * sim.groundNx + dz * sim.groundNz) / sim.groundNy;
    const limit = Math.hypot(dx, dz) * 1.5;
    if (slopeDy > limit) slopeDy = limit;
    if (slopeDy < -limit) slopeDy = -limit;
  }

  const vxBefore = sim.vx;
  const vzBefore = sim.vz;

  world.moveCapsule(startX, startY, startZ, dx, slopeDy, dz, r, h, moveOut);
  let hx = moveOut.x;
  let hy = moveOut.y;
  let hz = moveOut.z;
  let horizontalContacts: MoveOutput = moveOut;

  const desired = Math.hypot(dx, dz);
  const achieved = Math.hypot(hx - startX, hz - startZ);
  sim.blockedHorizontally = desired > 1e-4 && achieved < desired - 1e-3;

  /**
   * ---- step-up: silent, no vault animation (S5.1) ------------------------
   *
   * The `rise` gate was `> stepHeight * 0.5` and is now an absolute minimum (post-M8). The
   * old test scaled with the config, so raising `stepHeight` to clear taller obstacles also
   * raised the *ceiling* the capsule had to have free above it before a step was attempted —
   * which made the setting fight itself, and under a low soffit or a container lip it refused
   * to step over things it had just been retuned to step over. What actually matters is that
   * the capsule got far enough up to have a chance of clearing the obstacle, and a few
   * centimetres is that.
   */
  if (sim.blockedHorizontally && sim.wasGrounded && cfg.stepHeight > 0) {
    world.moveCapsule(startX, startY, startZ, 0, cfg.stepHeight, 0, r, h, stepRise);
    const rise = stepRise.y - startY;
    if (rise > MIN_STEP_RISE) {
      world.moveCapsule(stepRise.x, stepRise.y, stepRise.z, dx, 0, dz, r, h, stepForward);
      const steppedDistance = Math.hypot(stepForward.x - startX, stepForward.z - startZ);
      if (steppedDistance > achieved + 0.005) {
        world.moveCapsule(stepForward.x, stepForward.y, stepForward.z, 0, -(rise + 0.02), 0, r, h, stepDrop);
        // Only accept if we came back down onto walkable ground no lower than we started.
        if (stepDrop.grounded && stepDrop.y >= startY - 0.02) {
          hx = stepDrop.x;
          hy = stepDrop.y;
          hz = stepDrop.z;
          horizontalContacts = stepForward;
          sim.steppedUp = true;
          sim.blockedHorizontally = false;
          // The blocked move never happened, so the velocity it would have killed
          // is restored before the (much weaker) stepped contacts are projected.
          sim.vx = vxBefore;
          sim.vz = vzBefore;
        }
      }
    }
  }

  sim.x = hx;
  sim.y = hy;
  sim.z = hz;
  projectVelocity(sim, horizontalContacts, false);
  if (movementDebug.capture) captureContacts(horizontalContacts);

  // ---- vertical ----------------------------------------------------------
  const impactSpeed = -sim.vy;
  world.moveCapsule(sim.x, sim.y, sim.z, 0, sim.vy * DT, 0, r, h, moveOut);
  sim.x = moveOut.x;
  sim.y = moveOut.y;
  sim.z = moveOut.z;

  sim.grounded = moveOut.grounded;
  if (moveOut.grounded) {
    sim.groundNx = moveOut.groundNx;
    sim.groundNy = moveOut.groundNy;
    sim.groundNz = moveOut.groundNz;
    sim.groundMaterial = world.colliders.materialAt(moveOut.groundIndex);
  }
  if (moveOut.hitCeiling && sim.vy > 0) sim.vy = 0;
  projectVelocity(sim, moveOut, true);
  if (movementDebug.capture) captureContacts(moveOut);

  // The horizontal pass can also land us (walking up a ramp onto flat ground).
  if (!sim.grounded && sim.steppedUp) {
    sim.grounded = true;
    sim.groundNx = stepDrop.groundNx;
    sim.groundNy = stepDrop.groundNy;
    sim.groundNz = stepDrop.groundNz;
    sim.groundMaterial = world.colliders.materialAt(stepDrop.groundIndex);
  }

  // ---- ground snap: stay glued when walking off a step or down a ramp ----
  if (
    !sim.grounded &&
    sim.wasGrounded &&
    !sim.jumpedThisTick &&
    sim.vy <= 0.01 &&
    cfg.groundSnapDist > 0 &&
    world.probeGround(sim.x, sim.y, sim.z, r, h, cfg.groundSnapDist, probe)
  ) {
    sim.y -= probe.distance;
    sim.grounded = true;
    sim.groundNx = probe.nx;
    sim.groundNy = probe.ny;
    sim.groundNz = probe.nz;
    sim.groundMaterial = world.colliders.materialAt(probe.index);
    if (sim.vy < 0) sim.vy = 0;
  }

  // ---- landing -----------------------------------------------------------
  sim.justLanded = false;
  if (sim.grounded && !sim.wasGrounded) {
    sim.justLanded = true;
    sim.landImpact = impactSpeed > 0 ? impactSpeed : 0;
  }
}

/**
 * Remove the velocity component driving into each contact.
 * `allowVertical` gates whether the vertical component may be cancelled; the
 * horizontal pass must not zero a jump just because it brushed a wall.
 */
function projectVelocity(sim: PlayerSim, out: MoveOutput, allowVertical: boolean): void {
  for (let i = 0; i < out.contactCount; i++) {
    const i3 = i * 3;
    const nx = out.normals[i3] ?? 0;
    const ny = out.normals[i3 + 1] ?? 0;
    const nz = out.normals[i3 + 2] ?? 0;
    const into = sim.vx * nx + sim.vy * ny + sim.vz * nz;
    if (into >= 0) continue;
    sim.vx -= nx * into;
    sim.vz -= nz * into;
    if (allowVertical) sim.vy -= ny * into;
  }
}

/** Initial upward velocity that reaches `jumpHeight` under `gravity`. */
export function jumpVelocity(cfg: MovementConfig): number {
  return Math.sqrt(2 * cfg.gravity * cfg.jumpHeight);
}
