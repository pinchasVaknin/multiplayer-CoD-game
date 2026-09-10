/**
 * Static metadata for the character assets that can be rendered in the game.
 *
 * Files in public/ are deliberately not discovered at runtime. An explicit
 * catalogue gives a newly added asset a review point for scale, rig and memory
 * cost before it becomes eligible for a match.
 */
export type CharacterId =
  | 'apex'
  | 'echo'
  | 'hazard'
  | 'pulse'
  | 'rhino'
  | 'sentry'
  | 'viper';

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
   * The current source files contain cumulative, unnamed Mixamo clips. `last` isolates that
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
 * The marker is expressed in the source rig's local units (centimetres for these Mixamo skins),
 * rather than in weapon units.
 */
export interface CharacterSupportHandProfile {
  readonly upperArmBone: string;
  readonly forearmBone: string;
  readonly handBone: string;
  readonly palmOffset: readonly [number, number, number];
}

/**
 * Skeleton landmarks for the client-only IFF markers and overhead nameplate.
 *
 * These stay with the rig profile rather than in the renderer: a new skin can use a different
 * skeleton without making the roster reconciler know about imported bone names.
 */
export interface CharacterIndicatorProfile {
  readonly headBone: string;
  readonly leftUpperArmStartBone: string;
  readonly leftUpperArmEndBone: string;
  readonly rightUpperArmStartBone: string;
  readonly rightUpperArmEndBone: string;
  readonly leftKneeBone: string;
  readonly rightKneeBone: string;
}

export interface CharacterRigProfile {
  readonly id: string;
  readonly minimumBoneCount: number;
  readonly requiredBones: readonly string[];
  readonly motionBone: string;
  readonly lockedRootTranslationAxes: readonly number[];
  /**
   * Multiplier for imported bone translation tracks. Most reviewed Mixamo exports use 1;
   * Apex has a centimetre-scale skeleton beneath a millimetre-scale armature root.
   */
  readonly animationTranslationScale?: number;
  readonly weaponBone: string;
  readonly weaponOffset: readonly [number, number, number];
  readonly weaponRotation: readonly [number, number, number];
  readonly supportHand: CharacterSupportHandProfile;
  readonly indicators: CharacterIndicatorProfile;
  readonly modelScale: number;
  readonly modelYaw: number;
}

export interface CharacterDefinition {
  readonly id: CharacterId;
  readonly version: string;
  readonly skinUrl: string;
  readonly rig: CharacterRigProfile;
  readonly animations: Readonly<Record<CharacterAnimationId, CharacterAnimationDefinition>>;
}

const CHARACTER_VERSION = '2026-09-10-skins-v2';
const ANIMATION_ROOT = '/models/bots/animations';

const MIXAMO_V1_RIG: CharacterRigProfile = {
  id: 'mixamo-v1',
  minimumBoneCount: 65,
  requiredBones: [
    'mixamorigHips',
    'mixamorigSpine',
    'mixamorigHead',
    'mixamorigLeftArm',
    'mixamorigLeftForeArm',
    'mixamorigLeftHand',
    'mixamorigRightArm',
    'mixamorigRightForeArm',
    'mixamorigRightHand',
    'mixamorigLeftUpLeg',
    'mixamorigLeftLeg',
    'mixamorigRightUpLeg',
    'mixamorigRightLeg',
    'mixamorigLeftFoot',
    'mixamorigRightFoot',
  ],
  motionBone: 'mixamorigHips',
  lockedRootTranslationAxes: [0, 1],
  weaponBone: 'mixamorigRightHand',
  weaponOffset: [0, 0, 0],
  weaponRotation: [1.4436, 0.234, -1.3767],
  supportHand: {
    upperArmBone: 'mixamorigLeftArm',
    forearmBone: 'mixamorigLeftForeArm',
    handBone: 'mixamorigLeftHand',
    palmOffset: [-0.46, 4.98, -0.03],
  },
  indicators: {
    headBone: 'mixamorigHead',
    leftUpperArmStartBone: 'mixamorigLeftArm',
    leftUpperArmEndBone: 'mixamorigLeftForeArm',
    rightUpperArmStartBone: 'mixamorigRightArm',
    rightUpperArmEndBone: 'mixamorigRightForeArm',
    leftKneeBone: 'mixamorigLeftLeg',
    rightKneeBone: 'mixamorigRightLeg',
  },
  modelScale: 0.975,
  modelYaw: Math.PI,
};

/**
 * Apex has the same named Mixamo landmarks as the regular pack, but its exported armature uses
 * a 0.001 root scale while the bones remain authored in centimetres. Keeping this as a rig
 * profile makes the unit conversion explicit instead of smuggling a special case into the
 * renderer or changing authoritative actor transforms.
 */
const APEX_RIG: CharacterRigProfile = {
  ...MIXAMO_V1_RIG,
  id: 'mixamo-apex-v1',
  animationTranslationScale: 10,
  supportHand: {
    ...MIXAMO_V1_RIG.supportHand,
    palmOffset: [-4.6, 49.8, -0.3],
  },
  modelScale: 1.025,
};
function versionedAssetUrl(path: string, version: string): string {
  return `${path}?v=${encodeURIComponent(version)}`;
}

function animation(
  id: CharacterAnimationId,
  fileName: string,
  expectedDuration: number,
  loop: boolean,
): CharacterAnimationDefinition {
  return {
    id,
    url: versionedAssetUrl(`${ANIMATION_ROOT}/${fileName}.glb`, CHARACTER_VERSION),
    selector: { kind: 'last', expectedDuration },
    loop,
  };
}

const MIXAMO_ANIMATIONS: Readonly<
  Record<CharacterAnimationId, CharacterAnimationDefinition>
> = {
  idleRelaxed: animation('idleRelaxed', 'Idle_Relaxed', 7.717, true),
  idleWeaponReady: animation('idleWeaponReady', 'Idle_Aiming', 2.117, true),
  walkRelaxed: animation('walkRelaxed', 'Walk_Relaxed', 1.317, true),
  walkWeaponReady: animation('walkWeaponReady', 'Walk_Aiming', 1.383, true),
  runRelaxed: animation('runRelaxed', 'Run_Relaxed', 0.517, true),
  crouchIdleAiming: animation('crouchIdleAiming', 'Crouch_Idle_Aiming', 2.117, true),
  crouchWalkAiming: animation('crouchWalkAiming', 'Crouch_Walk_Aiming', 1.017, true),
  crouchRunAiming: animation('crouchRunAiming', 'Crouch_Run_Aiming', 0.783, true),
  crouchToStand: animation('crouchToStand', 'Transition_Crouch_To_Stand', 1.1, false),
  deathStand: animation('deathStand', 'Death_Stand', 3.033, false),
  deathCrouch: animation('deathCrouch', 'Death_Crouch', 2.367, false),
};

function character(
  id: CharacterId,
  fileName: string,
  rig: CharacterRigProfile = MIXAMO_V1_RIG,
): CharacterDefinition {
  return {
    id,
    version: CHARACTER_VERSION,
    skinUrl: versionedAssetUrl(`/models/bots/skins/${fileName}`, CHARACTER_VERSION),
    rig,
    animations: MIXAMO_ANIMATIONS,
  };
}

export const CHARACTER_DEFINITIONS = {
  apex: character('apex', 'Apex.glb', APEX_RIG),
  echo: character('echo', 'Echo.glb'),
  hazard: character('hazard', 'Hazard.glb'),
  pulse: character('pulse', 'Pulse.glb'),
  rhino: character('rhino', 'Rhino.glb'),
  sentry: character('sentry', 'Sentry.glb'),
  viper: character('viper', 'Viper.glb'),
} satisfies Readonly<Record<CharacterId, CharacterDefinition>>;

/**
 * Skins eligible for the current bot-only cosmetic selection.
 *
 * Every entry has passed the skin and rig validation. Apex keeps a separate rig profile because
 * its asset's unit scale differs from the rest of the Mixamo pack.
 */
export const BOT_CHARACTER_IDS = [
  'apex',
  'echo',
  'hazard',
  'pulse',
  'rhino',
  'sentry',
  'viper',
] as const satisfies readonly CharacterId[];

export const DEFAULT_CHARACTER_ID: CharacterId = 'echo';

export function characterDefinition(id: CharacterId): CharacterDefinition {
  return CHARACTER_DEFINITIONS[id];
}
