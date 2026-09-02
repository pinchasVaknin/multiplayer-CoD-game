import type { ScoreTeam } from '../combat/ScoreSystem';
import { accuracy } from '../combat/ScoreSystem';
import { DT } from '../core/Loop';
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
 * The Shooting Range — a testbed, from the M5 playtest notes.
 *
 * M5 shipped twelve weapons whose only entry point was the F1 debug picker, and the
 * playtest asked for "a dedicated, selectable Shooting Range game mode (with zero enemy
 * bots and active DPS/damage dummies) so all weapons can be tested freely once the Loadout
 * system is built". This is that: the grey-box room, M2's six target dummies, nobody
 * shooting back, and — the part that matters for M6 — **every unlock gate lifted**.
 *
 * That last decision is deliberate and is the reason this is a mode rather than a menu
 * toggle. Progression makes eleven of the twelve weapons unreachable at level 1, which is
 * correct for a match and useless for testing recoil. `ModeEntry.unrestricted` lets the
 * loadout editor offer everything here, and `banksProgress` is false so nothing done in
 * the range can move the account — a range that awarded XP would be the fastest way to
 * level, and progression earned by shooting cardboard is not progression.
 *
 * It is not a stub of a mode: it has a real win condition (the clock), a real scoreboard,
 * and it ends and summarises like anything else. It simply has nothing to score against.
 */

export interface RangeConfig {
  /** Session length, seconds. Long enough to work through the arsenal. */
  readonly timeLimitSeconds: number;
  /** Personal score for a dummy, so the scoreboard is not permanently zero. */
  readonly pointsPerTarget: number;
}

export const RANGE_CONFIG: RangeConfig = {
  timeLimitSeconds: 900,
  pointsPerTarget: 10,
};

export class Range extends GameMode {
  override readonly id: GameModeId = 'RANGE';
  override readonly name = 'SHOOTING RANGE';

  override readonly roundsToWin = 1;
  override readonly swapSidesAfterRound: number | null = null;
  override readonly livesPerRound = Infinity;
  override readonly roundSeconds: number;
  /** No limit: the bar at the top of the HUD has nothing to count toward. */
  override readonly scoreLimit = 0;

  /**
   * F10. Nobody is coming, which on a range is the whole brief.
   *
   * No distances in it deliberately: where the dummies stand is `client/combat/TargetRange.ts`,
   * which this package cannot see, and a sentence in `shared/` naming numbers held in `client/`
   * is a sentence that goes stale the first time somebody moves a target.
   */
  override readonly brief = 'EVERY WEAPON UNLOCKED · STATIC AND POP-UP TARGETS · NOBODY SHOOTING BACK';

  private readonly config: RangeConfig;
  private ticksLeft = 0;

  constructor(deps: ModeDeps, config: RangeConfig = RANGE_CONFIG) {
    super(deps);
    this.config = config;
    this.roundSeconds = config.timeLimitSeconds;
  }

  override onSpawn(_entity: Entity): void {
    /* Nothing to attach to a spawn on a range. */
  }

  /**
   * A dummy is not a person, so a "kill" here is a target knocked down.
   *
   * It scores personal points and never touches a team total — there is no other team,
   * and a range that could be "won" would end itself while the player was still working.
   */
  override onKill(ev: KillEvent): void {
    this.deps.score.recordKill(ev.killerId, ev.victimId, ev.headshot, this.config.pointsPerTarget);
  }

  override onTick(_tick: number): void {
    if (this.ticksLeft > 0) this.ticksLeft--;
  }

  override checkWinCondition(): MatchResult | RoundResult | null {
    if (this.ticksLeft > 0) return null;
    return {
      kind: 'match',
      winner: 'DRAW',
      reason: 'Session ended',
      scoreA: 0,
      scoreB: 0,
      roundsA: 0,
      roundsB: 0,
    };
  }

  /**
   * A range scoreboard is about the *weapon*, not about the fight: shots, hits and
   * accuracy are the three numbers a player is on a range to read.
   */
  override getScoreboardColumns(): ColumnDef[] {
    return [
      { key: 'score', label: 'Score', width: 6, align: 'right', value: (r) => String(r.score) },
      { key: 'hits', label: 'Hits', width: 6, align: 'right', value: (r) => String(r.shotsHit) },
      { key: 'shots', label: 'Shots', width: 6, align: 'right', value: (r) => String(r.shotsFired) },
      {
        key: 'acc',
        label: 'Acc',
        width: 6,
        align: 'right',
        value: (r) => {
          const pct = accuracy(r);
          return pct < 0 ? '—' : `${pct.toFixed(1)}%`;
        },
      },
      {
        key: 'dmg',
        label: 'Damage',
        width: 8,
        align: 'right',
        value: (r) => r.damageDealt.toFixed(0),
      },
    ];
  }

  override onRoundStart(_round: number): void {
    this.ticksLeft = Math.round(this.config.timeLimitSeconds / DT);
  }

  override onRoundEnd(_result: RoundResult): void {
    /* One session, and it ends with the round. */
  }

  override teamScore(_team: ScoreTeam): number {
    return 0;
  }
}
