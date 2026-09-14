import * as THREE from 'three';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';

/**
 * Semantic landmarks used by the client-only world identification layer.
 *
 * The head is a **point** (the nameplate hangs off it). A shoulder is a **frame** (M13 C3): a
 * pad that lies flush on a sleeve needs a position *and* an orientation, so the shoulders are
 * answered by `getIndicatorFrame`, and `getIndicatorAnchor` returns false for them. The knee
 * anchors went with the emissive spheres they placed.
 */
export type ActorIndicatorAnchor = 'head' | 'leftShoulder' | 'rightShoulder';

/** The anchors that are frames rather than points. */
export const INDICATOR_FRAME_ANCHORS = ['leftShoulder', 'rightShoulder'] as const satisfies readonly ActorIndicatorAnchor[];
export type ActorIndicatorFrameAnchor = (typeof INDICATOR_FRAME_ANCHORS)[number];

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
  /**
   * Write an animated, world-space **frame** — where a pad sits and which way it faces — for
   * one of the frame anchors. The convention is the pad's: local +Z is the outward normal of
   * the surface, +X runs along the limb toward its far end, +Y across it. `CharacterSkin`
   * answers from a calibrated node under the upper-arm bone (`CharacterIndicatorProfile`);
   * `BotMesh` from the outer face of its arm box. The renderer still learns no bone names.
   */
  getIndicatorFrame(anchor: ActorIndicatorFrameAnchor, position: THREE.Vector3, quaternion: THREE.Quaternion): boolean;
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
