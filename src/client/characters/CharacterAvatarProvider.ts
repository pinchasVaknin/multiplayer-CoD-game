import { logger } from '../../shared/core/Log';
import type { RenderableActor } from '../../shared/ai/BotVisualState';
import type { ActorAvatar } from './ActorAvatar';
import type { CharacterDefinition } from './CharacterCatalog';
import type { CharacterAvatarFactory } from './CharacterAvatarFactory';

const log = logger('CharacterAssets');

/** The renderer's narrow dependency on optional character presentation. */
export interface CharacterAvatarProvider {
  readonly isReady: boolean;
  create(): ActorAvatar | null;
  dispose(): void;
}

/**
 * Resolves a stable, Match-scoped provider for one replicated actor.
 *
 * The resolver is deliberately presentation-only. A future player-selected
 * appearance can replace the deterministic bot selection at this boundary,
 * without coupling the renderer to account or networking code.
 */
export type CharacterAvatarProviderResolver = (
  actor: RenderableActor,
) => CharacterAvatarProvider;

/**
 * Match-scoped view of an app-scoped character factory.
 *
 * The provider owns no GLB resources. A clone failure is isolated to this Match, while the
 * service remains free to finish a retry and make its factory visible to other providers.
 */
export class FactoryCharacterAvatarProvider implements CharacterAvatarProvider {
  private creationFailed = false;
  private disposed = false;

  constructor(
    private readonly definition: CharacterDefinition,
    private readonly factory: () => CharacterAvatarFactory | null,
  ) {}

  get isReady(): boolean {
    return !this.disposed && !this.creationFailed && this.factory() !== null;
  }

  create(): ActorAvatar | null {
    const factory = this.factory();
    if (this.disposed || this.creationFailed || factory === null) return null;

    try {
      return factory.create();
    } catch (error) {
      // Do not let one malformed clone throw in every render frame. This is deliberately local
      // to the Match: a later provider can retry after a new versioned asset is published.
      this.creationFailed = true;
      log.warn(
        `GLB character instance creation failed for "${this.definition.id}"; this match will retain its procedural fallback. ${errorMessage(error)}`,
      );
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
