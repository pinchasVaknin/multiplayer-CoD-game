import { logger } from '../../shared/core/Log';
import type { ActorAvatar } from './ActorAvatar';
import type { CharacterDefinition } from './CharacterCatalog';
import { CharacterAvatarFactory } from './CharacterAvatarFactory';
import {
  GltfCharacterAssetRepository,
  type CharacterAssetRepository,
} from './CharacterAssetRepository';

const log = logger('CharacterAssets');

/**
 * The renderer's dependency on optional character presentation.
 *
 * It exposes a synchronous factory only once background preload succeeds. The renderer never
 * owns GLTFLoader, URLs, cache policy, or a promise lifecycle.
 */
export interface CharacterAvatarProvider {
  readonly isReady: boolean;
  create(): ActorAvatar | null;
  dispose(): void;
}

/** Browser provider for one configured character bundle. */
export class GltfCharacterAvatarProvider implements CharacterAvatarProvider {
  private factory: CharacterAvatarFactory | null = null;
  private failed = false;
  private disposed = false;

  constructor(
    definition: CharacterDefinition,
    private readonly repository: CharacterAssetRepository = new GltfCharacterAssetRepository(),
  ) {
    // Starts once during composition, not during a render frame and not once per entity.
    void this.repository.preload(definition).then(
      (assets) => {
        if (this.disposed) return;
        this.factory = new CharacterAvatarFactory(assets);
        log.info(`GLB character template "${assets.definition.id}" is ready.`);
      },
      (error: unknown) => {
        if (this.disposed) return;
        this.failed = true;
        log.warn(`GLB character assets unavailable; renderer will retain its procedural fallback. ${errorMessage(error)}`);
      },
    );
  }

  get isReady(): boolean {
    return !this.disposed && !this.failed && this.factory !== null;
  }

  create(): ActorAvatar | null {
    if (!this.isReady) return null;
    try {
      return this.factory?.create() ?? null;
    } catch (error) {
      // A bad clone/socket is an asset failure, not a reason to let the render loop throw on
      // every actor every frame. Degrade once to the battle-tested procedural representation.
      this.failed = true;
      log.warn(`GLB character instance creation failed; renderer will retain its procedural fallback. ${errorMessage(error)}`);
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.factory = null;
    this.repository.dispose();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
