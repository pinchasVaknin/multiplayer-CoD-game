import { findMap } from '../../shared/modes/ModeRegistry';
import type { MapBuildProgress } from '../world/MapRender';

/**
 * The fallback for a client that missed the readiness timeout (M11, §4.18, §6.5).
 *
 * §4.18: *"A client that has not reported ready when the timeout expires is migrated anyway and
 * **shows its own loading screen** until it finishes. A server that waits indefinitely on one
 * slow client is a server that is stuck."*
 *
 * ## This is the path the design exists to avoid, and it still has to work
 *
 * Everything about §6.5 is arranged so this never appears: the map is built during warmup, a
 * chunk at a time, and adopted at the transition. It appears when that did not finish — an
 * unusually slow machine, a tab that was in the background and had its `requestAnimationFrame`
 * throttled to nothing, or a `Prepare` that was missed because the player connected mid-cycle.
 *
 * The alternative to a screen is not "no screen": it is a **frozen frame**. Building a map
 * synchronously takes long enough to be a visible hang, and a hang with the previous world
 * still painted on it looks exactly like the game having crashed. So the screen goes up first,
 * the browser is given a frame to paint it, and only then does the build run.
 *
 * ## It does not lie about progress
 *
 * The bar is driven by the real chunk count out of `buildMapChunked`, not by a timer. A
 * progress bar that is a `setInterval` is worse than no bar, because it keeps moving when the
 * thing it claims to describe has stopped.
 */

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly fill: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'op-loading';
    this.root.hidden = true;

    this.title = document.createElement('h2');
    this.title.className = 'op-loading__title';

    this.detail = document.createElement('p');
    this.detail.className = 'op-loading__detail';

    const track = document.createElement('div');
    track.className = 'op-loading__track';
    this.fill = document.createElement('div');
    this.fill.className = 'op-loading__fill';
    track.appendChild(this.fill);

    this.root.append(this.title, track, this.detail);
    host.appendChild(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /**
   * Put the screen up for a map that is about to be built.
   *
   * The caller must give the browser a frame to paint before it starts building — see
   * `Game.servicePendingTransitions`. Showing and building in the same task paints nothing.
   */
  show(mapId: string): void {
    this.title.textContent = mapNameOf(mapId);
    this.detail.textContent = 'BUILDING THE MAP — THE MATCH HAS ALREADY STARTED';
    this.fill.style.width = '0%';
    this.root.hidden = false;
  }

  /** Advance the bar from real chunk counts. Safe to call with null. */
  update(progress: MapBuildProgress | null): void {
    if (progress === null || progress.total <= 0) return;
    const pct = Math.min(100, Math.round((progress.done / progress.total) * 100));
    this.fill.style.width = `${pct}%`;
  }

  hide(): void {
    this.root.hidden = true;
  }

  dispose(): void {
    this.root.remove();
  }
}

function mapNameOf(mapId: string): string {
  try {
    return findMap(mapId).name;
  } catch {
    return mapId;
  }
}
