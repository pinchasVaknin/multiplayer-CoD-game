import type { ColliderSet } from './ColliderSet';
import { makeRayHit, rayBox, type RayHit } from './Geometry';
import type { SpatialHash } from './SpatialHash';

/**
 * The gameplay raycaster (brief S4.3).
 *
 * Walks the same uniform hash the collision broadphase uses, with a 3D DDA
 * (Amanatides & Woo), and stops as soon as the nearest hit is provably inside the
 * current cell. `THREE.Raycaster` is not used and must not be: it walks the scene
 * graph and will not fit the frame budget. It is permitted in debug tooling only.
 *
 * Allocation free. All hits are written into a caller-owned `RayHit`.
 */

/** Guard against a pathological direction producing an unbounded walk. */
const MAX_CELLS_VISITED = 4096;

export class Raycaster {
  /** Narrowphase ray-vs-box tests since the last reset. Diagnostics. */
  tests = 0;

  private readonly scratch = makeRayHit();

  constructor(
    private readonly colliders: ColliderSet,
    private readonly hash: SpatialHash,
  ) {}

  /**
   * Cast against static world geometry. `dx,dy,dz` must be normalised.
   * Returns true and fills `out` with the nearest hit within `maxDist`.
   */
  cast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    out: RayHit,
  ): boolean {
    const hash = this.hash;
    hash.beginQuery();

    // Walk to the grid first if the origin sits outside it.
    let t0 = 0;
    if (!hash.inGrid(hash.rawCellX(ox), hash.rawCellY(oy), hash.rawCellZ(oz))) {
      const entry = this.gridEntryT(ox, oy, oz, dx, dy, dz, maxDist);
      if (entry < 0) return false;
      t0 = entry + 1e-4;
      if (t0 > maxDist) return false;
    }

    const px = ox + dx * t0;
    const py = oy + dy * t0;
    const pz = oz + dz * t0;

    let cx = hash.rawCellX(px);
    let cy = hash.rawCellY(py);
    let cz = hash.rawCellZ(pz);
    if (!hash.inGrid(cx, cy, cz)) return false;

    const cs = hash.cellSize;
    const [gx, gy, gz] = hash.origin;

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaX = stepX === 0 ? Infinity : Math.abs(cs / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(cs / dy);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(cs / dz);

    let tMaxX = stepX === 0 ? Infinity : t0 + boundaryDist(px, gx + cx * cs, cs, stepX, dx);
    let tMaxY = stepY === 0 ? Infinity : t0 + boundaryDist(py, gy + cy * cs, cs, stepY, dy);
    let tMaxZ = stepZ === 0 ? Infinity : t0 + boundaryDist(pz, gz + cz * cs, cs, stepZ, dz);

    let bestT = maxDist;
    let found = false;

    for (let guard = 0; guard < MAX_CELLS_VISITED; guard++) {
      const cell = hash.cellIndex(cx, cy, cz);
      hash.noteCell(cell);
      const end = hash.itemsEnd(cell);
      for (let k = hash.itemsBegin(cell); k < end; k++) {
        const idx = hash.itemAt(k);
        // `claim` de-duplicates colliders that straddle several cells.
        if (idx < 0 || !hash.claim(idx)) continue;
        this.tests++;
        if (!rayBox(this.colliders, idx, ox, oy, oz, dx, dy, dz, bestT, this.scratch)) continue;
        if (this.scratch.t >= bestT) continue;
        bestT = this.scratch.t;
        out.t = this.scratch.t;
        out.nx = this.scratch.nx;
        out.ny = this.scratch.ny;
        out.nz = this.scratch.nz;
        out.index = idx;
        found = true;
      }

      const tExit = Math.min(tMaxX, Math.min(tMaxY, tMaxZ));
      // A hit inside the current cell is final: no later cell can be nearer.
      if (found && bestT <= tExit) return true;
      if (tExit > maxDist) break;

      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY <= tMaxZ) {
        cy += stepY;
        tMaxY += tDeltaY;
      } else {
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (!hash.inGrid(cx, cy, cz)) break;
    }

    return found;
  }

  /** True when nothing blocks the segment from A to B. */
  segmentClear(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    out: RayHit,
  ): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    const inv = 1 / dist;
    return !this.cast(ax, ay, az, dx * inv, dy * inv, dz * inv, dist, out);
  }

  /**
   * Distance along the ray at which it enters the grid AABB, or -1 if it misses.
   * Written out per axis rather than via a helper closure: this runs inside the
   * gameplay raycast path and must not allocate.
   */
  private gridEntryT(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): number {
    const hash = this.hash;
    const cs = hash.cellSize;
    const [gx, gy, gz] = hash.origin;
    const [nx, ny, nz] = hash.dimensions;

    let tmin = 0;
    let tmax = maxDist;

    if (Math.abs(dx) < 1e-9) {
      if (ox < gx || ox > gx + nx * cs) return -1;
    } else {
      const inv = 1 / dx;
      let t1 = (gx - ox) * inv;
      let t2 = (gx + nx * cs - ox) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dy) < 1e-9) {
      if (oy < gy || oy > gy + ny * cs) return -1;
    } else {
      const inv = 1 / dy;
      let t1 = (gy - oy) * inv;
      let t2 = (gy + ny * cs - oy) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dz) < 1e-9) {
      if (oz < gz || oz > gz + nz * cs) return -1;
    } else {
      const inv = 1 / dz;
      let t1 = (gz - oz) * inv;
      let t2 = (gz + nz * cs - oz) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    return tmin;
  }
}

/** Distance from `p` to the next cell boundary in the direction of travel. */
function boundaryDist(p: number, cellMin: number, cellSize: number, step: number, d: number): number {
  const target = step > 0 ? cellMin + cellSize : cellMin;
  return (target - p) / d;
}
