import type { WeaponDef } from '../WeaponDefs';

/**
 * The two sniper rifles (brief S6.1): one-shot to upper torso and head, scope glint, a
 * 0.35 s scope-in with visible breath sway, and hold-breath on Shift.
 *
 * **"Upper torso" is the chest box, not the whole torso zone.** The M2 hitbox rig already
 * splits the torso into `chest` and `abdomen`; `upperTorsoMult` applies to the first only.
 * That is why base damage sits below 100 on both rifles — a gut shot has to *not* kill, or
 * "upper torso" means nothing and the rifle is a one-shot to anything vaguely central.
 *
 *  - **KESTREL** is the bolt gun: 98 x 1.15 = 113 to the chest at any range you can see,
 *    and 1.25 s between shots. Miss and the fight is over.
 *  - **VANTAGE** is semi-automatic: 0.3 s between shots, but the one-shot chest expires at
 *    69 m and the pattern throws the second round well off the first. The follow-up is
 *    real; it is just not free.
 */

export const SNIPER_KESTREL: WeaponDef = {
  id: 'sniper_kestrel',
  name: 'KESTREL .338',
  class: 'SNIPER',
  slot: 'primary',

  damage: { near: 98, far: 92 },
  damageFalloff: { start: 65, end: 120 },
  headshotMult: 1.95,
  limbMult: 0.62,
  /** 98 x 1.15 = 112.7 near, 105.8 far. One-shot chest at every range on every map. */
  upperTorsoMult: 1.15,

  rpm: 48,
  magSize: 5,
  reserveAmmo: 40,
  reloadTime: 3.1,
  reloadEmptyTime: 3.9,
  adsTime: 0.35,
  sprintOutTime: 0.34,
  swapInTime: 0.72,
  swapOutTime: 0.58,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    // Hip-firing a bolt gun should be a joke, and it is.
    hipStand: 6.5,
    hipMove: 9.5,
    ads: 0,
    crouchScale: 0.7,
    airScale: 2.4,
    perShot: 0,
    perShotMax: 0,
    recover: 1,
  },

  recoil: {
    // Five rounds, five entries. Enormous vertical with a consistent lean left, and no
    // repetition to learn — the pattern's job here is to take the sight picture off the
    // target so the bolt cycle is spent re-acquiring rather than re-firing.
    kicks: [
      { x: -0.1, y: 4.6 },
      { x: -0.28, y: 4.4 },
      { x: -0.4, y: 4.3 },
      { x: -0.48, y: 4.2 },
      { x: -0.52, y: 4.15 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.0,
    recoverFraction: 0.94,
    recoverRate: 5.0,
    recoverDelay: 0.25,
    adsScale: 0.86,

    visualScale: 2.8,
    visualAttack: 0.035,
    visualSettle: 0.3,
  },

  penetration: 0.9,

  unlockLevel: 11,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.34,
  adsViewmodelFovScale: 0.6,
  tracerFraction: 1,
  shakePerShot: 0.22,
  muzzleFlashScale: 1.9,

  minimapPing: true,
  laserVisible: false,

  /** `adsTime` above is the 0.35 s scope-in S6.1 fixes. There is no second timer. */
  scope: {
    swayDeg: 0.55,
    swayRate: 0.42,
    breathSeconds: 3.2,
    breathRecovery: 4.5,
    breathHoldScale: 0.08,
    magnification: 4.5,
    glint: true,
  },

  voice: {
    level: 1.0,
    bodyFreq: 395,
    bodyQ: 2.4,
    bodyDecay: 0.2,
    bodyRatio: 0.16,
    tailDecay: 0.95,
    tailLevel: 0.42,
    tailFreq: 1400,
    clickFreq: 8400,
    clickLevel: 0.6,
    thumpFreq: 48,
    thumpLevel: 1.0,
    wet: 0.52,
  },
};

export const SNIPER_VANTAGE: WeaponDef = {
  id: 'sniper_vantage',
  name: 'VANTAGE SR',
  class: 'SNIPER',
  slot: 'primary',

  damage: { near: 88, far: 74 },
  damageFalloff: { start: 38, end: 72 },
  headshotMult: 1.8,
  limbMult: 0.58,
  /** 88 x 1.22 = 107.4 near; the one-shot chest expires at 69 m and it is two after that. */
  upperTorsoMult: 1.22,

  rpm: 200,
  magSize: 10,
  reserveAmmo: 60,
  reloadTime: 2.9,
  reloadEmptyTime: 3.7,
  adsTime: 0.44,
  sprintOutTime: 0.32,
  swapInTime: 0.68,
  swapOutTime: 0.54,

  pellets: 1,
  pelletSpread: 0,

  spread: {
    hipStand: 5.4,
    hipMove: 8.0,
    ads: 0.02,
    crouchScale: 0.72,
    airScale: 2.2,
    perShot: 0.06,
    perShotMax: 0.35,
    recover: 1.4,
  },

  recoil: {
    // Ten rounds and a hard alternating throw. The second shot lands nowhere near the
    // first, which is exactly the cost of semi-automatic: you get the trigger back, you do
    // not get the sight picture back.
    kicks: [
      { x: 0.0, y: 2.6 },
      { x: 0.85, y: 2.35 },
      { x: -0.95, y: 2.2 },
      { x: 1.0, y: 2.1 },
      { x: -1.05, y: 2.0 },
      { x: 1.05, y: 1.95 },
      { x: -1.0, y: 1.9 },
      { x: 0.95, y: 1.85 },
      { x: -0.9, y: 1.8 },
      { x: 0.85, y: 1.8 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.0,
    recoverFraction: 0.88,
    recoverRate: 5.8,
    recoverDelay: 0.22,
    adsScale: 0.9,

    visualScale: 2.0,
    visualAttack: 0.032,
    visualSettle: 0.26,
  },

  penetration: 0.75,

  unlockLevel: 38,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.44,
  adsViewmodelFovScale: 0.66,
  tracerFraction: 1,
  shakePerShot: 0.15,
  muzzleFlashScale: 1.6,

  minimapPing: true,
  laserVisible: false,

  /** Slower to the eye than the KESTREL: the cost of getting the trigger back. */
  scope: {
    swayDeg: 0.4,
    swayRate: 0.5,
    breathSeconds: 2.6,
    breathRecovery: 4.0,
    breathHoldScale: 0.12,
    magnification: 3.2,
    glint: true,
  },

  voice: {
    level: 0.9,
    bodyFreq: 620,
    bodyQ: 2.0,
    bodyDecay: 0.165,
    bodyRatio: 0.18,
    tailDecay: 0.78,
    tailLevel: 0.38,
    tailFreq: 1700,
    clickFreq: 7600,
    clickLevel: 0.55,
    thumpFreq: 54,
    thumpLevel: 0.9,
    wet: 0.48,
  },
};

export const SNIPERS: readonly WeaponDef[] = [SNIPER_KESTREL, SNIPER_VANTAGE];
