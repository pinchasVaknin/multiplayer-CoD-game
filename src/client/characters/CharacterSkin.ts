import * as THREE from 'three';
import { heldWeaponGripAnchor, heldWeaponSupportAnchor } from '../weapons/WeaponMesh';
import type { TeamVisualTint } from './ActorAvatar';
import type { CharacterRigProfile } from './CharacterCatalog';
import { WeaponSupportHandConstraint } from './WeaponSupportHandConstraint';

/**
 * One cloned skin and its cosmetic attachments.
 *
 * Geometry, textures, and skeleton source data are shared by the repository. Materials are
 * cloned per avatar because team tint is mutable; mutating a template material would repaint
 * every soldier on the map.
 */
export class CharacterSkin {
  readonly root = new THREE.Group();

  private readonly materials = new Set<THREE.Material>();
  private readonly baseColours = new Map<THREE.Material, THREE.Color>();
  private readonly weaponSocket = new THREE.Group();
  private readonly supportGripTarget = new THREE.Object3D();
  private readonly supportHandConstraint: WeaponSupportHandConstraint;
  private weapon: THREE.Mesh | null = null;
  private weaponId: string | null = null;
  private hasSupportGrip = false;

  constructor(instance: THREE.Object3D, rig: CharacterRigProfile) {
    this.root.name = `character-skin:${rig.id}`;
    this.root.rotation.y = rig.modelYaw;
    this.root.scale.setScalar(rig.modelScale);
    this.cloneMutableMaterials(instance);

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

  setTeamTint(tint: TeamVisualTint): void {
    const target = new THREE.Color(tint.color);
    const blend = THREE.MathUtils.clamp(tint.blend, 0, 1);
    for (const material of this.materials) {
      const base = this.baseColours.get(material);
      if (base === undefined || !hasColour(material)) continue;
      // Preserve the authored texture/material identity; this is a readable IFF wash, not a
      // replacement shader or a destructive change to the shared source material.
      material.color.copy(base).lerp(target, blend);
    }
  }

  dispose(): void {
    if (this.weapon !== null) this.weapon.removeFromParent();
    this.weapon = null;
    this.weaponId = null;
    this.hasSupportGrip = false;
    for (const material of this.materials) material.dispose();
    this.materials.clear();
    this.baseColours.clear();
    this.root.clear();
  }

  private cloneMutableMaterials(instance: THREE.Object3D): void {
    const variants = new Map<THREE.Material, THREE.Material>();
    instance.traverse((node) => {
      if ((node as THREE.Object3D & { isMesh?: boolean }).isMesh !== true) return;
      const mesh = node as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.material = cloneMaterialSet(mesh.material, variants, this.materials, this.baseColours);
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

function relativeUniformScale(root: THREE.Vector3, child: THREE.Vector3, rigId: string): number {
  const rootAverage = (Math.abs(root.x) + Math.abs(root.y) + Math.abs(root.z)) / 3;
  const childAverage = (Math.abs(child.x) + Math.abs(child.y) + Math.abs(child.z)) / 3;
  if (rootAverage < 1e-6 || childAverage < 1e-6) {
    throw new Error(`Character rig "${rigId}" has a zero-scale weapon attachment.`);
  }
  return rootAverage / childAverage;
}

function cloneMaterialSet(
  source: THREE.Material | readonly THREE.Material[],
  variants: Map<THREE.Material, THREE.Material>,
  materials: Set<THREE.Material>,
  baseColours: Map<THREE.Material, THREE.Color>,
): THREE.Material | THREE.Material[] {
  if (Array.isArray(source)) {
    return (source as readonly THREE.Material[]).map((material) => cloneMaterial(material, variants, materials, baseColours));
  }
  return cloneMaterial(source as THREE.Material, variants, materials, baseColours);
}

function cloneMaterial(
  source: THREE.Material,
  variants: Map<THREE.Material, THREE.Material>,
  materials: Set<THREE.Material>,
  baseColours: Map<THREE.Material, THREE.Color>,
): THREE.Material {
  const existing = variants.get(source);
  if (existing !== undefined) return existing;

  const clone = source.clone();
  variants.set(source, clone);
  materials.add(clone);
  if (hasColour(clone)) baseColours.set(clone, clone.color.clone());
  return clone;
}

function hasColour(material: THREE.Material): material is THREE.Material & { color: THREE.Color } {
  return 'color' in material && (material as { color?: unknown }).color instanceof THREE.Color;
}
