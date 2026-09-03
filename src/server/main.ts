import { installClock } from '../shared/core/Clock';
import { DT } from '../shared/core/Loop';
import { logger, type LogLevel } from '../shared/core/Log';
import { nodeClock } from './NodeClock';
import { installServerLogging, metric, type LogFormat } from './log';
import { ServerLoop } from './Loop';
import { ServerMatch, type ServerMatchResult } from './Match';
import { auditModeBriefs } from '../shared/modes/ModeRegistry';
import { BOT_TIERS, isBotDifficulty, type BotDifficulty } from '../shared/ai/DifficultyTiers';

/**
 * The headless entry point (brief S6.4 and S7).
 *
 * `npm run server` boots this, loads Foundry, runs a ten-bot Team Deathmatch to its win
 * condition with no browser open and no DOM shim installed, logs the result, and exits.
 *
 * `--matches N` turns it into the S7 headless harness: the M3 AFK bot-match harness, in Node,
 * logging frame time, tick jitter, AI cost and heap as structured JSON at every match
 * boundary. That is the tool the rest of the project is stabilised with, because it runs
 * unattended, in CI, with no display.
 *
 * Usage:
 *   npm run server
 *   npm run server -- --matches 5 --json
 *   npm run server -- --map mp_depot --mode DOM --bots 10 --tier VETERAN --seed 7
 *   npm run server -- --minutes 10           (a fixed-duration jitter run)
 *   npm run server -- --tier-sweep --asap    (playtest round 4 F1: one match per difficulty)
 */

interface Args {
  map: string;
  mode: string;
  bots: number;
  tier: BotDifficulty;
  /**
   * One match per difficulty, same seed, same map, same mode (playtest round 4, F1).
   *
   * The probe the selector is worth having only if it passes: it prints the roster each choice
   * actually built and what that roster shot like, so *"the tiers do not produce different
   * numbers"* is a thing somebody can read rather than assume. Ignores `--tier` and `--matches`,
   * because it sets both itself.
   */
  tierSweep: boolean;
  seed: number;
  matches: number;
  /** Stop after this many simulated minutes even if the match has not ended. 0 = no cap. */
  minutes: number;
  /**
   * Run the simulation as fast as the CPU allows instead of pacing it at 60 Hz.
   *
   * The default is real time, because that is what a server *is* — and because the tick
   * jitter of S4.10 is only meaningful when the loop is actually trying to hit a deadline.
   *
   * `--asap` is the harness mode. A TDM match is about five minutes of simulated time, so a
   * five-match stability run costs half an hour of wall clock at 60 Hz; S7 wants this thing
   * running unattended in CI, and half an hour per run is how a tool stops being used. It
   * changes nothing about the simulation: the same number of `DT` ticks happen in the same
   * order, they are simply not spaced out. Jitter is not reported for an unpaced run,
   * because there is no deadline to have missed.
   */
  asap: boolean;
  format: LogFormat;
  level: LogLevel;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    map: 'mp_foundry',
    mode: 'TDM',
    bots: 10,
    tier: 'MIX',
    tierSweep: false,
    seed: 1,
    matches: 1,
    minutes: 0,
    asap: false,
    // A redirected log is being read by something. Default to JSON when stdout is not a
    // terminal, so `npm run server > run.log` produces a parseable file without a flag.
    format: process.stdout.isTTY === true ? 'text' : 'json',
    level: 'info',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--map':
        args.map = next();
        break;
      case '--mode':
        args.mode = next();
        break;
      case '--bots':
        args.bots = Number.parseInt(next(), 10);
        break;
      case '--tier': {
        /**
         * Validated here rather than "inside `populate`", which is what the old comment on
         * `newMatch` claimed and was not true: an unknown tier resolved to a one-element list
         * containing it, and `createBot` then indexed `TierTable` with it and got `undefined`.
         * `--tier VETRAN` produced a roster of bots with no config rather than an error.
         */
        const raw = next().toUpperCase();
        if (!isBotDifficulty(raw)) {
          throw new Error(`--tier must be one of ${BOT_TIERS.join(', ')} or MIX; got "${raw}"`);
        }
        args.tier = raw;
        break;
      }
      case '--tier-sweep':
        args.tierSweep = true;
        break;
      case '--seed':
        args.seed = Number.parseInt(next(), 10);
        break;
      case '--matches':
        args.matches = Number.parseInt(next(), 10);
        break;
      case '--minutes':
        args.minutes = Number.parseFloat(next());
        break;
      case '--asap':
        args.asap = true;
        break;
      case '--json':
        args.format = 'json';
        break;
      case '--text':
        args.format = 'text';
        break;
      case '--debug':
        args.level = 'debug';
        break;
      case '--quiet':
        args.level = 'warn';
        break;
      default:
        throw new Error(`unknown argument "${a}"`);
    }
  }

  if (!Number.isFinite(args.bots) || args.bots < 2) throw new Error('--bots must be at least 2');
  if (!Number.isFinite(args.matches) || args.matches < 1) throw new Error('--matches must be >= 1');
  if (!Number.isFinite(args.seed)) throw new Error('--seed must be a number');
  return args;
}

/** Resident heap in MB, after a GC if the runtime was started with `--expose-gc`. */
function heapMb(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc !== undefined) gc();
  return Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10;
}

/** One JSON line per match boundary, identical whichever way the match was paced (S7). */
function reportMatch(
  args: Args,
  index: number,
  match: ServerMatch,
  simMsMean: number,
  jitter: ReturnType<ServerLoop['jitter']> | null,
): void {
  const result = match.outcome();
  const report = match.report();

  metric('harness', 'match.end', {
    match: index + 1,
    map: args.map,
    mode: args.mode,
    seed: args.seed + index,
    paced: jitter !== null,
    winner: result?.winner ?? 'INCOMPLETE',
    reason: result?.reason ?? `stopped at ${args.minutes} simulated minutes`,
    scoreA: result?.scoreA ?? 0,
    scoreB: result?.scoreB ?? 0,
    simSeconds: result?.simSeconds ?? Math.round(match.tickCount * DT * 10) / 10,
    ticks: match.tickCount,
    // S4.7's 3.0 ms budget covers sim + AI + audio scheduling. There is no audio here.
    simMsMean: round3(simMsMean),
    // Only meaningful when the loop was pacing to a deadline. Omitted rather than zeroed for
    // an unpaced run, so a reader cannot mistake "not measured" for "perfect".
    tickHz: jitter?.hz ?? null,
    jitterP50: jitter?.p50 ?? null,
    jitterP99: jitter?.p99 ?? null,
    jitterMin: jitter?.min ?? null,
    jitterMax: jitter?.max ?? null,
    ticksLate: jitter?.late ?? null,
    ticksDropped: jitter?.dropped ?? null,
    heapMb: heapMb(),
    /**
     * The killstreak economy (playtest round 4, B9 + B10 and the pivot).
     *
     * `lives`/`lifeStarts` are the denominators: a zero in `negativeBalances` means nothing
     * unless something was actually banked and spent. `thresholdGrants`, `balancePurchases` and
     * `balanceRepeatPurchases` are the three models the economy has had, priced from the same
     * lives in the same run — which is the only way a pacing comparison is not two fights.
     *
     * `activations` is zero in a bot-only run and that is not a measurement failure: no bot has
     * ever had a call site that spends a streak. See PLAN.md, "Found while here".
     */
    streaks: match.streakEconomy,
    /**
     * What every life started holding (playtest round 4, B3).
     *
     * `partialStock` is the number the session is about and must be 0; `lifeStarts` is the
     * denominator that stops a probe which never fired from reading as a pass.
     */
    equipment: match.equipmentAudit,
    hitRateByTier: Object.fromEntries(
      Object.entries(report.perTier).map(([tier, r]) => [
        tier,
        { bots: r.bots, shots: r.shotsFired, hits: r.shotsHit, hitRate: round3(r.hitRate) },
      ]),
    ),
  });
}

function newMatch(args: Args, index: number): ServerMatch {
  return new ServerMatch({
    mapId: args.map,
    modeId: args.mode,
    bots: args.bots,
    // Checked at parse by `isBotDifficulty`, so this is a `BotDifficulty` rather than the
    // `as never` that used to sit here in front of a claim about validation that was not true.
    tier: args.tier,
    // Each match in a run gets its own seed, so five matches are five different fights
    // rather than the same one five times — which is what a stability run needs.
    seed: args.seed + index,
  });
}

function tickCapFor(args: Args): number {
  return args.minutes > 0 ? Math.round((args.minutes * 60) / DT) : 0;
}

/**
 * Whichever pacing was asked for, over a match the caller owns.
 *
 * The match is passed in and **not disposed here** (round 4, F1). The tier sweep reads
 * `match.report()` after the run, and a runner that both built and destroyed its own match left
 * the per-tier table unreachable from outside — which is why the two functions below stopped
 * calling `newMatch` themselves.
 */
function runToEnd(args: Args, match: ServerMatch): Promise<ServerMatchResult | null> {
  return args.asap ? runMatchAsap(args, 0, match) : runMatchPaced(args, 0, match);
}

/** Real time, drift-corrected, jitter measured. What a server actually does. */
function runMatchPaced(
  args: Args,
  index: number,
  match: ServerMatch,
): Promise<ServerMatchResult | null> {
  return new Promise((resolve) => {
    const cap = tickCapFor(args);
    const loop = new ServerLoop({
      tick: (t) => match.step(t),
      shouldContinue: (t) => !match.isOver && (cap === 0 || t < cap),
      onStop: () => {
        reportMatch(args, index, match, loop.meanSimMs, loop.jitter());
        resolve(match.outcome());
      },
    });
    loop.start();
  });
}

/**
 * As fast as the CPU allows. The harness mode.
 *
 * Ticks are run in chunks with a `setImmediate` between them rather than in one blocking
 * loop, so the process stays interruptible — a five-match run that cannot be Ctrl-C'd is a
 * five-match run somebody kills with a task manager and loses the log of.
 */
function runMatchAsap(
  args: Args,
  index: number,
  match: ServerMatch,
): Promise<ServerMatchResult | null> {
  return new Promise((resolve) => {
    const cap = tickCapFor(args);
    /** 10 s of simulation per macrotask. Long enough to be cheap, short enough to yield. */
    const CHUNK = 600;
    let tick = 0;
    let simMsTotal = 0;

    const pump = (): void => {
      const t0 = nodeClock.nowMs();
      for (let i = 0; i < CHUNK; i++) {
        if (match.isOver || (cap !== 0 && tick >= cap)) break;
        match.step(tick);
        tick++;
      }
      simMsTotal += nodeClock.nowMs() - t0;

      if (match.isOver || (cap !== 0 && tick >= cap)) {
        reportMatch(args, index, match, tick === 0 ? 0 : simMsTotal / tick, null);
        resolve(match.outcome());
        return;
      }
      setImmediate(pump);
    };

    pump();
  });
}

/**
 * Every registered mode's brief, printed and asserted (playtest round 4, F10).
 *
 * At boot of every run rather than behind a flag, because an audit somebody has to remember to
 * pass is an audit nobody runs. It costs six mode constructions against no world and returns
 * before the first tick. `GameMode.brief` being abstract already makes a *missing* brief a
 * compile error; this is the half a type cannot state — that the sentence is non-empty, that
 * three of them assembled correctly from the map's own objectives, and that no two modes are
 * briefing the player identically.
 */
function reportModeBriefs(log: ReturnType<typeof logger>): number {
  const audit = auditModeBriefs();
  for (const row of audit.rows) log.info(`  ${row.id} (${row.mapId}): ${row.brief}`);
  for (const problem of audit.problems) log.error(`  ${problem}`);
  if (audit.problems.length > 0) {
    log.error(`MODE BRIEF AUDIT FAILED: ${audit.problems.length} problem(s).`);
    return 1;
  }
  log.info(`mode briefs: ${audit.rows.length} registered mode(s), all non-empty and distinct.`);
  return 0;
}

/**
 * One match per difficulty, everything else held constant (playtest round 4, F1).
 *
 * P10 asked for *"a match at each difficulty tier with the same seed, printing bot K/D per
 * tier. If the tiers do not produce different numbers, the selector is not wired."* Two things
 * are printed against that, and they answer different halves of it:
 *
 *  - **The roster**, per tier, which is the wiring itself. A choice that does not reach
 *    `BotDirector` leaves every run with the map's authored spread, and five identical
 *    composition rows is what that looks like.
 *  - **Hit rate and K/D**, which is the table reaching behaviour — and both are **symmetric
 *    measurements in a single-tier match**, which is the trap in reading this table. K/D is
 *    exactly 1.00 in every single-tier row by construction: both sides are the same tier, so
 *    every kill is also a death. Hit rate is symmetric for the same reason and measured
 *    non-monotonic across the four (Hardened came out *below* Regular), because a harder tier is
 *    also harder to hit. Neither is the discriminator.
 *
 * What separates the single-tier runs is the **time to the score limit**, printed on the roster
 * line, because that is the one quantity a symmetric roster does not cancel: ten Veterans reach
 * 75 kills faster than ten Recruits. And the `MIX` row is where per-tier K/D means something at
 * all — there the four fight each other and the ordering is the acceptance claim M3 made.
 */
async function runTierSweep(args: Args, log: ReturnType<typeof logger>): Promise<number> {
  const choices: readonly BotDifficulty[] = [...BOT_TIERS, 'MIX'];
  log.info(
    `tier sweep (F1): ${args.mode} on ${args.map}, ${args.bots} bots, seed ${args.seed}, ` +
      `one match per difficulty.`,
  );

  let incomplete = 0;
  for (const choice of choices) {
    const sweepArgs: Args = { ...args, tier: choice, matches: 1, tierSweep: false };
    const match = newMatch(sweepArgs, 0);
    const result = await runToEnd(sweepArgs, match);
    if (result === null) incomplete++;
    const report = match.report();
    const rows = Object.entries(report.perTier);
    const composition = rows.map(([tier, r]) => `${tier} x${r.bots}`).join(', ');
    log.info(
      `  ${padEnd(choice, 9)} roster [${composition}] — ` +
        `${result === null ? 'no winner' : `${result.reason} in ${result.simSeconds}s`}`,
    );
    for (const [tier, r] of rows) {
      log.info(
        `    ${padEnd(tier, 9)} ${r.bots} bot(s)  hit rate ${round3(r.hitRate)}  ` +
          `${r.kills}k / ${r.deaths}d  K/D ${round3(r.kills / Math.max(1, r.deaths))}`,
      );
    }
    metric('harness', 'tier.sweep', {
      difficulty: choice,
      map: args.map,
      mode: args.mode,
      seed: args.seed,
      simSeconds: result?.simSeconds ?? null,
      perTier: Object.fromEntries(
        rows.map(([tier, r]) => [
          tier,
          { bots: r.bots, hitRate: round3(r.hitRate), kills: r.kills, deaths: r.deaths },
        ]),
      ),
    });
    match.dispose();
  }
  return incomplete === 0 ? 0 : 1;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Before anything simulates. `nowMs()` throws rather than falling back, deliberately —
  // a silent fallback is how a headless run quietly measures the wrong thing for an hour.
  installClock(nodeClock);
  installServerLogging(args.format, args.level);

  const log = logger('server');

  /**
   * The mode-brief audit, before anything simulates (F10).
   *
   * Ahead of the boot line on purpose: a failure here is about the content the whole run is
   * built from, and reporting it after five matches would be reporting it after five matches.
   */
  const briefFault = reportModeBriefs(log);
  if (briefFault !== 0) return briefFault;

  if (args.tierSweep) return runTierSweep(args, log);

  log.info(
    `OPERATOR headless — node ${process.version}, ${args.matches} match(es), ` +
      `${args.mode} on ${args.map}, ${args.bots} bots, tier ${args.tier}, seed ${args.seed}, ` +
      `${args.asap ? 'unpaced' : 'real time at 60 Hz'}.`,
  );
  metric('server', 'boot', {
    node: process.version,
    pid: process.pid,
    matches: args.matches,
    map: args.map,
    mode: args.mode,
    bots: args.bots,
    tier: args.tier,
    seed: args.seed,
    paced: !args.asap,
    heapMb: heapMb(),
  });

  const results: Array<ServerMatchResult | null> = [];
  for (let i = 0; i < args.matches; i++) {
    const match = newMatch(args, i);
    results.push(args.asap ? await runMatchAsap(args, i, match) : await runMatchPaced(args, i, match));
    match.dispose();
  }

  /**
   * A match that stopped without a winner.
   *
   * Only a failure when nobody asked it to stop. `--minutes` is a *deliberate* cap — the
   * ten-minute jitter run of S8 criterion 6 wants exactly 600 seconds of ticks and does not
   * care who was winning — so hitting it is a normal end, and reporting a non-zero exit for
   * it would make that measurement look like a crash in CI. Without a cap, a match that ends
   * with no winner means the mode never terminated, which is a real fault.
   */
  let incomplete = 0;
  for (const r of results) {
    if (r === null) {
      if (args.minutes > 0) {
        log.info(`stopped at the ${args.minutes}-minute cap, as asked.`);
      } else {
        incomplete++;
        log.warn('a match did not reach a win condition.');
      }
      continue;
    }
    log.info(
      `${r.modeId} on ${r.mapId}: ${r.winner} wins ${r.scoreA}-${r.scoreB} (${r.reason}) ` +
        `in ${r.simSeconds}s of simulation across ${r.ticks} ticks.`,
    );
  }

  metric('server', 'run.end', {
    matches: args.matches,
    completed: args.matches - incomplete,
    incomplete,
    cappedAtMinutes: args.minutes > 0 ? args.minutes : null,
    heapMb: heapMb(),
  });

  return incomplete === 0 ? 0 : 1;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

main().then(
  (code) => {
    // Exit explicitly. Nothing should be holding the event loop open by this point, and if
    // something is, an exit code beats a process that hangs in CI with no explanation.
    process.exit(code);
  },
  (err: unknown) => {
    // Never a stack trace to a client (S4.16). There is no client yet, but the habit starts
    // here: the operator gets the message and the process gets a non-zero exit.
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack !== undefined) process.stderr.write(err.stack + '\n');
    process.exit(1);
  },
);
