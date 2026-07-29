import * as THREE from 'three';
import { Rng } from '../core/Rng';
import { surfaceAtIndex } from '../world/maps/materials';
import { DecalField } from './Decals';
import { buildFlashGeometry, buildFlashTexture } from './FxAssets';

/**
 * Shot feedback: muzzle flash, tracers, impact debris and decals (brief S6.5).
 *
 * Everything here is pooled and preallocated. A 700 RPM weapon fires twelve rounds a
 * second; anything that allocates per shot shows up in the frame histogram as a sawtooth
 * within about ten seconds of holding the trigger, which is exactly what acceptance
 * criterion 6 is looking for.
 *
 * Draw-call budget: one instanced mesh per effect class (tracers, sparks, dust, decals),
 * one mesh for the muzzle flash and one reused point light — six draws for all of it,
 * regardless of how much is on screen.
 *
 * This runs at render rate. None of it is gameplay; the round already landed.
 */

const TRACER_CAP = 24;
const SPARK_CAP = 220;
const DUST_CAP = 220;

/** Visual travel speed, m/s. The round was hitscan; the streak is theatre. */
const TRACER_SPEED = 620;
const TRACER_LENGTH = 3.2;
const TRACER_WIDTH = 0.022;

const FLASH_SECONDS = 0.05;
const FLASH_FRAMES = 3;
const MUZZLE_LIGHT_DISTANCE = 12;

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

interface Tracer {
  active: boolean;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  total: number;
  travelled: number;
}

interface Particle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
}

export class Fx {
  /** Added to the world scene. */
  readonly group = new THREE.Group();

  private readonly rng = new Rng(0x7f4a_11c3);

  private readonly tracers: Tracer[] = [];
  private readonly sparks: Particle[] = [];
  private readonly dust: Particle[] = [];

  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly dustMesh: THREE.InstancedMesh;
  private readonly decalField: DecalField;

  private readonly muzzleLight = new THREE.PointLight(0xffd9a0, 0, MUZZLE_LIGHT_DISTANCE, 2);
  private flashMesh: THREE.Mesh | null = null;
  private flashTimer = 0;
  private flashScale = 1;
  private muzzleLightPeak = 0;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  private readonly forwardAxis = new THREE.Vector3(0, 0, 1);

  constructor(anisotropy: number) {
    this.group.name = 'fx';

    for (let i = 0; i < TRACER_CAP; i++) {
      this.tracers.push({ active: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1, total: 0, travelled: 0 });
    }
    for (let i = 0; i < SPARK_CAP; i++) this.sparks.push(makeParticle());
    for (let i = 0; i < DUST_CAP; i++) this.dust.push(makeParticle());

    this.tracerMesh = this.makeInstanced(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      TRACER_CAP,
      'fx:tracers',
    );

    this.sparkMesh = this.makeInstanced(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      SPARK_CAP,
      'fx:sparks',
    );

    this.dustMesh = this.makeInstanced(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
      DUST_CAP,
      'fx:dust',
    );

    this.decalField = new DecalField(anisotropy, this.disposables);
    this.group.add(this.decalField.mesh);

    this.muzzleLight.name = 'fx:muzzleLight';
    this.group.add(this.muzzleLight);
  }

  get activeTracers(): number {
    return countActive(this.tracers);
  }

  get activeParticles(): number {
    return countActive(this.sparks) + countActive(this.dust);
  }

  get decals(): number {
    return this.decalField.live;
  }

  get decalCapacity(): number {
    return this.decalField.capacity;
  }

  /**
   * Build the muzzle flash and parent it to the weapon's muzzle anchor, so it inherits
   * every animation the viewmodel does rather than being pinned in front of the camera.
   */
  attachMuzzle(parent: THREE.Object3D): void {
    if (this.flashMesh !== null) return;
    const geometry = buildFlashGeometry();
    const material = new THREE.MeshBasicMaterial({
      map: buildFlashTexture(),
      color: 0xffd08a,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const map = material.map;
    if (map !== null) this.disposables.push(map);
    this.disposables.push(geometry, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'fx:muzzleFlash';
    mesh.visible = false;
    parent.add(mesh);
    this.flashMesh = mesh;
  }

  // -- spawning -------------------------------------------------------------

  /** `scale` comes from the weapon's `muzzleFlashScale`. */
  fireMuzzleFlash(worldX: number, worldY: number, worldZ: number, scale: number): void {
    this.flashTimer = FLASH_SECONDS;
    this.flashScale = scale;
    this.muzzleLight.position.set(worldX, worldY, worldZ);
    this.muzzleLightPeak = 9 * scale;
  }

  spawnTracer(
    x: number,
    y: number,
    z: number,
    endX: number,
    endY: number,
    endZ: number,
  ): void {
    const dx = endX - x;
    const dy = endY - y;
    const dz = endZ - z;
    const total = Math.hypot(dx, dy, dz);
    if (total < 0.2) return;
    const tracer = this.freeTracer();
    if (tracer === null) return;
    const inv = 1 / total;
    tracer.active = true;
    tracer.x = x;
    tracer.y = y;
    tracer.z = z;
    tracer.dx = dx * inv;
    tracer.dy = dy * inv;
    tracer.dz = dz * inv;
    tracer.total = total;
    tracer.travelled = 0;
  }

  /** Material-dependent burst plus a decal (S6.5). */
  spawnImpact(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    material: number,
    penetrated: boolean,
  ): void {
    const surface = surfaceAtIndex(material);
    const strength = penetrated ? 0.55 : 1;

    const sparkCount = Math.round(surface.impactSpark * 9 * strength);
    for (let i = 0; i < sparkCount; i++) {
      const at = firstFree(this.sparks);
      if (at < 0) break;
      this.launch(this.sparks, at, x, y, z, nx, ny, nz, this.rng.range(3.5, 9), this.rng.range(0.16, 0.34), 0.016);
      this.setInstanceColor(this.sparkMesh, at, 0xffc46a);
    }

    const dustCount = Math.round((3 + 5 * (1 - surface.impactSpark)) * strength);
    for (let i = 0; i < dustCount; i++) {
      const at = firstFree(this.dust);
      if (at < 0) break;
      this.launch(this.dust, at, x, y, z, nx, ny, nz, this.rng.range(0.8, 2.6), this.rng.range(0.24, 0.46), 0.03);
      this.setInstanceColor(this.dustMesh, at, surface.impactColor);
    }

    this.decalField.place(x, y, z, nx, ny, nz, surface.decalRadius, surface.decalStrength * strength, this.rng);
  }

  /** A hit on a body: a short, tight puff, no decal. */
  spawnHitPuff(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    for (let i = 0; i < 5; i++) {
      const at = firstFree(this.dust);
      if (at < 0) break;
      this.launch(this.dust, at, x, y, z, nx, ny, nz, this.rng.range(1.2, 3.0), this.rng.range(0.14, 0.26), 0.024);
      this.setInstanceColor(this.dustMesh, at, 0xd8c8b4);
    }
  }

  // -- per-frame ------------------------------------------------------------

  update(dt: number): void {
    const step = Math.min(Math.max(dt, 0), 1 / 20);
    this.updateTracers(step);
    this.updateParticles(this.sparks, this.sparkMesh, step, 9.5);
    this.updateParticles(this.dust, this.dustMesh, step, 3.2);
    this.updateFlash(step);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }

  // -- internals ------------------------------------------------------------

  private makeInstanced(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, HIDDEN);
      mesh.setColorAt(i, this.scratchColor.setHex(0xffffff));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.disposables.push(geometry, material);
    return mesh;
  }

  private setInstanceColor(mesh: THREE.InstancedMesh, index: number, hex: number): void {
    if (index < 0) return;
    mesh.setColorAt(index, this.scratchColor.setHex(hex));
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  private freeTracer(): Tracer | null {
    for (const t of this.tracers) if (!t.active) return t;
    return null;
  }

  private launch(
    list: Particle[],
    index: number,
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    speed: number,
    life: number,
    size: number,
  ): void {
    const p = list[index];
    if (p === undefined) return;
    // Scatter into the hemisphere around the surface normal, biased outward.
    const jx = this.rng.spread();
    const jy = this.rng.spread();
    const jz = this.rng.spread();
    let vx = nx * 1.4 + jx;
    let vy = ny * 1.4 + jy;
    let vz = nz * 1.4 + jz;
    const inv = speed / Math.max(Math.hypot(vx, vy, vz), 1e-4);
    vx *= inv;
    vy *= inv;
    vz *= inv;

    p.active = true;
    p.x = x + nx * 0.02;
    p.y = y + ny * 0.02;
    p.z = z + nz * 0.02;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.life = life;
    p.maxLife = life;
    p.size = size * this.rng.range(0.7, 1.4);
  }

  private updateTracers(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.tracers.length; i++) {
      const t = this.tracers[i];
      if (t === undefined) continue;
      if (!t.active) continue;
      dirty = true;
      t.travelled += TRACER_SPEED * dt;
      const head = Math.min(t.travelled, t.total);
      const tail = Math.max(0, t.travelled - TRACER_LENGTH);
      if (tail >= t.total) {
        t.active = false;
        this.tracerMesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      const length = head - tail;
      if (length <= 0) {
        this.tracerMesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      const mid = (head + tail) * 0.5;
      this.scratchPos.set(t.x + t.dx * mid, t.y + t.dy * mid, t.z + t.dz * mid);
      this.scratchDir.set(t.dx, t.dy, t.dz);
      this.scratchQuat.setFromUnitVectors(this.forwardAxis, this.scratchDir);
      this.scratchScale.set(TRACER_WIDTH, TRACER_WIDTH, length);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.tracerMesh.setMatrixAt(i, this.scratchMatrix);
    }
    if (dirty) this.tracerMesh.instanceMatrix.needsUpdate = true;
  }

  private updateParticles(
    list: Particle[],
    mesh: THREE.InstancedMesh,
    dt: number,
    gravity: number,
  ): void {
    let dirty = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p === undefined || !p.active) continue;
      dirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      p.vy -= gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      // Shrink as it dies: cheaper and steadier than fading alpha per instance.
      const scale = p.size * (p.life / p.maxLife);
      this.scratchPos.set(p.x, p.y, p.z);
      this.scratchQuat.identity();
      this.scratchScale.set(scale, scale, scale);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      mesh.setMatrixAt(i, this.scratchMatrix);
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  private updateFlash(dt: number): void {
    const mesh = this.flashMesh;
    if (this.flashTimer <= 0) {
      if (mesh !== null && mesh.visible) mesh.visible = false;
      if (this.muzzleLight.intensity !== 0) this.muzzleLight.intensity = 0;
      return;
    }
    this.flashTimer -= dt;
    const t = Math.max(0, this.flashTimer / FLASH_SECONDS);

    // Three discrete frames rather than a smooth fade: a real muzzle flash is two or
    // three exposed frames of very different shapes, and easing it looks like fire.
    const frame = Math.min(FLASH_FRAMES - 1, Math.floor((1 - t) * FLASH_FRAMES));
    if (mesh !== null) {
      mesh.visible = this.flashTimer > 0;
      const shape = [1.0, 0.62, 0.34][frame] ?? 0.3;
      const s = this.flashScale * shape;
      mesh.scale.set(s, s, s * (frame === 0 ? 1.25 : 0.8));
      mesh.rotation.z = frame * 1.9 + this.flashScale;
    }
    this.muzzleLight.intensity = this.muzzleLightPeak * t * t;
  }
}

function makeParticle(): Particle {
  return { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0.02 };
}

/** Index of the first idle particle, or -1. Index, not the object: the caller needs it
 *  to address the matching instance in the InstancedMesh. */
function firstFree(list: Particle[]): number {
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p !== undefined && !p.active) return i;
  }
  return -1;
}

function countActive(list: Array<{ active: boolean }>): number {
  let n = 0;
  for (const item of list) if (item.active) n++;
  return n;
}
