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
  ballotOpened,
  isArenaInstance,
  MAP_BALLOT,
  MODE_BALLOT,
  sanitiseNetLoadout,
  VotePhase,
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
import { STREAK_DEFS } from '../../shared/streaks/StreakDefs';
import { hashModeState, type ModeStateFacts } from '../../shared/debug/ModeStateHash';
import {
  NO_SPECTATOR_TARGET,
  pickSpectatorTarget,
  type SpectatorCandidate,
} from '../../shared/modes/SpectatorTarget';
import { bombStateCode } from '../../shared/net/Messages';
import { phaseAt } from '../../shared/net/Messages';
import { RESPAWN_SECONDS } from '../../shared/ai/BotDirector';
import {
  // `debugOverlayVisible` is deliberately absent: it reads only the front-end screen and the
  // request, and this process has neither. It is on the browser list rather than measured
  // here under a state sequence it does not depend on.
  briefVisible,
  cheatTag,
  matchCaption,
  quickLoadoutWindow,
  resultSurfacesVisible,
  scoreboardOpen,
  stepRespawnDisplay,
  type HudSurfaceState,
} from '../../shared/ui/HudSurfaces';
import { OBJ_TEAM_A, OBJ_TEAM_B, type ObjectiveState } from '../../shared/net/Skirmish';
import type { BombInfo, TagInfo } from '../../shared/modes/GameMode';

/**
 * Consecutive disagreeing hash samples before a divergence is believed (§7).
 *
 * The same reasoning and the same number as `DivergenceChecker.CONFIRM_SAMPLES`: a client is
 * always a snapshot behind on something, and a comparator that reports its first disagreement
 * reports one on every kill. Four consecutive samples is a quarter of a second of sustained
 * disagreement at 20 Hz, which no amount of in-flight latency explains.
 */
const HASH_CONFIRM_SAMPLES = 4;
import { NodeLink } from './NodeLink';

/** The Chopper Gunner's index in `STREAK_DEFS`, resolved once rather than hardcoded. */
const CHOPPER_KIND = STREAK_DEFS.findIndex((d) => d.id === 'chopper');

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
  /**
   * Throw a lethal every N ticks, or 0 never (§8.24).
   *
   * The only way the *human* half of the grenade path gets exercised headlessly: bots throw on
   * their own, but a grenade thrown from a replicated command is a different code path — the
   * server's `ThrowController` reading the same command the client predicted from.
   */
  readonly throwEveryTicks?: number;
  /**
   * Reproduce the browser's summary-screen gate (playtest round 4, B4). **A red control.**
   *
   * `Game.simulate` used to call `NetClient.update` only while the screen was `MATCH`, so from
   * the frame the post-match board went up the client stopped pinging, stopped reading and
   * stopped noticing its own link. The hold is 14 s and `CLIENT_TIMEOUT_MS` is 10 000, so the
   * server reaped every player who watched the board four seconds before it would have migrated
   * them home — and no harness run could ever see it, because a `HeadlessClient` pumps
   * unconditionally and has no screen to gate on.
   *
   * With this set the client goes silent from `MsgS.Summary` until the deadline that message
   * carries, which is exactly what the shipped client did. It exists so the probe below can be
   * watched red.
   */
  readonly gateOnSummary?: boolean;

  /**
   * Type this cheat code once the live match is running (playtest round 4, F14).
   *
   * The literal text, exactly as a player types it into the pause screen's field, because the
   * server parses the text and this harness's whole job is to be the client that sends what a
   * browser sends. A code with no seat to apply it to proves nothing, so it waits for the live
   * match rather than firing in the arena.
   *
   * It is sent **once**. A code is a toggle, so a repeating request would spend the run turning
   * god mode on and off again at whatever rate the timer fired at.
   */
  readonly cheatCode?: string;

  /**
   * Type it in the **arena**, before the migration, instead of in the live match (F14's fix).
   *
   * The reproduction for the regression F14 shipped, and the reason it needs a flag of its own:
   * the original probe typed its code once the client was already seated in the live match, so
   * the only migration in the run happened *before* any entitlement existed and no run could
   * have seen one cross it. Typing it in the arena puts a live entitlement on the seat that the
   * ballot is about to take away.
   *
   * It is also the case that matters most, because it is the silent one: god mode in the arena
   * does nothing at all — F7 spares every combatant in that room — so an entitlement that
   * followed the player out of it would first take effect in a match nobody typed it in.
   */
  readonly cheatInArena?: boolean;
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

  /** Which instance this client is in. See `isArenaInstance`. */
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
  /** Streak frames received, distinct live entities ever seen, and the peak at once. */
  readonly streakFrames: number;
  readonly streakEntitiesSeen: number;
  readonly peakStreakEntities: number;
  /** Frames carrying a friendly UAV sweep, and how many activations were asked for. */
  readonly sweepFrames: number;
  /** §7/§8.21: mode-state hash samples, confirmed mismatches, and the first mismatching tick. */
  /**
   * The HUD-surface invariant (playtest round 4, §P1). See `shared/ui/HudSurfaces.ts`.
   *
   * Every one of these is a count of ticks over which the *rule* was evaluated against real
   * replicated state. Nothing here claims a pixel was drawn — this process has no DOM — but
   * the rule is the half that can be wrong invisibly, and it is the half the three reports
   * were actually about.
   *
   * `quickLoadoutAlive` is the B13 assertion and it is written to go red rather than green:
   * a panel that outlived the respawn it belongs to is a panel up while the player is alive
   * and outside the pre-match freeze, which is exactly one comparison.
   */
  readonly deadTicks: number;
  readonly quickLoadoutTicks: number;
  readonly quickLoadoutRespawnTicks: number;
  readonly quickLoadoutPrematchTicks: number;
  readonly quickLoadoutAlive: number;
  readonly quickLoadoutWindows: number;
  /**
   * B6. `scoreboardHeldTicks` is the bit as it survived `NetClient.neutralise` and reached the
   * sim; `...WhileDead` is the same count restricted to the ticks the server says we are dead,
   * which is the number that was zero before this session and is the whole of the report.
   */
  readonly scoreboardHeldTicks: number;
  readonly scoreboardHeldWhileDeadTicks: number;
  readonly scoreboardOpenWhileDeadTicks: number;
  /**
   * F7. The lowest health this client was ever seen at **inside the arena**, and how many of
   * its deaths happened there.
   *
   * Read off the replicated owner entity rather than from a damage event, because the claim is
   * about health and not about being shot at: the room keeps *"damage live"*, so a run in which
   * nothing ever shot at this client would go green on a damage counter while proving nothing.
   * `warmupHitsTaken` is what makes the pair honest — it is the number that must stay non-zero.
   *
   * 101 rather than 100 as the initial value, so "never sampled" is distinguishable from "never
   * hurt" in a report.
   */
  readonly warmupMinHealth: number;
  readonly warmupHitsTaken: number;
  readonly warmupDeaths: number;
  /**
   * The same three, in a **live match** (playtest round 4, F14).
   *
   * The arena's copies cannot answer F14's questions: since F7 nobody in the room can be hurt at
   * all, so a health floor of 100 there is the room's rule rather than god mode. These are the
   * live-match numbers, and they are what `SPEC[]1` and `SPEC[]2` are measured through.
   *
   * `liveHitsTaken` is the one that makes the pair honest, exactly as `warmupHitsTaken` does for
   * F7: a run in which nobody shot at this client would report a floor of 100 and prove nothing.
   * Read it against `DamageSystem.blockedByInvulnerable` on the server, which is what tells the
   * two cheats apart — an invisible player takes no hits because nobody fires, and a god-mode
   * player takes no hits because the door refuses them.
   */
  readonly liveMinHealth: number;
  readonly liveHitsTaken: number;
  readonly liveDeaths: number;
  /**
   * Of those, the ones that landed **after** the entitlement arrived (playtest round 4, F14).
   *
   * The discriminator the first green run turned out to need. `SPEC[]2` is typed once the client
   * is already in the live match, so a hit taken in the seconds before the answer came back is
   * counted by `liveHitsTaken` and says nothing about invisibility. Splitting the count at the
   * moment the mask arrives is what separates *"perception did not stop this"* from *"this
   * happened before perception was asked"* — and only the first of those is a claim about F14.
   */
  readonly liveHitsWhileCheated: number;
  /** The entitlement mask this client currently holds, replicated (F14). */
  readonly cheatMask: number;
  /** Codes sent, and the outcomes the server answered with, in order (F14). */
  readonly cheatRequests: number;
  readonly cheatOutcomes: readonly number[];
  /** Which instance the code was typed in, or -1 if none was. */
  readonly cheatMatchId: number;
  /**
   * Ticks this client held an entitlement **in an instance it was not granted in** (F14's fix).
   *
   * The blocking assertion, and it is deliberately about the mask rather than about the caption.
   * The caption was the visible half of the regression; the mask surviving a migration was the
   * dangerous half, because god mode following a player out of the arena — where it is a no-op —
   * into a live match is a cheat nobody typed in the match it took effect in.
   *
   * Must be **0**. Counted per real tick, against `cheatTicks` below so a zero that means "never
   * held anything" fails as loudly as a zero that means "never leaked".
   */
  readonly cheatTicksInOtherInstance: number;
  /** Ticks an entitlement was held at all, anywhere. The denominator for the row above. */
  readonly cheatTicks: number;
  /** Ticks the HUD tag rendered non-empty in an instance the code was not typed in. */
  readonly cheatTagTicksInOtherInstance: number;
  /**
   * F13. Ballot-cue edges against the broadcasts that carried a ballot phase.
   *
   * The second number is the red control and it is the whole point of printing both: a sound
   * played level-triggered on the broadcast would fire `ballotBroadcasts` times, and the
   * requirement is that it fires `ballotOpens` times — **one per ballot opening**, so two per
   * cycle now that the mode ballot is cued as well as the map one.
   */
  readonly ballotOpens: number;
  readonly ballotBroadcasts: number;
  /**
   * F12. Ticks the centred caption was up in the arena, and in a live match.
   *
   * The second is written to go red rather than green: `WAITING` on screen during a live match
   * is the surface outliving the thing it describes, which is the failure mode every rule in
   * `shared/ui/HudSurfaces.ts` exists to make measurable.
   */
  readonly captionArenaTicks: number;
  readonly captionWaitingInLiveTicks: number;
  /**
   * F7's result surfaces — the score banner, the Tab board and the streak strip.
   *
   * The arena count is the violation and must be 0; the live count is its control, because a
   * run in which the HUD was down everywhere would report 0 and prove nothing.
   */
  readonly resultSurfacesInArenaTicks: number;
  readonly resultSurfacesLiveTicks: number;
  /**
   * F10. Ticks the mode brief was up, and the two numbers that make that one mean something.
   *
   * `briefTicks` is the window itself. `briefWindows` counts how many times it *opened*, because
   * "once per match, at the start" is the requirement and a tick count cannot tell one
   * ten-second window from ten one-second ones — the windows are what the assertion is written
   * against.
   *
   * `briefArenaTicks` is the **control**, and getting that wrong is worth recording. It counts
   * the ticks in the waiting room on which the phase-and-round rule *alone* would have opened
   * the brief — the arena term of `briefVisible` is passed `false` deliberately — so it is the
   * F13 shape: the number a rule without that term would have produced, printed beside the
   * number the rule with it does. It is **not** an assertion, and the first draft of this probe
   * made it one, which would have failed every run for doing exactly what it is meant to do.
   * Asking `briefVisible` whether `briefVisible` suppresses the arena is a probe that can only
   * be green, and the honest version of that question is the control.
   */
  readonly briefTicks: number;
  readonly briefWindows: number;
  readonly briefArenaTicks: number;
  /** §6.8 spectator picks, and the three invariant violations. All three must be zero. */
  readonly spectatePicks: number;
  readonly spectateSelfPicks: number;
  readonly spectateEnemyPicks: number;
  readonly spectateDeadPicks: number;
  readonly hashSamples: number;
  readonly hashMismatches: number;
  readonly firstMismatchTick: number;
  /** Projectile frames, distinct grenades thrown by others, and echoes of this client's own. */
  readonly projectileFrames: number;
  readonly remoteProjectiles: number;
  readonly ownProjectileSeen: number;
  readonly peakProjectiles: number;
  readonly smokeFrames: number;
  /** Frames carrying a live Chopper Gunner, and when the last one arrived (§8.23). */
  readonly chopperFrames: number;
  readonly lastChopperMs: number;
  /** When a chopper owned by each entity was last seen, for the §8.23 case-4 assertion. */
  readonly lastChopperMsByOwner: ReadonlyMap<number, number>;
  readonly pendingSeen: number;
  readonly streakRequests: number;
  readonly contactsSeen: number;
  /**
   * Entity ids seen as UAV contacts **while in a live match**, and the id held there.
   *
   * The pair travels together because comparing one against an id from another instance is
   * meaningless — see `onStreaks`.
   */
  readonly contactIdList: readonly number[];
  readonly liveEntityId: number;
  /** Which side the server put this client on. Decides who is an enemy for the Ghost test. */
  readonly team: 'A' | 'B';
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
  /**
   * The post-match hold, end to end (playtest round 4, B4).
   *
   * `summaryHoldMs` is wall time from `MsgS.Summary` to the return migration actually landing —
   * what the player spends on the summary screen. `summarySaidSeconds` is what the screen was
   * told to display for the same interval, from the deadline on the wire. Printing both is the
   * point: they are two independent answers to one question, and the screen's number was a
   * guess against a clock it had stopped reading.
   *
   * `droppedOnSummary` is the assertion. A client that watched the board out and was closed
   * rather than migrated is the whole of B4, and it must be false.
   */
  readonly summaryHoldMs: number;
  readonly summarySaidSeconds: number;
  readonly droppedOnSummary: boolean;
  readonly notices: readonly string[];
  /** Vote phases this client cast a vote in. */
  readonly votesCast: number;

  // -- reconnect (playtest round 4, F8) ---------------------------------------

  /** How many times this client dropped its socket and dialled back in. */
  readonly reconnects: number;
  /** Re-dial to the first synchronised frame, ms, or -1 if it never got one back. */
  readonly resyncMs: number;
  /** The seat as it stood the instant before the drop, or null if this client never dropped. */
  readonly seatBeforeDrop: SeatSnapshot | null;
  /** The seat this client came back to, or null if it never came back. */
  readonly seatAfterReturn: SeatSnapshot | null;
  /** §7 divergence, counted only over frames **after** a return. Denominator included. */
  readonly hashSamplesAfterReturn: number;
  readonly hashMismatchesAfterReturn: number;
}

/**
 * What a seat is, for the purpose of asking whether it survived (round 4, F8).
 *
 * The entity id is the whole question: it is what the score row, the streak ledger, the hand
 * and the rewind history are all keyed by, so a seat that came back with the same id came back
 * with all of them and one that did not came back with none. `matchId` is beside it because a
 * player who returned to the *arena* has technically kept a seat and has not kept **theirs**.
 */
export interface SeatSnapshot {
  readonly entityId: number;
  readonly matchId: number;
  readonly team: 'A' | 'B';
  readonly atMs: number;
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
  /**
   * The post-match hold, as this client experienced it (playtest round 4, B4).
   *
   * `awaitingReturn` latches at the summary and clears on the migration back to the arena, so
   * a client that never comes home is distinguishable from one that came home instantly —
   * a zero that means "never looked" has to fail as loudly as a zero that means "no wait".
   */
  private summaryAtMs = 0;
  private summarySaidSeconds = 0;
  private summaryHoldMs = -1;
  private awaitingReturn = false;
  private droppedOnSummary = false;
  /**
   * Wall-clock deadline while the summary gate holds this client silent, or -1.
   *
   * Wall clock rather than ticks, and that is not a shortcut: a gated client is not calling
   * `NetClient.update`, so `stats.clientTick` is frozen for exactly as long as the gate lasts.
   * A gate that waited for a tick it was itself preventing would never lift — which is the same
   * frozen-clock trap `LiveMatch.summaryElapsed` documents on the server side.
   */
  private gatedUntilMs = -1;
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
  private streakFrames = 0;
  private readonly streakInstanceIds = new Set<number>();
  private peakStreakEntities = 0;
  private sweepFrames = 0;
  /** The §7 hash: samples taken, confirmed mismatches, and where the first one landed. */
  private hashSamples = 0;
  private hashMismatches = 0;
  private hashMismatchStreak = 0;
  private firstMismatchTick = -1;
  /** The replicated mode state, exactly as decoded. Hashed against the server's own. */
  private repZones: readonly ObjectiveState[] = [];
  private repTags: readonly TagInfo[] = [];
  private repBomb: BombInfo | null = null;
  private readonly factTagIds: number[] = [];
  /** §6.8 spectator: picks made, and the three kinds of pick that must never happen. */
  private spectateTarget = NO_SPECTATOR_TARGET;
  private spectatePicks = 0;
  private spectateSelfPicks = 0;
  private spectateEnemyPicks = 0;
  private spectateDeadPicks = 0;

  /**
   * The HUD-surface probe (playtest round 4, §P1).
   *
   * `respawnDisplay` is the death screen's countdown, stepped by the **same shared function**
   * `ClientMatch` steps — set on the death edge, decremented while dead, zeroed on the respawn
   * edge. It is modelled rather than replicated because it is a client-side display value: the
   * server owns *when* the body comes back, and this owns the number describing the wait. The
   * quick class selector's window is derived from it, so a harness that could not step it could
   * not evaluate the rule at all.
   */
  private respawnDisplay = 0;
  private deadTicks = 0;
  private quickLoadoutTicks = 0;
  private quickLoadoutRespawnTicks = 0;
  private quickLoadoutPrematchTicks = 0;
  private quickLoadoutAlive = 0;
  private quickLoadoutWindows = 0;
  private lastQuickWindow: 'none' | 'prematch' | 'respawn' = 'none';
  private scoreboardHeldTicks = 0;
  private scoreboardHeldWhileDeadTicks = 0;
  private scoreboardOpenWhileDeadTicks = 0;
  /** F7/F12/F13. See the fields of the same name on `HeadlessClientReport`. */
  private warmupMinHealth = 101;
  private warmupHitsTaken = 0;
  private warmupDeaths = 0;
  private liveMinHealth = 101;
  private liveHitsTaken = 0;
  private liveDeaths = 0;
  private liveHitsWhileCheated = 0;
  /** F14. Sent once; see `HeadlessClientOptions.cheatCode`. */
  private cheatSent = false;
  private cheatRequests = 0;
  private readonly cheatOutcomes: number[] = [];
  private cheatMatchId = -1;
  private cheatTicks = 0;
  private cheatTicksInOtherInstance = 0;
  private cheatTagTicksInOtherInstance = 0;
  private ballotOpens = 0;
  private ballotBroadcasts = 0;
  private lastVotePhaseHeard: number = VotePhase.IDLE;
  private captionArenaTicks = 0;
  private captionWaitingInLiveTicks = 0;
  private resultSurfacesInArenaTicks = 0;
  private resultSurfacesLiveTicks = 0;
  private briefTicks = 0;
  private briefWindows = 0;
  private briefArenaTicks = 0;
  private briefWasOpen = false;
  private projectileFrames = 0;
  private readonly remoteSerials = new Set<number>();
  private ownProjectileSeen = 0;
  private peakProjectiles = 0;
  private smokeFrames = 0;
  private chopperFrames = 0;
  private lastChopperMs = 0;
  /** When a chopper owned by each entity id was last seen. Keyed by owner, see `onStreaks`. */
  private readonly lastChopperMsByOwner = new Map<number, number>();
  /** Entity ids this client has ever seen as a UAV contact. The Ghost assertion reads it. */
  readonly contactIds = new Set<number>();
  /** Contacts seen while in a live match, and the entity id held there. See `onStreaks`. */
  private readonly liveContactIds = new Set<number>();
  private liveEntityId = -1;
  private pendingSeen = 0;
  /** Kind index the replica says is spendable, or -1. Consumed by `update`. */
  private wantStreak = -1;
  private streakRequests = 0;
  private lastStreakRequestTick = -999;
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

  /**
   * The drop-and-return probe (playtest round 4, F8).
   *
   * `awaitingResync` is the latch that makes the resync time honest: it opens at the moment
   * the re-dial is asked for and closes on the first frame `NetClient.synchronised` is true,
   * which is the first frame the server has told this client where it is. Anything measured
   * to the socket opening instead would be reporting a TCP handshake.
   *
   * `hashSamplesAfterReturn` is counted separately from the run total for the reason the
   * §7 checker's own `hashSamples === 0` branch exists: a returning client is exactly the case
   * the divergence checker should be speaking about, and a zero mismatch count over zero
   * samples is a probe that never looked.
   */
  private reconnects = 0;
  private awaitingResync = false;
  private reconnectAtMs = 0;
  private resyncMs = -1;
  private returned = false;
  private seatBeforeDrop: SeatSnapshot | null = null;
  private seatAfterReturn: SeatSnapshot | null = null;
  private hashSamplesAfterReturn = 0;
  private hashMismatchesAfterReturn = 0;

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
      /**
       * The HUD-surface probe rides the browser's own seam (playtest round 4, §P1).
       *
       * `applyNonReplayed` is where `MatchWorld` hands the command to `ClientMatch`, and the
       * command it receives is the **neutralised** one — which is the entire point. B6 was
       * `neutralise` zeroing `Btn.Scoreboard` along with everything else while dead, so the
       * only place that can see the bug is the far side of that call. Run once per real tick
       * and never on a replay, which is also what makes the tick counts honest.
       */
      applyNonReplayed: (cmd) => this.observeSurfaces(cmd),
      events: {
        onDamage: (e) => {
          if (e.sourceId === this.net.entityId) {
            this.hitsDealt++;
            if (e.lethal) this.killsDealt++;
          }
          if (e.targetId === this.net.entityId && e.lethal) this.deaths++;
          /**
           * F7's two halves, counted separately on purpose.
           *
           * `warmupHitsTaken` is the *"damage live"* half §6.3 keeps and this session must not
           * break: a run in which the arena's bots never engaged would report a health floor of
           * 100 and prove nothing at all. `warmupDeaths` is the half F7 removes.
           */
          if (e.targetId === this.net.entityId && isArenaInstance(this.net.matchId)) {
            this.warmupHitsTaken++;
            if (e.lethal) this.warmupDeaths++;
          }
          // F14's half of the same pair, in a match where damage is real. Split by instance
          // rather than counted together, because the arena refuses the deduction for everybody
          // and a combined number could not tell a cheat from the room's own rule.
          if (e.targetId === this.net.entityId && !isArenaInstance(this.net.matchId)) {
            this.liveHitsTaken++;
            if (e.lethal) this.liveDeaths++;
            if (this.net.cheatMask !== 0) this.liveHitsWhileCheated++;
          }
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
        onSummary: (info) => {
          this.summaries++;
          this.summaryAtMs = nowMs();
          // What the screen is told to show for this hold, from the deadline the server sent
          // and the tick this client believes it is on — the browser's own arithmetic.
          this.summarySaidSeconds = Math.max(0, (info.endsTick - this.net.stats.clientTick) * DT);
          this.awaitingReturn = true;
          if (this.opts.gateOnSummary === true) {
            this.gatedUntilMs = nowMs() + this.summarySaidSeconds * 1000;
          }
        },
        onNotice: (text) => {
          this.notices.push(text);
        },
        /**
         * The server's answer to a cheat code (playtest round 4, F14).
         *
         * Every outcome is recorded in order, because the shape of the list is the measurement:
         * a run with the flag off must be all refusals and a run with it on must be all grants,
         * and a probe that counted only "did anything come back" would go green on either.
         */
        onCheats: (outcome) => {
          this.cheatOutcomes.push(outcome);
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
          // Kept verbatim for the §7 hash — the values as decoded, not re-derived.
          this.repZones = states;
        },
        /**
         * Killstreaks (Gate B, §8.22).
         *
         * The counters are chosen to fail against the plausible bugs rather than to succeed
         * against the feature. `streakEntitiesSeen` counts **distinct instance ids**, so a
         * server that replicated an empty list twenty times a second scores zero; and the
         * contact bookkeeping records *which entity ids* were seen rather than how many, which
         * is what makes the Ghost assertion possible at all.
         *
         * Spending is driven from here too: the moment the replica says something is
         * spendable, ask for it. That closes the loop — earn, replicate, request, grant,
         * replicate the entity — through the real messages rather than a test hook.
         */
        /**
         * Grenades and smoke (Gate B, §8.24).
         *
         * `remoteSerials` counts **distinct grenades thrown by somebody else**, which is the
         * number the feature is actually about: a client that only ever saw its own would score
         * zero here while a frame counter went green. `ownSeen` is the other half — the
         * authoritative echo of this client's own throw, which is what reconciliation has to
         * match against and which the double-render check depends on being excluded from the
         * render list.
         */
        onProjectiles: (projectiles, smoke) => {
          this.projectileFrames++;
          for (const p of projectiles) {
            if (p.ownerId === this.net.entityId) this.ownProjectileSeen++;
            else this.remoteSerials.add(p.serial);
          }
          if (projectiles.length > this.peakProjectiles) this.peakProjectiles = projectiles.length;
          if (smoke.length > 0) this.smokeFrames++;
        },
        /**
         * The §7 divergence check.
         *
         * The server's hash of tick N arrives **after** every channel describing tick N, so by
         * the time this runs the replicated copies below are the client's complete answer to
         * "what did tick N look like". Hashing them with the same function the server used and
         * comparing is the whole check.
         *
         * A mismatch is confirmed across consecutive samples before it is believed, for the
         * reason `DivergenceChecker` documents at length: a client is always one snapshot
         * behind on *something*, and a comparator that reports the first disagreement it sees
         * reports one on every kill and teaches its reader to ignore it.
         */
        onStateHash: (tick, hash) => {
          this.hashSamples++;
          // Counted separately once this client has come back from a drop (round 4, F8): a
          // returning client is exactly the case §4.18's discard list is about, and folding its
          // samples into the run total would let a match's worth of clean frames bury them.
          if (this.returned) this.hashSamplesAfterReturn++;
          const mine = hashModeState(this.localModeFacts());
          if (mine === hash) {
            this.hashMismatchStreak = 0;
            return;
          }
          this.hashMismatchStreak++;
          if (this.hashMismatchStreak < HASH_CONFIRM_SAMPLES) return;
          this.hashMismatchStreak = 0;
          this.hashMismatches++;
          if (this.returned) this.hashMismatchesAfterReturn++;
          if (this.firstMismatchTick < 0) this.firstMismatchTick = tick;
        },
        onStreaks: (view) => {
          this.streakFrames++;
          for (const e of view.entities) this.streakInstanceIds.add(e.instanceId);
          /**
           * When a Chopper Gunner was last seen in the sky (§8.23).
           *
           * A timestamp rather than a count, because the four Chopper cases are all questions
           * about *when it stopped* — the gunner died, disconnected, the match ended, the
           * instance was destroyed — and a total cannot answer any of them. The harness reads
           * this against the moment it injected the fault.
           */
          for (const e of view.entities) {
            if (e.kind !== CHOPPER_KIND) continue;
            this.chopperFrames++;
            this.lastChopperMs = nowMs();
            // **Per owner**, which is the whole point. Three clients each called in a chopper,
            // so "was any chopper present" stays true from the other two for the full duration
            // and cannot see the one orphaned body it is supposed to be watching.
            this.lastChopperMsByOwner.set(e.ownerId, nowMs());
          }
          if (view.entities.length > this.peakStreakEntities) {
            this.peakStreakEntities = view.entities.length;
          }
          if (view.sweepAngle >= 0) this.sweepFrames++;
          /**
           * Contacts, and the entity id they must be compared against (Gate B, §8.22).
           *
           * **Entity ids are per instance.** A client is entity 2 in the live match and entity
           * 5 back in the arena, because two `ServerMatch`es hand them out independently — the
           * reason `Session.playerId` exists at all. So a Ghost assertion that compared the id
           * read at *report* time against contacts recorded during the *match* is comparing ids
           * from two different worlds, and can never find a leak however broken Ghost is.
           *
           * Both halves are therefore captured together, while the live match is the current
           * instance: the contacts seen there, and the id this client held there.
           */
          for (const c of view.contacts) this.contactIds.add(c.entityId);
          if (!isArenaInstance(this.net.matchId)) {
            this.liveEntityId = this.net.entityId;
            for (const c of view.contacts) this.liveContactIds.add(c.entityId);
          }
          /**
           * Buy the cheapest thing this client can afford (round 4, B9).
           *
           * The view no longer says what is held — under a balance nothing is — so the choice
           * has to be made here from the price list, and it is the same choice the HUD paints:
           * an offer priced at or under the balance whose key is not locked out. Cheapest first,
           * so a client with twelve kills exercises the *debit* rather than sitting on a balance
           * waiting for the one expensive thing it has equipped.
           *
           * Skipping a locked-out offer is what the player does, so it is what this does — and
           * it means `refusedCooling` stays at zero in a clean run and the cooldown shows up in
           * `activations` and `maxRepeatsInOneLife` instead. A client that spammed the key
           * regardless would be measuring the server's refusal rather than the game's pacing.
           */
          let best = -1;
          let bestPrice = Number.POSITIVE_INFINITY;
          for (const offer of view.offers) {
            if (offer.lockoutCs > 0 || offer.price > view.balance) continue;
            if (offer.price >= bestPrice) continue;
            bestPrice = offer.price;
            best = offer.kind;
          }
          if (best >= 0) this.pendingSeen++;
          this.wantStreak = best;
        },
        /**
         * Dog tags (Gate B, §6.8).
         *
         * `tagsSeen` counts *distinct ids*, not frames. A frame counter would go green on a
         * server sending an empty list twenty times a second, which is precisely the state the
         * bug produced — so the number that matters is how many tags ever actually existed.
         */
        onTags: (tags) => {
          this.repTags = tags;
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
          this.repBomb = info;
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
    /**
     * F13's edge, measured against the broadcast that would have fired a level-triggered sound.
     *
     * Read **before** `votePhase` is overwritten, because the previous phase is the whole rule
     * and this method is the only thing that moves it. The browser hangs the same edge off
     * `VoteOverlay.apply`, which holds its previous phase in exactly the same way.
     */
    if (ballotOpened(this.lastVotePhaseHeard, info.phase) !== null) this.ballotOpens++;
    if (info.phase === VotePhase.MODE_VOTE || info.phase === VotePhase.MAP_VOTE) {
      this.ballotBroadcasts++;
    }
    this.lastVotePhaseHeard = info.phase;

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

    /**
     * Close the post-match hold (playtest round 4, B4).
     *
     * The return to the arena is what the summary screen's countdown is counting toward, so the
     * interval between the two is the only honest measure of how long that screen is up. A
     * migration into a *live* match does not close it — that would report the next match's
     * start as the previous match's return.
     */
    if (this.awaitingReturn && isArenaInstance(welcome.matchId)) {
      this.summaryHoldMs = Math.round(nowMs() - this.summaryAtMs);
      this.awaitingReturn = false;
      this.gatedUntilMs = -1;
    }

    /**
     * Discard every replicated mode-state channel (§4.18) — found by the §7 checker.
     *
     * The obligation list on a migration is flush, discard, resync, clear, and it applies to
     * **every** channel the instance being left was feeding. This was applied to the streaks and
     * the projectiles when those were built and not to the three mode-state channels that came
     * before them, and the failure is silent in the worst way: the arena has no zones and no
     * tags, so it **sends neither channel at all**, and a stale Domination flag list or Kill
     * Confirmed tag list is never overwritten. It simply persists, correct-looking, for the rest
     * of the session.
     *
     * Measured before the fix: return migration on tick 4270, first confirmed divergence on
     * tick 4281 — the first snapshot after it — in Domination and Kill Confirmed and in neither
     * of the two modes that have no such state.
     */
    this.repZones = [];
    this.repTags = [];
    this.repBomb = null;

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
      intoLive: !isArenaInstance(welcome.matchId),
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
     * The summary gate, when it is armed (playtest round 4, B4).
     *
     * Everything below — including `NetClient.update`, and therefore the ping, the read and the
     * link check — is skipped, which is precisely what the browser did on the post-match screen.
     * Returning before the counters means a gated run does not also lose ticks from the numbers
     * every other probe is reading.
     */
    if (this.gatedUntilMs >= 0) {
      if (nowMs() < this.gatedUntilMs) return;
      this.gatedUntilMs = -1;
    }
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

    /**
     * Spend whatever the server says is spendable (Gate B, §8.22).
     *
     * The request goes out once per pending list rather than every frame: the replica keeps
     * reporting the streak as pending until the grant comes back and the next `Streaks` frame
     * clears it, which at a snapshot interval is several client ticks. Re-asking every one of
     * them would be a self-inflicted rate-limit test rather than a streak test.
     *
     * The mark is this client's own position, which is meaningless for five of the six and is
     * a legitimate mortar target for the sixth.
     */
    /**
     * Type the cheat code, once, in the live match (playtest round 4, F14).
     *
     * Gated on being seated somewhere other than the arena rather than on a tick count, because
     * what makes the code meaningful is having a body the entitlement can act on — the same
     * reasoning F8's probe arrived at after two wrong gates on a clock. `matchId` is already on
     * the wire in `Welcome`.
     */
    const code = this.opts.cheatCode;
    const wantArena = this.opts.cheatInArena === true;
    const seatedWhereWanted =
      this.net.entityId >= 0 &&
      (wantArena
        ? isArenaInstance(this.net.matchId)
        : !isArenaInstance(this.net.matchId));
    if (code !== undefined && !this.cheatSent && seatedWhereWanted) {
      this.cheatSent = true;
      this.cheatRequests++;
      this.cheatMatchId = this.net.matchId;
      this.net.sendCheat(code);
    }

    if (this.wantStreak >= 0 && this.ticks - this.lastStreakRequestTick > 30) {
      this.lastStreakRequestTick = this.ticks;
      this.streakRequests++;
      const sim = this.controller.sim;
      this.net.sendStreak(this.wantStreak, sim.x, sim.z);
    }

    /**
     * The spectator selection, evaluated whenever this client is dead (§6.8).
     *
     * A headless client has no camera, so what is checked is the half that can be wrong without
     * anybody noticing: *which entity should I be watching*. Every answer is recorded and the
     * harness asserts the invariants afterwards — never yourself, never an enemy, never a corpse.
     * The camera that consumes it is a browser claim; the rule is an ordinary function with an
     * ordinary answer.
     */
    if (this.net.entityId >= 0 && !this.net.localAlive) {
      const target = pickSpectatorTarget(
        this.net.entityId,
        this.net.team,
        this.spectatorCandidates(),
        this.spectateTarget,
      );
      this.spectateTarget = target;
      if (target !== NO_SPECTATOR_TARGET) {
        this.spectatePicks++;
        const interp = this.net.remotes.get(target);
        if (target === this.net.entityId) this.spectateSelfPicks++;
        if (interp !== undefined) {
          const flags = interp.latest.flags;
          const team = (flags & EFlag.TeamB) !== 0 ? 'B' : 'A';
          if (team !== this.net.team) this.spectateEnemyPicks++;
          if ((flags & EFlag.Alive) === 0) this.spectateDeadPicks++;
        }
      }
    } else {
      this.spectateTarget = NO_SPECTATOR_TARGET;
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

    /**
     * Reaped while waiting out the summary (playtest round 4, B4).
     *
     * Recorded here rather than at the end of the run because `state` is where `NetClient`
     * finally notices a closed link, and the whole shape of the bug is that nothing was calling
     * this often enough to notice. Latched: a run that then reconnects has still failed.
     */
    if (this.awaitingReturn && (this.net.state === 'disconnected' || this.link.state === 'closed')) {
      this.droppedOnSummary = true;
    }

    /**
     * The return has landed (playtest round 4, F8).
     *
     * Closed on `synchronised` rather than on `'joined'`, because the two are a snapshot
     * interval apart and only the second means the server has said where this body is. The seat
     * is read here, on the frame it becomes true, for the same reason the Ghost probe reads its
     * entity id inside the match rather than at report time: **entity ids are per instance**, so
     * a seat read later is a seat read in whatever world the flow has since moved this client
     * into.
     */
    if (this.awaitingResync && this.net.synchronised) {
      this.awaitingResync = false;
      this.returned = true;
      this.resyncMs = Math.round(nowMs() - this.reconnectAtMs);
      this.seatAfterReturn = {
        entityId: this.net.entityId,
        matchId: this.net.matchId,
        team: this.net.team,
        atMs: nowMs(),
      };
    }
  }

  disconnect(clean: boolean): void {
    if (clean) this.net.disconnect('done');
    else this.link.terminate();
  }

  /**
   * Drop this client's socket the way a pulled cable does (playtest round 4, F8).
   *
   * `terminate` rather than `disconnect(false)` so the seat as it stood is recorded first —
   * once the link is gone, `net.entityId` still reads the old value but nothing else about the
   * moment is recoverable, and the whole probe is a before-and-after.
   *
   * Unclean on purpose. A clean `Bye` frees the seat immediately and is the case S8.11 already
   * covers; the case F8 is about is the one where the server finds out on its own.
   */
  dropForReconnect(): void {
    this.seatBeforeDrop = {
      entityId: this.net.entityId,
      matchId: this.net.matchId,
      team: this.net.team,
      atMs: nowMs(),
    };
    /**
     * Clear the previous cycle's answer, and this is not tidiness (round 4, F8).
     *
     * `seatAfterReturn` is what the harness waits on to decide a cycle has landed. Left over
     * from the last one it is already non-null, so cycle two closes on the *first* frame it is
     * looked at — before the socket has even been re-opened — and reports cycle one's seat and
     * cycle one's resync time again. A nine-cycle run did exactly that: three genuine results
     * and six copies of them, all green.
     *
     * Found by reading a run whose resync times repeated in threes. A latch is the right shape
     * for a thing that happens once and the wrong one for a thing that happens N times, and the
     * cheapest way to tell them apart is that the second kind has to be reset by whatever starts
     * the next round of it.
     */
    this.seatAfterReturn = null;
    this.resyncMs = -1;
    this.link.terminate();
  }

  /**
   * Dial back in on the same client object (playtest round 4, F8).
   *
   * The same `NetClient`, the same `NodeLink`, a new socket — which is the browser's shape too,
   * minus the world it has to rebuild. `NetClient.connect` refuses unless the state is `'idle'`
   * or `'disconnected'`, and the only place `'joined'` becomes `'disconnected'` is the top of
   * `update`, so the pump below is a precondition rather than a courtesy: without it the
   * `Hello` is silently never sent and the run reports a client that simply never came back.
   */
  async reconnect(): Promise<void> {
    this.net.update();
    this.reconnects++;
    this.reconnectAtMs = nowMs();
    this.awaitingResync = true;
    await this.link.open();
    this.net.connect();
  }

  /** Whether this client is dropped and has not yet been dialled back in. */
  get droppedOut(): boolean {
    return this.link.state === 'closed';
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
      streakFrames: this.streakFrames,
      streakEntitiesSeen: this.streakInstanceIds.size,
      peakStreakEntities: this.peakStreakEntities,
      sweepFrames: this.sweepFrames,
      deadTicks: this.deadTicks,
      quickLoadoutTicks: this.quickLoadoutTicks,
      quickLoadoutRespawnTicks: this.quickLoadoutRespawnTicks,
      quickLoadoutPrematchTicks: this.quickLoadoutPrematchTicks,
      quickLoadoutAlive: this.quickLoadoutAlive,
      quickLoadoutWindows: this.quickLoadoutWindows,
      scoreboardHeldTicks: this.scoreboardHeldTicks,
      scoreboardHeldWhileDeadTicks: this.scoreboardHeldWhileDeadTicks,
      scoreboardOpenWhileDeadTicks: this.scoreboardOpenWhileDeadTicks,
      warmupMinHealth: this.warmupMinHealth,
      warmupHitsTaken: this.warmupHitsTaken,
      warmupDeaths: this.warmupDeaths,
      liveMinHealth: this.liveMinHealth,
      liveHitsTaken: this.liveHitsTaken,
      liveDeaths: this.liveDeaths,
      liveHitsWhileCheated: this.liveHitsWhileCheated,
      cheatMask: this.net.cheatMask,
      cheatRequests: this.cheatRequests,
      cheatOutcomes: [...this.cheatOutcomes],
      cheatMatchId: this.cheatMatchId,
      cheatTicks: this.cheatTicks,
      cheatTicksInOtherInstance: this.cheatTicksInOtherInstance,
      cheatTagTicksInOtherInstance: this.cheatTagTicksInOtherInstance,
      ballotOpens: this.ballotOpens,
      ballotBroadcasts: this.ballotBroadcasts,
      captionArenaTicks: this.captionArenaTicks,
      captionWaitingInLiveTicks: this.captionWaitingInLiveTicks,
      resultSurfacesInArenaTicks: this.resultSurfacesInArenaTicks,
      resultSurfacesLiveTicks: this.resultSurfacesLiveTicks,
      briefTicks: this.briefTicks,
      briefWindows: this.briefWindows,
      briefArenaTicks: this.briefArenaTicks,
      spectatePicks: this.spectatePicks,
      spectateSelfPicks: this.spectateSelfPicks,
      spectateEnemyPicks: this.spectateEnemyPicks,
      spectateDeadPicks: this.spectateDeadPicks,
      hashSamples: this.hashSamples,
      hashMismatches: this.hashMismatches,
      firstMismatchTick: this.firstMismatchTick,
      projectileFrames: this.projectileFrames,
      remoteProjectiles: this.remoteSerials.size,
      ownProjectileSeen: this.ownProjectileSeen,
      peakProjectiles: this.peakProjectiles,
      smokeFrames: this.smokeFrames,
      chopperFrames: this.chopperFrames,
      lastChopperMs: this.lastChopperMs,
      lastChopperMsByOwner: new Map(this.lastChopperMsByOwner),
      pendingSeen: this.pendingSeen,
      streakRequests: this.streakRequests,
      contactsSeen: this.contactIds.size,
      contactIdList: [...this.liveContactIds],
      liveEntityId: this.liveEntityId,
      team: this.net.team,
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
      summaryHoldMs: this.summaryHoldMs,
      summarySaidSeconds: this.summarySaidSeconds,
      droppedOnSummary: this.droppedOnSummary,
      notices: [...this.notices],
      votesCast: this.votesCast,
      reconnects: this.reconnects,
      resyncMs: this.resyncMs,
      seatBeforeDrop: this.seatBeforeDrop,
      seatAfterReturn: this.seatAfterReturn,
      hashSamplesAfterReturn: this.hashSamplesAfterReturn,
      hashMismatchesAfterReturn: this.hashMismatchesAfterReturn,
    };
  }

  /** Bodies this client could watch, from the actors it has rebuilt from snapshots. */
  private *spectatorCandidates(): Generator<SpectatorCandidate> {
    for (const [entityId, interp] of this.net.remotes) {
      // Team and liveness are **discrete** facts and live on the newest snapshot rather than on
      // the interpolated pose — `EntityInterpolator` deliberately does not blend them, because
      // a body half-way between alive and dead is not a state the game has.
      const flags = interp.latest.flags;
      yield {
        entityId,
        team: (flags & EFlag.TeamB) !== 0 ? 'B' : 'A',
        alive: (flags & EFlag.Alive) !== 0,
      };
    }
  }

  /**
   * What this client believes tick N looked like (§7).
   *
   * Assembled from the channels **as decoded** — the zone records, the tag list and the bomb are
   * held verbatim rather than re-derived, because the point of the comparison is to catch a
   * value that arrived wrong, and re-deriving it here would be inventing a second chance to get
   * it right.
   *
   * Score, round and phase come from the snapshot header, which is the client's only source for
   * them. That half therefore agrees by construction and is included for the reason
   * `DivergenceChecker` includes the same fields: it costs one comparison, and the day anything
   * gives a client its own opinion about the round number, this is already watching.
   */
  private localModeFacts(): ModeStateFacts {
    const h = this.net.header;
    this.factTagIds.length = 0;
    for (const t of this.repTags) this.factTagIds.push(t.id & 0xffff);

    const bomb = this.repBomb;
    return {
      scoreA: h.scoreA,
      scoreB: h.scoreB,
      round: h.round,
      phase: h.phase,
      zones: this.repZones,
      tagIds: this.factTagIds,
      bomb:
        bomb === null
          ? null
          : {
              state: bombStateCode(bomb.state),
              carrierId: bomb.carrierId,
              attackers: bomb.attackers === 'B' ? OBJ_TEAM_B : OBJ_TEAM_A,
              plantedSite: bomb.plantedSiteIndex,
              timerCs: Math.max(0, Math.min(0xffff, Math.round(bomb.secondsLeft * 100))),
              interactProgress: Math.max(0, Math.min(255, Math.round(bomb.interactFraction * 255))),
              interactEntity: bomb.interactEntity,
            },
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

    /**
     * Throw a grenade on a fixed cadence (§8.24).
     *
     * A **press and release**, not a held bit: `ThrowController` begins a cook on the press and
     * lets go on the release, so a permanently-held Lethal would cook one grenade for ever and
     * throw nothing. Two ticks of hold is the shortest thing that is unambiguously both.
     */
    const period = this.opts.throwEveryTicks ?? 0;
    if (period > 0) {
      // Alternating slots, so both a lethal and a **tactical** are exercised. Smoke is the
      // tactical, and §6.8 gives it a requirement of its own — occluding bot line of sight —
      // so a run that only ever threw frags would leave the smoke channel unmeasured.
      if (tick % period < 2) buttons |= Btn.Lethal;
      else if (tick % period >= period >> 1 && tick % period < (period >> 1) + 2) {
        buttons |= Btn.Tactical;
      }
    }

    /**
     * Hold Tab on a duty cycle, **outside the `alive` gate above** (playtest round 4, B6).
     *
     * Deliberately not part of a behaviour: every run should measure this, and a client that
     * only pressed it while alive could never have found the bug, which was that the bit is
     * discarded while dead. Two seconds down, two up, so the probe sees both edges either side
     * of a 4.5 s death rather than sampling one level.
     *
     * It perturbs nothing. `Btn.Scoreboard` drives no simulation on either side — see
     * `NetClient.neutralise` — so holding it changes no prediction, no hit and no score.
     */
    if (tick % 240 < 120) buttons |= Btn.Scoreboard;

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
   * Evaluate every extracted HUD-surface rule against this tick's real state (§P1).
   *
   * `screen` is `'MATCH'` throughout and that is stated rather than assumed: this process has
   * no front end, so what is measured here is the rule's behaviour *inside* a match, across
   * death, respawn, round end and migration. The `PAUSED` and `SUMMARY` arms of the same
   * predicates are the browser's to confirm, and they are on the list.
   *
   * The respawn display is stepped **before** the edges are read, in the order `ClientMatch`
   * does it: a tick decrements the wait it is already in, and a respawn arriving on the same
   * tick zeroes it afterwards.
   */
  private observeSurfaces(cmd: InputCommand): void {
    const alive = this.net.localAlive;
    this.respawnDisplay = stepRespawnDisplay(this.respawnDisplay, !alive, DT);
    if (!alive && this.aliveLastTick) this.respawnDisplay = RESPAWN_SECONDS;
    if (alive && !this.aliveLastTick) this.respawnDisplay = 0;
    this.aliveLastTick = alive;

    const h = this.net.header;
    const state: HudSurfaceState = {
      screen: 'MATCH',
      hasWorld: true,
      playerDead: !alive,
      respawnSeconds: this.respawnDisplay,
      phase: phaseAt(h.phase),
      round: h.round,
      scoreboardHeld: (cmd.buttons & Btn.Scoreboard) !== 0,
      debugRequest: 'none',
      // F14. Replicated, so the surface rules can be evaluated against what the server actually
      // granted rather than against what this process asked for.
      cheatMask: this.net.cheatMask,
      /**
       * Always empty here, and that is a limit rather than a value (F14's fix).
       *
       * An instant cheat's caption is raised by `Game` from a deadline in wall time, and this
       * process has no `Game`. So every tag tick counted below is a **toggle** tick, which is
       * exactly the half that has to be zero after a migration; the announcement's own four
       * seconds are a browser claim and are on the list.
       */
      instantCheatLabel: '',
      /**
       * F7/F12, and it is in the record now rather than beside it (round 4 regression).
       *
       * `isArenaInstance` is the only comparison against `WARMUP_MATCH_ID` in the project, and
       * asking it here means every surface rule below sees the same answer as the browser's —
       * including `resultSurfacesVisible`, which is the one three surfaces share.
       */
      inWarmupArena: isArenaInstance(this.net.matchId),
    };

    if (!alive) this.deadTicks++;
    if (state.scoreboardHeld) {
      this.scoreboardHeldTicks++;
      if (!alive) this.scoreboardHeldWhileDeadTicks++;
    }
    if (scoreboardOpen(state) && !alive) this.scoreboardOpenWhileDeadTicks++;

    /**
     * F7 and F12, both of which are questions about *where this client is* (playtest round 4).
     *
     * Sampled here rather than from a snapshot handler because this runs once per real tick and
     * never on a replay, which is what makes a tick count mean a tick. `matchId` is the arena
     * test the whole session turns on and it is already on the wire in `Welcome`.
     */
    const inArena = state.inWarmupArena;

    /**
     * The banner, the board and the streak strip, from the one predicate (round 4 regression).
     *
     * Written to go **red rather than green**: a result surface up inside the arena is the
     * defect, so what is counted is the violation and not the feature. F7 removed the room's
     * score rows and left all three painting the absence, which no number then existing could
     * have caught — an empty board and a hidden board look identical to a client that never
     * asked.
     */
    if (resultSurfacesVisible(state)) {
      if (inArena) this.resultSurfacesInArenaTicks++;
      else this.resultSurfacesLiveTicks++;
    }
    const own = this.net.entityId >= 0 ? this.net.remotes.get(this.net.entityId) : undefined;
    if (own !== undefined) {
      // Two floors, one sample, split by instance. F7 asks about the room and F14 asks about a
      // match, and the same number cannot answer both — see `liveMinHealth`.
      if (inArena) {
        if (own.latest.health < this.warmupMinHealth) this.warmupMinHealth = own.latest.health;
      } else if (own.latest.health < this.liveMinHealth) {
        this.liveMinHealth = own.latest.health;
      }
    }
    /**
     * The entitlement's lifetime, sampled per real tick (F14's fix).
     *
     * `cheatMatchId` is the instance the code was typed in. Anything held outside it crossed a
     * boundary that destroys the entity the entitlement was granted against, which is the whole
     * of the regression. The tag is counted beside it rather than instead of it: the mask is the
     * defect and the caption is what made it visible.
     */
    if (this.net.cheatMask !== 0) {
      this.cheatTicks++;
      if (this.cheatMatchId >= 0 && this.net.matchId !== this.cheatMatchId) {
        this.cheatTicksInOtherInstance++;
      }
    }
    if (
      this.cheatMatchId >= 0 &&
      this.net.matchId !== this.cheatMatchId &&
      cheatTag(state) !== ''
    ) {
      this.cheatTagTicksInOtherInstance++;
    }

    const caption = matchCaption(state.phase, inArena);
    if (caption !== '') {
      if (inArena) this.captionArenaTicks++;
      else if (caption === 'WAITING') this.captionWaitingInLiveTicks++;
    }

    /**
     * F10's window, sampled beside the caption because it is drawn under it.
     *
     * The second line is the control, not a violation count: it asks `briefVisible` with the
     * arena term forced off, so it reports how long the room *would* have carried a brief. See
     * `briefArenaTicks`.
     */
    const briefOpen = briefVisible(state.phase, state.round, inArena);
    if (briefOpen) {
      this.briefTicks++;
      if (!this.briefWasOpen) this.briefWindows++;
    }
    this.briefWasOpen = briefOpen;
    if (inArena && briefVisible(state.phase, state.round, false)) this.briefArenaTicks++;

    // Named `qlWindow` rather than `window`: `scripts/check-boundaries.mjs` bans the bare
    // identifier in `server/`, and it is right to — a headless process has no such object.
    const qlWindow = quickLoadoutWindow(state);
    if (qlWindow !== 'none') {
      this.quickLoadoutTicks++;
      if (qlWindow === 'respawn') this.quickLoadoutRespawnTicks++;
      else this.quickLoadoutPrematchTicks++;
      /**
       * B13, and it is written to fail rather than to pass.
       *
       * *"The panel does not disappear after respawn"* is, stated as a rule violation, "the
       * panel is up while this client is alive and outside the pre-match freeze". A frame
       * counter would have gone green on a panel that was up for the whole match.
       */
      if (alive && qlWindow !== 'prematch') this.quickLoadoutAlive++;
    }
    if (qlWindow !== this.lastQuickWindow) {
      if (qlWindow !== 'none') this.quickLoadoutWindows++;
      this.lastQuickWindow = qlWindow;
    }
  }

  private aliveLastTick = true;

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
