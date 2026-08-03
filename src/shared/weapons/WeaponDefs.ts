/**
 * Weapon data (brief S6.1). Plain objects, no subclass per weapon.
 *
 * M2 said "M5 adds eleven more entries to this file and writes no new classes to do it".
 * That held: the eleven new weapons are data, and the only new *code* in M5's weapon layer
 * is the pellet loop, the scope, the swap and the attachment resolver — none of which is a
 * subclass and all of which are driven from the fields below.
 *
 * The data itself moved to `defs/`, one file per class, because twelve authored recoil
 * patterns is four hundred lines of content on its own. This file is the schema, the
 * registry and the helpers.
 *
 * Angles are in degrees throughout, because that is the unit these get tuned in.
 * Conversion happens once, at the point of use.
 *
 * The debug panel's slider metadata and accessors live in `WeaponTuning.ts`, derived from
 * these types rather than hand-listed alongside them.
 */

import { ASSAULT_RIFLES } from './defs/assaultRifles';
import { LMGS } from './defs/lmgs';
import { PISTOLS } from './defs/pistols';
import { SHOTGUNS } from './defs/shotguns';
import { SMGS } from './defs/smgs';
import { SNIPERS } from './defs/snipers';

export type WeaponClass = 'AR' | 'SMG' | 'LMG' | 'MARKSMAN' | 'SNIPER' | 'SHOTGUN' | 'PISTOL' | 'LAUNCHER';

/** Which inventory slot a weapon occupies (S6.4). */
export type WeaponSlot = 'primary' | 'secondary';

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

/**
 * Synthesis parameters for this weapon's voice (S6.7).
 *
 * The three character controls the brief names — filter cutoff, body resonance and tail
 * length — are `bodyFreq`, `bodyQ` and `tailDecay`. `bodyRatio` and `tailFreq` were added
 * in M5: with twelve weapons sharing one synthesis path, a fixed sweep target and a fixed
 * tail cutoff made the big guns and the small guns converge on the same shape no matter
 * what the other numbers said.
 */
export interface WeaponVoice {
  level: number;
  /** Body noise band centre, Hz. The single biggest character control. */
  bodyFreq: number;
  bodyQ: number;
  bodyDecay: number;
  /** Where the body sweeps down to, as a fraction of `bodyFreq`. */
  bodyRatio: number;
  /** Tail length, seconds. Long tails read as big rooms and big calibres. */
  tailDecay: number;
  tailLevel: number;
  /** Tail low-pass starting cutoff, Hz. Bright tails crack, dark tails boom. */
  tailFreq: number;
  clickFreq: number;
  clickLevel: number;
  thumpFreq: number;
  thumpLevel: number;
  /** Reverb send, 0..1. */
  wet: number;
}

/**
 * A telescopic sight (S6.1, snipers).
 *
 * Present only on weapons that have one. Everything else aims with irons or a red dot and
 * uses `adsTime` alone.
 */
export interface ScopeProfile {
  /** Idle breath sway amplitude at full scope, degrees. */
  swayDeg: number;
  /** Breath cycles per second. */
  swayRate: number;
  /** Seconds of held breath available from full. */
  breathSeconds: number;
  /** Seconds to refill the breath meter from empty. */
  breathRecovery: number;
  /** Sway multiplier while the breath is held. */
  breathHoldScale: number;
  /** Magnification, for the FOV pull and the scope overlay. */
  magnification: number;
  /** Whether the objective lens throws a glint an enemy can see. */
  glint: boolean;
}

export interface WeaponDef {
  id: string;
  name: string;
  class: WeaponClass;
  slot: WeaponSlot;

  damage: { near: number; far: number };
  /** Metres. Damage is `near` at or below `start` and `far` at or beyond `end`. */
  damageFalloff: { start: number; end: number };
  headshotMult: number;
  limbMult: number;
  /**
   * Multiplier for a hit on the chest specifically, as opposed to the abdomen.
   *
   * M2 had one torso zone and one multiplier of exactly 1, and every M2 number was verified
   * against that. This is added rather than substituted: 1.0 reproduces M2 exactly, and only
   * the snipers move off it — which is the whole of "one-shot to upper torso" (S6.1).
   */
  upperTorsoMult: number;

  rpm: number;
  magSize: number;
  reserveAmmo: number;
  reloadTime: number;
  reloadEmptyTime: number;
  /** Seconds from ADS press to fully aimed. */
  adsTime: number;
  /** Sprint-to-fire, seconds. A core balance lever (S6.6). */
  sprintOutTime: number;
  /** Seconds to bring this weapon up when swapped to (S6.4). */
  swapInTime: number;
  /** Seconds to put this weapon away when swapping off it. */
  swapOutTime: number;

  /**
   * Hitscan rays per trigger pull. 1 for everything but the shotgun, which fires 8 and
   * resolves each one against the hitbox rig separately (S6.1).
   */
  pellets: number;
  /** Extra cone applied to pellets 2..n, degrees of half-angle. 0 for a single ray. */
  pelletSpread: number;

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

  /** False once a suppressor is fitted: firing stops pinging the minimap (S6.2). */
  minimapPing: boolean;
  /** True once a laser is fitted: the dot is visible to enemies while aimed (S6.2). */
  laserVisible: boolean;

  scope?: ScopeProfile;

  voice: WeaponVoice;
}

/**
 * The arsenal (S6.1). Twelve weapons across five classes plus a sidearm.
 *
 * Order is the order they appear in the debug picker and the range read-out, which is
 * class by class rather than by power.
 */
export const ALL_WEAPONS: readonly WeaponDef[] = [
  ...ASSAULT_RIFLES,
  ...SMGS,
  ...SHOTGUNS,
  ...LMGS,
  ...SNIPERS,
  ...PISTOLS,
];

export const WEAPON_DEFS: Readonly<Record<string, WeaponDef>> = Object.fromEntries(
  ALL_WEAPONS.map((def) => [def.id, def]),
);

/** The AR the project has shipped since M2. Still the baseline every other gun is read against. */
export const AR_DEFAULT: WeaponDef = requireWeapon('ar_carbine');

/** The default secondary. Every loadout carries one. */
export const PISTOL_DEFAULT: WeaponDef = requireWeapon('pistol_talon');

export function requireWeapon(id: string): WeaponDef {
  const def = WEAPON_DEFS[id];
  if (def === undefined) throw new Error(`Unknown weapon id "${id}"`);
  return def;
}

/** Every weapon of a class, in roster order. */
export function weaponsOfClass(cls: WeaponClass): WeaponDef[] {
  return ALL_WEAPONS.filter((def) => def.class === cls);
}

export function cloneWeaponDef(src: WeaponDef): WeaponDef {
  const out: WeaponDef = {
    ...src,
    damage: { ...src.damage },
    damageFalloff: { ...src.damageFalloff },
    spread: { ...src.spread },
    recoil: { ...src.recoil, kicks: src.recoil.kicks },
    attachmentSlots: [...src.attachmentSlots],
    voice: { ...src.voice },
  };
  if (src.scope !== undefined) out.scope = { ...src.scope };
  return out;
}

/** Seconds between shots. */
export function shotInterval(def: WeaponDef): number {
  return 60 / Math.max(def.rpm, 1);
}
