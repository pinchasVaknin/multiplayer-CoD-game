import { DT } from '../core/Loop';
import { clamp01, damp, DEG2RAD, lerp, TAU } from '../core/MathUtil';
import type { Rng } from '../core/Rng';
import type { WeaponDef } from './WeaponDefs';
import { simCos, simSin, simTan } from '../core/SimMath';

/**
 * Recoil and spread (brief S6.2).
 *
 * Two things are deliberately kept apart:
 *
 *  - **Aim recoil** changes where the round actually goes. It is a deterministic,
 *    authored pattern, so it is learnable; a player who knows the pattern can counter
 *    it exactly, and a player who does not cannot.
 *  - **Visual recoil** is the viewmodel kick. It sells the shot and changes nothing.
 *
 * Recovery returns the camera *toward* the origin, not to it: each shot's kick is split
 * into a recoverable part, which decays away, and a residual, which is folded into the
 * player's actual view angles and stays there. That residual is why a long spray leaves
 * you aiming above where you started, and why holding one on target feels earned.
 *
 * A small random cone sits on top, scaled by stance and movement. The randomness comes
 * from the seeded `Rng`, never `Math.random`, so a recorded burst replays exactly.
 *
 * Runs on sim ticks; `DT` is the constant. Allocation free.
 */

export interface SpreadContext {
  /** 0 = stationary, 1 = at or above walking pace. */
  moveFraction: number;
  /** 0 = hip fire, 1 = fully aimed. */
  adsFraction: number;
  crouched: boolean;
  airborne: boolean;
}

/** Result of perturbing an aim direction by the spread cone. */
export interface AimSample {
  dx: number;
  dy: number;
  dz: number;
  /** The cone half-angle actually used, degrees. Drives the crosshair. */
  spreadDeg: number;
  /**
   * The tangent-space offset that produced `d`, in the view's right/up basis.
   *
   * Kept so a shotgun's pellets can be laid out *around* the aim point the spread cone
   * already chose, rather than each pellet re-rolling the whole cone — which would turn
   * eight rays into eight independent shots and lose the pattern entirely.
   */
  ax: number;
  ay: number;
}

export function makeAimSample(): AimSample {
  return { dx: 0, dy: 0, dz: -1, spreadDeg: 0, ax: 0, ay: 0 };
}

export class Recoil {
  /**
   * Transient aim offset in degrees, recovering to zero.
   *
   * These are **view-angle deltas**, not screen directions: yaw decreases as the view
   * turns right (see `Input.onMouseMove`), so a pattern kick to the right shows up here
   * as a negative `aimYaw`. The authored pattern stays in the natural "+x is right"
   * convention and the sign flip happens once, in `onShot`.
   */
  aimPitch = 0;
  aimYaw = 0;

  /** Residual produced by the most recent shot, degrees. Consumed once, then cleared. */
  residualPitch = 0;
  residualYaw = 0;

  /** Index into the authored pattern; cycles once the array ends. */
  shotIndex = 0;
  sinceLastShot = 999;

  /** Viewmodel kick, unitless. Fast attack, slower settle. */
  visualPunch = 0;
  visualLateral = 0;
  private punchTarget = 0;
  private lateralTarget = 0;

  /** Per-shot spread bloom, degrees. */
  bloom = 0;

  reset(): void {
    this.aimPitch = 0;
    this.aimYaw = 0;
    this.residualPitch = 0;
    this.residualYaw = 0;
    this.shotIndex = 0;
    this.sinceLastShot = 999;
    this.visualPunch = 0;
    this.visualLateral = 0;
    this.punchTarget = 0;
    this.lateralTarget = 0;
    this.bloom = 0;
  }

  /** The pattern restarts when the trigger is released or a reload finishes. */
  resetPattern(): void {
    this.shotIndex = 0;
  }

  /** One sim tick: recovery, bloom decay, viewmodel settle. */
  step(def: WeaponDef): void {
    const r = def.recoil;
    this.sinceLastShot += DT;

    // Recovery waits out `recoverDelay` so a sustained spray keeps climbing; between
    // taps, and after the trigger is released, the camera walks back down.
    if (this.sinceLastShot >= r.recoverDelay) {
      this.aimPitch = damp(this.aimPitch, 0, r.recoverRate, DT);
      this.aimYaw = damp(this.aimYaw, 0, r.recoverRate, DT);
      if (Math.abs(this.aimPitch) < 1e-4) this.aimPitch = 0;
      if (Math.abs(this.aimYaw) < 1e-4) this.aimYaw = 0;
    }

    // Bloom recovers linearly: a fixed degrees-per-second is what makes "wait a beat
    // and your next shot is accurate again" a readable rule rather than a feel.
    const recover = def.spread.recover * DT;
    this.bloom = this.bloom > recover ? this.bloom - recover : 0;

    // Attack/release follower. The target decays slowly and the position chases it
    // quickly, which is a fast punch into a longer settle without a spring to detune.
    const settleRate = 1 / Math.max(r.visualSettle, 1e-3);
    const attackRate = 1 / Math.max(r.visualAttack, 1e-3);
    this.punchTarget = damp(this.punchTarget, 0, settleRate, DT);
    this.lateralTarget = damp(this.lateralTarget, 0, settleRate, DT);
    this.visualPunch = damp(this.visualPunch, this.punchTarget, attackRate, DT);
    this.visualLateral = damp(this.visualLateral, this.lateralTarget, attackRate, DT);
  }

  /**
   * Register a shot. Advances the pattern, applies the kick, and leaves the residual in
   * `residualPitch` / `residualYaw` for the caller to fold into the player's view.
   */
  onShot(def: WeaponDef, adsFraction: number): void {
    const r = def.recoil;
    const kicks = r.kicks;
    const count = kicks.length;
    const kick = count > 0 ? kicks[this.shotIndex % count] : undefined;
    const kx = kick === undefined ? 0 : kick.x;
    const ky = kick === undefined ? 0 : kick.y;

    const first = this.shotIndex === 0 ? r.firstShotScale : 1;
    const adsScale = lerp(1, r.adsScale, clamp01(adsFraction));
    // Screen-space: +up and +right, the way the pattern is authored and plotted.
    const upKick = ky * r.verticalScale * first * adsScale;
    const rightKick = kx * r.horizontalScale * first * adsScale;

    const recovered = clamp01(r.recoverFraction);
    this.aimPitch += upKick * recovered;
    this.aimYaw += -rightKick * recovered;
    this.residualPitch = upKick * (1 - recovered);
    this.residualYaw = -rightKick * (1 - recovered);

    // The viewmodel stays in screen space: the gun kicks the way you see it kick.
    this.punchTarget += upKick * r.visualScale;
    this.lateralTarget += rightKick * r.visualScale;

    const spread = def.spread;
    this.bloom = Math.min(spread.perShotMax, this.bloom + spread.perShot);

    this.shotIndex++;
    this.sinceLastShot = 0;
  }

  /** Cone half-angle for the current state, degrees. Also drives the crosshair. */
  spreadDegrees(def: WeaponDef, ctx: SpreadContext): number {
    const s = def.spread;
    const hip = lerp(s.hipStand, s.hipMove, clamp01(ctx.moveFraction));
    let base = lerp(hip, s.ads, clamp01(ctx.adsFraction));
    if (ctx.crouched) base *= s.crouchScale;
    if (ctx.airborne) base *= s.airScale;
    return base + this.bloom;
  }

  /**
   * Perturb an aim direction by the spread cone.
   *
   * The offset is sampled on a disc (sqrt-weighted, so it is uniform over area rather
   * than clustered at the centre) and applied in the view's own right/up basis, which
   * keeps the cone circular at every pitch.
   */
  sampleAim(
    yaw: number,
    pitch: number,
    spreadDeg: number,
    rng: Rng,
    out: AimSample,
  ): void {
    let ax = 0;
    let ay = 0;
    if (spreadDeg > 1e-5) {
      const radius = Math.sqrt(rng.float()) * spreadDeg * DEG2RAD;
      const angle = rng.float() * TAU;
      ax = simTan(simCos(angle) * radius);
      ay = simTan(simSin(angle) * radius);
    }
    out.spreadDeg = spreadDeg;
    aimWithOffset(yaw, pitch, ax, ay, out);
  }
}

/**
 * Build a direction from view angles plus a tangent-space offset.
 *
 * Split out of `sampleAim` in M5 so the pellet loop can reuse the same basis: a shotgun
 * lays its pellets out deterministically around the point the spread cone chose, and doing
 * that meant the "offset a view direction" half had to stop being private to the random
 * half.
 */
export function aimWithOffset(
  yaw: number,
  pitch: number,
  ax: number,
  ay: number,
  out: AimSample,
): void {
  const cp = simCos(pitch);
  const sp = simSin(pitch);
  const sy = simSin(yaw);
  const cy = simCos(yaw);

  // Forward for this project's convention: yaw 0 looks down -Z.
  let fx = -sy * cp;
  let fy = sp;
  let fz = -cy * cp;

  if (ax !== 0 || ay !== 0) {
    // Horizontal right, and the up vector that completes the view basis.
    const rx = cy;
    const rz = -sy;
    const ux = -sy * -sp;
    const uy = cp;
    const uz = -cy * -sp;

    fx += rx * ax + ux * ay;
    fy += uy * ay;
    fz += rz * ax + uz * ay;
  }

  const inv = 1 / Math.hypot(fx, fy, fz);
  out.dx = fx * inv;
  out.dy = fy * inv;
  out.dz = fz * inv;
  out.ax = ax;
  out.ay = ay;
}

/**
 * Where pellet `index` of `count` sits inside the pellet cone, in tangent space.
 *
 * A sunflower lattice — golden-angle spiral, area-uniform radius — with the whole pattern
 * rotated at random per shot. Independently rolling eight random offsets clumps: roughly
 * one shot in five puts five of its eight pellets in the same quadrant, and the weapon
 * reads as broken rather than as spread. The lattice keeps the *shape* consistent so the
 * player can learn what six metres looks like, and the rotation keeps two shots from being
 * identical.
 *
 * Pellet 0 is always dead centre, which is the same contract every other weapon makes: the
 * round you aimed goes where you aimed.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function pelletOffset(
  index: number,
  count: number,
  spreadDeg: number,
  rotation: number,
  radiusJitter: number,
  out: { ax: number; ay: number },
): void {
  if (index <= 0 || count <= 1 || spreadDeg <= 0) {
    out.ax = 0;
    out.ay = 0;
    return;
  }
  const radius = Math.sqrt(index / (count - 1)) * spreadDeg * DEG2RAD * radiusJitter;
  const angle = rotation + index * GOLDEN_ANGLE;
  out.ax = simTan(simCos(angle) * radius);
  out.ay = simTan(simSin(angle) * radius);
}

/**
 * Accumulated pattern positions, for the debug plot (S7).
 *
 * This is the *ideal* trace — pattern only, no spread and no recovery — which is what a
 * player learning the gun is actually memorising. `outX` and `outY` receive degrees.
 */
export function accumulatePattern(
  def: WeaponDef,
  shots: number,
  outX: Float32Array,
  outY: Float32Array,
): number {
  const r = def.recoil;
  const kicks = r.kicks;
  if (kicks.length === 0) return 0;
  let x = 0;
  let y = 0;
  const n = Math.min(shots, outX.length, outY.length);
  for (let i = 0; i < n; i++) {
    const kick = kicks[i % kicks.length];
    if (kick === undefined) continue;
    const first = i === 0 ? r.firstShotScale : 1;
    x += kick.x * r.horizontalScale * first;
    y += kick.y * r.verticalScale * first;
    outX[i] = x;
    outY[i] = y;
  }
  return n;
}
