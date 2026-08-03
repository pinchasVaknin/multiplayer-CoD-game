import type { BotTeam, Combatant } from '../ai/Combatant';
import { makeDamageRequest, type DamageRequest, type DamageSystem } from '../combat/DamageSystem';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { DEG2RAD } from '../core/MathUtil';
import type { CollisionWorld } from '../world/CollisionWorld';
import { makeRayHit, type RayHit } from '../world/Geometry';
import type { EquipmentConfig } from './EquipmentConfig';
import { equipmentDef, type EquipmentDef, type EquipmentId, type EquipmentSlot } from './EquipmentDefs';
import { FlashField } from './FlashField';
import { ProjectilePool, type Projectile } from './Projectile';
import { SmokeField } from './SmokeField';
import { simCos, simSin } from '../core/SimMath';

/**
 * Everything thrown, and everything it does (brief S6.3).
 *
 * Owns the projectile pool, the smoke field and the flash field, and is the single place a
 * fuse is advanced or a detonation resolved — for the player and for every bot alike. A bot
 * throwing a frag calls `throwFrom` with exactly the arguments the player's throw uses.
 *
 * Blast damage goes through `DamageSystem.apply` with the equipment's `damageProfile`, so
 * there is still exactly one damage door (M3's note) and a grenade kill prints in the
 * killfeed and the debug read-out with no special case.
 *
 * Runs on sim ticks. Allocation free in the steady state: the pools are fixed and the
 * damage request and event payloads are owned by the instance.
 */

export interface EquipmentInventory {
  lethal: EquipmentId;
  tactical: EquipmentId;
  lethalCount: number;
  tacticalCount: number;
}

export function makeEquipmentInventory(lethal: EquipmentId, tactical: EquipmentId): EquipmentInventory {
  return {
    lethal,
    tactical,
    lethalCount: equipmentDef(lethal).count,
    tacticalCount: equipmentDef(tactical).count,
  };
}

/** How near the closest live lethal is to the player, for the HUD indicator. */
export interface ThreatReport {
  active: boolean;
  distance: number;
  /** Radians, relative to world +X/-Z, for the HUD to rotate against the view. */
  x: number;
  y: number;
  z: number;
  /** Seconds until it goes off, or -1 for a trigger-armed charge. */
  fuse: number;
}

const PROJECTILE_CAPACITY = 32;
const SMOKE_CAPACITY = 8;

const evThrown = { equipmentId: '', sourceId: 0, x: 0, y: 0, z: 0, cooked: 0 };
const evBounced = { equipmentId: '', x: 0, y: 0, z: 0, speed: 0, material: 0, stuck: false };
const evArmed = { equipmentId: '', sourceId: 0, x: 0, y: 0, z: 0 };
const evExploded = { equipmentId: '', sourceId: 0, x: 0, y: 0, z: 0, radius: 0, victims: 0 };
const evSmoke = { x: 0, y: 0, z: 0, radius: 0, seconds: 0 };

export interface EquipmentDeps {
  readonly bus: GameBus;
  readonly world: CollisionWorld;
  readonly damage: DamageSystem;
  readonly roster: readonly Combatant[];
  readonly cfg: EquipmentConfig;
}

export class EquipmentSystem {
  readonly projectiles: ProjectilePool;
  readonly smoke: SmokeField;
  readonly flash: FlashField;

  /** The nearest live threat to the local player, refreshed every tick. */
  readonly threat: ThreatReport = { active: false, distance: 0, x: 0, y: 0, z: 0, fuse: 0 };

  /** Diagnostics for the F1 panel. */
  thrownTotal = 0;
  detonatedTotal = 0;

  private readonly bus: GameBus;
  private readonly world: CollisionWorld;
  private readonly damage: DamageSystem;
  private readonly roster: readonly Combatant[];
  private readonly cfg: EquipmentConfig;
  private readonly request: DamageRequest;
  private readonly ray: RayHit = makeRayHit();

  constructor(deps: EquipmentDeps) {
    this.bus = deps.bus;
    this.world = deps.world;
    this.damage = deps.damage;
    this.roster = deps.roster;
    this.cfg = deps.cfg;
    this.projectiles = new ProjectilePool(PROJECTILE_CAPACITY, equipmentDef('frag'));
    this.smoke = new SmokeField(SMOKE_CAPACITY, deps.cfg);
    this.flash = new FlashField(deps.bus, deps.cfg);
    const profile = equipmentDef('frag').damageProfile;
    if (profile === null) throw new Error('The frag must carry a damage profile');
    this.request = makeDamageRequest(profile);
  }

  /**
   * Throw one.
   *
   * `cooked` is how long the fuse has already burned, which is what makes a cooked frag
   * different from a thrown one — the fuse is a single clock that starts when the pin comes
   * out, not when the hand opens (S6.3).
   *
   * `underhand` drops it at the thrower's feet rather than lobbing it, which is what a bot
   * must never do into its own cover and what a player wants when smoking a doorway they
   * are standing in.
   */
  throwFrom(
    def: EquipmentDef,
    ownerId: number,
    team: BotTeam | 'NONE',
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    yaw: number,
    pitch: number,
    ownerVx: number,
    ownerVz: number,
    cooked: number,
    underhand: boolean,
  ): Projectile | null {
    const cfg = this.cfg;
    const loft = (pitch + def.throwLoftDeg * DEG2RAD);
    const cp = simCos(loft);
    const sp = simSin(loft);
    const sy = simSin(yaw);
    const cy = simCos(yaw);
    const dx = -sy * cp;
    const dy = sp;
    const dz = -cy * cp;

    const speed = def.throwSpeed * (underhand ? def.dropScale : 1);
    const x = eyeX + dx * cfg.throwOffsetForward;
    const y = eyeY + cfg.throwOffsetUp + dy * cfg.throwOffsetForward;
    const z = eyeZ + dz * cfg.throwOffsetForward;

    const fuse = def.fuseSeconds < 0 ? -1 : Math.max(0.05, def.fuseSeconds - cooked);
    const p = this.projectiles.spawn(
      def,
      ownerId,
      team,
      x,
      y,
      z,
      dx * speed + ownerVx * cfg.throwInheritVelocity,
      dy * speed,
      dz * speed + ownerVz * cfg.throwInheritVelocity,
      fuse,
    );
    if (p === null) return null;

    this.thrownTotal++;
    evThrown.equipmentId = def.id;
    evThrown.sourceId = ownerId;
    evThrown.x = x;
    evThrown.y = y;
    evThrown.z = z;
    evThrown.cooked = cooked;
    this.bus.emit(EV.EquipmentThrown, evThrown);
    return p;
  }

  /** One sim tick: fly, fuse, trigger, detonate, and refresh the threat indicator. */
  simulate(localX: number, localY: number, localZ: number, localTeam: BotTeam): void {
    this.smoke.step();
    this.flash.step();

    this.threat.active = false;
    this.threat.distance = Infinity;

    for (const p of this.projectiles.items) {
      if (!p.active) continue;

      const result = this.projectiles.step(p, this.world, this.cfg);
      if (result.bounced || result.stuck || result.planted) {
        evBounced.equipmentId = p.def.id;
        evBounced.x = p.x;
        evBounced.y = p.y;
        evBounced.z = p.z;
        evBounced.speed = result.impactSpeed;
        evBounced.material = p.material;
        evBounced.stuck = result.stuck || result.planted;
        this.bus.emit(EV.EquipmentBounced, evBounced);
      }

      switch (p.phase) {
        case 'ARMING':
          p.fuse -= DT;
          if (p.fuse <= 0) {
            p.phase = 'ARMED';
            p.pollTimer = 0;
            evArmed.equipmentId = p.def.id;
            evArmed.sourceId = p.ownerId;
            evArmed.x = p.x;
            evArmed.y = p.y;
            evArmed.z = p.z;
            this.bus.emit(EV.EquipmentArmed, evArmed);
          }
          break;

        case 'ARMED':
          this.stepTrigger(p);
          break;

        case 'DETONATE':
          break;

        default:
          if (p.fuse >= 0) {
            p.fuse -= DT;
            if (p.fuse <= 0) p.phase = 'DETONATE';
          }
          break;
      }

      if (p.phase === 'DETONATE') {
        this.detonate(p);
        this.projectiles.release(p);
        continue;
      }

      this.noteThreat(p, localX, localY, localZ, localTeam);
    }
  }

  /**
   * A claymore watching its arc (S6.3): proximity plus a 180 degree cone, polled rather
   * than tested every tick because nobody crosses three metres in a tenth of a second.
   */
  private stepTrigger(p: Projectile): void {
    p.pollTimer -= DT;
    if (p.pollTimer > 0) return;
    p.pollTimer = this.cfg.triggerInterval;

    const half = simCos(p.def.triggerArcDeg * 0.5 * DEG2RAD);
    const fx = -simSin(p.yaw);
    const fz = -simCos(p.yaw);

    for (const c of this.roster) {
      if (!c.participating) continue;
      if (c.entityId === p.ownerId) continue;
      // Friendly fire is off, so a teammate walking past must not set it off either —
      // otherwise the charge is a way to delete your own equipment.
      if (c.team === p.team) continue;

      const dx = c.px - p.x;
      const dz = c.pz - p.z;
      const flat = Math.hypot(dx, dz);
      if (flat > p.def.triggerRadius) continue;
      if (Math.abs(c.py + 0.9 - p.y) > 2.4) continue;
      if (flat > 1e-4) {
        const dot = (dx * fx + dz * fz) / flat;
        if (dot < half) continue;
      }
      if (!this.world.segmentClear(p.x, p.y, p.z, c.px, c.py + c.aimHeight, c.pz, this.ray)) continue;

      p.phase = 'LIVE';
      p.fuse = this.cfg.triggerDelay;
      p.resting = true;
      return;
    }
  }

  /** Resolve a detonation: damage, flash, smoke, and the event that draws it. */
  private detonate(p: Projectile): void {
    const def = p.def;

    if (def.smokeSeconds > 0) {
      this.smoke.spawn(p.x, p.y + 0.6, p.z, def.smokeRadius, def.smokeSeconds, def.smokeBloom);
      evSmoke.x = p.x;
      evSmoke.y = p.y + 0.6;
      evSmoke.z = p.z;
      evSmoke.radius = def.smokeRadius;
      evSmoke.seconds = def.smokeSeconds;
      this.bus.emit(EV.SmokeSpawned, evSmoke);
    }

    let victims = 0;
    const profile = def.damageProfile;
    const radius = Math.max(def.effectRadius, def.flashSeconds > 0 ? def.effectRadius : 0);

    if (profile !== null || def.flashSeconds > 0) {
      for (const c of this.roster) {
        if (!c.participating) continue;
        const tx = c.px;
        const ty = c.py + c.aimHeight;
        const tz = c.pz;
        const distance = Math.hypot(tx - p.x, ty - p.y, tz - p.z);
        if (distance > radius) continue;

        // One ray per candidate, reused by both the damage and the flash. Cover works
        // against a blast, which is the entire reason to be behind it.
        const los = this.world.segmentClear(p.x, p.y, p.z, tx, ty, tz, this.ray);

        if (profile !== null && los) {
          this.request.weapon = profile;
          this.request.sourceId = p.ownerId;
          this.request.targetId = c.entityId;
          this.request.zone = 'torso';
          this.request.upperTorso = false;
          this.request.distance = distance;
          this.request.penetrationRetain = 1;
          this.request.x = tx;
          this.request.y = ty;
          this.request.z = tz;
          if (this.damage.apply(this.request) > 0) victims++;
        }

        if (def.flashSeconds > 0) {
          this.flash.apply(c, p.ownerId, p.x, p.y, p.z, def.effectRadius, def.flashSeconds, los);
        }
      }
    }

    this.detonatedTotal++;
    evExploded.equipmentId = def.id;
    evExploded.sourceId = p.ownerId;
    evExploded.x = p.x;
    evExploded.y = p.y;
    evExploded.z = p.z;
    evExploded.radius = def.effectRadius;
    evExploded.victims = victims;
    this.bus.emit(EV.EquipmentExploded, evExploded);
  }

  /** The grenade-indicator input (S6.3): nearest live enemy lethal within the radius. */
  private noteThreat(
    p: Projectile,
    lx: number,
    ly: number,
    lz: number,
    localTeam: BotTeam,
  ): void {
    if (p.def.damageProfile === null) return;
    if (p.team === localTeam) return;
    const distance = Math.hypot(p.x - lx, p.y - ly, p.z - lz);
    if (distance > this.cfg.indicatorRadius) return;
    if (distance >= this.threat.distance) return;
    this.threat.active = true;
    this.threat.distance = distance;
    this.threat.x = p.x;
    this.threat.y = p.y;
    this.threat.z = p.z;
    this.threat.fuse = p.fuse;
  }

  /** Blow up everything in flight without damaging anybody. Used by teardown and respawn. */
  clear(): void {
    this.projectiles.releaseAll();
    this.smoke.clear();
    this.flash.clear();
    this.threat.active = false;
  }

  /** Give a slot back on respawn (S6.3: equipment is per life). */
  static refill(inv: EquipmentInventory): void {
    inv.lethalCount = equipmentDef(inv.lethal).count;
    inv.tacticalCount = equipmentDef(inv.tactical).count;
  }

  static slotDef(inv: EquipmentInventory, slot: EquipmentSlot): EquipmentDef {
    return equipmentDef(slot === 'lethal' ? inv.lethal : inv.tactical);
  }

  static slotCount(inv: EquipmentInventory, slot: EquipmentSlot): number {
    return slot === 'lethal' ? inv.lethalCount : inv.tacticalCount;
  }

  static spendSlot(inv: EquipmentInventory, slot: EquipmentSlot): void {
    if (slot === 'lethal') inv.lethalCount = Math.max(0, inv.lethalCount - 1);
    else inv.tacticalCount = Math.max(0, inv.tacticalCount - 1);
  }
}
