import type { CollisionWorld } from './CollisionWorld';
import { rayBox, rayBoxExit, makeRayHit } from './Geometry';
import type { Box, Vec3Lit } from './maps/types';

/**
 * Navmesh grid, baked from map geometry at load (brief S6.5).
 *
 * A uniform grid in XZ at ~0.5 m, one walkable height per cell. Walkability comes from
 * the **same** capsule-versus-oriented-box test movement uses, so a cell the navmesh
 * calls walkable is a cell the capsule provably fits in — the navmesh cannot disagree
 * with collision, because it asks collision.
 *
 * Two things matter more than the grid itself:
 *
 * 1. **Surfaces are found by vertical interval analysis, not a single downward ray.**
 *    Casting down from the ceiling finds the *topmost* surface, which on this map is
 *    sometimes the top of an overhang the player can walk *under*. Instead every collider
 *    in the column is reduced to a `[bottom, top]` interval at the cell centre (entry and
 *    exit of a straight-down ray), the intervals are merged, and the **lowest** resulting
 *    surface with standing headroom wins. That is the floor a bot would actually use.
 *
 * 2. **Connectivity is a separate, directional decision.** Two adjacent walkable cells
 *    are linked only if the height difference is something the movement system can
 *    actually cross: up to `stepHeight` climbing (silent step-up) and `maxDrop`
 *    descending (ground snap). The 1.5 m ledge and the 3 m pit lip therefore have no
 *    links across them at all — which is exactly what S6.5 asks for when a bot cannot
 *    mantle, and it is what stops a bot walking off the edge or jittering into the wall
 *    below it. The ramps *are* linked, because 0.5 m of an 18 degree ramp is 0.16 m.
 *
 * Finally the graph is flood-filled from the map's spawn zones and everything
 * unreachable is discarded, which prunes the tops of crates, pillars and overhangs into
 * nothing rather than leaving islands for A* to fail against.
 *
 * Single-layer, deliberately: one height per XZ cell. The grey-box room has no place
 * where two walkable surfaces genuinely overlap. M4's real maps will, and that is when
 * this grows a second layer — see PLAN.md.
 */

/** Neighbour offsets. 0-3 orthogonal, 4-7 diagonal; diagonals need both orthogonals. */
export const NAV_DIRS: readonly Readonly<{ dx: number; dz: number; cost: number }>[] = [
  { dx: 1, dz: 0, cost: 1 },
  { dx: -1, dz: 0, cost: 1 },
  { dx: 0, dz: 1, cost: 1 },
  { dx: 0, dz: -1, cost: 1 },
  { dx: 1, dz: 1, cost: Math.SQRT2 },
  { dx: 1, dz: -1, cost: Math.SQRT2 },
  { dx: -1, dz: 1, cost: Math.SQRT2 },
  { dx: -1, dz: -1, cost: Math.SQRT2 },
];

/** Which orthogonal links a diagonal depends on, so corners are never cut. */
const DIAGONAL_DEPS: readonly Readonly<[number, number]>[] = [
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
];

export interface NavBakeOptions {
  readonly cellSize: number;
  readonly capsuleRadius: number;
  readonly standHeight: number;
  /** Climb a bot's movement can absorb silently, metres. */
  readonly stepHeight: number;
  /** Descent a bot may take without it reading as a fall, metres. */
  readonly maxDrop: number;
  /** cos of the steepest walkable slope. */
  readonly minGroundY: number;
  /** Reachability seeds. Anything not connected to one of these is discarded. */
  readonly seeds: readonly Vec3Lit[];
}

export interface NavBakeStats {
  cells: number;
  walkable: number;
  /** Cells that passed the geometry tests but were pruned as unreachable. */
  pruned: number;
  links: number;
  bakeMs: number;
}

/**
 * How far above the found surface the clearance capsule is placed.
 *
 * A capsule resting exactly on a sloped surface intersects it: the bottom sphere's
 * centre is `radius` above the contact point vertically, but only `radius * cos(theta)`
 * along the surface normal. On the 46 degree limit that is a 0.11 m overlap, which would
 * mark every ramp cell unwalkable. Lifting past the worst case costs a little headroom
 * strictness and buys correct ramps.
 */
const NAV_LIFT = 0.12;

/** Colliders considered in one vertical column. Well past anything a map stacks. */
const MAX_COLUMN = 96;

const columnCandidates = new Int32Array(512);
const intervalLo = new Float64Array(MAX_COLUMN);
const intervalHi = new Float64Array(MAX_COLUMN);
const intervalNy = new Float64Array(MAX_COLUMN);
const intervalOrder = new Int32Array(MAX_COLUMN);
const columnRay = makeRayHit();

export class NavGrid {
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly dimX: number;
  readonly dimZ: number;

  /** 1 = a bot may stand here. */
  readonly walkable: Uint8Array;
  /** Feet height of the walkable surface, metres. Meaningless where not walkable. */
  readonly height: Float32Array;
  /** Bit k set when this cell links to `NAV_DIRS[k]`. Directional. */
  readonly links: Uint8Array;
  /** Surface normal Y, for debug colouring and slope-aware steering. */
  readonly normalY: Float32Array;

  readonly stats: NavBakeStats;

  constructor(
    cellSize: number,
    originX: number,
    originZ: number,
    dimX: number,
    dimZ: number,
    stats: NavBakeStats,
  ) {
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;
    this.dimX = dimX;
    this.dimZ = dimZ;
    const n = dimX * dimZ;
    this.walkable = new Uint8Array(n);
    this.height = new Float32Array(n);
    this.links = new Uint8Array(n);
    this.normalY = new Float32Array(n);
    this.stats = stats;
  }

  get cellCount(): number {
    return this.dimX * this.dimZ;
  }

  cellX(x: number): number {
    return Math.floor((x - this.originX) / this.cellSize);
  }

  cellZ(z: number): number {
    return Math.floor((z - this.originZ) / this.cellSize);
  }

  centerX(ix: number): number {
    return this.originX + (ix + 0.5) * this.cellSize;
  }

  centerZ(iz: number): number {
    return this.originZ + (iz + 0.5) * this.cellSize;
  }

  inBounds(ix: number, iz: number): boolean {
    return ix >= 0 && iz >= 0 && ix < this.dimX && iz < this.dimZ;
  }

  index(ix: number, iz: number): number {
    return iz * this.dimX + ix;
  }

  indexOfX(index: number): number {
    return index % this.dimX;
  }

  indexOfZ(index: number): number {
    return Math.floor(index / this.dimX);
  }

  isWalkable(index: number): boolean {
    return this.walkable[index] === 1;
  }

  heightAt(index: number): number {
    return this.height[index] ?? 0;
  }

  linked(index: number, dir: number): boolean {
    return ((this.links[index] ?? 0) & (1 << dir)) !== 0;
  }

  /** Cell containing this world position, or -1 when it is off-grid or not walkable. */
  cellAt(x: number, z: number): number {
    const ix = this.cellX(x);
    const iz = this.cellZ(z);
    if (!this.inBounds(ix, iz)) return -1;
    const i = this.index(ix, iz);
    return this.walkable[i] === 1 ? i : -1;
  }

  /**
   * Nearest walkable cell to a world position, searched in expanding square rings.
   *
   * `y` breaks ties by height, which is what keeps a bot standing at the bottom of the
   * pit from being snapped to the lip 3 m above it.
   */
  nearestCell(x: number, y: number, z: number, maxRings = 12): number {
    const direct = this.cellAt(x, z);
    if (direct >= 0) return direct;

    const cx = this.cellX(x);
    const cz = this.cellZ(z);
    let best = -1;
    let bestScore = Infinity;

    for (let ring = 1; ring <= maxRings; ring++) {
      for (let oz = -ring; oz <= ring; oz++) {
        for (let ox = -ring; ox <= ring; ox++) {
          // Only the ring's perimeter; the interior was covered by a smaller ring.
          if (Math.max(Math.abs(ox), Math.abs(oz)) !== ring) continue;
          const ix = cx + ox;
          const iz = cz + oz;
          if (!this.inBounds(ix, iz)) continue;
          const i = this.index(ix, iz);
          if (this.walkable[i] !== 1) continue;
          const dx = this.centerX(ix) - x;
          const dz = this.centerZ(iz) - z;
          const dy = (this.height[i] ?? 0) - y;
          const score = dx * dx + dz * dz + dy * dy * 4;
          if (score < bestScore) {
            bestScore = score;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /**
   * Can a bot walk the straight line between two cells?
   *
   * Used by the string-puller. Samples at half a cell so no cell on the line is skipped,
   * and requires every sample to be walkable and within a step of its predecessor —
   * a smoothed path must obey the same height rules the links do.
   */
  lineWalkable(fromIndex: number, toIndex: number, stepHeight: number, maxDrop: number): boolean {
    const ax = this.centerX(this.indexOfX(fromIndex));
    const az = this.centerZ(this.indexOfZ(fromIndex));
    const bx = this.centerX(this.indexOfX(toIndex));
    const bz = this.centerZ(this.indexOfZ(toIndex));
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil((dist / this.cellSize) * 2));
    let prev = fromIndex;
    let prevH = this.height[fromIndex] ?? 0;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const ix = this.cellX(ax + (bx - ax) * t);
      const iz = this.cellZ(az + (bz - az) * t);
      if (!this.inBounds(ix, iz)) return false;
      const i = this.index(ix, iz);
      if (i === prev) continue;
      if (this.walkable[i] !== 1) return false;
      const h = this.height[i] ?? 0;
      const rise = h - prevH;
      if (rise > stepHeight || rise < -maxDrop) return false;
      prev = i;
      prevH = h;
    }
    return true;
  }
}

export function bakeNavmesh(world: CollisionWorld, bounds: Box, opts: NavBakeOptions): NavGrid {
  const t0 = performance.now();
  const cs = opts.cellSize;
  const originX = Math.floor(bounds.min.x / cs) * cs;
  const originZ = Math.floor(bounds.min.z / cs) * cs;
  const dimX = Math.max(1, Math.ceil((bounds.max.x - originX) / cs));
  const dimZ = Math.max(1, Math.ceil((bounds.max.z - originZ) / cs));

  const stats: NavBakeStats = { cells: dimX * dimZ, walkable: 0, pruned: 0, links: 0, bakeMs: 0 };
  const grid = new NavGrid(cs, originX, originZ, dimX, dimZ, stats);

  const topY = bounds.max.y + 1;
  const columnDepth = bounds.max.y - bounds.min.y + 2;

  // ---- 1. surface + clearance per cell -------------------------------------
  for (let iz = 0; iz < dimZ; iz++) {
    const z = grid.centerZ(iz);
    for (let ix = 0; ix < dimX; ix++) {
      const x = grid.centerX(ix);
      const i = grid.index(ix, iz);
      const count = collectColumn(world, x, z, topY, columnDepth);
      const surface = lowestStandableSurface(count, bounds.min.y, opts);
      if (surface < 0) continue;

      const surfaceY = intervalHi[surface] ?? 0;
      const ny = intervalNy[surface] ?? 1;
      // The authority on whether a bot fits here is the collision world itself.
      if (world.overlapCapsule(x, surfaceY + NAV_LIFT, z, opts.capsuleRadius, opts.standHeight)) {
        continue;
      }
      grid.walkable[i] = 1;
      grid.height[i] = surfaceY;
      grid.normalY[i] = ny;
      stats.walkable++;
    }
  }

  // ---- 2. connectivity -----------------------------------------------------
  linkGrid(grid, opts);

  // ---- 3. prune anything the spawns cannot reach ---------------------------
  stats.pruned = pruneUnreachable(grid, opts.seeds);
  if (stats.pruned > 0) {
    // Links pointed at cells that no longer exist; rebuild rather than patch.
    stats.walkable -= stats.pruned;
    grid.links.fill(0);
    linkGrid(grid, opts);
  }

  let links = 0;
  for (let i = 0; i < grid.cellCount; i++) links += popcount8(grid.links[i] ?? 0);
  stats.links = links;
  stats.bakeMs = performance.now() - t0;
  return grid;
}

/**
 * A coarse scatter of walkable cells, for patrol destinations.
 *
 * Sampled on a lattice rather than chosen at random so the points are spread rather than
 * clumped, and taken from the *pruned* grid so every one of them is reachable — a patrol
 * goal A* cannot solve is a bot standing still.
 */
export function samplePatrolCells(grid: NavGrid, spacingMetres: number): Int32Array {
  const stride = Math.max(1, Math.round(spacingMetres / grid.cellSize));
  const found: number[] = [];
  for (let iz = Math.floor(stride / 2); iz < grid.dimZ; iz += stride) {
    for (let ix = Math.floor(stride / 2); ix < grid.dimX; ix += stride) {
      // Nudge outward to the nearest walkable cell so a lattice point landing on a pillar
      // still contributes a nearby patrol spot instead of dropping out.
      const i = grid.index(ix, iz);
      if (grid.walkable[i] === 1) {
        found.push(i);
        continue;
      }
      const near = grid.nearestCell(grid.centerX(ix), grid.heightAt(i), grid.centerZ(iz), 3);
      if (near >= 0 && !found.includes(near)) found.push(near);
    }
  }
  return Int32Array.from(found);
}

// -- internals --------------------------------------------------------------

function linkGrid(grid: NavGrid, opts: NavBakeOptions): void {
  const { dimX, dimZ } = grid;
  for (let iz = 0; iz < dimZ; iz++) {
    for (let ix = 0; ix < dimX; ix++) {
      const i = grid.index(ix, iz);
      if (grid.walkable[i] !== 1) continue;
      const h = grid.height[i] ?? 0;
      let mask = 0;

      for (let d = 0; d < 4; d++) {
        const dir = NAV_DIRS[d];
        if (dir === undefined) continue;
        const jx = ix + dir.dx;
        const jz = iz + dir.dz;
        if (!grid.inBounds(jx, jz)) continue;
        const j = grid.index(jx, jz);
        if (grid.walkable[j] !== 1) continue;
        const rise = (grid.height[j] ?? 0) - h;
        // Directional: climbing is bounded by step-up, descending by ground snap.
        if (rise > opts.stepHeight || rise < -opts.maxDrop) continue;
        mask |= 1 << d;
      }

      for (let d = 4; d < 8; d++) {
        const dir = NAV_DIRS[d];
        const deps = DIAGONAL_DEPS[d - 4];
        if (dir === undefined || deps === undefined) continue;
        // No corner cutting: a diagonal exists only where both its orthogonals do.
        if ((mask & (1 << deps[0])) === 0 || (mask & (1 << deps[1])) === 0) continue;
        const jx = ix + dir.dx;
        const jz = iz + dir.dz;
        if (!grid.inBounds(jx, jz)) continue;
        const j = grid.index(jx, jz);
        if (grid.walkable[j] !== 1) continue;
        const rise = (grid.height[j] ?? 0) - h;
        if (rise > opts.stepHeight || rise < -opts.maxDrop) continue;
        mask |= 1 << d;
      }

      grid.links[i] = mask;
    }
  }
}

/** BFS from the spawn seeds; anything unvisited stops being walkable. */
function pruneUnreachable(grid: NavGrid, seeds: readonly Vec3Lit[]): number {
  const n = grid.cellCount;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  for (const seed of seeds) {
    const start = grid.nearestCell(seed.x, seed.y, seed.z, 20);
    if (start < 0 || seen[start] === 1) continue;
    seen[start] = 1;
    queue[tail++] = start;
  }

  while (head < tail) {
    const i = queue[head++] ?? 0;
    const ix = grid.indexOfX(i);
    const iz = grid.indexOfZ(i);
    for (let d = 0; d < 8; d++) {
      if (!grid.linked(i, d)) continue;
      const dir = NAV_DIRS[d];
      if (dir === undefined) continue;
      const jx = ix + dir.dx;
      const jz = iz + dir.dz;
      if (!grid.inBounds(jx, jz)) continue;
      const j = grid.index(jx, jz);
      if (seen[j] === 1) continue;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }

  let pruned = 0;
  for (let i = 0; i < n; i++) {
    if (grid.walkable[i] !== 1 || seen[i] === 1) continue;
    grid.walkable[i] = 0;
    grid.links[i] = 0;
    pruned++;
  }
  return pruned;
}

/**
 * Reduce every collider in the column at (x, z) to a `[bottom, top]` interval, then
 * merge overlaps in place. Returns the number of merged intervals, ordered upward, with
 * `intervalNy[k]` holding the surface normal Y of whichever collider owns the top.
 */
function collectColumn(
  world: CollisionWorld,
  x: number,
  z: number,
  topY: number,
  depth: number,
): number {
  const hash = world.hash;
  hash.beginQuery();
  const n = hash.queryAabb(x, topY - depth, z, x, topY, z, columnCandidates);

  let count = 0;
  for (let k = 0; k < n && count < MAX_COLUMN; k++) {
    const idx = columnCandidates[k] ?? -1;
    if (idx < 0) continue;
    // Straight down: entry is the collider's top surface at this XZ, exit its underside.
    if (!rayBox(world.colliders, idx, x, topY, z, 0, -1, 0, depth, columnRay)) continue;
    const exitT = rayBoxExit(world.colliders, idx, x, topY, z, 0, -1, 0);
    if (exitT <= columnRay.t) continue;
    intervalLo[count] = topY - exitT;
    intervalHi[count] = topY - columnRay.t;
    intervalNy[count] = columnRay.ny;
    count++;
  }
  if (count === 0) return 0;

  // Insertion sort by interval bottom. `count` is a handful of boxes in practice.
  for (let i = 0; i < count; i++) intervalOrder[i] = i;
  for (let i = 1; i < count; i++) {
    const cur = intervalOrder[i] ?? 0;
    const key = intervalLo[cur] ?? 0;
    let j = i - 1;
    while (j >= 0 && (intervalLo[intervalOrder[j] ?? 0] ?? 0) > key) {
      intervalOrder[j + 1] = intervalOrder[j] ?? 0;
      j--;
    }
    intervalOrder[j + 1] = cur;
  }

  // Merge forward into the front of the scratch arrays.
  let out = 0;
  let curLo = intervalLo[intervalOrder[0] ?? 0] ?? 0;
  let curHi = intervalHi[intervalOrder[0] ?? 0] ?? 0;
  let curNy = intervalNy[intervalOrder[0] ?? 0] ?? 1;
  for (let i = 1; i < count; i++) {
    const src = intervalOrder[i] ?? 0;
    const lo = intervalLo[src] ?? 0;
    const hi = intervalHi[src] ?? 0;
    const ny = intervalNy[src] ?? 1;
    if (lo <= curHi + 1e-4) {
      if (hi > curHi) {
        curHi = hi;
        curNy = ny;
      }
      continue;
    }
    intervalLo[out] = curLo;
    intervalHi[out] = curHi;
    intervalNy[out] = curNy;
    out++;
    curLo = lo;
    curHi = hi;
    curNy = ny;
  }
  intervalLo[out] = curLo;
  intervalHi[out] = curHi;
  intervalNy[out] = curNy;
  return out + 1;
}

/**
 * Index of the lowest merged interval whose top is a walkable slope with standing
 * headroom above it, or -1. "Lowest" is what makes an overhang something a bot walks
 * under rather than on.
 */
function lowestStandableSurface(count: number, floorY: number, opts: NavBakeOptions): number {
  const needed = opts.standHeight + NAV_LIFT;
  for (let i = 0; i < count; i++) {
    const top = intervalHi[i] ?? 0;
    if (top < floorY) continue;
    if ((intervalNy[i] ?? 0) < opts.minGroundY) continue;
    const ceiling = i + 1 < count ? (intervalLo[i + 1] ?? Infinity) : Infinity;
    if (ceiling - top < needed) continue;
    return i;
  }
  return -1;
}

function popcount8(v: number): number {
  let x = v & 0xff;
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}
