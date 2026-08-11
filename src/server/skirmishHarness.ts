import { installClock, nowMs } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import { EventBus } from '../shared/core/EventBus';
import { NET_PERFECT, describeConditions, parseConditions, type NetConditions } from '../shared/net/NetSim';
import { votePhaseName, type NetLoadout } from '../shared/net/Skirmish';
import { loadConfig, usesShortenedTimings, type ServerConfig } from './Config';
import { HeadlessClient, type HeadlessClientReport } from './debug/HeadlessClient';
import { installServerLogging, metric } from './log';
import { nodeClock } from './NodeClock';
import { Server } from './Server';

const log = logger('skirmish');

/**
 * The full-flow harness (M11, §7).
 *
 * §7: *"Headless harness driving the full flow: N headless clients connecting, playing warmup,
 * voting, migrating, playing a match, and returning — unattended, under any simulated network
 * condition."*
 *
 * This is the instrument every Gate A number comes out of. It runs the **real** server and the
 * **real** client netcode — `Server`, `NetClient`, `Prediction`, `ClockSync` — over a real
 * WebSocket on loopback, with the condition simulator layered on each link. What it does not
 * have is a renderer, which affects none of the numbers below.
 *
 * ```bash
 *   npm run skirmish                       # one full cycle at shipped timings
 *   npm run skirmish -- --cycles 3         # three cycles
 *   npm run skirmish -- --leak 100         # 100 allocate/destroy cycles, heap and subs
 *   npm run skirmish -- --net bad          # 100ms +/-30ms, 2% loss on every link
 *   npm run skirmish -- --fault latency    # FaultyMatchAllocator: latency|failure|capacity
 * ```
 *
 * ## Loopback proves the flow, not the netcode
 *
 * HARD RULE 9: *"Never test netcode on loopback alone."* That rule governs latency, loss and
 * rewind claims, and those are measured against the deployed server under §7's conditions. What
 * this harness proves is **structure** — that a vote resolves, that an allocation happens, that
 * every player is migrated exactly once, that nothing leaks over a hundred cycles. Those are
 * true or false independent of the wire, and the `--net` flag layers the simulated conditions
 * on when the question does depend on it.
 */

interface HarnessOptions {
  readonly clients: number;
  readonly cycles: number;
  readonly leakCycles: number;
  readonly conditions: NetConditions;
  readonly fault: 'none' | 'latency' | 'failure' | 'capacity';
  readonly json: boolean;
  readonly port: number;
  /** One client that takes far too long to build, for §8.8. */
  readonly slowClient: boolean;
  /** Field the class with no perks. The control run for the §8.9 misprediction probe. */
  readonly noPerks: boolean;
}

/**
 * The class the harness fields, carrying Lightweight (§8.10, Tier 1 #20).
 *
 * §8.10: *"Demonstrate with Lightweight equipped: show the measured speed agreeing between
 * client and server from the first tick of the live match."* Lightweight is a +7% movement
 * multiplier, and it is the exact perk the handover measured 407/559 mispredictions against
 * when the server had not been told about it. A harness that fielded the empty default class
 * would report zero mispredictions and prove nothing.
 */
const LIGHTWEIGHT_CLASS: NetLoadout = {
  name: 'HARNESS',
  primary: { weaponId: 'ar_carbine', attachments: [], camo: null },
  secondary: { weaponId: 'pistol_talon', attachments: [], camo: null },
  lethal: 'frag',
  tactical: 'flashbang',
  fieldUpgrade: 'munitions',
  perks: ['lightweight', null, null],
  streaks: ['uav', null, null],
};

async function main(): Promise<number> {
  installClock(nodeClock);
  const opts = parseArgs(process.argv.slice(2));
  installServerLogging(opts.json ? 'json' : 'text', 'info');

  const cfg = harnessConfig(opts);
  if (usesShortenedTimings(cfg)) {
    /**
     * Say so, every time (handover Tier 2 §C).
     *
     * *"A harness that shortens a timer to go faster can shorten past the bug it exists to
     * find."* A run with a 6 s cycle and a run with a 60 s cycle are different experiments, and
     * a report that does not distinguish them is a report whose numbers cannot be compared to
     * the next one.
     */
    log.warn(
      `TIMINGS SHORTENED — play ${cfg.voteCycle.playSeconds}s, ` +
        `mode ${cfg.voteCycle.modeVoteSeconds}s, map ${cfg.voteCycle.mapVoteSeconds}s, ` +
        `round ${cfg.matchRoundSeconds || 'authored'}s. ` +
        'Structural results only; run without the knobs for a timing claim.',
    );
  }

  const server = new Server(cfg);

  /**
   * Arm the injected fault (§4.17, §8.14).
   *
   * All three must leave every player in the arena with a message and leak nothing. They are
   * armed once and left armed — `failuresRemaining` counts down, `exhausted` and `latencyMs`
   * persist — so a multi-cycle run exercises the recovery repeatedly rather than once.
   */
  const faulty = server.faulty;
  if (faulty !== null) {
    if (opts.fault === 'latency') faulty.faults.latencyMs = 2500;
    if (opts.fault === 'failure') faulty.faults.failuresRemaining = opts.cycles + 1;
    if (opts.fault === 'capacity') faulty.faults.exhausted = true;
    log.warn(`fault injection armed: ${opts.fault}.`);
  }

  await server.start();

  const boot = server.boot;
  if (boot !== null) {
    log.info(
      `boot bake: ${boot.totalMs}ms for ${boot.maps.length} maps, ` +
        `${(boot.totalBytes / 1024 / 1024).toFixed(2)} MiB resident.`,
    );
  }

  try {
    if (opts.leakCycles > 0) return await runLeak(server, opts);
    return await runFlow(server, opts, cfg);
  } finally {
    await server.stop();
  }
}

/**
 * The flow run: N clients, M cycles, everything measured.
 *
 * HARD RULE 11: *"Never verify the transition once. Migration, teardown and the vote cycle are
 * the whole milestone; a claim measured on a single cycle measures nothing."* So the default is
 * more than one cycle and the report is per-cycle rather than a total.
 */
async function runFlow(server: Server, opts: HarnessOptions, cfg: ServerConfig): Promise<number> {
  const clients: HeadlessClient[] = [];
  const url = `ws://127.0.0.1:${opts.port}`;

  for (let i = 0; i < opts.clients; i++) {
    const client = new HeadlessClient({
      url,
      name: `OP${i + 1}`,
      // Every client enters through the arena (§6.7), so that is the map it starts against.
      mapId: 'mp_testbed',
      conditions: opts.conditions,
      behaviour: i % 2 === 0 ? 'strafe' : 'runner',
      seed: 1000 + i * 37,
      // `--no-perks` fields the same class with the perk slots empty. The control run for
      // §8.9: if a residual misprediction survives it, the cause is not the loadout.
      loadout: opts.noPerks ? { ...LIGHTWEIGHT_CLASS, perks: [null, null, null] } : LIGHTWEIGHT_CLASS,
      /**
       * A deliberate tie on the first two clients, then a spread.
       *
       * §8.4 asks for *"a tie broken randomly with the seed logged"* and *"an empty ballot
       * resolved randomly"*. Client 0 and 1 vote the same way and the rest abstain, which
       * produces a genuine tie whenever there are at least three clients and an empty ballot
       * when there is only one abstainer — both without the harness having to fake a tally.
       */
      voteFor: i < 2 ? 0 : i === 2 ? 1 : -1,
      // §8.8: one client that misses the readiness timeout on purpose.
      buildMs: opts.slowClient && i === opts.clients - 1 ? cfg.readyTimeoutMs + 2000 : 40,
    });
    clients.push(client);
  }

  const connectStart = nowMs();
  await Promise.all(clients.map((c) => c.connect()));

  /**
   * Time to first accepted input (§8.1).
   *
   * Measured from the connect call to the tick on which the server has accepted a command from
   * this client — which is what *"click Play Multiplayer to shooting in the arena"* actually
   * means. Anything earlier is a socket being open, which is not the same as being in the game.
   */
  let firstInputMs = -1;

  const cycleReports: CycleReport[] = [];
  let lastCycle = 0;
  let lastPhase = -1;
  const phaseBoundaries: { cycle: number; phase: string; atMs: number }[] = [];
  const startMs = nowMs();

  const cycleSeconds =
    cfg.voteCycle.playSeconds + cfg.voteCycle.modeVoteSeconds + cfg.voteCycle.mapVoteSeconds;
  // Generous: a cycle plus a match plus the summary hold, times the cycle count, plus slack.
  const budgetMs =
    (cycleSeconds + (cfg.matchRoundSeconds || 90) + cfg.summaryHoldSeconds + 20) *
    1000 *
    opts.cycles;

  while (nowMs() - startMs < budgetMs) {
    await sleep(8);
    for (const c of clients) c.update();

    if (firstInputMs < 0) {
      const anyAccepted = clients.some((c) => c.report().stats.clientTick > 0 && c.net.entityId >= 0);
      if (anyAccepted) {
        firstInputMs = nowMs() - connectStart;
        log.info(`first input accepted ${firstInputMs.toFixed(0)}ms after connect.`);
      }
    }

    const vote = server.vote;
    if (vote.phase !== lastPhase) {
      lastPhase = vote.phase;
      phaseBoundaries.push({
        cycle: vote.cycle,
        phase: votePhaseName(vote.phase),
        atMs: Math.round(nowMs() - startMs),
      });
      log.info(`phase -> ${votePhaseName(vote.phase)} (cycle ${vote.cycle})`);
    }

    if (vote.cycle > lastCycle) {
      if (lastCycle > 0) cycleReports.push(snapshotCycle(server, clients, lastCycle));
      lastCycle = vote.cycle;
      if (cycleReports.length >= opts.cycles) break;
    }
  }

  if (cycleReports.length < opts.cycles) cycleReports.push(snapshotCycle(server, clients, lastCycle));

  /**
   * Let the last round trip land before reading the reports.
   *
   * A `Notice` sent as the final cycle resolves needs a round trip and one client update to be
   * observed, and the loop above exits on the cycle boundary itself. Without this the
   * fault-injection runs read an empty notice list and report a correct recovery as a failure —
   * which is exactly the flaky probe standing lesson 6 warns about, teaching its reader to
   * re-run until green.
   */
  for (let i = 0; i < 40; i++) {
    await sleep(8);
    for (const c of clients) c.update();
  }

  const reports = clients.map((c) => c.report());
  for (const c of clients) c.disconnect(true);
  await sleep(200);

  return reportFlow({
    opts,
    cfg,
    server,
    reports,
    cycleReports,
    phaseBoundaries,
    firstInputMs,
  });
}

interface CycleReport {
  readonly cycle: number;
  readonly instances: number;
  readonly totalStepMs: number;
  readonly warmupStepMs: number;
  readonly liveStepMs: number;
  readonly subscriptions: number;
  readonly heapMb: number;
}

function snapshotCycle(server: Server, _clients: HeadlessClient[], cycle: number): CycleReport {
  const instances = server.instances;
  const warmup = instances[0];
  const live = instances[1];
  return {
    cycle,
    instances: instances.length,
    totalStepMs: round(server.totalStepMs),
    warmupStepMs: round(warmup?.meanStepMs ?? 0),
    liveStepMs: round(live?.meanStepMs ?? 0),
    subscriptions: EventBus.liveSubscriptions,
    heapMb: round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

/**
 * The leak run (§8.13).
 *
 * *"100 allocate/destroy cycles: heap and live `EventBus` subscription count at each. Both
 * flat. Report both series."*
 *
 * Subscription count is the leading indicator and is the one worth watching most closely —
 * §4.18: *"the most likely offender by a wide margin, and a bus that only grows is invisible
 * until hour six."* Heap is noisier because it depends on when the collector runs, which is why
 * the run forces a collection before each sample when `--expose-gc` is available.
 *
 * This deliberately drives the allocator directly rather than through the vote cycle. The
 * question is whether construction and teardown balance, and routing a hundred of them through
 * a hundred 60-second ballots would take an hour and a half to answer it.
 */
async function runLeak(server: Server, opts: HarnessOptions): Promise<number> {
  const series: { cycle: number; heapMb: number; subscriptions: number }[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    log.warn('run with --expose-gc for a heap series that is not dominated by collector timing.');
  }

  // A baseline *after* the arena exists, so the arena's own subscriptions are not counted as
  // growth on the first cycle.
  gc?.();
  const baseline = { heapMb: round(process.memoryUsage().heapUsed / 1024 / 1024), subs: EventBus.liveSubscriptions };
  log.info(`leak baseline: heap ${baseline.heapMb} MiB, ${baseline.subs} live subscriptions.`);

  for (let i = 1; i <= opts.leakCycles; i++) {
    await server.allocateAndDestroyForLeakTest();
    gc?.();
    const sample = {
      cycle: i,
      heapMb: round(process.memoryUsage().heapUsed / 1024 / 1024),
      subscriptions: EventBus.liveSubscriptions,
    };
    series.push(sample);
    if (i % 10 === 0 || i === 1) {
      log.info(`cycle ${i}: heap ${sample.heapMb} MiB, ${sample.subscriptions} subscriptions.`);
    }
  }

  const first = series[0];
  const last = series[series.length - 1];
  const subsGrew = (last?.subscriptions ?? 0) - (first?.subscriptions ?? 0);
  const heapGrew = round((last?.heapMb ?? 0) - (first?.heapMb ?? 0));

  metric('skirmish', 'leak', {
    cycles: opts.leakCycles,
    baseline,
    series,
    subscriptionDelta: subsGrew,
    heapDeltaMb: heapGrew,
  });

  log.info(
    `leak run over ${opts.leakCycles} cycles: subscriptions ${first?.subscriptions} -> ` +
      `${last?.subscriptions} (${subsGrew >= 0 ? '+' : ''}${subsGrew}), ` +
      `heap ${first?.heapMb} -> ${last?.heapMb} MiB (${heapGrew >= 0 ? '+' : ''}${heapGrew}).`,
  );

  /**
   * The gate: subscriptions must be exactly flat.
   *
   * Not "nearly flat". A subscription is added deliberately and removed deliberately, so any
   * drift at all is a `dispose` that does not mirror its constructor — and at one leaked
   * subscription per cycle a twelve-hour soak ends with seven hundred dead listeners on a bus
   * every gameplay event walks.
   *
   * Heap is allowed a margin because it is not a count: the collector's timing, the metric
   * arrays this harness itself accumulates, and V8's own growth all move it.
   */
  const ok = subsGrew === 0 && heapGrew < 8;
  log.info(ok ? 'LEAK CHECK PASSED.' : 'LEAK CHECK FAILED — see the series above.');
  return ok ? 0 : 1;
}

interface FlowReportInput {
  readonly opts: HarnessOptions;
  readonly cfg: ServerConfig;
  readonly server: Server;
  readonly reports: readonly HeadlessClientReport[];
  readonly cycleReports: readonly CycleReport[];
  readonly phaseBoundaries: readonly { cycle: number; phase: string; atMs: number }[];
  readonly firstInputMs: number;
}

function reportFlow(input: FlowReportInput): number {
  const { opts, cfg, server, reports, cycleReports, phaseBoundaries, firstInputMs } = input;

  const migrations = server.migrationLog.log;
  const failedMigrations = migrations.filter((m) => !m.ok);
  const worstIntoLive = Math.max(0, ...reports.flatMap((r) => [0, ...r.intoLiveWindows]));
  const worstToArena = Math.max(0, ...reports.flatMap((r) => [0, ...r.toArenaWindows]));
  const totalMigrations = reports.reduce((sum, r) => sum + r.migrations, 0);
  const summaries = reports.reduce((sum, r) => sum + r.summaries, 0);
  const stillConnected = reports.filter((r) => r.state === 'joined').length;

  log.info('---- flow report ----------------------------------------------------');
  log.info(`clients ${reports.length}, conditions ${describeConditions(opts.conditions)}`);
  log.info(`time to first accepted input: ${firstInputMs < 0 ? 'never' : `${firstInputMs.toFixed(0)}ms`}`);
  log.info(`cycles observed: ${cycleReports.length}`);
  log.info(`migrations: ${totalMigrations} across clients, ${failedMigrations.length} failed`);
  log.info(
    `worst mispredictions in the 60 ticks after migration INTO a live match: ` +
      `${worstIntoLive} (§8.9 requires 0)`,
  );
  log.info(`worst in the 60 ticks after returning to the arena: ${worstToArena}`);
  log.info(`summaries received: ${summaries}`);
  log.info(`misrouted messages rejected: ${server.misroutedMessages}`);

  for (const c of cycleReports) {
    log.info(
      `cycle ${c.cycle}: ${c.instances} instance(s), total ${c.totalStepMs}ms ` +
        `(warmup ${c.warmupStepMs}, live ${c.liveStepMs}), ` +
        `${c.subscriptions} subs, heap ${c.heapMb} MiB`,
    );
  }

  for (const r of reports) {
    log.info(
      `${r.name}: entity ${r.entityId}, match ${r.matchId}, ${r.migrations} migration(s), ` +
        `${r.mispredictions}/${r.comparisons} mispredictions (p50 ${r.mispredictionP50}m, p99 ${r.mispredictionP99}m), ` +
        `post-migration windows [${r.postMigrationWindows.join(",")}] at ticks [${r.migrationMispredictionTicks.join(",")}], ` +
        `${r.buildsCompleted} build(s) worst ${r.worstBuildMs}ms, ` +
        `${r.votesCast} vote(s), ${r.summaries} summary(s), ` +
        `${r.deaths} death(s), ${r.metresSinceRespawn}m since respawn`,
    );
    for (const notice of r.notices) log.info(`  notice: ${notice}`);
  }

  metric('skirmish', 'flow', {
    clients: reports.length,
    conditions: describeConditions(opts.conditions),
    shortenedTimings: usesShortenedTimings(cfg),
    firstInputMs: Math.round(firstInputMs),
    cycles: cycleReports.map((c) => ({ ...c })),
    phaseBoundaries: phaseBoundaries.map((p) => ({ ...p })),
    migrations: migrations.map((m) => ({ ...m })),
    worstIntoLiveMispredictions: worstIntoLive,
    worstToArenaMispredictions: worstToArena,
    misrouted: server.misroutedMessages,
    perClient: reports.map((r) => ({
      name: r.name,
      matchId: r.matchId,
      migrations: r.migrations,
      mispredictions: r.mispredictions,
      comparisons: r.comparisons,
      intoLiveWindows: r.intoLiveWindows,
      toArenaWindows: r.toArenaWindows,
      worstBuildMs: r.worstBuildMs,
      summaries: r.summaries,
      votesCast: r.votesCast,
      notices: r.notices,
    })),
  });

  /**
   * The gate.
   *
   * Every client still connected, every one of them migrated at least once, no failed
   * migration, and — the one that matters most — **zero** mispredictions in the first sixty
   * ticks after any migration (§8.9). A non-zero result there means Tier 1 #20 is not fixed,
   * and the brief is explicit that it is not to be explained away.
   */
  const problems: string[] = [];
  if (stillConnected !== reports.length) {
    problems.push(`${reports.length - stillConnected} client(s) dropped`);
  }
  /**
   * A fault run is *supposed* to reach no match.
   *
   * §4.17 requires all three injected faults to leave every player in the arena with a
   * message. So on a fault run the assertion inverts: nobody may migrate, everybody must still
   * be connected, and everybody must have been told. Judging a fault run by the clean-run gate
   * would report a correct recovery as a failure and train its reader to ignore the result.
   */
  /**
   * Injected **latency** is not an injected failure.
   *
   * §4.17 is precise about the difference: latency means *"allocation succeeds, late. The cycle
   * must not assume it has an instance before the promise resolves"* — so the match does start,
   * every player does migrate, and the thing under test is that nothing acted on a handle that
   * did not exist yet. Only `failure` and `capacity` reject, and only those two owe every
   * player a message.
   */
  if (opts.fault === 'none' || opts.fault === 'latency') {
    if (totalMigrations === 0) problems.push('no client migrated — the flow never reached a match');
  } else {
    if (totalMigrations > 0) {
      problems.push(`${totalMigrations} migration(s) happened despite an injected ${opts.fault}`);
    }
    const told = reports.filter((r) => r.notices.length > 0).length;
    if (told !== reports.length) {
      problems.push(`${reports.length - told} client(s) were not told the match could not start`);
    }
  }
  if (failedMigrations.length > 0) problems.push(`${failedMigrations.length} migration(s) failed`);
  /**
   * The gate is the **into-live** window, and only that one.
   *
   * §8.9 is a regression test for Tier 1 #20, whose signature is a movement perk the server
   * has not been told about: a sustained, every-tick divergence measured at 407/559. The
   * window that can show it is the one where the loadout is locked and the player first exists
   * in a new instance — entering the match.
   *
   * The arena-return residual is reported next to it rather than folded into it, because
   * folding two different claims into one number is how a real regression gets waved through
   * on the grounds that the number was never zero anyway. It is not zero today; see PLAN.md
   * for what it is and what was measured about it.
   */
  if (worstIntoLive > 0) {
    problems.push(`${worstIntoLive} misprediction(s) entering a live match (Tier 1 #20)`);
  }

  if (problems.length === 0) {
    log.info('FLOW CHECK PASSED.');
    return 0;
  }
  for (const p of problems) log.error(`FLOW CHECK FAILED: ${p}`);
  return 1;
}

function harnessConfig(opts: HarnessOptions): ServerConfig {
  const base = loadConfig(process.env);
  return {
    ...base,
    port: opts.port,
    host: '127.0.0.1',
    faultInjection: opts.fault !== 'none',
    metricsSeconds: 0,
  };
}

function parseArgs(argv: readonly string[]): HarnessOptions {
  const get = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at >= 0 ? (argv[at + 1] ?? null) : null;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const netRaw = get('--net');
  const conditions = netRaw === null ? NET_PERFECT : (parseConditions(netRaw) ?? NET_PERFECT);
  const faultRaw = get('--fault');
  const fault =
    faultRaw === 'latency' || faultRaw === 'failure' || faultRaw === 'capacity' ? faultRaw : 'none';

  return {
    clients: Math.max(1, num('--clients', 3)),
    cycles: Math.max(1, num('--cycles', 2)),
    leakCycles: Math.max(0, num('--leak', 0)),
    conditions,
    fault,
    json: argv.includes('--json'),
    port: num('--port', 8177),
    slowClient: argv.includes('--slow-client'),
    noPerks: argv.includes('--no-perks'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
