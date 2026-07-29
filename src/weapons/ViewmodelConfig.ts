import type { TunableMeta } from '../player/MovementConfig';

/**
 * Every number that decides how the gun *looks* while it does what WeaponBase says it
 * is doing (brief S6.6). Balance lives in `WeaponDefs`; this is presentation.
 *
 * The split matters: `sprintOutTime` is a weapon stat and lives in the def, while the
 * sprint *pose* lives here — and the pose is driven by the same `raise` value the
 * fireable state is, so the animation cannot lie about when the gun can shoot.
 *
 * Positions are metres in viewmodel-camera space (+X right, +Y up, -Z forward);
 * rotations are degrees.
 */
export interface ViewmodelConfig {
  // -- hip pose ----------------------------------------------------------
  hipX: number;
  hipY: number;
  hipZ: number;
  hipPitch: number;
  hipYaw: number;
  hipRoll: number;

  // -- ADS pose. X is 0 by definition: the sights are on the camera axis. --
  adsY: number;
  adsZ: number;
  /** Peak overshoot on the way in, as a fraction. None on the way out (S6.6). */
  adsOvershoot: number;

  // -- lowered / sprint pose ---------------------------------------------
  sprintX: number;
  sprintY: number;
  sprintZ: number;
  sprintPitch: number;
  sprintYaw: number;
  sprintRoll: number;
  /** Tactical sprint lowers the weapon further still. */
  tacSprintExtraY: number;
  tacSprintExtraPitch: number;
  slideExtraY: number;
  slideExtraRoll: number;

  // -- sway --------------------------------------------------------------
  /** Metres of lag per radian/second of look movement. */
  swayPosition: number;
  /** Degrees of counter-rotation per radian/second of look movement. */
  swayRotation: number;
  /** Cap on sway so a flick cannot throw the gun off screen, metres. */
  swayMax: number;
  /** How fast the sway offset chases its target, per second. */
  swayRate: number;
  /** Sway is mostly suppressed while aimed. */
  swayAdsScale: number;

  // -- movement bob ------------------------------------------------------
  bobAmount: number;
  bobLateral: number;
  bobRoll: number;
  bobAdsScale: number;
  /** Slow figure-of-eight drift so the gun is never perfectly still. */
  idleAmplitude: number;
  idleHz: number;

  // -- recoil kick -------------------------------------------------------
  /** Metres of rearward travel per degree of visual punch. */
  kickBack: number;
  kickUp: number;
  kickPitch: number;
  kickRoll: number;
  kickLateral: number;

  // -- reload ------------------------------------------------------------
  reloadDropY: number;
  reloadDropZ: number;
  reloadPitch: number;
  reloadRoll: number;
  reloadYaw: number;
  /** How far the magazine travels out of the well, metres. */
  magThrow: number;
  /** Charging-handle travel on the empty reload, metres. */
  chargeThrow: number;

  // -- world-space muzzle, for tracers and the environment flash ----------
  muzzleRight: number;
  muzzleUp: number;
  muzzleForward: number;
}

export const DEFAULT_VIEWMODEL_CONFIG: ViewmodelConfig = {
  hipX: 0.152,
  hipY: -0.132,
  hipZ: -0.33,
  hipPitch: 1.2,
  hipYaw: -4.5,
  hipRoll: 1.6,

  adsY: -0.0925,
  adsZ: -0.275,
  adsOvershoot: 0.14,

  sprintX: 0.2,
  sprintY: -0.2,
  sprintZ: -0.29,
  sprintPitch: -13,
  sprintYaw: -26,
  sprintRoll: 17,
  tacSprintExtraY: -0.07,
  tacSprintExtraPitch: -12,
  slideExtraY: -0.05,
  slideExtraRoll: 9,

  swayPosition: 0.028,
  swayRotation: 2.4,
  swayMax: 0.05,
  swayRate: 11,
  swayAdsScale: 0.28,

  bobAmount: 0.011,
  bobLateral: 0.017,
  bobRoll: 0.9,
  bobAdsScale: 0.22,
  idleAmplitude: 0.0032,
  idleHz: 0.31,

  kickBack: 0.026,
  kickUp: 0.008,
  kickPitch: 1.35,
  kickRoll: 0.5,
  kickLateral: 0.012,

  reloadDropY: -0.115,
  reloadDropZ: 0.045,
  reloadPitch: -19,
  reloadRoll: 22,
  reloadYaw: 13,
  magThrow: 0.22,
  chargeThrow: 0.055,

  muzzleRight: 0.17,
  muzzleUp: -0.11,
  muzzleForward: 0.62,
};

export const VIEWMODEL_TUNABLES: Readonly<Record<keyof ViewmodelConfig, TunableMeta>> = {
  hipX: { label: 'Hip X', group: 'Hip pose', min: -0.4, max: 0.4, step: 0.002, unit: 'm' },
  hipY: { label: 'Hip Y', group: 'Hip pose', min: -0.4, max: 0.2, step: 0.002, unit: 'm' },
  hipZ: { label: 'Hip Z', group: 'Hip pose', min: -0.8, max: -0.1, step: 0.005, unit: 'm' },
  hipPitch: { label: 'Hip pitch', group: 'Hip pose', min: -25, max: 25, step: 0.2, unit: '°' },
  hipYaw: { label: 'Hip yaw', group: 'Hip pose', min: -30, max: 30, step: 0.2, unit: '°' },
  hipRoll: { label: 'Hip roll', group: 'Hip pose', min: -30, max: 30, step: 0.2, unit: '°' },

  adsY: { label: 'ADS Y', group: 'ADS pose', min: -0.2, max: 0, step: 0.0005, unit: 'm' },
  adsZ: { label: 'ADS Z', group: 'ADS pose', min: -0.6, max: -0.1, step: 0.005, unit: 'm' },
  adsOvershoot: { label: 'Overshoot', group: 'ADS pose', min: 0, max: 0.5, step: 0.01, unit: '' },

  sprintX: { label: 'Sprint X', group: 'Sprint pose', min: -0.4, max: 0.5, step: 0.005, unit: 'm' },
  sprintY: { label: 'Sprint Y', group: 'Sprint pose', min: -0.5, max: 0.2, step: 0.005, unit: 'm' },
  sprintZ: { label: 'Sprint Z', group: 'Sprint pose', min: -0.8, max: -0.1, step: 0.005, unit: 'm' },
  sprintPitch: { label: 'Sprint pitch', group: 'Sprint pose', min: -60, max: 30, step: 0.5, unit: '°' },
  sprintYaw: { label: 'Sprint yaw', group: 'Sprint pose', min: -60, max: 30, step: 0.5, unit: '°' },
  sprintRoll: { label: 'Sprint roll', group: 'Sprint pose', min: -60, max: 60, step: 0.5, unit: '°' },
  tacSprintExtraY: { label: 'Tac extra Y', group: 'Sprint pose', min: -0.3, max: 0.1, step: 0.005, unit: 'm' },
  tacSprintExtraPitch: { label: 'Tac extra pitch', group: 'Sprint pose', min: -40, max: 10, step: 0.5, unit: '°' },
  slideExtraY: { label: 'Slide extra Y', group: 'Sprint pose', min: -0.3, max: 0.1, step: 0.005, unit: 'm' },
  slideExtraRoll: { label: 'Slide extra roll', group: 'Sprint pose', min: -30, max: 30, step: 0.5, unit: '°' },

  swayPosition: { label: 'Sway position', group: 'Sway', min: 0, max: 0.12, step: 0.001, unit: 'm' },
  swayRotation: { label: 'Sway rotation', group: 'Sway', min: 0, max: 12, step: 0.1, unit: '°' },
  swayMax: { label: 'Sway cap', group: 'Sway', min: 0.005, max: 0.2, step: 0.002, unit: 'm' },
  swayRate: { label: 'Sway rate', group: 'Sway', min: 1, max: 30, step: 0.5, unit: '/s' },
  swayAdsScale: { label: 'Sway ADS x', group: 'Sway', min: 0, max: 1, step: 0.01, unit: 'x' },

  bobAmount: { label: 'Bob vertical', group: 'Bob', min: 0, max: 0.06, step: 0.001, unit: 'm' },
  bobLateral: { label: 'Bob lateral', group: 'Bob', min: 0, max: 0.08, step: 0.001, unit: 'm' },
  bobRoll: { label: 'Bob roll', group: 'Bob', min: 0, max: 6, step: 0.05, unit: '°' },
  bobAdsScale: { label: 'Bob ADS x', group: 'Bob', min: 0, max: 1, step: 0.01, unit: 'x' },
  idleAmplitude: { label: 'Idle drift', group: 'Bob', min: 0, max: 0.02, step: 0.0002, unit: 'm' },
  idleHz: { label: 'Idle rate', group: 'Bob', min: 0.05, max: 2, step: 0.01, unit: 'Hz' },

  kickBack: { label: 'Kick back', group: 'Kick', min: 0, max: 0.12, step: 0.001, unit: 'm/°' },
  kickUp: { label: 'Kick up', group: 'Kick', min: 0, max: 0.06, step: 0.001, unit: 'm/°' },
  kickPitch: { label: 'Kick pitch', group: 'Kick', min: 0, max: 8, step: 0.05, unit: '°/°' },
  kickRoll: { label: 'Kick roll', group: 'Kick', min: 0, max: 6, step: 0.05, unit: '°/°' },
  kickLateral: { label: 'Kick lateral', group: 'Kick', min: 0, max: 0.08, step: 0.001, unit: 'm/°' },

  reloadDropY: { label: 'Drop Y', group: 'Reload', min: -0.3, max: 0, step: 0.005, unit: 'm' },
  reloadDropZ: { label: 'Drop Z', group: 'Reload', min: -0.2, max: 0.2, step: 0.005, unit: 'm' },
  reloadPitch: { label: 'Reload pitch', group: 'Reload', min: -60, max: 20, step: 0.5, unit: '°' },
  reloadRoll: { label: 'Reload roll', group: 'Reload', min: -60, max: 60, step: 0.5, unit: '°' },
  reloadYaw: { label: 'Reload yaw', group: 'Reload', min: -40, max: 40, step: 0.5, unit: '°' },
  magThrow: { label: 'Mag travel', group: 'Reload', min: 0, max: 0.5, step: 0.005, unit: 'm' },
  chargeThrow: { label: 'Charge travel', group: 'Reload', min: 0, max: 0.15, step: 0.002, unit: 'm' },

  muzzleRight: { label: 'Muzzle right', group: 'Muzzle', min: -0.5, max: 0.5, step: 0.005, unit: 'm' },
  muzzleUp: { label: 'Muzzle up', group: 'Muzzle', min: -0.5, max: 0.5, step: 0.005, unit: 'm' },
  muzzleForward: { label: 'Muzzle forward', group: 'Muzzle', min: 0.05, max: 1.5, step: 0.01, unit: 'm' },
};

export const VIEWMODEL_CONFIG_KEYS = Object.keys(DEFAULT_VIEWMODEL_CONFIG) as Array<keyof ViewmodelConfig>;

export function cloneViewmodelConfig(src: ViewmodelConfig): ViewmodelConfig {
  return { ...src };
}

export function viewmodelConfigToSource(cfg: ViewmodelConfig): string {
  const lines = ['export const DEFAULT_VIEWMODEL_CONFIG: ViewmodelConfig = {'];
  let lastGroup = '';
  for (const key of VIEWMODEL_CONFIG_KEYS) {
    const meta = VIEWMODEL_TUNABLES[key];
    if (meta.group !== lastGroup) {
      if (lastGroup !== '') lines.push('');
      lines.push(`  // -- ${meta.group.toLowerCase()} --`);
      lastGroup = meta.group;
    }
    lines.push(`  ${key}: ${Math.round(cfg[key] * 1e5) / 1e5},`);
  }
  lines.push('};');
  return lines.join('\n');
}
