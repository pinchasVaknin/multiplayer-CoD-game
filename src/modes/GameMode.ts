import type { Combatant } from '../ai/Combatant';
import type { HitZone } from '../combat/HitboxRig';
import type { PlayerScore, ScoreSystem, ScoreTeam } from '../combat/ScoreSystem';
import type { GameBus } from '../core/Events';

/**
 * What a game mode is (brief S6.2).
 *
 * The round abstraction is here from the start, and that is the whole point of building
 * this in M4 rather than M5. TDM does not need rounds; Search & Destroy in M7 needs one
 * life, a best-of-nine and a side swap at five. If this base assumed a single continuous
 * match, M7 would be a refactor of every mode that had already shipped — so a mode
 * *declares* whether it uses rounds and `MatchFlow` owns them either way. TDM answers
 * "one round, no swap, unlimited lives" and the flow code does not special-case it.
 *
 * A mode is deliberately thin: it reads the score, decides when the match or the round is
 * over, and says what its scoreboard looks like. It does not own the clock, the roster, the
 * spawns or the respawn timers, because two modes disagreeing about any of those is how you
 * get a mode that only works when it is the only one implemented.
 */

/**
 * The brief writes `Entity`; in this codebase the thing that spawns into a match is a
 * `Combatant` — the interface that makes the player and a bot the same thing (S6.1). Aliased
 * rather than duplicated so a mode signature reads as the brief wrote it.
 */
export type Entity = Combatant;

export type GameModeId = 'TDM' | 'RANGE' | 'DOM' | 'FFA' | 'SND' | 'KC';

/** One kill, resolved. Built by `MatchFlow` from `entity.killed` plus the roster. */
export interface KillEvent {
  readonly killerId: number;
  readonly victimId: number;
  readonly weaponId: string;
  readonly zone: HitZone;
  /** Absent when the killer is not a roster member (a range dummy, or the world). */
  readonly killerTeam: ScoreTeam | null;
  readonly victimTeam: ScoreTeam | null;
  readonly headshot: boolean;
  readonly suicide: boolean;
  readonly friendly: boolean;
}

export interface RoundResult {
  readonly kind: 'round';
  readonly round: number;
  readonly winner: ScoreTeam | 'DRAW';
  readonly reason: string;
}

export interface MatchResult {
  readonly kind: 'match';
  readonly winner: ScoreTeam | 'DRAW';
  readonly reason: string;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly roundsA: number;
  readonly roundsB: number;
}

/**
 * A scoreboard column. `value` formats one row; `width` is in `ch` so the tabular numerals
 * in the design system line up without measuring text.
 */
export interface ColumnDef {
  readonly key: string;
  readonly label: string;
  readonly width: number;
  readonly align: 'left' | 'right';
  readonly value: (row: PlayerScore) => string;
}

export interface ModeDeps {
  readonly bus: GameBus;
  readonly score: ScoreSystem;
  /** Bots *and* the player. Modes must add to this array, never around it (see PLAN.md). */
  readonly roster: readonly Combatant[];
}

export abstract class GameMode {
  abstract readonly id: GameModeId;
  abstract readonly name: string;

  // ---- round support. TDM implements these as a single round ----------------

  /** Rounds a team must win to take the match. TDM: 1. */
  abstract readonly roundsToWin: number;
  /** Round after which the two teams change ends. TDM: null. */
  abstract readonly swapSidesAfterRound: number | null;
  /** Respawns allowed per player per round. TDM: Infinity. */
  abstract readonly livesPerRound: number;
  /** Wall length of one round, seconds. TDM: 600. */
  abstract readonly roundSeconds: number;
  /**
   * Whether the score bar counts up to a limit. Used by the HUD banner and by the
   * announcer's "close game" cue; a mode with no limit returns 0.
   */
  abstract readonly scoreLimit: number;

  protected readonly deps: ModeDeps;

  constructor(deps: ModeDeps) {
    this.deps = deps;
  }

  abstract onSpawn(entity: Entity): void;
  abstract onKill(ev: KillEvent): void;
  abstract onTick(tick: number): void;
  abstract checkWinCondition(): MatchResult | RoundResult | null;
  abstract getScoreboardColumns(): ColumnDef[];
  abstract onRoundStart(round: number): void;
  abstract onRoundEnd(result: RoundResult): void;

  /** The team score the banner shows. Kills in TDM, captures in Domination. */
  abstract teamScore(team: ScoreTeam): number;
}

/** Which of two team scores is ahead, for the result of a timed match. */
export function leaderOf(a: number, b: number): ScoreTeam | 'DRAW' {
  if (a > b) return 'A';
  if (b > a) return 'B';
  return 'DRAW';
}
