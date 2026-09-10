import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type {
  CharacterAnimationDefinition,
  CharacterAnimationId,
  CharacterDefinition,
  CharacterId,
  CharacterRigProfile,
} from './CharacterCatalog';

/** Parsed, shared templates. They are immutable from the perspective of an avatar instance. */
export interface CharacterAssetBundle {
  readonly definition: CharacterDefinition;
  readonly skinTemplate: THREE.Object3D;
  readonly clips: ReadonlyMap<CharacterAnimationId, THREE.AnimationClip>;
}

/** The I/O/cache seam. Factories consume a `CharacterAssetBundle`, never a loader. */
export interface CharacterAssetRepository {
  preload(definition: CharacterDefinition): Promise<CharacterAssetBundle>;
  dispose(): void;
}

/**
 * Browser implementation for GLB character assets.
 *
 * A promise cache is intentional: ten actors becoming visible in one frame still perform one
 * fetch and one parse. The parsed skin remains a template; every actor is cloned later by the
 * factory with `SkeletonUtils.clone`.
 */
export class GltfCharacterAssetRepository implements CharacterAssetRepository {
  private readonly loader = new GLTFLoader();
  /** `public/` URLs are not hashed, so a catalog version belongs in the cache identity. */
  private readonly bundles = new Map<string, Promise<CharacterAssetBundle>>();
  private readonly loadedSkins = new Set<THREE.Object3D>();
  private disposed = false;

  preload(definition: CharacterDefinition): Promise<CharacterAssetBundle> {
    if (this.disposed) return Promise.reject(new Error('Character asset repository has been disposed.'));

    const cacheKey = `${definition.id}@${definition.version}`;
    const existing = this.bundles.get(cacheKey);
    if (existing !== undefined) return existing;

    const task = this.load(definition);
    this.bundles.set(cacheKey, task);
    // A transient fetch failure should be retryable rather than poisoning the repository for
    // the rest of the page lifetime. The caller still receives the original rejection.
    void task.catch(() => {
      if (this.bundles.get(cacheKey) === task) this.bundles.delete(cacheKey);
    });
    return task;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bundles.clear();
    for (const skin of this.loadedSkins) disposeTemplate(skin);
    this.loadedSkins.clear();
  }

  private async load(definition: CharacterDefinition): Promise<CharacterAssetBundle> {
    const animationDefinitions = Object.values(definition.animations);
    const loaded = await Promise.allSettled([
      this.loader.loadAsync(definition.skinUrl),
      ...animationDefinitions.map((animation) => this.loader.loadAsync(animation.url)),
    ]);

    const rejected = loaded.find((result) => result.status === 'rejected');
    if (rejected !== undefined) {
      // `Promise.all` would reject at the first failed request and orphan GLBs that happened to
      // parse before it. Wait for every request, then release each successful transient scene.
      for (const result of loaded) {
        if (result.status === 'fulfilled') disposeTemplate(result.value.scene);
      }
      throw rejected.reason;
    }

    const [skinGltf, ...animationGltfs] = loaded.map(fulfilledValue);
    if (skinGltf === undefined) throw new Error(`Character "${definition.id}" skin was not loaded.`);

    try {
      if (this.disposed) throw new Error('Character asset repository was disposed while assets were loading.');
      const bindMotionPosition = validateSkin(skinGltf.scene, definition.rig, definition.id);

      const clips = new Map<CharacterAnimationId, THREE.AnimationClip>();
      for (let index = 0; index < animationDefinitions.length; index++) {
        const animation = animationDefinitions[index];
        const gltf = animationGltfs[index];
        if (animation === undefined || gltf === undefined) {
          throw new Error(`Character "${definition.id}" animation manifest was not loaded completely.`);
        }
        clips.set(animation.id, prepareClip(animation, gltf.animations, definition.rig, bindMotionPosition));
      }

      this.loadedSkins.add(skinGltf.scene);
      return { definition, skinTemplate: skinGltf.scene, clips };
    } catch (error) {
      // A validation/manifest error happens after the skin itself was parsed. It is not part of
      // the repository cache yet, so release it here rather than waiting for a page refresh.
      disposeTemplate(skinGltf.scene);
      throw error;
    } finally {
      // An animation-only GLB is only an import container. `prepareClip` clones the selected
      // clip, so any transient scene/resources from it can be released whether validation
      // succeeded or failed.
      for (const gltf of animationGltfs) disposeTemplate(gltf.scene);
    }
  }
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

function validateSkin(
  scene: THREE.Object3D,
  rig: CharacterRigProfile,
  characterId: CharacterId,
): THREE.Vector3 {
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
  return motionBone.position.clone();
}

function prepareClip(
  definition: CharacterAnimationDefinition,
  source: readonly THREE.AnimationClip[],
  rig: CharacterRigProfile,
  bindMotionPosition: THREE.Vector3,
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

  lockRootTranslation(clip, rig, bindMotionPosition, definition.id);
  return clip;
}

function selectSourceClip(
  definition: CharacterAnimationDefinition,
  source: readonly THREE.AnimationClip[],
): THREE.AnimationClip {
  let clip: THREE.AnimationClip | undefined;
  const selector = definition.selector;
  if (selector.kind === 'name') {
    clip = source.find((candidate) => candidate.name === selector.name);
    if (clip === undefined) {
      throw new Error(
        `Animation "${definition.id}" expected a clip named "${selector.name}", but it was not found.`,
      );
    }
  } else {
    clip = source.at(-1);
    if (clip === undefined) throw new Error(`Animation "${definition.id}" contains no clips.`);
    if (Math.abs(clip.duration - selector.expectedDuration) > 0.05) {
      throw new Error(
        `Animation "${definition.id}" expected a ${selector.expectedDuration}s legacy clip, got ${clip.duration}s. ` +
          'Update the manifest or re-export one named semantic clip.',
      );
    }
  }
  return clip;
}

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
      if (axis < 0 || axis >= valueSize) {
        throw new Error(`Character rig "${rig.id}" declares invalid locked root-translation axis ${axis}.`);
      }
      track.values[offset + axis] = bind[axis] ?? 0;
    }
  }
}

/** Release resources owned by the loaded template once every avatar using it is already gone. */
function disposeTemplate(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry instanceof THREE.BufferGeometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const item of material) materials.add(item);
    } else if (material instanceof THREE.Material) {
      materials.add(material);
    }
  });

  for (const material of materials) {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
  root.clear();
}
