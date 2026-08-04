import type { Combatant } from '../ai/Combatant';
import { Killfeed } from '../combat/Killfeed';
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
    this.killfeed = new Killfeed(deps.bus, deps.roster);
    this.subscribe();
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
  applyReplicated(phase: MatchPhase, secondsRemaining: number, phaseSeconds: number, round: number): void {
    this.phase = phase;
    this.roundIndex = round;
    this.ticksRemaining = Math.max(0, Math.round(secondsRemaining / DT));
    const limit = phase === 'WARMUP' ? WARMUP_SECONDS : this.roundEndSeconds;
    this.phaseTicks = Math.max(0, Math.round((limit - phaseSeconds) / DT));
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

  /** Begin the match. Announces itself, then counts the warm-up down. */
  start(): void {
    const mode = this.deps.mode;
    this.phase = 'WARMUP';
    this.roundIndex = 1;
    this.phaseTicks = 0;
    this.ticksRemaining = Math.round(mode.roundSeconds / DT);
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

    this.ticksRemaining = Math.round(this.deps.mode.roundSeconds / DT);
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
        const killer = find(roster, p.sourceId);
        const victim = find(roster, p.targetId);
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
