import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp01, lerp } from '../core/MathUtil';
import { HUMANOID_RIG, type HitZone } from '../combat/HitboxRig';
import type { BotTeam } from './Combatant';

/**
 * A bot's body, and the way it dies (brief S6.8).
 *
 * The mesh *is* the rig, the same way M2's dummies are: the boxes drawn here are the boxes
 * a round is tested against, so what you can hit is what you can see. The only geometry
 * that is not a hitbox is the rifle, which exists because an unarmed silhouette shooting
 * at you reads as a bug, and a visor plate, which exists because you have to be able to
 * tell at a glance which way a bot is facing.
 *
 * **Ragdoll-lite death.** S6.8 asks for an impulse-driven fall taken from the killing hit,
 * in three or four variants, with no physics library — so it is a scripted fall with
 * damped rotation about the feet. Pivoting at the feet is what makes it work without a
 * solver: a body rotated 90 degrees about its own feet is already lying on the floor, so
 * there is nothing to resolve against the ground and nothing to sink through it. The
 * damping term is a decaying sine, which is the whole reason it does not look like a door
 * closing — the body arrives, settles past, and comes back.
 *
 * Flinch is the same trick at 1/20th the scale on a 0.18 s decay.
 */

export const DEATH_VARIANTS = 4;

/** Seconds the fall takes to settle. The body stays put afterwards until respawn. */
const FALL_SECONDS = 1.05;

/** How far a killing hit can shove a body along its own direction, metres. */
const MAX_SHOVE = 0.55;

const FLINCH_SECONDS = 0.18;
const FLINCH_ANGLE = 0.075;

export interface BotMaterials {
  readonly bodyA: THREE.Material;
  readonly bodyB: THREE.Material;
  readonly headA: THREE.Material;
  readonly headB: THREE.Material;
  readonly gear: THREE.Material;
  dispose(): void;
}

export function buildBotMaterials(): BotMaterials {
  // Two silhouettes that separate at a glance in grey-box lighting without either team
  // reading as "the enemy" by colour alone: cool slate versus warm sand.
  const bodyA = new THREE.MeshLambertMaterial({ color: 0x4a5a72 });
  const bodyB = new THREE.MeshLambertMaterial({ color: 0x6e5a44 });
  const headA = new THREE.MeshLambertMaterial({ color: 0x8a6a3c });
  const headB = new THREE.MeshLambertMaterial({ color: 0x8a6a3c });
  const gear = new THREE.MeshLambertMaterial({ color: 0x1d2026 });
  return {
    bodyA,
    bodyB,
    headA,
    headB,
    gear,
    dispose(): void {
      bodyA.dispose();
      bodyB.dispose();
      headA.dispose();
      headB.dispose();
      gear.dispose();
    },
  };
}

export class BotMesh {
  readonly group = new THREE.Group();

  private readonly body: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly gear: THREE.Mesh;
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly quat = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly spinQuat = new THREE.Quaternion();
  private static readonly upAxis = new THREE.Vector3(0, 1, 0);

  private dying = false;
  private deathTime = 0;
  private variant = 0;
  private fallX = 0;
  private fallZ = 1;
  private shove = 0;
  private flinchTime = 0;
  private flinchX = 0;
  private flinchZ = 0;

  constructor(team: BotTeam, materials: BotMaterials) {
    this.body = new THREE.Mesh(
      buildZoneGeometry(['torso', 'arm', 'leg']),
      team === 'A' ? materials.bodyA : materials.bodyB,
    );
    this.head = new THREE.Mesh(buildZoneGeometry(['head']), team === 'A' ? materials.headA : materials.headB);
    this.gear = new THREE.Mesh(buildGearGeometry(), materials.gear);
    this.body.castShadow = true;
    this.head.castShadow = true;
    this.gear.castShadow = true;
    this.disposables.push(this.body.geometry, this.head.geometry, this.gear.geometry);
    this.group.add(this.body, this.head, this.gear);
  }

  get isDying(): boolean {
    return this.dying;
  }

  /** Start the fall. `dx/dz` is the direction the killing round was travelling. */
  beginDeath(dx: number, dz: number, variant: number): void {
    const len = Math.hypot(dx, dz);
    this.fallX = len > 1e-4 ? dx / len : 0;
    this.fallZ = len > 1e-4 ? dz / len : 1;
    this.variant = ((variant % DEATH_VARIANTS) + DEATH_VARIANTS) % DEATH_VARIANTS;
    // Variant 1 pitches forward instead of back: shot in the back, dropped on the face.
    if (this.variant === 1) {
      this.fallX = -this.fallX;
      this.fallZ = -this.fallZ;
    }
    this.dying = true;
    this.deathTime = 0;
    this.shove = this.variant === 3 ? MAX_SHOVE : MAX_SHOVE * 0.55;
    this.flinchTime = 0;
  }

  endDeath(): void {
    this.dying = false;
    this.deathTime = 0;
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
  }

  /** A non-fatal hit: a short jolt away from the impact. */
  flinch(dx: number, dz: number): void {
    if (this.dying) return;
    const len = Math.hypot(dx, dz);
    this.flinchX = len > 1e-4 ? dx / len : 0;
    this.flinchZ = len > 1e-4 ? dz / len : 1;
    this.flinchTime = FLINCH_SECONDS;
  }

  setVisible(on: boolean): void {
    if (this.group.visible === on) return;
    this.group.visible = on;
  }

  /** Advance the death and flinch animations. Render-rate: these are visuals only. */
  advance(dt: number): void {
    if (this.dying && this.deathTime < FALL_SECONDS) this.deathTime += dt;
    if (this.flinchTime > 0) this.flinchTime = Math.max(0, this.flinchTime - dt);
  }

  /**
   * Place the body for this frame. `x/y/z` is the interpolated feet pose, `yaw` the facing
   * and `heightScale` the stance compression that the hitbox rig is also using.
   */
  apply(x: number, y: number, z: number, yaw: number, heightScale: number): void {
    this.group.rotation.set(0, 0, 0);
    this.group.scale.set(1, this.dying ? 1 : heightScale, 1);

    if (!this.dying) {
      this.group.position.set(x, y, z);
      this.group.quaternion.setFromAxisAngle(BotMesh.upAxis, yaw);
      if (this.flinchTime > 0) this.applyFlinch();
      return;
    }

    const t = clamp01(this.deathTime / FALL_SECONDS);
    // Rise toward the target angle, then a decaying wobble past it. No solver, no library.
    const ease = 1 - Math.exp(-5.5 * t);
    const wobble = Math.exp(-7 * t) * Math.sin(t * 21) * 0.13;
    const target = this.variant === 2 ? Math.PI * 0.42 : Math.PI * 0.5;
    const angle = target * ease + wobble;

    const travel = this.shove * (1 - Math.exp(-4 * t));
    // Variant 2 crumples: less rotation, more sink.
    const sink = this.variant === 2 ? lerp(0, -0.28, ease) : -0.04 * ease;

    this.group.position.set(x + this.fallX * travel, y + sink, z + this.fallZ * travel);

    this.quat.setFromAxisAngle(BotMesh.upAxis, yaw + (this.variant === 3 ? ease * 1.1 : 0));
    // Axis perpendicular to the fall direction, so +Y tips toward it (see the header).
    this.axis.set(this.fallZ, 0, -this.fallX).normalize();
    this.spinQuat.setFromAxisAngle(this.axis, angle);
    this.group.quaternion.copy(this.spinQuat).multiply(this.quat);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }

  private applyFlinch(): void {
    const t = this.flinchTime / FLINCH_SECONDS;
    const angle = Math.sin(t * Math.PI) * FLINCH_ANGLE;
    this.axis.set(this.flinchZ, 0, -this.flinchX).normalize();
    this.spinQuat.setFromAxisAngle(this.axis, angle);
    this.group.quaternion.premultiply(this.spinQuat);
  }
}

/** The mesh IS the rig: same boxes, same offsets, nothing to drift out of sync. */
function buildZoneGeometry(zones: readonly HitZone[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const box of HUMANOID_RIG.boxes) {
    if (!zones.includes(box.zone)) continue;
    const g = new THREE.BoxGeometry(box.sx, box.sy, box.sz);
    g.translate(box.ox, box.oy, box.oz);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error('Failed to merge bot body geometry');
  merged.computeBoundingSphere();
  return merged;
}

/**
 * The parts that are not hitboxes: a rifle held at the chest, a chest rig, and a visor
 * plate on the front of the head. Rig-local -Z is forward, matching `HitboxRig`.
 */
function buildGearGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const put = (sx: number, sy: number, sz: number, ox: number, oy: number, oz: number): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(ox, oy, oz);
    parts.push(g);
  };
  // Rifle: body, magazine, stock. Held across the chest, muzzle forward.
  put(0.06, 0.07, 0.62, 0.16, 1.24, -0.28);
  put(0.05, 0.16, 0.08, 0.16, 1.13, -0.16);
  put(0.05, 0.09, 0.2, 0.16, 1.22, 0.12);
  // Chest rig and visor, so the silhouette is not a bare stack of boxes.
  put(0.4, 0.24, 0.06, 0, 1.24, -0.15);
  put(0.15, 0.09, 0.03, 0, 1.68, -0.12);

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error('Failed to merge bot gear geometry');
  merged.computeBoundingSphere();
  return merged;
}
