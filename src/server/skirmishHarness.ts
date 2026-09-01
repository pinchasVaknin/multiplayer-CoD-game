import { installClock, nowMs } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import { EventBus } from '../shared/core/EventBus';
import { NET_PERFECT, describeConditions, parseConditions, type NetConditions } from '../shared/net/NetSim';
import { CLIENT_TIMEOUT_MS } from '../shared/net/Protocol';
import { votePhaseName, type NetLoadout } from '../shared/net/Skirmish';
import type { StreakId } from '../shared/streaks/StreakDefs';
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
 *   npm run skirmish -- --summary-gate     # RED CONTROL: go silent for the post-match hold
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
  /** Have one client change its class mid-warmup (§6.6). */
  readonly editClass: boolean;
  /** Make every client vote for this ballot index, or -1 for the default spread. */
  readonly voteFor: number;
  /**
   * Grant every seated human this streak once the live match is running (§8.22).
   *
   * The earn path itself is M7 code, unchanged and already proven in single-player: four kills
   * is four kills. What Gate B added is everything *after* it — replicate the pending list,
   * let the client ask, validate and grant server-side, replicate the resulting entity — and
   * waiting for a headless client to happen to get four kills would make that a test that
   * sometimes runs. This makes it a test that always runs.
   */
  readonly grantStreak: string | null;
  /**
   * Give the second client the Ghost perk (§8.22).
   *
   * The control for the Ghost assertion. Run with it and the ghost must never appear as a UAV
   * contact; run without it and they must — a probe that only ever goes green proves that the
   * contact list is empty, not that Ghost works.
   */
  readonly ghost: boolean;
  /**
   * Drop the last client while it is flying a Chopper Gunner (§8.23, case 4).
   *
   * The one Chopper case that no event covers. Death, match end, round end and teardown all
   * reach `StreakSystem` through subscriptions it already holds; a disconnect reaches nothing,
   * so the gunship kept flying with an owner that no longer existed.
   */
  readonly dropGunner: boolean;
  /**
   * Disconnect **every** client once the live match is running (§4.9, M11 Gate B).
   *
   * The probe for empty-instance teardown. §4.20 refuses to *start* a match for zero humans in
   * two places; nothing covered the case after `RUNNING`, so a match whose last player left
   * kept simulating ten bots to a win condition while holding the process's only live-match
   * slot. Distinct from `--drop-gunner`, which drops one client to test a streak's owner
   * vanishing: this one empties the match.
   */
  readonly abandon: boolean;
  /** Have every client throw a lethal every N ticks, or 0 never (§8.24). */
  readonly throwEveryTicks: number;
  /**
   * Go silent for the summary hold, the way the browser used to (playtest round 4, B4).
   *
   * **The red control for the post-match hold probe.** `Game.simulate` serviced the socket only
   * while the screen was `MATCH`, so the post-match board stopped the pings, the reads and the
   * link check for the whole 14 s hold — against a 10 s `CLIENT_TIMEOUT_MS`. A `HeadlessClient`
   * has no screen and pumps unconditionally, which is exactly why every harness run in this
   * milestone was green about a bug that disconnected every player of every match.
   */
  readonly summaryGate: boolean;
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
/** The same class with the perk slots empty. See `editClass` in `runFlow`. */
const NO_PERK_CLASS: NetLoadout = {
  name: 'HARNESS-EDIT',
  primary: { weaponId: 'smg_wasp', attachments: [], camo: null },
  secondary: { weaponId: 'pistol_talon', attachments: [], camo: null },
  lethal: 'semtex',
  tactical: 'smoke',
  fieldUpgrade: 'stim',
  perks: [null, null, null],
  streaks: ['uav', null, null],
};

/**
 * The same class carrying Ghost (§8.22).
 *
 * Ghost is the perk whose whole effect is an absence, which makes it the one perk that cannot
 * be verified by looking at the player who has it — only by looking at what an enemy is told.
 */
const GHOST_CLASS: NetLoadout = {
  name: 'HARNESS-GHOST',
  primary: { weaponId: 'ar_carbine', attachments: [], camo: null },
  secondary: { weaponId: 'pistol_talon', attachments: [], camo: null },
  lethal: 'frag',
  tactical: 'flashbang',
  fieldUpgrade: 'munitions',
  perks: ['ghost', null, null],
  streaks: ['uav', null, null],
};

const LIGHTWEIGHT_CLASS: NetLoadout = {
  name: 'HARNESS',
  primary: { weaponId: 'ar_carbine', attachments: [], camo: null },
  secondary: { weaponId: 'pistol_talon', attachments: [], camo: null },
  lethal: 'frag',
  /**
   * Smoke rather than a flashbang, deliberately (§8.24, §6.8).
   *
   * A flashbang spawns no cloud, so a harness fielding one leaves `applyReplicatedSmoke` and the
   * smoke half of `MsgS.Projectiles` unmeasured — and smoke is the piece §6.8 singles out,
   * because it occludes bot line of sight on the server. The perk under test here is
   * Lightweight, and the tactical slot has nothing to do with it.
   */
  tactical: 'smoke',
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
      loadout: streakHarnessClass(opts, i),
      throwEveryTicks: opts.throwEveryTicks,
      /**
       * A deliberate tie on the first two clients, then a spread.
       *
       * §8.4 asks for *"a tie broken randomly with the seed logged"* and *"an empty ballot
       * resolved randomly"*. Client 0 and 1 vote the same way and the rest abstain, which
       * produces a genuine tie whenever there are at least three clients and an empty ballot
       * when there is only one abstainer — both without the harness having to fake a tally.
       */
      /**
       * `--vote N` makes every client vote the same way, which is how a run targets one mode.
       *
       * Without it the spread below produces a tie and an abstention on purpose — see §8.4.
       * With it, a run can ask for Domination specifically, which is the only way to exercise
       * objective replication: TDM and FFA author no zones and correctly send nothing.
       */
      voteFor: opts.voteFor >= 0 ? opts.voteFor : i < 2 ? 0 : i === 2 ? 1 : -1,
      // §8.8: one client that misses the readiness timeout on purpose.
      buildMs: opts.slowClient && i === opts.clients - 1 ? cfg.readyTimeoutMs + 2000 : 40,
      /**
       * One client edits its class mid-warmup (§6.6, §8.10).
       *
       * The first client swaps to a class with **no** movement perk part-way through the first
       * warmup period. That is the interesting direction: it changes `speedScale` away from the
       * value both sides started with, so a server that applied it at the wrong moment — or not
       * at all — shows up immediately as a divergence, and one that applies it on the next spawn
       * on both sides shows nothing.
       */
      editClass: opts.editClass && i === 0 ? NO_PERK_CLASS : undefined,
      editAfterTicks: 240,
      // The red control. Every client, because the bug was every client. See `--summary-gate`.
      gateOnSummary: opts.summaryGate,
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
  /** The live match's roster, as last seen while it was running. See the sampler below. */
  let observedHumans = 0;
  let observedBots = 0;
  let observedThrown = 0;
  let observedDetonated = 0;
  let observedSmokePeak = 0;
  let observedSmokeBlocked = 0;
  /** Which match the streak grant has already been applied to, so it happens once each. */
  let grantedTo = -1;
  let gunnerDropped = false;
  let droppedAtMs = 0;
  /** When `--abandon` emptied the live match, and whether the server then released it. */
  let abandonedAtMs = 0;
  let abandonedFreedMs = 0;
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

    /**
     * Sample the live roster while the match is actually running (§6.7, §8.27).
     *
     * Taken here rather than in `snapshotCycle`, which fires on the *next* cycle's first tick —
     * by which time the live match has been destroyed and every roster reads zero. A count
     * that can only be zero is not a measurement.
     */
    const running = server.instances[1];
    if (running !== undefined && running.running) {
      observedHumans = running.playerCount;
      observedBots = running.botCount;
      const eq = running.match.equipmentStats;
      observedThrown = eq.thrown;
      observedDetonated = eq.detonated;
      // Peak rather than current: clouds last 12 s and the sampler runs every 8 ms, so the
      // instantaneous count is zero for most of a match that had smoke in it throughout.
      observedSmokePeak = Math.max(observedSmokePeak, eq.smokeLive);
      observedSmokeBlocked = eq.smokeBlocked;

      /**
       * Put a streak in every seated player's hand, once per match (§8.22).
       *
       * Granted through `debugGrant`, which is the same `grant` the earn path calls — so
       * everything downstream of "this player now holds a UAV" is the shipping code, and only
       * the four kills that would have produced it are stood in for.
       */
      /**
       * Drop the gunner once their chopper is actually in the sky (§8.23, case 4).
       *
       * Waits for the streak to be *live* rather than dropping on a timer: the case being
       * tested is a chopper in flight losing its owner, and a client dropped a tick before the
       * grant landed would test nothing while looking identical in the log.
       */
      /**
       * Empty the running match, once (§4.9).
       *
       * Every client leaves at the same moment, which is the case the fix is about: not a
       * player leaving a match that still has people in it, but the last one leaving. What is
       * asserted afterwards is that the instance is gone — `server.liveMatch` back to null —
       * rather than still stepping bots into a win condition nobody will see.
       */
      if (opts.abandon && !abandonedAtMs) {
        abandonedAtMs = nowMs();
        log.info(`abandoning match ${running.id}: dropping all ${clients.length} client(s).`);
        for (const c of clients) c.disconnect(false);
      }

      if (opts.dropGunner && !gunnerDropped && gunnerFlying(clients)) {
        const victim = clients[clients.length - 1];
        if (victim !== undefined) {
          gunnerDropped = true;
          droppedAtMs = nowMs();
          log.info(`dropping ${victim.report().name} while their chopper is up (§8.23 case 4).`);
          victim.disconnect(false);
        }
      }

      if (opts.grantStreak !== null && grantedTo !== running.id) {
        grantedTo = running.id;
        for (const seat of running.sessions) {
          running.match.streaks.debugGrant(seat.player.entityId, opts.grantStreak as StreakId);
        }
        log.info(`granted ${opts.grantStreak} to ${running.playerCount} player(s) in match ${running.id}.`);
      }
    }

    // The other half of the `--abandon` probe: how long the server took to release the slot.
    if (abandonedAtMs > 0 && abandonedFreedMs === 0 && server.liveMatch === null) {
      abandonedFreedMs = nowMs();
      log.info(`live match released ${Math.round(abandonedFreedMs - abandonedAtMs)}ms after the last human left.`);
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
      if (lastCycle > 0) {
        cycleReports.push(
          snapshotCycle(
            server, clients, lastCycle, observedHumans, observedBots, observedThrown, observedDetonated,
            observedSmokePeak, observedSmokeBlocked,
          ),
        );
        observedHumans = 0;
        observedBots = 0;
        observedThrown = 0;
        observedDetonated = 0;
        observedSmokePeak = 0;
        observedSmokeBlocked = 0;
      }
      lastCycle = vote.cycle;
      if (cycleReports.length >= opts.cycles) break;
    }
  }

  if (cycleReports.length < opts.cycles) {
    cycleReports.push(
      snapshotCycle(
        server, clients, lastCycle, observedHumans, observedBots, observedThrown, observedDetonated,
        observedSmokePeak, observedSmokeBlocked,
      ),
    );
  }

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
    droppedAtMs,
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
  /**
   * The live match's roster, split (§6.7, §8.27).
   *
   * The number the bot-replacement rule actually constrains is the **total**: §6.7 fixes it at
   * the mode's authored count, so three humans in a ten-body Team Deathmatch must show 3 + 7.
   * Reported as the pair rather than the sum, because 13 and 10 are told apart by the sum and
   * "the humans replaced bots on the wrong side" is only visible in the split.
   */
  readonly liveHumans: number;
  readonly liveBots: number;
  /**
   * Equipment thrown and detonated in the live match (§8.24).
   *
   * Both numbers, because they fail differently: zero thrown means nothing on the server has a
   * grenade hand, and thrown-without-detonated means fuses are not burning. A single "grenades
   * happened" counter could not tell those apart.
   */
  readonly thrown: number;
  readonly detonated: number;
  /**
   * Smoke, as the two numbers §6.8's claim rests on (M11 Gate B playtest).
   *
   * *"Smoke occludes bot LOS on the server"* had been wired since the equipment commit and never
   * measured, and a wired occluder that is never consulted is indistinguishable from a working
   * one. `smokePeak` is the largest number of clouds alive at once — without it a zero below
   * says "nothing was thrown" rather than "smoke does nothing" — and `smokeBlocked` is sight
   * lines `Perception` discarded because a cloud was across them.
   */
  readonly smokePeak: number;
  readonly smokeBlocked: number;
}

function snapshotCycle(
  server: Server,
  _clients: HeadlessClient[],
  cycle: number,
  liveHumans: number,
  liveBots: number,
  thrown: number,
  detonated: number,
  smokePeak: number,
  smokeBlocked: number,
): CycleReport {
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
    liveHumans,
    liveBots,
    thrown,
    detonated,
    smokePeak,
    smokeBlocked,
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
  /** When `--drop-gunner` cut the gunner's link, or 0 if it never fired (§8.23). */
  readonly droppedAtMs: number;
}

function reportFlow(input: FlowReportInput): number {
  const { opts, cfg, server, reports, cycleReports, phaseBoundaries, firstInputMs, droppedAtMs } =
    input;

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
  const worstSpawn = Math.max(0, ...reports.map((r) => r.spawnWindowMispredictions));
  log.info(`worst in the first 4 s after joining: ${worstSpawn} (the playtest's spawn rubberband)`);
  log.info(`summaries received: ${summaries}`);
  log.info(`misrouted messages rejected: ${server.misroutedMessages}`);

  for (const c of cycleReports) {
    log.info(
      `cycle ${c.cycle}: ${c.instances} instance(s), total ${c.totalStepMs}ms ` +
        `(warmup ${c.warmupStepMs}, live ${c.liveStepMs}), ` +
        `live roster ${c.liveHumans}H+${c.liveBots}B=${c.liveHumans + c.liveBots}, ` +
        `equipment ${c.thrown} thrown/${c.detonated} detonated, ` +
        `smoke ${c.smokePeak} peak/${c.smokeBlocked} LOS blocked, ` +
        `${c.subscriptions} subs, heap ${c.heapMb} MiB`,
    );
  }

  for (const r of reports) {
    log.info(
      `${r.name}: entity ${r.entityId}, match ${r.matchId}, ${r.migrations} migration(s), ` +
        `${r.mispredictions}/${r.comparisons} mispredictions (p50 ${r.mispredictionP50}m, p99 ${r.mispredictionP99}m), ` +
        `spawn window ${r.spawnWindowMispredictions}, ` +
        `objectives ${r.objectiveUpdates} upd/${r.objectivesOwned} owned, ` +
        modeStateLine(r) +
        streakLine(r) +
        projectileLine(r) +
        `divergence ${r.hashMismatches}/${r.hashSamples}` +
        (r.firstMismatchTick >= 0 ? ` (first @${r.firstMismatchTick})` : '') +
        ', ' +
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
    worstSpawnMispredictions: worstSpawn,
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
  /**
   * One client is *supposed* to be gone under `--drop-gunner` (§8.23 case 4).
   *
   * The run deliberately cuts the last client's link mid-chopper, so counting it as an
   * unexpected drop would make the case-4 test permanently red for the reason it exists.
   */
  const expectedDrops = opts.dropGunner ? 1 : 0;
  if (stillConnected < reports.length - expectedDrops) {
    problems.push(`${reports.length - expectedDrops - stillConnected} client(s) dropped`);
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

  /**
   * Ghost, when the run armed it (§8.22).
   *
   * A blocking failure rather than a warning. A perk whose entire effect is an absence fails
   * silently by definition — nothing looks wrong when it stops working, because what it
   * suppresses is a dot on somebody else's map.
   */
  if (opts.ghost && !checkGhost(reports)) {
    problems.push('a Ghost player appeared as a UAV contact on an enemy client');
  }

  /**
   * §8.21: *"Divergence checker reports zero mismatches across a full match in each of the five
   * modes. Any mismatch is this milestone's blocking bug — report it, do not explain it away."*
   *
   * So it blocks. A checker whose failures are warnings is a checker that gets ignored, and this
   * one exists precisely to catch the faults that are otherwise silent.
   */
  const mismatches = reports.reduce((sum, r) => sum + r.hashMismatches, 0);
  const hashSamples = reports.reduce((sum, r) => sum + r.hashSamples, 0);
  if (mismatches > 0) {
    problems.push(`${mismatches} confirmed mode-state divergence(s) across ${hashSamples} samples`);
  } else if (hashSamples === 0) {
    // A zero that means "never looked" reads identically to a zero that means "never differed",
    // and only one of them is a pass.
    problems.push('the divergence checker took no samples — it is not running');
  }

  /**
   * §6.8's spectator invariants. Blocking, because two of the three are information leaks.
   *
   * Watching an enemy through their own eyes in Search & Destroy is a wallhack with a cinematic
   * framing, in the one mode where a round is decided by who knows what. Watching yourself or a
   * corpse is merely broken.
   */
  const specSelf = reports.reduce((n, r) => n + r.spectateSelfPicks, 0);
  const specEnemy = reports.reduce((n, r) => n + r.spectateEnemyPicks, 0);
  const specDead = reports.reduce((n, r) => n + r.spectateDeadPicks, 0);
  const specPicks = reports.reduce((n, r) => n + r.spectatePicks, 0);
  if (specSelf > 0) problems.push(`${specSelf} spectator pick(s) targeted the dead player themselves`);
  if (specEnemy > 0) problems.push(`${specEnemy} spectator pick(s) targeted an enemy`);
  if (specDead > 0) problems.push(`${specDead} spectator pick(s) targeted a corpse`);
  if (specPicks > 0) {
    log.info(
      `spectator: ${specPicks} target selection(s) while dead — ` +
        `${specSelf} self, ${specEnemy} enemy, ${specDead} dead (all must be 0).`,
    );
  }

  /**
   * The HUD-surface invariant (playtest round 4, §P1). See `shared/ui/HudSurfaces.ts`.
   *
   * Two blocking assertions and their denominators, because a zero that means *"never looked"*
   * reads identically to a zero that means *"never violated"* and only one of them is a pass:
   *
   * - **B13** — the quick class selector up while alive and outside the pre-match freeze is
   *   the panel outliving the respawn it belongs to. Blocking, because a panel that stays up
   *   eats the digit keys for the rest of the match, which is round three's other half.
   * - **B6** — Tab surviving `NetClient.neutralise` while dead. Asserted as a *presence*
   *   rather than an absence: it was zero before this session, and the death screen is exactly
   *   when the board is wanted.
   */
  const surfaceAlive = reports.reduce((n, r) => n + r.quickLoadoutAlive, 0);
  const surfaceTicks = reports.reduce((n, r) => n + r.quickLoadoutTicks, 0);
  const surfaceWindows = reports.reduce((n, r) => n + r.quickLoadoutWindows, 0);
  const surfaceRespawn = reports.reduce((n, r) => n + r.quickLoadoutRespawnTicks, 0);
  const surfacePrematch = reports.reduce((n, r) => n + r.quickLoadoutPrematchTicks, 0);
  const deadTicks = reports.reduce((n, r) => n + r.deadTicks, 0);
  const tabHeld = reports.reduce((n, r) => n + r.scoreboardHeldTicks, 0);
  const tabHeldDead = reports.reduce((n, r) => n + r.scoreboardHeldWhileDeadTicks, 0);
  const boardOpenDead = reports.reduce((n, r) => n + r.scoreboardOpenWhileDeadTicks, 0);

  if (surfaceAlive > 0) {
    problems.push(
      `${surfaceAlive} tick(s) with the quick class selector up while alive and out of the freeze (B13)`,
    );
  }
  if (deadTicks > 0 && tabHeldDead === 0) {
    problems.push(
      `the scoreboard key was discarded on all ${deadTicks} dead tick(s) — neutralise dropped it (B6)`,
    );
  }
  log.info(
    `hud surfaces: quick loadout ${surfaceTicks} tick(s) over ${surfaceWindows} window(s) ` +
      `(${surfaceRespawn} respawn / ${surfacePrematch} pre-match), ${surfaceAlive} while alive (must be 0); ` +
      `Tab held ${tabHeld} tick(s), ${tabHeldDead} of them across ${deadTicks} dead tick(s), ` +
      `board open ${boardOpenDead} tick(s) while dead.`,
  );

  /**
   * The post-match hold, end to end (playtest round 4, B4).
   *
   * Two blocking assertions, and both carry their denominator:
   *
   * - **Nobody may be dropped while the summary is up.** This is the whole of B4. The server
   *   holds the board for `summaryHoldSeconds` and reaps a session silent for
   *   `CLIENT_TIMEOUT_MS`, and the shipped client stopped talking for the first the moment it
   *   drew the second's deadline — so it was closed four seconds before it would have been
   *   migrated home, and every symptom the report lists follows from that one gate.
   * - **Every summary must be followed by a return to the arena**, or the countdown on screen
   *   is counting toward something that never arrives.
   *
   * `--summary-gate` restores the old behaviour and is how both were watched red.
   */
  const held = reports.filter((r) => r.summaries > 0);
  const returned = held.filter((r) => r.summaryHoldMs >= 0);
  const droppedOnSummary = reports.filter((r) => r.droppedOnSummary);
  if (droppedOnSummary.length > 0) {
    problems.push(
      `${droppedOnSummary.length} client(s) were disconnected while the summary was up — ` +
        `the ${cfg.summaryHoldSeconds}s hold outlasts the ${CLIENT_TIMEOUT_MS}ms client timeout (B4)`,
    );
  }
  if (held.length > 0 && returned.length < held.length) {
    problems.push(
      `${held.length - returned.length} of ${held.length} client(s) saw a summary and were ` +
        'never migrated back to the arena (B4)',
    );
  }
  if (held.length === 0) {
    /**
     * Say when the leg did not run, rather than passing quietly (§7).
     *
     * The same shape as the divergence checker's `hashSamples === 0` branch. A run in which no
     * match ever ended proves nothing about the summary, the hold or the return — and this
     * harness is named for a flow that includes all three. It is a warning rather than a
     * failure because at shipped timings it is the *normal* outcome: the budget allows
     * `matchRoundSeconds || 90` seconds for a match whose authored round is far longer, so the
     * run is cut off mid-match. That is why nothing here ever caught B4. See PLAN.md.
     */
    log.warn(
      'post-match hold: NOT EXERCISED — no match ended in this run, so the summary, the hold ' +
        'and the return migration were not tested. Shorten MATCH_ROUND_SECONDS to reach them.',
    );
  } else {
    log.info(
      `post-match hold: ${held.length} client(s) held, ${returned.length} migrated back; ` +
        `screen said ${held.map((r) => r.summarySaidSeconds.toFixed(1)).join('/')}s, ` +
        `actual summary→arena ${returned.map((r) => r.summaryHoldMs).join('/')}ms ` +
        `(server hold ${cfg.summaryHoldSeconds}s, client timeout ${CLIENT_TIMEOUT_MS}ms, ` +
        `${droppedOnSummary.length} dropped).`,
    );
  }

  /** §8.23 case 4. Blocking: an orphaned gunship shoots people. */
  if (opts.dropGunner) {
    if (droppedAtMs === 0) {
      problems.push('--drop-gunner was set but no chopper was ever seen flying');
    } else if (!checkDroppedGunner(reports, reports[reports.length - 1], droppedAtMs, 1500)) {
      problems.push('a Chopper Gunner outlived the gunner who disconnected');
    }
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

/**
 * The Gate B mode-state channels, reported only by the modes that have them.
 *
 * Kill Confirmed and Search & Destroy each broadcast on every snapshot tick, and printing
 * `tags 0 seen` on a TDM run would be noise that reads like a failure. A mode that sent nothing
 * says nothing.
 *
 * The two numbers chosen are the ones that go **red against the bug rather than green against
 * the feature**: `seen` counts distinct tag ids rather than frames, because the bug produced a
 * steady stream of empty lists; and `fuse` counts frames on which the timer was observed to
 * *fall*, because the bug produced a fuse that was replicated and constant.
 */
function modeStateLine(r: HeadlessClientReport): string {
  let out = '';
  if (r.tagUpdates > 0) {
    out += `tags ${r.tagUpdates} upd/${r.tagsSeen} seen/${r.peakTags} peak, `;
  }
  if (r.bombUpdates > 0) {
    const events: string[] = [];
    if (r.bombPlanted) events.push('planted');
    if (r.bombDefused) events.push('defused');
    if (r.bombExploded) events.push('exploded');
    out +=
      `bomb ${r.bombUpdates} upd/fuse ticked ${r.bombTimerTicked}/` +
      `${r.bombInteractSeen} interact` +
      (events.length > 0 ? `/${events.join('+')}` : '') +
      ', ';
  }
  return out;
}

/**
 * The Gate B streak channel, reported only when it carried something.
 *
 * `entities` counts **distinct instance ids** rather than frames, because a server replicating
 * an empty list twenty times a second is exactly the shape of the bug this is watching for and
 * a frame counter would call it green.
 */
/**
 * Which class client `index` fields.
 *
 * Client 1 (index 1) is the ghost when `--ghost` is set, because the default team assignment
 * alternates and index 1 therefore lands on the opposite side from indices 0 and 2 — which is
 * what makes the other two *enemies* who would see them on a sweep.
 */
function streakHarnessClass(opts: HarnessOptions, index: number): NetLoadout {
  /**
   * `--no-perks` wins over `--ghost`, deliberately — it is what makes the red control possible.
   *
   * `--ghost --no-perks` arms the assertion and strips the perk it is asserting about, which is
   * the run that has to **fail**. Ordered the other way, as this was first written, the control
   * still equips Ghost and reports a clean pass — a probe that cannot go red, which is the exact
   * trap the standing lesson names. It was caught by running it.
   */
  if (opts.noPerks) return { ...LIGHTWEIGHT_CLASS, perks: [null, null, null] };
  if (opts.ghost && index === 1) return GHOST_CLASS;
  return LIGHTWEIGHT_CLASS;
}

/**
 * §8.22's Ghost check: *"show a Ghost player's position absent from the snapshot sent to enemy
 * clients."*
 *
 * The wording of the criterion is worth reading carefully, because the obvious implementation of
 * it is wrong. Removing a Ghost player's **entity** from the snapshot would make their body
 * invisible, and Ghost does not do that — it hides you from UAV intel. So what is asserted here
 * is the absence of the ghost from the **contact list**, and their continued presence in the
 * entity list is what makes it the right absence rather than a bigger one.
 *
 * Asserted against enemies only. A ghost is visible to their own team's UAV by construction —
 * `Uav.onTick` skips friendlies before it ever consults `visibleToUav` — so folding teammates
 * into the check would make it pass for the wrong reason.
 */
function checkGhost(reports: readonly HeadlessClientReport[]): boolean {
  const ghost = reports[1];
  if (ghost === undefined) return true;

  let enemies = 0;
  let leaked = 0;
  for (const r of reports) {
    if (r.name === ghost.name || r.team === ghost.team) continue;
    enemies++;
    if (r.contactIdList.includes(ghost.liveEntityId)) {
      leaked++;
      log.error(
        `GHOST LEAK: ${r.name} (team ${r.team}) saw ${ghost.name} (live entity ${ghost.liveEntityId}) ` +
          `as a UAV contact. Contacts seen: [${r.contactIdList.join(',')}].`,
      );
    }
  }

  if (enemies === 0) {
    log.warn(
      `ghost check inconclusive: no client was on the opposite team from ${ghost.name}. ` +
        'The assertion needs an enemy to be hidden from.',
    );
    return true;
  }
  log.info(
    `ghost check: ${ghost.name} (live entity ${ghost.liveEntityId}, team ${ghost.team}) against ` +
      `${enemies} enemy client(s) — ${leaked} leak(s). ` +
      `Enemy contact sets: ${reports
        .filter((r) => r.team !== ghost.team)
        .map((r) => `${r.name}[${r.contactIdList.join(',')}]`)
        .join(' ')}`,
  );
  return leaked === 0;
}

/** Whether any client can currently see a Chopper Gunner in the sky (§8.23). */
function gunnerFlying(clients: readonly HeadlessClient[]): boolean {
  for (const c of clients) {
    const r = c.report();
    // "Recently" rather than "ever": the question is whether one is up *now*, and a chopper
    // that expired ten seconds ago would otherwise answer yes for the rest of the run.
    if (r.chopperFrames > 0 && nowMs() - r.lastChopperMs < 500) return true;
  }
  return false;
}

/**
 * §8.23 case 4: a gunner who disconnects takes their chopper with them.
 *
 * Asserted against the **survivors**, which is the only place it can be seen — the client that
 * left is not receiving anything. If the chopper outlived its owner, the remaining clients keep
 * being sent it as a live entity, so a `lastChopperMs` after the drop is the leak.
 *
 * The grace window covers the frames genuinely in flight when the socket closed: the drop, the
 * server noticing, and the snapshot cadence. Anything past it is a chopper that is still being
 * simulated for a player who is gone.
 */
function checkDroppedGunner(
  reports: readonly HeadlessClientReport[],
  gunner: HeadlessClientReport | undefined,
  droppedAtMs: number,
  graceMs: number,
): boolean {
  if (gunner === undefined) return true;
  const owner = gunner.liveEntityId;
  let bad = 0;

  for (const r of reports) {
    if (r.name === gunner.name) continue;
    /**
     * **This gunner's** chopper, not any chopper.
     *
     * Every client in the run called one in, so a check for "was a chopper present" stays true
     * from the survivors' own gunships for the full duration and can never see the orphan. The
     * first version of this did exactly that and reported a failure that was really two other
     * players flying normally — it looked like a real bug for as long as it took to read the
     * log. Keyed by owner, the question is the one being asked.
     */
    const last = r.lastChopperMsByOwner.get(owner);
    if (last === undefined) {
      log.info(`${r.name}: never saw a chopper owned by entity ${owner}.`);
      continue;
    }
    const after = last - droppedAtMs;
    if (after > graceMs) {
      bad++;
      log.error(
        `CHOPPER OUTLIVED ITS GUNNER: ${r.name} was still sent entity ${owner}'s chopper ` +
          `${Math.round(after)}ms after they disconnected (grace ${graceMs}ms).`,
      );
    } else {
      log.info(
        `${r.name}: entity ${owner}'s chopper last seen ${Math.round(after)}ms ` +
          `relative to the drop — within the ${graceMs}ms grace.`,
      );
    }
  }
  return bad === 0;
}

/**
 * The grenade channel (§8.24), reported only when it carried something.
 *
 * `remote` counts **distinct grenades thrown by somebody else**, because that is the thing that
 * did not exist before: a client has always drawn its own. A frame counter would go green on a
 * server sending empty lists, and an "any projectile" counter would go green on the client's own
 * predicted throw.
 */
function projectileLine(r: HeadlessClientReport): string {
  if (r.projectileFrames === 0) return '';
  return (
    `grenades ${r.projectileFrames} frm/${r.remoteProjectiles} remote/` +
    `${r.ownProjectileSeen} own-echo/${r.peakProjectiles} peak/${r.smokeFrames} smoke, `
  );
}

function streakLine(r: HeadlessClientReport): string {
  if (r.streakFrames === 0) return '';
  return (
    `streaks ${r.streakFrames} frm/${r.pendingSeen} pend/${r.streakRequests} req/` +
    `${r.streakEntitiesSeen} ent/${r.peakStreakEntities} peak/` +
    `${r.sweepFrames} sweep/${r.contactsSeen} contacts, `
  );
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
    editClass: argv.includes('--edit-class'),
    voteFor: num('--vote', -1),
    grantStreak: get('--grant-streak'),
    ghost: argv.includes('--ghost'),
    dropGunner: argv.includes('--drop-gunner'),
    summaryGate: argv.includes('--summary-gate'),
    abandon: argv.includes('--abandon'),
    throwEveryTicks: Math.max(0, num('--throw', 0)),
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
