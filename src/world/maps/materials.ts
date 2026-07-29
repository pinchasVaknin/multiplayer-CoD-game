import { MATERIAL_KEYS, type MaterialKey } from './types';

/**
 * Physical and sensory properties of each map material (brief S6.4, S6.5, S6.7).
 *
 * `types.ts` names the materials; this file says what they *do* when a bullet, a boot
 * or a microphone meets them. It is the map DSL's material table: brushes reference a
 * material key, and penetration, impact debris, decals and footsteps all resolve
 * through here rather than special-casing geometry anywhere in gameplay code.
 *
 * Nothing here allocates at runtime — lookups are by index into a frozen table.
 */

export interface MaterialSurface {
  /**
   * Penetration cost per metre of material traversed, in the same units as a weapon's
   * `penetration` budget. 1.0 is poured concrete; steel plate is dearer per metre,
   * rubber and thin trim are cheap.
   */
  readonly penetrationDensity: number;

  /** Impact debris colour, 0xRRGGBB. Read as dust, sparks or rubber crumb. */
  readonly impactColor: number;
  /** Impact spark brightness, 0..1. Metal throws sparks; concrete throws dust. */
  readonly impactSpark: number;
  /** Decal darkness, 0..1. A hole in dark concrete needs less than one in pale floor. */
  readonly decalStrength: number;
  /** Decal radius, metres. */
  readonly decalRadius: number;

  /** Impact click centre frequency, Hz. */
  readonly impactFreq: number;
  /** Impact resonance. Metal rings, concrete does not. */
  readonly impactQ: number;
  /** Impact decay, seconds. */
  readonly impactDecay: number;

  /** Footstep band-pass centre at walking pace, Hz. */
  readonly stepFreq: number;
  /** Footstep resonance. */
  readonly stepQ: number;
  /** Footstep level scale. */
  readonly stepLevel: number;
}

const SURFACES: Readonly<Record<MaterialKey, MaterialSurface>> = {
  concrete: {
    penetrationDensity: 1.0,
    impactColor: 0xb8b2a6,
    impactSpark: 0.0,
    decalStrength: 0.85,
    decalRadius: 0.075,
    impactFreq: 1750,
    impactQ: 1.1,
    impactDecay: 0.1,
    stepFreq: 1500,
    stepQ: 0.9,
    stepLevel: 1.0,
  },
  concreteDark: {
    penetrationDensity: 1.15,
    impactColor: 0x9a958c,
    impactSpark: 0.0,
    decalStrength: 0.7,
    decalRadius: 0.08,
    impactFreq: 1560,
    impactQ: 1.1,
    impactDecay: 0.11,
    stepFreq: 1380,
    stepQ: 0.9,
    stepLevel: 1.0,
  },
  floor: {
    penetrationDensity: 1.0,
    impactColor: 0xc2c6cd,
    impactSpark: 0.0,
    decalStrength: 0.8,
    decalRadius: 0.07,
    impactFreq: 1650,
    impactQ: 1.0,
    impactDecay: 0.1,
    stepFreq: 1620,
    stepQ: 1.0,
    stepLevel: 1.0,
  },
  metal: {
    penetrationDensity: 1.9,
    impactColor: 0xffd08a,
    impactSpark: 1.0,
    decalStrength: 0.6,
    decalRadius: 0.05,
    impactFreq: 3200,
    impactQ: 5.5,
    impactDecay: 0.16,
    stepFreq: 2400,
    stepQ: 2.6,
    stepLevel: 1.12,
  },
  hazard: {
    penetrationDensity: 1.6,
    impactColor: 0xffc266,
    impactSpark: 0.7,
    decalStrength: 0.65,
    decalRadius: 0.055,
    impactFreq: 2900,
    impactQ: 4.0,
    impactDecay: 0.14,
    stepFreq: 2200,
    stepQ: 2.2,
    stepLevel: 1.08,
  },
  accent: {
    penetrationDensity: 0.9,
    impactColor: 0xffcf8f,
    impactSpark: 0.35,
    decalStrength: 0.6,
    decalRadius: 0.05,
    impactFreq: 2400,
    impactQ: 2.4,
    impactDecay: 0.12,
    stepFreq: 1900,
    stepQ: 1.6,
    stepLevel: 1.0,
  },
  rubber: {
    penetrationDensity: 0.5,
    impactColor: 0x4a4d54,
    impactSpark: 0.0,
    decalStrength: 0.5,
    decalRadius: 0.06,
    impactFreq: 700,
    impactQ: 0.7,
    impactDecay: 0.07,
    stepFreq: 620,
    stepQ: 0.65,
    stepLevel: 0.72,
  },
};

/** Indexed by the same integer `ColliderSet.materialAt` returns. */
const BY_INDEX: readonly MaterialSurface[] = MATERIAL_KEYS.map((key) => SURFACES[key]);

/** Fallback for an out-of-range index; never null, so no call site needs a guard. */
const DEFAULT_SURFACE: MaterialSurface = SURFACES.concrete;

export function surfaceOf(key: MaterialKey): MaterialSurface {
  return SURFACES[key];
}

/** Resolve a collider's material index (from `ColliderSet.materialAt`) to a surface. */
export function surfaceAtIndex(index: number): MaterialSurface {
  return BY_INDEX[index] ?? DEFAULT_SURFACE;
}

export function materialKeyAtIndex(index: number): MaterialKey {
  return MATERIAL_KEYS[index] ?? 'concrete';
}
