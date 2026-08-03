import type { WeaponDef } from '../WeaponDefs';

/**
 * The sidearm (brief S6.1): fast swap, secondary slot.
 *
 * The whole point of this weapon is `swapInTime`. At 0.24 s it comes up in less than half
 * the time any primary does, which makes "swap instead of reloading" a real decision — and
 * that decision is the only reason a secondary slot exists at all.
 *
 * Everything else about it is deliberately mediocre: 4 shots to the body, 400 RPM, and a
 * 12-round magazine that runs out during a single engagement.
 */

export const PISTOL_TALON: WeaponDef = {
  id: 'pistol_talon',
  name: 'TALON 9',
  class: 'PISTOL',
  slot: 'secondary',

  damage: { near: 32, far: 22 },
  damageFalloff: { start: 14, end: 28 },
  headshotMult: 1.6,
  limbMult: 0.9,
  upperTorsoMult: 1,

  rpm: 400,
  magSize: 12,
  reserveAmmo: 72,
  reloadTime: 1.5,
  reloadEmptyTime: 2.05,
  adsTime: 0.19,
  /** 0.18, raised from 0.12 for the same reason as the WASP's — see `smgs.ts`. */
  sprintOutTime: 0.18,
  /** The number that justifies the slot. Half a primary's, and you can feel it. */
  swapInTime: 0.24,
  swapOutTime: 0.2,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 2.6,
    hipMove: 4.2,
    ads: 0.3,
    crouchScale: 0.78,
    airScale: 2.0,
    perShot: 0.22,
    perShotMax: 2.4,
    recover: 6.0,
  },

  recoil: {
    // Twelve entries — one whole magazine, no repeat. A hard first shot, then a tight
    // rightward spiral. Trigger-mashing a pistol should walk off target quickly; the
    // pattern is what makes deliberate shots better than fast ones.
    kicks: [
      { x: 0.0, y: 1.5 },
      { x: 0.2, y: 1.25 },
      { x: 0.32, y: 1.1 },
      { x: 0.34, y: 1.0 },
      { x: 0.26, y: 0.95 },
      { x: 0.1, y: 0.9 },
      { x: -0.08, y: 0.88 },
      { x: -0.24, y: 0.86 },
      { x: -0.32, y: 0.85 },
      { x: -0.28, y: 0.84 },
      { x: -0.14, y: 0.83 },
      { x: 0.04, y: 0.82 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.0,
    recoverFraction: 0.9,
    recoverRate: 13.0,
    recoverDelay: 0.09,
    adsScale: 0.8,

    visualScale: 1.35,
    visualAttack: 0.02,
    visualSettle: 0.12,
  },

  penetration: 0.1,

  unlockLevel: 1,
  attachmentSlots: ['optic', 'muzzle', 'magazine', 'laser'],

  adsFovScale: 0.9,
  adsViewmodelFovScale: 0.94,
  tracerFraction: 0.25,
  shakePerShot: 0.05,
  muzzleFlashScale: 0.8,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.58,
    bodyFreq: 1320,
    bodyQ: 1.1,
    bodyDecay: 0.07,
    bodyRatio: 0.3,
    tailDecay: 0.28,
    tailLevel: 0.18,
    tailFreq: 2800,
    clickFreq: 5800,
    clickLevel: 0.48,
    thumpFreq: 96,
    thumpLevel: 0.45,
    wet: 0.28,
  },
};

export const PISTOLS: readonly WeaponDef[] = [PISTOL_TALON];
