import { DT } from '../core/Loop';
import { angleDelta, clamp, damp, DEG2RAD, RAD2DEG, TAU } from '../core/MathUtil';
import type { Rng } from '../core/Rng';
import type { BotBlackboard } from './BotBlackboard';
import type { TierConfig } from './DifficultyTiers';
import type { WeaponCombatProfile } from './WeaponProfile';
import { simCos, simSin } from '../core/SimMath';

/**
 * How a bot aims and when it pulls the trigger (brief S6.4).
 *
 * The rule S6.4 exists to enforce is that **bots must never be pixel-perfect**, and the
 * way this file gets there is by never letting the bot aim at the target at all. It aims
 * at an error point that orbits the target and shrinks:
 *
 *  - On first contact the error is snapped to the *edge* of the tier's first-burst cone,
 *    so the opening rounds are deliberately wide. That is the miss-first-burst rule, and
 *    it is what turns "I died to a bot" into "I got shot at, and then I died" — the
 *    player is told where the fight is before it can kill them.
 *  - The error then damps toward a wander point redrawn a few times a second inside the
 *    tier's settled cone. Convergence is exponential, so accuracy improves the longer a
 *    bot holds you, which is the shape a human tracking someone has.
 *  - Moving targets widen the cone in proportion to their lateral speed, and are led by
 *    only a fraction of the correct amount. Speed is clamped at the 8.2 m/s ceiling M1's
 *    slide-cancel rules impose, as S6.4 permits.
 *
 * The aim itself is slew-limited. A bot may not rotate faster than its tier's turn rate,
 * which is what stops a Veteran from answering a shot in the back instantly, and the
 * trigger is gated on the aim having actually arrived — a bot spraying at a wall halfway
 * through a turn looks broken, and it is broken.
 *
 * Bursts are counted from the magazine rather than from a timer, so a burst is a number of
 * *rounds* and stays that at any fire rate. Recoil is not compensated anywhere in here:
 * the weapon's residual reaches the bot's view exactly the way it reaches the player's,
 * and the convergence above is the only thing pulling back against it.
 */

/** Player speed ceiling from M1's slide-cancel rules. S6.4 permits assuming it. */
const MAX_TARGET_SPEED = 8.2;

/** How far ahead the aim solution predicts, seconds. Roughly one aim latency. */
const LEAD_TIME = 0.14;

/** The aim must be within this of its solution before the trigger is permitted. */
const FIRE_GATE_DEG = 11;

export class CombatBehaviour {
  /** Absolute commanded view angles, radians. What goes into the bot's command. */
  aimYaw = 0;
  aimPitch = 0;

  /** True when the bot wants the trigger held / the sights up this tick. */
  wantsFire = false;
  wantsAds = false;

  /** Debug read-outs (S7). */
  aimErrorDeg = 0;
  aimOffSolutionDeg = 0;
  burstRemaining = 0;

  /** Aim error in degrees, screen-relative. Yaw positive = right. */
  private errYaw = 0;
  private errPitch = 0;
  private wanderYaw = 0;
  private wanderPitch = 0;
  private wanderTimer = 0;
  private holdTimer = 0;

  private pauseTimer = 0;
  private lastMag = -1;

  reset(yaw: number, pitch: number): void {
    this.aimYaw = yaw;
    this.aimPitch = pitch;
    this.errYaw = 0;
    this.errPitch = 0;
    this.wanderYaw = 0;
    this.wanderPitch = 0;
    this.wanderTimer = 0;
    this.holdTimer = 0;
    this.pauseTimer = 0;
    this.burstRemaining = 0;
    this.lastMag = -1;
    this.wantsFire = false;
    this.wantsAds = false;
    this.aimErrorDeg = 0;
    this.aimOffSolutionDeg = 0;
  }

  /**
   * A fresh contact. Snaps the aim error out to the first-burst cone so the opening
   * rounds are wrong on purpose (S6.4), and restarts the burst counter.
   */
  onContact(tier: TierConfig, rng: Rng): void {
    const angle = rng.float() * TAU;
    this.errYaw = simCos(angle) * tier.firstBurstConeDeg;
    this.errPitch = simSin(angle) * tier.firstBurstConeDeg;
    this.wanderYaw = this.errYaw;
    this.wanderPitch = this.errPitch;
    this.wanderTimer = 0;
    this.holdTimer = tier.firstBurstHold;
    this.pauseTimer = 0;
    this.burstRemaining = rng.int(Math.round(tier.burstMin), Math.round(tier.burstMax) + 1);
  }

  /**
   * Slew the aim toward the blackboard's belief about the target. Every tick (S6.6).
   *
   * `eyeX/Y/Z` is where the bot's own eye is this tick. Everything about the target comes
   * from the blackboard, never from the target itself.
   */
  updateAim(tier: TierConfig, bb: BotBlackboard, eyeX: number, eyeY: number, eyeZ: number, rng: Rng): void {
    // Imperfect lead. The velocity estimate is itself from two perception samples, so a
    // target that changed direction inside the last 100 ms is led the wrong way.
    let vx = bb.lastKnownVx;
    let vz = bb.lastKnownVz;
    const speed = Math.hypot(vx, vz);
    if (speed > MAX_TARGET_SPEED) {
      const scale = MAX_TARGET_SPEED / speed;
      vx *= scale;
      vz *= scale;
    }
    const lead = LEAD_TIME * tier.leadFraction;
    const aimX = bb.lastKnownX + vx * lead;
    const aimY = bb.lastKnownY;
    const aimZ = bb.lastKnownZ + vz * lead;

    const dx = aimX - eyeX;
    const dy = aimY - eyeY;
    const dz = aimZ - eyeZ;
    const flat = Math.hypot(dx, dz);
    const solutionYaw = flat > 1e-5 ? Math.atan2(-dx, -dz) : this.aimYaw;
    const solutionPitch = Math.atan2(dy, Math.max(flat, 1e-5));

    // Wander target, redrawn a few times a second. Wide while the first-burst hold is
    // running, tight afterwards, and always widened by how fast the target is moving —
    // and, from M6, by how far away it is.
    //
    // The range term is the M5 playtest note ("bots feel too accurate at long distances").
    // It is additive in degrees past a tier-specific start range, so nothing inside a room
    // changes and everything across a yard opens up: at Veteran it adds 0.55° per 10 m
    // past 20 m, which roughly doubles the settled cone by 45 m.
    const range = Math.hypot(dx, dy, dz);
    const rangeError =
      Math.max(0, range - tier.rangeErrorStart) * (tier.rangeErrorPerTenM / 10);
    const settled =
      tier.aimConeDeg + tier.trackingErrorDeg * Math.min(speed, MAX_TARGET_SPEED) + rangeError;
    const wide = this.holdTimer > 0;
    if (this.holdTimer > 0) this.holdTimer -= DT;
    this.wanderTimer -= DT;
    if (this.wanderTimer <= 0) {
      const cone = wide ? tier.firstBurstConeDeg : settled;
      const angle = rng.float() * TAU;
      // sqrt weighting keeps the point uniform over the disc rather than centre-heavy.
      const radius = Math.sqrt(rng.float()) * cone;
      this.wanderYaw = simCos(angle) * radius;
      this.wanderPitch = simSin(angle) * radius;
      this.wanderTimer = wide ? tier.jitterPeriod * 1.5 : tier.jitterPeriod;
    }

    this.errYaw = damp(this.errYaw, this.wanderYaw, tier.convergeRate, DT);
    this.errPitch = damp(this.errPitch, this.wanderPitch, tier.convergeRate, DT);
    this.aimErrorDeg = Math.hypot(this.errYaw, this.errPitch);

    // Yaw is a view angle, so a rightward error is a negative yaw delta — the same sign
    // convention `Recoil` documents for its pattern.
    const targetYaw = solutionYaw - this.errYaw * DEG2RAD;
    const targetPitch = clamp(solutionPitch + this.errPitch * DEG2RAD, -89 * DEG2RAD, 89 * DEG2RAD);

    const maxStep = tier.turnRateDeg * DEG2RAD * DT;
    const yawDelta = angleDelta(this.aimYaw, targetYaw);
    this.aimYaw += clamp(yawDelta, -maxStep, maxStep);
    this.aimPitch += clamp(targetPitch - this.aimPitch, -maxStep, maxStep);

    // How far the aim still is from its own solution, ignoring the deliberate error.
    // This is the trigger gate: it is zero once the bot has finished turning.
    this.aimOffSolutionDeg =
      Math.hypot(angleDelta(this.aimYaw, solutionYaw), this.aimPitch - solutionPitch) * RAD2DEG;
  }

  /**
   * Point the aim somewhere that is not a target — a patrol heading, a noise, a corner.
   * Slew-limited the same way, so a bot turning to look at something takes time to do it.
   */
  lookToward(tier: TierConfig, yaw: number, pitch: number): void {
    const maxStep = tier.turnRateDeg * DEG2RAD * DT;
    this.aimYaw += clamp(angleDelta(this.aimYaw, yaw), -maxStep, maxStep);
    this.aimPitch += clamp(pitch - this.aimPitch, -maxStep, maxStep);
    this.aimErrorDeg = 0;
    this.aimOffSolutionDeg = Math.abs(angleDelta(this.aimYaw, yaw)) * RAD2DEG;
  }

  /**
   * Trigger discipline. Every tick.
   *
   * `magNow` is the weapon's magazine, which is how rounds get counted out of a burst;
   * `canFire` is the weapon's own authority (raise complete, not reloading), so a bot
   * cannot fire through a reload or a sprint-out any more than a player can (S6.4).
   */
  updateTrigger(
    tier: TierConfig,
    profile: WeaponCombatProfile,
    bb: BotBlackboard,
    rng: Rng,
    magNow: number,
    canFire: boolean,
    distance: number,
    hasLine: boolean,
  ): void {
    this.wantsFire = false;
    // Both gates are the tier's number scaled by the weapon's (M7). A shotgun holds fire
    // until the target is close enough for pellets to matter and never bothers with sights;
    // a sniper opens earlier and is aiming almost from the moment it has a line.
    this.wantsAds = hasLine && distance >= tier.adsRange * profile.adsScale;

    if (this.lastMag >= 0 && magNow < this.lastMag) this.burstRemaining -= this.lastMag - magNow;
    this.lastMag = magNow;

    if (this.pauseTimer > 0) {
      this.pauseTimer -= DT;
      return;
    }

    // The reaction delay S6.3 specifies: no trigger until it has been paid in full.
    if (!bb.reactionPaid) return;
    if (!hasLine) return;
    if (distance > tier.engageRange * profile.engageScale) return;
    if (!canFire) return;
    if (this.aimOffSolutionDeg > FIRE_GATE_DEG) return;

    if (this.burstRemaining <= 0) {
      this.pauseTimer = rng.range(tier.burstPauseMin, tier.burstPauseMax);
      this.burstRemaining = rng.int(Math.round(tier.burstMin), Math.round(tier.burstMax) + 1);
      return;
    }

    this.wantsFire = true;
  }

  /** Fold this tick's recoil residual into the aim, exactly as the player's view does. */
  applyRecoilResidual(yaw: number, pitch: number): void {
    this.aimYaw += yaw;
    this.aimPitch = clamp(this.aimPitch + pitch, -89 * DEG2RAD, 89 * DEG2RAD);
  }
}
