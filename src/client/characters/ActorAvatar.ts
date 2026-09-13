import * as THREE from 'three';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';

/** Semantic landmarks used by the client-only world identification layer. */
export type ActorIndicatorAnchor =
  | 'head'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftKnee'
  | 'rightKnee';

/**
 * A third-person weapon, ready to be put in a hand.
 *
 * Built by the weapon module and handed over whole, so an avatar never resolves anything by
 * weapon id itself: the geometry, the material and the two grip points arrive together and
 * cannot disagree about which weapon they describe. Both anchors are in the geometry's own
 * space, with the model scale already baked in — the same space the vertices are in.
 */
export interface HeldWeaponAsset {
  readonly weaponId: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  /** The trigger grip. This is the point that sits at the hand socket. */
  readonly gripAnchor: THREE.Vector3;
  /** The support palm. This is where the other hand is pulled to. */
  readonly supportAnchor: THREE.Vector3;
}

/**
 * The narrow scene-object contract consumed by `BotRenderer`.
 *
 * `BotMesh` implements it as the procedural fallback; `CharacterAvatar` implements it for a
 * skinned GLB.  The roster reconciler therefore never cares how a body was constructed.
 */
export interface ActorAvatar {
  readonly group: THREE.Group;
  readonly isDying: boolean;

  /** Put this in the body's hands, or empty them. Idempotent for an unchanged weapon id. */
  setWeapon(weapon: HeldWeaponAsset | null): void;
  setVisible(on: boolean): void;
  /**
   * Write an animated, world-space landmark to `target`.
   *
   * The renderer owns the viewer-relative IFF policy. Avatars expose only geometry landmarks,
   * which keeps a future skin free to use a different skeleton without teaching the renderer
   * about its bone names.
   */
  getIndicatorAnchor(anchor: ActorIndicatorAnchor, target: THREE.Vector3): boolean;
  beginDeath(dx: number, dz: number, variant: number, animation: ActorAnimationInput): void;
  endDeath(): void;
  flinch(dx: number, dz: number): void;
  /** Apply one authoritative render pose and advance local-only visual effects. */
  update(
    animation: ActorAnimationInput,
    x: number,
    y: number,
    z: number,
    yaw: number,
    heightScale: number,
    dt: number,
  ): void;
  dispose(): void;
}
