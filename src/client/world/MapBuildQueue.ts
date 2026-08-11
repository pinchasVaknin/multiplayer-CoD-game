import { logger } from '../../shared/core/Log';
import type { ProceduralTextures } from '../engine/ProceduralTextures';
import type { ShadowQuality } from '../../shared/meta/SaveData';
import { findMap } from '../../shared/modes/ModeRegistry';
import { buildMapChunked, type LoadedMap, type MapBuildProgress } from './MapRender';

const log = logger('mapbuild');

/**
 * The background map build (M11, §6.5).
 *
 * §6.5 calls this *"the most important engineering idea in the milestone"*, and the reason is
 * an asymmetry: when a vote resolves the **server has nothing to load** — its maps were baked
 * at boot (§4.19) — while the client has a full procedural texture pass and mesh construction
 * ahead of it, which on integrated graphics is seconds rather than milliseconds. If that
 * happened at the moment of transition there would be a loading screen, and removing the
 * loading screen is the entire point of the flow.
 *
 * So it happens **while the player is still shooting in the arena**, and it happens a slice at
 * a time.
 *
 * ## The frame budget
 *
 * `pump` is called once per rendered frame and does chunks until it has spent `budgetMs`. The
 * budget is deliberately small — the arena is a live firefight and this is background work, so
 * it yields to the game rather than the other way round.
 *
 * It checks the budget **after** each chunk rather than before, which is the only honest way
 * to do it: chunk durations are not known in advance, so a check beforehand would be a guess
 * about how long the next one takes. The cost of checking afterwards is that one chunk can
 * overrun the budget, and the worst frame during a build is therefore *budget plus the longest
 * single chunk*. That number is measured and reported rather than assumed — see `worstChunkMs`.
 *
 * ## Cancellation
 *
 * Dropping a build mid-flight is a real case: a player can disconnect, or the allocation can
 * fail after the `Prepare` went out. `cancel` disposes whatever has been built so far, which
 * matters because a half-built map is real GPU memory — geometries and materials that a
 * dropped generator would leak.
 */

export interface MapBuildQueueDeps {
  readonly textures: ProceduralTextures;
  readonly shadowQuality: () => ShadowQuality;
  /** Fired once, when the build finishes. The caller reports ready to the server. */
  readonly onComplete: (mapId: string, built: LoadedMap, report: BuildReport) => void;
}

export interface BuildReport {
  readonly mapId: string;
  /** Wall time from the first chunk to the last, including the frames spent not building. */
  readonly elapsedMs: number;
  /** Time actually spent inside chunks. The number that would have been one frame's stall. */
  readonly workMs: number;
  readonly chunks: number;
  /** The longest single chunk. Sets the floor on the worst frame a build can cause. */
  readonly worstChunkMs: number;
  /** Frames the build was spread across. */
  readonly frames: number;
}

/**
 * Milliseconds of building per frame.
 *
 * ## The budget has to meet a deadline, and the first value did not
 *
 * This was 2 ms, chosen so the arena could not possibly judder. That reasoning was incomplete
 * and the arithmetic never worked: 2 ms per frame at 60 FPS is **120 ms of build per second of
 * wall clock**, so a map costing a second or two of work needs eight to seventeen seconds to
 * finish — against a readiness timeout of eight. The handshake was therefore destined to time
 * out on a *healthy* machine, not merely a slow one, and every transition fell through to the
 * §4.18 loading-screen path that exists for the exceptional case.
 *
 * Five milliseconds is the size that meets the deadline. A frame at 60 FPS is 16.7 ms and §4.7
 * reserves 3.0 ms of it for game logic; 5 ms leaves 8.7 ms for rendering, which is comfortable
 * for a greybox arena with three bots in it. The delivered rate is 300 ms/s at 60 FPS and
 * 150 ms/s at 30, so a two-second build lands in roughly 7 s or 13 s respectively — both inside
 * `READY_TIMEOUT_MS`, which was raised to 20 s to cover the slower of the two with margin.
 *
 * **The measured build time per map is the number that validates this**, and it needs a real
 * browser — see PLAN.md. If a map turns out to cost far more than two seconds of work, this
 * budget and that timeout both need revisiting together; they are one decision, not two.
 */
const DEFAULT_BUDGET_MS = 5;

export class MapBuildQueue {
  private readonly deps: MapBuildQueueDeps;

  private steps: Generator<MapBuildProgress, LoadedMap> | null = null;
  private mapId = '';
  private startedMs = 0;
  private workMs = 0;
  private frames = 0;
  private chunks = 0;
  private worstChunkMs = 0;

  /** The finished map, held until the migration that needs it arrives. */
  private ready: { mapId: string; built: LoadedMap } | null = null;

  private lastProgress: MapBuildProgress | null = null;

  constructor(deps: MapBuildQueueDeps) {
    this.deps = deps;
  }

  get building(): boolean {
    return this.steps !== null;
  }

  get progress(): MapBuildProgress | null {
    return this.lastProgress;
  }

  /** The map id currently being built, or the one already built and waiting. */
  get pendingMapId(): string {
    return this.ready?.mapId ?? this.mapId;
  }

  /** Whether a finished map for `mapId` is waiting to be taken. */
  hasReady(mapId: string): boolean {
    return this.ready?.mapId === mapId;
  }

  /**
   * Start building a map in the background.
   *
   * Idempotent for the same map: a duplicate `Prepare` — which a client that reconnects
   * mid-cycle will receive — must not throw away a build that is already half done and start
   * again.
   */
  start(mapId: string): void {
    if (this.mapId === mapId && this.steps !== null) return;
    if (this.ready?.mapId === mapId) return;

    this.cancel();
    const entry = findMap(mapId);
    this.mapId = mapId;
    this.startedMs = performance.now();
    this.workMs = 0;
    this.frames = 0;
    this.chunks = 0;
    this.worstChunkMs = 0;
    this.steps = buildMapChunked(entry.def, this.deps.textures, this.deps.shadowQuality());
    log.info(`background build started: ${entry.name}.`);
  }

  /**
   * Do up to `budgetMs` of work. Call once per rendered frame.
   *
   * Returns the milliseconds actually spent, so the caller's frame-time probe can attribute a
   * spike to the build rather than to the game.
   */
  pump(budgetMs = DEFAULT_BUDGET_MS): number {
    const steps = this.steps;
    if (steps === null) return 0;

    const frameStart = performance.now();
    this.frames++;

    for (;;) {
      const chunkStart = performance.now();
      const step = steps.next();
      const chunkMs = performance.now() - chunkStart;
      this.chunks++;
      this.workMs += chunkMs;
      if (chunkMs > this.worstChunkMs) this.worstChunkMs = chunkMs;

      if (step.done === true) {
        this.finish(step.value);
        break;
      }
      this.lastProgress = step.value;

      // Checked after the chunk, not before. See the class comment.
      if (performance.now() - frameStart >= budgetMs) break;
    }

    return performance.now() - frameStart;
  }

  /**
   * Take the finished map, if it is the one asked for.
   *
   * Handing over ownership: the caller disposes it from here on. Returning null means the
   * build did not finish in time, and the caller's answer to that is §4.18's — show a loading
   * screen and build it synchronously, which is late but correct.
   */
  take(mapId: string): LoadedMap | null {
    const ready = this.ready;
    if (ready === null || ready.mapId !== mapId) return null;
    this.ready = null;
    return ready.built;
  }

  /**
   * Throw away whatever is in flight or waiting.
   *
   * Disposes both, because a `LoadedMap` owns geometries and materials that live on the GPU
   * and a dropped reference would leak them for the life of the page. §4.18 counts exactly
   * this kind of thing as the teardown surface.
   */
  cancel(): void {
    if (this.steps !== null) {
      log.info(`background build for ${this.mapId} cancelled after ${this.chunks} chunk(s).`);
      /**
       * `return()` runs the generator's `finally`, which disposes the partial build.
       *
       * Simply dropping the reference would not: the geometries and materials already created
       * live on the GPU, and nothing on the JS heap being collected frees them. See the
       * `try/finally` in `buildMapChunked`.
       */
      this.steps.return(undefined as unknown as LoadedMap);
      this.steps = null;
    }
    this.ready?.built.dispose();
    this.ready = null;
    this.lastProgress = null;
    this.mapId = '';
  }

  private finish(built: LoadedMap): void {
    const report: BuildReport = {
      mapId: this.mapId,
      elapsedMs: Math.round(performance.now() - this.startedMs),
      workMs: Math.round(this.workMs),
      chunks: this.chunks,
      worstChunkMs: Math.round(this.worstChunkMs * 100) / 100,
      frames: this.frames,
    };
    this.steps = null;
    this.ready = { mapId: this.mapId, built };
    this.lastProgress = null;
    log.info(
      `background build finished: ${this.mapId} in ${report.elapsedMs}ms wall ` +
        `(${report.workMs}ms of work across ${report.chunks} chunks over ${report.frames} frames, ` +
        `worst chunk ${report.worstChunkMs}ms).`,
    );
    this.deps.onComplete(this.mapId, built, report);
  }
}
