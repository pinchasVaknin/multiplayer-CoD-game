import { nowMs } from '../core/Clock';
import { SIM_HZ } from '../core/Loop';
import type { TunableMeta } from '../player/MovementConfig';
import type { Pathfinder } from './Pathing';

/**
 * The AI work scheduler (brief S6.6 — REQUIRED).
 *
 * Ten bots each running line-of-sight, A* and cover evaluation every tick would consume
 * the whole 3 ms logic budget on its own, so they don't. This file owns the rates and
 * nothing else owns them:
 *
 *   | Work                | Rate                                    |
 *   |---------------------|-----------------------------------------|
 *   | Aim and steering    | every tick, 60 Hz                       |
 *   | Perception / LOS    | ~10 Hz, staggered by bot index          |
 *   | Path request + A*   | ~3 Hz, staggered, budget-capped         |
 *   | Cover / tactical    | ~4 Hz, staggered                        |
 *
 * **The stagger is proportional, not modular.** `index % period` puts ten bots on six
 * perception phases as 2,2,2,2,1,1 — the first four ticks of every cycle do twice the work
 * of the last two, and the spike is exactly what staggering was supposed to remove.
 * Spreading them as `floor(index * period / count)` gives 2,2,2,2,1,1 in a different order
 * but, more importantly, holds for *any* count and period: with ten bots on a twenty-tick
 * path cycle it is one bot every other tick, dead even.
 *
 * **A\* is budget-capped, not rate-capped.** The pathfinder is resumable, so this hands it
 * a node allowance each tick and it stops mid-search when the allowance runs out. S6.6's
 * reasoning is the whole design: a bot arriving 100 ms late to a path is invisible, and a
 * 12 ms frame spike is not.
 *
 * The timing this class records is what acceptance criterion 6 is read from. It measures
 * itself with `nowMs()` around the whole AI block, once per tick, and keeps a
 * one-minute ring so p50 and p99 are real percentiles rather than a running average.
 */

export interface SchedulerConfig {
  /** Perception samples per second, per bot. */
  perceptionHz: number;
  /** Tactical / cover evaluations per second, per bot. */
  tacticalHz: number;
  /** Path requests per second, per bot. */
  pathHz: number;
  /** A* node expansions permitted across all bots per tick. */
  astarNodesPerTick: number;
}

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  perceptionHz: 10,
  tacticalHz: 4,
  pathHz: 3,
  astarNodesPerTick: 420,
};

export const SCHEDULER_TUNABLES: Readonly<Record<keyof SchedulerConfig, TunableMeta>> = {
  perceptionHz: { label: 'Perception', group: 'AI rates', min: 2, max: 60, step: 1, unit: 'Hz' },
  tacticalHz: { label: 'Tactical', group: 'AI rates', min: 1, max: 20, step: 1, unit: 'Hz' },
  pathHz: { label: 'Path request', group: 'AI rates', min: 1, max: 12, step: 1, unit: 'Hz' },
  astarNodesPerTick: { label: 'A* budget', group: 'AI rates', min: 40, max: 4000, step: 20, unit: 'n' },
};

export const SCHEDULER_CONFIG_KEYS = Object.keys(DEFAULT_SCHEDULER) as Array<keyof SchedulerConfig>;

export function schedulerConfigToSource(cfg: SchedulerConfig): string {
  const lines = ['export const DEFAULT_SCHEDULER: SchedulerConfig = {'];
  for (const key of SCHEDULER_CONFIG_KEYS) lines.push(`  ${key}: ${Math.round(cfg[key] * 1e4) / 1e4},`);
  lines.push('};');
  return lines.join('\n');
}

/** One minute of ticks. Long enough for p99 to mean something at 60 Hz. */
const HISTORY = SIM_HZ * 60;

export class AiScheduler {
  readonly config: SchedulerConfig;

  /** Last tick's AI wall time, ms. */
  lastMs = 0;
  p50Ms = 0;
  p99Ms = 0;
  worstMs = 0;
  meanMs = 0;

  /** Work actually dispatched on the last tick, for the read-out. */
  perceptionRuns = 0;
  tacticalRuns = 0;
  pathRuns = 0;

  private readonly history = new Float32Array(HISTORY);
  private readonly scratch = new Float32Array(HISTORY);
  private head = 0;
  private filled = 0;
  private startMs = 0;
  private tick = 0;
  private count = 1;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /** Call at the top of the AI block. `botCount` sizes the stagger. */
  beginTick(tick: number, botCount: number): void {
    this.tick = tick;
    this.count = Math.max(1, botCount);
    this.perceptionRuns = 0;
    this.tacticalRuns = 0;
    this.pathRuns = 0;
    this.startMs = nowMs();
  }

  /** Seconds between this bot's perception samples. Feeds the velocity estimate. */
  get perceptionInterval(): number {
    return 1 / Math.max(this.config.perceptionHz, 1);
  }

  perceptionDue(index: number): boolean {
    const due = this.due(index, this.config.perceptionHz);
    if (due) this.perceptionRuns++;
    return due;
  }

  tacticalDue(index: number): boolean {
    const due = this.due(index, this.config.tacticalHz);
    if (due) this.tacticalRuns++;
    return due;
  }

  pathDue(index: number): boolean {
    const due = this.due(index, this.config.pathHz);
    if (due) this.pathRuns++;
    return due;
  }

  /** Spend this tick's A* allowance. Overflow stays queued inside the pathfinder. */
  runPathBudget(pathfinder: Pathfinder): void {
    pathfinder.step(Math.max(1, Math.round(this.config.astarNodesPerTick)));
  }

  /** Call at the bottom of the AI block. */
  endTick(): void {
    const ms = nowMs() - this.startMs;
    this.lastMs = ms;
    this.history[this.head] = ms;
    this.head = (this.head + 1) % HISTORY;
    if (this.filled < HISTORY) this.filled++;
    if (ms > this.worstMs) this.worstMs = ms;
  }

  /** Recompute percentiles. Sorts a copy; call at a few Hz, never per tick. */
  recompute(): void {
    const n = this.filled;
    if (n === 0) return;
    const view = this.scratch.subarray(0, n);
    view.set(this.history.subarray(0, n));
    view.sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += view[i] ?? 0;
    this.meanMs = sum / n;
    this.p50Ms = view[Math.min(n - 1, Math.round(0.5 * (n - 1)))] ?? 0;
    this.p99Ms = view[Math.min(n - 1, Math.round(0.99 * (n - 1)))] ?? 0;
  }

  reset(): void {
    this.history.fill(0);
    this.head = 0;
    this.filled = 0;
    this.worstMs = 0;
    this.p50Ms = 0;
    this.p99Ms = 0;
    this.meanMs = 0;
    this.lastMs = 0;
  }

  get sampleCount(): number {
    return this.filled;
  }

  /**
   * Is `index`'s slot up this tick, for work that wants to run `hz` times a second?
   *
   * The period is the number of ticks between runs; the phase is this bot's slot inside
   * it, spread proportionally across the roster so no tick carries more than
   * `ceil(count / period)` bots' worth of work.
   */
  private due(index: number, hz: number): boolean {
    const period = Math.max(1, Math.round(SIM_HZ / Math.max(hz, 1)));
    if (period === 1) return true;
    const phase = Math.floor((index * period) / this.count) % period;
    return this.tick % period === phase;
  }
}
