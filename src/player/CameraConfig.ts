import { DEG2RAD } from '../core/MathUtil';
import type { TunableMeta } from './MovementConfig';

/**
 * Camera feel (brief S5.4). Separate from MovementConfig because these numbers are
 * tuned against a different question — "does it read?" rather than "does it play?" —
 * but they live under the same tuning panel and the same copy-to-clipboard button.
 */
export interface CameraConfig {
  /** Default world FOV, degrees. The 60-120 slider writes this. */
  fov: number;
  /** Viewmodel FOV, degrees. Plumbed now; M2 hangs a weapon off it. */
  viewmodelFov: number;

  fovSprintAdd: number;
  fovTacSprintAdd: number;
  fovSlideAdd: number;
  /** Multiplier applied while ADS is held. */
  fovAdsScale: number;
  /** How fast the FOV chases its target, per second. */
  fovRate: number;

  /** Peak vertical bob at `bobRefSpeed`, metres. */
  bobAmplitude: number;
  bobLateralScale: number;
  bobRefSpeed: number;
  bobRollDeg: number;

  /** Deepest a landing may push the camera, metres. */
  landDipMax: number;
  /** Impact speed that produces a full-depth dip, m/s. */
  landDipRefSpeed: number;
  landDipSpring: number;
  landDipDamping: number;

  slideRollDeg: number;
  strafeRollDeg: number;
  rollRate: number;

  /** Trauma lost per second. Higher = shorter shake. */
  shakeDecay: number;
  shakeYawDeg: number;
  shakePitchDeg: number;
  shakeRollDeg: number;
  /** Base shake frequency, Hz. Kept low; see S5.4. */
  shakeFrequency: number;
}

export const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  fov: 90,
  viewmodelFov: 65,

  fovSprintAdd: 5,
  fovTacSprintAdd: 11,
  fovSlideAdd: 13,
  fovAdsScale: 0.74,
  fovRate: 9,

  bobAmplitude: 0.032,
  bobLateralScale: 0.65,
  bobRefSpeed: 6.9,
  bobRollDeg: 0.45,

  landDipMax: 0.15,
  landDipRefSpeed: 12,
  landDipSpring: 95,
  landDipDamping: 13,

  slideRollDeg: 4.5,
  strafeRollDeg: 0.9,
  rollRate: 9,

  shakeDecay: 3.4,
  shakeYawDeg: 1.1,
  shakePitchDeg: 1.1,
  shakeRollDeg: 1.6,
  shakeFrequency: 6.1,
};

export const FOV_MIN = 60;
export const FOV_MAX = 120;

export const CAMERA_TUNABLES: Readonly<Record<keyof CameraConfig, TunableMeta>> = {
  fov: { label: 'World FOV', group: 'Camera', min: FOV_MIN, max: FOV_MAX, step: 1, unit: '°' },
  viewmodelFov: { label: 'Viewmodel FOV', group: 'Camera', min: 40, max: 110, step: 1, unit: '°' },
  fovSprintAdd: { label: 'Sprint FOV +', group: 'Camera', min: 0, max: 25, step: 0.5, unit: '°' },
  fovTacSprintAdd: { label: 'Tac FOV +', group: 'Camera', min: 0, max: 30, step: 0.5, unit: '°' },
  fovSlideAdd: { label: 'Slide FOV +', group: 'Camera', min: 0, max: 30, step: 0.5, unit: '°' },
  fovAdsScale: { label: 'ADS FOV x', group: 'Camera', min: 0.4, max: 1, step: 0.01, unit: 'x' },
  fovRate: { label: 'FOV rate', group: 'Camera', min: 1, max: 30, step: 0.5, unit: '/s' },

  bobAmplitude: { label: 'Bob amount', group: 'Bob', min: 0, max: 0.12, step: 0.002, unit: 'm' },
  bobLateralScale: { label: 'Bob lateral', group: 'Bob', min: 0, max: 2, step: 0.05, unit: 'x' },
  bobRefSpeed: { label: 'Bob ref speed', group: 'Bob', min: 1, max: 12, step: 0.1, unit: 'm/s' },
  bobRollDeg: { label: 'Bob roll', group: 'Bob', min: 0, max: 3, step: 0.05, unit: '°' },

  landDipMax: { label: 'Land dip', group: 'Landing', min: 0, max: 0.5, step: 0.005, unit: 'm' },
  landDipRefSpeed: { label: 'Dip ref speed', group: 'Landing', min: 2, max: 30, step: 0.5, unit: 'm/s' },
  landDipSpring: { label: 'Dip spring', group: 'Landing', min: 10, max: 300, step: 5, unit: '' },
  landDipDamping: { label: 'Dip damping', group: 'Landing', min: 1, max: 40, step: 0.5, unit: '' },

  slideRollDeg: { label: 'Slide roll', group: 'Roll', min: 0, max: 15, step: 0.25, unit: '°' },
  strafeRollDeg: { label: 'Strafe roll', group: 'Roll', min: 0, max: 6, step: 0.05, unit: '°' },
  rollRate: { label: 'Roll rate', group: 'Roll', min: 1, max: 30, step: 0.5, unit: '/s' },

  shakeDecay: { label: 'Decay', group: 'Shake', min: 0.5, max: 12, step: 0.1, unit: '/s' },
  shakeYawDeg: { label: 'Yaw', group: 'Shake', min: 0, max: 6, step: 0.05, unit: '°' },
  shakePitchDeg: { label: 'Pitch', group: 'Shake', min: 0, max: 6, step: 0.05, unit: '°' },
  shakeRollDeg: { label: 'Roll', group: 'Shake', min: 0, max: 8, step: 0.05, unit: '°' },
  shakeFrequency: { label: 'Frequency', group: 'Shake', min: 1, max: 20, step: 0.1, unit: 'Hz' },
};

export const CAMERA_CONFIG_KEYS = Object.keys(DEFAULT_CAMERA_CONFIG) as Array<keyof CameraConfig>;

export function cameraConfigToSource(cfg: CameraConfig): string {
  const lines: string[] = ['export const DEFAULT_CAMERA_CONFIG: CameraConfig = {'];
  let lastGroup = '';
  for (const key of CAMERA_CONFIG_KEYS) {
    const meta = CAMERA_TUNABLES[key];
    if (meta.group !== lastGroup) {
      if (lastGroup !== '') lines.push('');
      lines.push(`  // -- ${meta.group.toLowerCase()} --`);
      lastGroup = meta.group;
    }
    lines.push(`  ${key}: ${Math.round(cfg[key] * 1e4) / 1e4},`);
  }
  lines.push('};');
  return lines.join('\n');
}

export function degToRad(v: number): number {
  return v * DEG2RAD;
}
