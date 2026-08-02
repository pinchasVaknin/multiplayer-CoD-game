import type { FrameStats } from '../debug/FrameStats';

/**
 * The always-on frame-rate read-out (brief S6.3).
 *
 * Deliberately **not** part of the HUD and not part of the debug overlay. The HUD is
 * per-match and is torn down between rounds, and a player who turns on an FPS counter to
 * find out whether the menu is smooth would find it disappears there. The debug overlay is
 * a developer tool behind a function key. This is a player-facing setting, so it is owned
 * by `Game` alongside `FrameStats` and lives for the whole session.
 *
 * It updates at 4 Hz, not per frame. A number that changes sixty times a second is
 * unreadable, and — the reason that matters here — writing to `textContent` every frame is
 * a per-frame DOM write, which is exactly what S6.5 asks the performance pass to hunt down.
 * Four writes a second is free; sixty is a measurable cost for a widget whose entire job is
 * telling you what things cost.
 */

/** Updates per second. */
const REFRESH_HZ = 4;

export class FpsCounter {
  readonly element: HTMLElement;

  private readonly stats: FrameStats;
  private accumulator = 0;
  private visible = false;
  private lastShown = -1;

  constructor(host: HTMLElement, stats: FrameStats) {
    this.stats = stats;
    this.element = document.createElement('div');
    this.element.className = 'op-fps op-num';
    this.element.hidden = true;
    this.element.textContent = '—';
    host.appendChild(this.element);
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.element.hidden = !on;
    this.lastShown = -1;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Called once per frame with the real frame delta. Does nothing while hidden. */
  update(dt: number): void {
    if (!this.visible) return;
    this.accumulator += dt;
    if (this.accumulator < 1 / REFRESH_HZ) return;
    this.accumulator = 0;

    const fps = Math.round(this.stats.fps);
    // Guarded because an unchanged number is still a layout invalidation if written.
    if (fps === this.lastShown) return;
    this.lastShown = fps;
    this.element.textContent = `${fps} FPS`;
    // Three bands rather than a gradient: the question a player is asking is "is this
    // smooth", and that has three answers.
    this.element.classList.toggle('op-fps--good', fps >= 58);
    this.element.classList.toggle('op-fps--fair', fps >= 40 && fps < 58);
    this.element.classList.toggle('op-fps--poor', fps < 40);
  }

  dispose(): void {
    this.element.remove();
  }
}
