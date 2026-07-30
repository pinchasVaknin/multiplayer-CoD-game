import type { Game } from '../Game';
import { DT, type Loop } from '../core/Loop';
import type { FrameStats } from './FrameStats';

/**
 * Back-to-back matches with teardown between them (brief S7 — REQUIRED).
 *
 * The M3 harness proved a *firefight* does not leak. This proves a **match** does not, which
 * is a different question: M4 builds and destroys the map, the navmesh, the collision hash,
 * every mesh and material, the bot roster, the HUD, the scoreboard and eleven event
 * subscriptions on every cycle, and any one of them held past `teardownWorld` is a step in
 * `usedJSHeapSize` that a single long match would never show.
 *
 * "Your job is to make that one click." So it is one call:
 *
 * ```js
 * await __operator.runMatches(3)   // or 10; the human's number, not mine
 * ```
 *
 * and the heap is logged at every boundary. Three things make the number trustworthy:
 *
 * **The match is driven to its real end, not cut short.** `MatchFlow` decides when it is
 * over exactly as it would for a player, and the harness watches for the state machine to
 * reach SUMMARY. What is measured is the teardown a real match performs.
 *
 * **The clock is compressed by adding ticks, never by changing `DT`.** `Loop.simSpeed` runs
 * the same 1/60 s simulation more times per frame, so a ten-minute TDM finishes in wall
 * seconds while remaining bit-for-bit the match a player would have got (S4.1).
 *
 * **The heap is sampled after a settle.** `usedJSHeapSize` immediately after a teardown is
 * mostly garbage that has not been collected yet, so each sample waits a beat and, where the
 * browser exposes it, asks for a collection first. A rising sawtooth is still a rising
 * sawtooth; what the settle removes is the noise that makes a flat line look like a slope.
 */

/** Sim seconds per wall second while a harness match runs. */
const HARNESS_SPEED = 12;
/** Wall milliseconds to let the heap settle before sampling it. */
const SETTLE_MS = 900;
/** Give up on a match that has not ended in this many wall seconds. */
const MATCH_TIMEOUT_MS = 180_000;

/**
 * Allocation pressure applied before each heap sample, in 1 MB chunks.
 *
 * Without it the readings are unusable: six consecutive matches came back
 * 51.9, 50.9, 65.3, 70.1, 56.9, 60.1 MB — a 19 MB spread with no trend, which is V8 deciding
 * when to collect rather than anything the game did. `window.gc` only exists behind
 * `--expose-gc`, so the portable way to get comparable numbers is to *provoke* a collection:
 * allocate a few tens of megabytes, drop them, and let the resulting cycle run before reading
 * `usedJSHeapSize`. What survives that is what is actually retained.
 */
const GC_NUDGE_CHUNKS = 48;

export interface MatchBoundary {
  /** 0 is the sample taken before the first match started. */
  index: number;
  heapMB: number;
  /** Simulated seconds the match ran for. */
  simSeconds: number;
  wallSeconds: number;
  scoreA: number;
  scoreB: number;
  winner: string;
  reason: string;
  /** Frame percentiles across this match alone. */
  p50: number;
  p95: number;
  p99: number;
  /** Peak mode and HUD milliseconds seen during this match. */
  peakModeMs: number;
  peakHudMs: number;
}

export interface MatchHarnessReport {
  running: boolean;
  matchesRun: number;
  boundaries: MatchBoundary[];
  /** Heap change from the first boundary to the last, MB. The number that matters. */
  heapDeltaMB: number;
}

export interface MatchHarnessDeps {
  readonly game: Game;
  readonly loop: Loop;
  readonly stats: FrameStats;
}

export class MatchHarness {
  private readonly deps: MatchHarnessDeps;
  private readonly boundaries: MatchBoundary[] = [];
  private running = false;

  constructor(deps: MatchHarnessDeps) {
    this.deps = deps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Play `count` matches end to end, tearing down between each, and log the heap at every
   * boundary. Resolves with the report.
   */
  async run(count: number): Promise<MatchHarnessReport> {
    if (this.running) {
      console.warn('[MatchHarness] already running.');
      return this.report();
    }
    this.running = true;
    this.boundaries.length = 0;

    const { game, loop, stats } = this.deps;
    const restoreSpeed = loop.simSpeed;
    const restoreSteps = loop.maxStepsPerFrame;

    try {
      // Start from the menu, whatever the caller was looking at.
      if (game.currentState === 'SUMMARY') game.transitionTo('MENU');
      else if (game.currentState === 'MATCH') game.transitionTo('MENU');

      this.boundaries.push(await this.sampleBoundary(0, 0, 0, '', '', 0, 0));
      console.info(`[MatchHarness] baseline heap ${fmt(this.boundaries[0]?.heapMB)} MB`);

      for (let i = 1; i <= count; i++) {
        loop.simSpeed = HARNESS_SPEED;
        loop.maxStepsPerFrame = Math.max(5, HARNESS_SPEED + 2);
        stats.reset();

        const startTick = loop.currentTick;
        const startMs = performance.now();
        game.transitionTo('MATCH');

        const ended = await this.waitForSummary();
        const simSeconds = (loop.currentTick - startTick) * DT;
        const wallSeconds = (performance.now() - startMs) / 1000;

        const result = game.activeMatch?.flow.result ?? null;
        stats.recompute();
        const peakModeMs = stats.peakModeMs;
        const peakHudMs = stats.peakHudMs;
        const p50 = stats.p50;
        const p95 = stats.p95;
        const p99 = stats.p99;

        // SUMMARY -> MENU is the transition that runs `teardownWorld`.
        game.transitionTo('MENU');
        loop.simSpeed = 1;
        loop.maxStepsPerFrame = 5;

        const boundary = await this.sampleBoundary(
          i,
          simSeconds,
          wallSeconds,
          result?.winner ?? (ended ? 'UNKNOWN' : 'TIMEOUT'),
          result?.reason ?? '',
          result?.scoreA ?? 0,
          result?.scoreB ?? 0,
        );
        boundary.p50 = p50;
        boundary.p95 = p95;
        boundary.p99 = p99;
        boundary.peakModeMs = peakModeMs;
        boundary.peakHudMs = peakHudMs;
        this.boundaries.push(boundary);

        console.info(
          `[MatchHarness] match ${i}: ${boundary.winner} by ${boundary.reason || 'n/a'} ` +
            `${boundary.scoreA}-${boundary.scoreB} · ${boundary.simSeconds.toFixed(0)} sim s in ` +
            `${boundary.wallSeconds.toFixed(1)} wall s · heap ${fmt(boundary.heapMB)} MB · ` +
            `p50/p95/p99 ${p50.toFixed(1)}/${p95.toFixed(1)}/${p99.toFixed(1)} ms · ` +
            `mode peak ${peakModeMs.toFixed(2)} ms · HUD peak ${peakHudMs.toFixed(2)} ms`,
        );
      }
    } finally {
      loop.simSpeed = restoreSpeed;
      loop.maxStepsPerFrame = restoreSteps;
      this.running = false;
    }

    const report = this.report();
    console.info(
      `[MatchHarness] ${report.matchesRun} matches · heap ${fmt(report.boundaries[0]?.heapMB)} -> ` +
        `${fmt(report.boundaries[report.boundaries.length - 1]?.heapMB)} MB ` +
        `(delta ${report.heapDeltaMB >= 0 ? '+' : ''}${report.heapDeltaMB.toFixed(2)} MB)`,
    );
    return report;
  }

  report(): MatchHarnessReport {
    const first = this.boundaries[0];
    const last = this.boundaries[this.boundaries.length - 1];
    const delta =
      first === undefined || last === undefined || first.heapMB < 0 || last.heapMB < 0
        ? 0
        : last.heapMB - first.heapMB;
    return {
      running: this.running,
      matchesRun: Math.max(0, this.boundaries.length - 1),
      boundaries: this.boundaries.map((b) => ({ ...b })),
      heapDeltaMB: delta,
    };
  }

  // -- internals -------------------------------------------------------------

  /** Resolve once the state machine reaches SUMMARY, or on timeout. */
  private waitForSummary(): Promise<boolean> {
    const game = this.deps.game;
    const deadline = performance.now() + MATCH_TIMEOUT_MS;
    return new Promise<boolean>((resolve) => {
      const poll = (): void => {
        if (game.currentState === 'SUMMARY') {
          resolve(true);
          return;
        }
        if (performance.now() > deadline) {
          console.warn('[MatchHarness] match did not end inside the timeout.');
          resolve(false);
          return;
        }
        window.setTimeout(poll, 50);
      };
      poll();
    });
  }

  private async sampleBoundary(
    index: number,
    simSeconds: number,
    wallSeconds: number,
    winner: string,
    reason: string,
    scoreA: number,
    scoreB: number,
  ): Promise<MatchBoundary> {
    requestCollection();
    await delay(SETTLE_MS);
    return {
      index,
      heapMB: heapMB(),
      simSeconds,
      wallSeconds,
      winner,
      reason,
      scoreA,
      scoreB,
      p50: 0,
      p95: 0,
      p99: 0,
      peakModeMs: 0,
      peakHudMs: 0,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Provoke a garbage collection before sampling the heap.
 *
 * `window.gc` is used where it exists (`--js-flags=--expose-gc`). Where it does not, a few tens
 * of megabytes allocated and immediately dropped is what makes V8 collect, and a collected heap
 * is the only heap whose size means anything across a match boundary. See `GC_NUDGE_CHUNKS`.
 */
function requestCollection(): void {
  const candidate: unknown = (window as unknown as { gc?: unknown }).gc;
  if (typeof candidate === 'function') {
    (candidate as () => void)();
    return;
  }
  let sink: Uint8Array | null = null;
  for (let i = 0; i < GC_NUDGE_CHUNKS; i++) {
    sink = new Uint8Array(1024 * 1024);
    // Touch it, or the allocation can be elided and no pressure is applied.
    sink[i] = i & 0xff;
  }
  sink = null;
  void sink;
}

/**
 * `performance.memory` is a non-standard Chrome extension and is exactly what S7's memory
 * question needs. Absent elsewhere, hence the guard rather than a type assertion.
 */
function heapMB(): number {
  const perf: unknown = performance;
  if (typeof perf !== 'object' || perf === null || !('memory' in perf)) return -1;
  const memory: unknown = (perf as { memory: unknown }).memory;
  if (typeof memory !== 'object' || memory === null || !('usedJSHeapSize' in memory)) return -1;
  const used: unknown = (memory as { usedJSHeapSize: unknown }).usedJSHeapSize;
  return typeof used === 'number' ? used / (1024 * 1024) : -1;
}

function fmt(value: number | undefined): string {
  if (value === undefined || value < 0) return 'n/a';
  return value.toFixed(2);
}
