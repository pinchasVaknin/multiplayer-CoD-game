import * as THREE from 'three';
import type {
  CharacterAnimationDefinition,
  CharacterAnimationId,
  CharacterId,
  CharacterRigProfile,
} from './CharacterCatalog';

/**
 * The import pipeline: what happens to a parsed GLB before it may become a shared template.
 *
 * Pure functions of (parsed asset, rig profile). None of this fetches, caches or owns anything
 * — that is `CharacterAssetRepository`'s job, and keeping the two apart is what lets the
 * repository cache an animation file once per URL while every skin still gets clips prepared
 * against its own bind pose. Every check throws with the character or animation named, because
 * the message is the review point a newly exported asset gets.
 */

/**
 * What `importClip` needs to know about the skin a clip is being prepared for: the motion
 * bone's bind position, which the planar root lock is pinned to, and the bones the skin has,
 * which is what a clip's tracks can bind to. Both come out of one traversal in `validateSkin`
 * rather than being looked up twice.
 */
export interface SkinBinding {
  readonly bindMotionPosition: THREE.Vector3;
  readonly bones: ReadonlySet<string>;
}

/** Check a skin against its rig profile and return what clips are prepared against. */
export function validateSkin(
  scene: THREE.Object3D,
  rig: CharacterRigProfile,
  characterId: CharacterId,
): SkinBinding {
  const bones = new Set<string>();
  let skinnedMeshes = 0;
  scene.traverse((node) => {
    const tagged = node as THREE.Object3D & { isBone?: boolean; isSkinnedMesh?: boolean };
    if (tagged.isBone === true) bones.add(node.name);
    if (tagged.isSkinnedMesh === true) skinnedMeshes++;
  });

  if (skinnedMeshes === 0) {
    throw new Error(`Character "${characterId}" skin has no SkinnedMesh.`);
  }
  if (bones.size < rig.minimumBoneCount) {
    throw new Error(
      `Character "${characterId}" rig has ${bones.size} bones; ${rig.minimumBoneCount} are required for ${rig.id}.`,
    );
  }
  for (const required of rig.requiredBones) {
    if (!bones.has(required)) {
      throw new Error(`Character "${characterId}" rig ${rig.id} is missing required bone "${required}".`);
    }
  }
  const motionBone = scene.getObjectByName(rig.motionBone);
  if (motionBone === undefined) {
    throw new Error(`Character "${characterId}" rig ${rig.id} is missing motion bone "${rig.motionBone}".`);
  }
  return { bindMotionPosition: motionBone.position.clone(), bones };
}

/**
 * Turn one animation file's clips into the one clip the catalog names, prepared for this rig
 * and this skin.
 *
 * The result is a clone: the source clips are shared by every skin that uses the file, and
 * the unit scale and the root lock below are per rig and per skin respectively. So is the
 * track set: a clip exported on a skeleton with bones this skin lacks (the library's newer
 * files carry a `mixamorigNeck1` six of the seven skins do not have — `scripts/
 * animation-manifest.mjs` reports which) keeps those tracks only on a skin that can bind them.
 * On the others they would bind to nothing and earn a console warning per track per body;
 * the pose they carried is lost either way, and the loss is measured (PLAN.md, M13 Phase D),
 * not hidden by dropping the track here.
 */
export function importClip(
  definition: CharacterAnimationDefinition,
  source: readonly THREE.AnimationClip[],
  rig: CharacterRigProfile,
  skin: SkinBinding,
): THREE.AnimationClip {
  const chosen = selectSourceClip(definition, source);
  const clip = chosen.clone();
  clip.name = definition.id;

  const targetBones = new Set<string>();
  for (const track of clip.tracks) targetBones.add(track.name.split('.')[0] ?? '');
  for (const required of rig.requiredBones) {
    if (!targetBones.has(required)) {
      throw new Error(`Animation "${definition.id}" does not target required bone "${required}".`);
    }
  }
  clip.tracks = clip.tracks.filter((track) => skin.bones.has(track.name.split('.')[0] ?? ''));

  scaleBoneTranslations(clip, rig.animationTranslationScale ?? 1);
  lockRootTranslation(clip, rig, skin.bindMotionPosition, definition.id);
  return clip;
}

/**
 * A skin may use a different local unit from the reviewed animation export. Convert the cloned
 * position tracks at the asset boundary, before they reach a mixer or a shared template.
 */
function scaleBoneTranslations(clip: THREE.AnimationClip, scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Character rig declares invalid animation translation scale ${scale}.`);
  }
  if (scale === 1) return;

  for (const track of clip.tracks) {
    if (!track.name.endsWith('.position')) continue;
    const valueSize = track.getValueSize();
    if (valueSize !== 3) {
      throw new Error(`Animation position track "${track.name}" is not a Vector3 track.`);
    }
    for (let offset = 0; offset < track.values.length; offset += valueSize) {
      track.values[offset] = (track.values[offset] ?? 0) * scale;
      track.values[offset + 1] = (track.values[offset + 1] ?? 0) * scale;
      track.values[offset + 2] = (track.values[offset + 2] ?? 0) * scale;
    }
  }
}

/**
 * The clip the catalogue names, by name. A file on the export contract has exactly one, so
 * this is also where a file that is not — a session export dropped in by hand — is refused
 * with the name it lacks.
 */
function selectSourceClip(
  definition: CharacterAnimationDefinition,
  source: readonly THREE.AnimationClip[],
): THREE.AnimationClip {
  const clip = source.find((candidate) => candidate.name === definition.clipName);
  if (clip === undefined) {
    throw new Error(
      `Animation "${definition.id}" expected a clip named "${definition.clipName}" and found ` +
        `${source.length === 0 ? 'none' : source.map((candidate) => `"${candidate.name}"`).join(', ')}; ` +
        'run scripts/animation-import.mjs on the file.',
    );
  }
  return clip;
}

/** Vector3 track component for each axis name a rig profile may lock. */
const AXIS_COMPONENT = { x: 0, y: 1, z: 2 } as const;

/**
 * Imported Mixamo clips carry translation on the hips. It is motion authored for another
 * controller, not permission to move this actor's replicated pose. The configured components
 * are planar for this rig: its local Z becomes world vertical through the Armature rotation and
 * must remain live so crouches and deaths can reach the floor. Lock configured components to
 * the skin's bind pose rather than to the source clip's first frame: the supplied action GLBs
 * have slightly different rest translations.
 */
function lockRootTranslation(
  clip: THREE.AnimationClip,
  rig: CharacterRigProfile,
  bindMotionPosition: THREE.Vector3,
  animationId: CharacterAnimationId,
): void {
  const trackName = `${rig.motionBone}.position`;
  const track = clip.tracks.find((candidate) => candidate.name === trackName);
  if (track === undefined) {
    throw new Error(`Animation "${animationId}" is missing required root-motion track "${trackName}".`);
  }
  const valueSize = track.getValueSize();
  if (valueSize !== 3) {
    throw new Error(`Animation "${animationId}" root-motion track "${trackName}" is not a Vector3 track.`);
  }

  const bind = [bindMotionPosition.x, bindMotionPosition.y, bindMotionPosition.z];
  for (let offset = 0; offset < track.values.length; offset += valueSize) {
    for (const axis of rig.lockedRootTranslationAxes) {
      const component = AXIS_COMPONENT[axis];
      track.values[offset + component] = bind[component] ?? 0;
    }
  }
}
