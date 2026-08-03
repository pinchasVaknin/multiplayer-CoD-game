import { materialIndex, type MaterialKey, type Vec3Lit } from './maps/types';

/**
 * Write a rotation basis (columns = local axes in world space) into `out` at `offset`.
 * Rotations compose as R = Rz * Rx * Ry, which is also the order the mesher uses, so
 * a brush's collider and its render mesh can never disagree.
 */
export function writeBasis(
  rotationY: number,
  rotationX: number,
  rotationZ: number,
  out: Float32Array | number[],
  offset = 0,
): void {
  const cy = Math.cos(rotationY);
  const sy = Math.sin(rotationY);
  const cx = Math.cos(rotationX);
  const sx = Math.sin(rotationX);
  const cz = Math.cos(rotationZ);
  const sz = Math.sin(rotationZ);

  out[offset] = cz * cy + sz * sx * sy;
  out[offset + 1] = sz * cx;
  out[offset + 2] = -cz * sy + sz * sx * cy;

  out[offset + 3] = -sz * cy + cz * sx * sy;
  out[offset + 4] = cz * cx;
  out[offset + 5] = sz * sy + cz * sx * cy;

  out[offset + 6] = cx * sy;
  out[offset + 7] = -sx;
  out[offset + 8] = cx * cy;
}

/**
 * Static world geometry as oriented boxes, stored in flat typed arrays.
 *
 * One representation, used by both the collision broadphase and every gameplay
 * raycast (brief S4.3). Struct-of-arrays because M4's real maps will hold thousands
 * of brushes and the sweep loop touches centre/half/basis together.
 *
 * Basis layout, 9 floats per collider, columns are the box's local axes expressed in
 * world space:
 *   X axis = (b0, b1, b2)   Y axis = (b3, b4, b5)   Z axis = (b6, b7, b8)
 * so world->local is the transpose (a dot product per axis) and local->world is a
 * weighted sum of the columns.
 */
export class ColliderSet {
  count = 0;
  readonly capacity: number;

  readonly center: Float32Array;
  readonly half: Float32Array;
  readonly basis: Float32Array;
  readonly aabb: Float32Array;
  readonly axisAligned: Uint8Array;
  readonly material: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.center = new Float32Array(capacity * 3);
    this.half = new Float32Array(capacity * 3);
    this.basis = new Float32Array(capacity * 9);
    this.aabb = new Float32Array(capacity * 6);
    this.axisAligned = new Uint8Array(capacity);
    this.material = new Uint8Array(capacity);
  }

  /**
   * Append a box. Rotations are applied in Y -> X -> Z order, matching how the mesher
   * builds the matching render mesh.
   */
  add(
    position: Vec3Lit,
    size: Vec3Lit,
    rotationY: number,
    rotationX: number,
    rotationZ: number,
    material: MaterialKey,
  ): number {
    if (this.count >= this.capacity) {
      throw new Error(`ColliderSet full at ${this.capacity}; raise the capacity in MapLoader.`);
    }
    const i = this.count++;
    const c3 = i * 3;
    const b9 = i * 9;

    this.center[c3] = position.x;
    this.center[c3 + 1] = position.y;
    this.center[c3 + 2] = position.z;
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    this.half[c3] = hx;
    this.half[c3 + 1] = hy;
    this.half[c3 + 2] = hz;

    const aligned = rotationY === 0 && rotationX === 0 && rotationZ === 0;
    this.axisAligned[i] = aligned ? 1 : 0;
    this.material[i] = materialIndex(material);

    writeBasis(rotationY, rotationX, rotationZ, this.basis, b9);
    const x0 = this.basis[b9] ?? 0;
    const x1 = this.basis[b9 + 1] ?? 0;
    const x2 = this.basis[b9 + 2] ?? 0;
    const y0 = this.basis[b9 + 3] ?? 0;
    const y1 = this.basis[b9 + 4] ?? 0;
    const y2 = this.basis[b9 + 5] ?? 0;
    const z0 = this.basis[b9 + 6] ?? 0;
    const z1 = this.basis[b9 + 7] ?? 0;
    const z2 = this.basis[b9 + 8] ?? 0;

    // World AABB: project the half extents onto each world axis.
    const ex = Math.abs(x0) * hx + Math.abs(y0) * hy + Math.abs(z0) * hz;
    const ey = Math.abs(x1) * hx + Math.abs(y1) * hy + Math.abs(z1) * hz;
    const ez = Math.abs(x2) * hx + Math.abs(y2) * hy + Math.abs(z2) * hz;
    const a6 = i * 6;
    this.aabb[a6] = position.x - ex;
    this.aabb[a6 + 1] = position.y - ey;
    this.aabb[a6 + 2] = position.z - ez;
    this.aabb[a6 + 3] = position.x + ex;
    this.aabb[a6 + 4] = position.y + ey;
    this.aabb[a6 + 5] = position.z + ez;

    return i;
  }

  // -- accessors (all read-only, all allocation free) ---------------------

  centerX(i: number): number {
    return this.center[i * 3] ?? 0;
  }
  centerY(i: number): number {
    return this.center[i * 3 + 1] ?? 0;
  }
  centerZ(i: number): number {
    return this.center[i * 3 + 2] ?? 0;
  }
  halfX(i: number): number {
    return this.half[i * 3] ?? 0;
  }
  halfY(i: number): number {
    return this.half[i * 3 + 1] ?? 0;
  }
  halfZ(i: number): number {
    return this.half[i * 3 + 2] ?? 0;
  }
  basisAt(i: number, k: number): number {
    return this.basis[i * 9 + k] ?? 0;
  }
  aabbAt(i: number, k: number): number {
    return this.aabb[i * 6 + k] ?? 0;
  }
  isAxisAligned(i: number): boolean {
    return this.axisAligned[i] === 1;
  }
  materialAt(i: number): number {
    return this.material[i] ?? 0;
  }
}
