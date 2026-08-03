import type { Game } from '../Game';
import { Btn, type MutableInputCommand } from '../../shared/core/InputCommand';
import { DT } from '../../shared/core/Loop';
import type { Loop } from '../engine/FrameLoop';
import type { FrameStats } from './FrameStats';
import { HISTORY_LENGTH } from './FrameStats';
import type { MatchHarness } from './MatchHarness';

/**
 * The four measurements the human runs, in one export format (brief S6.5, S7).
 *
 * S6.5 splits the performance pass in two: what this build does, and what it *hands over*
 * because it cannot be answered on the wrong hardware. This file is the second half, and
 * the brief's requirement is specific — *"make each a single click or URL flag and document
 * it in DEBUG.md"*. So each is one call on `window.__operator`, each returns a plain object,
 * and each of those objects has the same envelope:
 *
 * ```
 * { tool, at, build, hardware, ...payload }
 * ```
 *
 * The envelope is the part that makes the export worth having a month later. A frame-time
 * histogram with no record of the render scale, the shadow tier, the map or the device
 * pixel ratio is a number nobody can act on, and "p99 was 31 ms" pasted into an issue is
 * indistinguishable from noise unless it says what it was 31 ms *of*.
 *
 * ## What is deliberately absent
 *
 * No claim about targets. S6.5 is explicit that the 60 FPS, sub-two-frame and ten-match
 * numbers cannot be verified from here, so nothing in this file compares a measurement to a
 * target or prints a pass. It reports, and the human judges.
 */

export interface ExportEnvelope {
  /** Which tool produced this. */
  tool: string;
  /** ISO timestamp, so two exports can be ordered. */
  at: string;
  /** What was on screen when it was taken. */
  context: RunContext;
}

export interface RunContext {
  map: string;
  mode: string;
  state: string;
  bots: number;
  renderScale: number;
  shadowQuality: string;
  motionBlur: boolean;
  /** Backing-buffer pixels per CSS pixel, after the render-scale multiply. */
  pixelRatio: number;
  viewport: string;
  /** `navigator.hardwareConcurrency`, when the browser reports it. */
  cores: number;
  userAgent: string;
}

export interface FrameExport extends ExportEnvelope {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  mean: number;
  /** Frames over 16.7 ms, as a count and a percentage of the buffer. */
  overBudget: number;
  overBudgetPercent: number;
  /** Frames where the 5-step catch-up cap was hit and a backlog was discarded. */
  starved: number;
  /** Sub-costs carved out of the totals above, in milliseconds. */
  peaks: { mode: number; hud: number; streaks: number };
  /** The whole rolling buffer, oldest first, so the human can plot it. */
  frameMs: number[];
}

export interface LatencyExport extends ExportEnvelope {
  samples: number;
  dropped: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
  meanMs: number;
  /** The same numbers in frames, which is what is actually actionable. */
  p50Frames: number;
  p99Frames: number;
  /** Excludes the compositor; see `LatencyProbe`. */
  caveat: string;
}

export interface RenderScaleRow {
  renderScale: number;
  pixelRatio: number;
  /** Backing-buffer pixels, which is the number that actually drives fill cost. */
  backingPixels: number;
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
}

export interface AllocationExport extends ExportEnvelope {
  ticks: number;
  simSeconds: number;
  /** The empty-loop control must be exactly flat, or the reading is noise. */
  controlFlat: boolean;
  controlRiseMB: number;
  controlSeriesMB: number[];
  simRiseMB: number;
  /** The shape is the answer: flat, sawtooth or staircase. See `allocationProbe`. */
  simSeriesMB: number[];
  bytesPerTick: number;
  note: string;
}

export interface RenderSweepExport extends ExportEnvelope {
  secondsPerStep: number;
  rows: RenderScaleRow[];
  restoredTo: number;
}

/** Render scales the sweep walks. 0.5 is the floor `Renderer.setSize` clamps to. */
const SWEEP_SCALES = [1, 0.9, 0.8, 0.7, 0.6, 0.5] as const;

/**
 * Seconds spent at each render scale.
 *
 * Long enough to fill a meaningful part of the 600-frame buffer at any frame rate the
 * setting is worth trying, and short enough that the whole sweep is under half a minute —
 * a tool nobody waits for is a tool nobody runs.
 */
const SWEEP_SECONDS = 4;

export interface HandoverDeps {
  readonly game: Game;
  readonly loop: Loop;
  readonly stats: FrameStats;
  readonly matchHarness: MatchHarness;
}

export class Handover {
  private readonly deps: HandoverDeps;

  constructor(deps: HandoverDeps) {
    this.deps = deps;
  }

  /**
   * Frame-time percentiles and the whole rolling buffer, as JSON (S6.5).
   *
   * Recomputed before reading, so the numbers describe the buffer as it is now rather than
   * whenever something last happened to call `recompute`.
   */
  frameReport(): FrameExport {
    const stats = this.deps.stats;
    stats.recompute();
    const n = stats.sampleCount;
    return {
      tool: 'frame-histogram',
      at: new Date().toISOString(),
      context: this.context(),
      samples: n,
      p50: round(stats.p50),
      p95: round(stats.p95),
      p99: round(stats.p99),
      worst: round(stats.worst),
      mean: round(stats.mean),
      overBudget: stats.overBudget,
      overBudgetPercent: n === 0 ? 0 : round((stats.overBudget / n) * 100),
      starved: stats.starvedFrames,
      peaks: {
        mode: round(stats.peakModeMs),
        hud: round(stats.peakHudMs),
        streaks: round(stats.peakStreakMs),
      },
      frameMs: stats.snapshot().map(round),
    };
  }

  /** Input latency, in milliseconds and in frames (S6.5). */
  latencyReport(): LatencyExport | null {
    const probe = this.deps.game.activeMatch?.latency;
    if (probe === undefined) return null;
    probe.recompute();
    const frame = 1000 / 60;
    return {
      tool: 'input-latency',
      at: new Date().toISOString(),
      context: this.context(),
      samples: probe.count,
      dropped: probe.dropped,
      p50Ms: round(probe.p50),
      p95Ms: round(probe.p95),
      p99Ms: round(probe.p99),
      worstMs: round(probe.worst),
      meanMs: round(probe.mean),
      p50Frames: round(probe.p50 / frame),
      p99Frames: round(probe.p99 / frame),
      caveat:
        'mousedown to the end of the render callback that drew the shot. A page cannot ' +
        'observe when its pixels reach the panel, so one further frame of compositing sits ' +
        'on top of every number here.',
    };
  }

  /**
   * Walk every render scale, holding each for `SWEEP_SECONDS`, and report the percentiles
   * at each (S6.5).
   *
   * The point of this tool is finding the setting that fits a machine this build has never
   * run on, so it changes exactly one variable and restores what it found. It refuses to
   * run outside a match, because percentiles taken over an empty menu describe nothing.
   */
  async renderScaleSweep(secondsPerStep = SWEEP_SECONDS): Promise<RenderSweepExport | null> {
    const game = this.deps.game;
    if (game.currentState !== 'MATCH') {
      console.warn('[Handover] renderScaleSweep needs a live match; start one first.');
      return null;
    }
    const restore = game.profile.settings.renderScale;
    const rows: RenderScaleRow[] = [];

    for (const scale of SWEEP_SCALES) {
      game.applySettings({ renderScale: scale });
      // A frame or two at the new size is not the new size settling; clear and re-fill.
      this.deps.stats.reset();
      await delay(secondsPerStep * 1000);
      this.deps.stats.recompute();
      const ratio = game.rendererPixelRatio;
      rows.push({
        renderScale: scale,
        pixelRatio: round(ratio),
        backingPixels: Math.round(window.innerWidth * ratio * window.innerHeight * ratio),
        samples: this.deps.stats.sampleCount,
        p50: round(this.deps.stats.p50),
        p95: round(this.deps.stats.p95),
        p99: round(this.deps.stats.p99),
        worst: round(this.deps.stats.worst),
      });
      console.info(
        `[Handover] render scale ${scale.toFixed(2)} → p50 ${this.deps.stats.p50.toFixed(1)} / ` +
          `p95 ${this.deps.stats.p95.toFixed(1)} / p99 ${this.deps.stats.p99.toFixed(1)} ms`,
      );
    }

    game.applySettings({ renderScale: restore });
    const out: RenderSweepExport = {
      tool: 'render-scale-sweep',
      at: new Date().toISOString(),
      context: this.context(),
      secondsPerStep,
      rows,
      restoredTo: restore,
    };
    console.table(rows);
    return out;
  }

  /**
   * Drive the per-tick sim path N times and watch the heap (S8, criterion 7).
   *
   * ## Why this is not simply "read `usedJSHeapSize` before and after"
   *
   * Because that does not work, and finding out *why* is most of what this tool is. Chrome
   * updates `performance.memory.usedJSHeapSize` in very coarse steps: a calibration run on
   * this build saw **no movement at all** for a million small objects allocated in a row,
   * and then a 49 MB jump. A naive before/after over ten thousand ticks therefore reports
   * zero for a path that allocates, which is the worst possible failure mode for a tool
   * whose entire job is answering "does this allocate".
   *
   * Two things make the reading trustworthy:
   *
   * **A control.** An empty loop of the same shape is measured first. It must come back
   * exactly flat, and if it does not the run is noise and says so. That is the check that
   * caught the naive version.
   *
   * **Enough ticks to cross the granularity.** At `ticks` = 300,000 — eighty-three minutes
   * of simulated play — a single 32-byte object per tick is about 9 MB, which is well
   * inside what the counter resolves. Below roughly 4 bytes/tick the result is noise and
   * should be read as "under the floor" rather than as zero.
   *
   * The series is returned rather than just the delta, because the *shape* is the answer: a
   * flat line is no allocation, a sawtooth that returns to its start is garbage being
   * collected as fast as it is made, and a staircase that never comes down is a leak.
   */
  async allocationProbe(ticks = 300000): Promise<AllocationExport | null> {
    const game = this.deps.game;
    const player = game.player;
    const match = game.activeMatch;
    if (player === null || match === null) {
      console.warn('[Handover] allocationProbe needs a live match; start one first.');
      return null;
    }

    const wasRunning = this.deps.loop.isRunning;
    this.deps.loop.stop();

    const cmd: MutableInputCommand = {
      seq: 0,
      tickIndex: 0,
      moveX: 0.7,
      moveZ: 0.7,
      yaw: 0.3,
      pitch: 0.05,
      buttons: 0,
      sampledAtMs: 0,
    };
    // Warm up: every lazily-built pool, cache and JIT tier has to have happened already, or
    // the first thousand ticks measure the engine waking up rather than the sim running.
    let tick = 0;
    for (let i = 0; i < 5000; i++) {
      cmd.seq++;
      cmd.tickIndex = tick++;
      player.step(cmd);
      match.simulate(cmd);
    }

    const steps = 10;
    const perStep = Math.max(1, Math.floor(ticks / steps));

    const control = await this.heapSeries(steps, () => {
      let sum = 0;
      for (let i = 0; i < perStep; i++) sum += i;
      if (sum < 0) console.info(sum);
    });

    const sim = await this.heapSeries(steps, () => {
      for (let i = 0; i < perStep; i++) {
        cmd.seq++;
        cmd.tickIndex = tick++;
        // Vary the input so branches are exercised rather than one path staying hot.
        cmd.moveX = Math.sin(tick * 0.01);
        cmd.moveZ = Math.cos(tick * 0.013);
        cmd.buttons = tick % 120 < 40 ? Btn.Sprint : tick % 120 < 60 ? Btn.Fire : 0;
        player.step(cmd);
        match.simulate(cmd);
      }
    });

    if (wasRunning) this.deps.loop.start();

    const measured = steps * perStep;
    const riseMB = (sim[sim.length - 1] ?? 0) - (sim[0] ?? 0);
    const controlRise = (control[control.length - 1] ?? 0) - (control[0] ?? 0);
    const out: AllocationExport = {
      tool: 'allocation-probe',
      at: new Date().toISOString(),
      context: this.context(),
      ticks: measured,
      simSeconds: round(measured * DT),
      controlFlat: controlRise === 0,
      controlRiseMB: round(controlRise),
      controlSeriesMB: control,
      simRiseMB: round(riseMB),
      simSeriesMB: sim,
      bytesPerTick: round((riseMB * 1048576) / measured),
      note:
        'usedJSHeapSize is coarse: a calibration on this build showed no movement for ' +
        '300,000 small objects. Read anything under ~4 bytes/tick as below the floor, and ' +
        'take a DevTools allocation-instrumentation recording for a per-call-site answer.',
    };
    console.info(
      `[Handover] allocation probe: ${measured} ticks, control ${out.controlFlat ? 'flat' : 'NOISY'}, ` +
        `sim ${out.simRiseMB.toFixed(2)} MB (${out.bytesPerTick.toFixed(1)} bytes/tick).`,
    );
    return out;
  }

  /** Run `work` `steps` times, sampling a settled heap before and after each. */
  private async heapSeries(steps: number, work: () => void): Promise<number[]> {
    provokeCollection();
    await delay(700);
    const series: number[] = [];
    for (let i = 0; i < steps; i++) {
      work();
      series.push(round(heapMB()));
    }
    return series;
  }

  /**
   * Everything at once, for pasting into an issue.
   *
   * The heap run is not included: it takes minutes and destroys the match it is called
   * from, so it stays an explicit `runMatches(n)`.
   */
  fullReport(): { frames: FrameExport; latency: LatencyExport | null; matches: unknown } {
    return {
      frames: this.frameReport(),
      latency: this.latencyReport(),
      matches: this.deps.matchHarness.report(),
    };
  }

  /**
   * Copy a report to the clipboard as JSON.
   *
   * "A single click" in S6.5 means the human should not have to expand a console object and
   * right-click it. Falls back to logging the string when the clipboard is unavailable,
   * which it is on an insecure origin.
   */
  async copy(report: unknown): Promise<boolean> {
    const text = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      console.info('[Handover] report copied to the clipboard.');
      return true;
    } catch {
      console.info('[Handover] clipboard unavailable; the JSON follows.');
      console.info(text);
      return false;
    }
  }

  /** What was on screen when a measurement was taken. */
  private context(): RunContext {
    const game = this.deps.game;
    const s = game.profile.settings;
    const match = game.activeMatch;
    return {
      map: game.map?.def.id ?? '(none)',
      mode: match?.mode.name ?? '(none)',
      state: game.currentState,
      bots: match?.bots.botCount ?? 0,
      renderScale: s.renderScale,
      shadowQuality: s.shadowQuality,
      motionBlur: s.motionBlur,
      pixelRatio: round(game.rendererPixelRatio),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      cores: navigator.hardwareConcurrency ?? 0,
      userAgent: navigator.userAgent,
    };
  }
}

function round(v: number): number {
  return Number(v.toFixed(3));
}

/**
 * `performance.memory` is a non-standard Chrome extension and is the only heap number a
 * page gets. Absent elsewhere, hence the guard rather than a type assertion.
 */
function heapMB(): number {
  const perf: unknown = performance;
  if (typeof perf !== 'object' || perf === null || !('memory' in perf)) return -1;
  const memory: unknown = (perf as { memory: unknown }).memory;
  if (typeof memory !== 'object' || memory === null || !('usedJSHeapSize' in memory)) return -1;
  const used: unknown = (memory as { usedJSHeapSize: unknown }).usedJSHeapSize;
  return typeof used === 'number' ? used / 1048576 : -1;
}

/**
 * Provoke a collection so a series starts from a settled heap.
 *
 * `window.gc` where it exists (`--js-flags=--expose-gc`); otherwise allocate and drop a few
 * tens of megabytes, which is what actually makes V8 collect. Same technique `MatchHarness`
 * uses, and for the same reason.
 */
function provokeCollection(): void {
  const candidate: unknown = (window as unknown as { gc?: unknown }).gc;
  if (typeof candidate === 'function') {
    (candidate as () => void)();
    return;
  }
  let sink: Uint8Array | null = null;
  for (let i = 0; i < 64; i++) {
    sink = new Uint8Array(1048576);
    sink[i] = i & 0xff;
  }
  sink = null;
  void sink;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Exported so `DEBUG.md`'s worked example can quote the real numbers. */
export const HANDOVER_CONSTANTS = { SWEEP_SCALES, SWEEP_SECONDS, HISTORY_LENGTH, DT };
