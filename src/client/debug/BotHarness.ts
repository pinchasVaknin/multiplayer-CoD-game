import { BOT_TIERS, type BotTier } from '../../shared/ai/DifficultyTiers';
import type { GameModeId } from '../../shared/modes/GameMode';
import { MODES } from '../../shared/modes/ModeRegistry';
import type { Loop } from '../engine/FrameLoop';
import { DT } from '../../shared/core/Loop';
import type { Match } from '../ClientMatch';
import type { FrameStats } from './FrameStats';

/**
 * The AFK bot-versus-bot match harness (brief S7 — REQUIRED).
 *
 * A dev-only mode that fills both sides with bots, takes the human out of the roster
 * entirely, and runs. The point is that a build can be left running for ten minutes and
 * come back with frame-time and memory data collected from the *real* systems — the real
 * loop, the real collision world, the real damage path — rather than from a rig that
 * approximates them.
 *
 * Two details matter and both are S7's:
 *
 * **The speed multiplier scales sim ticks per frame, never `dt`.** `Loop.simSpeed` adds
 * whole 1/60 s ticks. A ten-minute soak at 4x is forty minutes of simulation that is
 * bit-for-bit the simulation a player would have got, so a GC sawtooth it finds is real.
 *
 * **The player is a spectator, not a participant.** `PlayerCombatant.active = false` is
 * the whole mechanism: perception skips it, spawn scoring ignores it, and no bot goes
 * looking for it — so the numbers describe bots fighting bots and nothing else.
 *
 * M7 extends it to **any mode** (S7): `?harness=botmatch&mode=SND&speed=20` runs a full
 * best-of-nine Search & Destroy with nobody at the keyboard, which is the only practical way
 * to watch a nine-round match play out or to leave one running. The mode is applied to the
 * menu selection before the world is built, so the harness match is composed exactly the way
 * a player's would be — same registry entry, same objectives, same roster rules.
 *
 * Taking the human out matters more in M7 than it did in M3. With one life per round, an idle
 * player on team A is not a neutral observer: it makes every Search & Destroy round a 4-v-5,
 * and the attacking side wins all nine. `playerCombatant.active = false` is what makes the
 * measurement about the mode rather than about the spectator.
 *
 * Enabled by URL flag: `?harness=botmatch&bots=10&speed=4&tier=VETERAN&mode=DOM`.
 */

export interface BotHarnessOptions {
  /** Total bots across both sides. Split as evenly as possible. */
  readonly bots: number;
  /** Sim seconds per wall-clock second. */
  readonly speed: number;
  /** A single tier for every bot, or 'MIX' for the default spread. */
  readonly tier: BotTier | 'MIX';
  /** Map id to load, or null to use whatever the menu had selected. */
  readonly map: string | null;
  /** Mode id to run, or null to use whatever the menu had selected (M7). */
  readonly mode: GameModeId | null;
  /**
   * M8. How many matches to play back to back, logging the heap at every boundary.
   *
   * 1 is the M3/M7 behaviour: one AFK match that runs until it ends. Above 1, `Game` hands
   * the run to `MatchHarness` instead, which is the thing that already knows how to build
   * and tear down a world repeatedly and sample a settled heap between them — S6.5 asks for
   * "the AFK bot-match harness with a match-count parameter and heap logging at each
   * boundary", and those were two tools that had never been given one flag.
   */
  readonly matches: number;
}

const DEFAULT_OPTIONS: BotHarnessOptions = {
  bots: 10,
  speed: 1,
  tier: 'MIX',
  map: null,
  mode: null,
  matches: 1,
};

const MIX: readonly BotTier[] = ['RECRUIT', 'REGULAR', 'HARDENED', 'VETERAN'];

/** Sanity ceiling. Past this the linear target scan in `Ballistics` is the wrong shape. */
const MAX_BOTS = 32;
/**
 * Raised from 16 in M7.
 *
 * A best-of-nine Search & Destroy is up to nine 150-second rounds plus warm-ups — around
 * twenty-five minutes of simulation. At 16x that is a wall minute and a half of watching
 * nothing; at 32x it is under a minute, and the multiplier still only adds whole 1/60 s ticks
 * so the match is bit-for-bit the one a player would have played (S4.1).
 */
const MAX_SPEED = 32;

/**
 * Matches one `?matches=` run will play.
 *
 * Ten is the number S6.5's memory question is asked in, and a ceiling exists at all because
 * each match is a full build and teardown with a settle between: at 32x a ten-match TDM run
 * is already several wall minutes, and a typo of `matches=1000` should not silently commit
 * the machine to an afternoon.
 */
const MAX_MATCHES = 25;

/**
 * Read the harness flags off a query string. Returns null when this is a normal run,
 * which is what keeps the whole harness out of the way of an ordinary boot.
 */
export function parseHarnessOptions(search: string): BotHarnessOptions | null {
  const params = new URLSearchParams(search);
  if (params.get('harness') !== 'botmatch') return null;

  const bots = clampInt(params.get('bots'), DEFAULT_OPTIONS.bots, 2, MAX_BOTS);
  const speed = clampInt(params.get('speed'), DEFAULT_OPTIONS.speed, 1, MAX_SPEED);

  const raw = (params.get('tier') ?? '').toUpperCase();
  const tier: BotTier | 'MIX' = isTier(raw) ? raw : 'MIX';
  const map = params.get('map');
  const rawMode = (params.get('mode') ?? '').toUpperCase();
  const mode = MODES.some((m) => m.id === rawMode) ? (rawMode as GameModeId) : null;

  const matches = clampInt(params.get('matches'), DEFAULT_OPTIONS.matches, 1, MAX_MATCHES);

  return { bots, speed, tier, map, mode, matches };
}

export interface BotHarnessReport {
  running: boolean;
  options: BotHarnessOptions;
  /** Simulated seconds since the harness started, from ticks rather than wall clock. */
  simSeconds: number;
  wallSeconds: number;
  frames: {
    p50: number;
    p95: number;
    p99: number;
    worst: number;
    mean: number;
    samples: number;
    overBudget: number;
    starved: number;
  };
  /** JS heap in MB where the browser exposes it, else -1. */
  heapMB: number;
  bots: ReturnType<Match['bots']['report']>;
}

export class BotHarness {
  readonly options: BotHarnessOptions;

  private running = false;
  private startTick = 0;
  private startMs = 0;

  constructor(
    options: BotHarnessOptions,
    private readonly match: Match,
    private readonly loop: Loop,
    private readonly stats: FrameStats,
  ) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Take the human out of the fight, fill both sides, and start the clock.
   *
   * Counters are reset *after* the roster spawns so the initial placement does not
   * count against the spawn-safety statistics — those first spawns happen into an empty
   * room and would flatter the result.
   */
  start(): void {
    if (this.running) return;
    const { bots, speed, tier } = this.options;

    this.match.playerCombatant.active = false;

    const teamA = Math.floor(bots / 2);
    const teamB = bots - teamA;
    this.match.bots.populate(teamA, teamB, tier === 'MIX' ? MIX : [tier]);

    this.loop.simSpeed = speed;
    // The catch-up cap has to clear the multiplier or the extra ticks are discarded.
    this.loop.maxStepsPerFrame = Math.max(5, speed + 2);

    this.match.bots.resetCounters();
    this.stats.reset();
    this.startTick = this.loop.currentTick;
    this.startMs = performance.now();
    this.running = true;

    console.info(
      `[BotHarness] ${teamA}v${teamB} bots, tier ${tier}, ${speed}x sim speed. ` +
        `__operator.harnessReport() for numbers.`,
    );
  }

  /** Hand the room back to the human. The roster is left in place. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.loop.simSpeed = 1;
    this.loop.maxStepsPerFrame = 5;
    this.match.playerCombatant.active = true;
  }

  /** Everything acceptance criteria 3, 6 and 7 are read from, in one object. */
  report(): BotHarnessReport {
    this.stats.recompute();
    return {
      running: this.running,
      options: this.options,
      simSeconds: (this.loop.currentTick - this.startTick) * DT,
      wallSeconds: (performance.now() - this.startMs) / 1000,
      frames: {
        p50: this.stats.p50,
        p95: this.stats.p95,
        p99: this.stats.p99,
        worst: this.stats.worst,
        mean: this.stats.mean,
        samples: this.stats.sampleCount,
        overBudget: this.stats.overBudget,
        starved: this.stats.starvedFrames,
      },
      heapMB: heapMB(),
      bots: this.match.bots.report(),
    };
  }
}

function isTier(value: string): value is BotTier {
  return (BOT_TIERS as readonly string[]).includes(value);
}

function clampInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * `performance.memory` is a non-standard Chrome extension and is exactly what
 * acceptance criterion 7's memory question needs. Absent elsewhere, hence the guard
 * rather than a type assertion.
 */
function heapMB(): number {
  const perf: unknown = performance;
  if (typeof perf !== 'object' || perf === null || !('memory' in perf)) return -1;
  const memory: unknown = (perf as { memory: unknown }).memory;
  if (typeof memory !== 'object' || memory === null || !('usedJSHeapSize' in memory)) return -1;
  const used: unknown = (memory as { usedJSHeapSize: unknown }).usedJSHeapSize;
  return typeof used === 'number' ? used / (1024 * 1024) : -1;
}
