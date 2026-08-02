import { EV, type GameBus } from '../core/Events';
import { clamp01, lerp } from '../core/MathUtil';
import type { Health } from '../player/Health';
import type { WeaponDef } from '../weapons/WeaponDefs';
import type { HitboxRig, HitZone } from './HitboxRig';

/**
 * The only place damage is applied (brief S6.4).
 *
 * Everything upstream — ballistics, explosions later, fall damage later — describes a
 * hit; this decides what it costs. Falloff, zone multipliers and penetration loss are
 * resolved in one place so the numbers printed by the debug panel are, by construction,
 * the numbers the game used.
 *
 * Allocation free: the request and the event payload are module-level singletons.
 */

export interface Damageable {
  readonly entityId: number;
  readonly displayName: string;
  readonly health: Health;
  readonly rig: HitboxRig;
  /**
   * Which side this target is on, or absent for anything that is not on one — M2's range
   * dummies are damageable and belong to nobody.
   *
   * Written as the literal union rather than importing `BotTeam` from `ai/`: `combat/`
   * sits below `ai/` and should not depend upward on it. The two are structurally
   * identical, so a `Combatant` satisfies this without a cast.
   */
  readonly team?: 'A' | 'B';
  /**
   * True while this entity cannot be hurt at all (M7 playtest).
   *
   * Only the player's abandoned body uses it, while they are flying a Chopper Gunner. The
   * check lives here rather than in each damage source for the same reason the friendly-fire
   * gate does: there is one door into health, and a rule that is not applied at the door is a
   * rule some future damage source will forget.
   */
  readonly invulnerable?: boolean;
}

export interface DamageRequest {
  sourceId: number;
  targetId: number;
  zone: HitZone;
  /**
   * The torso hit landed on the chest rather than the abdomen (M5).
   *
   * Only consulted for `zone === 'torso'`, and only meaningful for a weapon whose
   * `upperTorsoMult` is not 1 — which is the two snipers and nothing else.
   */
  upperTorso: boolean;
  weapon: WeaponDef;
  /** Metres from muzzle to impact, along the whole traced path. */
  distance: number;
  /** Surviving fraction after wall penetration, 0..1. 1 = clean line of sight. */
  penetrationRetain: number;
  x: number;
  y: number;
  z: number;
}

/** What the last hit actually cost, for the debug read-out (S7). */
export interface LastHitReport {
  valid: boolean;
  targetName: string;
  zone: HitZone;
  upperTorso: boolean;
  distance: number;
  baseDamage: number;
  zoneMultiplier: number;
  falloffLoss: number;
  penetrationLoss: number;
  finalDamage: number;
  remainingHealth: number;
  lethal: boolean;
  atMs: number;
}

export const PLAYER_ENTITY_ID = 0;

/**
 * Callers own their request record and reuse it, which is what keeps the shot path
 * allocation free. It carries the weapon it was built for; retarget it per shot.
 */
export function makeDamageRequest(weapon: WeaponDef): DamageRequest {
  return {
    sourceId: PLAYER_ENTITY_ID,
    targetId: -1,
    zone: 'torso',
    upperTorso: false,
    weapon,
    distance: 0,
    penetrationRetain: 1,
    x: 0,
    y: 0,
    z: 0,
  };
}

const evDamage = {
  sourceId: 0,
  targetId: 0,
  weaponId: '',
  zone: 'torso' as HitZone,
  amount: 0,
  x: 0,
  y: 0,
  z: 0,
  distance: 0,
  falloffLoss: 0,
  penetrationLoss: 0,
  lethal: false,
};

const evKilled = { targetId: 0, sourceId: 0, weaponId: '', zone: 'torso' as HitZone };

/**
 * Damage multiplier for a zone, taken from the weapon rather than the rig.
 *
 * `upperTorso` splits the torso in two from M5. A weapon with `upperTorsoMult === 1` — every
 * weapon but the two snipers — is unaffected, which is what keeps M2's verified numbers
 * verified.
 */
export function zoneMultiplier(def: WeaponDef, zone: HitZone, upperTorso: boolean): number {
  switch (zone) {
    case 'head':
      return def.headshotMult;
    case 'torso':
      return upperTorso ? def.upperTorsoMult : 1;
    case 'arm':
    case 'leg':
      return def.limbMult;
  }
}

/** Falloff-interpolated base damage at `distance` metres. */
export function damageAtRange(def: WeaponDef, distance: number): number {
  const { start, end } = def.damageFalloff;
  if (end <= start) return distance <= start ? def.damage.near : def.damage.far;
  const t = clamp01((distance - start) / (end - start));
  return lerp(def.damage.near, def.damage.far, t);
}

export class DamageSystem {
  readonly lastHit: LastHitReport = {
    valid: false,
    targetName: '',
    zone: 'torso',
    upperTorso: false,
    distance: 0,
    baseDamage: 0,
    zoneMultiplier: 1,
    falloffLoss: 0,
    penetrationLoss: 0,
    finalDamage: 0,
    remainingHealth: 0,
    lethal: false,
    atMs: 0,
  };

  /**
   * Registered targets, kept as a flat array as well as a map: the ballistics
   * broadphase walks this every shot and a Map iterator would allocate.
   */
  readonly list: Damageable[] = [];

  /**
   * Whether a round may hurt a teammate (M4).
   *
   * Off in TDM, which is the CoD default for a core playlist and the only setting that
   * makes a team score mean anything: with it on, ten bots in a corridor spend the match
   * killing each other. It lives here because this is the one door damage goes through, and
   * `Ballistics` reads it to skip friendly rigs during target selection so the round passes
   * *through* a teammate rather than stopping harmlessly in one.
   */
  friendlyFire = false;

  private readonly entities = new Map<number, Damageable>();

  constructor(private readonly bus: GameBus) {}

  register(entity: Damageable): void {
    if (this.entities.has(entity.entityId)) this.unregister(entity.entityId);
    this.entities.set(entity.entityId, entity);
    this.list.push(entity);
  }

  unregister(entityId: number): void {
    const existing = this.entities.get(entityId);
    if (existing === undefined) return;
    this.entities.delete(entityId);
    const at = this.list.indexOf(existing);
    if (at >= 0) this.list.splice(at, 1);
  }

  get(entityId: number): Damageable | undefined {
    return this.entities.get(entityId);
  }

  /**
   * Apply one hit. Returns the damage actually dealt, or 0 if the target is gone or
   * already dead. Emits `damage.dealt`, and `entity.killed` on the lethal hit only.
   */
  apply(req: DamageRequest): number {
    const target = this.entities.get(req.targetId);
    if (target === undefined || !target.health.alive) return 0;
    if (target.invulnerable === true) return 0;
    if (!this.friendlyFire && req.sourceId !== req.targetId) {
      // The gate for every damage source, not just ballistics — which filters friendly
      // rigs out of target selection, so this is the one that will still be here when
      // grenades and killstreaks arrive with their own way of asking.
      const source = this.entities.get(req.sourceId);
      if (source !== undefined && source.team !== undefined && source.team === target.team) return 0;
    }

    const def = req.weapon;
    const base = damageAtRange(def, req.distance);
    const mult = zoneMultiplier(def, req.zone, req.upperTorso);
    const beforePenetration = base * mult;
    const retain = clamp01(req.penetrationRetain);
    const amount = beforePenetration * retain;

    const lethal = target.health.applyDamage(amount);

    const report = this.lastHit;
    report.valid = true;
    report.targetName = target.displayName;
    report.zone = req.zone;
    report.upperTorso = req.upperTorso;
    report.distance = req.distance;
    report.baseDamage = base;
    report.zoneMultiplier = mult;
    report.falloffLoss = (def.damage.near - base) * mult;
    report.penetrationLoss = beforePenetration - amount;
    report.finalDamage = amount;
    report.remainingHealth = target.health.current;
    report.lethal = lethal;
    report.atMs = performance.now();

    evDamage.sourceId = req.sourceId;
    evDamage.targetId = req.targetId;
    evDamage.weaponId = def.id;
    evDamage.zone = req.zone;
    evDamage.amount = amount;
    evDamage.x = req.x;
    evDamage.y = req.y;
    evDamage.z = req.z;
    evDamage.distance = req.distance;
    evDamage.falloffLoss = report.falloffLoss;
    evDamage.penetrationLoss = report.penetrationLoss;
    evDamage.lethal = lethal;
    this.bus.emit(EV.DamageDealt, evDamage);

    if (lethal) {
      evKilled.targetId = req.targetId;
      evKilled.sourceId = req.sourceId;
      evKilled.weaponId = def.id;
      evKilled.zone = req.zone;
      this.bus.emit(EV.EntityKilled, evKilled);
    }

    return amount;
  }

  get count(): number {
    return this.list.length;
  }
}
