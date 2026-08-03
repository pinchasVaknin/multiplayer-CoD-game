import { DT } from '../core/Loop';
import { clamp01, TAU } from '../core/MathUtil';
import type { ScopeProfile, WeaponDef } from './WeaponDefs';
import { simSin } from '../core/SimMath';

/**
 * The sniper scope (brief S6.1): visible breath sway, hold-breath on Shift, and the glint
 * an enemy can see.
 *
 * Sway is two sines at incommensurate rates rather than one. A single sine is a pendulum
 * and a player learns to fire at the ends of it within about a minute; two, at a ratio
 * that never repeats inside a scope-in, produce a wandering figure that has to be
 * *corrected* rather than timed. That is the whole difference between a mechanic and a
 * metronome.
 *
 * The sway is applied to the aim, not to the picture — the rounds go where the crosshair
 * is. Applying it to the camera only would be a lie the player would find out about.
 *
 * Runs on sim ticks; `DT` is the constant. Allocation free.
 */

/** Seconds the hold-breath damping takes to engage and to let go. */
const HOLD_BLEND_SECONDS = 0.18;

/** Aimed fraction below which the scope is not considered up at all. */
const SCOPED_THRESHOLD = 0.5;

/** Aimed fraction at which the objective lens starts catching the light. */
const GLINT_THRESHOLD = 0.85;

export class ScopeState {
  /** Degrees. Added to the aim exactly the way recoil's transient offset is. */
  swayYaw = 0;
  swayPitch = 0;

  /** 1 = a full lungful, 0 = out of breath and shaking. */
  breath = 1;
  /** Whether the hold is actually engaged, as opposed to merely requested. */
  holding = false;

  private phase = 0;
  private holdBlend = 0;
  private scoped = false;

  reset(): void {
    this.swayYaw = 0;
    this.swayPitch = 0;
    this.breath = 1;
    this.holding = false;
    this.phase = 0;
    this.holdBlend = 0;
    this.scoped = false;
  }

  /** True once the sight picture is up enough to matter. */
  get isScoped(): boolean {
    return this.scoped;
  }

  /**
   * One tick. `adsFraction` scales the sway in, so the wobble arrives with the sight
   * picture rather than snapping on at the end of the transition.
   */
  step(def: WeaponDef, adsFraction: number, holdRequested: boolean): void {
    const scope = def.scope;
    if (scope === undefined) {
      this.swayYaw = 0;
      this.swayPitch = 0;
      this.scoped = false;
      this.holding = false;
      // An unscoped weapon still recovers its breath, so swapping off a sniper and back
      // does not hand you an empty meter.
      this.breath = clamp01(this.breath + DT / 3);
      this.holdBlend = 0;
      return;
    }

    this.scoped = adsFraction >= SCOPED_THRESHOLD;

    const wantHold = holdRequested && this.scoped && this.breath > 0;
    this.holding = wantHold;
    if (wantHold) {
      this.breath = Math.max(0, this.breath - DT / Math.max(scope.breathSeconds, 1e-3));
    } else {
      this.breath = clamp01(this.breath + DT / Math.max(scope.breathRecovery, 1e-3));
    }

    // Blended rather than switched: running out of air should be a two-tenths slide back
    // into the wobble, not a single frame where the crosshair jumps.
    const target = wantHold ? 1 : 0;
    const rate = DT / HOLD_BLEND_SECONDS;
    this.holdBlend = target > this.holdBlend
      ? Math.min(target, this.holdBlend + rate)
      : Math.max(target, this.holdBlend - rate);

    this.phase += DT;
    const holdScale = 1 + (scope.breathHoldScale - 1) * this.holdBlend;
    // The last of the breath is the worst of the shake, which is what makes the meter
    // something you watch rather than something you spend.
    const fatigue = 1 + (1 - this.breath) * 0.45;
    const amp = scope.swayDeg * clamp01(adsFraction) * holdScale * fatigue;

    const w = scope.swayRate * TAU;
    this.swayYaw = simSin(this.phase * w) * amp;
    this.swayPitch = simSin(this.phase * w * 0.61 + 1.3) * amp * 0.62;
  }

  /**
   * Whether this weapon is throwing a glint right now (S6.1).
   *
   * Deliberately a property of the *scope being up*, not of firing: the point of a glint is
   * that holding an angle costs you something before you pull the trigger.
   */
  static glinting(def: WeaponDef, adsFraction: number): boolean {
    const scope: ScopeProfile | undefined = def.scope;
    return scope !== undefined && scope.glint && adsFraction >= GLINT_THRESHOLD;
  }
}
