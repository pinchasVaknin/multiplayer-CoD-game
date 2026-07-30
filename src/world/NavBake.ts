import type { CollisionWorld } from './CollisionWorld';
import { makeRayHit, rayBox, rayBoxExit } from './Geometry';
import {
  DIAGONAL_DEPS,
  NAV_DIRS,
  NAV_LAYERS,
  NavGrid,
  type NavBakeOptions,
  type NavBakeStats,
} from './NavGrid';
import type { Box, Vec3Lit } from './maps/types';

/**
 * Baking the navmesh out of map geometry at load (brief S6.5).
 *
 * Nothing here knows anything about maps. It asks the collision world what is in each
 * vertical column, reduces that to the set of surfaces a capsule can actually stand on,
 * links the ones movement can actually get between, and throws away whatever the spawns
 * cannot reach. A map therefore needs no nav authoring at all — only honest `navBounds`,
 * because the bake walks that volume.
 *
 * The interval analysis is the part worth reading: casting a single ray down from the
 * ceiling finds the *topmost* surface, which is sometimes the top of an overhang the player
 * walks under. Instead every collider in the column becomes a `[bottom, top]` interval,
 * overlaps are merged, and **every** merged surface with standing headroom is a candidate
 * floor — lowest first. That is what gives a catwalk deck and the floor beneath it two
 * separate nodes instead of one wrong one.
 */

/**
 * How far above the found surface the clearance capsule is placed.
 *
 * A capsule resting exactly on a sloped surface intersects it: the bottom sphere's centre
 * is `radius` above the contact point vertically, but only `radius * cos(theta)` along the
 * surface normal. On the 46 degree limit that is a 0.11 m overlap, which would mark every
 * ramp cell unwalkable. Lifting past the worst case costs a little headroom strictness and
 * buys correct ramps.
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

/** Standable surfaces found in the current column, lowest first. */
const surfaceY = new Float64Array(NAV_LAYERS);
const surfaceNy = new Float64Array(NAV_LAYERS);

export function bakeNavmesh(world: CollisionWorld, bounds: Box, opts: NavBakeOptions): NavGrid {
  const t0 = performance.now();
  const cs = opts.cellSize;
  const originX = Math.floor(bounds.min.x / cs) * cs;
  const originZ = Math.floor(bounds.min.z / cs) * cs;
  const dimX = Math.max(1, Math.ceil((bounds.max.x - originX) / cs));
  const dimZ = Math.max(1, Math.ceil((bounds.max.z - originZ) / cs));

  const stats: NavBakeStats = {
    cells: dimX * dimZ * NAV_LAYERS,
    walkable: 0,
    pruned: 0,
    links: 0,
    bakeMs: 0,
    stacked: 0,
  };
  const grid = new NavGrid(cs, originX, originZ, dimX, dimZ, NAV_LAYERS, stats);

  const topY = bounds.max.y + 1;
  const columnDepth = bounds.max.y - bounds.min.y + 2;

  // ---- 1. surfaces + clearance per column ----------------------------------
  for (let iz = 0; iz < dimZ; iz++) {
    const z = grid.centerZ(iz);
    for (let ix = 0; ix < dimX; ix++) {
      const x = grid.centerX(ix);
      const intervals = collectColumn(world, x, z, topY, columnDepth);
      const found = standableSurfaces(intervals, bounds.min.y, opts);

      let layer = 0;
      for (let k = 0; k < found && layer < grid.layers; k++) {
        const y = surfaceY[k] ?? 0;
        // The authority on whether a bot fits here is the collision world itself.
        if (world.overlapCapsule(x, y + NAV_LIFT, z, opts.capsuleRadius, opts.standHeight)) continue;
        const node = grid.node(ix, iz, layer);
        grid.walkable[node] = 1;
        grid.height[node] = y;
        grid.normalY[node] = surfaceNy[k] ?? 1;
        layer++;
        stats.walkable++;
      }
      if (layer > 1) stats.stacked++;
    }
  }

  // ---- 2. connectivity -----------------------------------------------------
  linkGrid(grid, opts);

  // ---- 3. prune anything the spawns cannot reach ---------------------------
  stats.pruned = pruneUnreachable(grid, opts.seeds);
  if (stats.pruned > 0) {
    // Links pointed at nodes that no longer exist; rebuild rather than patch.
    stats.walkable -= stats.pruned;
    grid.links.fill(0);
    grid.linkLayer.fill(0);
    linkGrid(grid, opts);
  }

  let links = 0;
  for (let i = 0; i < grid.cellCount; i++) links += popcount8(grid.links[i] ?? 0);
  stats.links = links;
  stats.bakeMs = performance.now() - t0;
  return grid;
}

/**
 * A coarse scatter of walkable nodes, for patrol destinations.
 *
 * Sampled on a lattice rather than chosen at random so the points are spread rather than
 * clumped, and taken from the *pruned* grid so every one of them is reachable — a patrol goal
 * A* cannot solve is a bot standing still.
 *
 * **Upper layers are sampled at half the stride.** A ground floor is an *area* and a coarse
 * lattice describes it well; a catwalk is a *route* three metres wide, and the same lattice
 * walks straight past most of it. Measured on Foundry: the even lattice put 6 of 77 patrol
 * points on the deck, patrolling is about 5% of what a bot does in a firefight, and across
 * eighteen simulated minutes no bot went up at all. Density has to follow the route, not the
 * floor plan.
 */
export function samplePatrolCells(grid: NavGrid, spacingMetres: number): Int32Array {
  const baseStride = Math.max(1, Math.round(spacingMetres / grid.cellSize));
  const found: number[] = [];

  for (let layer = 0; layer < grid.layers; layer++) {
    const stride = layer === 0 ? baseStride : Math.max(1, Math.round(baseStride / 2));
    const offset = Math.floor(stride / 2);
    for (let iz = offset; iz < grid.dimZ; iz += stride) {
      for (let ix = offset; ix < grid.dimX; ix += stride) {
        const node = grid.node(ix, iz, layer);
        if (grid.walkable[node] === 1) {
          found.push(node);
          continue;
        }
        // Only the ground layer gets a nudge: an upper layer has genuine holes in it, and
        // snapping to the nearest walkable node would drag the point down onto the floor.
        if (layer !== 0) continue;
        const near = grid.nearestCell(grid.centerX(ix), 0, grid.centerZ(iz), 3);
        if (near >= 0 && !found.includes(near)) found.push(near);
      }
    }
  }
  return Int32Array.from(found);
}

// -- internals --------------------------------------------------------------

function linkGrid(grid: NavGrid, opts: NavBakeOptions): void {
  const { dimX, dimZ } = grid;
  for (let layer = 0; layer < grid.layers; layer++) {
    for (let iz = 0; iz < dimZ; iz++) {
      for (let ix = 0; ix < dimX; ix++) {
        const i = grid.node(ix, iz, layer);
        if (grid.walkable[i] !== 1) continue;
        const h = grid.height[i] ?? 0;
        let mask = 0;

        for (let d = 0; d < 4; d++) {
          const dir = NAV_DIRS[d];
          if (dir === undefined) continue;
          const j = grid.layerFrom(ix + dir.dx, iz + dir.dz, h, opts.stepHeight, opts.maxDrop);
          if (j < 0) continue;
          mask |= 1 << d;
          grid.setLinkLayer(i, d, grid.layerOf(j));
        }

        for (let d = 4; d < 8; d++) {
          const dir = NAV_DIRS[d];
          const deps = DIAGONAL_DEPS[d - 4];
          if (dir === undefined || deps === undefined) continue;
          // No corner cutting: a diagonal exists only where both its orthogonals do.
          if ((mask & (1 << deps[0])) === 0 || (mask & (1 << deps[1])) === 0) continue;
          const j = grid.layerFrom(ix + dir.dx, iz + dir.dz, h, opts.stepHeight, opts.maxDrop);
          if (j < 0) continue;
          mask |= 1 << d;
          grid.setLinkLayer(i, d, grid.layerOf(j));
        }

        grid.links[i] = mask;
      }
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
    for (let d = 0; d < 8; d++) {
      const j = grid.neighbour(i, d);
      if (j < 0 || seen[j] === 1) continue;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }

  let pruned = 0;
  for (let i = 0; i < n; i++) {
    if (grid.walkable[i] !== 1 || seen[i] === 1) continue;
    grid.walkable[i] = 0;
    grid.links[i] = 0;
    grid.linkLayer[i] = 0;
    pruned++;
  }
  return pruned;
}

/**
 * Reduce every collider in the column at (x, z) to a `[bottom, top]` interval, then merge
 * overlaps in place. Returns the number of merged intervals, ordered upward, with
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
 * Every merged surface that is a walkable slope with standing headroom above it, lowest
 * first, written into `surfaceY` / `surfaceNy`. Returns how many were found, capped at
 * `NAV_LAYERS`.
 *
 * Taking the lowest first is what makes an overhang something a bot walks *under*; taking
 * the ones above it too is what makes a catwalk somewhere a bot can walk *on*.
 */
function standableSurfaces(count: number, floorY: number, opts: NavBakeOptions): number {
  const needed = opts.standHeight + NAV_LIFT;
  let found = 0;
  for (let i = 0; i < count && found < NAV_LAYERS; i++) {
    const top = intervalHi[i] ?? 0;
    if (top < floorY) continue;
    if ((intervalNy[i] ?? 0) < opts.minGroundY) continue;
    const ceiling = i + 1 < count ? (intervalLo[i + 1] ?? Infinity) : Infinity;
    if (ceiling - top < needed) continue;
    surfaceY[found] = top;
    surfaceNy[found] = intervalNy[i] ?? 1;
    found++;
  }
  return found;
}

function popcount8(v: number): number {
  let x = v & 0xff;
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}
