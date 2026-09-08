import type { WeaponDef } from '../WeaponDefs';

/**
 * The shotgun (brief S6.1): 8 pellets, per-pellet damage, one-shot inside 6 m.
 *
 * `damage` here is **per pellet**, not per trigger pull, and `Ballistics` resolves each of
 * the eight as its own hitscan ray against the hitbox rig — so a spread that catches the
 * head and the chest applies the head multiplier to the pellets that hit the head and the
 * torso multiplier to the rest. A single ray with a x8 multiplier would be a completely
 * different weapon: it would either all-hit or all-miss, and the whole character of a
 * shotgun is the part that lands.
 *
 * 18 per pellet means six of eight is 108 and kills; at 6 m the cone is 0.27 m across
 * against a 0.46 m chest, so six is what you get for aiming. At 10 m the pellets have
 * fallen to 10 and the cone has opened past the silhouette, and it is a two-shot at best
 * against a 90 RPM pump.
 */

export const SHOTGUN_BREACHER: WeaponDef = {
  id: 'shotgun_breacher',
  name: 'BREACHER 12',
  class: 'SHOTGUN',
  slot: 'primary',

  /**
   * Per pellet. `far` raised from 4 to 7 and the falloff shortened to 13 m after the first
   * balance measurement, which had the shotgun unable to kill *at all* at 15 m inside six
   * seconds. Spiky is the design (S6.5); a weapon with a hard wall at 14 m past which it
   * literally cannot win is a weapon nobody carries. At 7 it is a four-shell grind out
   * there — hopeless, but a fight. See PLAN.md.
   */
  damage: { near: 18, far: 7 },
  damageFalloff: { start: 6, end: 13 },
  headshotMult: 1.4,
  limbMult: 0.8,
  upperTorsoMult: 1,

  rpm: 90,
  magSize: 6,
  reserveAmmo: 48,
  reloadTime: 2.4,
  reloadEmptyTime: 3.0,
  adsTime: 0.29,
  sprintOutTime: 0.2,
  swapInTime: 0.54,
  swapOutTime: 0.42,

  pellets: 8,
  /**
   * Half-angle of the pellet cone. This is what actually decides the weapon: 2.6 deg is
   * 0.27 m of radius at six metres — tight enough that an aimed shot puts six pellets on a
   * chest — and 0.45 m at ten, which is wider than the silhouette.
   */
  pelletSpread: 2.6,

  spread: {
    // The aim cone the whole pattern is *centred* on, on top of the pellet spread. Small,
    // because the pellet cone is doing the work.
    hipStand: 0.9,
    hipMove: 1.6,
    ads: 0.25,
    crouchScale: 0.8,
    airScale: 1.9,
    perShot: 0.2,
    perShotMax: 0.8,
    recover: 2.4,
  },

  recoil: {
    // Eight shots is the whole magazine, so the pattern is short and every entry is felt.
    // Almost pure vertical with a small consistent drift right — a shotgun that walked
    // sideways would be unreadable at the range it is used.
    kicks: [
      { x: 0.0, y: 2.5 },
      { x: 0.12, y: 2.35 },
      { x: 0.2, y: 2.25 },
      { x: 0.26, y: 2.15 },
      { x: 0.3, y: 2.1 },
      { x: 0.32, y: 2.05 },
    ],
    verticalScale: 1.0,
    horizontalScale: 1.0,
    firstShotScale: 1.0,
    recoverFraction: 0.9,
    recoverRate: 6.5,
    recoverDelay: 0.2,
    adsScale: 0.9,

    visualScale: 2.2,
    visualAttack: 0.03,
    visualSettle: 0.24,
  },

  penetration: 0.06,

  unlockLevel: 1,
  attachmentSlots: ['optic', 'muzzle', 'barrel', 'magazine', 'stock', 'laser'],

  adsFovScale: 0.88,
  adsViewmodelFovScale: 0.92,
  tracerFraction: 0,
  shakePerShot: 0.16,
  muzzleFlashScale: 1.8,

  minimapPing: true,
  laserVisible: false,

  voice: {
    level: 0.92,
    bodyFreq: 470,
    bodyQ: 0.55,
    bodyDecay: 0.16,
    bodyRatio: 0.2,
    tailDecay: 0.6,
    tailLevel: 0.36,
    tailFreq: 1500,
    clickFreq: 3200,
    clickLevel: 0.5,
    thumpFreq: 55,
    thumpLevel: 0.95,
    wet: 0.42,
  },
};

export const SHOTGUNS: readonly WeaponDef[] = [SHOTGUN_BREACHER];
