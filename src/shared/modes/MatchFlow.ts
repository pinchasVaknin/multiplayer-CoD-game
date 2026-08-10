import type { Combatant } from '../ai/Combatant';
import { Killfeed, type CombatantDirectory } from '../combat/Killfeed';
import { LocalIdentity } from '../combat/LocalIdentity';
import type { ScoreSystem, ScoreTeam } from '../combat/ScoreSystem';
import { EV, type AnnouncerCue, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import type { GameMode, KillEvent, MatchResult, RoundResult } from './GameMode';

/**
 * Match flow: rounds, the clock, and who is allowed to come back (brief S6.2).
 *
 * S6.2 draws the line and this file is on the other side of it: **match flow owns rounds,
 * the mode declares whether it uses them.** TDM says one round, no side swap, unlimited
 * lives, and none of the code below special-cases that — it runs the same round machine it
 * will run for a best-of-nine Search & Destroy in M7. That is the entire reason the
 * abstraction is being built in M4 instead of M7.
 *
 * Everything here advances on sim ticks and nothing is multiplied by a frame delta (S4.1),
 * so the match clock is as frame-rate independent as movement is. The clock is stored in
 * *ticks* rather than seconds for exactly that reason: seconds are derived for display.
 *
 * Three things it owns that the mode deliberately does not:
 *
 * **The respawn gate.** `respawnAllowed` is what `BotDirector` and `Match` ask before
 * putting anybody back on the map. It is not speculative round support — it is required in
 * M4, because a match that has ended must stop respawning people while the summary screen
 * is up, and a bot that respawns behind the post-match scoreboard is a leak of live state
 * into a state that is supposed to be over. `livesPerRound` rides the same gate.
 *
 * **The side swap.** A mode that sets `swapSidesAfterRound` gets its ends changed for real:
 * the team totals swap and the spawn selector starts drawing each team's candidates from the
 * other team's zones. TDM never triggers it, but it is implemented rather than stubbed,
 * and `__operator.flow().swapSides()` exercises it.
 *
 * **The killfeed's input.** The flow already resolves killer and victim against the roster
 * to build a `KillEvent`; having the feed subscribe separately would be two places that can
 * disagree about who shot whom.
 */

export type MatchPhase = 'WARMUP' | 'LIVE' | 'ROUND_END' | 'MATCH_END';

/**
 * One snapshot header's worth of match state, as `MatchFlow` wants it (M10).
 *
 * A record rather than seven positional arguments. The three that were added during the M10
 * playtests — phase, phase seconds, round — arrived one at a time, and each one was another
 * number in a call whose meaning had to be read off the parameter list at the definition.
 */
export interface ReplicatedMatchState {
  phase: MatchPhase;
  /** Seconds left on the match clock. */
  secondsRemaining: number;
  /** Seconds left of the warm-up or the round-end hold. */
  phaseSeconds: number;
  round: number;
  scoreA: number;
  scoreB: number;
  /** The server's tick, so a killfeed line is stamped with game time rather than zero. */
  serverTick: number;
}

/** A zeroed record, for a caller that refills and reuses one per snapshot. */
export function makeReplicatedMatchState(): ReplicatedMatchState {
  return {
    phase: 'WARMUP',
    secondsRemaining: 0,
    phaseSeconds: 0,
    round: 1,
    scoreA: 0,
    scoreB: 0,
    serverTick: 0,
  };
}

/** Seconds of "get ready" before the first tick of a round counts. */
const WARMUP_SECONDS = 3;

/** Remaining-time announcer cues, in seconds. Fired once each, highest first. */
const TIME_CUES: readonly Readonly<{ at: number; cue: AnnouncerCue }>[] = [
  { at: 120, cue: 'twoMinutes' },
  { at: 60, cue: 'oneMinute' },
  { at: 30, cue: 'thirtySeconds' },
];

export interface MatchFlowDeps {
  readonly bus: GameBus;
  readonly score: ScoreSystem;
  readonly roster: readonly Combatant[];
  readonly mode: GameMode;
  readonly mapId: string;
  readonly mapName: string;
  /** The local player's side, so the announcer knows whether a win is a victory. */
  readonly localTeam: ScoreTeam;
  /** Told when the ends change, so respawns follow the swap. */
  readonly onSidesSwapped: (swapped: boolean) => void;
  /** Which entity this client is, for the killfeed's "involves me" highlight (M10). */
  readonly identity?: LocalIdentity;
  /**
   * False on a client whose match is run by a dedicated server (M10, playtest round 2).
   *
   * This object has two drive modes and it is worth naming them rather than leaving the
   * difference implicit in which methods a caller happens to invoke:
   *
   * - **Authoritative** (`true`, the default): `simulate` runs the clock, the mode scores,
   *   and the phase machine advances itself. Single-player and the dedicated server.
   * - **Replicated** (`false`): `simulate` is never called and `applyReplicated` writes the
   *   phase, round and clock from the wire. The mode must **not** score — the server already
   *   did, and a client that scored too would count every kill twice and then be overwritten
   *   by the replicated total, which reads as a scoreboard that flickers.
   *
   * The killfeed still runs in both, because a feed line is presentation and S3 requires a
   * networked event and a local one to be indistinguishable.
   */
  readonly authoritative?: boolean;
  /** Shorten a round, for harnesses only. Unset everywhere a player is involved. */
  readonly roundSecondsOverride?: number | undefined;
}

const evMatchStarted = { modeId: '', modeName: '', mapId: '', mapName: '', roundsToWin: 1 };
const evRoundStarted = { round: 1, roundsToWin: 1 };
const evRoundEnded = { round: 1, winner: 'DRAW' as ScoreTeam | 'DRAW', reason: '' };
const evMatchEnded = {
  winner: 'DRAW' as ScoreTeam | 'DRAW',
  reason: '',
  scoreA: 0,
  scoreB: 0,
  localWon: false,
};
const evScore = { teamA: 0, teamB: 0, limit: 0 };
const evSwapped = { afterRound: 0 };
const evCue = { cue: 'fight' as AnnouncerCue };

export class MatchFlow {
  readonly killfeed: Killfeed;

  private readonly deps: MatchFlowDeps;
  private readonly unsubscribe: Array<() => void> = [];
  /** Respawns already used this round, by entity id. Only read when lives are finite. */
  private readonly livesUsed = new Map<number, number>();

  private phase: MatchPhase = 'WARMUP';
  private roundIndex = 1;
  private ticksRemaining = 0;
  private phaseTicks = 0;
  private tick = 0;
  private cuesFired = 0;
  private swapped = false;
  private outcome: MatchResult | null = null;
  private lastLeader: ScoreTeam | 'DRAW' = 'DRAW';
  private lastScoreA = -1;
  private lastScoreB = -1;

  constructor(deps: MatchFlowDeps) {
    this.deps = deps;
    this.authoritative = deps.authoritative !== false;
    this.killfeed = new Killfeed(deps.bus, deps.roster, deps.identity ?? new LocalIdentity());
    this.subscribe();
  }

  /** See `MatchFlowDeps.authoritative`. */
  private readonly authoritative: boolean;

  /** Point the killfeed at a different name source. See `CombatantDirectory`. */
  setKillfeedDirectory(directory: CombatantDirectory): void {
    this.killfeed.setDirectory(directory);
  }

  get currentPhase(): MatchPhase {
    return this.phase;
  }

  get round(): number {
    return this.roundIndex;
  }

  get secondsRemaining(): number {
    return this.ticksRemaining * DT;
  }

  /**
   * How long a decided round is held before the next one, seconds.
   *
   * Asked of the mode (post-M8) rather than being a constant here. Search & Destroy ends on a
   * detonation or a defuse and wants to move on quickly; a Domination round does not exist.
   */
  private get roundEndSeconds(): number {
    return this.deps.mode.roundEndSeconds;
  }

  /** Seconds left of the warm-up or the round-end hold, whichever is running. */
  get phaseSecondsRemaining(): number {
    const limit = this.phase === 'WARMUP' ? WARMUP_SECONDS : this.roundEndSeconds;
    return Math.max(0, limit - this.phaseTicks * DT);
  }

  /**
   * Adopt match state from the server (M10).
   *
   * On a dedicated server this flow is the only one running its clock; every client holds an
   * inert copy whose `simulate` is never called. Without this the client's copy sits at
   * whatever it was constructed with, and the HUD — which reads `currentPhase`,
   * `secondsRemaining` and `phaseSecondsRemaining` straight off it — shows the *initial*
   * state forever. Measured before this existed: the banner stuck on "GET READY - 3" and the
   * clock frozen at 10:00 for a match that was minutes in and had a score of 6-14.
   *
   * Fields are written directly rather than by advancing the clock, because the server's
   * value is the answer and re-deriving it here would be a second clock to disagree with.
   * `phaseTicks` is back-computed from the remaining phase seconds so `phaseSecondsRemaining`
   * — which the countdown banner reads — returns the replicated number rather than a stale one.
   */
  applyReplicated(state: ReplicatedMatchState): void {
    const { phase, round, scoreA, scoreB } = state;
    const previousPhase = this.phase;
    const previousRound = this.roundIndex;

    this.phase = phase;
    this.roundIndex = round;
    this.tick = state.serverTick;
    this.ticksRemaining = Math.max(0, Math.round(state.secondsRemaining / DT));
    const limit = phase === 'WARMUP' ? WARMUP_SECONDS : this.roundEndSeconds;
    this.phaseTicks = Math.max(0, Math.round((limit - state.phaseSeconds) / DT));
    this.replicatedScoreA = scoreA;
    this.replicatedScoreB = scoreB;

    /**
     * The transitions, which are the whole reason this is not three assignments (playtest
     * round 2).
     *
     * Adopting the phase was enough to make the HUD *read* correctly and nothing else. Every
     * consumer downstream of a match ending is wired to an **event**, not to a poll of
     * `currentPhase`: `Game` sets `pendingSummary` from `EV.MatchEnded`, the announcer plays
     * from `EV.AnnouncerCue`, the round reset in `ClientMatch` listens for `EV.RoundStarted`.
     * A client that silently arrived in `MATCH_END` fired none of them, so it never entered
     * SUMMARY, never tore its world down, and sat on the final banner while the server moved
     * on to the next match — with the old score, the old killfeed and the old scoreboard still
     * on screen. That is the reported state leakage, and it is this method's fault.
     *
     * So the replicated path emits the same events the simulated one does, at the same
     * transitions, in the same order. Edge-triggered against the previous phase, because this
     * runs at the snapshot rate and a level-triggered version would announce the match ending
     * twenty times a second.
     */
    if (round !== previousRound && phase !== 'MATCH_END') {
      evRoundStarted.round = round;
      evRoundStarted.roundsToWin = this.deps.mode.roundsToWin;
      this.deps.bus.emit(EV.RoundStarted, evRoundStarted);
    }

    if (phase === previousPhase) return;

    if (phase === 'LIVE') this.cue('fight');
    if (phase === 'MATCH_END') this.adoptReplicatedEnd(scoreA, scoreB);
  }

  /**
   * The server says the match is over. Produce the result the client's own end-of-match path
   * needs, and announce it.
   *
   * The winner is derived from the replicated score rather than replicated on its own: the
   * two cannot disagree, because they are the same number, and a `winner` byte on the wire
   * would be a second fact to keep in step with the first.
   */
  private adoptReplicatedEnd(scoreA: number, scoreB: number): void {
    if (this.outcome !== null) return;
    const winner: ScoreTeam | 'DRAW' = scoreA === scoreB ? 'DRAW' : scoreA > scoreB ? 'A' : 'B';
    this.endMatch({
      kind: 'match',
      winner,
      reason: 'Match over',
      scoreA,
      scoreB,
      roundsA: this.deps.score.team('A').rounds,
      roundsB: this.deps.score.team('B').rounds,
    });
  }

  /**
   * The replicated team scores, for a client whose own mode is not scoring.
   *
   * `mode.teamScore` is the right answer everywhere the mode is actually running and is
   * always zero on a replicated client, so the summary screen and the end-of-match banner
   * read this instead. -1 means "nothing replicated", which is what single-player reports.
   */
  private replicatedScoreA = -1;
  private replicatedScoreB = -1;

  /** Team score from whichever source is authoritative for this client. */
  teamScore(team: ScoreTeam): number {
    if (this.authoritative) return this.deps.mode.teamScore(team);
    const replicated = team === 'A' ? this.replicatedScoreA : this.replicatedScoreB;
    return replicated < 0 ? this.deps.mode.teamScore(team) : replicated;
  }

  get isLive(): boolean {
    return this.phase === 'LIVE';
  }

  get isOver(): boolean {
    return this.phase === 'MATCH_END';
  }

  get result(): MatchResult | null {
    return this.outcome;
  }

  get sidesSwapped(): boolean {
    return this.swapped;
  }

  /**
   * How long a round is. The mode's answer, unless a harness said otherwise.
   *
   * **One accessor rather than two call sites reading the same field**, so the override cannot
   * apply to the first round and not to subsequent ones — which is exactly the bug two
   * independent reads would produce in Search & Destroy, presenting as "the soak hangs after
   * round one".
   */
  private roundSeconds(): number {
    const override = this.deps.roundSecondsOverride;
    return override !== undefined && override > 0 ? override : this.deps.mode.roundSeconds;
  }

  /** Begin the match. Announces itself, then counts the warm-up down. */
  start(): void {
    const mode = this.deps.mode;
    this.phase = 'WARMUP';
    this.roundIndex = 1;
    this.phaseTicks = 0;
    this.ticksRemaining = Math.round(this.roundSeconds() / DT);
    this.cuesFired = 0;
    this.outcome = null;
    this.livesUsed.clear();
    this.lastLeader = 'DRAW';
    this.lastScoreA = -1;
    this.lastScoreB = -1;

    evMatchStarted.modeId = mode.id;
    evMatchStarted.modeName = mode.name;
    evMatchStarted.mapId = this.deps.mapId;
    evMatchStarted.mapName = this.deps.mapName;
    evMatchStarted.roundsToWin = mode.roundsToWin;
    this.deps.bus.emit(EV.MatchStarted, evMatchStarted);
    this.cue('matchStart');

    mode.onRoundStart(this.roundIndex);
    evRoundStarted.round = this.roundIndex;
    evRoundStarted.roundsToWin = mode.roundsToWin;
    this.deps.bus.emit(EV.RoundStarted, evRoundStarted);
    this.publishScore();
  }

  /**
   * One sim tick.
   *
   * The mode only ticks while the round is live, which is what keeps a mode from having to
   * ask whether it is allowed to score. Everything else here is a countdown.
   */
  simulate(tickIndex: number): void {
    this.tick = tickIndex;
    // The score's assist window is measured in ticks, and this is the one place in the
    // project that knows the tick and already owns the score (S4.1: gameplay timers never
    // touch the wall clock).
    this.deps.score.setTick(tickIndex);
    this.phaseTicks++;

    switch (this.phase) {
      case 'WARMUP':
        if (this.phaseTicks * DT >= WARMUP_SECONDS) this.goLive();
        return;
      case 'ROUND_END':
        if (this.phaseTicks * DT >= this.roundEndSeconds) this.advanceRound();
        return;
      case 'MATCH_END':
        return;
      case 'LIVE':
        break;
    }

    if (this.ticksRemaining > 0) this.ticksRemaining--;
    this.deps.mode.onTick(tickIndex);
    this.publishScore();
    this.fireTimeCues();

    const decision = this.deps.mode.checkWinCondition();
    if (decision === null) return;
    if (decision.kind === 'match') {
      this.endMatch(decision);
      return;
    }
    this.endRound(decision);
  }

  /**
   * May this entity respawn right now?
   *
   * Asked by `BotDirector` for every bot and by `Match` for the player, so there is one
   * answer rather than two. Nobody comes back once the match is over, nobody comes back
   * during the round-end hold, and a mode with finite lives runs out of them.
   */
  respawnAllowed(entityId: number): boolean {
    if (this.phase === 'MATCH_END' || this.phase === 'ROUND_END') return false;
    const lives = this.deps.mode.livesPerRound;
    if (!Number.isFinite(lives)) return true;
    return (this.livesUsed.get(entityId) ?? 0) < lives - 1;
  }

  /** Called by whoever actually put an entity back on the map. */
  noteRespawn(entityId: number): void {
    if (!Number.isFinite(this.deps.mode.livesPerRound)) return;
    this.livesUsed.set(entityId, (this.livesUsed.get(entityId) ?? 0) + 1);
  }

  /** Lives left this round, or Infinity. Read by the HUD in a mode that has them. */
  livesRemaining(entityId: number): number {
    const lives = this.deps.mode.livesPerRound;
    if (!Number.isFinite(lives)) return Infinity;
    return Math.max(0, lives - 1 - (this.livesUsed.get(entityId) ?? 0));
  }

  /**
   * Change ends. Public because it is the one part of round support that TDM never
   * exercises, and a side swap nobody can run is a side swap nobody knows is broken.
   *
   * **It does not touch the score (round 2).** It used to call `score.swapTeams()`, and that
   * is the reported "S&D scoring is inverted": Team B wins round one, the sides change, and
   * the round is now showing against Team A — who then only need one more to be declared the
   * 2-0 winner of a match they are actually drawing. Every downstream consumer inherited it,
   * because `endRound` reads `score.team('A').rounds` to decide whether the match is over.
   *
   * The rule the bug broke is that `'A'` and `'B'` are teams of people, not ends of a map.
   * Nothing else about a swap moves with the ends either — `Combatant.team` does not change,
   * `PlayerScore.team` does not change — so a score that did was the one thing out of step.
   * What a swap changes is which spawn zones each team draws from, which is `onSidesSwapped`
   * on the next line and is all of it.
   */
  swapSides(): void {
    this.swapped = !this.swapped;
    this.deps.onSidesSwapped(this.swapped);
    evSwapped.afterRound = this.roundIndex;
    this.deps.bus.emit(EV.SidesSwapped, evSwapped);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  // -- internals -------------------------------------------------------------

  private goLive(): void {
    this.phase = 'LIVE';
    this.phaseTicks = 0;
    this.cue('fight');
  }

  private endRound(result: RoundResult): void {
    this.deps.mode.onRoundEnd(result);
    if (result.winner !== 'DRAW') this.deps.score.addRoundWin(result.winner);

    evRoundEnded.round = result.round;
    evRoundEnded.winner = result.winner;
    evRoundEnded.reason = result.reason;
    this.deps.bus.emit(EV.RoundEnded, evRoundEnded);

    // A round win that finishes the match ends the match, not the round.
    const a = this.deps.score.team('A').rounds;
    const b = this.deps.score.team('B').rounds;
    const target = this.deps.mode.roundsToWin;
    if (a >= target || b >= target) {
      this.endMatch({
        kind: 'match',
        winner: a === b ? 'DRAW' : a > b ? 'A' : 'B',
        reason: `Best of ${target * 2 - 1}`,
        scoreA: this.deps.mode.teamScore('A'),
        scoreB: this.deps.mode.teamScore('B'),
        roundsA: a,
        roundsB: b,
      });
      return;
    }

    this.phase = 'ROUND_END';
    this.phaseTicks = 0;
  }

  private advanceRound(): void {
    this.roundIndex++;
    if (this.deps.mode.swapSidesAfterRound === this.roundIndex - 1) this.swapSides();

    this.ticksRemaining = Math.round(this.roundSeconds() / DT);
    this.cuesFired = 0;
    this.livesUsed.clear();
    this.deps.score.resetRound();
    this.deps.mode.onRoundStart(this.roundIndex);

    evRoundStarted.round = this.roundIndex;
    evRoundStarted.roundsToWin = this.deps.mode.roundsToWin;
    this.deps.bus.emit(EV.RoundStarted, evRoundStarted);

    this.phase = 'WARMUP';
    this.phaseTicks = 0;
  }

  private endMatch(result: MatchResult): void {
    this.phase = 'MATCH_END';
    this.phaseTicks = 0;
    this.outcome = result;

    const localWon = result.winner === this.deps.localTeam;
    evMatchEnded.winner = result.winner;
    evMatchEnded.reason = result.reason;
    evMatchEnded.scoreA = result.scoreA;
    evMatchEnded.scoreB = result.scoreB;
    evMatchEnded.localWon = localWon;
    this.deps.bus.emit(EV.MatchEnded, evMatchEnded);
    this.cue(result.winner === 'DRAW' ? 'draw' : localWon ? 'victory' : 'defeat');
  }

  private publishScore(): void {
    const a = this.deps.mode.teamScore('A');
    const b = this.deps.mode.teamScore('B');
    if (a === this.lastScoreA && b === this.lastScoreB) return;
    this.lastScoreA = a;
    this.lastScoreB = b;
    evScore.teamA = a;
    evScore.teamB = b;
    evScore.limit = this.deps.mode.scoreLimit;
    this.deps.bus.emit(EV.ScoreChanged, evScore);

    // "You are winning" is worth saying once, not every kill.
    const leader = a === b ? 'DRAW' : a > b ? 'A' : 'B';
    if (leader === this.lastLeader) return;
    const previous = this.lastLeader;
    this.lastLeader = leader;
    if (leader === 'DRAW') return;
    if (leader === this.deps.localTeam) this.cue('leadTaken');
    else if (previous === this.deps.localTeam) this.cue('leadLost');
  }

  private fireTimeCues(): void {
    const seconds = this.ticksRemaining * DT;
    while (this.cuesFired < TIME_CUES.length) {
      const next = TIME_CUES[this.cuesFired];
      if (next === undefined) return;
      if (seconds > next.at) return;
      this.cuesFired++;
      this.cue(next.cue);
    }
  }

  private cue(cue: AnnouncerCue): void {
    evCue.cue = cue;
    this.deps.bus.emit(EV.AnnouncerCue, evCue);
  }

  private subscribe(): void {
    const { bus, mode, roster } = this.deps;

    this.unsubscribe.push(
      bus.on(EV.EntityKilled, (p) => {
        // Kills only count while the round is live. A round that ended two ticks ago is not
        // still scoring, and neither is a match that is over.
        if (this.phase !== 'LIVE') return;

        /**
         * Scoring is the authority's job; the feed line is everybody's (M10).
         *
         * On a replicated client the roster is empty — the bodies are `RemoteActor`s rebuilt
         * from snapshots and never enter `bots.roster` — so the lookup below misses on every
         * kill and the old code returned before it ever reached the killfeed. The result was
         * a networked match with no killfeed at all, which is not a rendering bug and was not
         * going to be found by looking at the renderer.
         *
         * The mode must not run here either, and for a stronger reason than tidiness: the
         * server has already scored this kill and replicated the total. A client that scored
         * it again would double every number, then have the replicated score overwrite it a
         * few milliseconds later.
         */
        if (this.authoritative) {
          const killer = find(roster, p.sourceId);
          const victim = find(roster, p.targetId);
          // Nobody this match is tracking: not scored, and not drawn.
          if (victim === undefined) return;

          const ev: KillEvent = {
            killerId: p.sourceId,
            victimId: p.targetId,
            weaponId: p.weaponId,
            zone: p.zone,
            killerTeam: killer?.team ?? null,
            victimTeam: victim.team,
            headshot: p.zone === 'head',
            suicide: p.sourceId === p.targetId || killer === undefined,
            friendly: killer !== undefined && killer.team === victim.team,
          };
          mode.onKill(ev);
        } else {
          /**
           * Kills, deaths and streaks on a replicated client (M10, playtest round 2).
           *
           * The *team* score is replicated in the snapshot header and is the number the HUD
           * banner and the win condition use. The per-player columns are not on the wire, and
           * without this the scoreboard showed the right roster with every K/D at zero —
           * which looks like the scoreboard is broken and is really nobody counting.
           *
           * Zero points, deliberately: what a kill is *worth* is a mode decision, the mode is
           * not running here, and inventing a number would put a per-player score column on
           * screen that disagrees with the server's. Kills, deaths, assists and streaks are
           * facts about the kill itself and are the same in both runtimes.
           */
          this.deps.score.recordKill(p.sourceId, p.targetId, p.zone === 'head', 0);
        }

        this.killfeed.push(p.sourceId, p.targetId, p.weaponId, p.zone, this.tick);
      }),
    );

    // Spawns reach the mode through the same events everything else does, so a mode that
    // cares (Kill Confirmed's tags, Domination's flag ownership) never needs the roster.
    this.unsubscribe.push(
      bus.on(EV.BotSpawned, (p) => {
        const entity = find(roster, p.entityId);
        if (entity !== undefined) mode.onSpawn(entity);
      }),
    );
    this.unsubscribe.push(
      bus.on(EV.PlayerSpawned, (p) => {
        const entity = find(roster, p.entityId);
        if (entity !== undefined) mode.onSpawn(entity);
      }),
    );
  }
}

function find(roster: readonly Combatant[], entityId: number): Combatant | undefined {
  for (const c of roster) {
    if (c.entityId === entityId) return c;
  }
  return undefined;
}
