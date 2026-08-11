import type { Combatant } from '../ai/Combatant';
import type { ObjectiveZone } from './ObjectiveZone';
import type { HitZone } from '../combat/HitboxRig';
import type { PlayerScore, ScoreSystem, ScoreTeam } from '../combat/ScoreSystem';
import type { GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import type { MapDef } from '../world/maps/types';

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
  /**
   * The map, for its authored objectives (M7).
   *
   * M4 wrote Domination's three flags and Search & Destroy's two bomb sites into `MapDef`
   * ahead of the modes that consume them, precisely so this milestone would not have to move
   * them after the lanes were balanced. A mode reads them here and never positions anything
   * itself — objective placement is map data, like everything else about a map.
   */
  readonly mapDef: MapDef;
  /**
   * Shorten this mode's round, seconds. Harness only.
   *
   * There are **two** match clocks and this is the seam between them. `MatchFlow` counts
   * `ticksRemaining` down — that is what the HUD shows and what the snapshot header replicates
   * — but every mode also keeps its own `ticksLeft`, seeded from its own config, and it is the
   * mode's clock that `checkWinCondition` reads to decide a match on time. They agree today
   * only because both are seeded from the same authored number. A harness that shortened only
   * `MatchFlow`'s clock got a HUD that hit zero and a match that carried on for another nine
   * minutes.
   *
   * Both are overridden from this one value, so they cannot be shortened apart. Left as two
   * clocks deliberately: collapsing them means changing how all five modes decide a time limit,
   * and the shared simulation is verified and should be extended, not rewritten.
   */
  readonly roundSecondsOverride?: number | undefined;
  /**
   * Which authored ruleset this match runs (M11, §6.4).
   *
   * `'STANDARD'` is what the menu and every earlier milestone build. `'SKIRMISH'` is the
   * drop-in flow's variant, and today exactly one mode reads it: Search & Destroy runs a
   * shorter series on the ballot, because a full one is a twenty-minute commitment in a flow
   * whose whole premise is that you did not commit to anything.
   *
   * A named variant rather than a bag of per-mode overrides on this interface. The numbers
   * still live in one config object per variant next to the mode that owns them (S3), and a
   * mode that has no variant simply never reads the field.
   */
  readonly variant?: MatchVariant | undefined;
}

/**
 * See `ModeDeps.variant`.
 *
 * `'WARMUP'` is the permanent arena (§6.3): free-for-all rules with damage live and instant
 * respawn, and **no score, no win condition and no match timer**. It is a variant rather than
 * a sixth mode because it is Free-for-All with two limits switched off, and §9 puts new modes
 * out of scope for good reason.
 */
export type MatchVariant = 'STANDARD' | 'SKIRMISH' | 'WARMUP';

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

  /**
   * Seconds a decided round is held on screen before the next one starts (post-M8).
   *
   * A default rather than an abstract, because only one mode has an opinion. Four seconds is
   * right for a Domination round that ended on a score limit and wrong for Search & Destroy,
   * where the round ends on a bang and the players are watching a corpse — S&D overrides it
   * downward. See `MatchFlow.roundEndSeconds`, which asks the mode rather than using a
   * constant, so "how long is the hold" has one answer per mode and none in the flow.
   */
  readonly roundEndSeconds: number = 4;

  protected readonly deps: ModeDeps;

  constructor(deps: ModeDeps) {
    this.deps = deps;
  }

  /**
   * How long this mode's round runs, in ticks. The authored length unless a harness said
   * otherwise. See `ModeDeps.roundSecondsOverride` for why both clocks read this.
   */
  protected roundTicks(authoredSeconds: number): number {
    const override = this.deps.roundSecondsOverride;
    const seconds = override !== undefined && override > 0 ? override : authoredSeconds;
    return Math.round(seconds / DT);
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

  /**
   * The mode's objective zones, in a fixed order, or empty (M11 Gate B, §6.8).
   *
   * The seam objective replication runs through. Declared on the base rather than tested for
   * with `instanceof` at the call site, because the server must be able to ask *any* mode for
   * its objectives without importing the concrete classes — and because a mode added later that
   * forgets to override this replicates nothing rather than crashing the encoder.
   *
   * Order is identity on the wire. It comes from `MapDef.objectives`, which both runtimes build
   * from the same data, so index N on the server is index N on the client.
   */
  get objectiveZones(): readonly ObjectiveZone[] {
    return [];
  }
}

/** Which of two team scores is ahead, for the result of a timed match. */
export function leaderOf(a: number, b: number): ScoreTeam | 'DRAW' {
  if (a > b) return 'A';
  if (b > a) return 'B';
  return 'DRAW';
}
