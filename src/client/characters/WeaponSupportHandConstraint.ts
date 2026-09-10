import * as THREE from 'three';
import type { CharacterSupportHandProfile } from './CharacterCatalog';

const ITERATIONS = 8;
const MAX_TURN_RADIANS = 0.65;
const POSITION_EPSILON_SQ = 0.000025;
const VECTOR_EPSILON_SQ = 1e-10;

/**
 * Presentation-only inverse kinematics for the hand that supports a weapon.
 *
 * The weapon stays attached to the trigger hand. This constraint only rotates the left upper
 * arm and forearm after the AnimationMixer has produced a pose, bringing a virtual palm marker
 * to an Object3D attached to the weapon. It never changes the actor transform or simulation.
 */
export class WeaponSupportHandConstraint {
  private readonly upperArm: THREE.Bone;
  private readonly forearm: THREE.Bone;
  private readonly hand: THREE.Bone;
  private readonly palm = new THREE.Object3D();
  private readonly targetPosition = new THREE.Vector3();
  private readonly palmPosition = new THREE.Vector3();
  private readonly linkPosition = new THREE.Vector3();
  private readonly effectorVector = new THREE.Vector3();
  private readonly targetVector = new THREE.Vector3();
  private readonly rotationAxis = new THREE.Vector3();
  private readonly linkWorldRotation = new THREE.Quaternion();
  private readonly inverseLinkWorldRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();

  constructor(
    private readonly root: THREE.Object3D,
    private readonly target: THREE.Object3D,
    profile: CharacterSupportHandProfile,
  ) {
    this.upperArm = requiredBone(root, profile.upperArmBone);
    this.forearm = requiredBone(root, profile.forearmBone);
    this.hand = requiredBone(root, profile.handBone);
    this.palm.name = 'weapon-support-palm';
    this.palm.position.set(...profile.palmOffset);
    this.hand.add(this.palm);
  }

  /** Call after AnimationMixer.update and after the avatar's outer transform is current. */
  solve(): void {
    this.root.updateWorldMatrix(true, true);
    this.target.getWorldPosition(this.targetPosition);

    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      this.palm.getWorldPosition(this.palmPosition);
      if (this.palmPosition.distanceToSquared(this.targetPosition) <= POSITION_EPSILON_SQ) return;
      this.rotateTowardTarget(this.forearm);
      this.rotateTowardTarget(this.upperArm);
    }
  }

  private rotateTowardTarget(link: THREE.Bone): void {
    this.palm.getWorldPosition(this.palmPosition);
    link.getWorldPosition(this.linkPosition);
    this.effectorVector.subVectors(this.palmPosition, this.linkPosition);
    this.targetVector.subVectors(this.targetPosition, this.linkPosition);
    if (
      this.effectorVector.lengthSq() <= VECTOR_EPSILON_SQ ||
      this.targetVector.lengthSq() <= VECTOR_EPSILON_SQ
    ) {
      return;
    }

    // Express the turn in the link's local frame. Multiplying the local bone quaternion then
    // applies exactly the world-space turn from its joint toward the weapon target.
    link.getWorldQuaternion(this.linkWorldRotation);
    this.inverseLinkWorldRotation.copy(this.linkWorldRotation).invert();
    this.effectorVector.applyQuaternion(this.inverseLinkWorldRotation).normalize();
    this.targetVector.applyQuaternion(this.inverseLinkWorldRotation).normalize();

    const dot = THREE.MathUtils.clamp(this.effectorVector.dot(this.targetVector), -1, 1);
    if (dot >= 1 - 1e-6) return;

    this.rotationAxis.crossVectors(this.effectorVector, this.targetVector);
    if (this.rotationAxis.lengthSq() <= VECTOR_EPSILON_SQ) {
      // Exact opposition is rare, but choosing a stable perpendicular axis prevents a stalled
      // arm on a pose transition where the two vectors happen to be collinear.
      this.rotationAxis.set(1, 0, 0);
      if (Math.abs(this.effectorVector.x) > 0.9) this.rotationAxis.set(0, 1, 0);
      this.rotationAxis.cross(this.effectorVector).normalize();
    } else {
      this.rotationAxis.normalize();
    }

    const angle = Math.min(Math.acos(dot), MAX_TURN_RADIANS);
    this.rotation.setFromAxisAngle(this.rotationAxis, angle);
    link.quaternion.multiply(this.rotation).normalize();
    link.updateWorldMatrix(false, true);
  }
}

function requiredBone(root: THREE.Object3D, name: string): THREE.Bone {
  const node = root.getObjectByName(name);
  if (node === undefined || (node as THREE.Object3D & { isBone?: boolean }).isBone !== true) {
    throw new Error(`Character skin is missing support-hand bone "${name}".`);
  }
  return node as THREE.Bone;
}
