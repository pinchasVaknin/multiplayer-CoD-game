import type { ScoreTeam } from '../combat/ScoreSystem';
import { accuracy, killDeath } from '../combat/ScoreSystem';
import {
  GameMode,
  leaderOf,
  type ColumnDef,
  type Entity,
  type GameModeId,
  type KillEvent,
  type MatchResult,
  type ModeDeps,
  type RoundResult,
} from './GameMode';

/**
 * Team Deathmatch (brief S6.2): first to 75 kills or ten minutes.
 *
 * The mode is small, and that is the result the round abstraction was built for. TDM's
 * answer to every round question is "one round, no swap, unlimited lives" — three constants
 * — and `MatchFlow` runs the same machine it will run for a best-of-nine. Nothing here
 * knows what a round *is*.
 *
 * The only real decisions in the file are what a kill is worth and what the scoreboard shows,
 * and both live in `TDM_CONFIG` because S3 says every number that affects feel belongs in a
 * config rather than inline in logic.
 */

export interface TdmConfig {
  /**
   * Kills that win the match. The team score in TDM *is* a kill count, which is why nothing
   * below is added to it — see `onKill`.
   */
  readonly scoreLimit: number;
  /** Length of the match, seconds. */
  readonly timeLimitSeconds: number;
  /** Scoreboard points for a kill. Personal score only. */
  readonly pointsPerKill: number;
  /** Extra scoreboard points for putting it through the head. */
  readonly pointsHeadshotBonus: number;
  /** Team kills deducted for killing your own. Only reachable with friendly fire on. */
  readonly teamKillPenalty: number;
}

export const TDM_CONFIG: TdmConfig = {
  scoreLimit: 75,
  timeLimitSeconds: 600,
  pointsPerKill: 100,
  pointsHeadshotBonus: 50,
  teamKillPenalty: 1,
};

export class Tdm extends GameMode {
  override readonly id: GameModeId = 'TDM';
  override readonly name = 'TEAM DEATHMATCH';

  // ---- round support, answered trivially ----------------------------------
  override readonly roundsToWin = 1;
  override readonly swapSidesAfterRound: number | null = null;
  override readonly livesPerRound = Infinity;
  override readonly roundSeconds: number;
  override readonly scoreLimit: number;

  private readonly config: TdmConfig;
  /** Ticks left, owned here because the win condition is the only thing that reads it. */
  private ticksLeft = 0;

  constructor(deps: ModeDeps, config: TdmConfig = TDM_CONFIG) {
    super(deps);
    this.config = config;
    this.roundSeconds = config.timeLimitSeconds;
    this.scoreLimit = config.scoreLimit;
  }

  /**
   * Nothing to do when somebody spawns.
   *
   * Not a stub — TDM genuinely has no per-spawn state, which is exactly why the interface
   * puts the hook here rather than making every mode invent one. Domination attaches flag
   * ownership to this, Kill Confirmed drops a tag.
   */
  override onSpawn(_entity: Entity): void {
    /* TDM scores kills, not spawns. */
  }

  /**
   * A kill is worth `pointsPerKill` on the *scoreboard* and exactly **one** on the team
   * score, because the team score in TDM is a kill count and the win condition is "first to
   * 75 kills". Adding the scoreboard points to the team total instead was a real bug and an
   * instructive one: the score limit is 75 and a kill was worth 100, so every match ended on
   * its first kill and every other number in the mode looked plausible.
   */
  override onKill(ev: KillEvent): void {
    const points = ev.headshot
      ? this.config.pointsPerKill + this.config.pointsHeadshotBonus
      : this.config.pointsPerKill;
    this.deps.score.recordKill(ev.killerId, ev.victimId, ev.headshot, points);

    if (ev.suicide || ev.victimTeam === null) return;
    if (ev.friendly) {
      // Costs the killer's team a kill rather than awarding one. Unreachable while friendly
      // fire is off, and correct the moment a playlist turns it on.
      if (ev.killerTeam !== null) {
        this.deps.score.addTeamScore(ev.killerTeam, -this.config.teamKillPenalty);
      }
      return;
    }
    if (ev.killerTeam === null) return;
    this.deps.score.addTeamScore(ev.killerTeam, 1);
  }

  override onTick(_tick: number): void {
    if (this.ticksLeft > 0) this.ticksLeft--;
  }

  /**
   * The whole win condition. Returns a `MatchResult` and never a `RoundResult`, because a
   * TDM round *is* the match — which is what "implements them trivially as a single round"
   * means in practice.
   */
  override checkWinCondition(): MatchResult | RoundResult | null {
    const a = this.teamScore('A');
    const b = this.teamScore('B');

    if (a >= this.config.scoreLimit || b >= this.config.scoreLimit) {
      return this.result(leaderOf(a, b), 'Score limit', a, b);
    }
    if (this.ticksLeft <= 0) {
      const winner = leaderOf(a, b);
      return this.result(winner, winner === 'DRAW' ? 'Time — draw' : 'Time limit', a, b);
    }
    return null;
  }

  override getScoreboardColumns(): ColumnDef[] {
    return [
      { key: 'score', label: 'Score', width: 6, align: 'right', value: (r) => String(r.score) },
      { key: 'kills', label: 'K', width: 4, align: 'right', value: (r) => String(r.kills) },
      { key: 'deaths', label: 'D', width: 4, align: 'right', value: (r) => String(r.deaths) },
      { key: 'kd', label: 'K/D', width: 5, align: 'right', value: (r) => killDeath(r).toFixed(2) },
      {
        key: 'acc',
        label: 'Acc',
        width: 6,
        align: 'right',
        value: (r) => {
          const pct = accuracy(r);
          return pct < 0 ? '—' : `${pct.toFixed(0)}%`;
        },
      },
      { key: 'streak', label: 'Best', width: 5, align: 'right', value: (r) => String(r.bestStreak) },
    ];
  }

  override onRoundStart(_round: number): void {
    this.ticksLeft = this.roundTicks(this.config.timeLimitSeconds);
  }

  override onRoundEnd(_result: RoundResult): void {
    /* Nothing carries over: TDM has one round and the match ends with it. */
  }

  override teamScore(team: ScoreTeam): number {
    return this.deps.score.team(team).score;
  }

  private result(winner: ScoreTeam | 'DRAW', reason: string, a: number, b: number): MatchResult {
    return {
      kind: 'match',
      winner,
      reason,
      scoreA: a,
      scoreB: b,
      roundsA: winner === 'A' ? 1 : 0,
      roundsB: winner === 'B' ? 1 : 0,
    };
  }
}
