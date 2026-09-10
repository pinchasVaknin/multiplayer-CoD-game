import * as THREE from 'three';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';

/** A viewer-relative colour wash applied by an avatar without knowing game-team rules. */
export interface TeamVisualTint {
  readonly color: number;
  /** 0 preserves the authored material; 1 replaces it with `color`. */
  readonly blend: number;
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

  setWeapon(weaponId: string | null, geometry: THREE.BufferGeometry | null, material: THREE.Material): void;
  setVisible(on: boolean): void;
  /** `tint` is a per-instance presentation colour, never a mutation of shared materials. */
  setTeamTint(tint: TeamVisualTint): void;
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
