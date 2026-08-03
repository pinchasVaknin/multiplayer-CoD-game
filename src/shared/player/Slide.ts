import { clamp01 } from '../core/MathUtil';
import { DT } from '../core/Loop';
import type { MovementConfig } from './MovementConfig';
import type { PlayerSim } from './PlayerState';

/**
 * Slide, and the slide-cancel rules (brief S5.2, LOCKED).
 *
 *   Jump-cancel               yes, at any point, carrying current slide velocity
 *   Tac-sprint after a slide  locked out for slideTacLockout seconds, any exit route
 *   Slide cooldown            slideCooldown seconds
 *   Entry gate                sprint held for at least slideMinSprintTime
 *
 * Net effect: a slide is a burst above sprint speed, but it cannot be chained, and the
 * maximum *sustained* speed stays bounded by tactical sprint.
 */

export function canStartSlide(sim: PlayerSim, cfg: MovementConfig): boolean {
  if (sim.slideActive || sim.mantleActive) return false;
  if (!sim.grounded) return false;
  if (sim.slideCooldown > 0) return false;
  if (sim.sprintHeldTime < cfg.slideMinSprintTime) return false;
  // Sliding from a standstill would be a free speed boost, so require real momentum.
  return sim.speed >= cfg.sprintSpeed * 0.6;
}

/** Returns the entry speed, for the event payload. */
export function beginSlide(sim: PlayerSim, cfg: MovementConfig, wishX: number, wishZ: number): number {
  const speed = sim.speed;
  let dx = sim.vx;
  let dz = sim.vz;
  if (speed < 1e-3) {
    dx = wishX;
    dz = wishZ;
  }
  const len = Math.hypot(dx, dz) || 1;
  sim.slideDirX = dx / len;
  sim.slideDirZ = dz / len;

  sim.slideActive = true;
  sim.slideElapsed = 0;
  sim.slideAirTime = 0;
  sim.slideSpeed = cfg.slideStartSpeed;
  sim.vx = sim.slideDirX * cfg.slideStartSpeed;
  sim.vz = sim.slideDirZ * cfg.slideStartSpeed;
  sim.stance = 'SLIDE';
  return speed;
}

/** Advance the slide's speed curve and steering. Gravity is applied by the caller. */
export function stepSlide(sim: PlayerSim, cfg: MovementConfig, wishX: number, wishZ: number): void {
  sim.slideElapsed += DT;
  const t = clamp01(sim.slideElapsed / Math.max(cfg.slideDuration, 1e-3));

  // Quadratic bleed: speed is held early and dumped late, which is what makes a
  // slide feel like a committed burst rather than a gentle glide.
  const curve = t * t;
  sim.slideSpeed = cfg.slideStartSpeed + (cfg.slideEndSpeed - cfg.slideStartSpeed) * curve;

  if (wishX !== 0 || wishZ !== 0) {
    const k = clamp01(cfg.slideSteer * 8 * DT);
    let nx = sim.slideDirX + (wishX - sim.slideDirX) * k;
    let nz = sim.slideDirZ + (wishZ - sim.slideDirZ) * k;
    const len = Math.hypot(nx, nz);
    if (len > 1e-4) {
      nx /= len;
      nz /= len;
      sim.slideDirX = nx;
      sim.slideDirZ = nz;
    }
  }

  sim.vx = sim.slideDirX * sim.slideSpeed;
  sim.vz = sim.slideDirZ * sim.slideSpeed;

  if (sim.grounded) sim.slideAirTime = 0;
  else sim.slideAirTime += DT;
}

/**
 * Leave the slide. Applies both LOCKED penalties: the slide cooldown and the tactical
 * sprint lockout. Every exit route goes through here, which is the point — there is no
 * path out of a slide that skips the lockout.
 */
export function endSlide(sim: PlayerSim, cfg: MovementConfig): void {
  if (!sim.slideActive) return;
  sim.slideActive = false;
  sim.slideElapsed = 0;
  sim.slideAirTime = 0;
  sim.slideCooldown = cfg.slideCooldown;
  sim.tacLockout = cfg.slideTacLockout;
  sim.sprintHeldTime = 0;
  if (sim.tacSprintActive) {
    sim.tacSprintActive = false;
    sim.tacSprintElapsed = 0;
    sim.tacSprintCooldown = cfg.tacSprintCooldown;
  }
}
