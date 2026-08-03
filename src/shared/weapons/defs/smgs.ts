import type { WeaponDef } from '../WeaponDefs';

/**
 * The two submachine guns (brief S6.1): fastest ADS (~180 ms), high RPM, brutal falloff
 * past 18 m.
 *
 * They are the only weapons in the game that beat an AR's time-to-kill, and they do it
 * inside a distance you can cross in two seconds:
 *
 *  - **WASP** 3-shots to 8 m at 900 RPM — 0.133 s, the fastest kill in the arsenal — and
 *    needs *seven* rounds past 18 m, which is 0.40 s and a lost fight. The cliff is the
 *    weapon.
 *  - **MERIDIAN** gives up the 3-shot entirely for a 4-shot that holds to 17 m and a
 *    40-round magazine. The SMG you can take into a lane.
 *
 * Both patterns are fast and wide rather than tall: an SMG that climbed like a rifle would
 * be controllable at the range where it is supposed to be losing.
 */

export const SMG_WASP: WeaponDef = {
  id: 'smg_wasp',
  name: 'WASP 9',
  class: 'SMG',
  slot: 'primary',

  damage: { near: 34, far: 15 },
  damageFalloff: { start: 7, end: 18 },
  headshotMult: 1.45,
  limbMult: 0.92,
  upperTorsoMult: 1,

  /**
   * 1000, raised from 900 after the first balance measurement.
   *
   * At 900 this 3-shot killed in 0.133 s and so did the HALCYON — an assault rifle matching
   * the fastest SMG in the game inside its own band, which is the one thing an SMG must
   * not lose. 1000 RPM puts it at 0.120 s and restores the seventeen-millisecond edge that
   * is the entire reason to carry one. See PLAN.md.
   */
  rpm: 1000,
  magSize: 32,
  reserveAmmo: 256,
  reloadTime: 1.7,
  reloadEmptyTime: 2.3,
  adsTime: 0.175,
  /**
   * 0.18, raised from 0.13 in M5's balance pass.
   *
   * `sprintOutTime` is also slide-out time, and firing while sliding became legal in M5 —
   * so at 0.13 this weapon came up out of a slide 45 ms *before* the fastest ADS in the
   * arsenal (its own, 0.175 s) could finish. Holding it just above that means a slide entry
   * never wins the duel outright against somebody who chose to aim. See PLAN.md.
   */
  sprintOutTime: 0.18,
  swapInTime: 0.4,
  swapOutTime: 0.3,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 2.4,
    hipMove: 3.2,
    ads: 0.42,
    crouchScale: 0.82,
    airScale: 1.7,
    perShot: 0.11,
    perShotMax: 2.2,
    recover: 5.0,
  },

  recoil: {
    // Wide before it is tall: the muzzle leaves right immediately, crosses back through
    // centre around shot 11 and ends left. Vertical is deliberately mild — this gun is
    // fired at eight metres, and a tall pattern there is just a miss.
    kicks: [
      { x: 0.14, y: 0.34 },
      { x: 0.24, y: 0.32 },
      { x: 0.32, y: 0.3 },
      { x: 0.36, y: 0.28 },
      { x: 0.36, y: 0.26 },
      { x: 0.32, y: 0.25 },
      { x: 0.24, y: 0.24 },
      { x: 0.14, y: 0.23 },
      { x: 0.02, y: 0.22 },
      { x: -0.12, y: 0.22 },
      { x: -0.24, y: 0.21 },
      { x: -0.34, y: 0.21 },
      { x: -0.4, y: 0.2 },
      { x: -0.42, y: 0.2 },
      { x: -0.4, y: 0.19 },
      { x: -0.34, y: 0.19 },
      { x: -0.26, y: 0.19 },
      { x: -0.16, y: 0.18 },
      { x: -0.04, y: 0.18 },
      { x: 0.08, y: 0.18 },
      { x: 0.2, y: 0.17 },
      { x: 0.3, y: 0.17 },
      { x: 0.36, y: 0.17 },
      { x: 0.38, y: 0.17 },
      { x: 0.36, y: 0.16 },
      { x: 0.3, y: 0.16 },
      { x: 0.2, y: 0.16 },
      { x: 0.08, y: 0.16 },
      { x: -0.04, y: 0.16 },
      { x: -0.16, y: 0.15 },
      { x: -0.26, y: 0.15 },
      { x: -0.32, y: 0.15 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.05,
    recoverFraction: 0.86,
    recoverRate: 12.5,
    recoverDelay: 0.09,
    adsScale: 0.8,

    visualScale: 0.75,
    visualAttack: 0.018,
    visualSettle: 0.095,
  },

  penetration: 0.12,

  unlockLevel: 4,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.86,
  adsViewmodelFovScale: 0.9,
  tracerFraction: 0.25,
  shakePerShot: 0.032,
  muzzleFlashScale: 0.75,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.48,
    bodyFreq: 1950,
    bodyQ: 0.62,
    bodyDecay: 0.045,
    bodyRatio: 0.45,
    tailDecay: 0.17,
    tailLevel: 0.12,
    tailFreq: 3600,
    clickFreq: 7200,
    clickLevel: 0.52,
    thumpFreq: 128,
    thumpLevel: 0.28,
    wet: 0.22,
  },
};

export const SMG_MERIDIAN: WeaponDef = {
  id: 'smg_meridian',
  name: 'MERIDIAN P40',
  class: 'SMG',
  slot: 'primary',

  /**
   * `near` raised from 30 to 34 after the first balance measurement.
   *
   * At 30 this was a 4-shot everywhere and therefore *worse than the baseline carbine at
   * every range including its own* — an SMG with no band it wins. 34 buys a 3-shot inside
   * the 12 m falloff start (0.154 s against the carbine's 0.167 s) and nothing beyond it,
   * which is the shape the weapon was supposed to have. See PLAN.md.
   */
  damage: { near: 34, far: 18 },
  damageFalloff: { start: 12, end: 24 },
  headshotMult: 1.45,
  limbMult: 0.94,
  upperTorsoMult: 1,

  rpm: 780,
  magSize: 40,
  reserveAmmo: 280,
  reloadTime: 1.95,
  reloadEmptyTime: 2.6,
  adsTime: 0.19,
  /**
   * 0.18. Same floor as the WASP and the TALON: no weapon in the arsenal comes up out of a
   * slide faster than the fastest ADS in it (0.175 s), which is the S6.5 retune's whole
   * conclusion. The first pass raised only two weapons and this one inherited the problem.
   */
  sprintOutTime: 0.18,
  swapInTime: 0.44,
  swapOutTime: 0.33,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 2.0,
    hipMove: 2.8,
    ads: 0.3,
    crouchScale: 0.8,
    airScale: 1.8,
    perShot: 0.085,
    perShotMax: 1.8,
    recover: 4.6,
  },

  recoil: {
    // A tight anticlockwise loop rather than a sweep. Over forty rounds it goes round
    // roughly twice, which is a shape you can trace with the mouse and cannot guess.
    kicks: [
      { x: 0.0, y: 0.4 },
      { x: 0.08, y: 0.37 },
      { x: 0.16, y: 0.33 },
      { x: 0.2, y: 0.28 },
      { x: 0.22, y: 0.23 },
      { x: 0.2, y: 0.19 },
      { x: 0.15, y: 0.16 },
      { x: 0.08, y: 0.14 },
      { x: 0.0, y: 0.13 },
      { x: -0.08, y: 0.14 },
      { x: -0.15, y: 0.16 },
      { x: -0.2, y: 0.19 },
      { x: -0.22, y: 0.23 },
      { x: -0.2, y: 0.27 },
      { x: -0.15, y: 0.3 },
      { x: -0.08, y: 0.31 },
      { x: 0.0, y: 0.3 },
      { x: 0.08, y: 0.28 },
      { x: 0.16, y: 0.25 },
      { x: 0.2, y: 0.21 },
      { x: 0.22, y: 0.18 },
      { x: 0.2, y: 0.15 },
      { x: 0.15, y: 0.13 },
      { x: 0.08, y: 0.12 },
      { x: 0.0, y: 0.12 },
      { x: -0.08, y: 0.13 },
      { x: -0.15, y: 0.15 },
      { x: -0.2, y: 0.18 },
      { x: -0.22, y: 0.21 },
      { x: -0.2, y: 0.24 },
      { x: -0.15, y: 0.26 },
      { x: -0.08, y: 0.27 },
      { x: 0.0, y: 0.26 },
      { x: 0.08, y: 0.24 },
      { x: 0.15, y: 0.21 },
      { x: 0.2, y: 0.18 },
      { x: 0.21, y: 0.16 },
      { x: 0.18, y: 0.14 },
      { x: 0.12, y: 0.13 },
      { x: 0.05, y: 0.12 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.1,
    recoverFraction: 0.85,
    recoverRate: 11.0,
    recoverDelay: 0.1,
    adsScale: 0.75,

    visualScale: 0.9,
    visualAttack: 0.02,
    visualSettle: 0.105,
  },

  penetration: 0.16,

  unlockLevel: 15,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.84,
  adsViewmodelFovScale: 0.88,
  tracerFraction: 0.25,
  shakePerShot: 0.038,
  muzzleFlashScale: 0.85,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.54,
    bodyFreq: 1680,
    bodyQ: 0.95,
    bodyDecay: 0.058,
    bodyRatio: 0.4,
    tailDecay: 0.22,
    tailLevel: 0.15,
    tailFreq: 3200,
    clickFreq: 6600,
    clickLevel: 0.44,
    thumpFreq: 112,
    thumpLevel: 0.36,
    wet: 0.24,
  },
};

export const SMGS: readonly WeaponDef[] = [SMG_WASP, SMG_MERIDIAN];
