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
  /**
   * Decal half-size, metres, before `DecalField.place`'s per-hole jitter.
   *
   * Halved across the board in playtest round 5 (F3), which reported *"soft black blobs 30-40cm
   * across"*. They were: the plane spanned 7.6-26.4 cm and what the eye actually reads is the
   * texture's pale rim at `DECAL_RIM_FRACTION` of it, so the visible smudge ran to 25 cm on
   * sand. These are chosen against a target rather than nudged — see `DECAL_RIM_FRACTION` — and
   * `npm run readability` prints the resulting centimetres and fails if they leave the range.
   *
   * The spread between materials is kept deliberately: a round spalls wider out of plaster than
   * it does out of steel grating, and flattening that would trade one wrong picture for another.
   */
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

/**
 * What a bullet decal's texture actually draws, as fractions of the quad it is mapped onto.
 *
 * `buildDecalTexture` paints a dark hole inside a pale rim, and both are authored as radii in a
 * 64px square — so a `decalRadius` in metres means nothing on its own. These two numbers are
 * what turn it into a size somebody can argue about, and they live here rather than beside the
 * canvas code because they are the units `decalRadius` is denominated in.
 *
 * Diameters, as fractions of the quad's width: the hole is `2 x 0.22` and the rim `2 x 0.48`.
 * The rim is the one that matters — it is the outer edge of anything visible, and therefore the
 * number F3 was reporting when it said 30-40 cm.
 */
export const DECAL_HOLE_FRACTION = 0.44;
export const DECAL_RIM_FRACTION = 0.96;

/**
 * The rim diameter every `decalRadius` above is chosen to land inside, metres.
 *
 * A rifle strike is a hole a couple of centimetres across with spalling around it, so 5-12 cm
 * of *visible mark* is the target and the per-material spread lives inside it. Asserted by
 * `npm run readability`, which multiplies `decalRadius` back out through the jitter and the rim
 * fraction — so a value edited here without thinking fails the gate rather than shipping.
 */
export const DECAL_RIM_MIN_M = 0.05;
export const DECAL_RIM_MAX_M = 0.12;

const SURFACES: Readonly<Record<MaterialKey, MaterialSurface>> = {
  concrete: {
    penetrationDensity: 1.0,
    impactColor: 0xb8b2a6,
    impactSpark: 0.0,
    decalStrength: 0.85,
    decalRadius: 0.041,
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
    decalRadius: 0.042,
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
    decalRadius: 0.039,
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
    decalRadius: 0.033,
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
    decalRadius: 0.034,
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
    decalRadius: 0.033,
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
    decalRadius: 0.036,
    impactFreq: 700,
    impactQ: 0.7,
    impactDecay: 0.07,
    stepFreq: 620,
    stepQ: 0.65,
    stepLevel: 0.72,
  },

  // ---- M4 -----------------------------------------------------------------

  /**
   * Fired brick. Slightly cheaper per metre than poured concrete and much louder to walk
   * on than either, which is what makes Foundry's shell read as a different building from
   * its interior even with the lights off.
   */
  brick: {
    penetrationDensity: 0.88,
    impactColor: 0xa2705c,
    impactSpark: 0.0,
    decalStrength: 0.8,
    decalRadius: 0.044,
    impactFreq: 1400,
    impactQ: 1.4,
    impactDecay: 0.12,
    stepFreq: 1250,
    stepQ: 1.1,
    stepLevel: 1.05,
  },

  /**
   * Corroded container plate. Thinner and pitted, so it costs less per metre than clean
   * steel and a round gets through a container wall with damage left — which is the point
   * of stacking them in a lane.
   */
  rust: {
    penetrationDensity: 1.35,
    impactColor: 0xc08a4e,
    impactSpark: 0.75,
    decalStrength: 0.68,
    decalRadius: 0.036,
    impactFreq: 2600,
    impactQ: 3.4,
    impactDecay: 0.19,
    stepFreq: 2100,
    stepQ: 2.2,
    stepLevel: 1.15,
  },

  /**
   * Catwalk grating. Mostly holes, so it is the cheapest metal on the map to shoot
   * through — the deck above you is cover you can be killed through, and it should sound
   * like it: bright, ringing, and the loudest thing to run across.
   */
  grate: {
    penetrationDensity: 0.72,
    impactColor: 0xffd9a4,
    impactSpark: 1.0,
    decalStrength: 0.45,
    decalRadius: 0.031,
    impactFreq: 3800,
    impactQ: 7.0,
    impactDecay: 0.22,
    stepFreq: 2900,
    stepQ: 3.4,
    stepLevel: 1.24,
  },

  // ---- M8: Dunes ----------------------------------------------------------

  /**
   * Loose sand. The cheapest thing on any map to shoot through and the quietest to walk
   * on — which is a real tactical property, not flavour: a sand berm is concealment and
   * not cover, and a player crossing an open street on Dunes is genuinely harder to hear
   * than one crossing Foundry's steel floor.
   */
  sand: {
    penetrationDensity: 0.42,
    impactColor: 0xd8bd90,
    impactSpark: 0.0,
    decalStrength: 0.42,
    decalRadius: 0.052,
    impactFreq: 620,
    impactQ: 0.55,
    impactDecay: 0.07,
    stepFreq: 780,
    stepQ: 0.6,
    stepLevel: 0.66,
  },

  /**
   * Mud plaster over block. Slightly softer than poured concrete and considerably softer
   * than brick, so a Dunes village wall is a wall you can shoot a man through if you know
   * he is behind it — which is what stops the alleys being a safe route rather than a
   * risky one.
   */
  plaster: {
    penetrationDensity: 0.74,
    impactColor: 0xd4bb96,
    impactSpark: 0.0,
    decalStrength: 0.78,
    decalRadius: 0.047,
    impactFreq: 1250,
    impactQ: 0.95,
    impactDecay: 0.11,
    stepFreq: 1180,
    stepQ: 0.85,
    stepLevel: 0.94,
  },

  /** Fired roof tile. Brittle, bright, and it shatters rather than absorbing. */
  clayTile: {
    penetrationDensity: 0.66,
    impactColor: 0xe08a58,
    impactSpark: 0.15,
    decalStrength: 0.72,
    decalRadius: 0.042,
    impactFreq: 2050,
    impactQ: 2.6,
    impactDecay: 0.13,
    stepFreq: 1750,
    stepQ: 1.7,
    stepLevel: 1.02,
  },

  /**
   * Plank. Shared by Dunes' stalls and Depot's pallets. Cheap to penetrate and it *sounds*
   * cheap — a hollow knock rather than a crack, which is the cue that tells you the thing
   * you are hiding behind is not going to hold.
   */
  wood: {
    penetrationDensity: 0.48,
    impactColor: 0xc09a62,
    impactSpark: 0.0,
    decalStrength: 0.66,
    decalRadius: 0.039,
    impactFreq: 980,
    impactQ: 1.9,
    impactDecay: 0.14,
    stepFreq: 900,
    stepQ: 1.5,
    stepLevel: 1.06,
  },

  // ---- M8: Depot ----------------------------------------------------------

  /** Yard asphalt. Between concrete and rubber: dense enough to stop a round, dull to walk on. */
  asphalt: {
    penetrationDensity: 1.05,
    impactColor: 0x8e939c,
    impactSpark: 0.0,
    decalStrength: 0.88,
    decalRadius: 0.041,
    impactFreq: 1180,
    impactQ: 0.8,
    impactDecay: 0.09,
    stepFreq: 1120,
    stepQ: 0.75,
    stepLevel: 0.88,
  },

  /**
   * Painted container plate. Dearer per metre than `rust` — the paint is still on it, so
   * the plate has not been eaten thin — which means a Depot stack is harder to shoot
   * through than a Foundry one. That difference is load-bearing on a map whose cover *is*
   * containers: the stacks have to be worth climbing rather than worth shooting through.
   */
  paintedSteel: {
    penetrationDensity: 1.62,
    impactColor: 0xa8d0d4,
    impactSpark: 0.85,
    decalStrength: 0.62,
    decalRadius: 0.034,
    impactFreq: 2850,
    impactQ: 4.2,
    impactDecay: 0.2,
    stepFreq: 2250,
    stepQ: 2.4,
    stepLevel: 1.18,
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
