import * as THREE from 'three';
import { EV, type GameBus } from '../../shared/core/Events';
import { clamp01 } from '../../shared/core/MathUtil';
import { PLAYER_ENTITY_ID } from '../../shared/combat/DamageSystem';
import {
  PICKUP_HEIGHT,
  PICKUP_LIFETIME,
  type PerksRuntime,
} from '../../shared/perks/PerksRuntime';

/**
 * What the perks look like (M9).
 *
 * Two things, both lifted out of `shared/perks/PerksRuntime.ts`: the Scavenger pickups, and
 * the Tracker footstep trail.
 *
 * **The pickups** are drawn from the simulation's pool. `PerksRuntime` owns whether a
 * pickup exists and whether walking over it grants a magazine; the bob, the spin and the
 * about-to-expire blink are here, and the spin phase is a field of this class rather than of
 * the pickup — it advances on a real frame delta and nothing gameplay-facing may read it.
 *
 * **The trail** is entirely client-side. `PerksRuntime.revealsFootstep` answers the one
 * question that is a fact about the match — is Tracker equipped, and is this an enemy — and
 * everything after that (a ring of positions, an age per print, the colour ramp) lives here.
 * A server has no reason to remember where a bot walked nine seconds ago.
 */

/** Footsteps remembered for the tracker trail. */
const TRAIL_CAPACITY = 160;
/** Seconds a footprint stays visible. */
const TRAIL_LIFETIME = 9;

export class PerksRenderer {
  readonly group = new THREE.Group();

  /** Diagnostics for the F1 panel. */
  trailPoints = 0;

  private readonly pickupMeshes: THREE.Mesh[] = [];
  private readonly pickupSpin: Float32Array;
  private readonly pickupGeometry: THREE.BufferGeometry;
  private readonly pickupMaterial: THREE.MeshBasicMaterial;

  private readonly trail: Float32Array;
  private readonly trailAge: Float32Array;
  private trailHead = 0;
  private readonly trailPositions: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly trailPoints3: THREE.Points;
  private readonly trailGeometry: THREE.BufferGeometry;
  private readonly trailMaterial: THREE.PointsMaterial;

  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly perks: PerksRuntime,
    bus: GameBus,
    scene: THREE.Scene,
  ) {
    this.group.name = 'perks';

    // ---- scavenger pickups --------------------------------------------------
    const capacity = perks.pickups.length;
    this.pickupSpin = new Float32Array(capacity);
    this.pickupGeometry = new THREE.BoxGeometry(0.16, 0.2, 0.09);
    this.pickupMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb340,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    for (let i = 0; i < capacity; i++) {
      const mesh = new THREE.Mesh(this.pickupGeometry, this.pickupMaterial);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      this.pickupMeshes.push(mesh);
      this.group.add(mesh);
    }

    // ---- tracker trail ------------------------------------------------------
    this.trail = new Float32Array(TRAIL_CAPACITY * 3);
    this.trailAge = new Float32Array(TRAIL_CAPACITY).fill(Infinity);
    this.trailPositions = new Float32Array(TRAIL_CAPACITY * 3);
    this.trailColors = new Float32Array(TRAIL_CAPACITY * 3);
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    this.trailGeometry.setDrawRange(0, 0);
    this.trailMaterial = new THREE.PointsMaterial({
      size: 0.17,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.trailPoints3 = new THREE.Points(this.trailGeometry, this.trailMaterial);
    this.trailPoints3.frustumCulled = false;
    this.trailPoints3.visible = false;
    this.group.add(this.trailPoints3);

    scene.add(this.group);

    this.unsubscribe.push(
      bus.on(EV.PlayerFootstep, (p) => this.onFootstep(p.entityId, p.x, p.y, p.z)),
      // A fresh life clears the trail: hunting the ghost of somebody who has already
      // respawned across the map is worse than no information.
      bus.on(EV.PlayerSpawned, (p) => {
        if (p.entityId === PLAYER_ENTITY_ID) this.clearTrail();
      }),
    );
  }

  /** Render pass: bob the pickups, fade the trail. */
  render(dt: number): void {
    const pickups = this.perks.pickups;
    for (let i = 0; i < pickups.length; i++) {
      const pickup = pickups[i];
      const mesh = this.pickupMeshes[i];
      if (pickup === undefined || mesh === undefined) continue;
      if (!pickup.active) {
        mesh.visible = false;
        this.pickupSpin[i] = 0;
        continue;
      }
      const spin = (this.pickupSpin[i] ?? 0) + dt * 2.2;
      this.pickupSpin[i] = spin;
      mesh.visible = true;
      mesh.position.set(pickup.x, pickup.y + PICKUP_HEIGHT + Math.sin(spin * 1.6) * 0.05, pickup.z);
      mesh.rotation.y = spin;
      // The last three seconds blink, so a pickup does not vanish without warning.
      const remaining = PICKUP_LIFETIME - pickup.age;
      mesh.scale.setScalar(remaining < 3 ? 0.7 + 0.3 * Math.abs(Math.sin(spin * 6)) : 1);
      mesh.updateMatrix();
    }

    this.updateTrail(dt);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.group.removeFromParent();
    this.group.clear();
    this.pickupGeometry.dispose();
    this.pickupMaterial.dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
  }

  private onFootstep(entityId: number, x: number, y: number, z: number): void {
    if (!this.perks.revealsFootstep(entityId)) return;
    const i = this.trailHead * 3;
    this.trail[i] = x;
    this.trail[i + 1] = y + 0.04;
    this.trail[i + 2] = z;
    this.trailAge[this.trailHead] = 0;
    this.trailHead = (this.trailHead + 1) % TRAIL_CAPACITY;
  }

  private clearTrail(): void {
    this.trailAge.fill(Infinity);
    this.trailGeometry.setDrawRange(0, 0);
    this.trailPoints3.visible = false;
    this.trailPoints = 0;
  }

  /**
   * Rebuild the visible point set.
   *
   * The buffers are preallocated and compacted in place: live points are written to the
   * front and the draw range is set to how many there were, so the geometry never grows
   * and the GPU only sees what is alive.
   */
  private updateTrail(dt: number): void {
    if (!this.perks.perkState.tracker) {
      if (this.trailPoints3.visible) this.clearTrail();
      return;
    }
    let write = 0;
    for (let i = 0; i < TRAIL_CAPACITY; i++) {
      const age = (this.trailAge[i] ?? Infinity) + dt;
      this.trailAge[i] = age;
      if (age >= TRAIL_LIFETIME) continue;
      const src = i * 3;
      const dst = write * 3;
      this.trailPositions[dst] = this.trail[src] ?? 0;
      this.trailPositions[dst + 1] = this.trail[src + 1] ?? 0;
      this.trailPositions[dst + 2] = this.trail[src + 2] ?? 0;
      // Fresh prints burn accent-hot and cool to a dim ember, so age reads as colour
      // rather than as a size the player has to compare across the room.
      const life = clamp01(1 - age / TRAIL_LIFETIME);
      this.trailColors[dst] = 1;
      this.trailColors[dst + 1] = 0.35 + 0.35 * life;
      this.trailColors[dst + 2] = 0.1 + 0.15 * life;
      write++;
    }
    this.trailPoints = write;
    this.trailPoints3.visible = write > 0;
    if (write === 0) {
      this.trailGeometry.setDrawRange(0, 0);
      return;
    }
    this.trailGeometry.setDrawRange(0, write);
    this.trailGeometry.getAttribute('position').needsUpdate = true;
    this.trailGeometry.getAttribute('color').needsUpdate = true;
  }
}
