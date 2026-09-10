import * as THREE from 'three';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';
import type { CharacterAssetBundle } from './CharacterAssetRepository';
import { CharacterAnimator } from './CharacterAnimator';
import { CharacterSkin } from './CharacterSkin';
import type { ActorAvatar, ActorIndicatorAnchor } from './ActorAvatar';

const FLINCH_SECONDS = 0.18;
const FLINCH_ANGLE = 0.075;

/**
 * A live GLB-backed actor presentation.
 *
 * The outer `group` is placed only from an authoritative render pose. The mixer animates the
 * cloned skeleton beneath it, so imported root motion can never move either the scene actor or
 * its gameplay hitbox.
 */
export class CharacterAvatar implements ActorAvatar {
  readonly group = new THREE.Group();

  private readonly skin: CharacterSkin;
  private readonly animator: CharacterAnimator;
  private readonly axis = new THREE.Vector3();
  private readonly flinchQuat = new THREE.Quaternion();
  private flinchTime = 0;
  private flinchX = 0;
  private flinchZ = 1;
  private lastX = 0;
  private lastZ = 0;
  private seeded = false;
  private armed = false;

  constructor(instance: THREE.Object3D, assets: CharacterAssetBundle) {
    this.group.name = `character:${assets.definition.id}`;
    this.skin = new CharacterSkin(instance, assets.definition.rig);
    this.animator = new CharacterAnimator(this.skin.root, assets.definition, assets.clips);
    this.group.add(this.skin.root);
  }

  get isDying(): boolean {
    return this.animator.isDying;
  }

  setWeapon(weaponId: string | null, geometry: THREE.BufferGeometry | null, material: THREE.Material): void {
    this.skin.setWeapon(weaponId, geometry, material);
    this.armed = weaponId !== null && geometry !== null;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  getIndicatorAnchor(anchor: ActorIndicatorAnchor, target: THREE.Vector3): boolean {
    return this.skin.getIndicatorAnchor(anchor, target);
  }

  beginDeath(dx: number, dz: number, variant: number, animation: ActorAnimationInput): void {
    // `variant` remains part of the replicated cosmetic event. The supplied asset pack has
    // only stand/crouch deaths, so selection is posture-driven until additional authored
    // variants are added to the catalog; never reinterpret the shared serial as a clip index.
    void dx;
    void dz;
    void variant;
    this.flinchTime = 0;
    this.animator.beginDeath(animation);
  }

  endDeath(): void {
    this.flinchTime = 0;
    this.seeded = false;
    this.animator.endDeath();
  }

  flinch(dx: number, dz: number): void {
    if (this.isDying) return;
    const length = Math.hypot(dx, dz);
    this.flinchX = length > 1e-4 ? dx / length : 0;
    this.flinchZ = length > 1e-4 ? dz / length : 1;
    this.flinchTime = FLINCH_SECONDS;
  }

  update(
    animation: ActorAnimationInput,
    x: number,
    y: number,
    z: number,
    yaw: number,
    heightScale: number,
    dt: number,
  ): void {
    const planarSpeed = this.measurePlanarSpeed(x, z, dt);
    this.animator.setLocomotion(animation, planarSpeed, this.armed);
    this.animator.update(dt);

    this.group.position.set(x, y, z);
    this.group.quaternion.setFromAxisAngle(UP, yaw);
    // A crouch/slide is selected as an authored pose. Applying the old capsule compression as
    // well would double-compress a skinned crouch. `heightScale` stays in this interface for
    // the procedural fallback and for future rigs whose manifest deliberately opts into it.
    void heightScale;
    this.group.scale.set(1, 1, 1);

    if (this.flinchTime > 0 && !this.isDying) {
      this.flinchTime = Math.max(0, this.flinchTime - Math.max(0, dt));
      const t = this.flinchTime / FLINCH_SECONDS;
      const angle = Math.sin(t * Math.PI) * FLINCH_ANGLE;
      this.axis.set(this.flinchZ, 0, -this.flinchX).normalize();
      this.flinchQuat.setFromAxisAngle(this.axis, angle);
      this.group.quaternion.premultiply(this.flinchQuat);
    }

    // Let the mixer establish the authored pose first, then make only the support arm meet its
    // weapon-local target. The outer group remains the authoritative networked actor pose.
    if (this.animator.supportsWeaponSupportGrip) this.skin.solveSupportHand();
  }

  dispose(): void {
    this.animator.dispose();
    this.skin.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }

  private measurePlanarSpeed(x: number, z: number, dt: number): number {
    if (!this.seeded) {
      this.lastX = x;
      this.lastZ = z;
      this.seeded = true;
      return 0;
    }
    const distance = Math.hypot(x - this.lastX, z - this.lastZ);
    this.lastX = x;
    this.lastZ = z;
    return dt > 1e-5 ? distance / dt : 0;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
