import type { WeaponDef } from '../weapons/WeaponDefs';

/**
 * Grenades and equipment (brief S6.3).
 *
 * `equipment/` is a directory S3's layout does not name. The alternative was `weapons/`,
 * which is already the largest package in the project and whose contents are all "a thing
 * you shoot"; a frag is a thrown, fused, bouncing volume that damages by radius and blinds
 * by angle, and it shares exactly one thing with a rifle — the damage door.
 *
 * That one shared thing is deliberate: **an explosion is a `WeaponDef`.** Every piece of
 * equipment below carries a `damageProfile` shaped like a weapon, so radial damage goes
 * through `DamageSystem.apply` unchanged and the number a grenade does to you is computed
 * by the same code as the number a rifle does. M3's rule — "damage has exactly one door" —
 * survives, and the debug read-out prints a grenade the same way it prints a bullet.
 *
 * `projectileSpeed` on the profile is the legitimate use S4.4 carves out: thrown equipment
 * is the *only* thing in this project that is not hitscan.
 */

export type EquipmentSlot = 'lethal' | 'tactical';

export type EquipmentId = 'frag' | 'semtex' | 'flashbang' | 'smoke' | 'claymore';

/** How a thrown object behaves when it meets geometry. */
export type ImpactBehaviour =
  /** Loses energy and keeps going: a frag rolls around a corner and that is the point. */
  | 'bounce'
  /** Stops dead where it lands, on a wall or on a person. */
  | 'stick'
  /** Stops on the ground and arms an area trigger instead of a fuse. */
  | 'plant';

export interface EquipmentDef {
  readonly id: EquipmentId;
  readonly name: string;
  readonly slot: EquipmentSlot;

  /** Carried per life. Both slots are refilled on respawn. */
  readonly count: number;

  /** Seconds from leaving the hand to detonation, or -1 for trigger-armed (claymore). */
  readonly fuseSeconds: number;
  /** Whether holding the button before release burns fuse (S6.3: frags are cookable). */
  readonly cookable: boolean;
  /** Seconds of cook after which it goes off in your hand. Guards the cook. */
  readonly cookLimit: number;

  /** Metres per second at full throw. The S4.4 exception. */
  readonly throwSpeed: number;
  /** Degrees above the aim direction the throw is lofted. */
  readonly throwLoftDeg: number;
  /** Fraction of the throw speed used for an underhand drop (crouched or looking down). */
  readonly dropScale: number;

  readonly impact: ImpactBehaviour;
  /** Fraction of speed kept per bounce. */
  readonly restitution: number;
  /** Fraction of tangential speed kept per bounce. */
  readonly friction: number;
  /** Below this speed it stops rolling, m/s. */
  readonly restSpeed: number;
  /** Collision radius, metres. Also the drawn size. */
  readonly radius: number;

  /** Blast radius, metres. Nothing beyond this is touched at all. */
  readonly effectRadius: number;
  /**
   * The explosion as a weapon, so the one damage door applies (see the file comment).
   * Null for equipment that does no damage — smoke.
   */
  readonly damageProfile: WeaponDef | null;

  /** Seconds of full blindness at point blank, before angle and LOS scaling. 0 = not a flash. */
  readonly flashSeconds: number;

  /** Seconds of smoke, and how big it grows. 0 = not a smoke. */
  readonly smokeSeconds: number;
  readonly smokeRadius: number;
  /** Seconds the cloud takes to reach full radius and full opacity. */
  readonly smokeBloom: number;

  /** Claymore: detection cone half-angle in degrees, and its trigger radius. */
  readonly triggerArcDeg: number;
  readonly triggerRadius: number;
  /** Seconds after planting before it will fire. */
  readonly armSeconds: number;

  /** Bots below this tier index never throw one (S6.3). Recruit is 0. */
  readonly minBotTier: number;
}

/**
 * An explosion's damage curve, expressed as a weapon.
 *
 * `near` at the centre falling linearly to `far` at `end` is exactly what
 * `damageAtRange` already computes, so a grenade needs no second damage model. Zone
 * multipliers are all 1: a blast does not care which limb it found first, and a headshot
 * multiplier on shrapnel would make crouching *worse*, which is backwards.
 */
function blast(id: string, name: string, near: number, far: number, radius: number): WeaponDef {
  return {
    id,
    name,
    class: 'LAUNCHER',
    slot: 'primary',
    damage: { near, far },
    damageFalloff: { start: 0.6, end: radius },
    headshotMult: 1,
    limbMult: 1,
    upperTorsoMult: 1,
    rpm: 60,
    magSize: 1,
    reserveAmmo: 0,
    reloadTime: 1,
    reloadEmptyTime: 1,
    adsTime: 0.3,
    sprintOutTime: 0.2,
    swapInTime: 0.5,
    swapOutTime: 0.4,
    pellets: 1,
    pelletSpread: 0,
    spread: {
      hipStand: 0,
      hipMove: 0,
      ads: 0,
      crouchScale: 1,
      airScale: 1,
      perShot: 0,
      perShotMax: 0,
      recover: 1,
    },
    recoil: {
      kicks: [],
      verticalScale: 0,
      horizontalScale: 0,
      firstShotScale: 1,
      recoverFraction: 1,
      recoverRate: 10,
      recoverDelay: 0.1,
      adsScale: 1,
      visualScale: 0,
      visualAttack: 0.03,
      visualSettle: 0.15,
    },
    penetration: 0,
    projectileSpeed: 18,
    unlockLevel: 1,
    attachmentSlots: [],
    adsFovScale: 1,
    adsViewmodelFovScale: 1,
    tracerFraction: 0,
    shakePerShot: 0,
    muzzleFlashScale: 0,
    minimapPing: true,
    laserVisible: false,
    voice: {
      level: 1,
      bodyFreq: 180,
      bodyQ: 0.6,
      bodyDecay: 0.4,
      bodyRatio: 0.15,
      tailDecay: 1.1,
      tailLevel: 0.5,
      tailFreq: 900,
      clickFreq: 2400,
      clickLevel: 0.7,
      thumpFreq: 40,
      thumpLevel: 1,
      wet: 0.6,
    },
  };
}

/** Shared defaults so each record below only states what makes it different. */
const BASE = {
  count: 2,
  fuseSeconds: 3.5,
  cookable: false,
  cookLimit: 3.4,
  throwSpeed: 17,
  throwLoftDeg: 7,
  dropScale: 0.4,
  impact: 'bounce' as ImpactBehaviour,
  restitution: 0.36,
  friction: 0.72,
  restSpeed: 0.55,
  radius: 0.075,
  effectRadius: 6,
  damageProfile: null,
  flashSeconds: 0,
  smokeSeconds: 0,
  smokeRadius: 0,
  smokeBloom: 1,
  triggerArcDeg: 0,
  triggerRadius: 0,
  armSeconds: 0,
  minBotTier: 1,
};

export const FRAG: EquipmentDef = {
  ...BASE,
  id: 'frag',
  name: 'FRAG',
  slot: 'lethal',
  fuseSeconds: 3.5,
  cookable: true,
  cookLimit: 3.4,
  effectRadius: 6,
  /** 120 at the centre falling off over 6 m, exactly as S6.3 states. */
  damageProfile: blast('eq_frag', 'FRAG', 120, 6, 6),
  minBotTier: 1,
};

export const SEMTEX: EquipmentDef = {
  ...BASE,
  id: 'semtex',
  name: 'SEMTEX',
  slot: 'lethal',
  fuseSeconds: 2.4,
  // A sticky charge you can cook is a grenade with no downside; the shorter fuse is the
  // trade for the certainty of where it lands.
  cookable: false,
  impact: 'stick',
  restitution: 0,
  friction: 0,
  throwSpeed: 19,
  throwLoftDeg: 4,
  effectRadius: 5.2,
  damageProfile: blast('eq_semtex', 'SEMTEX', 130, 8, 5.2),
  minBotTier: 2,
};

export const FLASHBANG: EquipmentDef = {
  ...BASE,
  id: 'flashbang',
  name: 'FLASHBANG',
  slot: 'tactical',
  fuseSeconds: 1.9,
  cookable: true,
  cookLimit: 1.8,
  effectRadius: 11,
  damageProfile: null,
  /** S6.3's three seconds, at point blank and looking straight at it. */
  flashSeconds: 3,
  minBotTier: 1,
};

export const SMOKE: EquipmentDef = {
  ...BASE,
  id: 'smoke',
  name: 'SMOKE',
  slot: 'tactical',
  fuseSeconds: 1.4,
  restitution: 0.25,
  effectRadius: 0,
  damageProfile: null,
  smokeSeconds: 12,
  smokeRadius: 4.2,
  smokeBloom: 1.6,
  minBotTier: 2,
};

export const CLAYMORE: EquipmentDef = {
  ...BASE,
  id: 'claymore',
  name: 'CLAYMORE',
  slot: 'lethal',
  count: 1,
  fuseSeconds: -1,
  impact: 'plant',
  restitution: 0,
  friction: 0,
  throwSpeed: 7,
  throwLoftDeg: -6,
  radius: 0.11,
  effectRadius: 4.5,
  damageProfile: blast('eq_claymore', 'CLAYMORE', 150, 20, 4.5),
  triggerArcDeg: 90,
  triggerRadius: 3.6,
  armSeconds: 1.1,
  minBotTier: 3,
};

export const ALL_EQUIPMENT: readonly EquipmentDef[] = [FRAG, SEMTEX, FLASHBANG, SMOKE, CLAYMORE];

export const EQUIPMENT_DEFS: Readonly<Record<EquipmentId, EquipmentDef>> = {
  frag: FRAG,
  semtex: SEMTEX,
  flashbang: FLASHBANG,
  smoke: SMOKE,
  claymore: CLAYMORE,
};

export function equipmentDef(id: EquipmentId): EquipmentDef {
  return EQUIPMENT_DEFS[id];
}
