import type { CameraRig } from '../engine/CameraRig';
import type { ProceduralAudio } from '../engine/ProceduralAudio';
import type { Renderer } from '../engine/Renderer';
import { EV, type GameBus } from '../core/Events';
import type { Loop } from '../core/Loop';
import {
  CAMERA_CONFIG_KEYS,
  CAMERA_TUNABLES,
  DEFAULT_CAMERA_CONFIG,
  cameraConfigToSource,
  type CameraConfig,
} from '../player/CameraConfig';
import {
  DEFAULT_MOVEMENT_CONFIG,
  MOVEMENT_CONFIG_KEYS,
  MOVEMENT_TUNABLES,
  movementConfigToSource,
  type MovementConfig,
} from '../player/MovementConfig';
import type { PlayerController } from '../player/PlayerController';
import type { MapStats } from '../world/MapLoader';
import type { CollisionDebug } from './CollisionDebug';
import { FrameStats } from './FrameStats';
import { Speedometer } from './Speedometer';
import { makeTuningGroup, TuningPanel, type TuningGroup } from './TuningPanel';

/**
 * The F1 debug overlay (brief S6).
 *
 * Sections are containers that later milestones add panels to: `addSection` returns a
 * handle, and `addField` hangs a labelled readout off it. M2 onward should extend this
 * rather than building a second overlay. See DEBUG.md.
 *
 * Text is refreshed at 15 Hz and the histogram at 5 Hz. Updating readouts every frame
 * would have the overlay measurably perturbing the frame times it is there to report.
 */

const TEXT_HZ = 15;
const GRAPH_HZ = 5;

export interface DebugContext {
  bus: GameBus;
  loop: Loop;
  renderer: Renderer;
  player: PlayerController;
  cameraRig: CameraRig;
  collisionDebug: CollisionDebug;
  audio: ProceduralAudio;
  movementConfig: MovementConfig;
  cameraConfig: CameraConfig;
  mapStats: MapStats;
  /**
   * Owned by `Game` from M4, not by the overlay.
   *
   * The overlay is built and destroyed with each match; the frame-time history is not, because
   * the three-match heap run needs one continuous buffer across the boundaries it measures.
   */
  stats: FrameStats;
  speedo: Speedometer;
  onConfigChanged: () => void;
}

interface Field {
  el: HTMLElement;
  last: string;
}

export class DebugSection {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;

  constructor(title: string) {
    this.element = document.createElement('section');
    this.element.className = 'dbg-section';
    const head = document.createElement('div');
    head.className = 'dbg-section__title op-label';
    head.textContent = title;
    this.body = document.createElement('div');
    this.body.className = 'dbg-section__body';
    this.element.append(head, this.body);
  }

  addField(label: string): Field {
    const row = document.createElement('div');
    row.className = 'dbg-row';
    const name = document.createElement('span');
    name.className = 'dbg-row__label';
    name.textContent = label;
    const value = document.createElement('span');
    value.className = 'dbg-row__value op-num';
    value.textContent = '-';
    row.append(name, value);
    this.body.appendChild(row);
    return { el: value, last: '' };
  }

  addNode(node: HTMLElement): void {
    this.body.appendChild(node);
  }
}

export class DebugOverlay {
  readonly stats: FrameStats;
  readonly speedo: Speedometer;

  private readonly root: HTMLElement;
  private readonly ctx: DebugContext;
  private readonly sections: DebugSection[] = [];
  private readonly panels: TuningPanel[] = [];
  private readonly unsubscribe: Array<() => void> = [];
  private readonly textHooks: Array<() => void> = [];
  private readonly graphHooks: Array<() => void> = [];
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly canvasCtx: CanvasRenderingContext2D;

  private visible = false;
  private textAccumulator = 0;
  private graphAccumulator = 0;

  // Perf fields
  private fFps: Field;
  private fFrame: Field;
  private fSim: Field;
  private fRender: Field;
  private fSteps: Field;
  private fPercentiles: Field;
  private fWorst: Field;
  private fDraws: Field;
  private fBudget: Field;
  private fBreakdown: Field;
  private fStreaks: Field;

  // Player fields
  private fPos: Field;
  private fVel: Field;
  private fSpeed: Field;
  private fStance: Field;
  private fGrounded: Field;
  private fCapsule: Field;
  private fTac: Field;
  private fSlide: Field;
  private fCooldowns: Field;
  private fCaps: Field;
  private fFlags: Field;

  // Measurement fields
  private fInstant: Field;
  private fSustained: Field;
  private fPeaks: Field;

  constructor(host: HTMLElement, ctx: DebugContext) {
    this.ctx = ctx;
    this.stats = ctx.stats;
    this.speedo = ctx.speedo;

    this.root = document.createElement('div');
    this.root.className = 'dbg-root';
    this.root.hidden = true;

    const header = document.createElement('div');
    header.className = 'dbg-header';
    const headTitle = document.createElement('span');
    headTitle.className = 'dbg-header__title';
    headTitle.textContent = 'OPERATOR · DEBUG';
    const headHint = document.createElement('span');
    headHint.className = 'dbg-header__hint op-label';
    headHint.textContent = 'F2 collision · F3 reset stats · Esc close';
    // The M5 playtest asked for an explicit way out that is not a function key.
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dbg-close';
    close.setAttribute('aria-label', 'Close the debug overlay');
    close.textContent = '×';
    close.addEventListener('click', () => this.setVisible(false));
    header.append(headTitle, headHint, close);
    this.root.appendChild(header);

    const columns = document.createElement('div');
    columns.className = 'dbg-columns';
    this.root.appendChild(columns);

    const left = document.createElement('div');
    left.className = 'dbg-col';
    const right = document.createElement('div');
    right.className = 'dbg-col dbg-col--wide';
    columns.append(left, right);
    this.left = left;
    this.right = right;

    // ---- PERF ------------------------------------------------------------
    const perf = this.section('Performance', left);
    this.fFps = perf.addField('FPS');
    this.fFrame = perf.addField('Frame');
    this.fSim = perf.addField('Sim');
    this.fRender = perf.addField('Render');
    this.fSteps = perf.addField('Sim steps');
    this.fPercentiles = perf.addField('p50 / p95 / p99');
    this.fWorst = perf.addField('Worst / mean');
    this.fBudget = perf.addField('Over 16.7ms');
    this.fDraws = perf.addField('Draws / tris');
    this.fBreakdown = perf.addField('Mode / HUD ms');
    // M7 (S7): streak-entity cost and how many are alive.
    this.fStreaks = perf.addField('Streak ms / count');

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dbg-graph';
    this.canvas.width = 300;
    this.canvas.height = 76;
    const c2d = this.canvas.getContext('2d');
    if (c2d === null) throw new Error('Debug overlay needs a 2D context');
    this.canvasCtx = c2d;
    perf.addNode(this.canvas);

    const mapLine = perf.addField('Map');
    mapLine.el.textContent = `${ctx.mapStats.colliders} col · ${ctx.mapStats.hashCells} cells · AO ${ctx.mapStats.aoMs.toFixed(0)}ms`;

    // ---- PLAYER ----------------------------------------------------------
    const player = this.section('Player', left);
    this.fPos = player.addField('Position');
    this.fVel = player.addField('Velocity');
    this.fSpeed = player.addField('Speed');
    this.fStance = player.addField('Stance');
    this.fGrounded = player.addField('Grounded');
    this.fCapsule = player.addField('Capsule / eye');
    this.fTac = player.addField('Tac sprint');
    this.fSlide = player.addField('Slide');
    this.fCooldowns = player.addField('Cooldowns');
    this.fCaps = player.addField('Speed cap / air');
    this.fFlags = player.addField('Flags');

    // ---- MEASUREMENT -----------------------------------------------------
    const measure = this.section('Measurement', left);
    this.fInstant = measure.addField('Speed (0.25s)');
    this.fSustained = measure.addField('Speed (1.0s)');
    this.fPeaks = measure.addField('Peak inst / sust (±1 tick)');
    measure.addNode(
      this.button('Reset measurement', () => {
        this.speedo.reset();
      }),
    );

    const loadRow = document.createElement('label');
    loadRow.className = 'dbg-slider';
    const loadLabel = document.createElement('span');
    loadLabel.className = 'dbg-slider__label';
    loadLabel.textContent = 'Synthetic load';
    const loadInput = document.createElement('input');
    loadInput.type = 'range';
    loadInput.min = '0';
    loadInput.max = '60';
    loadInput.step = '1';
    loadInput.value = '0';
    loadInput.className = 'dbg-slider__input';
    const loadValue = document.createElement('span');
    loadValue.className = 'dbg-slider__value op-num';
    loadValue.textContent = '0ms';
    loadInput.addEventListener('input', () => {
      const ms = Number.parseFloat(loadInput.value);
      ctx.loop.syntheticLoadMs = Number.isFinite(ms) ? ms : 0;
      loadValue.textContent = `${loadInput.value}ms`;
    });
    loadRow.append(loadLabel, loadInput, loadValue);
    measure.addNode(loadRow);

    // ---- TOOLS -----------------------------------------------------------
    const tools = this.section('Tools', left);
    tools.addNode(
      this.toggle('Collision visualisation', false, (on) => {
        ctx.collisionDebug.setEnabled(on);
      }),
    );
    tools.addNode(
      this.button('Reset frame stats', () => {
        this.stats.reset();
      }),
    );

    // ---- TUNING ----------------------------------------------------------
    const movementGroup = makeTuningGroup(
      'Movement config',
      ctx.movementConfig,
      MOVEMENT_TUNABLES,
      MOVEMENT_CONFIG_KEYS,
      DEFAULT_MOVEMENT_CONFIG,
      movementConfigToSource,
    );
    const cameraGroup = makeTuningGroup(
      'Camera config',
      ctx.cameraConfig,
      CAMERA_TUNABLES,
      CAMERA_CONFIG_KEYS,
      DEFAULT_CAMERA_CONFIG,
      cameraConfigToSource,
    );
    for (const group of [movementGroup, cameraGroup]) {
      const panel = new TuningPanel(group, ctx.onConfigChanged);
      this.panels.push(panel);
      right.appendChild(panel.element);
    }

    // A spawn teleports the player. Integrating that jump as distance travelled would
    // put a 90 m/s peak in the measurement panel and make the whole readout useless.
    //
    // The unsubscribe is retained from M4: the overlay is built and destroyed with each match,
    // and a subscription that outlives it keeps the whole overlay — and through `ctx`, the
    // player, the collision world and the map's stats — alive for the life of the page. This
    // was one of two leaks the multi-match heap run found.
    this.unsubscribe.push(ctx.bus.on(EV.PlayerSpawned, () => this.speedo.reset()));

    host.appendChild(this.root);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** Extension point for later milestones. */
  section(title: string, column?: HTMLElement): DebugSection {
    const s = new DebugSection(title);
    this.sections.push(s);
    if (column !== undefined) column.appendChild(s.element);
    return s;
  }

  /** Left column: read-outs. Right column: tuning. Both are extension points. */
  get leftColumn(): HTMLElement {
    return this.left;
  }

  get rightColumn(): HTMLElement {
    return this.right;
  }

  /** Attach another generated slider set. Refreshed with the rest on open. */
  addTuningGroup(group: TuningGroup, onChange: () => void): TuningPanel {
    const panel = new TuningPanel(group, onChange);
    this.panels.push(panel);
    this.right.appendChild(panel.element);
    return panel;
  }

  /**
   * Extensions register here rather than running their own timers. Text hooks fire at
   * 15 Hz and canvas hooks at 5 Hz, which is the whole reason the overlay does not show
   * up in the frame times it exists to report.
   */
  addTextHook(fn: () => void): void {
    this.textHooks.push(fn);
  }

  addGraphHook(fn: () => void): void {
    this.graphHooks.push(fn);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.hidden = !on;
    if (on) this.for(this.panels, (p) => p.refresh());
  }

  /** Feed the loop's frame sample. Cheap; safe to call while hidden. */
  recordFrame(frameMs: number, simMs: number, renderMs: number, steps: number, starved: boolean): void {
    this.stats.push(frameMs, simMs, renderMs, steps, starved);
  }

  /** Called once per rendered frame after the sim has advanced. */
  update(dt: number): void {
    const sim = this.ctx.player.sim;
    this.speedo.sample(sim.x, sim.z, performance.now());
    if (!this.visible) return;

    this.textAccumulator += dt;
    this.graphAccumulator += dt;

    if (this.textAccumulator >= 1 / TEXT_HZ) {
      this.textAccumulator = 0;
      this.stats.recompute();
      this.refreshText();
    }
    if (this.graphAccumulator >= 1 / GRAPH_HZ) {
      this.graphAccumulator = 0;
      this.stats.draw(this.canvasCtx, this.canvas.width, this.canvas.height, {
        background: '#0c0e11',
        trace: '#8fa6c4',
        sim: 'rgba(255,179,64,0.30)',
        budget: '#262b33',
        p99: '#ffb340',
      });
      for (const fn of this.graphHooks) fn();
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  // -- internals -----------------------------------------------------------

  private refreshText(): void {
    const { stats, ctx } = this;
    const sim = ctx.player.sim;
    const info = ctx.renderer.info;

    set(this.fFps, stats.fps.toFixed(0));
    set(this.fFrame, `${stats.lastFrameMs.toFixed(2)} ms`);
    set(this.fSim, `${stats.lastSimMs.toFixed(2)} ms`);
    set(this.fRender, `${stats.lastRenderMs.toFixed(2)} ms`);
    set(this.fSteps, `${stats.lastSteps} (starved ${stats.starvedFrames})`);
    set(
      this.fPercentiles,
      `${stats.p50.toFixed(2)} / ${stats.p95.toFixed(2)} / ${stats.p99.toFixed(2)} ms`,
    );
    set(this.fWorst, `${stats.worst.toFixed(2)} / ${stats.mean.toFixed(2)} ms`);
    set(this.fBudget, `${stats.overBudget} / ${stats.sampleCount}`);
    set(this.fDraws, `${info.render.calls} / ${info.render.triangles}`);
    set(
      this.fBreakdown,
      `${stats.lastModeMs.toFixed(3)} / ${stats.lastHudMs.toFixed(2)} ` +
        `(peak ${stats.peakModeMs.toFixed(2)} / ${stats.peakHudMs.toFixed(2)})`,
    );

    set(
      this.fStreaks,
      `${stats.lastStreakMs.toFixed(3)} ms / ${stats.lastStreakCount} ` +
        `(peak ${stats.peakStreakMs.toFixed(2)} ms / ${stats.peakStreakCount})`,
    );

    set(this.fPos, `${sim.x.toFixed(2)} ${sim.y.toFixed(2)} ${sim.z.toFixed(2)}`);
    set(this.fVel, `${sim.vx.toFixed(2)} ${sim.vy.toFixed(2)} ${sim.vz.toFixed(2)}`);
    set(this.fSpeed, `${sim.speed.toFixed(2)} m/s`);
    set(this.fStance, sim.stance);
    set(this.fGrounded, sim.grounded ? `yes  n.y ${sim.groundNy.toFixed(3)}` : 'no');
    set(this.fCapsule, `${sim.capsuleHeight.toFixed(2)} / ${sim.eyeHeight.toFixed(2)} m`);
    set(
      this.fTac,
      sim.tacSprintActive
        ? `active ${sim.tacSprintElapsed.toFixed(2)}s`
        : `off (cd ${sim.tacSprintCooldown.toFixed(2)}s, lock ${sim.tacLockout.toFixed(2)}s)`,
    );
    set(
      this.fSlide,
      sim.slideActive
        ? `active ${sim.slideElapsed.toFixed(2)}s @ ${sim.slideSpeed.toFixed(2)} m/s`
        : `off (cd ${sim.slideCooldown.toFixed(2)}s)`,
    );
    set(
      this.fCooldowns,
      `sprintHeld ${sim.sprintHeldTime.toFixed(2)}s  coyote ${sim.coyote.toFixed(2)}s  buf ${sim.jumpBuffer.toFixed(2)}s`,
    );
    set(
      this.fCaps,
      `${ctx.player.currentSpeedCap.toFixed(2)} / ${sim.airSpeedCap.toFixed(2)} m/s  fov ${ctx.cameraRig.fov.toFixed(1)}`,
    );
    set(
      this.fFlags,
      `${sim.blockedHorizontally ? 'blocked ' : ''}${sim.steppedUp ? 'step ' : ''}` +
        `${sim.mantleActive ? 'mantle ' : ''}${ctx.audio.isRunning ? `voices ${ctx.audio.voiceCount}` : 'audio off'}`,
    );

    set(this.fInstant, `${this.speedo.instant.toFixed(3)} m/s`);
    set(this.fSustained, `${this.speedo.sustained.toFixed(3)} m/s`);
    set(
      this.fPeaks,
      `${this.speedo.instantPeak.toFixed(3)} / ${this.speedo.sustainedPeak.toFixed(3)} m/s`,
    );

    for (const fn of this.textHooks) fn();
  }

  private button(label: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dbg-btn dbg-btn--block';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private toggle(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'dbg-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    const text = document.createElement('span');
    text.textContent = label;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, text);
    return wrap;
  }

  private for<T>(items: readonly T[], fn: (item: T) => void): void {
    for (const item of items) fn(item);
  }

  /**
   * F2 and F3 only (M6, from the M5 playtest notes).
   *
   * **F1 is deliberately not bound any more.** The overlay is a large interactive panel and
   * opening it mid-match put focus-stealing controls under the crosshair; the playtest
   * asked for it to be reachable from the pause menu instead, and it is — along with the
   * close button in its own header. The two visualisation keys stay because they toggle
   * *drawing* rather than opening a panel, and neither takes focus.
   *
   * `Escape` is handled here too, and only while the overlay is open: it closes the
   * overlay and stops there, so Esc-with-the-panel-open no longer unpauses the game
   * underneath it. That was the last item on the M5 list.
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      // Handled by `Game.onEscape`, which owns the Esc stack: `Input`'s listener is
      // registered first and would run before anything this file could stop.
      return;
    }
    if (e.code === 'F2') {
      e.preventDefault();
      const next = !this.ctx.collisionDebug.isEnabled;
      this.ctx.collisionDebug.setEnabled(next);
      const box = this.root.querySelector<HTMLInputElement>('.dbg-toggle input');
      if (box !== null) box.checked = next;
    } else if (e.code === 'F3') {
      e.preventDefault();
      this.stats.reset();
      this.speedo.reset();
    }
  };
}

function set(field: Field, text: string): void {
  if (field.last === text) return;
  field.last = text;
  field.el.textContent = text;
}
