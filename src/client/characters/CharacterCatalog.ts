/**
 * Static metadata for the character assets that can be rendered in the game.
 *
 * Files in public/ are deliberately not discovered at runtime. An explicit
 * catalogue gives a newly added asset a review point for scale, rig and memory
 * cost before it becomes eligible for a match. `scripts/check-animations.mjs`
 * holds the animation half of it to the folder it names, in the gate.
 */
export type CharacterId =
  | 'apex'
  | 'echo'
  | 'hazard'
  | 'pulse'
  | 'rhino'
  | 'sentry'
  | 'viper';

/**
 * A **slot** (M13 Phase D): the semantic pose `AnimationSelector` asks for. A slot holds one
 * or more clips — variants — and the selector never learns how many, which is why it has never
 * had to know about files. Which variant a body wears is dealt by `variantFor` from facts every
 * client shares, never drawn at random.
 */
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
  | 'standToCrouch'
  | 'reloadStand'
  | 'reloadWalk'
  | 'reloadCrouch'
  | 'deathStand'
  | 'deathCrouch';

export interface CharacterAnimationDefinition {
  readonly id: CharacterAnimationId;
  readonly url: string;
  /**
   * The export contract: the file holds exactly one clip, named after the file. Every file in
   * the library is on it since decision 13 (2026-09-14) — the original eleven Mixamo session
   * exports were rewritten in place by `scripts/animation-import.mjs`, which also brings in
   * every new file — and `check:animations` refuses one that is not.
   */
  readonly clipName: string;
  readonly loop: boolean;
  /**
   * Whether the clip holds a firearm in both hands, so the presentation-only support-hand
   * constraint may pull the left palm onto the weapon. Relaxed loops, the transitions, the
   * reloads (the left hand is on the magazine) and the deaths do not: forcing a second hand
   * onto a rifle there bends the arm into a pose the source animation never authored. A fact
   * about the clip, so it lives with the clip rather than as a list of ids inside
   * `CharacterAnimator`. Every variant of a slot shares it — see `slot`.
   */
  readonly weaponReady: boolean;
}

/** One or more variants; the selector's answer is never empty. */
type CharacterAnimationSlot = readonly [CharacterAnimationDefinition, ...CharacterAnimationDefinition[]];

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
interface CharacterIndicatorProfile {
  readonly headBone: string;
  readonly leftShoulder: CharacterIndicatorPadProfile;
  readonly rightShoulder: CharacterIndicatorPadProfile;
}

/** A component of a bone-local translation. */
type RootTranslationAxis = 'x' | 'y' | 'z';

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
  readonly animations: Readonly<Record<CharacterAnimationId, CharacterAnimationSlot>>;
}

// M15 B0: the skins were re-encoded (1024 px, JPEG) — the URLs move so a cached 28 MB Echo is not kept.
const CHARACTER_VERSION = '2026-09-15-skins-jpeg';
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

/**
 * A slot's variants, each a file named by its path under `public/models/bots/animations/`
 * without the extension, in the order `variantFor` indexes them. The folder is the slot family
 * (`locomotion/stand`, `deaths`, …); the README there says what each folder means, and
 * `check:animations` holds this table and that folder to each other, so a file nobody
 * catalogued and a catalogue entry nobody shipped both fail the gate. Variants share the kind:
 * two clips that disagree about looping or about holding a weapon are two slots, not two
 * variants.
 */
function slot(id: CharacterAnimationId, kind: ClipKind, first: string, ...rest: readonly string[]): CharacterAnimationSlot {
  const define = (path: string): CharacterAnimationDefinition => ({
    id,
    url: versionedAssetUrl(`${ANIMATION_ROOT}/${path}.glb`, CHARACTER_VERSION),
    clipName: path.slice(path.lastIndexOf('/') + 1),
    loop: kind !== 'oneShot',
    weaponReady: kind === 'weaponReadyLoop',
  });
  return [define(first), ...rest.map(define)];
}

/**
 * The library (M13 Phase D). Slots were decided from `scripts/animation-manifest.mjs` and
 * `scripts/measure-crouch.mjs` over the delivered files, not from their names:
 *
 * - `runRelaxed` has two variants, dealt per life. Both are 0.517 s relaxed sprints whose
 *   crown sits 1.52 m up, and a standing body only reaches the run threshold while sprinting.
 * - `deathStand` has two; the simulation's `deathVariant` indexes them, so the server and
 *   every client agree which one a body fell with.
 * - `standToCrouch` is the authored transition into the kneel (its last frame is 4 cm under
 *   the kneel's crown, 3.4 of them the `Neck1` the skins lack). With it, `crouchToStand` is
 *   no longer played backwards.
 * - The three reloads are one-shots keyed on `ActorAnimationInput.reloading`, fitted to the
 *   weapon's reload time by `CharacterAnimator`. `Crouch_Idle_Reload` sits 5 cm under the
 *   kneel layout's head box — recorded in PLAN.md, not padded away.
 * - The seven pistol-family files stay in `incoming/`: their crouch is a half-squat 11 cm
 *   taller than the kneel layout, and a slot whose variants need different hitboxes is not a
 *   slot. PLAN.md carries the decision.
 */
const MIXAMO_ANIMATIONS: Readonly<Record<CharacterAnimationId, CharacterAnimationSlot>> = {
  idleRelaxed: slot('idleRelaxed', 'loop', 'locomotion/stand/Idle_Relaxed'),
  idleWeaponReady: slot('idleWeaponReady', 'weaponReadyLoop', 'locomotion/stand/Idle_Aiming'),
  walkRelaxed: slot('walkRelaxed', 'loop', 'locomotion/stand/Walk_Relaxed'),
  walkWeaponReady: slot('walkWeaponReady', 'weaponReadyLoop', 'locomotion/stand/Walk_Aiming'),
  runRelaxed: slot('runRelaxed', 'loop', 'locomotion/stand/Run_Relaxed', 'locomotion/stand/Sprint_Relaxed'),
  crouchIdleAiming: slot('crouchIdleAiming', 'weaponReadyLoop', 'locomotion/crouch/Crouch_Idle_Aiming'),
  crouchWalkAiming: slot('crouchWalkAiming', 'weaponReadyLoop', 'locomotion/crouch/Crouch_Walk_Aiming'),
  crouchRunAiming: slot('crouchRunAiming', 'weaponReadyLoop', 'locomotion/crouch/Crouch_Run_Aiming'),
  crouchToStand: slot('crouchToStand', 'oneShot', 'transitions/Transition_Crouch_To_Stand'),
  standToCrouch: slot('standToCrouch', 'oneShot', 'transitions/Transition_Stand_To_Crouch_Aiming'),
  reloadStand: slot('reloadStand', 'oneShot', 'actions/Idle_Reload'),
  reloadWalk: slot('reloadWalk', 'oneShot', 'actions/Walk_Reload'),
  reloadCrouch: slot('reloadCrouch', 'oneShot', 'actions/Crouch_Idle_Reload'),
  deathStand: slot('deathStand', 'oneShot', 'deaths/Death_Stand', 'deaths/Death_Stand_01'),
  deathCrouch: slot('deathCrouch', 'oneShot', 'deaths/Death_Crouch'),
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
