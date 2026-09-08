import { installClock, nowMs } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import { EventBus } from '../shared/core/EventBus';
import { NET_PERFECT, describeConditions, parseConditions, type NetConditions } from '../shared/net/NetSim';
import {
  CHEAT_FULL_SPECTATOR,
  Cheat,
  CheatOutcome,
  bitsClearing,
  describeCheatMask,
  toggleCheat,
} from '../shared/cheats/Cheats';
import { CLIENT_TIMEOUT_MS, RECONNECT_GRACE_MS } from '../shared/net/Protocol';
import { isArenaInstance, votePhaseName, type NetLoadout } from '../shared/net/Skirmish';
import type { StreakId } from '../shared/streaks/StreakDefs';
import type { StreakEconomyReport } from '../shared/streaks/StreakLedger';
import type { LifeStockReport } from '../shared/equipment/LifeStockAudit';
import { loadConfig, usesShortenedTimings, type ServerConfig } from './Config';
import { HeadlessClient, type HeadlessClientReport, type SeatSnapshot } from './debug/HeadlessClient';
import type { MatchInstance } from './instance/MatchInstance';
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
 *   npm run skirmish -- --drop-return 3    # 3 drop/return cycles mid-match (F8)
 *   npm run skirmish -- --drop-return 1 --drop-hold 40000   # ...past the grace, on purpose
 *   npm run skirmish -- --cheats            # F14: RED CONTROL — the server must refuse
 *   npm run skirmish -- --cheats --cheats-on   # ...and, with the flag, must honour them
 *   npm run skirmish -- --cheats --cheats-on --cheats-early  # type it in the ARENA (F14 fix)
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
  /**
   * Drop a client mid-match and dial it back in, N times (playtest round 4, F8).
   *
   * The instrument the reconnect session is measured with, and the only place in the project
   * where a return from a disconnect is exercised at all. One client at a time, round-robin, so
   * a run of three cycles asks the question of three different seats rather than three times of
   * one — a seat that only ever survives when it is the *first* to drop would pass otherwise.
   *
   * The drop is **unclean**: `NodeLink.terminate`, no `Bye`. A clean departure frees the seat
   * on purpose and is not what F8 is about.
   */
  readonly dropReturn: number;
  /**
   * How long a dropped client stays away before dialling back in, ms.
   *
   * The one knob that decides which half of the feature a run tests. Below the grace it is the
   * return path; above it, it is the expiry path — the player is told and comes back as
   * somebody new. Both are requirements, and the difference between them is this number, so it
   * is a flag rather than a constant.
   */
  readonly dropHoldMs: number;

  /**
   * Type a cheat code on every client, once the live match is running (round 4, F14).
   *
   * One code per client rather than the same one everywhere, and the assignment is the whole
   * design of the probe: client 0 asks for god mode, client 1 for invisibility, client 2 for the
   * wallet, and any client past the third asks for nothing and is the **control**. So a single
   * run produces the cheat and the un-cheated comparison for the same fight, on the same map,
   * against the same bots — which is the only way "an invisible player takes no hits" means
   * anything, because a run in which nobody was shot at reports the same zero.
   */
  readonly cheats: boolean;
  /**
   * Turn `ServerConfig.cheatsEnabled` on for this run.
   *
   * The flag is environment configuration and defaults to off, so `--cheats` alone is the red
   * control: every code must be refused, and the refusal must reach the client. This is the
   * green half, as a flag rather than an environment variable so both halves are one command
   * line each and neither depends on what a shell was left holding.
   */
  readonly cheatsOn: boolean;
  /**
   * Type the code in the **arena**, so a live entitlement crosses the migration (F14's fix).
   *
   * The run that reproduces the regression F14 shipped, and the run that proves it gone. Without
   * it every code is typed after the only migration in the cycle, so nothing ever crosses one —
   * which is exactly why F14's own green run was green about a bug that was already in it.
   */
  readonly cheatsEarly: boolean;
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

/**
 * Which code each client types, by index (playtest round 4, F14).
 *
 * Atomic codes on purpose. `SPEC[]4` would grant all three at once and make the run unable to
 * tell perception from invulnerability — which is exactly the coupling this session removed from
 * `Spectator.setInvisible`, and it would be no better in a probe than it was in the tool.
 *
 * Index 3 and beyond are `undefined`, and that is the control seat.
 */
const CHEAT_SCRIPT: readonly (string | undefined)[] = ['SPEC[]1', 'SPEC[]2', 'MO951357'];

/**
 * The clearing arithmetic, proved against the real functions on every run (F14's second fix).
 *
 * ## Why this is here and not in `check-cheats.mjs`
 *
 * It was there first, as a re-implementation of `bitsClearing` in JavaScript — that script cannot
 * import TypeScript. Watched red with the real function broken, it stayed **green**: it was
 * proving a property of its own copy. This module is compiled, so it can import the thing itself,
 * and that is the difference between a proof and a restatement.
 *
 * ## The property, and why it is exhaustive rather than sampled
 *
 * `toggleCheat` is a relative move. Toggling a multi-bit set clears it **only** from the mask that
 * already holds every bit; every other mask widens to the full set. Expressing *"turn these off"*
 * as one such toggle is what shipped: a player holding god mode alone was migrated, the teardown
 * asked to toggle all three, the request landed on a mask the migration had cleared to zero, and
 * `0 | God|Unseen|NoClip` arrived in the next match as every cheat on. One bit in, three bits out.
 *
 * `bitsClearing` is the verb that means "off". The state space is eight masks, so the property is
 * decidable rather than sampled: for **every** reachable mask, folding `toggleCheat` over its
 * answer must give exactly `0` — not "not the full mask", exactly zero. That is the assertion the
 * report asked for, over all of the inputs instead of one of them.
 *
 * Pure, allocation-light and instant, so it runs unconditionally at the top of every harness
 * invocation rather than behind a flag. A property that only holds when somebody remembers to
 * pass `--cheats` is a property that will be broken by a run that does not.
 */
function assertClearingArithmetic(): string[] {
  const problems: string[] = [];
  const full = CHEAT_FULL_SPECTATOR;
  let masks = 0;

  for (let mask = 0; mask <= full; mask++) {
    // Masks with bits outside the set are not reachable; the wire filters them on arrival.
    if ((mask & ~full) !== 0) continue;
    masks++;
    let after = mask;
    for (const bit of bitsClearing(mask, full)) after = toggleCheat(after, bit);
    if (after !== 0) {
      problems.push(
        `bitsClearing cannot clear mask ${mask} (${describeCheatMask(mask)}): folding its ` +
          `toggles gives ${after} (${describeCheatMask(after)}), not 0`,
      );
    }
  }

  /**
   * And the single case the report named, spelled out rather than left implied by the loop.
   *
   * "Activate only bit 1, clear, and the result must be exactly 0 and not the full bitmask."
   * It is one of the eight above; it is also the one a reader will look for, and a named
   * assertion is what makes the failure message say which case broke.
   */
  let one = Cheat.God;
  for (const bit of bitsClearing(one, full)) one = toggleCheat(one, bit);
  if (one !== 0) {
    problems.push(
      `clearing god mode alone gives ${one} (${describeCheatMask(one)}), not 0 — this is the ` +
        'reported mutation: a single active cheat becoming the full set',
    );
  }
  // The other half of the same report: the full set must clear too, which it always did.
  let all = full;
  for (const bit of bitsClearing(all, full)) all = toggleCheat(all, bit);
  if (all !== 0) problems.push(`clearing the full set gives ${all}, not 0`);

  if (masks !== 8) {
    problems.push(`expected 8 reachable cheat masks and walked ${masks} — the bit table moved`);
  }
  return problems;
}

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
/**
 * Whether this seat has anything to lose yet (playtest round 4, F8).
 *
 * The drop waits for this rather than for a wall clock, and it took two attempts to get right —
 * both worth recording, because both were probes that could not fail for the reason they
 * claimed:
 *
 * 1. **Six seconds after the match started.** That lands inside the ten-second pre-match
 *    freeze, so every cycle compared `0k/0d/0pt/0sh` against a missing row and declared the
 *    score lost. Right answer, wrong reason, and it would have gone green the day the row was
 *    reclaimed without ever having proved anything about a score.
 * 2. **`shotsFired > 0`.** This harness fields `strafe` and `runner`, and **neither pulls a
 *    trigger** — the flow run's shooting is done by the arena's and the match's bots. The gate
 *    never opened and no cycle ever ran.
 *
 * So it asks whether *any* counter on the row has moved, rather than naming the one this
 *  particular harness happens to move. Here that is `deaths`: these clients are shot at
 * constantly and die every few tens of seconds, and a death is exactly as much a part of the
 * record a reconnect must preserve as a kill is. A run in which no row ever moves completes no
 * cycle and fails as "no drop/return cycle completed", which is the honest outcome rather than
 * a silent pass.
 */
function hasSomethingToLose(score: SeatScore | null): boolean {
  if (score === null) return false;
  return score.kills > 0 || score.deaths > 0 || score.score > 0 || score.shotsFired > 0;
}

/** A seat's authoritative scoreboard row, read from the server at a named instant (F8). */
interface SeatScore {
  readonly entityId: number;
  readonly kills: number;
  readonly deaths: number;
  readonly score: number;
  /**
   * The field that makes the comparison meaningful.
   *
   * Kills and score can honestly be zero for a headless client that had bad luck, and a probe
   * whose only evidence is `0 === 0` proves nothing. Every client in a live match fires, so
   * `shotsFired` is the counter that is reliably non-zero by the time the first drop happens.
   */
  readonly shotsFired: number;
}

/** One drop-and-return cycle, and what it found (playtest round 4, F8). */
interface ReturnCycle {
  readonly client: string;
  readonly entityBefore: number;
  readonly matchBefore: number;
  readonly teamBefore: 'A' | 'B';
  readonly entityAfter: number;
  readonly matchAfter: number;
  readonly teamAfter: 'A' | 'B';
  readonly resyncMs: number;
  readonly scoreBefore: SeatScore | null;
  readonly scoreAfter: SeatScore | null;
  /** Same instance, same entity, same side. The three together are "this is my seat". */
  readonly keptSeat: boolean;
  /** The row this seat came back to is the row it left with, and nothing in it went backwards. */
  readonly keptScore: boolean;
  /**
   * The **team** score, three ways, for playtest round 5's B7.
   *
   * B7 left open whether a client that misses part of a match ever learns the score, or sits on
   * `0 - 0` until the next kill moves it. `rendered` is what the returning client held on its
   * first synchronised frame; `serverAtDrop` and `serverAtReturn` bracket it on the instance.
   * See `sawTheScore` for what is asserted and why it is a bracket rather than an equality.
   */
  readonly renderedOnReturn: TeamScores | null;
  readonly serverAtDrop: TeamScores | null;
  readonly serverAtReturn: TeamScores | null;
  readonly sawTheScore: boolean;
}

/** What one named client was told. Keyed by name because a cycle records the name, not the report. */
function clientNotices(
  reports: readonly HeadlessClientReport[],
  name: string,
): readonly string[] {
  return reports.find((r) => r.name === name)?.notices ?? [];
}

/** Both team scores in one token, or why there are not two. */
function describeTeamScores(t: TeamScores | null): string {
  return t === null ? 'none' : `${t.a}-${t.b}`;
}

/** One seat's row in one line, or why there is not one. Always prints its denominators. */
function describeSeatScore(s: SeatScore | null): string {
  if (s === null) return 'no row';
  return `e${s.entityId} ${s.kills}k/${s.deaths}d/${s.score}pt/${s.shotsFired}sh`;
}

/** Both team scores as the instance holds them, at a named instant (round 5, B7). */
interface TeamScores {
  readonly a: number;
  readonly b: number;
}

function readTeamScores(instance: MatchInstance): TeamScores {
  const flow = instance.match.flow;
  return { a: flow.teamScore('A'), b: flow.teamScore('B') };
}

function readSeatScore(instance: MatchInstance, entityId: number): SeatScore | null {
  const row = instance.match.score.row(entityId);
  if (row === undefined) return null;
  return {
    entityId,
    kills: row.kills,
    deaths: row.deaths,
    score: row.score,
    shotsFired: row.shotsFired,
  };
}

/**
 * Close one cycle: what the seat was, what came back, and whether they are the same seat.
 *
 * `keptScore` is deliberately *not* "the numbers are equal". The match kept running while this
 * client was away and the bot standing in for them was scored on a different row, but a
 * reclaimed row keeps accruing the moment they are back — so equality would fail on a timing
 * accident. What cannot happen to a preserved row is for it to go **backwards**, and that is
 * what is asserted, against the denominators printed beside it.
 */
function closeReturnCycle(
  victim: HeadlessClient,
  after: SeatSnapshot,
  scoreBefore: SeatScore | null,
  teamAtDrop: TeamScores | null,
  server: Server,
): ReturnCycle {
  const report = victim.report();
  const before = report.seatBeforeDrop;
  const instance = server.instances.find((i) => i.id === after.matchId) ?? null;
  const scoreAfter = instance === null ? null : readSeatScore(instance, after.entityId);
  const teamAtReturn = instance === null ? null : readTeamScores(instance);
  const rendered = report.scoreOnReturn;
  /**
   * Did the returning client come back knowing the score? (round 5, B7)
   *
   * A **bracket**, not an equality, and the reason is standing lesson 3: the client's header is
   * up to one snapshot interval old, so a kill landing inside that window makes an exact
   * comparison fail on a timing accident rather than on a bug. What cannot happen if the score
   * replicates is for it to come back *below what it was when this client left* — that is the
   * reset-to-zero B7 asked about — or *above what the server holds now*, which no honest client
   * can be. Both bounds are sampled on the instance, so neither is an invented tolerance.
   */
  const sawTheScore =
    rendered !== null &&
    teamAtDrop !== null &&
    teamAtReturn !== null &&
    rendered.a >= teamAtDrop.a &&
    rendered.b >= teamAtDrop.b &&
    rendered.a <= teamAtReturn.a &&
    rendered.b <= teamAtReturn.b;
  const keptSeat =
    before !== null &&
    before.entityId === after.entityId &&
    before.matchId === after.matchId &&
    before.team === after.team;
  const keptScore =
    scoreBefore !== null &&
    scoreAfter !== null &&
    scoreAfter.entityId === scoreBefore.entityId &&
    scoreAfter.kills >= scoreBefore.kills &&
    scoreAfter.deaths >= scoreBefore.deaths &&
    scoreAfter.score >= scoreBefore.score &&
    scoreAfter.shotsFired >= scoreBefore.shotsFired;
  return {
    client: report.name,
    entityBefore: before?.entityId ?? -1,
    matchBefore: before?.matchId ?? -1,
    teamBefore: before?.team ?? 'A',
    entityAfter: after.entityId,
    matchAfter: after.matchId,
    teamAfter: after.team,
    resyncMs: report.resyncMs,
    scoreBefore,
    scoreAfter,
    keptSeat,
    keptScore,
    renderedOnReturn: rendered,
    serverAtDrop: teamAtDrop,
    serverAtReturn: teamAtReturn,
    sawTheScore,
  };
}

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
      // F14. See `HarnessOptions.cheats` for why the codes differ per client and why the
      // fourth client onwards is deliberately handed nothing.
      cheatCode: opts.cheats ? CHEAT_SCRIPT[i] : undefined,
      cheatInArena: opts.cheatsEarly,
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
  /** The live match's streak economy, sampled while it is running. See below. */
  let observedEconomy: StreakEconomyReport | null = null;
  /** What every life in the live match started holding (round 4, B3). Sampled beside the economy. */
  let observedStock: LifeStockReport | null = null;
  /** Damage the door refused because the target could not be hurt (round 4, F14). */
  let observedBlockedDamage = 0;
  /** When the streak wallet was last topped up, and how many times. See the grant below. */
  let grantedAtMs = 0;
  let grants = 0;
  let gunnerDropped = false;
  let droppedAtMs = 0;
  /** The drop-and-return probe's state machine and its results (round 4, F8). See `ReturnCycle`. */
  const returnCycles: ReturnCycle[] = [];
  let dropPhase: 'idle' | 'down' | 'dialling' = 'idle';
  let dropVictim: HeadlessClient | null = null;
  let dropAtMs = 0;
  let dropScoreBefore: SeatScore | null = null;
  /** The instance's team scores at the instant of the drop. See `ReturnCycle` (round 5, B7). */
  let dropTeamBefore: TeamScores | null = null;
  let dropNext = 0;
  /** When `--abandon` emptied the live match, and whether the server then released it. */
  let abandonedAtMs = 0;
  let abandonedFreedMs = 0;
  let lastCycle = 0;
  let lastPhase = -1;
  const phaseBoundaries: { cycle: number; phase: string; atMs: number }[] = [];
  const startMs = nowMs();

  /** How often `--grant-streak` pays the wallet in. Short enough to outpace a life. */
  const GRANT_INTERVAL_MS = 15_000;

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
       * The economy, sampled here for the same reason the roster is (round 4, B9 + B10).
       *
       * Taken while the live match is running, because the report is folded out of per-entity
       * rows that go away with the instance. A reading taken after it has been destroyed is
       * every field zero, and every field zero passes every check below.
       */
      observedEconomy = running.match.streakEconomy;
      // Same reason, same instant: the audit is folded out of the running match and reads as
      // a clean zero once it is gone.
      observedStock = running.match.equipmentAudit;
      /**
       * Hits the damage door refused outright, sampled here for the same reason (F14).
       *
       * This is the server-side half of `SPEC[]1`, and it is the only half that can be positive:
       * god mode returns *before* the damage event, so from a client both the health and the hit
       * count are absences — and an absence is what a run where nobody engaged looks like too.
       * Counted on the server, at the line that decides it, a non-zero number is a damage tick
       * that reached a god-mode body and was refused.
       */
      observedBlockedDamage = running.match.damage.blockedByInvulnerable;

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

      /**
       * Top the wallet up, repeatedly (round 4, B9 + B10 and the pivot).
       *
       * Was once per match, which is the right shape for an entitlement and the wrong one for a
       * currency: a single grant is spent once and proves only that the debit path runs. Paying
       * in what the streak costs every `GRANT_INTERVAL_MS` puts every client permanently able to
       * afford it, so the only things that can stop them buying it again are the cooldown and
       * the streak still being up — and `maxRepeatsInOneLife` in the economy report is what that
       * looks like from outside. Under B10 it could not exceed 1 whatever the wallet held; the
       * top-up interval is shorter than a UAV's whole lockout on purpose, so a life that lasts
       * long enough to earn it twice will show a 2.
       *
       * Still `debugGrant`, which is the same `credit` a care package uses, so everything
       * downstream of "this player can now afford a UAV" is shipping code.
       */
      if (opts.grantStreak !== null && nowMs() - grantedAtMs > GRANT_INTERVAL_MS) {
        grantedAtMs = nowMs();
        grants++;
        for (const seat of running.sessions) {
          running.match.streaks.debugGrant(seat.player.entityId, opts.grantStreak as StreakId);
        }
      }
    }

    /**
     * Drop one client, wait, and dial it back in (playtest round 4, F8).
     *
     * Four deliberate choices, each of which a simpler version gets wrong:
     *
     * - **It waits for the seat to have earned something** — see `hasSomethingToLose`. "Kept
     *   the score" is only a question worth asking of a seat that had one, and the ten-second
     *   pre-match freeze means a wall-clock delay lands before anybody has fired. The
     *   `scoreBefore` row is printed either way, so a zero is visible as a zero.
     * - **The score is read from the server**, not from the client. What survives a disconnect
     *   is the server's row; the client's copy is a replica that goes away with the socket, so
     *   asking it would be asking the wrong end of the question.
     * - **One cycle at a time, round-robin.** Two clients down at once confounds the seat
     *   question with the roster question, and a probe that always dropped the same client
     *   could not tell a seat that survives from a seat that survives *first*.
     * - **It lives outside the `running` block.** Only the drop needs a live match; the return
     *   has to be able to land after the match has ended, or a cycle straddling the end is
     *   silently never closed and the run reports one fewer than it ran.
     */
    if (opts.dropReturn > 0) {
      const live = server.liveMatch;
      const liveRunning = live !== null && live.running;
      const started = returnCycles.length + (dropPhase === 'idle' ? 0 : 1);

      if (dropPhase === 'idle') {
        if (liveRunning && started < opts.dropReturn && live !== null) {
          const victim = clients[dropNext % clients.length];
          const score =
            victim === undefined || victim.net.matchId !== live.id || victim.droppedOut
              ? null
              : readSeatScore(live, victim.net.entityId);
          // Round-robin advances only on a drop, so a client that is not ready yet is asked
          // again next frame rather than skipped for the rest of the run.
          if (victim !== undefined && hasSomethingToLose(score)) {
            dropNext++;
            dropVictim = victim;
            dropScoreBefore = score;
            dropTeamBefore = readTeamScores(live);
            dropPhase = 'down';
            dropAtMs = nowMs();
            log.info(
              `reconnect cycle ${started + 1}/${opts.dropReturn}: dropping ` +
                `${victim.report().name} (entity ${victim.net.entityId}) for ${opts.dropHoldMs}ms.`,
            );
            victim.dropForReconnect();
          }
        }
      } else if (dropPhase === 'down' && nowMs() - dropAtMs > opts.dropHoldMs) {
        dropPhase = 'dialling';
        const victim = dropVictim;
        if (victim !== null) {
          // Not awaited: this loop *is* the client pump, and a dial that blocked here would
          // stop every other client for the length of a socket handshake.
          void victim.reconnect().catch((err: unknown) => {
            log.error(`reconnect dial failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } else if (dropPhase === 'dialling') {
        const victim = dropVictim;
        const after = victim === null ? null : victim.report().seatAfterReturn;
        if (victim !== null && after !== null) {
          returnCycles.push(
            closeReturnCycle(victim, after, dropScoreBefore, dropTeamBefore, server),
          );
          dropPhase = 'idle';
          dropVictim = null;
          dropScoreBefore = null;
          dropTeamBefore = null;
        }
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
    economy: observedEconomy,
    stock: observedStock,
    blockedDamage: observedBlockedDamage,
    grants,
    returnCycles,
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
  /**
   * The live match's killstreak economy, sampled while it was running (round 4, B9 + B10).
   *
   * Null when no live match was ever observed. Passed in rather than read here, for the same
   * reason the roster counts are: by the time this function runs the instance is gone and every
   * field would be zero — and every field zero passes every check.
   */
  readonly economy: StreakEconomyReport | null;
  /**
   * What every life in the live match started holding (playtest round 4, B3).
   *
   * Null for the same reason `economy` is, and blocking for a stronger one: this is the only
   * measurement in the project that watches a **connected human's** grenades come back, because
   * `HeadlessClient` has no `ClientMatch` and therefore no local hand to look at. The server's
   * copy is the one both halves are supposed to agree with.
   */
  readonly stock: LifeStockReport | null;
  /**
   * Hits the live match's damage door refused outright (playtest round 4, F14).
   *
   * Sampled off the server while the match was running, for the same reason the two above are.
   * It is the only positive evidence god mode actually reached the simulation: the client-side
   * symptoms are both absences, and this is the line that produced them.
   */
  readonly blockedDamage: number;
  /** How many times `--grant-streak` topped the wallets up. Zero without the flag. */
  readonly grants: number;
  /**
   * The drop-and-return cycles this run completed (playtest round 4, F8).
   *
   * Empty without `--drop-return`, and empty is reported as *not exercised* rather than passed:
   * a run in which nobody ever dropped says nothing about what happens when somebody does.
   */
  readonly returnCycles: readonly ReturnCycle[];
}

function reportFlow(input: FlowReportInput): number {
  const { opts, cfg, server, reports, cycleReports, phaseBoundaries, firstInputMs, droppedAtMs } =
    input;
  const economy = input.economy;
  const stock = input.stock;

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
    // B6: what a finished match actually paid, and through which rows. Printed only when a
    // summary arrived, so a run that never ended a match says nothing rather than says zero.
    if (r.summaries > 0) {
      log.info(`  ${r.name} XP: ${r.summaryXpTotal} over ${r.summaryXp.length} row(s) — ${r.summaryXp.join(', ')}`);
    }
    for (const notice of r.notices) log.info(`  notice: ${notice}`);
  }

  reportArena(server, reports);

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
      summaryXp: r.summaryXp,
      summaryXpTotal: r.summaryXpTotal,
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
   * The cheat arithmetic, on **every** run rather than behind `--cheats`.
   *
   * It is a pure property of two shared functions and costs eight iterations, so there is no
   * reason for it to depend on a flag — and the regression it guards shipped precisely because
   * the only probe that touched cheats had to be asked for. See `assertClearingArithmetic`.
   */
  problems.push(...assertClearingArithmetic());
  // F14's block reads its own numbers and returns its own failures, so they join this gate
  // rather than logging beside it and passing.
  if (opts.cheats) problems.push(...reportCheats(input));
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
  /**
   * F10, and the assertion is about the **windows**, not about the arena.
   *
   * The arena number is a control and is printed rather than asserted — see
   * `HeadlessClientReport.briefArenaTicks` for why asserting it would have been a probe that
   * could only be green.
   *
   * This one can genuinely go red, because it is not a question about the predicate: it is a
   * question about the **replicated phase and round** the predicate is fed. *"Round one only"*
   * is the rule, so a client that migrated into two matches may see at most two briefs. More
   * than that means the server sent `WARMUP` with `round <= 1` again inside a match — a
   * Search & Destroy series re-entering round one, or a flow reset that should not have
   * happened — and the visible symptom would be the objective banner reappearing over a live
   * round, which is what round three's stale-overlay report looked like from the outside.
   */
  const briefWindowsTotal = reports.reduce((n, r) => n + r.briefWindows, 0);
  const liveMigrations = reports.reduce((n, r) => n + r.intoLiveWindows.length, 0);
  if (briefWindowsTotal > liveMigrations) {
    problems.push(
      `the mode brief opened ${briefWindowsTotal} time(s) across ${liveMigrations} migration(s) ` +
        'into a live match — it is a round-one surface and opened more than once (F10)',
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

  /**
   * The killstreak economy, over a real connection (playtest round 4, B9 + B10).
   *
   * Two blocking assertions and their denominator, because every one of these counters is zero
   * in a run where nobody ever killed anybody:
   *
   * - **The balance is never negative.** It is the model's floor: `charge` refuses what the
   *   balance cannot cover, so a negative reading means something reached the wallet without
   *   passing the one door — which is the whole failure mode this session exists to prevent.
   * - **The kill anchor never goes backwards inside a match.** `foldKills` measures a delta
   *   against `PlayerScore.kills`, and a count that resets under it would silently starve every
   *   balance for the rest of the run while looking like nothing at all.
   *
   * `walletsAtLifeStart` is asserted against `walletsAtRoundBoundary` since P5 decided the row:
   * a wallet survives a round boundary on purpose and survives nothing else, so the two counts —
   * one taken at the spawn, one at the round turn — have to be the same number. Both are about
   * the **wallet**; the cooldowns that replaced the once-per-life rule are meant to cross a
   * death, so they are reported beside these rather than asserted against anything.
   */
  if (economy === null) {
    log.warn('streak economy: NOT SAMPLED — no live match was observed running in this run.');
  } else {
    if (economy.negativeBalances > 0) {
      problems.push(`${economy.negativeBalances} negative streak balance(s) — the debit door was bypassed (B9)`);
    }
    if (economy.resyncs > 0) {
      problems.push(`${economy.resyncs} kill-anchor resync(s) inside a live match — the balance was starved (B9)`);
    }
    if (economy.walletsAtLifeStart !== economy.walletsAtRoundBoundary) {
      problems.push(
        `${economy.walletsAtLifeStart} life-start(s) inherited a balance against ` +
          `${economy.walletsAtRoundBoundary} round boundary carry-over(s) — a wallet crossed a death (B9)`,
      );
    }
    log.info(
      `streak economy: ${economy.lives} life/lives, ${economy.lifeStarts} life-start(s) ` +
        `(${economy.walletsAtLifeStart} inheriting a balance); banked ${economy.killsBanked} + ` +
        `${economy.credited} credited, spent ${economy.spent}, peak balance ${economy.peakBalance}; ` +
        `${economy.postMortemKills} post-mortem kill(s) dropped; ` +
        `${economy.activations} activation(s) over ${input.grants} wallet top-up(s), most in one ` +
        `life ${economy.maxBuysInOneLife}, most of one streak in one life ` +
        `${economy.maxRepeatsInOneLife}; refused ${economy.refusedUnaffordable} unaffordable / ` +
        `${economy.refusedCooling} cooling / ${economy.refusedLive} already up; ` +
        `${economy.cooldownsCrossingDeath} cooldown(s) crossed a death; entitlement per life ` +
        `${economy.thresholdGrants} threshold / ${economy.balancePurchases} once-per-life / ` +
        `${economy.balanceRepeatPurchases} with repeats.`,
    );
  }

  /**
   * Every life's opening grenade stock, over a real connection (playtest round 4, B3).
   *
   * Blocking, and the denominator is reported beside it: "0 partial" out of no lives at all is
   * what a probe that never fired looks like, and this milestone has shipped three of those.
   */
  if (stock === null) {
    log.warn('per-life stock: NOT SAMPLED — no live match was observed running in this run.');
  } else {
    if (stock.partialStock > 0) {
      problems.push(
        `${stock.partialStock} of ${stock.lifeStarts} life-start(s) began with partial ` +
          `equipment — the per-life refill did not reach them (B3)`,
      );
    }
    log.info(
      `per-life stock: ${stock.lifeStarts} life-start(s) examined ` +
        `(${stock.humanLifeStarts} human, ${stock.botLifeStarts} bot), ` +
        `${stock.partialStock} with partial stock, ${stock.emptyStock} empty; ` +
        `${stock.observedStock} grenades held against ${stock.expectedStock} expected.`,
    );
  }

  /**
   * Reconnect and join-in-progress (playtest round 4, F8).
   *
   * Three blocking assertions and every denominator printed beside them:
   *
   * - **The seat comes back.** Same instance, same entity id, same side. The entity id is the
   *   whole of it — the score row, the streak ledger, the hand and the rewind history are all
   *   keyed by it, so a seat that returns with a different id has returned with none of them.
   * - **The score comes back with it**, and this is the half that used to fail in a way nobody
   *   could see: the row survives a disconnect on purpose (`Match.removePlayer` keeps it), and
   *   a returning player who could not reclaim it accrued a *second* row while the first sat on
   *   the board attributed to a bot.
   * - **The return does not diverge.** A returning client is exactly the case §4.18's discard
   *   list is about, so its hash samples are counted separately — and zero mismatches over zero
   *   samples fails as loudly as it does everywhere else in this harness.
   *
   * The resync time is a **reading**, not an assertion. There is no threshold anybody has
   * agreed to, and inventing one here would be the magic number P0 bans; what is asserted is
   * that a synchronised frame arrived at all.
   */
  const cycles = input.returnCycles;
  if (opts.dropReturn > 0 && cycles.length === 0) {
    problems.push(
      `--drop-return ${opts.dropReturn} was set and no drop/return cycle completed — ` +
        'either no live match ran long enough or nobody came back (F8)',
    );
  }
  if (cycles.length > 0) {
    const keptSeat = cycles.filter((c) => c.keptSeat).length;
    const keptScore = cycles.filter((c) => c.keptScore).length;
    const resynced = cycles.filter((c) => c.resyncMs >= 0).length;
    /**
     * Past the grace, the assertion inverts (F8's failure branch, and join-in-progress).
     *
     * The same shape as a `--fault` run: a probe that deliberately breaks the precondition must
     * be judged against what *should* then happen, or it reports a correct refusal as a failure
     * and teaches its reader to ignore the result. Held past `RECONNECT_GRACE_MS`, the seat is
     * gone by design and the requirements become the other two thirds of F8:
     *
     * - **They must not get the seat back.** A grace that can be redeemed after it expires is
     *   not a grace, and the entry would be claimable for as long as the match ran.
     * - **They must land in the running match anyway**, not in the arena. That is
     *   join-in-progress, and it is the same assertion inverted: same instance, different
     *   entity. Before this session a returning player went to the arena either way, which is
     *   why "kept the seat" and "joined the match" have to be separate questions.
     * - **They must be told.** F8 asks for it in as many words, and a silent demotion to a new
     *   player is a bug report waiting to be filed twice.
     */
    const graceExpired = opts.dropHoldMs >= RECONNECT_GRACE_MS;
    if (graceExpired) {
      const stillGotSeat = cycles.filter((c) => c.keptSeat).length;
      const joinedTheMatch = cycles.filter((c) => c.matchAfter === c.matchBefore).length;
      const told = cycles.filter((c) => clientNotices(reports, c.client).length > 0).length;
      if (stillGotSeat > 0) {
        problems.push(
          `${stillGotSeat} of ${cycles.length} reconnect(s) got a seat back after the ` +
            `${RECONNECT_GRACE_MS}ms grace had expired — the grace does not expire (F8)`,
        );
      }
      if (joinedTheMatch < cycles.length) {
        problems.push(
          `${cycles.length - joinedTheMatch} of ${cycles.length} client(s) whose grace expired ` +
            'landed outside the running match — join-in-progress did not happen (F8)',
        );
      }
      if (told < cycles.length) {
        problems.push(
          `${cycles.length - told} of ${cycles.length} client(s) lost their seat and were not ` +
            'told (F8)',
        );
      }
      log.info(
        `reconnect (grace expired on purpose, held ${opts.dropHoldMs}ms against a ` +
          `${RECONNECT_GRACE_MS}ms grace): ${cycles.length} cycle(s), ${stillGotSeat} kept the ` +
          `seat (must be 0), ${joinedTheMatch} joined the running match, ${told} were told.`,
      );
    }
    if (!graceExpired && keptSeat < cycles.length) {
      problems.push(
        `${cycles.length - keptSeat} of ${cycles.length} reconnect(s) did not get their seat ` +
          'back — a returning player was given a new entity, in a new instance, or on a new side (F8)',
      );
    }
    if (!graceExpired && keptScore < cycles.length) {
      problems.push(
        `${cycles.length - keptScore} of ${cycles.length} reconnect(s) lost their scoreboard ` +
          'row — the kills they earned are on the board without them (F8)',
      );
    }
    if (resynced < cycles.length) {
      problems.push(
        `${cycles.length - resynced} of ${cycles.length} reconnect(s) never reached a ` +
          'synchronised frame after dialling back in (F8)',
      );
    }
    /**
     * The score a returning client renders on its first frame back (playtest round 5, B7).
     *
     * B7 raised two possibilities and asked which. One was that the score does not replicate on
     * this path — that a player who joins or rejoins mid-match reads `0 - 0` on the banner until
     * the next kill moves it, *"a real, visible, shipping bug ... invisible to every previous
     * round, because every previous round joined at the start"*. This is the number that
     * settles it, and it is asserted whichever way it lands: it is the property a player cares
     * about, and it had never been measured.
     */
    const sawScore = cycles.filter((c) => c.sawTheScore).length;
    if (sawScore < cycles.length) {
      problems.push(
        `${cycles.length - sawScore} of ${cycles.length} reconnect(s) came back without the ` +
          'score — the first frame after a return did not carry what the instance held (B7)',
      );
    }
    const returnSamples = reports.reduce((n, r) => n + r.hashSamplesAfterReturn, 0);
    const returnMismatches = reports.reduce((n, r) => n + r.hashMismatchesAfterReturn, 0);
    if (returnMismatches > 0) {
      problems.push(
        `${returnMismatches} confirmed divergence(s) over ${returnSamples} sample(s) taken ` +
          'after a reconnect — the return did not resync every channel (F8, §4.18)',
      );
    }
    const held = server.reconnectStats;
    /**
     * The registry must not still be holding anything.
     *
     * A reservation outlives the connection that made it by design, and the only thing that
     * bounds it is `forgetMatch` at the live match's teardown. A run that ends with entries
     * still in the map is either a match that was never destroyed or a bound that does not
     * work, and both are the shape §8.13's hundred cycles exist to catch — one entry per player
     * per match is a slow leak in the part of the process that is meant to be stateless.
     */
    if (held.held > 0) {
      problems.push(
        `${held.held} reconnect reservation(s) still held at the end of the run — the registry ` +
          'is not released with the match it belongs to (F8)',
      );
    }
    log.info(
      `reconnect: ${cycles.length} cycle(s), ${keptSeat} kept the seat, ${keptScore} kept the ` +
        `score, ${resynced} resynced, ${sawScore} came back knowing the team score; ` +
        `divergence after return ${returnMismatches}/${returnSamples}` +
        (returnSamples === 0 ? ' (NOT EXERCISED — no hash arrived after a return)' : '') +
        `; registry ${held.reserved} reserved / ${held.claimed} claimed / ${held.expired} expired ` +
        `/ ${held.unknown} unknown, ${held.held} still held (must be 0)`,
    );
    for (const c of cycles) {
      log.info(
        `  ${c.client}: entity ${c.entityBefore}@${c.matchBefore}/${c.teamBefore} -> ` +
          `${c.entityAfter}@${c.matchAfter}/${c.teamAfter}` +
          `${c.keptSeat ? '' : '  SEAT LOST'}, resync ${c.resyncMs}ms, ` +
          `score ${describeSeatScore(c.scoreBefore)} -> ${describeSeatScore(c.scoreAfter)}` +
          `${c.keptScore ? '' : '  SCORE LOST'}` +
          `; team ${describeTeamScores(c.serverAtDrop)} at drop -> rendered ` +
          `${describeTeamScores(c.renderedOnReturn)} -> ${describeTeamScores(c.serverAtReturn)} ` +
          `on the instance${c.sawTheScore ? '' : '  TEAM SCORE LOST'}`,
      );
    }
  } else if (opts.dropReturn === 0) {
    log.info('reconnect: NOT EXERCISED — pass --drop-return N to run drop/return cycles.');
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

/**
 * F14's block, and every number in it is printed next to the control that makes it mean
 * something (playtest round 4).
 *
 * Three claims, and none of them is checkable on its own:
 *
 * - **Refusal.** With `cheatsEnabled` off, every code must come back refused. Counted against
 *   the codes *sent*, because "0 grants" is also what a run in which nobody typed anything says.
 * - **God mode reached the simulation.** The client sees two absences — full health, no hits —
 *   and a run where nothing engaged reports the same pair. `blockedDamage` is the server's own
 *   count of hits the door refused, and it is what turns the absence into evidence.
 * - **Invisibility is perception and not invulnerability.** The invisible client must take no
 *   hits *while* `blockedDamage` accounts only for the god-mode one — otherwise the two codes
 *   are indistinguishable and one counter is measuring both. The control client is what says the
 *   bots were shooting at people at all.
 *
 * Returns the failures rather than logging them, so they join the run's own gate.
 */
function reportCheats(input: FlowReportInput): string[] {
  const { opts, cfg, reports, blockedDamage } = input;
  const problems: string[] = [];

  const sent = reports.reduce((n, r) => n + r.cheatRequests, 0);
  const answered = reports.reduce((n, r) => n + r.cheatOutcomes.length, 0);
  const refusals = reports.reduce(
    (n, r) => n + r.cheatOutcomes.filter((o) => o === CheatOutcome.RefusedDisabled).length,
    0,
  );
  const grants = reports.reduce(
    (n, r) =>
      n +
      r.cheatOutcomes.filter(
        (o) => o === CheatOutcome.Granted || o === CheatOutcome.InstantApplied,
      ).length,
    0,
  );

  log.info(
    `cheats (F14): flag ${cfg.cheatsEnabled ? 'ON' : 'off'}, ` +
      `${sent} code(s) typed, ${answered} answered, ${refusals} refused, ${grants} granted`,
  );
  for (const r of reports) {
    log.info(
      `  ${r.name}: code ${r.cheatRequests > 0 ? 'sent' : 'none'}, ` +
        `mask ${r.cheatMask} (${describeCheatMask(r.cheatMask)}), ` +
        `outcomes [${r.cheatOutcomes.join(',')}], ` +
        `live health floor ${r.liveMinHealth > 100 ? 'never sampled' : r.liveMinHealth}, ` +
        `${r.liveHitsTaken} hit(s) taken (${r.liveHitsWhileCheated} after the grant), ` +
        `${r.liveDeaths} death(s)`,
    );
  }
  log.info(`  server refused ${blockedDamage} hit(s) at the damage door (god mode)`);

  /**
   * The lifetime assertion (F14's fix), and it blocks.
   *
   * An entitlement is granted against an entity in one instance, and a migration destroys that
   * entity along with its streak ledger row. So a mask held anywhere other than the instance the
   * code was typed in is the regression, whatever the tag happens to say. `cheatTicks` is printed
   * beside it so a zero that means *"never held anything"* is distinguishable from a zero that
   * means *"never leaked"* — the same property the divergence checker's `hashSamples` carries.
   */
  const leakedTicks = reports.reduce((n, r) => n + r.cheatTicksInOtherInstance, 0);
  const heldTicks = reports.reduce((n, r) => n + r.cheatTicks, 0);
  const leakedTagTicks = reports.reduce((n, r) => n + r.cheatTagTicksInOtherInstance, 0);
  log.info(
    `  entitlement held ${heldTicks} tick(s); ${leakedTicks} of them in an instance it was not ` +
      `granted in (must be 0), tag up ${leakedTagTicks} tick(s) there`,
  );
  if (leakedTicks > 0) {
    problems.push(
      `${leakedTicks} tick(s) of cheat entitlement held in an instance it was not granted in`,
    );
  }
  if (leakedTagTicks > 0) {
    problems.push(`${leakedTagTicks} tick(s) of cheat tag shown in an instance it was not granted in`);
  }

  // A probe that never fired is not a probe that passed. Same shape as the divergence
  // checker's `hashSamples === 0` branch and F8's "no drop/return cycle completed".
  if (sent === 0) {
    problems.push('--cheats was set but no client ever reached a live match to type a code');
    return problems;
  }
  if (answered < sent) {
    problems.push(`${sent} cheat code(s) typed and only ${answered} were answered`);
  }

  if (!cfg.cheatsEnabled) {
    // The red control, and it is the assertion rather than a reading: a server with cheats off
    // must refuse every one, must say so, and must grant nothing.
    if (refusals !== sent) {
      problems.push(`cheats are disabled and only ${refusals} of ${sent} codes were refused`);
    }
    if (grants !== 0) problems.push(`cheats are disabled and ${grants} code(s) were granted`);
    const leaked = reports.filter((r) => r.cheatMask !== 0);
    if (leaked.length > 0) {
      problems.push(
        `cheats are disabled and ${leaked.length} client(s) hold a non-zero entitlement mask`,
      );
    }
    return problems;
  }

  if (grants !== sent) problems.push(`${sent} codes typed with the flag on and ${grants} granted`);

  if (opts.cheatsEarly) {
    /**
     * `--cheats-early` only means something if the codes really were typed before the migration.
     * A run where a client never reached the arena, or reached it after the ballot, would type
     * nothing and pass the leak assertion by never having anything to leak.
     */
    const inArena = reports.filter((r) => isArenaInstance(r.cheatMatchId)).length;
    if (inArena !== sent) {
      problems.push(
        `--cheats-early: ${sent} code(s) typed and only ${inArena} of them in the arena`,
      );
    }
    const migrated = reports.filter((r) => r.migrations > 0).length;
    if (migrated === 0) {
      problems.push('--cheats-early: nobody migrated, so no entitlement ever crossed a boundary');
    }
  }

  const god = reports[0];
  const unseen = reports[1];
  const control = reports.length > 3 ? reports[3] : undefined;

  /**
   * **These three assertions invert under `--cheats-early`**, and saying so is the point.
   *
   * The same shape as F8's `--drop-hold 35000` run: judged by the ordinary gate, a correct
   * refusal reads as a failure. Typed in the live match, the entitlement must be *held* and the
   * damage door must refuse something, or nothing was granted. Typed in the **arena**, the
   * migration must have taken all of it away, so the identical numbers mean the opposite — and a
   * run that demanded a live mask there would fail on the fix and pass on the bug.
   *
   * Written as one branch rather than as a loosened test that accepts both, because a check that
   * accepts either answer is a check that has stopped asking.
   */
  if (opts.cheatsEarly) {
    for (const r of reports) {
      if (r.cheatMask !== 0) {
        problems.push(
          `${r.name} typed a code in the arena and still holds mask ${r.cheatMask} after ` +
            'migrating; the entitlement belongs to the seat it was granted on',
        );
      }
    }
    if (blockedDamage !== 0) {
      problems.push(
        `god mode was typed in the arena and the live match's damage door still refused ` +
          `${blockedDamage} hit(s) — the entitlement crossed the migration`,
      );
    }
    return problems;
  }

  if (god !== undefined) {
    if (god.cheatMask !== Cheat.God) {
      problems.push(`the god-mode client holds mask ${god.cheatMask}, expected ${Cheat.God}`);
    }
    if (blockedDamage === 0) {
      // Not "god mode is broken" — it may be that nothing shot at anybody. The distinction is
      // the reason the control's hits are printed above.
      problems.push('god mode was granted and the damage door refused nothing all match');
    }
  }
  if (unseen !== undefined && unseen.cheatMask !== Cheat.Unseen) {
    problems.push(`the invisible client holds mask ${unseen.cheatMask}, expected ${Cheat.Unseen}`);
  }
  if (control !== undefined && control.cheatMask !== 0) {
    problems.push('the control client holds an entitlement it never asked for');
  }
  return problems;
}

function harnessConfig(opts: HarnessOptions): ServerConfig {
  const base = loadConfig(process.env);
  return {
    ...base,
    port: opts.port,
    host: '127.0.0.1',
    faultInjection: opts.fault !== 'none',
    metricsSeconds: 0,
    // F14. `--cheats` on its own leaves this at the shipped default of off, which is what makes
    // the plain run the red control rather than a second thing to remember to arrange.
    cheatsEnabled: opts.cheatsOn || base.cheatsEnabled,
  };
}

/**
 * The waiting room, and the four things F7 and F12 say must not be true of it (round 4, §P6).
 *
 * Printed as one block rather than folded into the per-client line because all of it is about
 * one instance, and because three of the numbers are only meaningful next to their control:
 * a health floor next to the hits that produced it, an edge count next to the broadcasts a
 * level-triggered effect would have fired on, and a caption count next to where it must never
 * have appeared.
 *
 * The score rows are read off the arena's own `ScoreSystem` rather than inferred from a
 * client, because that is where the room's "results" live — the client's board is a copy of it.
 */
function reportArena(server: Server, reports: readonly HeadlessClientReport[]): void {
  // The instance kind, not the id. See `MatchInstance.isArena`.
  const arena = server.instances.find((i) => i.isArena);
  const rows = arena?.match.score.rows.length ?? -1;
  const sampled = reports.filter((r) => r.warmupMinHealth <= 100);
  const floor = sampled.length === 0 ? -1 : Math.min(...sampled.map((r) => r.warmupMinHealth));
  const hits = reports.reduce((sum, r) => sum + r.warmupHitsTaken, 0);
  const deaths = reports.reduce((sum, r) => sum + r.warmupDeaths, 0);
  const opens = reports.reduce((sum, r) => sum + r.ballotOpens, 0);
  const broadcasts = reports.reduce((sum, r) => sum + r.ballotBroadcasts, 0);
  const captionArena = reports.reduce((sum, r) => sum + r.captionArenaTicks, 0);
  const captionLive = reports.reduce((sum, r) => sum + r.captionWaitingInLiveTicks, 0);
  const briefTicks = reports.reduce((sum, r) => sum + r.briefTicks, 0);
  const briefWindows = reports.reduce((sum, r) => sum + r.briefWindows, 0);
  const briefArena = reports.reduce((sum, r) => sum + r.briefArenaTicks, 0);

  log.info(
    `arena (F7): score rows ${rows}, ` +
      `health floor ${floor < 0 ? 'never sampled' : floor} over ${hits} hit(s) taken, ` +
      `${deaths} death(s) in the room`,
  );
  const worstOpens = Math.max(0, ...reports.map((r) => r.ballotOpens));
  const worstBroadcasts = Math.max(0, ...reports.map((r) => r.ballotBroadcasts));
  log.info(
    `arena (F13): ballot cue fires ${opens} time(s) across ${reports.length} client(s), ` +
      `worst ${worstOpens} for one client — one per ballot opening, so two per cycle; ` +
      `level-triggered on the broadcast it would fire ${broadcasts} (worst ${worstBroadcasts})`,
  );
  log.info(
    `arena (F12): caption up ${captionArena} tick(s) in the room, ` +
      `${captionLive} tick(s) of WAITING in a live match (must be 0)`,
  );
  const resultsInArena = reports.reduce((sum, r) => sum + r.resultSurfacesInArenaTicks, 0);
  const resultsLive = reports.reduce((sum, r) => sum + r.resultSurfacesLiveTicks, 0);
  log.info(
    `arena (F7 surfaces): banner/board/streaks up ${resultsInArena} tick(s) in the room ` +
      `(must be 0), ${resultsLive} tick(s) in a live match (the control — must not be 0)`,
  );
  /**
   * F10, printed here because it is the same question as F12 — *where is this client* — and the
   * arena is the control for both. The window count is the denominator: `briefTicks` alone
   * cannot distinguish one ten-second brief from a banner that never came down.
   */
  log.info(
    `brief (F10): up ${briefTicks} tick(s) over ${briefWindows} window(s) in live matches; ` +
      `without the arena term the same rule would have run ${briefArena} tick(s) in the room`,
  );

  metric('skirmish', 'arena', {
    scoreRows: rows,
    healthFloor: floor,
    hitsTaken: hits,
    deaths,
    ballotOpens: opens,
    ballotBroadcasts: broadcasts,
    worstBallotOpens: worstOpens,
    worstBallotBroadcasts: worstBroadcasts,
    captionArenaTicks: captionArena,
    captionWaitingInLiveTicks: captionLive,
    resultSurfacesInArenaTicks: resultsInArena,
    resultSurfacesLiveTicks: resultsLive,
    briefTicks,
    briefWindows,
    briefArenaTicks: briefArena,
  });
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
    dropReturn: Math.max(0, num('--drop-return', 0)),
    dropHoldMs: Math.max(0, num('--drop-hold', 3000)),
    cheats: argv.includes('--cheats'),
    cheatsOn: argv.includes('--cheats-on'),
    cheatsEarly: argv.includes('--cheats-early'),
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
