/**
 * Character asset metadata only.
 *
 * This file deliberately has no Three.js imports and no loader calls.  It is the boundary
 * between gameplay-facing semantic names (`walkRelaxed`) and whichever files an artist
 * delivered.  Adding a character therefore changes data here, rather than creating another
 * renderer branch.
 */

export type CharacterId = 'tacticalSoldier';

export type CharacterAnimationId =
  | 'idleRelaxed'
  | 'idleWeaponReady'
  | 'walkRelaxed'
  | 'walkWeaponReady'
  | 'runRelaxed'
  | 'crouchIdleAiming'
  | 'crouchWalkAiming'
  | 'crouchRunAiming'
  | 'crouchToStand'
  | 'deathStand'
  | 'deathCrouch';

export type LegacyClipSelector = {
  /**
   * The current source files contain cumulative, unnamed Mixamo clips.  `last` isolates that
   * export accident here until the assets are re-exported with one named clip per file.
   */
  readonly kind: 'last';
  /** A cheap guard against an artist overwriting the file with a different last clip. */
  readonly expectedDuration: number;
};

export type NamedClipSelector = {
  readonly kind: 'name';
  readonly name: string;
};

export interface CharacterAnimationDefinition {
  readonly id: CharacterAnimationId;
  readonly url: string;
  readonly selector: LegacyClipSelector | NamedClipSelector;
  readonly loop: boolean;
}

/**
 * Bone landmarks and a palm marker used by the presentation-only support-hand constraint.
 * The marker is expressed in the source rig's local units (centimetres for this Mixamo skin),
 * rather than in weapon units.
 */
export interface CharacterSupportHandProfile {
  readonly upperArmBone: string;
  readonly forearmBone: string;
  readonly handBone: string;
  readonly palmOffset: readonly [number, number, number];
}

export interface CharacterRigProfile {
  readonly id: string;
  /** The loader refuses a skin with fewer joints than this. */
  readonly minimumBoneCount: number;
  /** Enough landmarks to reject a same-sized, incompatible rig. */
  readonly requiredBones: readonly string[];
  /** Bone that owns the root transform tracks in the source animations. */
  readonly motionBone: string;
  /**
   * Source Hips translation components that the repository locks to the skin bind pose.
   * Networked world motion is authoritative. In this asset, local Z becomes world vertical
   * through the Armature rotation, so it must remain animated for crouches and deaths.
   */
  readonly lockedRootTranslationAxes: readonly number[];
  readonly weaponBone: string;
  readonly weaponOffset: readonly [number, number, number];
  readonly weaponRotation: readonly [number, number, number];
  readonly supportHand: CharacterSupportHandProfile;
  /** Model-space calibration against the 1.77 m gameplay rig. */
  readonly modelScale: number;
  /** Mixamo faces +Z while this game's convention is -Z forward. */
  readonly modelYaw: number;
}

export interface CharacterDefinition {
  readonly id: CharacterId;
  readonly version: string;
  readonly skinUrl: string;
  readonly rig: CharacterRigProfile;
  readonly animations: Readonly<Record<CharacterAnimationId, CharacterAnimationDefinition>>;
}

const ANIMATION_ROOT = '/models/bots/animations';
const TACTICAL_SOLDIER_VERSION = '2026-09-10';

/**
 * Files in Vite's `public/` directory keep their literal filename, unlike emitted modules.
 * Make a catalog version part of the URL so a replacement cannot silently reuse a browser's
 * earlier GLB response. A CDN may replace this with a content-hashed manifest later.
 */
function versionedAssetUrl(path: string, version: string): string {
  return `${path}?v=${encodeURIComponent(version)}`;
}

/**
 * The current assets must use legacy selectors because their clips are all called
 * `mixamo.com`, `mixamo.com.001`, etc.  Re-exporting an animation as one semantically named
 * clip changes only its `selector` to `{ kind: 'name', name: 'walk_relaxed' }`.
 */
const animation = (
  version: string,
  id: CharacterAnimationId,
  file: string,
  expectedDuration: number,
  loop: boolean,
): CharacterAnimationDefinition => ({
  id,
  url: versionedAssetUrl(`${ANIMATION_ROOT}/${file}.glb`, version),
  selector: { kind: 'last', expectedDuration },
  loop,
});

export const TACTICAL_SOLDIER: CharacterDefinition = {
  id: 'tacticalSoldier',
  // Bump whenever a public asset is replaced. It is a manifest/cache identity, not a filename.
  version: TACTICAL_SOLDIER_VERSION,
  skinUrl: versionedAssetUrl('/models/bots/skins/tactical_soldier.glb', TACTICAL_SOLDIER_VERSION),
  rig: {
    id: 'mixamo-v1',
    minimumBoneCount: 65,
    requiredBones: [
      'mixamorigHips',
      'mixamorigSpine',
      'mixamorigHead',
      'mixamorigLeftArm',
      'mixamorigLeftForeArm',
      'mixamorigLeftHand',
      'mixamorigRightHand',
      'mixamorigLeftFoot',
      'mixamorigRightFoot',
    ],
    motionBone: 'mixamorigHips',
    // On this Mixamo export the Armature maps local Z to the rendered vertical axis. Locking
    // it pins a fallen/crouched body at standing height; X/Y are the only planar root drift.
    lockedRootTranslationAxes: [0, 1],
    weaponBone: 'mixamorigRightHand',
    // A deliberately explicit, per-rig wrist-to-palm calibration point. Per-weapon placement
    // belongs to the weapon's grip anchor, never here.
    weaponOffset: [0, 0, 0],
    // Calibrated against the supplied Mixamo weapon-ready clips: maps procedural weapon -Z
    // forward and +Y up to the animated right hand's axes.
    weaponRotation: [1.4436, 0.234, -1.3767],
    // The virtual palm marker sits midway between the wrist and middle-finger root. Its source
    // rig units are centimetres; keeping this here makes a replacement rig explicit to review.
    supportHand: {
      upperArmBone: 'mixamorigLeftArm',
      forearmBone: 'mixamorigLeftForeArm',
      handBone: 'mixamorigLeftHand',
      palmOffset: [-0.46, 4.98, -0.03],
    },
    modelScale: 0.975,
    modelYaw: Math.PI,
  },
  animations: {
    idleRelaxed: animation(TACTICAL_SOLDIER_VERSION, 'idleRelaxed', 'Idle_Relaxed', 7.717, true),
    // The supplied source files call these "Aiming", but they are the only delivered poses
    // that actually hold a weapon. Preserve that source detail in the manifest, not gameplay.
    idleWeaponReady: animation(TACTICAL_SOLDIER_VERSION, 'idleWeaponReady', 'Idle_Aiming', 2.117, true),
    walkRelaxed: animation(TACTICAL_SOLDIER_VERSION, 'walkRelaxed', 'Walk_Relaxed', 1.317, true),
    walkWeaponReady: animation(TACTICAL_SOLDIER_VERSION, 'walkWeaponReady', 'Walk_Aiming', 1.383, true),
    runRelaxed: animation(TACTICAL_SOLDIER_VERSION, 'runRelaxed', 'Run_Relaxed', 0.517, true),
    crouchIdleAiming: animation(TACTICAL_SOLDIER_VERSION, 'crouchIdleAiming', 'Crouch_Idle_Aiming', 2.117, true),
    crouchWalkAiming: animation(TACTICAL_SOLDIER_VERSION, 'crouchWalkAiming', 'Crouch_Walk_Aiming', 1.017, true),
    crouchRunAiming: animation(TACTICAL_SOLDIER_VERSION, 'crouchRunAiming', 'Crouch_Run_Aiming', 0.783, true),
    crouchToStand: animation(TACTICAL_SOLDIER_VERSION, 'crouchToStand', 'Transition_Crouch_To_Stand', 1.1, false),
    deathStand: animation(TACTICAL_SOLDIER_VERSION, 'deathStand', 'Death_Stand', 3.033, false),
    deathCrouch: animation(TACTICAL_SOLDIER_VERSION, 'deathCrouch', 'Death_Crouch', 2.367, false),
  },
};

export const DEFAULT_CHARACTER_ID: CharacterId = 'tacticalSoldier';

export function characterDefinition(id: CharacterId): CharacterDefinition {
  switch (id) {
    case 'tacticalSoldier':
      return TACTICAL_SOLDIER;
  }
}
