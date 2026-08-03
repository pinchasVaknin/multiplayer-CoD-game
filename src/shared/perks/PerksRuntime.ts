import * as THREE from 'three';
import type { Combatant } from '../ai/Combatant';
import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { clamp01 } from '../core/MathUtil';
import type { PlayerSim } from '../player/PlayerState';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { NO_PERKS, type PerkState } from './PerkState';

/**
 * The two perks that need a world presence: Scavenger and Tracker.
 *
 * Everything else a perk does is a number on a resolved `WeaponDef`, a multiplier handed
 * to one system, or a flag somebody reads. These two are different — they put things in
 * the scene — so they get a runtime that owns a group, two pools and their subscriptions,
 * and is built and destroyed with the match like every other per-match object since M4.
 *
 * **Scavenger** drops a pickup where a combatant died and grants a magazine when you walk
 * over it. Deliberately a pickup rather than an automatic radius grant: "ammo from bodies"
 * means going to the body, and an invisible refill you cannot decline is not a decision.
 *
 * **Tracker** records enemy footsteps into a fixed ring and draws them as a fading trail.
 * The footsteps are the *same* events the bots' noise field consumes, so a trail exists
 * exactly where an enemy made a sound a bot could have heard — including none at all if
 * they were crouch-walking, which is the answer a player wants from a tracking perk.
 *
 * Both are inert while their perk is not equipped: the subscriptions stay live (so the
 * cost is one branch per event either way) and nothing is spawned or drawn.
 */

/** Pickups on the map at once. Bodies outnumber this only in a very bad minute. */
const PICKUP_CAPACITY = 16;
/** Seconds a dropped magazine remains. */
const PICKUP_LIFETIME = 30;
/** Metres. Generous enough to collect by running past, tight enough to need the detour. */
const PICKUP_RADIUS = 1.35;
/** Metres above the feet the pickup floats. */
const PICKUP_HEIGHT = 0.35;

/** Footsteps remembered for the tracker trail. */
const TRAIL_CAPACITY = 160;
/** Seconds a footprint stays visible. */
const TRAIL_LIFETIME = 9;

interface Pickup {
  active: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
  spin: number;
}

export interface PerksRuntimeDeps {
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly roster: readonly Combatant[];
  readonly weapons: WeaponSystem;
  /** The local player's team, so a trail only shows the other side. */
  readonly localTeam: 'A' | 'B';
}

const evScavenged = { entityId: 0, x: 0, y: 0, z: 0, rounds: 0 };

export class PerksRuntime {
  readonly group = new THREE.Group();

  /** Diagnostics for the F1 panel. */
  pickupsSpawned = 0;
  pickupsCollected = 0;
  trailPoints = 0;

  private state: PerkState = NO_PERKS;

  private readonly deps: PerksRuntimeDeps;
  private readonly unsubscribe: Array<() => void> = [];

  private readonly pickups: Pickup[] = [];
  private readonly pickupMeshes: THREE.Mesh[] = [];
  private readonly pickupGeometry: THREE.BufferGeometry;
  private readonly pickupMaterial: THREE.MeshBasicMaterial;

  private readonly trail: Float32Array;
  private readonly trailAge: Float32Array;
  private trailHead = 0;
  private readonly trailPoints3: THREE.Points;
  private readonly trailGeometry: THREE.BufferGeometry;
  private readonly trailMaterial: THREE.PointsMaterial;
  private readonly trailPositions: Float32Array;
  private readonly trailColors: Float32Array;

  constructor(deps: PerksRuntimeDeps) {
    this.deps = deps;
    this.group.name = 'perks';

    // ---- scavenger pickups --------------------------------------------------
    this.pickupGeometry = new THREE.BoxGeometry(0.16, 0.2, 0.09);
    this.pickupMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb340,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    for (let i = 0; i < PICKUP_CAPACITY; i++) {
      this.pickups.push({ active: false, x: 0, y: 0, z: 0, age: 0, spin: 0 });
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

    deps.scene.add(this.group);

    this.unsubscribe.push(
      deps.bus.on(EV.EntityKilled, (p) => this.onKilled(p.targetId)),
      deps.bus.on(EV.PlayerFootstep, (p) => this.onFootstep(p.entityId, p.x, p.y, p.z)),
      // A fresh life clears the trail: hunting the ghost of somebody who has already
      // respawned across the map is worse than no information.
      deps.bus.on(EV.PlayerSpawned, (p) => {
        if (p.entityId === PLAYER_ENTITY_ID) this.clearTrail();
      }),
    );
  }

  /** Called whenever the loadout changes, which in practice is once per match. */
  setPerks(state: PerkState): void {
    this.state = state;
    if (!state.scavenger) this.releaseAllPickups();
    if (!state.tracker) this.clearTrail();
  }

  get perkState(): PerkState {
    return this.state;
  }

  /** One sim tick: age the pickups, and collect any the player is standing on. */
  simulate(sim: PlayerSim, playerAlive: boolean): void {
    if (!this.state.scavenger) return;
    for (const pickup of this.pickups) {
      if (!pickup.active) continue;
      pickup.age += DT;
      if (pickup.age >= PICKUP_LIFETIME) {
        pickup.active = false;
        continue;
      }
      if (!playerAlive) continue;
      const dx = pickup.x - sim.x;
      const dz = pickup.z - sim.z;
      const dy = pickup.y - sim.y;
      if (dx * dx + dz * dz > PICKUP_RADIUS * PICKUP_RADIUS) continue;
      if (Math.abs(dy) > 2) continue;
      this.collect(pickup);
    }
  }

  /** Render pass: bob the pickups, fade the trail. */
  render(dt: number): void {
    for (let i = 0; i < this.pickups.length; i++) {
      const pickup = this.pickups[i];
      const mesh = this.pickupMeshes[i];
      if (pickup === undefined || mesh === undefined) continue;
      if (!pickup.active) {
        mesh.visible = false;
        continue;
      }
      pickup.spin += dt * 2.2;
      mesh.visible = true;
      mesh.position.set(
        pickup.x,
        pickup.y + PICKUP_HEIGHT + Math.sin(pickup.spin * 1.6) * 0.05,
        pickup.z,
      );
      mesh.rotation.y = pickup.spin;
      // The last three seconds blink, so a pickup does not vanish without warning.
      const remaining = PICKUP_LIFETIME - pickup.age;
      mesh.scale.setScalar(remaining < 3 ? 0.7 + 0.3 * Math.abs(Math.sin(pickup.spin * 6)) : 1);
      mesh.updateMatrix();
    }

    this.updateTrail(dt);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.deps.scene.remove(this.group);
    this.group.clear();
    this.pickupGeometry.dispose();
    this.pickupMaterial.dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
  }

  // -- internals --------------------------------------------------------------

  private onKilled(targetId: number): void {
    if (!this.state.scavenger) return;
    if (targetId === PLAYER_ENTITY_ID) return;
    const victim = this.findCombatant(targetId);
    if (victim === undefined) return;
    const slot = this.pickups.find((p) => !p.active);
    if (slot === undefined) return;
    slot.active = true;
    slot.x = victim.px;
    slot.y = victim.py;
    slot.z = victim.pz;
    slot.age = 0;
    slot.spin = 0;
    this.pickupsSpawned++;
  }

  private collect(pickup: Pickup): void {
    const weapon = this.deps.weapons.weapon;
    const rounds = weapon.addReserve(weapon.definition.magSize);
    // A pickup with nothing to give is left where it is: walking over a magazine you
    // cannot carry should not consume it.
    if (rounds === 0) return;
    pickup.active = false;
    this.pickupsCollected++;
    evScavenged.entityId = PLAYER_ENTITY_ID;
    evScavenged.x = pickup.x;
    evScavenged.y = pickup.y;
    evScavenged.z = pickup.z;
    evScavenged.rounds = rounds;
    this.deps.bus.emit(EV.PerkScavenged, evScavenged);
  }

  private releaseAllPickups(): void {
    for (const pickup of this.pickups) pickup.active = false;
  }

  private onFootstep(entityId: number, x: number, y: number, z: number): void {
    if (!this.state.tracker) return;
    if (entityId === PLAYER_ENTITY_ID) return;
    const walker = this.findCombatant(entityId);
    if (walker === undefined || walker.team === this.deps.localTeam) return;
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
    if (!this.state.tracker) {
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
    const position = this.trailGeometry.getAttribute('position');
    const color = this.trailGeometry.getAttribute('color');
    position.needsUpdate = true;
    color.needsUpdate = true;
  }

  private findCombatant(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) {
      if (c.entityId === entityId) return c;
    }
    return undefined;
  }
}
