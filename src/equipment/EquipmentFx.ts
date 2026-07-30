import * as THREE from 'three';
import { clamp01, lerp } from '../core/MathUtil';
import { Rng } from '../core/Rng';
import type { EquipmentDef } from './EquipmentDefs';
import type { Projectile, ProjectilePool } from './Projectile';
import type { SmokeField, SmokeVolume } from './SmokeField';

/**
 * Everything equipment draws (brief S2: zero external assets).
 *
 * Three pools, all fixed size and all built once:
 *
 *  - **Bodies.** One mesh per live projectile, shaped by its equipment id. A frag is a
 *    faceted ball, a semtex is a flat slab, a claymore is a box on legs with a visible
 *    front face so you can read which way its arc points.
 *  - **Smoke.** Per volume, a fan of camera-facing quads with a radial-gradient texture,
 *    drifting on their own seeded offsets. Billboards rather than a volume because a
 *    volumetric cloud is a fragment cost this project's frame budget does not have, and
 *    what actually sells smoke is parallax between layers.
 *  - **Blasts.** An expanding, fading shell plus one shared point light. The light is
 *    shared for the same reason M2's muzzle flash shares one: a second light in this
 *    scene costs a shadow-map decision.
 *
 * Nothing here reads gameplay state except through the pools it is handed, and nothing
 * here writes any. Interpolated with the frame's `alpha`, so grenades move smoothly
 * between sim ticks like everything else.
 */

const SMOKE_PUFFS = 11;
const BLAST_POOL = 6;

/**
 * Metres beyond which a cloud stops drawing its billboards.
 *
 * Eight clouds at eleven quads each is 88 large, transparent, depth-write-disabled
 * surfaces, and the overdraw is what the first frame-time run of this milestone found:
 * p99 climbed from 29 ms to 40 ms with the pool full. A cloud forty metres away is a grey
 * smudge worth about two pixels of information and the full fill cost of one at four
 * metres, so it does not draw.
 *
 * **This is a render cull only.** `SmokeField.blocksSight` knows nothing about it, so a
 * cloud you cannot see still blocks the line of sight through it — the gameplay and the
 * picture cannot disagree, because only one of them is being culled.
 */
const SMOKE_DRAW_DISTANCE = 38;

interface Blast {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  radius: number;
  active: boolean;
}

interface SmokeCloud {
  group: THREE.Group;
  puffs: THREE.Mesh[];
  offsets: Float32Array;
  volume: SmokeVolume | null;
}

export class EquipmentFx {
  readonly group = new THREE.Group();

  private readonly bodies: THREE.Mesh[] = [];
  private readonly bodyGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly clouds: SmokeCloud[] = [];
  private readonly blasts: Blast[] = [];
  private readonly light: THREE.PointLight;
  private lightTimer = 0;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly rng = new Rng(0x77b1_2c04);

  constructor(projectileCapacity: number, smokeCapacity: number) {
    this.group.name = 'equipment-fx';

    const metal = new THREE.MeshStandardMaterial({ color: 0x4d5a4a, roughness: 0.62, metalness: 0.35 });
    const sticky = new THREE.MeshStandardMaterial({ color: 0x8a6a2a, roughness: 0.85, metalness: 0.1 });
    const tactical = new THREE.MeshStandardMaterial({ color: 0x9aa2ac, roughness: 0.5, metalness: 0.45 });
    this.disposables.push(metal, sticky, tactical);

    this.bodyGeometries.set('frag', new THREE.IcosahedronGeometry(0.075, 1));
    this.bodyGeometries.set('semtex', new THREE.BoxGeometry(0.13, 0.05, 0.09));
    this.bodyGeometries.set('flashbang', new THREE.CylinderGeometry(0.045, 0.045, 0.15, 8));
    this.bodyGeometries.set('smoke', new THREE.CylinderGeometry(0.05, 0.05, 0.17, 8));
    this.bodyGeometries.set('claymore', new THREE.BoxGeometry(0.24, 0.13, 0.06));
    for (const g of this.bodyGeometries.values()) this.disposables.push(g);

    const fragGeometry = this.bodyGeometries.get('frag');
    if (fragGeometry === undefined) throw new Error('frag geometry missing');
    for (let i = 0; i < projectileCapacity; i++) {
      const mesh = new THREE.Mesh(fragGeometry, metal);
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.name = `equipment:body:${i}`;
      this.group.add(mesh);
      this.bodies.push(mesh);
    }
    // Held so the swap in `update` can reach them without a second lookup table.
    this.materials = { metal, sticky, tactical };

    const puffTexture = buildPuffTexture();
    const puffMaterial = new THREE.MeshBasicMaterial({
      map: puffTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      color: 0xb9bcc0,
    });
    this.disposables.push(puffTexture, puffMaterial);
    const puffGeometry = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(puffGeometry);

    for (let i = 0; i < smokeCapacity; i++) {
      const cloudGroup = new THREE.Group();
      cloudGroup.visible = false;
      const puffs: THREE.Mesh[] = [];
      const offsets = new Float32Array(SMOKE_PUFFS * 4);
      for (let p = 0; p < SMOKE_PUFFS; p++) {
        // Each puff gets its own material instance so opacity can differ across the
        // cloud — a single shared material would make the whole thing fade as one flat
        // sheet, which is exactly what stops billboards reading as volume.
        const mat = puffMaterial.clone();
        this.disposables.push(mat);
        const mesh = new THREE.Mesh(puffGeometry, mat);
        mesh.renderOrder = 3;
        cloudGroup.add(mesh);
        puffs.push(mesh);
        offsets[p * 4] = this.rng.range(-0.75, 0.75);
        offsets[p * 4 + 1] = this.rng.range(-0.55, 0.7);
        offsets[p * 4 + 2] = this.rng.range(-0.75, 0.75);
        offsets[p * 4 + 3] = this.rng.range(0.7, 1.35);
      }
      this.group.add(cloudGroup);
      this.clouds.push({ group: cloudGroup, puffs, offsets, volume: null });
    }

    const blastGeometry = new THREE.IcosahedronGeometry(1, 2);
    this.disposables.push(blastGeometry);
    for (let i = 0; i < BLAST_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb469,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      this.disposables.push(mat);
      const mesh = new THREE.Mesh(blastGeometry, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.blasts.push({ mesh, age: 0, life: 0.5, radius: 1, active: false });
    }

    this.light = new THREE.PointLight(0xffc07a, 0, 26, 2);
    this.light.visible = false;
    this.group.add(this.light);
  }

  private readonly materials: {
    metal: THREE.MeshStandardMaterial;
    sticky: THREE.MeshStandardMaterial;
    tactical: THREE.MeshStandardMaterial;
  };

  /** Fire the visual half of a detonation. */
  spawnBlast(x: number, y: number, z: number, radius: number, bright: boolean): void {
    for (const blast of this.blasts) {
      if (blast.active) continue;
      blast.active = true;
      blast.age = 0;
      blast.life = bright ? 0.34 : 0.46;
      blast.radius = radius;
      blast.mesh.position.set(x, y, z);
      blast.mesh.visible = true;
      const mat = blast.mesh.material;
      if (mat instanceof THREE.MeshBasicMaterial) mat.color.setHex(bright ? 0xffffff : 0xffb469);
      break;
    }
    this.light.position.set(x, y, z);
    this.light.color.setHex(bright ? 0xffffff : 0xffb46e);
    this.lightTimer = bright ? 0.3 : 0.22;
    this.light.visible = true;
  }

  /**
   * One render pass. `alpha` interpolates projectile positions between sim ticks, exactly
   * the way bots and the player are interpolated.
   */
  update(
    projectiles: ProjectilePool,
    smoke: SmokeField,
    alpha: number,
    dt: number,
    camera: THREE.Camera,
    elapsed: number,
  ): void {
    let bodyIndex = 0;
    for (const p of projectiles.items) {
      if (!p.active) continue;
      const mesh = this.bodies[bodyIndex];
      if (mesh === undefined) break;
      bodyIndex++;
      this.poseBody(mesh, p, alpha, elapsed);
    }
    for (let i = bodyIndex; i < this.bodies.length; i++) {
      const mesh = this.bodies[i];
      if (mesh !== undefined) mesh.visible = false;
    }

    this.updateSmoke(smoke, camera, elapsed);
    this.updateBlasts(dt);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }

  // -- internals -------------------------------------------------------------

  private poseBody(mesh: THREE.Mesh, p: Projectile, alpha: number, elapsed: number): void {
    const geometry = this.bodyGeometries.get(p.def.id);
    if (geometry !== undefined && mesh.geometry !== geometry) mesh.geometry = geometry;
    mesh.material = materialFor(p.def, this.materials);

    mesh.position.set(
      lerp(p.px, p.x, alpha),
      lerp(p.py, p.y, alpha),
      lerp(p.pz, p.z, alpha),
    );
    if (p.resting) {
      mesh.rotation.set(p.def.impact === 'plant' ? 0 : mesh.rotation.x, p.yaw, 0);
    } else {
      // Tumbling. Driven off the clock rather than integrated, because nothing depends on
      // it and a grenade's spin is the one thing in this project that may be a lie.
      const spin = elapsed * 7 + p.serial;
      mesh.rotation.set(spin * 1.3, spin, spin * 0.7);
    }
    mesh.visible = true;
  }

  private updateSmoke(smoke: SmokeField, camera: THREE.Camera, elapsed: number): void {
    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      const volume = smoke.volumes[i];
      if (cloud === undefined) continue;
      if (volume === undefined || !volume.active) {
        cloud.group.visible = false;
        continue;
      }

      const density = smoke.density(volume);
      const radius = smoke.currentRadius(volume);
      const cam = camera.position;
      const distance = Math.hypot(cam.x - volume.x, cam.y - volume.y, cam.z - volume.z);
      cloud.group.visible = density > 0.02 && distance < SMOKE_DRAW_DISTANCE;
      cloud.group.position.set(volume.x, volume.y, volume.z);
      if (!cloud.group.visible) continue;

      for (let p = 0; p < cloud.puffs.length; p++) {
        const puff = cloud.puffs[p];
        if (puff === undefined) continue;
        const ox = cloud.offsets[p * 4] ?? 0;
        const oy = cloud.offsets[p * 4 + 1] ?? 0;
        const oz = cloud.offsets[p * 4 + 2] ?? 0;
        const scale = cloud.offsets[p * 4 + 3] ?? 1;
        // A slow churn so a settled cloud is not a frozen still life.
        const drift = Math.sin(elapsed * 0.35 + p) * 0.12;
        puff.position.set(ox * radius, oy * radius * 0.55 + drift, oz * radius);
        puff.scale.setScalar(radius * scale);
        puff.quaternion.copy(camera.quaternion);
        const mat = puff.material;
        if (mat instanceof THREE.MeshBasicMaterial) mat.opacity = clamp01(density * 0.42);
      }
    }
  }

  private updateBlasts(dt: number): void {
    for (const blast of this.blasts) {
      if (!blast.active) continue;
      blast.age += dt;
      const t = clamp01(blast.age / blast.life);
      if (t >= 1) {
        blast.active = false;
        blast.mesh.visible = false;
        continue;
      }
      // Fast out, slow fade: the shell reaches full radius in the first third.
      const grow = Math.min(1, t * 3);
      blast.mesh.scale.setScalar(blast.radius * (0.25 + 0.75 * grow));
      const mat = blast.mesh.material;
      if (mat instanceof THREE.MeshBasicMaterial) mat.opacity = (1 - t) * 0.75;
    }

    if (this.lightTimer <= 0) {
      if (this.light.visible) {
        this.light.visible = false;
        this.light.intensity = 0;
      }
      return;
    }
    this.lightTimer -= dt;
    this.light.intensity = Math.max(0, this.lightTimer) * 160;
    if (this.lightTimer <= 0) {
      this.light.visible = false;
      this.light.intensity = 0;
    }
  }
}

function materialFor(
  def: EquipmentDef,
  materials: {
    metal: THREE.MeshStandardMaterial;
    sticky: THREE.MeshStandardMaterial;
    tactical: THREE.MeshStandardMaterial;
  },
): THREE.MeshStandardMaterial {
  switch (def.id) {
    case 'semtex':
      return materials.sticky;
    case 'flashbang':
    case 'smoke':
      return materials.tactical;
    default:
      return materials.metal;
  }
}

/** A soft radial falloff. One 64px canvas, drawn once. */
function buildPuffTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable; cannot build smoke texture.');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.62)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
