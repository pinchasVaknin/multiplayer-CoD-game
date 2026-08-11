import { accuracy, killDeath, type ScoreTeam } from '../combat/ScoreSystem';
import {
  GameMode,
  type ColumnDef,
  type Entity,
  type GameModeId,
  type KillEvent,
  type MatchResult,
  type ModeDeps,
  type RoundResult,
} from './GameMode';

/**
 * Free-for-All (brief S6.2): eight players, no teams, first to thirty kills.
 *
 * ## The awkward part, stated plainly
 *
 * Everything underneath this mode is built on two teams. `ScoreTeam` is `'A' | 'B'`,
 * `Combatant.team` is `BotTeam`, spawn safety scores candidates against "the other team",
 * perception filters by team, and the killfeed colours rows by it. FFA has eight sides.
 *
 * Rewriting that for one mode would be the wrong trade — it is the M4 foundation every other
 * mode stands on, and the brief says to extend rather than rewrite. So FFA keeps the two-team
 * substrate and makes it *irrelevant*:
 *
 *  - **The win condition ignores teams entirely.** `checkWinCondition` scans the individual
 *    rows for the first to `scoreLimit`, and the "team score" the banner shows is the best
 *    individual score on each side, so the bar still means something without implying a team.
 *  - **Everyone is hostile.** `MatchWorld` puts FFA's roster on alternating sides so the eight
 *    are split 4/4, which is what makes perception, spawn safety and the aim model treat
 *    roughly half the lobby as enemies for free — and `Match` additionally turns on
 *    `ffaHostility`, which makes the spawn selector and the bot brain treat *every* other
 *    combatant as a threat regardless of side.
 *  - **Friendly fire is not a concept.** There are no teammates, so `onKill` credits every
 *    kill and never applies the team-kill penalty.
 *
 * What a player sees is eight operators who all shoot each other and a scoreboard with no team
 * split. What the engine sees is the same two-team machinery it has run since M4. The one
 * place the seam is visible is the minimap, which is told to draw no allies.
 */

export interface FreeForAllConfig {
  /** Kills that win. */
  readonly scoreLimit: number;
  readonly timeLimitSeconds: number;
  /** Total combatants including the player. */
  readonly playerCount: number;
  readonly pointsPerKill: number;
  readonly pointsHeadshotBonus: number;
}

export const FFA_CONFIG: FreeForAllConfig = {
  scoreLimit: 30,
  timeLimitSeconds: 600,
  playerCount: 8,
  pointsPerKill: 100,
  pointsHeadshotBonus: 50,
};

/**
 * The permanent warmup arena's rules (M11, §6.3).
 *
 * §6.3: *"Free-for-all rules with damage live and instant respawn. **No score, no win
 * condition, no match timer.** Killing and being killed carries no consequence beyond the
 * respawn."*
 *
 * Both limits are zero, and zero means *absent* rather than *immediate* — see
 * `checkWinCondition`, which is where that convention is enforced. `Range` has used the same
 * convention for `scoreLimit` since M6 (*"No limit: the bar at the top of the HUD has nothing
 * to count toward"*), so this is an existing idea applied to a second mode rather than a new
 * one.
 *
 * The alternative — a very large limit — was rejected on the grounds that it is a lie that
 * eventually comes true. An arena running for twelve hours under the soak harness would reach
 * any finite kill count, and it would end the one world in the process that has no path to
 * `DESTROYED` and nowhere to migrate its players to.
 */
export const FFA_WARMUP_CONFIG: FreeForAllConfig = {
  ...FFA_CONFIG,
  scoreLimit: 0,
  timeLimitSeconds: 0,
  // Small: §6.3 asks for 2-3 bots so a lone player has something to shoot, and the arena is
  // the M1 greybox room rather than a map balanced for eight.
  playerCount: 4,
};

export class FreeForAll extends GameMode {
  override readonly id: GameModeId = 'FFA';
  override readonly name = 'FREE-FOR-ALL';

  override readonly roundsToWin = 1;
  override readonly swapSidesAfterRound: number | null = null;
  override readonly livesPerRound = Infinity;
  override readonly roundSeconds: number;
  override readonly scoreLimit: number;

  private readonly config: FreeForAllConfig;
  private ticksLeft = 0;

  constructor(deps: ModeDeps, config: FreeForAllConfig = FFA_CONFIG) {
    super(deps);
    this.config = config;
    this.roundSeconds = config.timeLimitSeconds;
    this.scoreLimit = config.scoreLimit;
  }

  override onSpawn(_entity: Entity): void {
    /* No per-spawn state: FFA is kills and nothing else. */
  }

  /**
   * Every kill counts, including one on somebody who happens to share your substrate side.
   *
   * There is no friendly fire concept in FFA, so the team-kill penalty TDM applies is simply
   * absent rather than disabled — a kill is a kill.
   */
  override onKill(ev: KillEvent): void {
    const points = ev.headshot
      ? this.config.pointsPerKill + this.config.pointsHeadshotBonus
      : this.config.pointsPerKill;

    if (ev.suicide) {
      // Still records the death and resets the streak; `recordKill` handles the self case.
      this.deps.score.recordKill(ev.killerId, ev.victimId, false, 0);
      return;
    }
    this.deps.score.recordKill(ev.killerId, ev.victimId, ev.headshot, points);
  }

  override onTick(_tick: number): void {
    if (this.ticksLeft > 0) this.ticksLeft--;
  }

  /**
   * First *individual* to the limit wins. Teams do not enter into it.
   *
   * The `MatchResult` still has to name a `ScoreTeam`, because the summary screen and
   * `MatchFlow` are written against one — so the winner's own side is reported, which is what
   * makes "VICTORY" correct for the player when the player is the one who won.
   */
  override checkWinCondition(): MatchResult | RoundResult | null {
    let leader = null as null | { team: ScoreTeam; kills: number };
    let runnerUp = -1;
    for (const row of this.deps.score.rows) {
      if (leader === null || row.kills > leader.kills) {
        if (leader !== null) runnerUp = leader.kills;
        leader = { team: row.team, kills: row.kills };
      } else if (row.kills > runnerUp) {
        runnerUp = row.kills;
      }
    }
    if (leader === null) return null;

    /**
     * A non-positive limit is **no limit** (M11, §6.3).
     *
     * Guarded on the *config* rather than on the running counter, and the distinction is the
     * whole point: `ticksLeft` is seeded from `timeLimitSeconds`, so a zero time limit would
     * otherwise make `ticksLeft <= 0` true on the first tick and end the match instantly —
     * turning "no clock" into "no match". The same trap sits under `scoreLimit`, where
     * `leader.kills >= 0` is true before anybody has fired.
     */
    if (this.config.scoreLimit > 0 && leader.kills >= this.config.scoreLimit) {
      return this.result(leader.team, 'Kill limit', leader.kills, runnerUp);
    }
    if (this.config.timeLimitSeconds > 0 && this.ticksLeft <= 0) {
      // A tie at the top is a draw, exactly as a tied team score is.
      const drawn = leader.kills === runnerUp;
      return this.result(drawn ? 'DRAW' : leader.team, drawn ? 'Time — draw' : 'Time limit', leader.kills, runnerUp);
    }
    return null;
  }

  /** No team columns: FFA's board is a straight ladder. */
  override getScoreboardColumns(): ColumnDef[] {
    return [
      { key: 'score', label: 'Score', width: 6, align: 'right', value: (r) => String(r.score) },
      { key: 'kills', label: 'K', width: 4, align: 'right', value: (r) => String(r.kills) },
      { key: 'deaths', label: 'D', width: 4, align: 'right', value: (r) => String(r.deaths) },
      { key: 'kd', label: 'K/D', width: 5, align: 'right', value: (r) => killDeath(r).toFixed(2) },
      {
        key: 'acc', label: 'Acc', width: 6, align: 'right',
        value: (r) => { const p = accuracy(r); return p < 0 ? '—' : `${p.toFixed(0)}%`; },
      },
      { key: 'streak', label: 'Best', width: 5, align: 'right', value: (r) => String(r.bestStreak) },
    ];
  }

  override onRoundStart(_round: number): void {
    this.ticksLeft = this.roundTicks(this.config.timeLimitSeconds);
  }

  override onRoundEnd(_result: RoundResult): void {
    /* One round. */
  }

  /**
   * The banner's per-side number is the *best individual* on that side.
   *
   * There is no team total in FFA, and showing a sum would tell the player their team is
   * winning a mode that has no teams. The best score on each side is the closest honest thing
   * a two-sided banner can say, and it makes the bar track the actual leader.
   */
  override teamScore(team: ScoreTeam): number {
    let best = 0;
    for (const row of this.deps.score.rows) {
      if (row.team !== team) continue;
      if (row.kills > best) best = row.kills;
    }
    return best;
  }

  private result(winner: ScoreTeam | 'DRAW', reason: string, a: number, b: number): MatchResult {
    return {
      kind: 'match', winner, reason, scoreA: a, scoreB: b,
      roundsA: winner === 'A' ? 1 : 0, roundsB: winner === 'B' ? 1 : 0,
    };
  }
}
