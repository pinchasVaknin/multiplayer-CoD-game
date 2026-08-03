import { clamp01, DEG2RAD } from '../../shared/core/MathUtil';
import type { CameraConfig } from './CameraConfig';

/**
 * Additive shake channel (brief S5.4), ready for M2's weapon fire.
 *
 * Trauma-based: callers add trauma, the shake amplitude is trauma squared, and trauma
 * decays linearly. Squaring is what makes a small nudge stay subtle while a big hit
 * still lands — a linear mapping makes everything feel the same.
 *
 * Three summed sines rather than random noise, so the motion is smooth and
 * frame-rate independent: sampling noise per frame produces a buzz that changes
 * character with FPS. Frequencies are deliberately low and decay is fast; this is an
 * impact cue, not a rumble.
 */
export class CameraShake {
  /** 0..1. Read by the debug overlay. */
  trauma = 0;

  yaw = 0;
  pitch = 0;
  roll = 0;

  private time = 0;

  /** Add trauma. Values above 1 are clamped; overlapping hits do not stack forever. */
  add(amount: number): void {
    this.trauma = clamp01(this.trauma + amount);
  }

  reset(): void {
    this.trauma = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.time = 0;
  }

  update(cfg: CameraConfig, dt: number): void {
    if (this.trauma <= 0) {
      this.yaw = 0;
      this.pitch = 0;
      this.roll = 0;
      return;
    }
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - cfg.shakeDecay * dt);

    const amp = this.trauma * this.trauma;
    const f = cfg.shakeFrequency * Math.PI * 2;
    const t = this.time;

    this.yaw = wobble(t, f, 0.0) * cfg.shakeYawDeg * DEG2RAD * amp;
    this.pitch = wobble(t, f, 2.1) * cfg.shakePitchDeg * DEG2RAD * amp;
    this.roll = wobble(t, f, 4.3) * cfg.shakeRollDeg * DEG2RAD * amp;
  }
}

/**
 * Irrational frequency ratios so the three sines never re-phase into a visible
 * repeating pattern.
 */
function wobble(t: number, f: number, phase: number): number {
  return (
    Math.sin(t * f + phase) * 0.62 +
    Math.sin(t * f * 1.618 + phase * 1.7) * 0.27 +
    Math.sin(t * f * 2.414 + phase * 2.3) * 0.11
  );
}
