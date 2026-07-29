/**
 * Weapon data (brief S6.1). Plain objects, no subclass per weapon.
 *
 * M5 adds eleven more entries to this file and writes no new classes to do it: every
 * behavioural difference between weapons has to be expressible as a number here, which
 * is the constraint that keeps the weapon *system* the deliverable rather than the AR.
 *
 * Angles are in degrees throughout, because that is the unit these get tuned in.
 * Conversion happens once, at the point of use.
 *
 * The debug panel's slider metadata and accessors live in `WeaponTuning.ts`, derived from
 * these types rather than hand-listed alongside them.
 */

export type WeaponClass = 'AR' | 'SMG' | 'LMG' | 'MARKSMAN' | 'SNIPER' | 'SHOTGUN' | 'PISTOL' | 'LAUNCHER';

export type AttachmentSlot =
  | 'optic'
  | 'muzzle'
  | 'barrel'
  | 'underbarrel'
  | 'magazine'
  | 'stock'
  | 'laser'
  | 'rearGrip';

/** One authored recoil step, degrees. +y is up, +x is right. */
export interface RecoilKick {
  readonly x: number;
  readonly y: number;
}

export interface RecoilPattern {
  /** Authored per-shot kicks, cycling once the array ends (S6.2). */
  readonly kicks: readonly RecoilKick[];

  verticalScale: number;
  horizontalScale: number;
  /** The opening shot is punchier than the pattern alone; this scales only shot 1. */
  firstShotScale: number;
  /**
   * Fraction of each kick the camera takes back during recovery. The remainder is
   * permanent aim drift — the residual that makes a spray feel earned (S6.2).
   */
  recoverFraction: number;
  /** Exponential recovery rate toward the settled aim, per second. */
  recoverRate: number;
  /** Quiet time after the last shot before recovery starts, seconds. */
  recoverDelay: number;
  /** Aim-recoil multiplier while fully aimed down sights. */
  adsScale: number;

  /** Viewmodel kick, independent of the aim change (S6.2 ships both). */
  visualScale: number;
  /** Viewmodel kick attack time, seconds. Fast. */
  visualAttack: number;
  /** Viewmodel kick settle time, seconds. Slower. */
  visualSettle: number;
}

/** Random cone on top of the pattern, degrees of half-angle. */
export interface SpreadProfile {
  hipStand: number;
  hipMove: number;
  ads: number;
  /** Multiplier while crouched. */
  crouchScale: number;
  /** Multiplier while airborne. */
  airScale: number;
  /** Added per shot fired, degrees. */
  perShot: number;
  /** Ceiling on the per-shot bloom, degrees. */
  perShotMax: number;
  /** Bloom recovery, degrees per second. */
  recover: number;
}

/** Synthesis parameters for this weapon's voice (S6.7). */
export interface WeaponVoice {
  level: number;
  /** Body noise band centre, Hz. The single biggest character control. */
  bodyFreq: number;
  bodyQ: number;
  bodyDecay: number;
  /** Tail length, seconds. Long tails read as big rooms and big calibres. */
  tailDecay: number;
  tailLevel: number;
  clickFreq: number;
  clickLevel: number;
  thumpFreq: number;
  thumpLevel: number;
  /** Reverb send, 0..1. */
  wet: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  class: WeaponClass;

  damage: { near: number; far: number };
  /** Metres. Damage is `near` at or below `start` and `far` at or beyond `end`. */
  damageFalloff: { start: number; end: number };
  headshotMult: number;
  limbMult: number;

  rpm: number;
  magSize: number;
  reserveAmmo: number;
  reloadTime: number;
  reloadEmptyTime: number;
  /** Seconds from ADS press to fully aimed. */
  adsTime: number;
  /** Sprint-to-fire, seconds. A core balance lever (S6.6). */
  sprintOutTime: number;

  spread: SpreadProfile;
  recoil: RecoilPattern;

  /** Penetration budget, in metres of poured concrete. See world/maps/materials.ts. */
  penetration: number;
  /** Absent = hitscan (S4.4). Only launchers and thrown equipment set this. */
  projectileSpeed?: number;

  unlockLevel: number;
  attachmentSlots: AttachmentSlot[];

  // -- extensions beyond the S6.1 list, all feel numbers ------------------
  /** World FOV multiplier at full ADS. */
  adsFovScale: number;
  /** Viewmodel FOV multiplier at full ADS. */
  adsViewmodelFovScale: number;
  /** Fraction of shots that draw a tracer (S6.5 asks for roughly 1 in 3). */
  tracerFraction: number;
  /** Camera shake trauma added per shot, 0..1. */
  shakePerShot: number;
  /** Muzzle rise felt as a kick on the weapon's own axis; scales the flash too. */
  muzzleFlashScale: number;

  voice: WeaponVoice;
}

/**
 * The M2 arsenal. One assault rifle.
 *
 * 3-shot kill inside 26 m, 4-shot beyond 42 m, 700 RPM: a 0.17 s best-case TTK, which
 * is the CoD band this whole project is aiming at.
 */
export const AR_DEFAULT: WeaponDef = {
  id: 'ar_default',
  name: 'M4 CARBINE',
  class: 'AR',

  damage: { near: 34, far: 25 },
  damageFalloff: { start: 26, end: 42 },
  headshotMult: 2.0,
  limbMult: 0.9,

  rpm: 700,
  magSize: 30,
  reserveAmmo: 240,
  reloadTime: 2.05,
  reloadEmptyTime: 2.85,
  adsTime: 0.28,
  sprintOutTime: 0.22,

  spread: {
    hipStand: 1.9,
    hipMove: 3.4,
    ads: 0.18,
    crouchScale: 0.74,
    airScale: 2.1,
    perShot: 0.085,
    perShotMax: 1.4,
    recover: 3.6,
  },

  recoil: {
    // Learnable and counterable (S6.2): a steep, controllable vertical climb for the
    // first five, then a lateral S that starts on shot 6 and reverses twice. Anyone who
    // has learned it can hold a 30-round spray on a torso; anyone who has not cannot.
    kicks: [
      { x: 0.0, y: 0.62 },
      { x: 0.05, y: 0.58 },
      { x: -0.06, y: 0.55 },
      { x: 0.08, y: 0.52 },
      { x: -0.05, y: 0.48 },
      { x: 0.14, y: 0.42 },
      { x: 0.22, y: 0.38 },
      { x: 0.28, y: 0.34 },
      { x: 0.3, y: 0.3 },
      { x: 0.26, y: 0.27 },
      { x: 0.14, y: 0.25 },
      { x: -0.06, y: 0.23 },
      { x: -0.22, y: 0.22 },
      { x: -0.3, y: 0.21 },
      { x: -0.32, y: 0.2 },
      { x: -0.24, y: 0.19 },
      { x: -0.1, y: 0.18 },
      { x: 0.06, y: 0.18 },
      { x: 0.18, y: 0.17 },
      { x: 0.24, y: 0.17 },
      { x: 0.2, y: 0.16 },
      { x: 0.1, y: 0.16 },
      { x: -0.02, y: 0.15 },
      { x: -0.14, y: 0.15 },
      { x: -0.2, y: 0.14 },
      { x: -0.18, y: 0.14 },
      { x: -0.08, y: 0.14 },
      { x: 0.04, y: 0.13 },
      { x: 0.14, y: 0.13 },
      { x: 0.18, y: 0.12 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.15,
    recoverFraction: 0.82,
    recoverRate: 9.5,
    // Longer than the 0.086 s shot interval at 700 RPM, on purpose: a sustained spray
    // must keep climbing, and recovery is what a player earns by letting go.
    recoverDelay: 0.12,
    adsScale: 0.78,

    visualScale: 1.0,
    visualAttack: 0.028,
    visualSettle: 0.13,
  },

  penetration: 0.28,

  unlockLevel: 1,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock'],

  adsFovScale: 0.76,
  adsViewmodelFovScale: 0.82,
  tracerFraction: 0.34,
  shakePerShot: 0.055,
  muzzleFlashScale: 1.0,

  voice: {
    level: 0.62,
    bodyFreq: 1150,
    bodyQ: 0.85,
    bodyDecay: 0.085,
    tailDecay: 0.32,
    tailLevel: 0.2,
    clickFreq: 5200,
    clickLevel: 0.4,
    thumpFreq: 88,
    thumpLevel: 0.5,
    wet: 0.3,
  },
};

export const WEAPON_DEFS: Readonly<Record<string, WeaponDef>> = {
  [AR_DEFAULT.id]: AR_DEFAULT,
};

export function cloneWeaponDef(src: WeaponDef): WeaponDef {
  return {
    ...src,
    damage: { ...src.damage },
    damageFalloff: { ...src.damageFalloff },
    spread: { ...src.spread },
    recoil: { ...src.recoil, kicks: src.recoil.kicks },
    attachmentSlots: [...src.attachmentSlots],
    voice: { ...src.voice },
  };
}

/** Seconds between shots. */
export function shotInterval(def: WeaponDef): number {
  return 60 / Math.max(def.rpm, 1);
}
