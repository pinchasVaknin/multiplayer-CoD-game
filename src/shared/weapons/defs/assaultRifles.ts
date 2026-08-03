import type { WeaponDef } from '../WeaponDefs';

/**
 * The four assault rifles (brief S6.1).
 *
 * The brief's constraint is the interesting part: *differentiate by RPM, ADS time, falloff
 * and pattern shape, not by damage alone*. So all four are 3-4 shot kills and the axis each
 * one lives on is different:
 *
 *  - **CARBINE** is the baseline. 700 RPM, 3-shot to 27 m. Every other weapon in the game
 *    is read against this one, and its pattern is the one M2 verified — untouched.
 *  - **VULCAN** trades rate for reach and recoil. 3-shot to 31 m, but the pattern pulls
 *    hard left after shot 4 and never comes back, so it punishes a held trigger.
 *  - **HALCYON** is the fastest close-quarters AR — 3-shot inside 15 m — and the worst
 *    beyond it. Fastest ADS of the class, mildest pattern: the AR you can use like an SMG.
 *  - **LONGBOW** is a semi-automatic-feeling 480 RPM that 3-shots to 55 m. The pattern is
 *    a hard alternating zig-zag: cheap to counter if you tap, brutal if you hold.
 *
 * Every pattern below is hand-authored. None is generated, and no two share a shape.
 */

export const AR_CARBINE: WeaponDef = {
  id: 'ar_carbine',
  name: 'M4 CARBINE',
  class: 'AR',
  slot: 'primary',

  damage: { near: 34, far: 25 },
  damageFalloff: { start: 26, end: 42 },
  headshotMult: 1.5,
  limbMult: 0.9,
  upperTorsoMult: 1,

  rpm: 700,
  magSize: 30,
  reserveAmmo: 240,
  reloadTime: 2.05,
  reloadEmptyTime: 2.85,
  adsTime: 0.28,
  sprintOutTime: 0.22,
  swapInTime: 0.52,
  swapOutTime: 0.4,

  pellets: 1,
  pelletSpread: 0,

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
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.76,
  adsViewmodelFovScale: 0.82,
  tracerFraction: 0.34,
  shakePerShot: 0.055,
  muzzleFlashScale: 1.0,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.62,
    bodyFreq: 1150,
    bodyQ: 0.85,
    bodyDecay: 0.085,
    bodyRatio: 0.32,
    tailDecay: 0.32,
    tailLevel: 0.2,
    tailFreq: 2600,
    clickFreq: 5200,
    clickLevel: 0.4,
    thumpFreq: 88,
    thumpLevel: 0.5,
    wet: 0.3,
  },
};

export const AR_VULCAN: WeaponDef = {
  id: 'ar_vulcan',
  name: 'VULCAN 74',
  class: 'AR',
  slot: 'primary',

  damage: { near: 38, far: 28 },
  damageFalloff: { start: 24, end: 40 },
  headshotMult: 1.5,
  limbMult: 0.88,
  upperTorsoMult: 1,

  rpm: 620,
  magSize: 30,
  reserveAmmo: 210,
  reloadTime: 2.25,
  reloadEmptyTime: 3.1,
  adsTime: 0.31,
  sprintOutTime: 0.25,
  swapInTime: 0.58,
  swapOutTime: 0.45,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 2.3,
    hipMove: 4.1,
    ads: 0.2,
    crouchScale: 0.72,
    airScale: 2.3,
    perShot: 0.1,
    perShotMax: 1.7,
    recover: 3.2,
  },

  recoil: {
    // The AK shape: four heavy vertical shots, then it walks left and stays there. The
    // reversal on shot 18 is small and late on purpose — this gun is meant to be tapped
    // in bursts of four, and the pattern is what tells you so.
    kicks: [
      { x: 0.02, y: 0.86 },
      { x: -0.05, y: 0.8 },
      { x: -0.14, y: 0.74 },
      { x: -0.26, y: 0.66 },
      { x: -0.38, y: 0.55 },
      { x: -0.46, y: 0.46 },
      { x: -0.5, y: 0.4 },
      { x: -0.5, y: 0.35 },
      { x: -0.46, y: 0.32 },
      { x: -0.42, y: 0.29 },
      { x: -0.36, y: 0.27 },
      { x: -0.32, y: 0.26 },
      { x: -0.28, y: 0.25 },
      { x: -0.24, y: 0.24 },
      { x: -0.18, y: 0.23 },
      { x: -0.1, y: 0.23 },
      { x: -0.02, y: 0.22 },
      { x: 0.08, y: 0.22 },
      { x: 0.18, y: 0.21 },
      { x: 0.26, y: 0.21 },
      { x: 0.3, y: 0.2 },
      { x: 0.28, y: 0.2 },
      { x: 0.22, y: 0.19 },
      { x: 0.12, y: 0.19 },
      { x: 0.0, y: 0.19 },
      { x: -0.12, y: 0.18 },
      { x: -0.22, y: 0.18 },
      { x: -0.28, y: 0.18 },
      { x: -0.3, y: 0.17 },
      { x: -0.26, y: 0.17 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.22,
    recoverFraction: 0.76,
    recoverRate: 8.2,
    recoverDelay: 0.14,
    adsScale: 0.8,

    visualScale: 1.25,
    visualAttack: 0.03,
    visualSettle: 0.155,
  },

  penetration: 0.36,

  unlockLevel: 6,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.76,
  adsViewmodelFovScale: 0.82,
  tracerFraction: 0.34,
  shakePerShot: 0.075,
  muzzleFlashScale: 1.25,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.72,
    bodyFreq: 890,
    bodyQ: 1.35,
    bodyDecay: 0.115,
    bodyRatio: 0.26,
    tailDecay: 0.44,
    tailLevel: 0.28,
    tailFreq: 2100,
    clickFreq: 4200,
    clickLevel: 0.38,
    thumpFreq: 70,
    thumpLevel: 0.72,
    wet: 0.34,
  },
};

export const AR_HALCYON: WeaponDef = {
  id: 'ar_halcyon',
  name: 'HALCYON B5',
  class: 'AR',
  slot: 'primary',

  damage: { near: 34, far: 25.5 },
  damageFalloff: { start: 14, end: 30 },
  headshotMult: 1.5,
  limbMult: 0.92,
  upperTorsoMult: 1,

  rpm: 820,
  magSize: 30,
  reserveAmmo: 240,
  reloadTime: 1.85,
  reloadEmptyTime: 2.5,
  adsTime: 0.235,
  sprintOutTime: 0.18,
  swapInTime: 0.46,
  swapOutTime: 0.35,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 1.7,
    hipMove: 2.9,
    ads: 0.22,
    crouchScale: 0.76,
    airScale: 1.9,
    perShot: 0.075,
    perShotMax: 1.5,
    recover: 4.2,
  },

  recoil: {
    // The forgiving one. Small kicks, near-vertical, with a slow single sweep right that
    // completes over the whole magazine rather than reversing. One correction, held.
    kicks: [
      { x: -0.02, y: 0.44 },
      { x: 0.0, y: 0.42 },
      { x: 0.03, y: 0.4 },
      { x: 0.05, y: 0.38 },
      { x: 0.07, y: 0.35 },
      { x: 0.09, y: 0.32 },
      { x: 0.11, y: 0.29 },
      { x: 0.12, y: 0.27 },
      { x: 0.14, y: 0.25 },
      { x: 0.15, y: 0.24 },
      { x: 0.16, y: 0.22 },
      { x: 0.17, y: 0.21 },
      { x: 0.18, y: 0.2 },
      { x: 0.18, y: 0.19 },
      { x: 0.19, y: 0.19 },
      { x: 0.19, y: 0.18 },
      { x: 0.2, y: 0.18 },
      { x: 0.2, y: 0.17 },
      { x: 0.2, y: 0.17 },
      { x: 0.21, y: 0.16 },
      { x: 0.21, y: 0.16 },
      { x: 0.21, y: 0.16 },
      { x: 0.21, y: 0.15 },
      { x: 0.22, y: 0.15 },
      { x: 0.22, y: 0.15 },
      { x: 0.22, y: 0.14 },
      { x: 0.22, y: 0.14 },
      { x: 0.22, y: 0.14 },
      { x: 0.22, y: 0.14 },
      { x: 0.22, y: 0.13 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.08,
    recoverFraction: 0.88,
    recoverRate: 11.5,
    recoverDelay: 0.1,
    adsScale: 0.72,

    visualScale: 0.85,
    visualAttack: 0.022,
    visualSettle: 0.11,
  },

  penetration: 0.22,

  unlockLevel: 12,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.78,
  adsViewmodelFovScale: 0.84,
  tracerFraction: 0.34,
  shakePerShot: 0.042,
  muzzleFlashScale: 0.85,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.56,
    bodyFreq: 1480,
    bodyQ: 0.7,
    bodyDecay: 0.062,
    bodyRatio: 0.38,
    tailDecay: 0.24,
    tailLevel: 0.16,
    tailFreq: 3100,
    clickFreq: 6100,
    clickLevel: 0.46,
    thumpFreq: 102,
    thumpLevel: 0.4,
    wet: 0.26,
  },
};

export const AR_LONGBOW: WeaponDef = {
  id: 'ar_longbow',
  name: 'LONGBOW MK3',
  class: 'AR',
  slot: 'primary',

  damage: { near: 42, far: 32 },
  damageFalloff: { start: 34, end: 58 },
  headshotMult: 1.55,
  limbMult: 0.85,
  upperTorsoMult: 1,

  rpm: 480,
  magSize: 20,
  reserveAmmo: 160,
  reloadTime: 2.15,
  reloadEmptyTime: 2.95,
  adsTime: 0.325,
  sprintOutTime: 0.27,
  swapInTime: 0.6,
  swapOutTime: 0.46,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 2.8,
    hipMove: 5.0,
    ads: 0.1,
    crouchScale: 0.66,
    airScale: 2.6,
    perShot: 0.14,
    perShotMax: 1.9,
    recover: 5.5,
  },

  recoil: {
    // Heavy and alternating. Each shot throws the muzzle to the opposite side of the last,
    // so a held trigger paints a zig-zag that is impossible to hold on a distant torso and
    // trivial to counter if you respect the 0.125 s shot interval and tap.
    kicks: [
      { x: 0.0, y: 1.05 },
      { x: 0.34, y: 0.94 },
      { x: -0.4, y: 0.86 },
      { x: 0.46, y: 0.78 },
      { x: -0.5, y: 0.7 },
      { x: 0.52, y: 0.62 },
      { x: -0.54, y: 0.56 },
      { x: 0.54, y: 0.5 },
      { x: -0.52, y: 0.46 },
      { x: 0.5, y: 0.42 },
      { x: -0.48, y: 0.39 },
      { x: 0.46, y: 0.36 },
      { x: -0.44, y: 0.34 },
      { x: 0.42, y: 0.32 },
      { x: -0.4, y: 0.31 },
      { x: 0.38, y: 0.3 },
      { x: -0.36, y: 0.29 },
      { x: 0.35, y: 0.28 },
      { x: -0.34, y: 0.27 },
      { x: 0.33, y: 0.27 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.3,
    recoverFraction: 0.72,
    recoverRate: 7.4,
    recoverDelay: 0.16,
    adsScale: 0.84,

    visualScale: 1.5,
    visualAttack: 0.034,
    visualSettle: 0.185,
  },

  penetration: 0.46,

  unlockLevel: 20,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.68,
  adsViewmodelFovScale: 0.78,
  tracerFraction: 0.5,
  shakePerShot: 0.095,
  muzzleFlashScale: 1.4,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.8,
    bodyFreq: 790,
    bodyQ: 1.7,
    bodyDecay: 0.135,
    bodyRatio: 0.22,
    tailDecay: 0.56,
    tailLevel: 0.32,
    tailFreq: 1800,
    clickFreq: 3800,
    clickLevel: 0.42,
    thumpFreq: 62,
    thumpLevel: 0.85,
    wet: 0.4,
  },
};

export const ASSAULT_RIFLES: readonly WeaponDef[] = [AR_CARBINE, AR_VULCAN, AR_HALCYON, AR_LONGBOW];
