import { AR_DEFAULT, cloneWeaponDef, type WeaponDef } from '../weapons/WeaponDefs';

/**
 * Weapons that belong to killstreaks rather than to a player (M7).
 *
 * `DamageSystem.apply` takes a `DamageRequest`, and a request carries a `WeaponDef` because
 * that is where falloff, zone multipliers and the killfeed's weapon name live. A mortar shell
 * and a sentry burst are not weapons anybody carries, but they still have to answer those
 * questions — so they get real defs rather than a special case in the damage path.
 *
 * Built by cloning the carbine and overriding what matters. That is deliberate rather than
 * lazy: it guarantees every field a `WeaponDef` is required to have is present and sane, so
 * adding a field to the schema cannot leave a streak weapon half-initialised.
 *
 * Each is built once for the process. They are read-only in practice — nothing resolves
 * attachments against them — so sharing one object across every sentry on the map is safe.
 */

function synthetic(id: string, name: string, damage: number, headshotMult: number): WeaponDef {
  const def = cloneWeaponDef(AR_DEFAULT);
  def.id = id;
  def.name = name;
  def.damage.near = damage;
  def.damage.far = damage;
  def.headshotMult = headshotMult;
  def.limbMult = 1;
  // No distance term of their own: the mortar applies a radial falloff through
  // `penetrationRetain`, and a sentry's shots are already range-limited by its own arc.
  def.damageFalloff.start = 1000;
  def.damageFalloff.end = 1001;
  return def;
}

let mortar: WeaponDef | null = null;
let sentry: WeaponDef | null = null;
let chopper: WeaponDef | null = null;

/** Flat damage, no falloff. The blast radius is the only distance term. */
export function mortarWeapon(damage: number): WeaponDef {
  if (mortar === null) mortar = synthetic('streak_mortar', 'MORTAR', damage, 1);
  mortar.damage.near = damage;
  mortar.damage.far = damage;
  return mortar;
}

/** A sentry hits a head no harder than a chest: it is a turret, not a marksman. */
export function sentryWeapon(damage: number): WeaponDef {
  if (sentry === null) sentry = synthetic('streak_sentry', 'SENTRY GUN', damage, 1.15);
  sentry.damage.near = damage;
  sentry.damage.far = damage;
  return sentry;
}

export function chopperWeapon(damage: number): WeaponDef {
  if (chopper === null) chopper = synthetic('streak_chopper', 'CHOPPER GUNNER', damage, 1.25);
  chopper.damage.near = damage;
  chopper.damage.far = damage;
  return chopper;
}
