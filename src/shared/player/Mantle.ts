import { clamp01, smoothstep } from '../core/MathUtil';
import { DT } from '../core/Loop';
import type { CollisionWorld } from '../world/CollisionWorld';
import { makeRayHit } from '../world/Geometry';
import { capsuleFits } from './Movement';
import type { MovementConfig } from './MovementConfig';
import type { PlayerSim } from './PlayerState';
import type { StanceId } from './Stance';

/**
 * Ledge detection and the vault itself (brief S5.1: ledges 0.4-1.6 m, 0.4 s vault).
 *
 * Detection is two probes against the gameplay raycaster: one forward to find the
 * wall, one down from above it to find the top. The destination is then validated
 * with a real capsule fit test, which is what makes "mantling into a low ceiling"
 * finish crouched instead of clipping (acceptance criterion 3).
 */

export interface MantleTarget {
  toX: number;
  toY: number;
  toZ: number;
  dirX: number;
  dirZ: number;
  ledgeHeight: number;
  endStance: StanceId;
}

export function makeMantleTarget(): MantleTarget {
  return { toX: 0, toY: 0, toZ: 0, dirX: 0, dirZ: 0, ledgeHeight: 0, endStance: 'STAND' };
}

const wallHit = makeRayHit();
const topHit = makeRayHit();

/** Height above the feet at which the forward probe looks for a wall. */
const WALL_PROBE_HEIGHT = 0.25;
/** How far past the wall the downward probe is placed. */
const TOP_PROBE_OVERSHOOT = 0.3;
/** Clearance above the detected ledge before the downward probe starts. */
const TOP_PROBE_HEADROOM = 0.35;

/**
 * Look for a mantleable ledge in front of the player.
 * Returns true and fills `out` when one is found and the top is actually standable.
 */
export function detectMantle(
  sim: PlayerSim,
  cfg: MovementConfig,
  world: CollisionWorld,
  out: MantleTarget,
): boolean {
  if (sim.mantleCooldown > 0) return false;

  const fx = -Math.sin(sim.yaw);
  const fz = -Math.cos(sim.yaw);

  // 1. Find the wall.
  const reach = cfg.capsuleRadius + cfg.mantleReach;
  if (!world.raycast(sim.x, sim.y + WALL_PROBE_HEIGHT, sim.z, fx, 0, fz, reach, wallHit)) return false;
  // A ledge face is near-vertical. A ramp is not something you mantle.
  if (Math.abs(wallHit.ny) > 0.55) return false;

  const wallDist = wallHit.t;

  // 2. Find the top of it.
  const probeX = sim.x + fx * (wallDist + TOP_PROBE_OVERSHOOT);
  const probeZ = sim.z + fz * (wallDist + TOP_PROBE_OVERSHOOT);
  const probeY = sim.y + cfg.mantleMaxHeight + TOP_PROBE_HEADROOM;
  const probeLength = cfg.mantleMaxHeight + TOP_PROBE_HEADROOM + 0.1;
  if (!world.raycast(probeX, probeY, probeZ, 0, -1, 0, probeLength, topHit)) return false;
  if (topHit.ny < world.groundNormalMin) return false;

  const ledgeY = probeY - topHit.t;
  const ledgeHeight = ledgeY - sim.y;
  if (ledgeHeight < cfg.mantleMinHeight || ledgeHeight > cfg.mantleMaxHeight) return false;

  // 3. Validate the landing spot with the real capsule.
  const toX = sim.x + fx * (wallDist + cfg.capsuleRadius + 0.12);
  const toZ = sim.z + fz * (wallDist + cfg.capsuleRadius + 0.12);
  const toY = ledgeY + 0.02;

  let endStance: StanceId;
  if (capsuleFits(world, cfg, toX, toY, toZ, cfg.standHeight)) {
    endStance = 'STAND';
  } else if (capsuleFits(world, cfg, toX, toY, toZ, cfg.crouchHeight)) {
    endStance = 'CROUCH';
  } else {
    // Nothing fits up there. Refuse rather than push the player into geometry.
    return false;
  }

  out.toX = toX;
  out.toY = toY;
  out.toZ = toZ;
  out.dirX = fx;
  out.dirZ = fz;
  out.ledgeHeight = ledgeHeight;
  out.endStance = endStance;
  return true;
}

export function beginMantle(sim: PlayerSim, target: MantleTarget): void {
  sim.mantleActive = true;
  sim.mantleElapsed = 0;
  sim.mantleFromX = sim.x;
  sim.mantleFromY = sim.y;
  sim.mantleFromZ = sim.z;
  sim.mantleToX = target.toX;
  sim.mantleToY = target.toY;
  sim.mantleToZ = target.toZ;
  sim.mantleDirX = target.dirX;
  sim.mantleDirZ = target.dirZ;
  sim.mantleEndStance = target.endStance;
  sim.stance = 'MANTLE';
  sim.vx = 0;
  sim.vy = 0;
  sim.vz = 0;
  sim.grounded = false;
}

/**
 * Advance a vault by one tick. Returns true on the tick it completes.
 *
 * The two curves overlap deliberately: the body rises first and swings forward as it
 * clears the lip, which is what reads as "pulling yourself up" rather than sliding
 * along a diagonal.
 */
export function stepMantle(sim: PlayerSim, cfg: MovementConfig): boolean {
  sim.mantleElapsed += DT;
  const t = clamp01(sim.mantleElapsed / Math.max(cfg.mantleDuration, 1e-3));

  // The rise finishes just before the swing begins. The small overlap keeps the vault
  // reading as one motion; any more and the capsule spends real time inside the ledge
  // lip, which shows up as overlap ticks in the collision harness.
  const vertical = smoothstep(0, 0.55, t);
  const horizontal = smoothstep(0.5, 1, t);

  sim.y = sim.mantleFromY + (sim.mantleToY - sim.mantleFromY) * vertical;
  sim.x = sim.mantleFromX + (sim.mantleToX - sim.mantleFromX) * horizontal;
  sim.z = sim.mantleFromZ + (sim.mantleToZ - sim.mantleFromZ) * horizontal;
  sim.vx = 0;
  sim.vy = 0;
  sim.vz = 0;

  if (t < 1) return false;

  sim.mantleActive = false;
  sim.stance = sim.mantleEndStance;
  sim.grounded = true;
  sim.groundNx = 0;
  sim.groundNy = 1;
  sim.groundNz = 0;
  sim.vx = sim.mantleDirX * cfg.mantleExitSpeed;
  sim.vz = sim.mantleDirZ * cfg.mantleExitSpeed;
  sim.mantleCooldown = 0.25;
  return true;
}
