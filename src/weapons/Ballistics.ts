import type { DamageRequest, DamageSystem } from '../combat/DamageSystem';
import { makeRigHit, type HitZone, type RigHit } from '../combat/HitboxRig';
import { EV, type GameBus } from '../core/Events';
import type { CollisionWorld } from '../world/CollisionWorld';
import { makeRayHit, rayBoxExit, type RayHit } from '../world/Geometry';
import { surfaceAtIndex } from '../world/maps/materials';
import type { WeaponDef } from './WeaponDefs';

/**
 * Hitscan ballistics (brief S4.4).
 *
 * All weapons are hitscan. At 800 m/s across a 50 m lane a simulated round takes 60 ms
 * to arrive, and players read that as "my shots aren't registering" — so the round lands
 * on the tick it is fired and the tracer is a visual that catches up afterwards.
 *
 * The trace walks the same 4 m spatial hash the collision broadphase uses (S4.3), never
 * `THREE.Raycaster`, and interleaves world geometry with damageable rigs so a round that
 * punches through a thin wall goes on to hit whatever is standing behind it.
 *
 * Allocation free: every record here is owned by the instance and reused.
 */

/** Range beyond which a round is simply gone. Larger than any M4 map lane. */
const MAX_RANGE = 300;
/** Surfaces a single round may attempt to punch through before it is spent. */
const MAX_PENETRATIONS = 4;
/** Nudge past an exit face so the next cast does not re-hit the surface it just left. */
const EXIT_EPSILON = 1e-3;

export interface ShotTrace {
  /** Total path length from muzzle to termination, metres. */
  distance: number;
  endX: number;
  endY: number;
  endZ: number;

  hitWorld: boolean;
  /** Surface normal at the terminating world impact. */
  nx: number;
  ny: number;
  nz: number;
  /** Material index of the terminating world impact. */
  material: number;

  hitTarget: boolean;
  targetId: number;
  zone: HitZone;
  damage: number;
  lethal: boolean;

  surfacesPenetrated: number;
  /** Surviving damage fraction after penetration, 0..1. */
  penetrationRetain: number;
  /** Accumulated penetration cost, metres of concrete equivalent. */
  penetrationCost: number;
}

export function makeShotTrace(): ShotTrace {
  return {
    distance: 0,
    endX: 0,
    endY: 0,
    endZ: 0,
    hitWorld: false,
    nx: 0,
    ny: 1,
    nz: 0,
    material: 0,
    hitTarget: false,
    targetId: -1,
    zone: 'torso',
    damage: 0,
    lethal: false,
    surfacesPenetrated: 0,
    penetrationRetain: 1,
    penetrationCost: 0,
  };
}

const evImpact = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, material: 0, penetrated: false };

export class Ballistics {
  /** Diagnostics: rig tests performed by the last shot. */
  lastRigTests = 0;

  private readonly rayHit: RayHit = makeRayHit();
  private readonly rigHit: RigHit = makeRigHit();
  private readonly bestRig: RigHit = makeRigHit();

  constructor(
    private readonly world: CollisionWorld,
    private readonly damage: DamageSystem,
    private readonly bus: GameBus,
  ) {}

  /**
   * Trace one round. `dx,dy,dz` must be normalised. `request` is the caller's reusable
   * damage record; its `weapon` field selects the ballistics.
   */
  fire(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    def: WeaponDef,
    request: DamageRequest,
    out: ShotTrace,
  ): void {
    out.distance = 0;
    out.endX = ox + dx * MAX_RANGE;
    out.endY = oy + dy * MAX_RANGE;
    out.endZ = oz + dz * MAX_RANGE;
    out.hitWorld = false;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.material = 0;
    out.hitTarget = false;
    out.targetId = -1;
    out.zone = 'torso';
    out.damage = 0;
    out.lethal = false;
    out.surfacesPenetrated = 0;
    out.penetrationRetain = 1;
    out.penetrationCost = 0;
    this.lastRigTests = 0;

    let px = ox;
    let py = oy;
    let pz = oz;
    let travelled = 0;
    let cost = 0;

    for (let pass = 0; pass <= MAX_PENETRATIONS; pass++) {
      const remaining = MAX_RANGE - travelled;
      if (remaining <= EXIT_EPSILON) break;

      const targetId = this.nearestTarget(px, py, pz, dx, dy, dz, remaining, request.sourceId);
      const targetT = targetId >= 0 ? this.bestRig.t : Infinity;
      const worldFound = this.world.raycast(px, py, pz, dx, dy, dz, remaining, this.rayHit);
      const worldT = worldFound ? this.rayHit.t : Infinity;

      // ---- a body stops the round -----------------------------------------
      if (targetId >= 0 && targetT <= worldT) {
        const total = travelled + targetT;
        out.distance = total;
        out.endX = px + dx * targetT;
        out.endY = py + dy * targetT;
        out.endZ = pz + dz * targetT;
        out.hitTarget = true;
        out.targetId = targetId;
        out.zone = this.bestRig.zone;
        out.nx = this.bestRig.nx;
        out.ny = this.bestRig.ny;
        out.nz = this.bestRig.nz;

        request.targetId = targetId;
        request.zone = this.bestRig.zone;
        request.distance = total;
        request.penetrationRetain = out.penetrationRetain;
        request.x = out.endX;
        request.y = out.endY;
        request.z = out.endZ;
        out.damage = this.damage.apply(request);
        const target = this.damage.get(targetId);
        out.lethal = target !== undefined && !target.health.alive;
        return;
      }

      // ---- nothing left to hit ---------------------------------------------
      if (!worldFound) {
        out.distance = MAX_RANGE;
        out.endX = px + dx * remaining;
        out.endY = py + dy * remaining;
        out.endZ = pz + dz * remaining;
        return;
      }

      // ---- world geometry ---------------------------------------------------
      const hitT = this.rayHit.t;
      const colliderIndex = this.rayHit.index;
      const hitX = px + dx * hitT;
      const hitY = py + dy * hitT;
      const hitZ = pz + dz * hitT;
      const material = this.world.colliders.materialAt(colliderIndex);

      out.distance = travelled + hitT;
      out.endX = hitX;
      out.endY = hitY;
      out.endZ = hitZ;
      out.hitWorld = true;
      out.nx = this.rayHit.nx;
      out.ny = this.rayHit.ny;
      out.nz = this.rayHit.nz;
      out.material = material;

      // How much material is actually in the way, and what it costs to cross.
      const exitT = rayBoxExit(this.world.colliders, colliderIndex, px, py, pz, dx, dy, dz);
      const thickness = exitT > hitT ? exitT - hitT : 0;
      const surface = surfaceAtIndex(material);
      const stepCost = thickness * surface.penetrationDensity;
      const budget = def.penetration;

      const canPass = pass < MAX_PENETRATIONS && budget > 0 && cost + stepCost < budget;

      evImpact.x = hitX;
      evImpact.y = hitY;
      evImpact.z = hitZ;
      evImpact.nx = out.nx;
      evImpact.ny = out.ny;
      evImpact.nz = out.nz;
      evImpact.material = material;
      evImpact.penetrated = canPass;
      this.bus.emit(EV.BulletImpact, evImpact);

      if (!canPass) {
        out.penetrationCost = cost + stepCost;
        return;
      }

      cost += stepCost;
      out.surfacesPenetrated++;
      out.penetrationCost = cost;
      out.penetrationRetain = 1 - cost / budget;

      const advance = exitT + EXIT_EPSILON;
      travelled += advance;
      px += dx * advance;
      py += dy * advance;
      pz += dz * advance;
    }
  }

  /**
   * Nearest damageable rig along the ray, or -1. The winning hit is left in
   * `this.bestRig`. Linear over the registered list, which is the right structure while
   * a match holds tens of actors rather than thousands; the static hash is built once at
   * load and must not have moving actors bolted into it (see PLAN.md).
   */
  private nearestTarget(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
    excludeId: number,
  ): number {
    const list = this.damage.list;
    let bestT = maxT;
    let bestId = -1;
    for (let i = 0; i < list.length; i++) {
      const entity = list[i];
      if (entity === undefined) continue;
      if (entity.entityId === excludeId) continue;
      if (!entity.health.alive) continue;
      this.lastRigTests++;
      if (!entity.rig.raycast(ox, oy, oz, dx, dy, dz, bestT, this.rigHit)) continue;
      if (this.rigHit.t >= bestT) continue;
      bestT = this.rigHit.t;
      bestId = entity.entityId;
      this.bestRig.t = this.rigHit.t;
      this.bestRig.zone = this.rigHit.zone;
      this.bestRig.boxIndex = this.rigHit.boxIndex;
      this.bestRig.nx = this.rigHit.nx;
      this.bestRig.ny = this.rigHit.ny;
      this.bestRig.nz = this.rigHit.nz;
    }
    return bestId;
  }
}
