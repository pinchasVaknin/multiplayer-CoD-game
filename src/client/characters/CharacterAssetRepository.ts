import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CharacterAnimationId, CharacterDefinition } from './CharacterCatalog';
import { importClip, validateSkin } from './CharacterAssetImport';

/**
 * Parsed, shared templates. They are immutable from the perspective of an avatar instance.
 *
 * `clips` holds one prepared clip per catalogue variant, in the slot's order, so
 * `clips.get(slot)[variant]` is the clip `variantFor` names (M13 Phase D).
 */
export interface CharacterAssetBundle {
  readonly definition: CharacterDefinition;
  readonly skinTemplate: THREE.Object3D;
  readonly clips: ReadonlyMap<CharacterAnimationId, readonly THREE.AnimationClip[]>;
}

/** The I/O/cache seam. Factories consume a `CharacterAssetBundle`, never a loader. */
export interface CharacterAssetRepository {
  preload(definition: CharacterDefinition): Promise<CharacterAssetBundle>;
  dispose(): void;
}

/**
 * Browser implementation for GLB character assets.
 *
 * Two caches, because the two kinds of file have two different lifetimes:
 *
 * - **A skin is fetched and parsed once per `characterId@version`.** The parsed scene is the
 *   template every avatar of that character is cloned from, and it owns GPU resources.
 * - **An animation file is fetched and parsed once per URL.** The catalog shares one animation
 *   set across every Mixamo-rigged skin, so keying this on the skin would fetch and parse the
 *   same eleven files for each of seven characters and hold seven copies of every clip. What
 *   *is* per skin — the unit scale and the root lock against that skin's bind pose — is done
 *   on a clone by `importClip`, and a clone of a clip is cheap where a parse of a GLB is not.
 *
 * Both are promise caches: ten actors becoming visible in one frame still perform one fetch
 * and one parse. A failed request is evicted so the next `preload` can try again without
 * discarding anything that succeeded.
 */
export class GltfCharacterAssetRepository implements CharacterAssetRepository {
  private readonly loader = new GLTFLoader();
  /** `public/` URLs are not hashed, so a catalog version belongs in the cache identity. */
  private readonly bundles = new Map<string, Promise<CharacterAssetBundle>>();
  /** Source clips per animation URL. The URL already carries the catalog version. */
  private readonly animationSources = new Map<string, Promise<readonly THREE.AnimationClip[]>>();
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
    this.animationSources.clear();
    for (const skin of this.loadedSkins) disposeTemplate(skin);
    this.loadedSkins.clear();
  }

  private async load(definition: CharacterDefinition): Promise<CharacterAssetBundle> {
    const animationDefinitions = Object.values(definition.animations).flat();
    const loaded = await Promise.allSettled([
      this.loader.loadAsync(definition.skinUrl),
      ...animationDefinitions.map((animation) => this.animationSource(animation.url)),
    ]);

    const [skinResult, ...sourceResults] = loaded;
    const rejected = loaded.find((result) => result.status === 'rejected');
    if (rejected !== undefined) {
      // `Promise.all` would reject at the first failed request and orphan a skin that happened
      // to parse before it. Wait for every request, then release the skin if it did arrive; the
      // animation sources that succeeded stay cached, since nothing about them failed.
      if (skinResult !== undefined && skinResult.status === 'fulfilled') {
        disposeTemplate(skinResult.value.scene);
      }
      throw rejected.reason;
    }
    if (skinResult === undefined || skinResult.status !== 'fulfilled') {
      throw new Error(`Character "${definition.id}" skin was not loaded.`);
    }

    const skin = skinResult.value.scene;
    try {
      if (this.disposed) throw new Error('Character asset repository was disposed while assets were loading.');
      const binding = validateSkin(skin, definition.rig, definition.id);

      const clips = new Map<CharacterAnimationId, THREE.AnimationClip[]>();
      for (let index = 0; index < animationDefinitions.length; index++) {
        const animation = animationDefinitions[index];
        const source = sourceResults[index];
        if (animation === undefined || source === undefined || source.status !== 'fulfilled') {
          throw new Error(`Character "${definition.id}" animation manifest was not loaded completely.`);
        }
        const variants = clips.get(animation.id) ?? [];
        variants.push(importClip(animation, source.value, definition.rig, binding));
        clips.set(animation.id, variants);
      }

      this.loadedSkins.add(skin);
      return { definition, skinTemplate: skin, clips };
    } catch (error) {
      // A validation/manifest error happens after the skin itself was parsed. It is not part of
      // the repository cache yet, so release it here rather than waiting for a page refresh.
      disposeTemplate(skin);
      throw error;
    }
  }

  /**
   * The clips inside one animation file, fetched and parsed once.
   *
   * An animation-only GLB is an import container: its scene is a throwaway skeleton that exists
   * so the tracks have something to bind to at export time. Only the clips are kept, and the
   * scene is released the moment they are out, so the cache holds no geometry or textures.
   */
  private animationSource(url: string): Promise<readonly THREE.AnimationClip[]> {
    const existing = this.animationSources.get(url);
    if (existing !== undefined) return existing;

    const task = this.loader.loadAsync(url).then((gltf) => {
      disposeTemplate(gltf.scene);
      return gltf.animations;
    });
    this.animationSources.set(url, task);
    void task.catch(() => {
      if (this.animationSources.get(url) === task) this.animationSources.delete(url);
    });
    return task;
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
