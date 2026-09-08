import type { WeaponDef } from '../WeaponDefs';

/**
 * The two light machine guns (brief S6.1): 100+ round magazines, 4 s reloads, 2x wall
 * penetration, the slowest ADS in the game.
 *
 * Penetration is the reason to carry one. The carbine's budget is 0.28 m of concrete
 * equivalent; these are 0.56 and 0.60, which is the difference between a thin steel panel
 * and the stack of crates somebody is hiding behind.
 *
 *  - **BASTION** is the marksman LMG: 650 RPM, 3-shot to 38 m, and a pattern that climbs
 *    almost vertically for twelve rounds before it starts to walk.
 *  - **MONOLITH** is volume: 800 RPM, 125 rounds, 4-shot everywhere, and a pattern that
 *    goes wide early and stays wide. You do not hold this one on a head; you hold it on a
 *    doorway.
 *
 * The 4 s reload is the balance. Both are effectively out of the fight twice a minute.
 */

export const LMG_BASTION: WeaponDef = {
  id: 'lmg_bastion',
  name: 'BASTION 249',
  class: 'LMG',
  slot: 'primary',

  damage: { near: 36, far: 28 },
  damageFalloff: { start: 30, end: 52 },
  headshotMult: 1.5,
  limbMult: 0.86,
  upperTorsoMult: 1,

  rpm: 650,
  magSize: 100,
  reserveAmmo: 200,
  reloadTime: 4.0,
  reloadEmptyTime: 4.6,
  adsTime: 0.42,
  sprintOutTime: 0.36,
  swapInTime: 0.78,
  swapOutTime: 0.62,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 4.2,
    hipMove: 6.8,
    ads: 0.16,
    crouchScale: 0.58,
    airScale: 3.0,
    perShot: 0.06,
    perShotMax: 1.6,
    recover: 2.6,
  },

  recoil: {
    // Twelve rounds of near-pure climb, then a slow, long lateral drift right that takes
    // another twenty to complete. Crouched, with the vertical countered, this is the most
    // accurate sustained-fire weapon in the game; standing, it is a wall of noise.
    kicks: [
      { x: 0.0, y: 0.7 },
      { x: 0.02, y: 0.66 },
      { x: -0.02, y: 0.62 },
      { x: 0.03, y: 0.58 },
      { x: -0.03, y: 0.54 },
      { x: 0.04, y: 0.5 },
      { x: -0.04, y: 0.46 },
      { x: 0.04, y: 0.43 },
      { x: -0.03, y: 0.4 },
      { x: 0.05, y: 0.37 },
      { x: 0.02, y: 0.35 },
      { x: 0.06, y: 0.33 },
      { x: 0.1, y: 0.31 },
      { x: 0.14, y: 0.3 },
      { x: 0.18, y: 0.28 },
      { x: 0.21, y: 0.27 },
      { x: 0.24, y: 0.26 },
      { x: 0.26, y: 0.25 },
      { x: 0.28, y: 0.24 },
      { x: 0.29, y: 0.24 },
      { x: 0.3, y: 0.23 },
      { x: 0.3, y: 0.23 },
      { x: 0.29, y: 0.22 },
      { x: 0.27, y: 0.22 },
      { x: 0.24, y: 0.21 },
      { x: 0.2, y: 0.21 },
      { x: 0.15, y: 0.21 },
      { x: 0.09, y: 0.2 },
      { x: 0.02, y: 0.2 },
      { x: -0.05, y: 0.2 },
      { x: -0.12, y: 0.2 },
      { x: -0.18, y: 0.19 },
      { x: -0.23, y: 0.19 },
      { x: -0.26, y: 0.19 },
      { x: -0.28, y: 0.19 },
      { x: -0.28, y: 0.18 },
      { x: -0.26, y: 0.18 },
      { x: -0.22, y: 0.18 },
      { x: -0.16, y: 0.18 },
      { x: -0.09, y: 0.18 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.1,
    recoverFraction: 0.8,
    recoverRate: 7.0,
    recoverDelay: 0.15,
    adsScale: 0.7,

    visualScale: 1.15,
    visualAttack: 0.03,
    visualSettle: 0.16,
  },

  penetration: 0.56,

  unlockLevel: 15,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.72,
  adsViewmodelFovScale: 0.8,
  tracerFraction: 0.25,
  shakePerShot: 0.07,
  muzzleFlashScale: 1.35,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.85,
    bodyFreq: 545,
    bodyQ: 1.9,
    bodyDecay: 0.15,
    bodyRatio: 0.2,
    tailDecay: 0.68,
    tailLevel: 0.34,
    tailFreq: 1650,
    clickFreq: 3400,
    clickLevel: 0.34,
    thumpFreq: 58,
    thumpLevel: 0.92,
    wet: 0.44,
  },
};

export const LMG_MONOLITH: WeaponDef = {
  id: 'lmg_monolith',
  name: 'MONOLITH 60',
  class: 'LMG',
  slot: 'primary',

  damage: { near: 31, far: 26 },
  damageFalloff: { start: 26, end: 46 },
  headshotMult: 1.45,
  limbMult: 0.88,
  upperTorsoMult: 1,

  rpm: 800,
  magSize: 125,
  reserveAmmo: 250,
  reloadTime: 4.4,
  reloadEmptyTime: 5.1,
  adsTime: 0.46,
  sprintOutTime: 0.4,
  swapInTime: 0.85,
  swapOutTime: 0.68,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 4.8,
    hipMove: 7.4,
    ads: 0.24,
    crouchScale: 0.56,
    airScale: 3.2,
    perShot: 0.05,
    perShotMax: 2.0,
    recover: 2.2,
  },

  recoil: {
    // Wide immediately and wide forever. Two full lateral sweeps in the first thirty
    // rounds, with the vertical flattening out early — the shape says "suppress", and the
    // gun is honest about it.
    kicks: [
      { x: 0.0, y: 0.52 },
      { x: 0.16, y: 0.48 },
      { x: 0.3, y: 0.44 },
      { x: 0.4, y: 0.4 },
      { x: 0.44, y: 0.36 },
      { x: 0.42, y: 0.33 },
      { x: 0.34, y: 0.3 },
      { x: 0.2, y: 0.28 },
      { x: 0.04, y: 0.26 },
      { x: -0.14, y: 0.25 },
      { x: -0.3, y: 0.24 },
      { x: -0.42, y: 0.23 },
      { x: -0.48, y: 0.22 },
      { x: -0.48, y: 0.22 },
      { x: -0.42, y: 0.21 },
      { x: -0.3, y: 0.21 },
      { x: -0.14, y: 0.2 },
      { x: 0.04, y: 0.2 },
      { x: 0.2, y: 0.2 },
      { x: 0.34, y: 0.19 },
      { x: 0.44, y: 0.19 },
      { x: 0.48, y: 0.19 },
      { x: 0.46, y: 0.18 },
      { x: 0.38, y: 0.18 },
      { x: 0.24, y: 0.18 },
      { x: 0.08, y: 0.18 },
      { x: -0.1, y: 0.18 },
      { x: -0.26, y: 0.17 },
      { x: -0.38, y: 0.17 },
      { x: -0.46, y: 0.17 },
      { x: -0.48, y: 0.17 },
      { x: -0.44, y: 0.17 },
      { x: -0.34, y: 0.16 },
      { x: -0.2, y: 0.16 },
      { x: -0.02, y: 0.16 },
      { x: 0.16, y: 0.16 },
      { x: 0.32, y: 0.16 },
      { x: 0.42, y: 0.16 },
      { x: 0.46, y: 0.16 },
      { x: 0.42, y: 0.15 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.05,
    recoverFraction: 0.84,
    recoverRate: 8.0,
    recoverDelay: 0.13,
    adsScale: 0.74,

    visualScale: 1.0,
    visualAttack: 0.026,
    visualSettle: 0.145,
  },

  penetration: 0.6,

  unlockLevel: 31,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.74,
  adsViewmodelFovScale: 0.82,
  tracerFraction: 0.34,
  shakePerShot: 0.05,
  muzzleFlashScale: 1.15,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.76,
    bodyFreq: 700,
    bodyQ: 1.45,
    bodyDecay: 0.105,
    bodyRatio: 0.24,
    tailDecay: 0.52,
    tailLevel: 0.3,
    tailFreq: 1950,
    clickFreq: 4000,
    clickLevel: 0.36,
    thumpFreq: 66,
    thumpLevel: 0.78,
    wet: 0.38,
  },
};

export const LMGS: readonly WeaponDef[] = [LMG_BASTION, LMG_MONOLITH];
