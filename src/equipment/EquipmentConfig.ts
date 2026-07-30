import type { TunableMeta } from '../player/MovementConfig';

/**
 * Every number that decides how equipment feels, in one place (brief S3).
 *
 * Same contract as `MovementConfig`: the `Record<keyof EquipmentConfig, TunableMeta>` below
 * makes a field without a slider a compile error, so the tuning panel cannot drift.
 */
export interface EquipmentConfig {
  /** Downward acceleration on a thrown object, m/s². */
  gravity: number;
  /** Air drag as a fraction of speed lost per second. */
  drag: number;

  /** Metres in front of the eye a grenade leaves from. */
  throwOffsetForward: number;
  throwOffsetUp: number;
  /** Inherited fraction of the thrower's own velocity. */
  throwInheritVelocity: number;

  /** Metres from the player inside which a live grenade raises the indicator (S6.3). */
  indicatorRadius: number;
  /** Seconds between indicator beeps. */
  beepInterval: number;

  /**
   * Degrees off the target's facing at which a flash has half its effect.
   *
   * The scaling S6.3 asks for. 0 deg is a full flash, 180 deg is the floor below.
   */
  flashHalfAngleDeg: number;
  /** Effect floor for someone facing directly away, as a fraction. */
  flashRearFraction: number;
  /** Effect multiplier for someone with no line of sight to the blast. */
  flashNoLosFraction: number;
  /** Seconds of white-out before the fade begins, as a fraction of total. */
  flashHoldFraction: number;
  /** Low-pass cutoff at full flash, Hz. */
  flashMuffleHz: number;

  /**
   * Optical depth at which a smoke volume stops a sight line.
   *
   * The occluder integrates path length through every live cloud and compares the total
   * against this, so two thin clouds in a row can block what neither would alone — which
   * is what "density-based occluder" means and is why it is not a sphere-intersection test.
   */
  smokeBlockDepth: number;
  /** Metres of travel through a full-density cloud that produce one unit of depth. */
  smokeDepthScale: number;

  /** Claymore: seconds between proximity checks. Cheap, and nobody crosses it in 0.1 s. */
  triggerInterval: number;
  /** Seconds between the trigger firing and the charge going off. */
  triggerDelay: number;

  /** Camera shake trauma at the centre of a blast, 0..1. */
  blastShake: number;
}

export const DEFAULT_EQUIPMENT_CONFIG: EquipmentConfig = {
  gravity: 18,
  drag: 0.12,

  throwOffsetForward: 0.45,
  throwOffsetUp: -0.08,
  throwInheritVelocity: 0.5,

  indicatorRadius: 9,
  beepInterval: 0.45,

  flashHalfAngleDeg: 62,
  flashRearFraction: 0.12,
  flashNoLosFraction: 0.25,
  flashHoldFraction: 0.35,
  flashMuffleHz: 340,

  smokeBlockDepth: 1,
  smokeDepthScale: 2.2,

  triggerInterval: 0.1,
  triggerDelay: 0.28,

  blastShake: 0.85,
};

export const EQUIPMENT_TUNABLES: Readonly<Record<keyof EquipmentConfig, TunableMeta>> = {
  gravity: { label: 'Gravity', group: 'Throw', min: 5, max: 40, step: 0.5, unit: 'm/s²' },
  drag: { label: 'Drag', group: 'Throw', min: 0, max: 1, step: 0.01, unit: '/s' },
  throwOffsetForward: { label: 'Release fwd', group: 'Throw', min: 0, max: 1.2, step: 0.01, unit: 'm' },
  throwOffsetUp: { label: 'Release up', group: 'Throw', min: -0.5, max: 0.5, step: 0.01, unit: 'm' },
  throwInheritVelocity: { label: 'Inherit vel', group: 'Throw', min: 0, max: 1, step: 0.05, unit: 'x' },

  indicatorRadius: { label: 'Indicator range', group: 'Warning', min: 2, max: 25, step: 0.5, unit: 'm' },
  beepInterval: { label: 'Beep interval', group: 'Warning', min: 0.1, max: 1.5, step: 0.05, unit: 's' },

  flashHalfAngleDeg: { label: 'Half angle', group: 'Flash', min: 15, max: 180, step: 1, unit: '°' },
  flashRearFraction: { label: 'Facing away', group: 'Flash', min: 0, max: 0.6, step: 0.01, unit: 'x' },
  flashNoLosFraction: { label: 'No LOS', group: 'Flash', min: 0, max: 1, step: 0.01, unit: 'x' },
  flashHoldFraction: { label: 'White-out hold', group: 'Flash', min: 0, max: 0.9, step: 0.01, unit: 'x' },
  flashMuffleHz: { label: 'Muffle cutoff', group: 'Flash', min: 120, max: 2000, step: 10, unit: 'Hz' },

  smokeBlockDepth: { label: 'Block depth', group: 'Smoke', min: 0.2, max: 4, step: 0.05, unit: '' },
  smokeDepthScale: { label: 'Depth / metre', group: 'Smoke', min: 0.2, max: 8, step: 0.1, unit: '/m' },

  triggerInterval: { label: 'Trigger poll', group: 'Claymore', min: 0.02, max: 0.5, step: 0.01, unit: 's' },
  triggerDelay: { label: 'Trigger delay', group: 'Claymore', min: 0, max: 1, step: 0.01, unit: 's' },

  blastShake: { label: 'Blast shake', group: 'Blast', min: 0, max: 1.5, step: 0.05, unit: '' },
};

export const EQUIPMENT_CONFIG_KEYS = Object.keys(DEFAULT_EQUIPMENT_CONFIG) as Array<keyof EquipmentConfig>;

export function cloneEquipmentConfig(src: EquipmentConfig): EquipmentConfig {
  return { ...src };
}

/** Serialise a tuned config back into pasteable TypeScript source. */
export function equipmentConfigToSource(cfg: EquipmentConfig): string {
  const lines: string[] = ['export const DEFAULT_EQUIPMENT_CONFIG: EquipmentConfig = {'];
  let lastGroup = '';
  for (const key of EQUIPMENT_CONFIG_KEYS) {
    const meta = EQUIPMENT_TUNABLES[key];
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
