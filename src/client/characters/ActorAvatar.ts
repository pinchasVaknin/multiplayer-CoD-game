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
 * The narrow scene-object contract consumed by `BotRenderer`.
 *
 * `BotMesh` implements it as the procedural fallback; `CharacterAvatar` implements it for a
 * skinned GLB.  The roster reconciler therefore never cares how a body was constructed.
 */
export interface ActorAvatar {
  readonly group: THREE.Group;
  readonly isDying: boolean;

  setWeapon(weaponId: string | null, geometry: THREE.BufferGeometry | null, material: THREE.Material): void;
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
