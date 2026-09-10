import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterAssetBundle } from './CharacterAssetRepository';
import { CharacterAvatar } from './CharacterAvatar';

/**
 * Synchronous composition of an already-loaded character.
 *
 * It deliberately has no loader or cache dependency: `BotRenderer` can call this only after
 * the repository has completed preload, so actor creation never awaits I/O inside a frame.
 */
export class CharacterAvatarFactory {
  constructor(private readonly assets: CharacterAssetBundle) {}

  create(): CharacterAvatar {
    // `Object3D.clone(true)` would leave SkinnedMeshes referring to the source skeleton. That
    // makes one actor's mixer pose every actor; SkeletonUtils clones the bone hierarchy safely
    // while retaining shared geometry and textures.
    return new CharacterAvatar(cloneSkeleton(this.assets.skinTemplate), this.assets);
  }
}
