import type { Vec3Lit } from './maps/types';

/**
 * The navmesh structure and its queries. The bake that fills it lives in `NavBake.ts`;
 * `Navmesh.ts` is the barrel both are consumed through.
 *
 * A uniform grid in XZ at ~0.5 m. Walkability comes from the **same** capsule-versus-
 * oriented-box test movement uses, so a cell the navmesh calls walkable is a cell the
 * capsule provably fits in — the navmesh cannot disagree with collision, because it asks
 * collision.
 *
 * **Columns carry up to `NAV_LAYERS` surfaces.** M1-M3 kept one height per XZ cell and
 * said so: the grey-box room has no place where two walkable surfaces genuinely overlap,
 * and PLAN.md recorded that M4's real maps would. Foundry's catwalks run directly over
 * walkable floor, so a column now holds the ground *and* the deck above it, and a node is
 * `layer * columnCount + iz * dimX + ix`. `indexOfX` / `indexOfZ` mod the layer out, so
 * every consumer that only cares where a node is in plan is unchanged.
 *
 * **Connectivity is directional, and it chooses a layer.** Two adjacent walkable surfaces
 * are linked only if the height difference is something the movement system can actually
 * cross: up to `stepHeight` climbing (silent step-up) and `maxDrop` descending (ground
 * snap). Where a neighbour column offers two surfaces the nearer one wins. A catwalk edge
 * over open floor is 4 m above it and therefore has no link at all, which is what stops a
 * bot walking off it; the ramps *are* linked, because half a metre of a 24 degree ramp is
 * 0.22 m.
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
export const DIAGONAL_DEPS: readonly Readonly<[number, number]>[] = [
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
];

/**
 * Walkable surfaces one XZ column may carry.
 *
 * Two, because that is what Foundry needs and what a 3-lane map with a catwalk deck
 * *means*: the floor, and the thing over it. `linkLayer` packs `LAYER_BITS` per direction
 * into a Uint16, so this may not exceed 4 without widening that word.
 */
export const NAV_LAYERS = 2;

const LAYER_BITS = 2;
const LAYER_MASK = (1 << LAYER_BITS) - 1;

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
  /** Nodes in the grid: columns times layers. */
  cells: number;
  walkable: number;
  /** Nodes that passed the geometry tests but were pruned as unreachable. */
  pruned: number;
  links: number;
  bakeMs: number;
  /** Columns that ended up carrying more than one walkable surface. */
  stacked: number;
}

export class NavGrid {
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly dimX: number;
  readonly dimZ: number;
  readonly layers: number;
  /** Nodes in one layer. A node is `layer * columnCount + iz * dimX + ix`. */
  readonly columnCount: number;

  /** 1 = a bot may stand here. */
  readonly walkable: Uint8Array;
  /** Feet height of the walkable surface, metres. Meaningless where not walkable. */
  readonly height: Float32Array;
  /** Bit k set when this node links to `NAV_DIRS[k]`. Directional. */
  readonly links: Uint8Array;
  /** `LAYER_BITS` per direction: which layer of the neighbour column the link lands on. */
  readonly linkLayer: Uint16Array;
  /** Surface normal Y, for debug colouring and slope-aware steering. */
  readonly normalY: Float32Array;

  readonly stats: NavBakeStats;

  constructor(
    cellSize: number,
    originX: number,
    originZ: number,
    dimX: number,
    dimZ: number,
    layers: number,
    stats: NavBakeStats,
  ) {
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;
    this.dimX = dimX;
    this.dimZ = dimZ;
    this.layers = layers;
    this.columnCount = dimX * dimZ;
    const n = this.columnCount * layers;
    this.walkable = new Uint8Array(n);
    this.height = new Float32Array(n);
    this.links = new Uint8Array(n);
    this.linkLayer = new Uint16Array(n);
    this.normalY = new Float32Array(n);
    this.stats = stats;
  }

  /** Total nodes. This is what A*'s working arrays are sized against. */
  get cellCount(): number {
    return this.columnCount * this.layers;
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

  /** The ground-layer node of a column. */
  index(ix: number, iz: number): number {
    return iz * this.dimX + ix;
  }

  node(ix: number, iz: number, layer: number): number {
    return layer * this.columnCount + iz * this.dimX + ix;
  }

  layerOf(node: number): number {
    return Math.floor(node / this.columnCount);
  }

  /** The column a node belongs to, i.e. where it is in plan. */
  columnOf(node: number): number {
    return node % this.columnCount;
  }

  indexOfX(node: number): number {
    return (node % this.columnCount) % this.dimX;
  }

  indexOfZ(node: number): number {
    return Math.floor((node % this.columnCount) / this.dimX);
  }

  isWalkable(node: number): boolean {
    return this.walkable[node] === 1;
  }

  heightAt(node: number): number {
    return this.height[node] ?? 0;
  }

  linked(node: number, dir: number): boolean {
    return ((this.links[node] ?? 0) & (1 << dir)) !== 0;
  }

  /** Record which layer of the neighbour column direction `dir` lands on. */
  setLinkLayer(node: number, dir: number, layer: number): void {
    const shift = dir * LAYER_BITS;
    const cleared = (this.linkLayer[node] ?? 0) & ~(LAYER_MASK << shift);
    this.linkLayer[node] = cleared | ((layer & LAYER_MASK) << shift);
  }

  /** The node `dir` leads to from `node`, resolved to its layer, or -1. */
  neighbour(node: number, dir: number): number {
    if (((this.links[node] ?? 0) & (1 << dir)) === 0) return -1;
    const step = NAV_DIRS[dir];
    if (step === undefined) return -1;
    const ix = this.indexOfX(node) + step.dx;
    const iz = this.indexOfZ(node) + step.dz;
    if (!this.inBounds(ix, iz)) return -1;
    const layer = ((this.linkLayer[node] ?? 0) >> (dir * LAYER_BITS)) & LAYER_MASK;
    return this.node(ix, iz, layer);
  }

  /**
   * Lowest walkable surface in the column containing this position, or -1.
   *
   * "Lowest" is the right default for anything asking about ground level, which is what
   * every pre-M4 caller meant. Anything that knows its own height wants `cellAtY`.
   */
  cellAt(x: number, z: number): number {
    const ix = this.cellX(x);
    const iz = this.cellZ(z);
    if (!this.inBounds(ix, iz)) return -1;
    const column = this.index(ix, iz);
    for (let l = 0; l < this.layers; l++) {
      const n = l * this.columnCount + column;
      if (this.walkable[n] === 1) return n;
    }
    return -1;
  }

  /**
   * Walkable surface in this column nearest to `y`, or -1.
   *
   * This is what a bot standing on a catwalk has to ask: the column under its feet also
   * holds the floor four metres below, and answering with that one is how an AI decides it
   * is somewhere it is not.
   */
  cellAtY(x: number, y: number, z: number): number {
    const ix = this.cellX(x);
    const iz = this.cellZ(z);
    if (!this.inBounds(ix, iz)) return -1;
    const column = this.index(ix, iz);
    let best = -1;
    let bestDelta = Infinity;
    for (let l = 0; l < this.layers; l++) {
      const n = l * this.columnCount + column;
      if (this.walkable[n] !== 1) continue;
      const delta = Math.abs((this.height[n] ?? 0) - y);
      if (delta >= bestDelta) continue;
      bestDelta = delta;
      best = n;
    }
    return best;
  }

  /**
   * Nearest walkable node to a world position, searched in expanding square rings.
   *
   * `y` breaks ties by height, which is what keeps a bot on a catwalk from being snapped to
   * the floor beneath it and a bot at the bottom of a pit from being snapped to the lip.
   */
  nearestCell(x: number, y: number, z: number, maxRings = 12): number {
    const direct = this.cellAtY(x, y, z);
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
          const column = this.index(ix, iz);
          for (let l = 0; l < this.layers; l++) {
            const i = l * this.columnCount + column;
            if (this.walkable[i] !== 1) continue;
            const dx = this.centerX(ix) - x;
            const dz = this.centerZ(iz) - z;
            const dy = (this.height[i] ?? 0) - y;
            const score = dx * dx + dz * dz + dy * dy * 4;
            if (score >= bestScore) continue;
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
   * Walkable surface in a column reachable from height `fromH`, or -1.
   *
   * The same directional rule the links use: climbing is bounded by step-up, descending by
   * ground snap, and where both layers qualify the nearer one wins.
   */
  layerFrom(ix: number, iz: number, fromH: number, stepHeight: number, maxDrop: number): number {
    if (!this.inBounds(ix, iz)) return -1;
    const column = this.index(ix, iz);
    let best = -1;
    let bestDelta = Infinity;
    for (let l = 0; l < this.layers; l++) {
      const n = l * this.columnCount + column;
      if (this.walkable[n] !== 1) continue;
      const rise = (this.height[n] ?? 0) - fromH;
      if (rise > stepHeight || rise < -maxDrop) continue;
      const delta = Math.abs(rise);
      if (delta >= bestDelta) continue;
      bestDelta = delta;
      best = n;
    }
    return best;
  }

  /**
   * Can a bot walk the straight line between two nodes?
   *
   * Used by the string-puller. Samples at half a cell so no column on the line is skipped,
   * and resolves a layer at every sample against the running height — a smoothed path must
   * obey the same height rules the links do, and must not cut from a catwalk to the floor
   * underneath it just because they are one cell apart in plan.
   */
  lineWalkable(fromIndex: number, toIndex: number, stepHeight: number, maxDrop: number): boolean {
    const ax = this.centerX(this.indexOfX(fromIndex));
    const az = this.centerZ(this.indexOfZ(fromIndex));
    const bx = this.centerX(this.indexOfX(toIndex));
    const bz = this.centerZ(this.indexOfZ(toIndex));
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil((dist / this.cellSize) * 2));
    let prevColumn = this.columnOf(fromIndex);
    let prevH = this.height[fromIndex] ?? 0;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const ix = this.cellX(ax + (bx - ax) * t);
      const iz = this.cellZ(az + (bz - az) * t);
      if (!this.inBounds(ix, iz)) return false;
      const column = this.index(ix, iz);
      if (column === prevColumn) continue;
      const node = this.layerFrom(ix, iz, prevH, stepHeight, maxDrop);
      if (node < 0) return false;
      prevColumn = column;
      prevH = this.height[node] ?? 0;
    }
    // The walk has to arrive at the surface that was asked for, not merely above or below it.
    return Math.abs(prevH - (this.height[toIndex] ?? 0)) < 1e-3;
  }
}
