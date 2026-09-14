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
  /**
   * Whether the clip holds a firearm in both hands, so the presentation-only support-hand
   * constraint may pull the left palm onto the weapon. Relaxed loops, the crouch-to-stand
   * transition and the deaths do not: forcing a second hand onto a rifle there bends the arm
   * into a pose the source animation never authored. A fact about the clip, so it lives with
   * the clip rather than as a list of ids inside `CharacterAnimator`.
   */
  readonly weaponReady: boolean;
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
 * Where a shoulder pad sits on a skin (M13 C3): a node under `bone`, at `offset` in the
 * bone's own local units (centimetres for the Mixamo skins — the same units `palmOffset` is
 * in, and Apex's ×10 rides the same override), turned by `rotation` (Euler XYZ, radians) so
 * the node's +Z points out of the sleeve and its +X runs down the arm. The renderer reads the
 * node's world frame and knows nothing about which bone it hangs from.
 */
export interface CharacterIndicatorPadProfile {
  readonly bone: string;
  readonly offset: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
}

/**
 * Skeleton landmarks for the client-only IFF layer: the overhead nameplate and the two
 * shoulder pads.
 *
 * These stay with the rig profile rather than in the renderer: a new skin can use a different
 * skeleton without making the roster reconciler know about imported bone names. The knee
 * bones the emissive IFF spheres hung off left with them (M13 C3).
 */
export interface CharacterIndicatorProfile {
  readonly headBone: string;
  readonly leftShoulder: CharacterIndicatorPadProfile;
  readonly rightShoulder: CharacterIndicatorPadProfile;
}

/** A component of a bone-local translation. */
export type RootTranslationAxis = 'x' | 'y' | 'z';

export interface CharacterRigProfile {
  readonly id: string;
  readonly minimumBoneCount: number;
  readonly requiredBones: readonly string[];
  readonly motionBone: string;
  /**
   * Components of the motion bone's translation that are pinned to the bind pose, named in the
   * bone's own local frame. For the Mixamo export local `z` is rendered height, which is why
   * the planar lock is `x` and `y` and not the two you would guess.
   */
  readonly lockedRootTranslationAxes: readonly RootTranslationAxis[];
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

/**
 * Where the shoulder pads sit on a Mixamo skin (M13 C3), measured rather than guessed.
 *
 * The upper-arm bone's +Y runs down the arm to the elbow and its −Z is the lateral surface of
 * the deltoid (world +Y in the T-pose; measured on Echo and Apex). A pad sits 4 cm down the arm
 * and `lateralCm` out along that surface; the rotation maps the bone frame onto the pad's
 * (+Z out of the sleeve, +X down the arm). The lateral distance is where the skinned sleeve
 * vertices under the pad's footprint top out, plus 3 mm — probed in the running game for every
 * skin, in idle, run and crouch, which read the same to a millimetre because the footprint is
 * rigid to the bone. Viper 7.9, Hazard 8.0, Pulse 8.1 and Sentry 7.5 share the 8 cm base; Echo
 * (9.6) and Rhino (12.3) wear bulkier sleeves and get their own rig ids; Apex is 8.7 in its
 * ×10 units. A pad any closer is inside the sleeve; any further floats off it.
 */
const SHOULDER_PAD_LATERAL_CM = 8;
const SHOULDER_PAD_DROP_CM = 4;
const SHOULDER_PAD_ROTATION: readonly [number, number, number] = [-Math.PI, 0, -Math.PI / 2];

function shoulderPads(lateralCm: number, unitScale = 1): CharacterIndicatorProfile {
  const offset: readonly [number, number, number] = [0, SHOULDER_PAD_DROP_CM * unitScale, -lateralCm * unitScale];
  return {
    headBone: 'mixamorigHead',
    leftShoulder: { bone: 'mixamorigLeftArm', offset, rotation: SHOULDER_PAD_ROTATION },
    rightShoulder: { bone: 'mixamorigRightArm', offset, rotation: SHOULDER_PAD_ROTATION },
  };
}

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
  lockedRootTranslationAxes: ['x', 'y'],
  weaponBone: 'mixamorigRightHand',
  weaponOffset: [0, 0, 0],
  weaponRotation: [1.4436, 0.234, -1.3767],
  supportHand: {
    upperArmBone: 'mixamorigLeftArm',
    forearmBone: 'mixamorigLeftForeArm',
    handBone: 'mixamorigLeftHand',
    palmOffset: [-0.46, 4.98, -0.03],
  },
  indicators: shoulderPads(SHOULDER_PAD_LATERAL_CM),
  modelScale: 0.975,
  modelYaw: Math.PI,
};

/**
 * A bulkier sleeve than the pack's: the same rig with the pads further out. Measured the way
 * the base number was; see `shoulderPads`.
 */
function withShoulderPads(base: CharacterRigProfile, id: string, lateralCm: number): CharacterRigProfile {
  return { ...base, id, indicators: shoulderPads(lateralCm) };
}

const ECHO_RIG = withShoulderPads(MIXAMO_V1_RIG, 'mixamo-v1/echo', 9.6);
const RHINO_RIG = withShoulderPads(MIXAMO_V1_RIG, 'mixamo-v1/rhino', 12.3);

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
  // Apex's ×10 rides the same mechanism as its `palmOffset`: measured flush at 8.7 cm.
  indicators: shoulderPads(8.7, 10),
  modelScale: 1.025,
};
function versionedAssetUrl(path: string, version: string): string {
  return `${path}?v=${encodeURIComponent(version)}`;
}

type ClipKind = 'loop' | 'weaponReadyLoop' | 'oneShot';

function animation(
  id: CharacterAnimationId,
  fileName: string,
  expectedDuration: number,
  kind: ClipKind,
): CharacterAnimationDefinition {
  return {
    id,
    url: versionedAssetUrl(`${ANIMATION_ROOT}/${fileName}.glb`, CHARACTER_VERSION),
    selector: { kind: 'last', expectedDuration },
    loop: kind !== 'oneShot',
    weaponReady: kind === 'weaponReadyLoop',
  };
}

const MIXAMO_ANIMATIONS: Readonly<
  Record<CharacterAnimationId, CharacterAnimationDefinition>
> = {
  idleRelaxed: animation('idleRelaxed', 'Idle_Relaxed', 7.717, 'loop'),
  idleWeaponReady: animation('idleWeaponReady', 'Idle_Aiming', 2.117, 'weaponReadyLoop'),
  walkRelaxed: animation('walkRelaxed', 'Walk_Relaxed', 1.317, 'loop'),
  walkWeaponReady: animation('walkWeaponReady', 'Walk_Aiming', 1.383, 'weaponReadyLoop'),
  runRelaxed: animation('runRelaxed', 'Run_Relaxed', 0.517, 'loop'),
  crouchIdleAiming: animation('crouchIdleAiming', 'Crouch_Idle_Aiming', 2.117, 'weaponReadyLoop'),
  crouchWalkAiming: animation('crouchWalkAiming', 'Crouch_Walk_Aiming', 1.017, 'weaponReadyLoop'),
  crouchRunAiming: animation('crouchRunAiming', 'Crouch_Run_Aiming', 0.783, 'weaponReadyLoop'),
  crouchToStand: animation('crouchToStand', 'Transition_Crouch_To_Stand', 1.1, 'oneShot'),
  deathStand: animation('deathStand', 'Death_Stand', 3.033, 'oneShot'),
  deathCrouch: animation('deathCrouch', 'Death_Crouch', 2.367, 'oneShot'),
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
  echo: character('echo', 'Echo.glb', ECHO_RIG),
  hazard: character('hazard', 'Hazard.glb'),
  pulse: character('pulse', 'Pulse.glb'),
  rhino: character('rhino', 'Rhino.glb', RHINO_RIG),
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
