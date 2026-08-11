import { nowMs } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import type { VoteInfo } from '../shared/net/Messages';
// Importing this module is also what runs its boot-time check that both ballots name things
// the registry actually has — see the bottom of `Skirmish.ts`.
import { InstanceState, MAP_BALLOT, MODE_BALLOT, sanitiseNetLoadout } from '../shared/net/Skirmish';
import { describeConfig, type ServerConfig } from './Config';
import { LiveMatch } from './instance/LiveMatch';
import type { MatchInstance } from './instance/MatchInstance';
import { VoteCycle, type VoteResolution } from './instance/VoteCycle';
import { WarmupMatch } from './instance/WarmupMatch';
import { ServerLoop, type TickJitter } from './Loop';
import { metric } from './log';
import { MapBakery, type BootBakeReport } from './MapBakery';
import {
  AllocationError,
  FaultyMatchAllocator,
  InProcessMatchAllocator,
  type IMatchAllocator,
  type MatchHandle,
  type PlayerSlot,
} from './MatchAllocator';
import { Migration, seatInfo } from './Migration';
import { Router } from './Router';
import { Session } from './net/Session';
import { WsServer, type WsLink } from './net/WsServer';

const log = logger('server');

/**
 * The process: one loop, one arena, at most one live match (M11, §4.9).
 *
 * Replaces M10's `GameServer`, which was a match, a loop, a listener and a rotation policy in
 * one class. The rotation is gone — a dedicated server that walks a fixed map list is a
 * different product from one where the players vote — and what is left is a scheduler.
 *
 * ## The tick, and why it is in this order
 *
 * ```
 *   1. receive     drain every socket into the input buffers
 *   2. instances   step the arena, then the live match, each wrapped
 *   3. flow        vote cycle, allocation, readiness, migration, teardown
 *   4. flush       release anything the condition simulator is holding
 *   5. reap        time out silent connections, drop closed ones
 * ```
 *
 * Receive before simulate, because a command that arrived during the last frame is for a tick
 * that has not run yet. The **flow runs after the instances**, which is the ordering that
 * matters most here: a migration that ran before the step would move a player out of a world
 * midway through the tick that world was about to simulate them in, and the forced snapshot in
 * Tier 2 §A depends on the ending instance having been stepped first.
 *
 * ## Two instances, one loop
 *
 * §4.19: *"One loop, not N. The drift-corrected loop in §4.10 exists once, at master level,
 * and steps every `RUNNING` instance."* `ServerLoop` is unchanged from M9; the only difference
 * is that its `tick` callback now steps a list.
 */

export class Server {
  private readonly loop: ServerLoop;
  private readonly wss: WsServer;
  private readonly bakery = new MapBakery();
  private readonly router = new Router();
  private readonly migration: Migration;
  private readonly allocator: IMatchAllocator;
  /** Non-null only when fault injection is configured. §8.14 drives this. */
  readonly faulty: FaultyMatchAllocator | null;

  private warmup: WarmupMatch;
  private readonly voteCycle: VoteCycle;

  private live: MatchHandle | null = null;
  /** True between asking the allocator and hearing back. Stops a second ask. */
  private allocating = false;

  private readonly sessions: Session[] = [];

  private bootReport: BootBakeReport | null = null;
  private lastMetricsMs = 0;
  private lastVoteBroadcastTick = -1;
  private stopping = false;

  /** Total ms across every instance for the most recent tick. §8.28's number. */
  totalStepMs = 0;
  meanTotalStepMs = 0;

  constructor(private readonly cfg: ServerConfig) {
    /**
     * Bake every map before anything else (§4.19).
     *
     * Before the listener opens, before the arena is built, before a single connection is
     * accepted. The arena itself is built over this cache, so even the greybox room's bake is
     * inside the boot report rather than hidden in a constructor.
     */
    this.bootReport = this.bakery.bakeAll();

    this.warmup = this.buildWarmup(0);

    const inProcess = new InProcessMatchAllocator({
      bakery: this.bakery,
      snapshotHz: cfg.snapshotHz,
      interpolationDelayMs: cfg.interpolationDelayMs,
      readyTimeoutMs: cfg.readyTimeoutMs,
      summaryHoldSeconds: cfg.summaryHoldSeconds,
      botTier: 'MIX',
      currentTick: () => this.loop.currentTick,
      seed: cfg.seed,
      roundSecondsOverride: cfg.matchRoundSeconds,
    });

    /**
     * The faulty allocator is wired in only when asked for (§4.17, test-only).
     *
     * It wraps rather than replaces, so what runs in production is the real allocator with
     * nothing in front of it, and what the harness exercises is the real allocator with a
     * fault in front of it. A build flag that swapped implementations would test a second
     * implementation instead of the first.
     */
    if (cfg.faultInjection) {
      this.faulty = new FaultyMatchAllocator(inProcess);
      this.allocator = this.faulty;
      log.warn('FAULT_INJECTION=1 — the allocator can be made to stall and fail. Diagnostic only.');
    } else {
      this.faulty = null;
      this.allocator = inProcess;
    }

    this.migration = new Migration(this.router);

    this.voteCycle = new VoteCycle({
      /**
       * Humans **connected to the server**, not humans standing in the arena.
       *
       * §4.20's rule is *"if every human leaves during a vote phase, the cycle cancels"*, and
       * "leaves" means leaves the server. Counting arena occupancy instead made a successful
       * migration look identical to a mass disconnect: the moment everybody moved into the
       * live match the arena was empty, the cycle cancelled itself to `IDLE`, and no further
       * ballot ever opened — the match played out and the players came back to a server that
       * had quietly stopped asking them what to play next.
       *
       * Found by the flow harness, which observed exactly one cycle across a two-cycle run.
       */
      humanCount: () => this.router.playerCount,
      onResolved: (resolution) => void this.onVoteResolved(resolution),
      seed: cfg.seed,
      config: cfg.voteCycle,
    });

    if (cfg.rewindDisabled) {
      log.warn('REWIND_DISABLED=1 — lag compensation is OFF. Diagnostic only (S8.6).');
    }

    this.loop = new ServerLoop({
      tick: (tickIndex) => this.tick(tickIndex),
      shouldContinue: () => !this.stopping,
    });

    this.wss = new WsServer({
      port: cfg.port,
      host: cfg.host,
      tlsCertPath: cfg.tlsCertPath,
      tlsKeyPath: cfg.tlsKeyPath,
      conditions: cfg.conditions,
      onConnection: (link) => this.accept(link),
    });
  }

  async start(): Promise<void> {
    await this.wss.listen();
    log.info(`listening — ${describeConfig(this.cfg)}`);
    this.lastMetricsMs = nowMs();
    this.loop.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.loop.stop();
    for (const s of this.sessions) s.close('server shutting down');
    this.sessions.length = 0;
    if (this.live !== null) {
      await this.allocator.destroy(this.live);
      this.live = null;
    }
    this.warmup.dispose();
    await this.wss.close();
  }

  get jitter(): TickJitter {
    return this.loop.jitter();
  }

  get boot(): BootBakeReport | null {
    return this.bootReport;
  }

  /** Both instances, for the §7 instance panel and for the leak harness. */
  get instances(): readonly MatchInstance[] {
    return this.live === null ? [this.warmup] : [this.warmup, this.live.instance];
  }

  get liveMatch(): LiveMatch | null {
    return this.live?.instance ?? null;
  }

  get vote(): VoteCycle {
    return this.voteCycle;
  }

  get migrationLog(): Migration {
    return this.migration;
  }

  get misroutedMessages(): number {
    return this.router.misroutedMessages;
  }

  // -- connections ------------------------------------------------------------

  private accept(link: WsLink): void {
    const session = new Session(
      link,
      {
        // The name is already on the session by the time this runs — `Session.handleHello`
        // sanitises it and assigns it before calling — so it is taken from there rather than
        // from the parameter, and there is one sanitised copy rather than two.
        onJoin: (s) => {
          /**
           * Every player enters through the arena (§6.7).
           *
           * *"A player who joins the server while a live match is running goes to the warmup
           * arena, not into the match, and joins at the next cycle. Warmup is always the entry
           * point."* One entry point means one seating path to get right, and it is why a
           * player can be shooting one round trip after clicking Play Multiplayer: the arena
           * always exists and is always `RUNNING`.
           */
          const player = this.warmup.seat(s, s.loadout);
          if (player === null) return null;
          this.router.admit(s, this.warmup);

          /**
           * The seat assignment goes out in `afterIdentity`, not here (Tier 2 §D).
           *
           * *"Any side effect of a reconnect that sends a frame must not run inside the hello
           * handler, or its frame overtakes the `Identity` it is a reply to."* In this flow the
           * seat assignment **is** the identity frame, so what has to be deferred is everything
           * downstream of it: the vote state and, if a match is being prepared, the `Prepare`
           * that starts a background build. Sent from inside `onJoin`, either would reach the
           * client before the `Welcome` that tells it who it is, and the handshake drops
           * frames it has no context for.
           */
          return {
            player,
            afterIdentity: () => {
              this.sendSeatTo(s, this.warmup, player.entityId, player.team, false);
              this.sendVoteStateTo(s);
              this.sendPrepareIfBuilding(s);
            },
          };
        },
        onLeave: (s, reason) => this.onLeave(s, reason),
        onLoadout: (s, raw) => this.onLoadout(s, raw),
        onVote: (s, phase, option) => this.onVote(s, phase, option),
        onReady: (s, matchId) => this.onReady(s, matchId),
      },
      () => this.loop.currentTick,
    );
    this.sessions.push(session);
  }

  private onLeave(session: Session, reason: string): void {
    this.router.release(session.playerId);
    this.voteCycle.forget(session.playerId);
    session.player = null;
    log.info(`connection from ${session.link.remoteAddress} closed: ${reason}`);
  }

  /**
   * A class arrived (Tier 1 #20).
   *
   * Validated here and applied on the **next spawn** rather than to the standing body, per the
   * handover's rule 3: *"Applying a class change live to a standing networked world
   * reintroduced the same divergence by another door. Deferring to next spawn is CoD behaviour
   * anyway."* §6.6 says the same thing from the player's side.
   *
   * The stored value is what gets locked into the `MatchRequest` at migration, so a class sent
   * at any point during warmup is the class carried into the match.
   */
  private onLoadout(session: Session, raw: Parameters<typeof sanitiseNetLoadout>[0]): void {
    const clean = sanitiseNetLoadout(raw);
    if (clean === null) {
      // Never a disconnect: a class the server cannot read is a client one build ahead or
      // behind, and the M10 defaults are a working game.
      log.warn(`${session.displayName} sent an unusable loadout; keeping the previous one.`);
      return;
    }
    session.loadout = clean;
    log.info(
      `${session.displayName} set class "${clean.name}" — ` +
        `${clean.primary.weaponId}/${clean.secondary.weaponId}, ` +
        `perks [${clean.perks.filter((p) => p !== null).join(', ')}]. Applies on next spawn.`,
    );
  }

  private onVote(session: Session, phase: number, option: number): void {
    const accepted = this.voteCycle.castVote(session.playerId, phase, option);
    if (!accepted) {
      // §8.6 requires a vote outside its window to be demonstrably rejected. Logged rather
      // than answered: the tally not moving is the client's feedback, and a reply would be a
      // message a hostile client could make the server send at will.
      log.warn(
        `${session.displayName} voted ${option} in phase ${phase}; ` +
          `the server is in phase ${this.voteCycle.phase} — rejected.`,
      );
      return;
    }
    // Broadcast immediately so the voter sees their own vote land rather than waiting up to a
    // quarter of a second for the next scheduled tally.
    this.broadcastVoteState();
  }

  private onReady(session: Session, matchId: number): void {
    const target = this.live;
    if (target === null || target.id !== matchId) {
      this.router.mayAddress(session, matchId);
      return;
    }
    target.instance.noteReady(session.playerId);
    const waited = session.prepareSentAtMs === 0 ? 0 : nowMs() - session.prepareSentAtMs;
    log.info(
      `${session.displayName} ready for match ${matchId} after ${Math.round(waited)}ms of background build.`,
    );
    metric('migration', 'ready', {
      playerId: session.playerId,
      name: session.displayName,
      matchId,
      buildMs: Math.round(waited),
    });
  }

  // -- the tick ---------------------------------------------------------------

  private tick(tickIndex: number): void {
    // 1. Drain sockets. Commands land in input buffers before anything simulates.
    for (const s of this.sessions) s.receive();

    // 2. Step every RUNNING instance, each wrapped (§4.18).
    let total = 0;
    this.stepInstance(this.warmup, tickIndex);
    total += this.warmup.lastStepMs;

    const live = this.live;
    if (live !== null) {
      this.stepInstance(live.instance, tickIndex);
      total += live.instance.lastStepMs;
    }
    this.totalStepMs = total;
    this.meanTotalStepMs = this.meanTotalStepMs * 0.98 + total * 0.02;

    // 3. The flow: vote, allocate, wait for readiness, migrate, end, tear down.
    this.stepFlow(tickIndex);

    // 4. Release whatever the per-link condition simulator has been holding.
    for (const s of this.sessions) {
      const link = s.link;
      if (isWsLink(link)) link.pumpOutbound();
    }

    // 5. Reap. Done last so a connection that died this tick still had its commands applied.
    for (const s of this.sessions) s.checkTimeout();
    this.reap();

    this.maybeLogMetrics();
  }

  /**
   * Step one instance, and survive its exceptions (§4.18).
   *
   * *"An exception inside one instance must not take down the process. Each instance's step is
   * wrapped. A throwing `LiveMatch` is marked failed, its players are migrated back to warmup,
   * and it is destroyed. A throwing `WarmupMatch` is the one case that cannot be recovered by
   * migration — it must be rebuilt in place, and every connected player told."*
   *
   * The two recoveries are genuinely different and that is why the wrapping is here rather
   * than inside `MatchInstance.step`: the base class would have to guess which of its
   * subclasses it was.
   */
  private stepInstance(instance: MatchInstance, tickIndex: number): void {
    if (!instance.running) return;
    try {
      instance.step(tickIndex);
    } catch (err) {
      // The stack goes into the message rather than a second argument: `logger` takes one
      // string, so that a structured sink and a text sink cannot disagree about what a log
      // line contains. It is written to our log and never to a client (S4.16).
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      if (instance === this.warmup) {
        this.rebuildWarmup(tickIndex, message);
      } else if (this.live !== null && instance === this.live.instance) {
        log.error(`live match ${instance.id} threw: ${message}`);
        this.live.instance.fail(message);
        this.returnEveryoneToWarmup(tickIndex, 'The match ended unexpectedly — back to the arena.');
        void this.destroyLive();
      }
    }
  }

  /**
   * The arena threw. Rebuild it in place and tell everybody (§4.18).
   *
   * There is nowhere to migrate to — the arena is the destination of last resort — so the only
   * options are to rebuild or to take the process down with every connected player on it. The
   * rebuild is not free: players lose their position and their streak, and are re-seated into a
   * fresh world. It is a bad outcome and it is much better than the alternative.
   */
  private rebuildWarmup(tickIndex: number, message: string): void {
    log.error(`the warmup arena threw: ${message}. Rebuilding it in place.`);

    const seated = [...this.warmup.sessions].map((seat) => seat.session);
    for (const session of seated) this.router.release(session.playerId);
    this.warmup.dispose();
    this.warmup = this.buildWarmup(tickIndex);

    for (const session of seated) {
      if (session.closed) continue;
      const player = this.warmup.seat(session, session.loadout);
      if (player === null) {
        session.close('arena rebuild could not seat this connection');
        continue;
      }
      session.player = player;
      this.router.admit(session, this.warmup);
      this.sendSeatTo(session, this.warmup, player.entityId, player.team, true);
      session.notice('The arena was rebuilt after a server fault.');
    }
    metric('server', 'warmupRebuilt', { tick: tickIndex, reason: message, reseated: seated.length });
  }

  // -- the skirmish flow ------------------------------------------------------

  private stepFlow(tickIndex: number): void {
    this.voteCycle.step(tickIndex);
    this.broadcastVoteStatePeriodically(tickIndex);

    const live = this.live;
    if (live === null) return;
    const instance = live.instance;

    switch (instance.state) {
      case InstanceState.READY_WAIT:
        this.maybeStartLive(instance, tickIndex);
        return;
      case InstanceState.ENDED:
        this.finishLive(instance, tickIndex);
        return;
      default:
        return;
    }
  }

  /**
   * The map vote resolved. Ask the allocator, and handle all three ways it can refuse.
   *
   * §4.17: *"The vote cycle must handle all three by leaving every player in the warmup arena
   * with a message, never by dropping them, stranding them, or leaking a half-built instance."*
   * Every path out of the catch does exactly that, and the cycle resumes into free play so the
   * next ballot opens on schedule rather than the arena sitting in `ALLOCATING` forever.
   */
  private async onVoteResolved(resolution: VoteResolution): Promise<void> {
    if (this.allocating || this.live !== null) {
      log.warn('a vote resolved while a match was already allocated or allocating; ignoring it.');
      this.voteCycle.resume(this.loop.currentTick);
      return;
    }

    this.allocating = true;
    const players: PlayerSlot[] = [...this.warmup.sessions].map((seat) => ({
      playerId: seat.session.playerId,
      displayName: seat.session.displayName,
      // Locked here: the class as it is at the moment of the request (§4.18, §6.6).
      loadout: seat.session.loadout,
    }));

    const startedMs = nowMs();
    try {
      const handle = await this.allocator.allocate({
        modeId: resolution.modeId,
        mapId: resolution.mapId,
        players,
        botFill: { count: 10, tier: 'MIX' },
      });
      this.live = handle;
      const elapsed = nowMs() - startedMs;
      log.info(
        `match ${handle.id} allocated in ${elapsed.toFixed(1)}ms — ` +
          `${resolution.modeId} on ${resolution.mapId}.`,
      );
      metric('allocator', 'allocated', {
        matchId: handle.id,
        modeId: resolution.modeId,
        mapId: resolution.mapId,
        ms: Math.round(elapsed * 100) / 100,
        humans: players.length,
      });

      /**
       * Start every client's background build now (§6.5).
       *
       * *"The client begins building meshes and procedural textures for the chosen map
       * immediately, in the background, while the player is still playing warmup."* This is
       * the message that starts it, and the readiness reports that answer it are what
       * `READY_WAIT` waits on.
       */
      let prepared = 0;
      for (const seat of this.warmup.sessions) {
        seat.session.readyForMatch = -1;
        seat.session.prepareSentAtMs = nowMs();
        seat.session.sendPrepare(handle.id, resolution.mapId, resolution.modeId);
        prepared++;
      }
      // Logged because it is one half of §7's per-client readiness time, and because "did the
      // start-building message actually go out" is the first question when every client hits
      // the readiness timeout.
      log.info(`sent Prepare for match ${handle.id} (${resolution.mapId}) to ${prepared} client(s).`);
    } catch (err) {
      const kind = err instanceof AllocationError ? err.kind : 'failure';
      const text =
        kind === 'capacity'
          ? 'The server is at capacity — staying in the arena.'
          : 'Could not start the match — staying in the arena.';
      log.warn(`allocation failed (${kind}): ${err instanceof Error ? err.message : String(err)}`);
      for (const seat of this.warmup.sessions) seat.session.notice(text);
      metric('allocator', 'failed', { kind, modeId: resolution.modeId, mapId: resolution.mapId });
      // Nothing was built, so there is nothing to leak and nobody moved. Back to free play.
      this.voteCycle.resume(this.loop.currentTick);
    } finally {
      this.allocating = false;
    }
  }

  /**
   * Everybody is ready, or the timeout fired: migrate and start (§4.18, §6.5, §6.7).
   *
   * The migration is the named-tick move for every player at once, and the match begins on the
   * same tick — so the first tick of the live match is a tick on which every migrated player
   * already exists in it with their loadout applied. That ordering is what makes §8.9's
   * *"misprediction count in the first 60 ticks after migration: expected zero"* achievable at
   * all.
   */
  private maybeStartLive(instance: LiveMatch, tickIndex: number): void {
    const expected = [...this.warmup.sessions].map((seat) => seat.session.playerId);
    if (expected.length === 0) {
      /**
       * Everybody left between allocation and readiness.
       *
       * §4.20's rule again, one stage later: no match for zero humans. The instance was built,
       * so unlike the allocation-failure path there *is* something to release.
       */
      log.info(`match ${instance.id}: nobody left to migrate. Destroying it.`);
      void this.destroyLive();
      this.voteCycle.resume(tickIndex);
      return;
    }

    const { settled } = instance.readinessSettled(expected);
    if (!settled) return;

    instance.begin(tickIndex);
    let moved = 0;
    for (const seat of [...this.warmup.sessions]) {
      if (this.migration.move(seat.session, instance, tickIndex, this.cfg.snapshotHz)) moved++;
    }
    log.info(`match ${instance.id} started on tick ${tickIndex} with ${moved} human(s) migrated.`);
  }

  /**
   * The match is over: send the summary, hold it, then take everybody home (§6.9).
   *
   * The summary is built and sent **before** teardown, because the scoreboard it is built from
   * lives in the `ScoreSystem` that `dispose()` releases. Sent once, then held for
   * `summaryHoldSeconds` so the M6 XP bar has time to animate, then everybody migrates back
   * and the instance is destroyed.
   */
  private finishLive(instance: LiveMatch, tickIndex: number): void {
    if (!instance.summaryAlreadySent) {
      const summary = instance.buildSummary();
      // Per-session encode, for the reason `Session.sendPrepare` documents at length: one
      // shared writer hands out several views of the same buffer.
      for (const seat of instance.sessions) seat.session.sendSummary(summary);
      instance.markSummarySent();
      log.info(
        `match ${instance.id} over — ${summary.winner} ${summary.scoreA}-${summary.scoreB} ` +
          `(${summary.reason}). Holding the summary for ${summary.holdSeconds}s.`,
      );
    }
    if (!instance.summaryElapsed(tickIndex)) return;

    this.returnEveryoneToWarmup(tickIndex, '');
    void this.destroyLive();
    this.voteCycle.resume(tickIndex);
  }

  /** Move every player in the live match back to the arena. Used by the end and by faults. */
  private returnEveryoneToWarmup(tickIndex: number, notice: string): void {
    const live = this.live;
    if (live === null) return;
    for (const seat of [...live.instance.sessions]) {
      const ok = this.migration.move(seat.session, this.warmup, tickIndex, this.cfg.snapshotHz);
      if (ok && notice !== '') seat.session.notice(notice);
    }
  }

  private async destroyLive(): Promise<void> {
    const handle = this.live;
    if (handle === null) return;
    this.live = null;
    /**
     * Anybody still seated here has to come out before the instance is disposed.
     *
     * The normal path has already migrated everybody, so this is a backstop for the fault
     * paths. Releasing through the router rather than calling `unseat` keeps the "exactly one
     * instance" map honest — a player released from a destroyed instance and never re-admitted
     * is the "never zero" failure, so they are put back in the arena.
     */
    for (const seat of [...handle.instance.sessions]) {
      this.migration.move(seat.session, this.warmup, this.loop.currentTick, this.cfg.snapshotHz);
    }
    await this.allocator.destroy(handle);
  }

  /**
   * Allocate a live match and destroy it again, with nobody in it (§8.13).
   *
   * The teardown leak harness's one operation. It deliberately bypasses the vote cycle: the
   * question is whether `LiveMatch` construction and `dispose` balance, and routing a hundred
   * of them through a hundred sixty-second ballots would take an hour and a half to answer it.
   *
   * It does **not** bypass the allocator, because the allocator holds a reference to the handle
   * and *"every reference held by the router, the session layer and the allocator"* is on
   * §4.18's list of things `destroy()` must release.
   *
   * Rotates the map and mode across calls, so a leak that only appears on one map — a bigger
   * navmesh, a mode with objective state — is not missed by a hundred repetitions of the
   * cheapest one.
   */
  async allocateAndDestroyForLeakTest(): Promise<void> {
    if (this.live !== null) await this.destroyLive();
    const modeId = MODE_BALLOT[this.leakCycle % MODE_BALLOT.length] ?? 'TDM';
    const mapId = MAP_BALLOT[this.leakCycle % MAP_BALLOT.length] ?? 'mp_foundry';
    this.leakCycle++;

    const handle = await this.allocator.allocate({
      modeId,
      mapId,
      players: [],
      botFill: { count: 10, tier: 'MIX' },
    });
    this.live = handle;
    // One step, so the instance builds its entity list and its bots take a tick — a teardown
    // that only ever released a never-stepped instance would miss anything allocated lazily on
    // the first step, which is most of the per-tick pools.
    handle.instance.begin(this.loop.currentTick);
    handle.instance.step(this.loop.currentTick);
    await this.destroyLive();
  }

  private leakCycle = 0;

  // -- broadcasts -------------------------------------------------------------

  /**
   * The vote state, at 4 Hz.
   *
   * Not every tick: the phase-end tick is the only field that changes continuously and the
   * client derives its countdown from it locally, so sending it sixty times a second would be
   * sixty copies of a number that has not changed. Four is enough for a tally to feel live.
   *
   * A rate rather than a change-detector because the tally is not the only reader — a client
   * that missed a broadcast during a loss burst gets the next one 250 ms later rather than
   * waiting for somebody to vote again.
   */
  private broadcastVoteStatePeriodically(tickIndex: number): void {
    const everyTicks = Math.round(60 / VOTE_BROADCAST_HZ);
    if (tickIndex - this.lastVoteBroadcastTick < everyTicks) return;
    this.lastVoteBroadcastTick = tickIndex;
    this.broadcastVoteState();
  }

  private broadcastVoteState(): void {
    for (const seat of this.warmup.sessions) this.sendVoteStateTo(seat.session);
  }

  private sendVoteStateTo(session: Session): void {
    const info: VoteInfo = {
      phase: this.voteCycle.phase,
      phaseEndsTick: this.voteCycle.endsTick,
      tally: this.voteCycle.tally(),
      // Per-recipient: a player sees their own vote highlighted, and cannot see anybody
      // else's. The tally is the only aggregate that crosses the wire.
      selfVote: this.voteCycle.voteOf(session.playerId),
      decidedMode: this.voteCycle.decided.mode,
      decidedMap: this.voteCycle.decided.map,
      humans: this.warmup.playerCount,
    };
    session.sendVoteState(info);
  }

  /**
   * A client that connected while a build was already in flight.
   *
   * Without this they would sit in the arena with no `Prepare`, never report ready, and be
   * migrated by the timeout into a map they had not built — the slow-client path, entered for
   * no reason. Sent from `afterIdentity`, so it cannot overtake the seat assignment.
   */
  private sendPrepareIfBuilding(session: Session): void {
    const live = this.live;
    if (live === null || live.instance.state !== InstanceState.READY_WAIT) return;
    session.prepareSentAtMs = nowMs();
    session.sendPrepare(live.id, live.instance.mapId, live.instance.modeId);
  }

  private sendSeatTo(
    session: Session,
    instance: MatchInstance,
    entityId: number,
    team: 'A' | 'B',
    migrated: boolean,
  ): void {
    session.sendSeat(
      seatInfo(instance, entityId, team, this.loop.currentTick, this.cfg.snapshotHz, migrated),
    );
  }

  // -- housekeeping -----------------------------------------------------------

  private buildWarmup(startTick: number): WarmupMatch {
    return new WarmupMatch({
      bakery: this.bakery,
      snapshotHz: this.cfg.snapshotHz,
      interpolationDelayMs: this.cfg.interpolationDelayMs,
      seed: this.cfg.seed,
      startTick,
      bots: this.cfg.warmupBots,
    });
  }

  private reap(): void {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      if (s === undefined) continue;
      if (!s.closed) continue;
      // `close` already ran `onLeave`, which released the seat. This only drops the now-inert
      // session object so the per-tick loops stay short.
      this.router.release(s.playerId);
      this.voteCycle.forget(s.playerId);
      s.player = null;
      this.sessions.splice(i, 1);
    }
  }

  private maybeLogMetrics(): void {
    if (this.cfg.metricsSeconds <= 0) return;
    const now = nowMs();
    if (now - this.lastMetricsMs < this.cfg.metricsSeconds * 1000) return;
    this.lastMetricsMs = now;

    const j = this.loop.jitter();
    metric('server', 'metrics', {
      tick: this.loop.currentTick,
      jitterP50: j.p50,
      jitterP99: j.p99,
      ticksLate: j.late,
      ticksDropped: j.dropped,
      hz: j.hz,
      sessions: this.sessions.length,
      // §4.19: per-instance and total, separately. The total is what the event loop absorbs
      // and is the number that decides the real concurrency cap (§8.28).
      totalStepMs: round(this.totalStepMs),
      meanTotalStepMs: round(this.meanTotalStepMs),
      instances: this.instances.map((i) => ({
        id: i.id,
        state: i.state,
        players: i.playerCount,
        bots: i.botCount,
        stepMs: round(i.lastStepMs),
        meanStepMs: round(i.meanStepMs),
      })),
      vote: {
        cycle: this.voteCycle.cycle,
        phase: this.voteCycle.phase,
        endsTick: this.voteCycle.endsTick,
      },
      misroutedMessages: this.router.misroutedMessages,
    });
  }
}

/** How often the vote state goes out. See `broadcastVoteStatePeriodically`. */
const VOTE_BROADCAST_HZ = 4;

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** `pumpOutbound` is a `WsLink` concern, not part of the `INetLink` contract. */
function isWsLink(link: unknown): link is WsLink {
  return typeof (link as { pumpOutbound?: unknown }).pumpOutbound === 'function';
}
