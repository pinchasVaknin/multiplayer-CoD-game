import { nowMs } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import type { VoteInfo } from '../shared/net/Messages';
// Importing this module is also what runs its boot-time check that both ballots name things
// the registry actually has — see the bottom of `Skirmish.ts`.
import {
  InstanceState,
  instanceStateName,
  MAP_BALLOT,
  MODE_BALLOT,
  sanitiseNetLoadout,
} from '../shared/net/Skirmish';
import {
  CheatOutcome,
  describeCheatMask,
  parseCheatCode,
  toggleCheat,
} from '../shared/cheats/Cheats';
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
import { STREAK_DEFS } from '../shared/streaks/StreakDefs';
import { ReconnectRegistry, type ReconnectStats } from './net/ReconnectRegistry';
import { Router } from './Router';
import { Session, type JoinResult, type LeaveCause } from './net/Session';
import { WsServer, type WsLink } from './net/WsServer';

const log = logger('server');

/**
 * What a reconnect claim came to (M11 Gate B, playtest round 4, F8).
 *
 * Two fields rather than a nullable seat, because a refused claim still has something to say
 * and the two answers are independent: a returning player who got their seat back needs no
 * message, and one who did not needs a *different* message depending on why. Folding them into
 * one nullable return meant parking the reason on the session — a field with exactly one read,
 * one write and a lifetime of three lines.
 */
interface ReclaimOutcome {
  readonly seat: JoinResult | null;
  /** What to tell the player, sent after the identity frame. Null when there is nothing to say. */
  readonly notice: string | null;
}

/** Not a returning player. The common case, and it says nothing to anybody. */
const NO_RECLAIM: ReclaimOutcome = { seat: null, notice: null };

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

  /**
   * Seats held open for players who have dropped (round 4, F8).
   *
   * On the server rather than on an instance, because it has to outlive the connection that
   * made it and be readable by the next one — which is a fact about the *process*, not about a
   * world. Bounded by the live match's teardown; see `ReconnectRegistry`.
   */
  private readonly reconnects = new ReconnectRegistry();

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
      onAborted: (reason) => this.noticeAll(reason),
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
      // One origin for the page and the socket. See `WsServerOptions.staticDir`.
      staticDir: cfg.staticDir,
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
    this.reconnects.clear();
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

  /** Held seats, and what has happened to them (round 4, F8). Read by the flow harness. */
  get reconnectStats(): ReconnectStats {
    return this.reconnects.stats;
  }

  // -- connections ------------------------------------------------------------

  private accept(link: WsLink): void {
    const session = new Session(
      link,
      {
        // The name is already on the session by the time this runs — `Session.handleHello`
        // sanitises it and assigns it before calling — so it is taken from there rather than
        // from the parameter, and there is one sanitised copy rather than two.
        onJoin: (s, _name, claim) => this.onJoin(s, claim),
        onLeave: (s, reason, cause) => this.onLeave(s, reason, cause),
        onLoadout: (s, raw) => this.onLoadout(s, raw),
        onVote: (s, phase, option) => this.onVote(s, phase, option),
        onReady: (s, matchId) => this.onReady(s, matchId),
        onStreakRequest: (s, kind, x, z) => this.onStreakRequest(s, kind, x, z),
        onCheatRequest: (s, code) => this.onCheatRequest(s, code),
      },
      () => this.loop.currentTick,
    );
    this.sessions.push(session);
  }

  /**
   * A `Hello` was accepted: decide where this connection sits (§6.7, and round 4's F8).
   *
   * Three outcomes, in the order they are tried, and the order is the whole policy:
   *
   * 1. **A returning player with a live reservation** goes back to the seat they left — same
   *    instance, same entity id, same side, same scoreboard row. This is F8's *"reconnect"*.
   * 2. **Anybody else, while a match is actually running**, joins that match. This is F8's
   *    *"join a match that is already running"*, and it **reverses §6.7** — see below.
   * 3. **Everybody else** enters through the arena, exactly as before. It is still the entry
   *    point whenever there is no running match to enter, which is most of a cycle.
   *
   * ## Reversing §6.7, deliberately
   *
   * §6.7 said *"a player who joins the server while a live match is running goes to the warmup
   * arena, not into the match, and joins at the next cycle. Warmup is always the entry point."*
   * The fourth playtest asks for the opposite and the amended clause is in PLAN.md, so the spec
   * and the code say the same thing.
   *
   * What the old rule bought was one seating path. What it cost is the whole of F8: a player
   * who dropped out of a five-minute match spent the rest of it in the arena watching a ballot,
   * and so did anybody who arrived while a match was on. The cost of reversing it is smaller
   * than it looks, because the piece that made the arena the safe entry point — the background
   * map build — is about **migration**, not about joining: a fresh connection has not built
   * anything yet either way, and `handshake` already tells it which map before a world exists.
   * A direct join is the arena's own path with a different `mapId`.
   *
   * `RUNNING` only. A match in `READY_WAIT` has not started and its players are still in the
   * arena waiting to be migrated as one; dropping a newcomer straight into it would seat them in
   * a world nobody else is in yet, and `maybeStartLive` counts the arena's sessions to decide
   * when to begin.
   */
  private onJoin(session: Session, claim: Uint8Array | null): JoinResult | null {
    /**
     * The token is minted here, before anything is seated.
     *
     * On the connection rather than on the seat, because it identifies *this socket's right to
     * come back* and has to survive the migrations that reassign everything else about the seat.
     * `Session.sendSeat` stamps it into every assignment, so there is no call site that can
     * forget it.
     */
    session.reconnectToken = this.reconnects.mint();

    const returning = this.reclaimSeat(session, claim);
    if (returning.seat !== null) return returning.seat;
    // Carried into `afterIdentity` as a local rather than parked on the session: it belongs to
    // this one handshake, and a field would be a second place holding a fact with one use.
    const rejoinNotice = returning.notice;

    const live = this.live?.instance ?? null;
    const joinInProgress = live !== null && live.state === InstanceState.RUNNING;
    const destination: MatchInstance = joinInProgress && live !== null ? live : this.warmup;

    const player = destination.seat(session, session.loadout);
    if (player === null) {
      /**
       * The live match refused, so fall back to the arena rather than the connection.
       *
       * §4.20's shape applied one stage earlier: a player who cannot be given the seat they
       * asked for is left somewhere playable with a message, never dropped. The arena is the
       * destination of last resort and always exists.
       */
      if (!joinInProgress) return null;
      const fallback = this.warmup.seat(session, session.loadout);
      if (fallback === null) return null;
      this.router.admit(session, this.warmup);
      return {
        player: fallback,
        afterIdentity: () => {
          this.sendSeatTo(session, this.warmup, fallback.entityId, fallback.team, false);
          if (rejoinNotice !== null) session.notice(rejoinNotice);
          session.notice('The match is full — you are in the arena until the next one.');
          this.sendVoteStateTo(session);
          this.sendPrepareIfBuilding(session);
        },
      };
    }
    this.router.admit(session, destination);

    /**
     * The seat assignment goes out in `afterIdentity`, not here (Tier 2 §D).
     *
     * *"Any side effect of a reconnect that sends a frame must not run inside the hello
     * handler, or its frame overtakes the `Identity` it is a reply to."* In this flow the seat
     * assignment **is** the identity frame, so what has to be deferred is everything downstream
     * of it: the vote state and, if a match is being prepared, the `Prepare` that starts a
     * background build. Sent from inside `onJoin`, either would reach the client before the
     * `Welcome` that tells it who it is, and the handshake drops frames it has no context for.
     */
    return {
      player,
      afterIdentity: () => {
        this.sendSeatTo(session, destination, player.entityId, player.team, false);
        if (rejoinNotice !== null) session.notice(rejoinNotice);
        if (joinInProgress) {
          log.info(`${session.displayName} joined match ${destination.id} in progress.`);
          // The ballot belongs to the arena and this player is not in it. Sending them a vote
          // state would put a ballot on screen for a cycle they cannot take part in — round
          // three's stale-overlay bug, arriving by the one door that was left.
          return;
        }
        this.sendVoteStateTo(session);
        this.sendPrepareIfBuilding(session);
      },
    };
  }

  /**
   * Give a returning player their seat back, or explain why not (round 4, F8).
   *
   * Returns null for *"this is not a returning player"*, which includes a claim that named
   * nothing and a claim whose grace had run out — the difference between those two is what the
   * player is told, and nothing else. A refused claim always falls through to an ordinary join
   * rather than to a refused connection: somebody whose seat has gone still wants to play.
   */
  private reclaimSeat(session: Session, claim: Uint8Array | null): ReclaimOutcome {
    if (claim === null) return NO_RECLAIM;
    const result = this.reconnects.claim(claim);
    if (!result.ok) {
      /**
       * Silence for an unrecognised token, a line for one that ran out.
       *
       * They are genuinely different events and only one of them is worth interrupting somebody
       * for: an *expired* claim means this player had a seat and the grace elapsed, which is
       * the failure F8 asks to be told about. An *unknown* one is the ordinary case — a token
       * from a match that ended cleanly, or from an arena seat that never reserved anything —
       * and nothing was lost, so there is nothing to say.
       */
      return {
        seat: null,
        notice: result.why === 'expired' ? 'Your seat was given away — welcome back.' : null,
      };
    }

    const held = result.reservation;
    const live = this.live?.instance ?? null;
    /**
     * The instance has to still be there, and still be the one the seat is in.
     *
     * A reservation names a `matchId` rather than holding the instance, on purpose: an object
     * reference would keep a destroyed world alive for the length of the grace, which is the
     * shape §4.18's teardown list exists to prevent. `forgetMatch` drops these at teardown, so
     * reaching here with a dead id means a match that ended inside the grace — the player
     * genuinely has no seat to return to, and the arena is the right answer.
     */
    if (live === null || live.id !== held.matchId || live.state !== InstanceState.RUNNING) {
      return { seat: null, notice: 'That match has finished — you are in the arena.' };
    }

    const player = live.seat(session, held.loadout ?? session.loadout, {
      entityId: held.entityId,
      team: held.team,
    });
    if (player === null) {
      return { seat: null, notice: 'Your seat could not be restored — back to the arena.' };
    }
    // The class they were playing, restored onto the connection as well as the body: it is what
    // the next migration locks into the `MatchRequest` (§4.18), and a returning player who then
    // migrated home with the server's defaults would lose their class one cycle later.
    if (held.loadout !== null) session.loadout = held.loadout;
    this.router.admit(session, live);
    log.info(
      `${session.displayName} reconnected into match ${live.id} as entity ${player.entityId} ` +
        `on team ${player.team} — the seat player ${held.playerId} left.`,
    );
    metric('reconnect', 'restored', {
      playerId: session.playerId,
      previousPlayerId: held.playerId,
      matchId: live.id,
      entityId: player.entityId,
      team: player.team,
    });
    return {
      seat: {
        player,
        afterIdentity: () => {
          this.sendSeatTo(session, live, player.entityId, player.team, false);
          session.notice('Reconnected — welcome back.');
        },
      },
      notice: null,
    };
  }

  /**
   * A client asked to spend a streak (M11 Gate B, §8.22).
   *
   * A **request**, and every part of granting it is the server's. §4.16: *"The client is fully
   * untrusted."* So the three things that could be lied about are each answered here rather than
   * taken from the message:
   *
   * - **Which instance.** The router, never the client. A request from somebody in the arena
   *   cannot reach into the live match.
   * - **Whether they may buy it, and whether they can pay.** Two questions since round 4's B9,
   *   because a balance answers only the second. The class check is here: `pricesFor` is the
   *   list the server offered this seat, and a request for anything outside it is a client
   *   asking for a streak it never had a key for. Everything else is inside
   *   `StreakSystem.activate`, which debits through the one door that also refuses a streak
   *   still cooling down and one whose previous instance is still in the world — and it is the
   *   same door a bot would come through, which is what stops there being two economies.
   * - **Where it goes.** At the player's own body, from the *server's* copy of their position.
   *   The only coordinates taken from the client are the mortar's marked point, which is a
   *   genuine choice the player makes on the map overlay and is clamped to the map by
   *   `MortarStrike` itself.
   *
   * A refused request is logged at debug and otherwise silent. It is the ordinary consequence of
   * a double keypress arriving either side of a death, and answering it would mean a message
   * whose only reader is a HUD that the next `Streaks` frame corrects anyway.
   */
  private onStreakRequest(session: Session, kind: number, x: number, z: number): void {
    const instance = this.router.instanceOf(session.playerId);
    const player = session.player;
    if (instance === null || player === null) return;

    const def = STREAK_DEFS[kind];
    if (def === undefined) {
      // A kind index outside the table is malformed rather than merely wrong, and §4.16 puts
      // the response to malformed input at the boundary: count it, drop it, never throw.
      log.warn(`${session.displayName} asked for streak kind ${kind}, which does not exist.`);
      return;
    }

    const streaks = instance.match.streaks;
    if (!streaks.pricesFor(player.entityId).some((p) => p.id === def.id)) {
      log.warn(`${session.displayName} asked for ${def.id}, which is not in their class.`);
      return;
    }

    const sim = player.controller.sim;
    // The mortar is marked on the map overlay; everything else is placed where the caller
    // stands. `MortarStrike` clamps the mark to the playable area.
    const isMortar = def.id === 'mortar';
    const granted = streaks.activate(
      player.entityId,
      def.id,
      isMortar ? x : sim.x,
      isMortar ? 0 : sim.y,
      isMortar ? z : sim.z,
      sim.yaw,
    );
    if (granted === null) {
      // Cannot pay, still cooling, or their last one is still up. Which of the three is in the
      // economy report's refusal counters; here it is one line, because the next `Streaks`
      // frame tells the client the same thing more precisely than a reply could.
      log.debug(`${session.displayName} asked for ${def.id} and was refused.`);
      return;
    }
    log.info(`${session.displayName} called in ${def.id} in instance ${instance.id}.`);
  }

  /**
   * A client typed a cheat code (playtest round 4, F14).
   *
   * **The server decides, and always answers.** God mode, invisibility and free cam are facts
   * about the simulation, so a client that granted itself one would either be ignored or be
   * exploiting a hole; and thirty unearned kills is a purchase nobody made. So the code arrives
   * as text, is parsed against *this* process's copy of the table, and is honoured only if
   * `ServerConfig.cheatsEnabled` says so — which is off unless an operator set
   * `CHEATS_ENABLED=1`.
   *
   * Four things are worth reading in the order they happen:
   *
   * - **An unknown code is answered before the flag is consulted**, because it is a typo rather
   *   than an attempt at anything, and telling somebody "cheats are disabled" about a string
   *   that is not a code would send them looking for an operator they do not need.
   * - **The flag is checked before the seat**, so a server with cheats off gives one answer to
   *   everybody and never reveals whether the code would have worked.
   * - **`DEBUG666` never arrives here.** It is `CHEAT_LOCAL`, the client authors it, and if a
   *   crafted frame sends it anyway the toggle lands in a mask the simulation does not read.
   *   Written down rather than guarded, because the guard is the partition.
   * - **Every grant, revoke and refusal is logged with the resulting mask.** That is the second
   *   half of F14's *"make it visible"*: a bug report from a player who had god mode on is
   *   otherwise indistinguishable from one from a player who did not, and nobody can go back
   *   and ask.
   */
  private onCheatRequest(session: Session, code: string): void {
    const entry = parseCheatCode(code);
    if (entry === null) {
      session.sendCheats(CheatOutcome.RefusedUnknown, session.cheats.mask);
      return;
    }
    if (!this.cfg.cheatsEnabled) {
      log.warn(`${session.displayName} typed a cheat code and this server has cheats disabled.`);
      session.sendCheats(CheatOutcome.RefusedDisabled, session.cheats.mask);
      return;
    }

    const instance = this.router.instanceOf(session.playerId);
    const player = session.player;
    if (instance === null || player === null) {
      session.sendCheats(CheatOutcome.RefusedNoSeat, session.cheats.mask);
      return;
    }

    if (entry.effect.kind === 'instant') {
      /**
       * `MO951357`, and it is the test P7 said it would be for P4's separation.
       *
       * It needs no compensating deduction anywhere, because the balance is **not** a read of
       * `PlayerScore.kills` — P4 built `credit` as a second door precisely so unearned kills can
       * buy streaks without appearing in the match results. `creditKills` is that door, and it
       * already applies the aliveness rule every other unearned credit does.
       *
       * **Nothing is latched.** F14 set a `Wallet` bit here so the payment would leave a trace on
       * screen, and that bit outlived its own subject: the ledger row it described is destroyed
       * by the next migration (`removePlayer` runs `StreakSystem.onOwnerRemoved`), so the tag
       * went on claiming an audit trail for a balance that no longer existed. An instant is
       * *announced* by the client for a display duration — see `CheatKind` — and the durable
       * record of it is this log line and `StreakEconomyReport.credited`, which is where a
       * transaction's record belongs.
       */
      instance.match.streaks.creditKills(player.entityId, entry.effect.kills);
      log.warn(
        `CHEAT: ${session.displayName} (player ${session.playerId}) took ` +
          `${entry.effect.kills} kills into their streak balance in instance ${instance.id}; ` +
          `entitlements unchanged at ${describeCheatMask(session.cheats.mask)}.`,
      );
      session.sendCheats(CheatOutcome.InstantApplied, session.cheats.mask);
      return;
    }

    if (entry.effect.kind !== 'toggle') {
      /**
       * A `'surface'` code reaching the server is a client that should never have sent it.
       *
       * `DEBUG666` is the only one, it grants no entitlement, and `Game.requestCheat` returns
       * before the send. So this is unreachable from the shipped client and is refused rather
       * than asserted: §4.16 answers a frame that makes no sense at the boundary, and the type
       * system knowing it cannot happen is not the same as the socket knowing.
       */
      log.warn(`${session.displayName} sent a client-side code to the server. Refused.`);
      session.sendCheats(CheatOutcome.RefusedUnknown, session.cheats.mask);
      return;
    }

    const before = session.cheats.mask;
    const after = toggleCheat(before, entry.effect.bits);
    session.cheats.set(after);
    const granted = (after & entry.effect.bits) !== 0;
    log.warn(
      `CHEAT: ${session.displayName} (player ${session.playerId}) ` +
        `${granted ? 'enabled' : 'cleared'} a cheat in instance ${instance.id}; ` +
        `mask now ${describeCheatMask(after)}.`,
    );
    session.sendCheats(granted ? CheatOutcome.Granted : CheatOutcome.Revoked, after);
  }

  /**
   * A connection ended. Free the seat, and hold it open if it is worth holding (§6.7, F8).
   *
   * The reservation is made **before** `router.release`, and the order is the whole of it: the
   * release is what removes the entity, replaces it with a bot and takes the seat out of the
   * instance, so by the time it returns there is nothing left to describe. Everything the
   * reservation needs — which instance, which entity, which side, which class — is read while
   * the seat still exists.
   *
   * Only a **lost** connection is held, and only a seat in a **running live match**. A `Bye` is
   * the player saying they are done — see `LeaveCause` — and an arena seat is worth nothing to
   * hold: it
   * records no score (F7), carries no objective state and is handed out instantly to anybody who
   * asks, so a reservation for one would be a map entry protecting nothing. That is also what
   * bounds the registry — see `ReconnectRegistry`.
   */
  private onLeave(session: Session, reason: string, cause: LeaveCause): void {
    if (cause === 'lost') this.holdSeatForReturn(session);
    this.router.release(session.playerId);
    this.voteCycle.forget(session.playerId);
    session.player = null;
    log.info(`connection from ${session.link.remoteAddress} closed: ${reason}`);
  }

  private holdSeatForReturn(session: Session): void {
    const token = session.reconnectToken;
    const player = session.player;
    if (token === null || player === null) return;
    const instance = this.router.instanceOf(session.playerId);
    const live = this.live?.instance ?? null;
    if (instance === null || live === null || instance !== live) return;
    if (live.state !== InstanceState.RUNNING) return;
    this.reconnects.reserve(token, {
      playerId: session.playerId,
      displayName: session.displayName,
      matchId: live.id,
      entityId: player.entityId,
      team: player.team,
      loadout: session.loadout,
    });
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

    /**
     * Queue it on whichever instance holds this player, for their next spawn (§6.6).
     *
     * Two things happen and both matter. The session copy is what gets **locked into the
     * `MatchRequest` at migration** (§4.18) — that is Tier 1 #20's fix and it is why the class
     * lives on the connection rather than in a world. The instance copy is what takes effect
     * *now*, on the next respawn in the arena, so a player who edits their class sees it in
     * their hands before the match starts.
     *
     * A player with no instance is mid-migration; the session copy still lands, so the class
     * travels with them and applies on their first spawn in the destination.
     */
    const instance = this.router.instanceOf(session.playerId);
    const player = session.player;
    const queued =
      instance !== null && player !== null
        ? instance.match.setPendingLoadout(player.entityId, clean)
        : false;
    /**
     * During the pre-match countdown it applies **now** rather than on the next spawn.
     *
     * That is what makes the quick class selector mean what it says — see
     * `ServerMatch.applyPendingLoadoutNow` for why the freeze is the one window where an
     * immediate change cannot cost a misprediction. Everywhere else this returns false and the
     * ordinary §6.6 deferral stands.
     */
    const immediate =
      queued && player !== null && instance !== null
        ? instance.match.applyPendingLoadoutNow(player.entityId)
        : false;

    log.info(
      `${session.displayName} set class "${clean.name}" — ` +
        `${clean.primary.weaponId}/${clean.secondary.weaponId}, ` +
        `perks [${clean.perks.filter((p) => p !== null).join(', ')}]. ` +
        (immediate
          ? 'Applied now (pre-match countdown).'
          : queued
            ? 'Applies on next spawn.'
            : 'Applies when they next exist in a world.'),
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
    /**
     * 1. Drain sockets. Commands land in input buffers before anything simulates.
     *
     * Wrapped **per session** (M11 playtest). S4.16 requires that *"malformed input must never
     * crash the server"*, and the decode paths honour that — `ByteReader` does not throw and
     * `decodeHeader` returns `bad` rather than raising. What was unguarded is the layer above:
     * the *handlers*. `onLoadout` runs `resolveLoadout` over a class a client chose, and a
     * throw there escaped the tick entirely, taking the rest of the drain, the whole
     * simulation step and the flow with it.
     *
     * Per session rather than around the loop, so one client's bad frame costs that client its
     * frame and nobody else theirs. The connection is dropped rather than left in an unknown
     * state — S4.16's answer to anything the server does not like is to close the link.
     */
    for (const s of this.sessions) {
      try {
        s.receive();
      } catch (err) {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        log.error(`session ${s.playerId} (${s.displayName}) threw while receiving: ${message}`);
        metric('server', 'receiveFault', { playerId: s.playerId, reason: String(err) });
        s.close('malformed message');
      }
    }

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
    this.stepFlowGuarded(tickIndex);

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

  /**
   * The flow step, wrapped — and recovered from (M11 playtest).
   *
   * §4.18 requires each *instance's* step to be wrapped so one world cannot take down the
   * process. The **scheduler** around them was not, and it is the newest and most intricate
   * code in the milestone: allocation continuations, the readiness handshake, the named-tick
   * migration and teardown all run here.
   *
   * An exception escaping this used to reach `serve.ts`'s `uncaughtException` handler, which
   * logs it and keeps the process alive — leaving the flow in a half-built state with
   * `this.live` set and no instance able to reach `ENDED`. Every subsequent cycle then hit the
   * one-live-match cap and returned everybody to the arena. From the player's side that is a
   * server which votes, counts down, and then silently does nothing, for ever, which is what
   * the playtest reported.
   *
   * So it is caught here and **recovered**: the half-built match is destroyed, everybody is put
   * back in the arena and told, and the cycle resumes. A cycle lost is a bad outcome; a server
   * that has quietly stopped starting matches is a much worse one.
   */
  private stepFlowGuarded(tickIndex: number): void {
    try {
      this.stepFlow(tickIndex);
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.error(`the skirmish flow threw: ${message}`);
      metric('server', 'flowFault', { tick: tickIndex, reason: String(err) });
      this.recoverFlow(tickIndex);
    }
  }

  /**
   * Put the flow back to a state it can run from.
   *
   * Deliberately blunt: whatever the live match was doing, it is now unreachable. Everybody
   * goes back to the arena — the one world that always exists — the instance is released, and
   * the cycle starts again from free play. Each step is itself guarded, because a recovery that
   * throws is a recovery that leaves the process worse than it found it.
   */
  private recoverFlow(tickIndex: number): void {
    try {
      this.returnEveryoneToWarmup(tickIndex, '');
    } catch (err) {
      log.error(`flow recovery could not return every player to the arena: ${String(err)}`);
    }
    try {
      void this.destroyLive();
    } catch (err) {
      log.error(`flow recovery could not destroy the live match: ${String(err)}`);
    }
    this.live = null;
    this.allocating = false;
    this.noticeAll('The match could not be started — back to the arena.');
    this.voteCycle.resume(tickIndex);
  }

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
      case InstanceState.RUNNING:
        this.maybeAbandonLive(instance, tickIndex);
        return;
      case InstanceState.ENDED:
        this.finishLive(instance, tickIndex);
        return;
      default:
        return;
    }
  }

  /**
   * Every human left a running match: shut it down (§4.9, §4.20).
   *
   * §4.20 already refuses to *start* a match for zero humans, in two places — the vote cycle
   * cancels when the last human disconnects, and `maybeStartLive` destroys an instance nobody
   * is left to migrate into. Neither of them covers the case after `RUNNING`, and until now
   * nothing did: a match whose last player pulled their cable kept simulating ten bots to a
   * win condition, held the process's single live-match slot for the whole of it, and only
   * then released it. Every ballot that resolved in the meantime hit the one-match cap and
   * sent the arena back to free play with a notice — so one disconnect could cost the *next*
   * lobby its match.
   *
   * The bots are not asked whether they mind. There is nobody to watch them, no summary to
   * deliver — `finishLive` sends one to `instance.sessions`, which is empty — and no XP to
   * bank, so the ordinary end-of-match path would do nothing but wait.
   *
   * `abandoned` rather than `playerCount === 0` on purpose: see `LiveMatch.everSeated`.
   */
  private maybeAbandonLive(instance: LiveMatch, tickIndex: number): void {
    if (!instance.abandoned) return;
    log.info(
      `match ${instance.id}: every human has left a running match. ` +
        `Destroying it and freeing the slot (${instance.botCount} bot(s) discarded).`,
    );
    metric('allocator', 'abandoned', {
      matchId: instance.id,
      tick: tickIndex,
      bots: instance.botCount,
    });
    void this.destroyLive();
    this.voteCycle.resume(tickIndex);
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
      /**
       * A vote resolved while a match already exists.
       *
       * §4.9 caps the process at one live match, so this is the cap doing its job — but it is
       * also the signature of a `LiveMatch` that never reached `ENDED` and was therefore never
       * destroyed, which would silently abort every cycle from then on. Logged loudly with the
       * offending instance's state so the second reading is distinguishable from the first.
       */
      const state = this.live === null ? 'allocating' : instanceStateName(this.live.instance.state);
      log.warn(
        `a vote resolved while a match was already present (state ${state}); ignoring it. ` +
          'If this repeats, a live match is stuck and is holding the only slot.',
      );
      this.noticeAll('The previous match has not finished — staying in the arena.');
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
        botFill: { count: 10, tier: this.cfg.botDifficulty },
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
      log.warn(`match ${instance.id}: nobody left in the arena to migrate. Destroying it.`);
      this.noticeAll('The match was cancelled — nobody left to play it.');
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
          `(${summary.reason}). Holding the summary until tick ${summary.endsTick}, ` +
          `${this.cfg.summaryHoldSeconds}s from now.`,
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
    /**
     * The held seats go with the world they were in (round 4, F8).
     *
     * A reservation names a `matchId`, so one that outlives its instance can never be redeemed
     * — it would be a row nobody deletes, one per player per match, in a process §8.13 measures
     * over a hundred allocate/destroy cycles. Released here rather than swept on a timer,
     * because the instance ending is the exact moment the seat stops existing.
     */
    this.reconnects.forgetMatch(handle.id);
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
      botFill: { count: 10, tier: this.cfg.botDifficulty },
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

  /**
   * A line for **every connected player**, wherever they are seated.
   *
   * Distinct from `instance.broadcast`, which reaches one world. An aborted transition is
   * exactly the case where "one world" is the wrong set: the players are in the arena, the
   * instance that failed may not exist, and §4.17 requires all of them to be told.
   */
  private noticeAll(text: string): void {
    for (const session of this.sessions) {
      if (!session.closed && session.state === 'live') session.notice(text);
    }
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
      difficulty: this.cfg.botDifficulty,
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
