import { nowMs } from '../../shared/core/Clock';
import { createGameBus, type GameBus } from '../../shared/core/Events';
import { Btn, CommandRing, type InputCommand } from '../../shared/core/InputCommand';
import { DT } from '../../shared/core/Loop';
import { Rng } from '../../shared/core/Rng';
import { simSin } from '../../shared/core/SimMath';
import type { VoteInfo, WelcomeInfo } from '../../shared/net/Messages';
import { NetClient, type NetClientStats } from '../../shared/net/NetClient';
import type { NetConditions } from '../../shared/net/NetSim';
import {
  MAP_BALLOT,
  MODE_BALLOT,
  sanitiseNetLoadout,
  VotePhase,
  WARMUP_MATCH_ID,
  type NetLoadout,
} from '../../shared/net/Skirmish';
import { resolveLoadout } from '../../shared/meta/Loadouts';
import { DEFAULT_INTERPOLATION_DELAY_MS, makeInterpolatedPose } from '../../shared/net/Interpolation';
import { EFlag } from '../../shared/net/Snapshot';
import {
  cloneMovementConfig,
  DEFAULT_MOVEMENT_CONFIG,
} from '../../shared/player/MovementConfig';
import { PlayerController } from '../../shared/player/PlayerController';
import { findMap } from '../../shared/modes/ModeRegistry';
import { loadMapCollision } from '../../shared/world/MapLoader';
import { NodeLink } from './NodeLink';

/**
 * A client with no browser (M10, S7).
 *
 * Runs the **real** client netcode — `NetClient`, `Prediction`, `ClockSync`,
 * `EntityInterpolator` — against a real socket, driven by a scripted input pattern instead of
 * a keyboard. What it does not have is a renderer, an audio graph or a viewmodel, none of
 * which affect a single number this milestone is measured on.
 *
 * ## What it is for
 *
 * Three things, and they are the reason it was worth building before the browser client:
 *
 * 1. **Verification.** S8's criteria 4, 5, 6, 10 and 12 are all measurements, and a
 *    measurement taken by hand in a browser is a measurement taken once. This takes them
 *    repeatedly and identically.
 * 2. **Soak.** S7 asks for a networked match that can be left running unattended.
 * 3. **Proving the prediction code is runtime-agnostic.** If `NetClient` ever reaches for a
 *    browser API, this stops compiling — which is a better guarantee than a rule.
 *
 * ## The input script
 *
 * Deliberately not a `BotBrain`. A bot's job is to play well; this one's job is to exercise
 * the netcode, which means doing the things that are *hard* to predict and replicate:
 * strafing hard enough that lag compensation matters, jumping, crouching, sprinting into
 * walls, and firing in bursts. It is seeded, so two runs at different simulated latencies are
 * driving the identical input and their numbers are comparable.
 */

export type ClientBehaviour = 'strafe' | 'idle' | 'runner' | 'shooter' | 'seeker';

/**
 * How long after a migration mispredictions are attributed to it (§7, §8.9).
 *
 * *"Misprediction count in the first 60 ticks after migration, which is the direct regression
 * test for Tier 1 #20."* One second at 60 Hz — long enough for the first reconciliation to
 * have happened several times over, short enough that ordinary in-match corrections from a
 * lossy link are not swept into the number.
 */
const POST_MIGRATION_WINDOW_TICKS = 60;

/**
 * How long after joining counts as "at spawn" (M11 playtest, bug 1).
 *
 * Four seconds. Sized from what it is watching: `ClockSync` keeps a sixteen-sample window at
 * 4 Hz, so a bad offset estimate takes about four seconds to be displaced. A window shorter
 * than that would miss the tail of the problem; much longer and ordinary in-match corrections
 * start to dominate the number.
 */
const SPAWN_WINDOW_TICKS = 240;

export interface HeadlessClientOptions {
  readonly url: string;
  readonly name: string;
  readonly mapId: string;
  readonly conditions: NetConditions;
  readonly behaviour: ClientBehaviour;
  readonly seed: number;
  /** Ask the server for the rewind debug feed. */
  readonly wantRewindDebug?: boolean;

  // -- M11: the skirmish flow -------------------------------------------------

  /**
   * The class to send after joining (Tier 1 #20), or undefined to send none.
   *
   * §8.10 asks for a demonstration *"with Lightweight equipped"* that client and server agree
   * about speed from the first tick of the live match. That is only meaningful if the harness
   * can actually field a movement perk, so this is how it does it.
   */
  readonly loadout?: NetLoadout;
  /**
   * Which ballot option to vote for, or -1 to abstain.
   *
   * Abstaining is not a gap in the harness — §4.20 requires an empty ballot to resolve
   * randomly and §8.4 requires that to be demonstrated, so a client that votes for nothing is
   * a test case rather than a client that forgot.
   */
  readonly voteFor?: number;
  /**
   * Milliseconds to spend "building" a map before reporting ready (§6.5).
   *
   * Stands in for the browser's mesh and texture build, which this process has no GPU for. Set
   * high to make one client miss the readiness timeout on purpose — that is §8.8's deliberately
   * slow client.
   */
  readonly buildMs?: number;
  /**
   * Send this class as a mid-session change, `editAfterTicks` into the run (§6.6).
   *
   * Exercises the Edit-Class-in-warmup path end to end: the client sends `MsgC.Loadout`, the
   * server validates it, queues it, and applies it on the player's **next spawn** rather than
   * to the standing body. Undefined never sends one.
   */
  readonly editClass?: NetLoadout;
  readonly editAfterTicks?: number;
}

export interface HeadlessClientReport {
  readonly name: string;
  readonly entityId: number;
  readonly state: string;
  readonly closeReason: string;
  readonly stats: NetClientStats;
  readonly mispredictions: number;
  readonly comparisons: number;
  readonly mispredictionP50: number;
  readonly mispredictionP99: number;
  readonly maxReplayDepth: number;
  readonly ticksSimulated: number;
  /** Damage events in which this client was the shooter. */
  readonly hitsDealt: number;
  readonly shotsFired: number;
  readonly killsDealt: number;
  readonly deaths: number;
  /** Remote entities currently tracked. */
  readonly remotes: number;
  /** Deaths this client has been through. */
  readonly deathCycles: number;
  /**
   * Metres travelled **since the most recent respawn**.
   *
   * The unattended detector for a frozen player. A client that dies and comes back unable to
   * move looks completely healthy on every other number here — it is connected, its RTT is
   * fine, it is receiving snapshots and mispredicting nothing — because standing still is
   * something a client does correctly. This is the one figure that goes to zero and stays
   * there, which is exactly the M10 playtest bug.
   */
  readonly metresSinceRespawn: number;

  // -- M11 ---------------------------------------------------------------------

  /** Which instance this client is in. `WARMUP_MATCH_ID` is the arena. */
  readonly matchId: number;
  readonly migrations: number;
  /**
   * Mispredictions in the first 60 ticks after each migration (§7, §8.9).
   *
   * **The direct regression test for Tier 1 #20.** Expected zero. A non-zero value means the
   * loadout was not locked before the entity existed, and the arithmetic is unforgiving: the
   * shipped ASSAULT class carries Lightweight at +7%, so a client predicting with it against a
   * server simulating without it diverges on every single tick.
   *
   * Counted per migration and reported as the worst window rather than the total, because one
   * bad transition among twenty is still the bug and a sum would hide it behind nineteen
   * clean ones.
   */
  /**
   * Mispredictions in the first four seconds after joining. See `SPAWN_WINDOW_TICKS`.
   *
   * The playtest's "severe rubberbanding at spawn" in one number.
   */
  /** Objective broadcasts received, and how many carried an owned (non-neutral) zone. */
  readonly objectiveUpdates: number;
  readonly objectivesOwned: number;
  /** Tag broadcasts, distinct tag ids ever seen, and the most on the floor at once. */
  readonly tagUpdates: number;
  readonly tagsSeen: number;
  readonly peakTags: number;
  /** Bomb broadcasts, and what was observed happening to it. */
  readonly bombUpdates: number;
  readonly bombPlanted: boolean;
  readonly bombDefused: boolean;
  readonly bombExploded: boolean;
  readonly bombInteractSeen: number;
  /** Frames on which the fuse was seen to *decrease*. Zero means a frozen timer. */
  readonly bombTimerTicked: number;
  readonly spawnWindowMispredictions: number;
  readonly worstPostMigrationMispredictions: number;
  readonly postMigrationWindows: readonly number[];
  /**
   * Windows for migrations **into a live match** — §8.9's actual subject.
   *
   * This is where the loadout is locked and where Tier 1 #20's divergence would appear. Zero
   * is the requirement and zero is what it measures.
   */
  readonly intoLiveWindows: readonly number[];
  /** Windows for migrations back to the arena. Reported separately; see PLAN.md. */
  readonly toArenaWindows: readonly number[];
  /** Where inside a 60-tick window each misprediction landed. Empty when the window is clean. */
  readonly migrationMispredictionTicks: readonly number[];
  /** Background builds completed, and the longest one, ms. */
  readonly buildsCompleted: number;
  readonly worstBuildMs: number;
  /** Summaries received. One per match played (§6.9). */
  readonly summaries: number;
  readonly notices: readonly string[];
  /** Vote phases this client cast a vote in. */
  readonly votesCast: number;
}

export class HeadlessClient {
  readonly link: NodeLink;
  readonly net: NetClient;
  readonly bus: GameBus = createGameBus();

  private readonly controller: PlayerController;
  private readonly ring = new CommandRing(64);
  private readonly rng: Rng;
  private readonly opts: HeadlessClientOptions;
  private readonly pose = makeInterpolatedPose();

  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private ticks = 0;

  /** Distance to the nearest enemy at the last aim update, metres. */
  private targetDistance = Infinity;

  private hitsDealt = 0;
  private shotsFired = 0;
  private killsDealt = 0;
  private deaths = 0;

  /** Live state of this client's own entity, from the snapshot. */
  private alive = true;
  private deathCycles = 0;
  private metresSinceRespawn = 0;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;

  // -- M11 state ---------------------------------------------------------------

  private votedInPhase = -1;
  private votesCast = 0;
  private votePhase = 0;
  private votePhaseEndsTick = 0;
  private voteTally: readonly number[] = [];
  private decidedMode = -1;
  private summaries = 0;
  private readonly notices: string[] = [];
  private currentMapId = '';
  private controllerInUse: PlayerController;

  /** A background build in flight, or null. See `onPrepare`. */
  private preparing: {
    matchId: number;
    mapId: string;
    controller: PlayerController;
    startedMs: number;
    readyAtMs: number;
    reported?: boolean;
  } | null = null;

  /**
   * Mispredictions in the first seconds after joining (M11 playtest, bug 1).
   *
   * The direct instrument for "severe rubberbanding at spawn". A clock seeded half a round trip
   * wrong, or a class the two sides resolved differently, both show up here and nowhere else —
   * the run-total averages them away across a match, and the post-migration window opens too
   * late to see the join at all.
   */
  private spawnWindowUntilTick = -1;
  private spawnWindowMispredictions = 0;

  private objectiveUpdates = 0;
  private objectivesOwned = 0;
  private tagUpdates = 0;
  private readonly tagIds = new Set<number>();
  private peakTags = 0;
  private bombUpdates = 0;
  private bombPlanted = false;
  private bombDefused = false;
  private bombExploded = false;
  private bombInteractSeen = 0;
  private bombTimerTicked = 0;
  private lastBombTimer = -1;
  private editSent = false;
  private buildsCompleted = 0;
  private worstBuildMs = 0;
  /** Migrations where no prepared build was waiting. Should be arena returns only. */
  private lateBuilds = 0;

  private migrationWindow: {
    untilTick: number;
    baseline: number;
    seen: number;
    atTicks: number[];
    intoLive: boolean;
  } | null = null;
  private readonly intoLiveWindows: number[] = [];
  private readonly toArenaWindows: number[] = [];
  private readonly postMigrationWindows: number[] = [];
  /** Tick offsets inside a window where a misprediction appeared. See `pumpMigrationWindow`. */
  private readonly migrationMispredictionTicks: number[] = [];

  constructor(opts: HeadlessClientOptions) {
    this.opts = opts;
    this.rng = new Rng(opts.seed);

    // The same collision world the server loaded, from the same shared loader. Prediction
    // needs it: `PlayerController.step` sweeps a capsule against it, and a client predicting
    // against different geometry would mispredict on every wall.
    this.controller = this.buildController(opts.mapId);
    this.controllerInUse = this.controller;
    this.currentMapId = opts.mapId;

    this.link = new NodeLink(opts.url, opts.conditions, opts.seed);
    this.net = new NetClient({
      link: this.link,
      controller: this.controller,
      sample: (tick) => this.sample(tick),
      events: {
        onDamage: (e) => {
          if (e.sourceId === this.net.entityId) {
            this.hitsDealt++;
            if (e.lethal) this.killsDealt++;
          }
          if (e.targetId === this.net.entityId && e.lethal) this.deaths++;
        },
        onFired: (e) => {
          if (e.sourceId === this.net.entityId) this.shotsFired++;
        },
      },
      displayName: opts.name,
      loadout: opts.loadout ?? null,
      wantRewindDebug: opts.wantRewindDebug,
      skirmish: {
        onVoteState: (info) => this.onVoteState(info),
        onPrepare: (matchId, mapId) => this.onPrepare(matchId, mapId),
        onMigrated: (welcome) => this.onMigrated(welcome),
        onSummary: () => {
          this.summaries++;
        },
        onNotice: (text) => {
          this.notices.push(text);
        },
        /**
         * Objective replication (Gate B, §6.8).
         *
         * Counted, and the owner codes recorded, so a headless run can prove the flags are
         * actually crossing the wire and *changing* — a count alone would go green on a stream
         * of permanently neutral zones, which is the exact bug this replication exists to fix.
         */
        onObjectives: (states) => {
          this.objectiveUpdates++;
          for (const s of states) if (s.owner !== 0) this.objectivesOwned++;
        },
        /**
         * Dog tags (Gate B, §6.8).
         *
         * `tagsSeen` counts *distinct ids*, not frames. A frame counter would go green on a
         * server sending an empty list twenty times a second, which is precisely the state the
         * bug produced — so the number that matters is how many tags ever actually existed.
         */
        onTags: (tags) => {
          this.tagUpdates++;
          for (const t of tags) this.tagIds.add(t.id);
          if (tags.length > this.peakTags) this.peakTags = tags.length;
        },
        /**
         * The bomb (Gate B, §6.8).
         *
         * `bombTimerTicked` is the probe with teeth, and it is written to go red against the
         * bug rather than green against the feature: a frozen fuse — the networked client's
         * actual behaviour before this — sends the same value for ever, so a *decrease* is the
         * only observation that distinguishes a replicated countdown from a constant.
         */
        onBomb: (info) => {
          this.bombUpdates++;
          if (info.state === 'PLANTED') {
            this.bombPlanted = true;
            if (this.lastBombTimer >= 0 && info.secondsLeft < this.lastBombTimer) {
              this.bombTimerTicked++;
            }
            this.lastBombTimer = info.secondsLeft;
          } else {
            this.lastBombTimer = -1;
          }
          if (info.state === 'DEFUSED') this.bombDefused = true;
          if (info.state === 'EXPLODED') this.bombExploded = true;
          if (info.interactFraction > 0) this.bombInteractSeen++;
        },
      },
    });

    // No `DamageSystem` here, deliberately. This client resolves no damage — the server does,
    // and a client-side damage system would be a second opinion on a question with exactly
    // one authority (S4.9). Hits arrive as replicated `damage.dealt` events and are counted.
  }

  async connect(): Promise<void> {
    await this.link.open();
    this.net.connect();
  }

  // -- M11: the skirmish flow ---------------------------------------------------

  /**
   * A `PlayerController` over one map's collision.
   *
   * Rebuilt on every migration to a different map — see `onMigrated`. The world comes from the
   * same shared `loadMapCollision` the server used, which is what makes prediction agree about
   * geometry; a client sweeping its capsule against different walls mispredicts on every one
   * of them.
   */
  private buildController(mapId: string): PlayerController {
    const map = findMap(mapId);
    const world = loadMapCollision(map.def).collision;
    const movement = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
    const controller = new PlayerController(movement, world, this.bus, 0);

    /**
     * Apply the class's movement perks locally (Tier 1 #20, §8.10).
     *
     * **This is what makes the misprediction probe able to fail.** The browser does exactly
     * this in `MatchMeta.applyPerkHooks`, and the handover's bug was that the *server* did not:
     * the shipped class carries Lightweight at +7%, so the client predicted 7% faster than the
     * server simulated on every tick forever — 407/559 mispredictions, measured.
     *
     * A harness that skipped this line would set `speedScale` on neither side, agree perfectly,
     * and report zero mispredictions whether or not the loadout ever reached the server.
     * Standing lesson 4: *"Tests must be able to fail. Always stub the mechanism and watch the
     * probe go red before believing it green."* Comment out `Server.onLoadout`'s assignment and
     * this run goes red, which is the property that makes the green mean something.
     */
    const loadout = this.opts.loadout;
    if (loadout !== undefined) {
      const slot = sanitiseNetLoadout(loadout);
      if (slot !== null) controller.speedScale = resolveLoadout(slot, 0).perkState.moveSpeedMult;
    }
    return controller;
  }

  /**
   * Vote, once per phase, for the configured option (§4.20).
   *
   * The guard is `votedInPhase` rather than a timer: §4.20 allows a vote to be changed inside
   * its window, so re-sending on every 4 Hz broadcast would be legal but would put sixty
   * pointless frames on the wire per ballot. One vote per phase per client is what a human
   * does and is what the tally is meant to reflect.
   */
  private onVoteState(info: VoteInfo): void {
    this.votePhase = info.phase;
    this.votePhaseEndsTick = info.phaseEndsTick;
    this.voteTally = info.tally;
    this.decidedMode = info.decidedMode;

    const choice = this.opts.voteFor ?? -1;
    if (choice < 0) return;
    const isBallot = info.phase === VotePhase.MODE_VOTE || info.phase === VotePhase.MAP_VOTE;
    if (!isBallot || this.votedInPhase === info.phase) return;

    // Clamped rather than dropped: a configured choice of 4 is legal on the five-mode ballot
    // and out of range on the three-map one, and a harness that silently abstained on the map
    // vote would look like it was testing something it was not.
    const size = info.phase === VotePhase.MODE_VOTE ? MODE_BALLOT.length : MAP_BALLOT.length;
    this.votedInPhase = info.phase;
    this.votesCast++;
    this.net.sendVote(info.phase, choice % size);
  }

  /**
   * Start a background build (§6.5).
   *
   * The browser builds meshes and `CanvasTexture`s here; this process has neither, so it
   * builds the one thing it genuinely needs for the new map — the collision world prediction
   * will sweep against — and then waits out `buildMs` to stand in for the GPU work it cannot
   * do. That wait is what makes §8.8's deliberately slow client possible.
   */
  private onPrepare(matchId: number, mapId: string): void {
    if (this.preparing !== null && this.preparing.matchId === matchId) return;
    const startedMs = nowMs();
    // Built now, held until the migration lands. Doing it here rather than on arrival is the
    // whole point of the design: the cost is paid while the player is still shooting in the
    // arena rather than on the transition they are meant to experience as seamless.
    const controller = this.buildController(mapId);
    this.preparing = { matchId, mapId, controller, startedMs, readyAtMs: startedMs + (this.opts.buildMs ?? 0) };
  }

  /**
   * The build has had its time. Report ready.
   *
   * Driven from `update` rather than a timer, because §4.18 counts timers as part of the
   * teardown surface and a harness that leaked them would be a poor instrument for measuring
   * leaks.
   */
  private pumpBuild(): void {
    const build = this.preparing;
    if (build === null || build.reported) return;
    if (nowMs() < build.readyAtMs) return;
    build.reported = true;
    const elapsed = nowMs() - build.startedMs;
    this.buildsCompleted++;
    if (elapsed > this.worstBuildMs) this.worstBuildMs = elapsed;
    this.net.sendReady(build.matchId);
  }

  /**
   * Moved to another instance (§4.18).
   *
   * Two things happen, in this order. The controller is swapped for the one built during
   * `onPrepare`, so prediction sweeps against the new map's geometry from the very first tick;
   * and the post-migration misprediction window opens, which is §8.9's regression test for
   * Tier 1 #20.
   *
   * If no build is waiting — a migration back to the arena, or a `Prepare` that never arrived
   * — the controller is built here instead. Synchronously and on the spot, which is exactly
   * the stall the background build exists to avoid, and is the correct fallback: being late is
   * better than predicting against the wrong walls.
   */
  private onMigrated(welcome: WelcomeInfo): void {
    const prepared = this.preparing;
    if (prepared !== null && prepared.mapId === welcome.mapId) {
      this.net.swapController(prepared.controller);
      this.controllerInUse = prepared.controller;
      this.preparing = null;
    } else if (welcome.mapId !== this.currentMapId) {
      this.lateBuilds++;
      const controller = this.buildController(welcome.mapId);
      this.net.swapController(controller);
      this.controllerInUse = controller;
      this.preparing = null;
    }
    this.currentMapId = welcome.mapId;

    // Open the window. `mispredictionsAtMigration` is the baseline the count is taken against
    // 60 ticks later, so the number reported is what happened *in* the window rather than the
    // running total.
    this.migrationWindow = {
      untilTick: this.ticks + POST_MIGRATION_WINDOW_TICKS,
      baseline: this.net.prediction.stats.mispredictions,
      seen: 0,
      atTicks: [],
      // Which direction this migration went. The two are different claims: entering a live
      // match is what Tier 1 #20 and §8.9 are about, because that is where the loadout is
      // locked and where a movement perk could diverge. Returning to the arena is the same
      // machinery run backwards into a world that was already running.
      intoLive: welcome.matchId !== WARMUP_MATCH_ID,
    };
    this.votedInPhase = -1;
  }

  /**
   * Close the post-migration window once it has run its 60 ticks.
   *
   * Sampled every update rather than only at the end, so a non-zero result carries *when*
   * inside the window it happened. That distinction is the whole diagnosis: a divergence on
   * tick 1 is the client predicting before the first authoritative owner block has landed,
   * while one spread across all sixty is a genuine per-tick disagreement of the Tier 1 #20
   * kind. A bare count cannot tell them apart, and the two have nothing in common.
   */
  private pumpMigrationWindow(): void {
    // Named `span` rather than `window`: the boundary check bans that identifier outright in
    // `server/`, and it is right to — a bare `window.innerWidth` crosses the partition just as
    // completely as an import does, and no import graph can see it.
    const span = this.migrationWindow;
    if (span === null) return;

    const soFar = this.net.prediction.stats.mispredictions - span.baseline;
    if (soFar > span.seen) {
      span.seen = soFar;
      span.atTicks.push(this.ticks - (span.untilTick - POST_MIGRATION_WINDOW_TICKS));
    }

    if (this.ticks < span.untilTick) return;
    this.postMigrationWindows.push(soFar);
    if (span.intoLive) this.intoLiveWindows.push(soFar);
    else this.toArenaWindows.push(soFar);
    if (soFar > 0) this.migrationMispredictionTicks.push(...span.atTicks);
    this.migrationWindow = null;
  }

  /**
   * Whether the server ever told this client its match was over.
   *
   * Assert on it **per match, not latched once** — a churn run plays several, and one silent
   * ending among four is still the bug.
   */
  get sawMatchEnd(): boolean {
    return this.net.sawMatchOver;
  }

  /** One update. Call at roughly frame rate. */
  update(): void {
    /**
     * The mid-session class change (§6.6).
     *
     * Sent once, from the same `sendLoadout` the browser's loadout editor calls on close. The
     * server's answer is deferred to the next spawn on both sides — see
     * `ServerMatch.setPendingLoadout` for why that is the only safe moment.
     */
    const edit = this.opts.editClass;
    if (edit !== undefined && !this.editSent && this.ticks >= (this.opts.editAfterTicks ?? 120)) {
      this.editSent = true;
      this.net.sendLoadout(edit);
    }

    const steps = this.net.update();
    this.ticks += steps;

    // Opened on the first tick this client is actually simulating, closed SPAWN_WINDOW_TICKS
    // later. See `spawnWindowMispredictions`.
    if (this.spawnWindowUntilTick < 0 && this.net.state === 'joined' && steps > 0) {
      this.spawnWindowUntilTick = this.ticks + SPAWN_WINDOW_TICKS;
    }
    if (this.spawnWindowUntilTick >= 0 && this.ticks <= this.spawnWindowUntilTick) {
      this.spawnWindowMispredictions = this.net.prediction.stats.mispredictions;
    }

    this.readOwnEntity();
    this.pumpBuild();
    this.pumpMigrationWindow();
  }

  disconnect(clean: boolean): void {
    if (clean) this.net.disconnect('done');
    else this.link.terminate();
  }

  report(): HeadlessClientReport {
    const p = this.net.prediction.percentiles();
    return {
      name: this.opts.name,
      entityId: this.net.entityId,
      state: this.net.state,
      closeReason: this.net.closeReason,
      stats: this.net.stats,
      mispredictions: this.net.prediction.stats.mispredictions,
      comparisons: this.net.prediction.stats.comparisons,
      mispredictionP50: round(p.p50),
      mispredictionP99: round(p.p99),
      maxReplayDepth: this.net.prediction.stats.maxReplayDepth,
      ticksSimulated: this.ticks,
      hitsDealt: this.hitsDealt,
      shotsFired: this.shotsFired,
      killsDealt: this.killsDealt,
      deaths: this.deaths,
      remotes: this.net.remotes.size,
      deathCycles: this.deathCycles,
      metresSinceRespawn: Math.round(this.metresSinceRespawn * 10) / 10,
      matchId: this.net.matchId,
      migrations: this.net.migrations,
      objectiveUpdates: this.objectiveUpdates,
      objectivesOwned: this.objectivesOwned,
      tagUpdates: this.tagUpdates,
      tagsSeen: this.tagIds.size,
      peakTags: this.peakTags,
      bombUpdates: this.bombUpdates,
      bombPlanted: this.bombPlanted,
      bombDefused: this.bombDefused,
      bombExploded: this.bombExploded,
      bombInteractSeen: this.bombInteractSeen,
      bombTimerTicked: this.bombTimerTicked,
      spawnWindowMispredictions: this.spawnWindowMispredictions,
      worstPostMigrationMispredictions:
        this.postMigrationWindows.length === 0 ? 0 : Math.max(...this.postMigrationWindows),
      postMigrationWindows: [...this.postMigrationWindows],
      intoLiveWindows: [...this.intoLiveWindows],
      toArenaWindows: [...this.toArenaWindows],
      migrationMispredictionTicks: [...this.migrationMispredictionTicks],
      buildsCompleted: this.buildsCompleted,
      worstBuildMs: Math.round(this.worstBuildMs),
      summaries: this.summaries,
      notices: [...this.notices],
      votesCast: this.votesCast,
    };
  }

  /** The vote cycle as this client last saw it. Read by the harness's phase-boundary check. */
  get voteView(): { phase: number; endsTick: number; tally: readonly number[]; decidedMode: number } {
    return {
      phase: this.votePhase,
      endsTick: this.votePhaseEndsTick,
      tally: this.voteTally,
      decidedMode: this.decidedMode,
    };
  }

  /** Migrations that had to build their map on arrival. Arena returns are expected here. */
  get lateBuildCount(): number {
    return this.lateBuilds;
  }

  /** The controller prediction is currently running through. Swapped on a map change. */
  get activeController(): PlayerController {
    return this.controllerInUse;
  }

  // -- the input script -------------------------------------------------------

  /**
   * Produce this tick's command.
   *
   * The shape of the motion matters more than its quality. Strafing is the case S4.13's
   * half-metre error was measured against, so the default behaviour reverses direction on a
   * cadence fast enough that lag compensation is doing real work rather than correcting a
   * body that was standing still.
   */
  private sample(tick: number): InputCommand {
    const cmd = this.ring.next();
    cmd.seq = this.seq++;
    cmd.tickIndex = tick;
    cmd.sampledAtMs = 0;

    let moveX = 0;
    let moveZ = 0;
    let buttons = 0;

    if (this.alive) {
      switch (this.opts.behaviour) {
        case 'strafe': {
          // Reverse every ~0.6 s. Fast enough to matter, slow enough to reach full speed.
          moveX = simSin(tick / 36) > 0 ? 1 : -1;
          // Turn slowly so the view is never static, which exercises the yaw quantisation
          // and the validation's yaw-rate check on every tick rather than never.
          this.yaw += 0.004;
          break;
        }
        case 'runner': {
          moveZ = 1;
          buttons |= Btn.Sprint;
          this.yaw += 0.02;
          // Jump occasionally: airborne state has its own speed cap and its own replay path.
          if (tick % 90 === 0) buttons |= Btn.Jump;
          if (tick % 240 < 30) buttons |= Btn.Crouch;
          break;
        }
        case 'shooter': {
          moveX = simSin(tick / 48) > 0 ? 0.7 : -0.7;
          // Aim at the nearest visible remote and hold the trigger in bursts.
          this.aimAtNearest();
          if (tick % 30 < 12) buttons |= Btn.Fire;
          if (tick % 600 === 0) buttons |= Btn.Reload;
          break;
        }

        /**
         * Close to engagement range, then hold it and shoot.
         *
         * The hit-registration experiment (S8.6) needs the shooter to actually be able to see
         * the target, and two clients dropped on opposite team spawns of Foundry never can —
         * the first run of the test scored 0/38 at every latency for exactly that reason, and
         * the number was measuring the map rather than the netcode.
         *
         * So this walks toward the nearest enemy until it is at `ENGAGE_RANGE_M` and then
         * stops advancing and strafes. Holding a known range is also what makes the S8.7 TTK
         * comparison meaningful, since damage falls off with distance.
         */
        case 'seeker': {
          this.aimAtNearest();
          if (this.targetDistance > ENGAGE_RANGE_M + 2) {
            moveZ = 1;
          } else if (this.targetDistance < ENGAGE_RANGE_M - 2) {
            moveZ = -1;
          }
          moveX = simSin(tick / 40) > 0 ? 0.6 : -0.6;
          // Only shoot once there is something in range to shoot at. A burst cadence rather
          // than a held trigger, so recoil recovers between groups the way a player's does.
          if (this.targetDistance < 25 && tick % 24 < 10) buttons |= Btn.Fire;
          break;
        }
        case 'idle':
          break;
      }
    }

    this.pitch += (this.rng.spread() * 0.002);
    if (this.pitch > 1.4) this.pitch = 1.4;
    if (this.pitch < -1.4) this.pitch = -1.4;

    cmd.moveX = moveX;
    cmd.moveZ = moveZ;
    cmd.yaw = wrap(this.yaw);
    cmd.pitch = this.pitch;
    cmd.buttons = buttons;
    return cmd;
  }

  /**
   * Point at the nearest living remote entity.
   *
   * Read out of the **interpolation buffer at the client's own render time**, which is the
   * point: this is exactly what a human aims at, so a shot fired here is a shot the server
   * must rewind to make land. Aiming at the entity's newest replicated position instead would
   * quietly test a case no real player is ever in.
   */
  private aimAtNearest(): void {
    const renderMs = this.net.renderTimeMs(DEFAULT_INTERPOLATION_DELAY_MS);
    const sim = this.controller.sim;
    let bestDistance = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;

    for (const [id, interp] of this.net.remotes) {
      if (id === this.net.entityId) continue;
      if ((interp.latest.flags & EFlag.Alive) === 0) continue;
      interp.sample(renderMs, this.pose);
      const dx = this.pose.x - sim.x;
      const dz = this.pose.z - sim.z;
      const d = Math.hypot(dx, dz);
      if (d < bestDistance) {
        bestDistance = d;
        bestX = this.pose.x;
        bestY = this.pose.y;
        bestZ = this.pose.z;
      }
    }

    this.targetDistance = bestDistance;
    if (bestDistance === Infinity) {
      this.yaw += 0.01;
      return;
    }

    const dx = bestX - sim.x;
    const dz = bestZ - sim.z;
    // Chest height, matching where `HitboxRig`'s torso box actually is.
    const dy = bestY + 1.26 - (sim.y + sim.eyeHeight);
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  /**
   * Track our own liveness, and how far we have moved since coming back.
   *
   * The distance is measured off the *predicted* controller rather than the snapshot,
   * because that is what the player would see and it is what stops moving when the input
   * pipeline is suppressed.
   */
  private readOwnEntity(): void {
    const own = this.net.remotes.get(this.net.entityId);
    if (own === undefined) return;
    const alive = (own.latest.flags & EFlag.Alive) !== 0;

    if (alive && !this.alive) {
      // Respawned: start the odometer again from wherever the server put us.
      this.deathCycles++;
      this.metresSinceRespawn = 0;
      this.lastX = Number.NaN;
      this.lastZ = Number.NaN;
    }
    this.alive = alive;

    if (!alive) return;
    const sim = this.controller.sim;
    if (Number.isFinite(this.lastX) && Number.isFinite(this.lastZ)) {
      const step = Math.hypot(sim.x - this.lastX, sim.z - this.lastZ);
      // Ignore the metre-scale jump a correction can produce; this is an odometer, not a
      // displacement, and a teleport is not distance the player walked.
      if (step < 1) this.metresSinceRespawn += step;
    }
    this.lastX = sim.x;
    this.lastZ = sim.z;
  }
}

/**
 * Range the seeker holds, metres.
 *
 * Ten, because S8.7 specifies TTK *"at 10 m"* and using the same distance for both
 * measurements means the hit-rate number and the TTK number describe the same engagement.
 */
const ENGAGE_RANGE_M = 10;

function wrap(a: number): number {
  const t = Math.PI * 2;
  let v = a % t;
  if (v > Math.PI) v -= t;
  if (v < -Math.PI) v += t;
  return v;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Seconds one headless tick represents. Exported so the harness paces itself honestly. */
export const HEADLESS_DT = DT;
