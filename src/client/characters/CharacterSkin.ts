import * as THREE from 'three';
import { heldWeaponGripAnchor, heldWeaponSupportAnchor } from '../weapons/WeaponMesh';
import type { ActorIndicatorAnchor } from './ActorAvatar';
import type { CharacterRigProfile } from './CharacterCatalog';
import { WeaponSupportHandConstraint } from './WeaponSupportHandConstraint';

/**
 * One cloned skin and its cosmetic attachments.
 *
 * Geometry, textures, materials, and skeleton source data are shared by the repository. The
 * skin has no viewer-relative material mutation: its authored textures are the same for every
 * team, while the renderer owns separate IFF markers and nameplates.
 */
export class CharacterSkin {
  readonly root = new THREE.Group();

  private readonly weaponSocket = new THREE.Group();
  private readonly supportGripTarget = new THREE.Object3D();
  private readonly supportHandConstraint: WeaponSupportHandConstraint;
  private readonly indicatorBones: IndicatorBones;
  private readonly anchorStart = new THREE.Vector3();
  private readonly anchorEnd = new THREE.Vector3();
  private weapon: THREE.Mesh | null = null;
  private weaponId: string | null = null;
  private hasSupportGrip = false;

  constructor(instance: THREE.Object3D, rig: CharacterRigProfile) {
    this.root.name = `character-skin:${rig.id}`;
    this.root.rotation.y = rig.modelYaw;
    this.root.scale.setScalar(rig.modelScale);
    this.prepareMeshes(instance);

    const hand = instance.getObjectByName(rig.weaponBone);
    if (hand === undefined) {
      throw new Error(`Character skin is missing weapon bone "${rig.weaponBone}".`);
    }
    this.weaponSocket.name = 'weapon-socket';
    this.weaponSocket.rotation.set(...rig.weaponRotation);
    hand.add(this.weaponSocket);
    this.supportGripTarget.name = 'weapon-support-grip';
    this.supportGripTarget.visible = false;
    this.weaponSocket.add(this.supportGripTarget);
    this.root.add(instance);
    this.supportHandConstraint = new WeaponSupportHandConstraint(this.root, this.supportGripTarget, rig.supportHand);
    this.indicatorBones = findIndicatorBones(instance, rig);
    this.configureWeaponSocketUnits(hand, rig);
  }

  setWeapon(weaponId: string | null, geometry: THREE.BufferGeometry | null, material: THREE.Material): void {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    if (this.weapon !== null) {
      this.weapon.removeFromParent();
      this.weapon = null;
    }
    this.hasSupportGrip = false;
    this.supportGripTarget.visible = false;
    if (geometry === null || weaponId === null) return;

    const weapon = new THREE.Mesh(geometry, material);
    weapon.name = `held-weapon:${weaponId ?? 'unknown'}`;
    weapon.castShadow = true;
    // `weaponSocket` sits at the hand. Move the mesh so its trigger grip — rather than the
    // centre of its receiver — occupies that point. The socket rotation remains rig-owned.
    const triggerGrip = heldWeaponGripAnchor(weaponId);
    weapon.position.copy(triggerGrip).multiplyScalar(-1);
    // The target is a sibling of the mesh under the same calibrated socket. Subtracting the
    // trigger anchor maps the semantic weapon-local support grip into that socket space.
    this.supportGripTarget.position.copy(heldWeaponSupportAnchor(weaponId)).sub(triggerGrip);
    this.supportGripTarget.visible = true;
    this.hasSupportGrip = true;
    this.weaponSocket.add(weapon);
    this.weapon = weapon;
  }

  /** Constrain the animated support palm only while this skin currently has a held weapon. */
  solveSupportHand(): void {
    if (!this.hasSupportGrip) return;
    this.supportHandConstraint.solve();
  }

  /** Resolve an animated semantic landmark for the renderer's separate IFF layer. */
  getIndicatorAnchor(anchor: ActorIndicatorAnchor, target: THREE.Vector3): boolean {
    switch (anchor) {
      case 'head':
        this.indicatorBones.head.getWorldPosition(target);
        return true;
      case 'leftUpperArm':
        return this.midpoint(
          this.indicatorBones.leftUpperArmStart,
          this.indicatorBones.leftUpperArmEnd,
          target,
        );
      case 'rightUpperArm':
        return this.midpoint(
          this.indicatorBones.rightUpperArmStart,
          this.indicatorBones.rightUpperArmEnd,
          target,
        );
      case 'leftKnee':
        this.indicatorBones.leftKnee.getWorldPosition(target);
        return true;
      case 'rightKnee':
        this.indicatorBones.rightKnee.getWorldPosition(target);
        return true;
    }
  }

  dispose(): void {
    if (this.weapon !== null) this.weapon.removeFromParent();
    this.weapon = null;
    this.weaponId = null;
    this.hasSupportGrip = false;
    this.root.clear();
  }

  private prepareMeshes(instance: THREE.Object3D): void {
    instance.traverse((node) => {
      if ((node as THREE.Object3D & { isMesh?: boolean }).isMesh !== true) return;
      const mesh = node as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  }

  private midpoint(start: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3): boolean {
    start.getWorldPosition(this.anchorStart);
    end.getWorldPosition(this.anchorEnd);
    target.lerpVectors(this.anchorStart, this.anchorEnd, 0.5);
    return true;
  }

  /**
   * The imported Armature is scaled to centimetres (0.01), while held-weapon geometry is made
   * in game metres. Cancel only that inherited unit scale at the hand socket; keep the skin
   * root's deliberate model calibration intact.
   */
  private configureWeaponSocketUnits(hand: THREE.Object3D, rig: CharacterRigProfile): void {
    this.root.updateWorldMatrix(true, true);
    const rootScale = this.root.getWorldScale(new THREE.Vector3());
    const handScale = hand.getWorldScale(new THREE.Vector3());
    const compensation = relativeUniformScale(rootScale, handScale, rig.id);

    this.weaponSocket.scale.setScalar(compensation);
    this.weaponSocket.position.set(
      rig.weaponOffset[0] * compensation,
      rig.weaponOffset[1] * compensation,
      rig.weaponOffset[2] * compensation,
    );
  }
}

interface IndicatorBones {
  readonly head: THREE.Object3D;
  readonly leftUpperArmStart: THREE.Object3D;
  readonly leftUpperArmEnd: THREE.Object3D;
  readonly rightUpperArmStart: THREE.Object3D;
  readonly rightUpperArmEnd: THREE.Object3D;
  readonly leftKnee: THREE.Object3D;
  readonly rightKnee: THREE.Object3D;
}

function findIndicatorBones(instance: THREE.Object3D, rig: CharacterRigProfile): IndicatorBones {
  const profile = rig.indicators;
  return {
    head: requiredBone(instance, profile.headBone, rig.id),
    leftUpperArmStart: requiredBone(instance, profile.leftUpperArmStartBone, rig.id),
    leftUpperArmEnd: requiredBone(instance, profile.leftUpperArmEndBone, rig.id),
    rightUpperArmStart: requiredBone(instance, profile.rightUpperArmStartBone, rig.id),
    rightUpperArmEnd: requiredBone(instance, profile.rightUpperArmEndBone, rig.id),
    leftKnee: requiredBone(instance, profile.leftKneeBone, rig.id),
    rightKnee: requiredBone(instance, profile.rightKneeBone, rig.id),
  };
}

function requiredBone(instance: THREE.Object3D, name: string, rigId: string): THREE.Object3D {
  const bone = instance.getObjectByName(name);
  if (bone === undefined) {
    throw new Error(`Character rig "${rigId}" is missing indicator bone "${name}".`);
  }
  return bone;
}

function relativeUniformScale(root: THREE.Vector3, child: THREE.Vector3, rigId: string): number {
  const rootAverage = (Math.abs(root.x) + Math.abs(root.y) + Math.abs(root.z)) / 3;
  const childAverage = (Math.abs(child.x) + Math.abs(child.y) + Math.abs(child.z)) / 3;
  if (rootAverage < 1e-6 || childAverage < 1e-6) {
    throw new Error(`Character rig "${rigId}" has a zero-scale weapon attachment.`);
  }
  return rootAverage / childAverage;
}
