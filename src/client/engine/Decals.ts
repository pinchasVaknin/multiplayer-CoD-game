import * as THREE from 'three';
import type { Rng } from '../../shared/core/Rng';
import { buildDecalTexture } from './FxAssets';

/**
 * Bullet-hole decals: a fixed pool with LRU recycling (brief S6.5).
 *
 * One `InstancedMesh`, so the whole field is a single draw call however many holes are on
 * the wall, and a ring cursor, so hole 97 quietly reuses the slot of hole 1. There is no
 * growth path and no fade-out timer — a hard cap with recycling is both cheaper and more
 * predictable than a lifetime, and it is what acceptance criterion 6 asks to see hold.
 */

/**
 * Raised from 96 in M7, for the accuracy wall (M6 playtest item).
 *
 * 96 recycled inside a single LMG magazine, so a group being measured lost its earliest holes
 * while the burst that made them was still going — which is precisely the case the wall exists
 * to serve. 192 holds two full magazines of the largest-magazine weapon in the arsenal, so a
 * group survives a reload and can be compared against the next one.
 *
 * Nearly free: the whole field is one `InstancedMesh` and therefore one draw call whatever the
 * count, so this buys 96 more instance matrices and no additional state changes.
 */
const CAPACITY = 192;
/** Lift off the surface, metres. Backed up by a polygon offset in the material. */
const SURFACE_LIFT = 0.006;

export class DecalField {
  readonly mesh: THREE.InstancedMesh;

  private cursor = 0;
  private count = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly spin = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly planeNormal = new THREE.Vector3(0, 0, 1);
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(anisotropy: number, private readonly disposables: Array<{ dispose(): void }>) {
    const texture = buildDecalTexture(anisotropy);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(texture, material, geometry);

    const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
    mesh.name = 'fx:decals';
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < CAPACITY; i++) {
      mesh.setMatrixAt(i, this.hidden);
      mesh.setColorAt(i, this.color.setHex(0xffffff));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
  }

  get live(): number {
    return this.count;
  }

  get capacity(): number {
    return CAPACITY;
  }

  /** `strength` darkens the hole; `radius` is the decal's half-size in metres. */
  place(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    radius: number,
    strength: number,
    rng: Rng,
  ): void {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % CAPACITY;
    if (this.count < CAPACITY) this.count++;

    // Lift off the surface and spin randomly about it so repeated hits on one wall do not
    // read as a stamped pattern. The spin composes into the same quaternion, so no second
    // matrix is needed and nothing allocates.
    this.position.set(x + nx * SURFACE_LIFT, y + ny * SURFACE_LIFT, z + nz * SURFACE_LIFT);
    this.normal.set(nx, ny, nz).normalize();
    this.quat.setFromUnitVectors(this.planeNormal, this.normal);
    this.spin.setFromAxisAngle(this.planeNormal, rng.float() * Math.PI * 2);
    this.quat.multiply(this.spin);

    const size = radius * 2 * rng.range(0.85, 1.2);
    this.scale.set(size, size, 1);
    this.matrix.compose(this.position, this.quat, this.scale);
    this.mesh.setMatrixAt(index, this.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;

    const v = Math.round(255 * (1 - Math.min(1, Math.max(0, strength)) * 0.75));
    this.mesh.setColorAt(index, this.color.setRGB(v / 255, v / 255, v / 255));
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < CAPACITY; i++) this.mesh.setMatrixAt(i, this.hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cursor = 0;
    this.count = 0;
  }
}
