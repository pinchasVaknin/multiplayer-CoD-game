import { ColliderSet } from './ColliderSet';
import { capsuleBoxPenetration, makeContact, type Contact, type RayHit } from './Geometry';
import { Raycaster } from './Raycaster';
import { SpatialHash } from './SpatialHash';
import type { Box } from './maps/types';
import { simCos } from '../core/SimMath';

/**
 * The one collision scheme (brief S4.3): swept capsule against static oriented boxes,
 * de-penetrated along the contact normal, at most 4 resolution iterations per tick,
 * broadphased through the same 4 m spatial hash that serves gameplay raycasts.
 *
 * "Swept" is implemented by substepping: a move is split so the capsule never advances
 * more than 40% of its radius before being resolved, which makes tunnelling impossible
 * at any speed the game can produce, without needing a closed-form capsule-vs-OBB
 * time-of-impact.
 *
 * Every entry point here is allocation free.
 */

export const MAX_CONTACTS = 8;
const MAX_SUBSTEPS = 16;
const RESOLUTION_ITERATIONS = 4;
const CANDIDATE_CAP = 512;
const SUBSTEP_FRACTION = 0.4;

export interface MoveOutput {
  x: number;
  y: number;
  z: number;
  contactCount: number;
  /** 3 floats per contact. */
  readonly normals: Float32Array;
  /** 3 floats per contact: the point on the box surface. */
  readonly points: Float32Array;
  grounded: boolean;
  groundNx: number;
  groundNy: number;
  groundNz: number;
  groundIndex: number;
  hitCeiling: boolean;
  hitWall: boolean;
  /** Deepest penetration resolved during the move. Diagnostics. */
  maxDepth: number;
  /** Total resolution iterations spent. Diagnostics. */
  iterations: number;
}

export function makeMoveOutput(): MoveOutput {
  return {
    x: 0,
    y: 0,
    z: 0,
    contactCount: 0,
    normals: new Float32Array(MAX_CONTACTS * 3),
    points: new Float32Array(MAX_CONTACTS * 3),
    grounded: false,
    groundNx: 0,
    groundNy: 0,
    groundNz: 0,
    groundIndex: -1,
    hitCeiling: false,
    hitWall: false,
    maxDepth: 0,
    iterations: 0,
  };
}

export interface GroundProbe {
  /** How far the capsule must drop to rest on the surface, metres. */
  distance: number;
  nx: number;
  ny: number;
  nz: number;
  index: number;
}

export function makeGroundProbe(): GroundProbe {
  return { distance: 0, nx: 0, ny: 1, nz: 0, index: -1 };
}

export class CollisionWorld {
  readonly colliders: ColliderSet;
  readonly hash: SpatialHash;

  /** cos of the steepest walkable slope. Set from MovementConfig at load. */
  private minGroundY = simCos((46 * Math.PI) / 180);
  private skin = 0.005;

  private readonly candidates = new Int32Array(CANDIDATE_CAP);
  private readonly contact = makeContact();
  private readonly best = makeContact();

  /** Shares this world's collider set and hash — one structure, one scheme (S4.3). */
  readonly raycaster: Raycaster;

  /** Diagnostics for the debug overlay; reset by the caller each tick. */
  broadphaseTests = 0;
  narrowphaseTests = 0;

  constructor(colliders: ColliderSet, bounds: Box, cellSize = 4) {
    this.colliders = colliders;
    this.hash = new SpatialHash(cellSize);
    this.hash.build(colliders, bounds);
    this.raycaster = new Raycaster(colliders, this.hash);
  }

  configure(maxSlopeDeg: number, skin: number): void {
    this.minGroundY = simCos((maxSlopeDeg * Math.PI) / 180);
    this.skin = skin;
  }

  get groundNormalMin(): number {
    return this.minGroundY;
  }

  // -- capsule movement ---------------------------------------------------

  /**
   * Move a capsule standing on `y` (feet) by (dx,dy,dz), resolving collisions.
   * The result position is written into `out.x/y/z`.
   */
  moveCapsule(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    radius: number,
    height: number,
    out: MoveOutput,
  ): void {
    out.x = x;
    out.y = y;
    out.z = z;
    out.contactCount = 0;
    out.grounded = false;
    out.groundIndex = -1;
    out.groundNx = 0;
    out.groundNy = 0;
    out.groundNz = 0;
    out.hitCeiling = false;
    out.hitWall = false;
    out.maxDepth = 0;
    out.iterations = 0;

    const len = Math.hypot(dx, dy, dz);
    let steps = 1;
    if (len > 0) {
      steps = Math.ceil(len / Math.max(radius * SUBSTEP_FRACTION, 1e-4));
      if (steps < 1) steps = 1;
      if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
    }
    const inv = 1 / steps;
    const sx = dx * inv;
    const sy = dy * inv;
    const sz = dz * inv;

    for (let s = 0; s < steps; s++) {
      out.x += sx;
      out.y += sy;
      out.z += sz;
      this.resolve(out, radius, height);
    }
  }

  /** De-penetrate in place, e.g. after a stance change grew the capsule. */
  resolveAt(x: number, y: number, z: number, radius: number, height: number, out: MoveOutput): void {
    out.x = x;
    out.y = y;
    out.z = z;
    out.contactCount = 0;
    out.grounded = false;
    out.groundIndex = -1;
    out.hitCeiling = false;
    out.hitWall = false;
    out.maxDepth = 0;
    out.iterations = 0;
    this.resolve(out, radius, height);
  }

  /** True when the capsule at this position intersects anything. */
  overlapCapsule(x: number, y: number, z: number, radius: number, height: number): boolean {
    const ax = x;
    const ay = y + radius;
    const az = z;
    const bx = x;
    const by = y + height - radius;
    const bz = z;

    const n = this.gatherCandidates(x, y, z, radius, height);
    for (let k = 0; k < n; k++) {
      const idx = this.candidates[k] ?? -1;
      if (idx < 0) continue;
      this.narrowphaseTests++;
      if (capsuleBoxPenetration(this.colliders, idx, ax, ay, az, bx, by, bz, radius, this.contact)) {
        if (this.contact.depth > this.skin) return true;
      }
    }
    return false;
  }

  /**
   * Look for walkable ground beneath the capsule, up to `maxDrop` metres.
   * Steps the capsule down in fixed increments and refines with the contact depth,
   * so it respects the capsule's shape rather than approximating with rays.
   */
  probeGround(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    maxDrop: number,
    out: GroundProbe,
  ): boolean {
    const step = 0.04;
    for (let d = step; d <= maxDrop + 1e-4; d += step) {
      const testY = y - d;
      if (!this.deepestWalkableContact(x, testY, z, radius, height)) continue;
      const ny = this.best.ny;
      // Lift the capsule back out along the vertical so it just kisses the surface.
      const lift = this.best.depth / Math.max(ny, 0.25);
      out.distance = Math.max(0, d - lift);
      out.nx = this.best.nx;
      out.ny = ny;
      out.nz = this.best.nz;
      out.index = this.best.index;
      return true;
    }
    return false;
  }

  // -- raycast ------------------------------------------------------------

  /**
   * Gameplay raycast against the spatial hash. `dx,dy,dz` must be normalised.
   * Delegates to Raycaster, which walks the same grid this class broadphases against.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    out: RayHit,
  ): boolean {
    return this.raycaster.cast(ox, oy, oz, dx, dy, dz, maxDist, out);
  }

  /** Convenience: is there clear line of sight between two points? */
  segmentClear(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    out: RayHit,
  ): boolean {
    return this.raycaster.segmentClear(ax, ay, az, bx, by, bz, out);
  }

  // -- internals ----------------------------------------------------------

  private gatherCandidates(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
  ): number {
    const pad = radius + this.skin + 0.01;
    this.hash.beginQuery();
    this.broadphaseTests++;
    return this.hash.queryAabb(
      x - pad,
      y - this.skin - 0.01,
      z - pad,
      x + pad,
      y + height + this.skin + 0.01,
      z + pad,
      this.candidates,
    );
  }

  /** Deepest contact of any kind at this pose. Result lands in `this.best`. */
  private deepestContact(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
  ): boolean {
    const ax = x;
    const ay = y + radius;
    const bx = x;
    const by = y + height - radius;

    const n = this.gatherCandidates(x, y, z, radius, height);
    let bestDepth = 0;
    let any = false;
    for (let k = 0; k < n; k++) {
      const idx = this.candidates[k] ?? -1;
      if (idx < 0) continue;
      this.narrowphaseTests++;
      if (!capsuleBoxPenetration(this.colliders, idx, ax, ay, z, bx, by, z, radius, this.contact)) {
        continue;
      }
      if (this.contact.depth > bestDepth) {
        bestDepth = this.contact.depth;
        copyContact(this.contact, this.best);
        any = true;
      }
    }
    return any;
  }

  /** Deepest contact whose normal is walkable. Result lands in `this.best`. */
  private deepestWalkableContact(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
  ): boolean {
    const ax = x;
    const ay = y + radius;
    const bx = x;
    const by = y + height - radius;

    const n = this.gatherCandidates(x, y, z, radius, height);
    let bestDepth = 0;
    let any = false;
    for (let k = 0; k < n; k++) {
      const idx = this.candidates[k] ?? -1;
      if (idx < 0) continue;
      this.narrowphaseTests++;
      if (!capsuleBoxPenetration(this.colliders, idx, ax, ay, z, bx, by, z, radius, this.contact)) {
        continue;
      }
      if (this.contact.ny < this.minGroundY) continue;
      if (this.contact.depth > bestDepth) {
        bestDepth = this.contact.depth;
        copyContact(this.contact, this.best);
        any = true;
      }
    }
    return any;
  }

  /**
   * De-penetrate along contact normals. At most RESOLUTION_ITERATIONS passes; each
   * pass fully resolves the single deepest contact, which converges on corners in two
   * or three passes and cannot fight itself the way a simultaneous push can.
   */
  private resolve(out: MoveOutput, radius: number, height: number): void {
    for (let iter = 0; iter < RESOLUTION_ITERATIONS; iter++) {
      out.iterations++;
      if (!this.deepestContact(out.x, out.y, out.z, radius, height)) break;
      const c = this.best;
      if (c.depth > out.maxDepth) out.maxDepth = c.depth;

      const push = c.depth + this.skin;
      out.x += c.nx * push;
      out.y += c.ny * push;
      out.z += c.nz * push;

      this.recordContact(out, c);

      if (c.ny >= this.minGroundY) {
        if (!out.grounded || c.ny > out.groundNy) {
          out.grounded = true;
          out.groundNx = c.nx;
          out.groundNy = c.ny;
          out.groundNz = c.nz;
          out.groundIndex = c.index;
        }
      } else if (c.ny < -0.5) {
        out.hitCeiling = true;
      } else {
        out.hitWall = true;
      }
    }
  }

  private recordContact(out: MoveOutput, c: Contact): void {
    // Fold near-parallel normals together so a flat floor built from four brushes
    // does not fill the contact list with copies of (0,1,0).
    for (let i = 0; i < out.contactCount; i++) {
      const i3 = i * 3;
      const dot =
        (out.normals[i3] ?? 0) * c.nx + (out.normals[i3 + 1] ?? 0) * c.ny + (out.normals[i3 + 2] ?? 0) * c.nz;
      if (dot > 0.995) return;
    }
    if (out.contactCount >= MAX_CONTACTS) return;
    const i3 = out.contactCount * 3;
    out.normals[i3] = c.nx;
    out.normals[i3 + 1] = c.ny;
    out.normals[i3 + 2] = c.nz;
    out.points[i3] = c.px;
    out.points[i3 + 1] = c.py;
    out.points[i3 + 2] = c.pz;
    out.contactCount++;
  }

}

function copyContact(src: Contact, dst: Contact): void {
  dst.depth = src.depth;
  dst.nx = src.nx;
  dst.ny = src.ny;
  dst.nz = src.nz;
  dst.px = src.px;
  dst.py = src.py;
  dst.pz = src.pz;
  dst.index = src.index;
}
