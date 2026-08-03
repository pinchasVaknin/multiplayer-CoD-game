import type { ColliderSet } from './ColliderSet';
import type { Box } from './maps/types';

/**
 * Uniform spatial hash over static geometry, 4 m cells (brief S4.3).
 *
 * This single structure serves both the collision broadphase and every gameplay
 * raycast. There is no second acceleration structure and no THREE.Raycaster in the
 * gameplay path.
 *
 * Storage is CSR (compressed sparse row): one prefix-summed start table plus a flat
 * item array, built once at map load. Queries allocate nothing — results are written
 * into a caller-owned Int32Array and de-duplicated with a rolling stamp.
 */
export class SpatialHash {
  readonly cellSize: number;

  private originX = 0;
  private originY = 0;
  private originZ = 0;
  private dimX = 1;
  private dimY = 1;
  private dimZ = 1;

  private cellStart = new Int32Array(1);
  private cellItems = new Int32Array(0);

  private stamps = new Int32Array(0);
  private stampCounter = 0;

  /** Debug: record which cells the last query touched, for the collision overlay. */
  recordQueriedCells = false;
  readonly queriedCells = new Int32Array(4096);
  queriedCellCount = 0;

  constructor(cellSize = 4) {
    this.cellSize = cellSize;
  }

  get dimensions(): readonly [number, number, number] {
    return [this.dimX, this.dimY, this.dimZ];
  }

  get cellCount(): number {
    return this.dimX * this.dimY * this.dimZ;
  }

  get itemCount(): number {
    return this.cellItems.length;
  }

  get origin(): readonly [number, number, number] {
    return [this.originX, this.originY, this.originZ];
  }

  /** Build from a finished collider set. Bounds are padded by one cell. */
  build(set: ColliderSet, bounds: Box): void {
    const cs = this.cellSize;
    this.originX = Math.floor((bounds.min.x - cs) / cs) * cs;
    this.originY = Math.floor((bounds.min.y - cs) / cs) * cs;
    this.originZ = Math.floor((bounds.min.z - cs) / cs) * cs;

    this.dimX = Math.max(1, Math.ceil((bounds.max.x + cs - this.originX) / cs));
    this.dimY = Math.max(1, Math.ceil((bounds.max.y + cs - this.originY) / cs));
    this.dimZ = Math.max(1, Math.ceil((bounds.max.z + cs - this.originZ) / cs));

    const nCells = this.dimX * this.dimY * this.dimZ;
    const counts = new Int32Array(nCells + 1);

    // Pass 1: how many colliders land in each cell.
    for (let i = 0; i < set.count; i++) {
      this.forEachCellOfCollider(set, i, (cell) => {
        counts[cell + 1] = (counts[cell + 1] ?? 0) + 1;
      });
    }

    // Prefix sum.
    for (let c = 0; c < nCells; c++) {
      counts[c + 1] = (counts[c + 1] ?? 0) + (counts[c] ?? 0);
    }
    this.cellStart = counts;

    const total = counts[nCells] ?? 0;
    this.cellItems = new Int32Array(total);
    const cursor = new Int32Array(nCells);

    // Pass 2: place.
    for (let i = 0; i < set.count; i++) {
      this.forEachCellOfCollider(set, i, (cell) => {
        const base = this.cellStart[cell] ?? 0;
        const off = cursor[cell] ?? 0;
        this.cellItems[base + off] = i;
        cursor[cell] = off + 1;
      });
    }

    this.stamps = new Int32Array(set.count);
    this.stampCounter = 0;
  }

  // -- cell addressing ----------------------------------------------------

  cellXOf(x: number): number {
    return clampInt(Math.floor((x - this.originX) / this.cellSize), 0, this.dimX - 1);
  }
  cellYOf(y: number): number {
    return clampInt(Math.floor((y - this.originY) / this.cellSize), 0, this.dimY - 1);
  }
  cellZOf(z: number): number {
    return clampInt(Math.floor((z - this.originZ) / this.cellSize), 0, this.dimZ - 1);
  }

  /** Unclamped cell coordinate; used by the ray walker to detect leaving the grid. */
  rawCellX(x: number): number {
    return Math.floor((x - this.originX) / this.cellSize);
  }
  rawCellY(y: number): number {
    return Math.floor((y - this.originY) / this.cellSize);
  }
  rawCellZ(z: number): number {
    return Math.floor((z - this.originZ) / this.cellSize);
  }

  inGrid(cx: number, cy: number, cz: number): boolean {
    return cx >= 0 && cy >= 0 && cz >= 0 && cx < this.dimX && cy < this.dimY && cz < this.dimZ;
  }

  cellIndex(cx: number, cy: number, cz: number): number {
    return (cz * this.dimY + cy) * this.dimX + cx;
  }

  cellMinCorner(cell: number, out: Float32Array): void {
    const cx = cell % this.dimX;
    const cy = Math.floor(cell / this.dimX) % this.dimY;
    const cz = Math.floor(cell / (this.dimX * this.dimY));
    out[0] = this.originX + cx * this.cellSize;
    out[1] = this.originY + cy * this.cellSize;
    out[2] = this.originZ + cz * this.cellSize;
  }

  itemsBegin(cell: number): number {
    return this.cellStart[cell] ?? 0;
  }
  itemsEnd(cell: number): number {
    return this.cellStart[cell + 1] ?? 0;
  }
  itemAt(k: number): number {
    return this.cellItems[k] ?? -1;
  }

  // -- queries ------------------------------------------------------------

  /** Start a new de-duplication epoch. Call once per logical query. */
  beginQuery(): void {
    this.stampCounter++;
  }

  /**
   * Debug: drop the recorded cell list. Called once per sim tick by the collision
   * visualiser so the overlay shows every cell touched during that tick, not just the
   * cells of the last query.
   */
  clearRecordedCells(): void {
    this.queriedCellCount = 0;
  }

  /**
   * True the first time `index` is seen in the current epoch. Lets a caller walk
   * several cells (a swept AABB, a ray) and still visit each collider once.
   */
  claim(index: number): boolean {
    if ((this.stamps[index] ?? 0) === this.stampCounter) return false;
    this.stamps[index] = this.stampCounter;
    return true;
  }

  noteCell(cell: number): void {
    if (!this.recordQueriedCells) return;
    if (this.queriedCellCount >= this.queriedCells.length) return;
    for (let i = 0; i < this.queriedCellCount; i++) {
      if (this.queriedCells[i] === cell) return;
    }
    this.queriedCells[this.queriedCellCount++] = cell;
  }

  /**
   * Collect every collider whose world AABB region overlaps the given box.
   * Returns the number written into `out`. Call `beginQuery()` first.
   */
  queryAabb(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Int32Array,
  ): number {
    const x0 = this.cellXOf(minX);
    const x1 = this.cellXOf(maxX);
    const y0 = this.cellYOf(minY);
    const y1 = this.cellYOf(maxY);
    const z0 = this.cellZOf(minZ);
    const z1 = this.cellZOf(maxZ);

    let n = 0;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const cell = this.cellIndex(cx, cy, cz);
          this.noteCell(cell);
          const end = this.itemsEnd(cell);
          for (let k = this.itemsBegin(cell); k < end; k++) {
            const idx = this.itemAt(k);
            if (idx < 0 || !this.claim(idx)) continue;
            if (n >= out.length) return n;
            out[n++] = idx;
          }
        }
      }
    }
    return n;
  }

  private forEachCellOfCollider(set: ColliderSet, i: number, visit: (cell: number) => void): void {
    const x0 = this.cellXOf(set.aabbAt(i, 0));
    const y0 = this.cellYOf(set.aabbAt(i, 1));
    const z0 = this.cellZOf(set.aabbAt(i, 2));
    const x1 = this.cellXOf(set.aabbAt(i, 3));
    const y1 = this.cellYOf(set.aabbAt(i, 4));
    const z1 = this.cellZOf(set.aabbAt(i, 5));
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          visit(this.cellIndex(cx, cy, cz));
        }
      }
    }
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
