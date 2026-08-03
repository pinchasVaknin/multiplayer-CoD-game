import type { BotTeam } from '../ai/Combatant';
import { DT } from '../core/Loop';
import type { CollisionWorld, MoveOutput } from '../world/CollisionWorld';
import { makeMoveOutput } from '../world/CollisionWorld';
import type { EquipmentConfig } from './EquipmentConfig';
import type { EquipmentDef } from './EquipmentDefs';

/**
 * A thrown object in flight (brief S6.3).
 *
 * The arc is an integrated ballistic curve stepped through the *existing* swept collision —
 * `CollisionWorld.moveCapsule` with a capsule whose height is twice its radius, which is a
 * sphere. No physics library, no second collision scheme, and the contact normals the
 * capsule solver already produces are exactly what a bounce needs (S4.3, S6.3).
 *
 * Everything is pooled and the pool never grows: a match can have a few dozen live objects
 * and each one is a fixed record written in place, so the per-tick path allocates nothing.
 */

export type ProjectilePhase =
  /** In the air or rolling. */
  | 'LIVE'
  /** Stuck to geometry or to somebody (semtex). */
  | 'STUCK'
  /** Planted and counting down to armed (claymore). */
  | 'ARMING'
  /** Planted, armed, watching its arc. */
  | 'ARMED'
  /** Fuse expired or trigger tripped; the system will detonate it this tick. */
  | 'DETONATE';

export interface Projectile {
  active: boolean;
  serial: number;
  def: EquipmentDef;
  ownerId: number;
  team: BotTeam | 'NONE';

  phase: ProjectilePhase;

  /** Centre of the sphere. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;

  /** Previous-tick centre, for render interpolation. */
  px: number;
  py: number;
  pz: number;

  /** Seconds until detonation, or -1 for trigger-armed equipment. */
  fuse: number;
  /** Seconds since it left the hand. */
  age: number;
  /** Facing, for a claymore's arc and for drawing an oriented mesh. */
  yaw: number;
  /** Seconds until the next proximity poll. */
  pollTimer: number;
  /** True once it has stopped moving. Still fused. */
  resting: boolean;
  /** Entity it is stuck to, or -1 for geometry. */
  stuckTo: number;
  /** Material index of the last surface hit, for the bounce sound. */
  material: number;
}

function makeProjectile(def: EquipmentDef): Projectile {
  return {
    active: false,
    serial: 0,
    def,
    ownerId: -1,
    team: 'NONE',
    phase: 'LIVE',
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    px: 0,
    py: 0,
    pz: 0,
    fuse: 0,
    age: 0,
    yaw: 0,
    pollTimer: 0,
    resting: false,
    stuckTo: -1,
    material: 0,
  };
}

/** What one integration tick did, so the caller can turn it into sound and light. */
export interface StepResult {
  bounced: boolean;
  stuck: boolean;
  planted: boolean;
  impactSpeed: number;
}

const RESULT: StepResult = { bounced: false, stuck: false, planted: false, impactSpeed: 0 };

/** A bounce quieter than this is a roll, and rolling should not click. */
const MIN_BOUNCE_SPEED = 1.2;

export class ProjectilePool {
  readonly items: Projectile[] = [];
  private nextSerial = 1;
  private readonly move: MoveOutput = makeMoveOutput();

  constructor(capacity: number, seedDef: EquipmentDef) {
    for (let i = 0; i < capacity; i++) this.items.push(makeProjectile(seedDef));
  }

  get liveCount(): number {
    let n = 0;
    for (const p of this.items) if (p.active) n++;
    return n;
  }

  /**
   * Claim a slot, or null when the pool is exhausted.
   *
   * Returning null rather than growing is the same decision M3 made about audio voices:
   * a bounded pool that occasionally refuses is a frame budget you can reason about, and
   * an unbounded one is a leak nobody notices until a soak run.
   */
  spawn(
    def: EquipmentDef,
    ownerId: number,
    team: BotTeam | 'NONE',
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    fuse: number,
  ): Projectile | null {
    for (const p of this.items) {
      if (p.active) continue;
      p.active = true;
      p.serial = this.nextSerial++;
      p.def = def;
      p.ownerId = ownerId;
      p.team = team;
      p.phase = 'LIVE';
      p.x = x;
      p.y = y;
      p.z = z;
      p.px = x;
      p.py = y;
      p.pz = z;
      p.vx = vx;
      p.vy = vy;
      p.vz = vz;
      p.fuse = fuse;
      p.age = 0;
      p.yaw = Math.atan2(-vx, -vz);
      p.pollTimer = 0;
      p.resting = false;
      p.stuckTo = -1;
      p.material = 0;
      return p;
    }
    return null;
  }

  release(p: Projectile): void {
    p.active = false;
    p.phase = 'LIVE';
    p.stuckTo = -1;
  }

  releaseAll(): void {
    for (const p of this.items) p.active = false;
  }

  /**
   * One tick of flight for one projectile.
   *
   * Returns a reused record; copy anything you keep. The fuse is *not* advanced here —
   * `EquipmentSystem` owns that, because a cooked grenade's fuse started before it was
   * thrown and the two clocks must not be in two places.
   */
  step(p: Projectile, world: CollisionWorld, cfg: EquipmentConfig): StepResult {
    RESULT.bounced = false;
    RESULT.stuck = false;
    RESULT.planted = false;
    RESULT.impactSpeed = 0;

    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
    p.age += DT;

    if (p.phase !== 'LIVE' || p.resting) return RESULT;

    const r = p.def.radius;

    // Integrate. Drag is a fraction of speed per second, which is enough to stop a hard
    // throw carrying half the map without needing a real drag model.
    p.vy -= cfg.gravity * DT;
    const decay = Math.max(0, 1 - cfg.drag * DT);
    p.vx *= decay;
    p.vy *= decay;
    p.vz *= decay;

    const speedIn = Math.hypot(p.vx, p.vy, p.vz);

    // The sphere is a capsule of height 2r; `moveCapsule` takes feet, so subtract r.
    world.moveCapsule(p.x, p.y - r, p.z, p.vx * DT, p.vy * DT, p.vz * DT, r, r * 2, this.move);
    p.x = this.move.x;
    p.y = this.move.y + r;
    p.z = this.move.z;

    if (this.move.contactCount === 0) return RESULT;

    // Average the contact normals. A grenade in a concave corner has two or three, and
    // reflecting about any single one of them sends it back into the other.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < this.move.contactCount; i++) {
      nx += this.move.normals[i * 3] ?? 0;
      ny += this.move.normals[i * 3 + 1] ?? 0;
      nz += this.move.normals[i * 3 + 2] ?? 0;
    }
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < 1e-6) return RESULT;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;

    if (this.move.groundIndex >= 0) p.material = world.colliders.materialAt(this.move.groundIndex);

    RESULT.impactSpeed = speedIn;

    switch (p.def.impact) {
      case 'stick':
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        p.phase = 'STUCK';
        p.resting = true;
        // Face out of the surface it landed on, so the charge reads as attached.
        p.yaw = Math.atan2(-nx, -nz);
        RESULT.stuck = true;
        return RESULT;

      case 'plant': {
        // A claymore only plants on something walkable; off a wall it drops and keeps
        // going, which is what stops one being stuck to a ceiling above a doorway.
        if (ny < 0.6) break;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        p.phase = 'ARMING';
        p.resting = true;
        p.fuse = p.def.armSeconds;
        RESULT.planted = true;
        return RESULT;
      }

      case 'bounce':
        break;
    }

    // Reflect: the component along the normal loses `restitution`, the component across it
    // loses `friction`. That single split is the whole difference between a grenade that
    // rolls round a corner and one that sticks where it lands.
    const vn = p.vx * nx + p.vy * ny + p.vz * nz;
    const tx = p.vx - vn * nx;
    const ty = p.vy - vn * ny;
    const tz = p.vz - vn * nz;
    const bounce = -vn * p.def.restitution;
    p.vx = tx * p.def.friction + nx * bounce;
    p.vy = ty * p.def.friction + ny * bounce;
    p.vz = tz * p.def.friction + nz * bounce;

    RESULT.bounced = speedIn > MIN_BOUNCE_SPEED;

    const speedOut = Math.hypot(p.vx, p.vy, p.vz);
    if (speedOut < p.def.restSpeed && ny > 0.55) {
      p.vx = 0;
      p.vy = 0;
      p.vz = 0;
      p.resting = true;
    }
    return RESULT;
  }
}

/**
 * Where a throw would land, as a polyline (S7's trajectory preview).
 *
 * Runs the *same* integration as `step` against the same collision world, so the preview
 * cannot disagree with the throw — a preview computed with its own closed-form parabola
 * would be a picture of a grenade this game does not have.
 *
 * Writes `x,y,z` triples into `out` and returns how many points it produced.
 */
export function previewTrajectory(
  def: EquipmentDef,
  cfg: EquipmentConfig,
  world: CollisionWorld,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  maxSeconds: number,
  out: Float32Array,
  /** Caller-owned scratch. The bot safety check runs this inside a sim tick. */
  move: MoveOutput,
): number {
  const r = def.radius;
  let cx = x;
  let cy = y;
  let cz = z;
  let dvx = vx;
  let dvy = vy;
  let dvz = vz;
  let w = 0;
  const steps = Math.min(Math.round(maxSeconds / DT), Math.floor(out.length / 3));

  for (let i = 0; i < steps; i++) {
    dvy -= cfg.gravity * DT;
    const decay = Math.max(0, 1 - cfg.drag * DT);
    dvx *= decay;
    dvy *= decay;
    dvz *= decay;

    world.moveCapsule(cx, cy - r, cz, dvx * DT, dvy * DT, dvz * DT, r, r * 2, move);
    cx = move.x;
    cy = move.y + r;
    cz = move.z;

    out[w++] = cx;
    out[w++] = cy;
    out[w++] = cz;

    if (move.contactCount === 0) continue;

    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let k = 0; k < move.contactCount; k++) {
      nx += move.normals[k * 3] ?? 0;
      ny += move.normals[k * 3 + 1] ?? 0;
      nz += move.normals[k * 3 + 2] ?? 0;
    }
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < 1e-6) continue;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;

    if (def.impact !== 'bounce') break;

    const vn = dvx * nx + dvy * ny + dvz * nz;
    const tx = dvx - vn * nx;
    const ty = dvy - vn * ny;
    const tz = dvz - vn * nz;
    const b = -vn * def.restitution;
    dvx = tx * def.friction + nx * b;
    dvy = ty * def.friction + ny * b;
    dvz = tz * def.friction + nz * b;
    if (Math.hypot(dvx, dvy, dvz) < def.restSpeed && ny > 0.55) break;
  }
  return w / 3;
}
