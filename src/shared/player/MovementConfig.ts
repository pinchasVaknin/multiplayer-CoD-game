/**
 * Every number that affects how movement feels. Nothing inline in logic (brief S3).
 *
 * Starting values come from S5.1 and S5.2 of the milestone brief. They are meant to be
 * tuned from here — the debug overlay drives this object live and can copy the tuned
 * result back out as source (F1 -> TUNING -> COPY CONFIG).
 */
export interface MovementConfig {
  // -- speeds (m/s) ------------------------------------------------------
  walkSpeed: number;
  sprintSpeed: number;
  tacSprintSpeed: number;
  crouchSpeed: number;
  /** Reserved by S5.1; live now on RMB so the cap is exercised before M2 adds optics. */
  adsSpeed: number;

  // -- tactical sprint ---------------------------------------------------
  /** Seconds at tacSprintSpeed before the decay begins. */
  tacSprintDuration: number;
  /** Seconds spent ramping tacSprintSpeed down to sprintSpeed. */
  tacSprintDecay: number;
  /** Seconds after a tac sprint ends before another may start. */
  tacSprintCooldown: number;
  /** Double-tap window on the sprint key that promotes sprint to tac sprint, seconds. */
  tacSprintDoubleTapWindow: number;

  // -- acceleration ------------------------------------------------------
  /** Ground acceleration, m/s^2. */
  groundAccel: number;
  /** Ground friction coefficient (per second). */
  friction: number;
  /** Below this speed friction becomes linear so the player actually reaches zero. */
  stopSpeed: number;
  /** Air control as a fraction of ground control. */
  airControl: number;

  // -- jump / gravity ----------------------------------------------------
  /** Apex height of a standing jump, metres. */
  jumpHeight: number;
  /** Downward acceleration, m/s^2. Deliberately snappier than real gravity. */
  gravity: number;
  /** Terminal velocity, m/s. Also keeps per-tick displacement under the capsule radius. */
  maxFallSpeed: number;
  /** Grace period after walking off a ledge during which jump still works, seconds. */
  coyoteTime: number;
  /** How long early jump presses are remembered, seconds. */
  jumpBufferTime: number;

  // -- slide (S5.2, LOCKED structure) ------------------------------------
  slideDuration: number;
  slideStartSpeed: number;
  slideEndSpeed: number;
  /** Seconds after a slide ends before another may start. LOCKED at 1.2. */
  slideCooldown: number;
  /** Sprint must have been held this long before a slide may start. LOCKED at 0.3. */
  slideMinSprintTime: number;
  /** Tactical sprint lockout after leaving a slide by any route. LOCKED at 1.0. */
  slideTacLockout: number;
  /** How much the player may steer mid-slide, as a fraction of ground control. */
  slideSteer: number;
  /** Slide ends early below this speed, m/s. */
  slideMinSpeed: number;

  // -- capsule (S4.3) ----------------------------------------------------
  capsuleRadius: number;
  standHeight: number;
  crouchHeight: number;
  slideHeight: number;
  standEye: number;
  crouchEye: number;
  slideEye: number;

  // -- collision ---------------------------------------------------------
  /** Silent step-up, no vault animation. */
  stepHeight: number;
  /** Steepest walkable surface, degrees. */
  maxSlopeDeg: number;
  /** How far the capsule searches downward to stay glued to the ground, metres. */
  groundSnapDist: number;
  /** Separation kept between capsule and geometry after de-penetration, metres. */
  collisionSkin: number;

  // -- mantle ------------------------------------------------------------
  mantleMinHeight: number;
  mantleMaxHeight: number;
  /** Vault duration, seconds. */
  mantleDuration: number;
  /** How far ahead of the capsule a ledge is detected, metres. */
  mantleReach: number;
  /** Ledges at or below this height vault automatically when sprinting into them. */
  autoVaultMaxHeight: number;
  /** Forward speed handed back to the player at the top of a vault, m/s. */
  mantleExitSpeed: number;

  // -- footsteps ---------------------------------------------------------
  /** Metres of travel between footsteps at walk speed. */
  footstepStride: number;
}

export const DEFAULT_MOVEMENT_CONFIG: MovementConfig = {
  walkSpeed: 4.6,
  sprintSpeed: 6.9,
  tacSprintSpeed: 8.2,
  crouchSpeed: 2.8,
  adsSpeed: 3.0,

  tacSprintDuration: 1.5,
  tacSprintDecay: 0.35,
  tacSprintCooldown: 5.0,
  tacSprintDoubleTapWindow: 0.3,

  groundAccel: 60,
  friction: 12,
  stopSpeed: 1.2,
  airControl: 0.25,

  jumpHeight: 0.95,
  gravity: 18,
  maxFallSpeed: 32,
  coyoteTime: 0.08,
  jumpBufferTime: 0.1,

  slideDuration: 0.85,
  slideStartSpeed: 8.0,
  slideEndSpeed: 2.0,
  slideCooldown: 1.2,
  slideMinSprintTime: 0.3,
  /**
   * 1.25, raised from 1.0 in M5's balance pass (S6.5).
   *
   * The brief asks whether sliding into a room beats the fastest ADS in the arsenal now
   * that TTK exists, and to lengthen this if it does. Measured: it does, marginally — the
   * WASP and the TALON come up 0.13 s and 0.12 s out of a slide against the WASP's 0.175 s
   * ADS. Their `sprintOutTime` is where that 45 ms actually lives and both were raised to
   * 0.18 s alongside this.
   *
   * This number is the *chaining* lever rather than the entry one, and the measurement says
   * chaining was never the problem: over thirty adversarial seconds of slide-cancelling at
   * 7.94 m/s the weapon is fireable on **zero** ticks. The extra quarter second is taken
   * anyway, because a rule that only bites in a case that is already paid for is cheap, and
   * the brief asked for it. See PLAN.md for the full measurement.
   */
  slideTacLockout: 1.25,
  slideSteer: 0.16,
  slideMinSpeed: 1.6,

  capsuleRadius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.1,
  slideHeight: 0.55,
  standEye: 1.65,
  crouchEye: 0.95,
  slideEye: 0.55,

  /**
   * 0.55, raised from 0.35 (post-M8) and then from 0.5 (round 2).
   *
   * Playtesting reported being stopped by kerbs, pallet edges and the small rocks on Dunes
   * and having to jump over things a walking person would not notice. 0.35 m is a tall kerb
   * and the map props are not built to it — Depot's pallets and Dunes' stone lips sit in the
   * 0.36-0.48 m band, which was exactly high enough to block and exactly low enough that
   * being blocked read as a bug rather than as an obstacle.
   *
   * **Round 2 asked for it again, and this number was never what was wrong.** Measured
   * headless against a flat step, the shipped 0.5 m config cleared *nothing*: a 0.30 m step
   * blocked a walking capsule for three solid seconds. The defect was in the step-up
   * sequence, not in its budget — see the long note in `Movement.integrateMotion`. With that
   * fixed, 0.5 already cleared 0.65 m, so this last 5 cm is headroom rather than the fix, and
   * it is deliberately small for the reason below.
   *
   * The ceiling on it is the 0.7 m `crate`, which is the greybox's auto-vault test bed and
   * has to stay a vault. It stays clear of `mantleMinHeight`, which moves up with it: the two
   * ranges must not overlap, or an obstacle would be both silently stepped and vault-detected
   * on the same tick and which one you got would depend on your approach speed.
   *
   * One honest caveat, measured rather than assumed: the *effective* ceiling is about 0.70 m,
   * not 0.55. Once the capsule is raised, its bottom hemisphere meets a step's top corner at
   * a contact normal inside `maxSlopeDeg`, so it climbs the last few centimetres as if the
   * corner were a ramp. That is a property of capsule-versus-box de-penetration and not of
   * this table; it is why the number here is kept well under the crate rather than tuned up
   * to it.
   */
  stepHeight: 0.55,
  maxSlopeDeg: 46,
  groundSnapDist: 0.4,
  collisionSkin: 0.005,

  // Raised with `stepHeight` (0.4 -> 0.55 post-M8 -> 0.6 in round 2) to stay above it.
  // Anything the capsule can silently step over must not also be a vault, or the same ledge
  // produces two different animations.
  mantleMinHeight: 0.6,
  mantleMaxHeight: 1.6,
  mantleDuration: 0.4,
  mantleReach: 0.95,
  autoVaultMaxHeight: 0.85,
  mantleExitSpeed: 2.4,

  footstepStride: 2.1,
};

export interface TunableMeta {
  readonly label: string;
  readonly group: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

/**
 * Slider metadata for every field above.
 *
 * The `Record<keyof MovementConfig, ...>` type is the point: adding a config field
 * without giving it a slider is a compile error, so the tuning panel can never drift
 * out of date with the config.
 */
export const MOVEMENT_TUNABLES: Readonly<Record<keyof MovementConfig, TunableMeta>> = {
  walkSpeed: { label: 'Walk', group: 'Speeds', min: 1, max: 12, step: 0.1, unit: 'm/s' },
  sprintSpeed: { label: 'Sprint', group: 'Speeds', min: 1, max: 14, step: 0.1, unit: 'm/s' },
  tacSprintSpeed: { label: 'Tac sprint', group: 'Speeds', min: 1, max: 16, step: 0.1, unit: 'm/s' },
  crouchSpeed: { label: 'Crouch', group: 'Speeds', min: 0.5, max: 8, step: 0.1, unit: 'm/s' },
  adsSpeed: { label: 'ADS', group: 'Speeds', min: 0.5, max: 8, step: 0.1, unit: 'm/s' },

  tacSprintDuration: { label: 'Duration', group: 'Tac sprint', min: 0.2, max: 5, step: 0.05, unit: 's' },
  tacSprintDecay: { label: 'Decay', group: 'Tac sprint', min: 0, max: 2, step: 0.05, unit: 's' },
  tacSprintCooldown: { label: 'Cooldown', group: 'Tac sprint', min: 0, max: 10, step: 0.1, unit: 's' },
  tacSprintDoubleTapWindow: {
    label: 'Dbl-tap window',
    group: 'Tac sprint',
    min: 0.1,
    max: 0.6,
    step: 0.01,
    unit: 's',
  },

  groundAccel: { label: 'Ground accel', group: 'Acceleration', min: 5, max: 200, step: 1, unit: 'm/s²' },
  friction: { label: 'Friction', group: 'Acceleration', min: 0, max: 30, step: 0.5, unit: '' },
  stopSpeed: { label: 'Stop speed', group: 'Acceleration', min: 0, max: 5, step: 0.1, unit: 'm/s' },
  airControl: { label: 'Air control', group: 'Acceleration', min: 0, max: 1, step: 0.01, unit: 'x' },

  jumpHeight: { label: 'Jump height', group: 'Jump', min: 0.2, max: 2.5, step: 0.05, unit: 'm' },
  gravity: { label: 'Gravity', group: 'Jump', min: 5, max: 40, step: 0.5, unit: 'm/s²' },
  maxFallSpeed: { label: 'Terminal vel', group: 'Jump', min: 10, max: 80, step: 1, unit: 'm/s' },
  coyoteTime: { label: 'Coyote time', group: 'Jump', min: 0, max: 0.3, step: 0.01, unit: 's' },
  jumpBufferTime: { label: 'Jump buffer', group: 'Jump', min: 0, max: 0.3, step: 0.01, unit: 's' },

  slideDuration: { label: 'Duration', group: 'Slide', min: 0.2, max: 2, step: 0.05, unit: 's' },
  slideStartSpeed: { label: 'Start speed', group: 'Slide', min: 2, max: 14, step: 0.1, unit: 'm/s' },
  slideEndSpeed: { label: 'End speed', group: 'Slide', min: 0, max: 8, step: 0.1, unit: 'm/s' },
  slideCooldown: { label: 'Cooldown', group: 'Slide', min: 0, max: 4, step: 0.05, unit: 's' },
  slideMinSprintTime: { label: 'Min sprint held', group: 'Slide', min: 0, max: 1.5, step: 0.05, unit: 's' },
  slideTacLockout: { label: 'Tac lockout', group: 'Slide', min: 0, max: 3, step: 0.05, unit: 's' },
  slideSteer: { label: 'Steer', group: 'Slide', min: 0, max: 1, step: 0.01, unit: 'x' },
  slideMinSpeed: { label: 'Exit below', group: 'Slide', min: 0, max: 5, step: 0.1, unit: 'm/s' },

  capsuleRadius: { label: 'Radius', group: 'Capsule', min: 0.15, max: 0.7, step: 0.01, unit: 'm' },
  standHeight: { label: 'Stand height', group: 'Capsule', min: 1, max: 2.4, step: 0.01, unit: 'm' },
  crouchHeight: { label: 'Crouch height', group: 'Capsule', min: 0.6, max: 1.8, step: 0.01, unit: 'm' },
  slideHeight: { label: 'Slide height', group: 'Capsule', min: 0.4, max: 1.4, step: 0.01, unit: 'm' },
  standEye: { label: 'Stand eye', group: 'Capsule', min: 0.8, max: 2.3, step: 0.01, unit: 'm' },
  crouchEye: { label: 'Crouch eye', group: 'Capsule', min: 0.4, max: 1.6, step: 0.01, unit: 'm' },
  slideEye: { label: 'Slide eye', group: 'Capsule', min: 0.2, max: 1.2, step: 0.01, unit: 'm' },

  stepHeight: { label: 'Step-up', group: 'Collision', min: 0, max: 0.8, step: 0.01, unit: 'm' },
  maxSlopeDeg: { label: 'Max slope', group: 'Collision', min: 20, max: 70, step: 1, unit: '°' },
  groundSnapDist: { label: 'Ground snap', group: 'Collision', min: 0, max: 1, step: 0.01, unit: 'm' },
  collisionSkin: { label: 'Skin', group: 'Collision', min: 0.001, max: 0.05, step: 0.001, unit: 'm' },

  mantleMinHeight: { label: 'Min ledge', group: 'Mantle', min: 0.1, max: 1.5, step: 0.05, unit: 'm' },
  mantleMaxHeight: { label: 'Max ledge', group: 'Mantle', min: 0.5, max: 2.5, step: 0.05, unit: 'm' },
  mantleDuration: { label: 'Vault time', group: 'Mantle', min: 0.1, max: 1.2, step: 0.02, unit: 's' },
  mantleReach: { label: 'Reach', group: 'Mantle', min: 0.3, max: 2, step: 0.05, unit: 'm' },
  autoVaultMaxHeight: { label: 'Auto-vault below', group: 'Mantle', min: 0, max: 1.6, step: 0.05, unit: 'm' },
  mantleExitSpeed: { label: 'Exit speed', group: 'Mantle', min: 0, max: 6, step: 0.1, unit: 'm/s' },

  footstepStride: { label: 'Stride', group: 'Footsteps', min: 0.8, max: 4, step: 0.05, unit: 'm' },
};

export const MOVEMENT_CONFIG_KEYS = Object.keys(DEFAULT_MOVEMENT_CONFIG) as Array<keyof MovementConfig>;

export function cloneMovementConfig(src: MovementConfig): MovementConfig {
  return { ...src };
}

/** Serialise a tuned config back into pasteable TypeScript source. */
export function movementConfigToSource(cfg: MovementConfig): string {
  const lines: string[] = ['export const DEFAULT_MOVEMENT_CONFIG: MovementConfig = {'];
  let lastGroup = '';
  for (const key of MOVEMENT_CONFIG_KEYS) {
    const meta = MOVEMENT_TUNABLES[key];
    if (meta.group !== lastGroup) {
      if (lastGroup !== '') lines.push('');
      lines.push(`  // -- ${meta.group.toLowerCase()} --`);
      lastGroup = meta.group;
    }
    lines.push(`  ${key}: ${round(cfg[key])},`);
  }
  lines.push('};');
  return lines.join('\n');
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
