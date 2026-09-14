import * as THREE from 'three';
import type { ActorIndicatorAnchor, ActorIndicatorFrameAnchor, HeldWeaponAsset } from './ActorAvatar';
import type { CharacterIndicatorPadProfile, CharacterRigProfile } from './CharacterCatalog';
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
  private readonly headBone: THREE.Object3D;
  /** One calibrated node per shoulder, parented to its upper-arm bone; the pads' frames. */
  private readonly shoulderFrames: Readonly<Record<ActorIndicatorFrameAnchor, THREE.Object3D>>;
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
    this.headBone = requiredBone(instance, rig.indicators.headBone, rig.id);
    this.shoulderFrames = {
      leftShoulder: padNode(instance, rig.indicators.leftShoulder, 'left', rig.id),
      rightShoulder: padNode(instance, rig.indicators.rightShoulder, 'right', rig.id),
    };
    this.configureWeaponSocketUnits(hand, rig);
  }

  setWeapon(asset: HeldWeaponAsset | null): void {
    const weaponId = asset?.weaponId ?? null;
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    if (this.weapon !== null) {
      this.weapon.removeFromParent();
      this.weapon = null;
    }
    this.hasSupportGrip = false;
    this.supportGripTarget.visible = false;
    if (asset === null) return;

    const weapon = new THREE.Mesh(asset.geometry, asset.material);
    weapon.name = `held-weapon:${asset.weaponId}`;
    weapon.castShadow = true;
    // `weaponSocket` sits at the hand. Move the mesh so its trigger grip — rather than the
    // centre of its receiver — occupies that point. The socket rotation remains rig-owned.
    weapon.position.copy(asset.gripAnchor).multiplyScalar(-1);
    // The target is a sibling of the mesh under the same calibrated socket. Subtracting the
    // trigger anchor maps the semantic weapon-local support grip into that socket space.
    this.supportGripTarget.position.copy(asset.supportAnchor).sub(asset.gripAnchor);
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
        this.headBone.getWorldPosition(target);
        return true;
      case 'leftShoulder':
      case 'rightShoulder':
        return false;
    }
  }

  /** The calibrated pad node's world frame: scale-free, so the pad's metres stay metres. */
  getIndicatorFrame(
    anchor: ActorIndicatorFrameAnchor,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
  ): boolean {
    const node = this.shoulderFrames[anchor];
    node.getWorldPosition(position);
    node.getWorldQuaternion(quaternion);
    return true;
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

/**
 * The node a shoulder pad hangs from, under its bone at the profile's offset and rotation —
 * the same construction as the support hand's palm marker, and in the same bone-local units.
 */
function padNode(
  instance: THREE.Object3D,
  profile: CharacterIndicatorPadProfile,
  side: 'left' | 'right',
  rigId: string,
): THREE.Object3D {
  const bone = requiredBone(instance, profile.bone, rigId);
  const node = new THREE.Object3D();
  node.name = `indicator-frame:${side}-shoulder`;
  node.position.set(...profile.offset);
  node.rotation.set(...profile.rotation);
  bone.add(node);
  return node;
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
