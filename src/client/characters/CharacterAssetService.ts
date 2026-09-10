import { logger } from '../../shared/core/Log';
import { FactoryCharacterAvatarProvider, type CharacterAvatarProvider } from './CharacterAvatarProvider';
import { CharacterAvatarFactory } from './CharacterAvatarFactory';
import type { CharacterDefinition } from './CharacterCatalog';
import {
  GltfCharacterAssetRepository,
  type CharacterAssetRepository,
} from './CharacterAssetRepository';

const log = logger('CharacterAssets');

/** Observable state for a future loading surface or skin picker. */
export type CharacterAssetStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Application-lifetime owner for parsed character GLB templates and their synchronous factories.
 *
 * The repository owns the actual fetch/parse cache. This service owns its lifetime, adds a
 * factory cache keyed by `characterId@version`, and lets Match-scoped providers observe a retry
 * without ever owning or disposing shared geometry, textures, or clips.
 */
export class CharacterAssetService {
  private readonly factories = new Map<string, CharacterAvatarFactory>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly statuses = new Map<string, CharacterAssetStatus>();
  private disposed = false;

  constructor(private readonly repository: CharacterAssetRepository = new GltfCharacterAssetRepository()) {}

  /** Start or join a background load. It never creates an avatar during a render frame. */
  preload(definition: CharacterDefinition): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Character asset service has been disposed.'));

    const key = assetKey(definition);
    if (this.factories.has(key)) return Promise.resolve();

    const existing = this.loading.get(key);
    if (existing !== undefined) return existing;

    this.statuses.set(key, 'loading');
    const task = this.repository.preload(definition).then((assets) => {
      if (this.disposed) throw new Error('Character asset service was disposed while assets were loading.');
      this.factories.set(key, new CharacterAvatarFactory(assets));
      this.statuses.set(key, 'ready');
      log.info(`GLB character template "${assets.definition.id}" is ready.`);
    });
    this.loading.set(key, task);
    void task.then(
      () => {
        if (this.loading.get(key) === task) this.loading.delete(key);
      },
      (error: unknown) => {
        if (this.loading.get(key) !== task) return;
        this.loading.delete(key);
        this.statuses.set(key, 'error');
        // Failed repository promises are evicted, so the next explicit retry or Match can make
        // one new request without discarding successfully cached assets for other skins.
        log.warn(
          `GLB character assets unavailable for "${definition.id}"; renderers will retain their procedural fallback until a retry succeeds. ${errorMessage(error)}`,
        );
      },
    );
    return task;
  }

  /** Retry a failed bundle once; live providers automatically see a successful factory. */
  retry(definition: CharacterDefinition): Promise<void> {
    return this.preload(definition);
  }

  statusFor(definition: CharacterDefinition): CharacterAssetStatus {
    return this.statuses.get(assetKey(definition)) ?? 'idle';
  }

  /**
   * Create a lightweight provider for one Match. Calling this is a composition-time retry point,
   * never a render-loop action; after a success the provider reads the cached factory directly.
   */
  avatarProvider(definition: CharacterDefinition): CharacterAvatarProvider {
    void this.preload(definition).catch(() => undefined);
    return new FactoryCharacterAvatarProvider(definition, () => this.factoryFor(definition));
  }

  /** Called only after all Match avatars are gone, when the application itself is torn down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.factories.clear();
    this.loading.clear();
    this.statuses.clear();
    this.repository.dispose();
  }

  private factoryFor(definition: CharacterDefinition): CharacterAvatarFactory | null {
    if (this.disposed) return null;
    return this.factories.get(assetKey(definition)) ?? null;
  }
}

function assetKey(definition: CharacterDefinition): string {
  return `${definition.id}@${definition.version}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
