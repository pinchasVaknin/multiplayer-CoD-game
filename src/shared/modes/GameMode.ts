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
 * `'WARMUP'` is the permanent arena (§6.3): free-for-all rules with damage live, and **no
 * score, no win condition, no match timer, and nobody killable** (the last from playtest round
 * 4, F7). It is a variant rather than a sixth mode because it is Free-for-All with its limits
 * switched off and its consequences unwired, and §9 puts new modes out of scope for good
 * reason. `ServerMatch` reads it for the two consequences; `FreeForAll` reads it for the limits.
 */
export type MatchVariant = 'STANDARD' | 'SKIRMISH' | 'WARMUP';

/**
 * One cell of the mode's persistent header strip (playtest round 5, F8).
 *
 * Deliberately four fields and no more. The temptation is a per-mode shape — flags for
 * Domination, a bomb for Search & Destroy — and it is the wrong one for the reason `brief`'s
 * comment gives about a HUD that knows the name of every mode. What every header cell in this
 * game has in common is a short label, a side that currently holds it, and possibly something
 * filling; anything a mode wants said beyond that belongs in `brief` or in the contextual
 * banner, both of which already exist.
 */
export interface HeaderSlot {
  /** One or two characters: a flag's letter, a bomb site's letter. Drawn as given. */
  readonly label: string;
  /** Who holds it now, or `'NONE'` for neutral. Drives the cell's colour. */
  readonly owner: ScoreTeam | 'NONE';
  /**
   * 0..1 of something filling this cell, or 0 for nothing happening.
   *
   * A capture in Domination; a plant's fuse in Search & Destroy. The HUD draws it as a fill and
   * does not care which, because both mean the same thing to somebody deciding where to go: this
   * one is about to change hands.
   */
  readonly progress: number;
  /** Whose `progress` it is, when it is not the owner's. */
  readonly capturing: ScoreTeam | 'NONE';
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

  /**
   * One line saying what a player is here to do (playtest round 4, F10).
   *
   * *"A short brief per mode: what the objective is, where to take the bomb."* The obvious
   * shape for that is a map of strings in the HUD, and it is the wrong one: a HUD that knows
   * the name of every mode is a HUD that has to be edited when a mode is added, and the sixth
   * mode is the one that gets forgotten. So the mode says it and the HUD draws whatever it is
   * given — and because this is **abstract**, a mode that forgets is a compile error rather
   * than a blank banner nobody notices until a playtest.
   *
   * A getter rather than a string field on three of the five, and that is the second reason it
   * lives here rather than beside `ModeEntry.blurb` in the registry: *"where to take the bomb"*
   * is a per-map fact. Search & Destroy names its actual sites, Domination its actual flags, and
   * both read them off the objectives the map authored. A registry entry knows the mode's rules
   * and cannot know the map's letters.
   *
   * It is not `ModeEntry.blurb` and does not replace it. The blurb sells a mode to somebody
   * choosing one — *"first to 75 kills, or ten minutes"* — on a screen a player migrated in by a
   * ballot never sees. This is an instruction to somebody who is already standing on the map
   * with ten seconds before the round starts, and the two are different sentences on purpose.
   *
   * Upper case, no trailing punctuation, and short enough to read in that window: it is drawn
   * under the `GET READY` caption in one line. See `briefVisible` in `shared/ui/HudSurfaces.ts`
   * for exactly when, and `MatchHud` for the one writer.
   */
  abstract readonly brief: string;

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

  /**
   * What this mode wants standing in the top bar for the whole match (playtest round 5, F8).
   *
   * F8 reported that in Domination *"which team holds A, B or C is readable only from the
   * minimap"*. The objective banner exists and works, but it is contextual — it appears when you
   * are standing in a point, which is after the decision it would have informed. The information
   * is on the client the whole time: `MatchWorld` writes every replicated `ObjectiveState` onto
   * these zones, so unlike `teamScore` this is live rather than a structural zero.
   *
   * The artefact F8 asks for is *"not flags in the top bar but a header slot the mode fills"*,
   * and this is the same idea as `brief` above, made permanent instead of shown once: the HUD
   * draws whatever list it is handed and knows the name of no mode, so the next mode gets a
   * header without a new component and without an edit to the HUD.
   *
   * ## Why this is a default and `brief` is abstract
   *
   * Every mode owes the player a sentence about what they are here to do, so forgetting one is
   * a compile error. Not every mode has a persistent header worth drawing — Kill Confirmed's
   * tags are loose objects on the floor with no owner and no progress, and forcing it to invent
   * a row would put something meaningless in the one strip that is always on screen. An empty
   * list is a real answer here in a way it is not for `brief`.
   */
  get headerSlots(): readonly HeaderSlot[] {
    return [];
  }

  /**
   * Loose objects the mode has put on the floor — Kill Confirmed's tags (M11 Gate B, §6.8).
   *
   * The second seam replication runs through, and it exists for the same reason the first one
   * does: the server must be able to ask *any* mode what it has dropped without importing
   * `KillConfirmed`.
   *
   * **`null` and `[]` mean different things, and conflating them costs a bug.** `null` is "this
   * mode has no such thing", and the instance sends no message at all. `[]` is "this mode drops
   * tags and there are none on the floor *right now*", which must still be sent — a client told
   * only about non-empty lists would never learn that the last tag was collected and would draw
   * it lying there for the rest of the match. The zones channel can skip on empty because a
   * zone list is fixed at construction; a tag list is not.
   *
   * The shape is structural rather than `DogTag` itself, which would put a concrete mode's
   * type on its own base class and make the import circular. `DogTag` satisfies it — it has
   * these five fields and two more that are nobody else's business.
   */
  get dogTags(): readonly TagInfo[] | null {
    return null;
  }

  /**
   * The mode's bomb, or null for the four modes that have none (M11 Gate B, §6.8).
   *
   * Returned as **one stable object the mode owns and mutates**, never a fresh literal. This
   * is read on the snapshot cadence from inside the tick, and S4.7 allows no allocation on
   * that path; a getter that built a record would allocate 20 objects a second per instance
   * for the whole of a Search & Destroy match.
   */
  get bombInfo(): BombInfo | null {
    return null;
  }
}

/**
 * A dropped object's replicable state, structurally.
 *
 * `id` is what makes a tag the same tag from one frame to the next, which the renderer's mesh
 * pool depends on and which an index into a list that shrinks in the middle cannot give it.
 */
export interface TagInfo {
  readonly id: number;
  /** The side that died. Enemy tags confirm; your own deny. */
  readonly team: ScoreTeam;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Everything about the bomb that a client may not work out for itself (§6.8). */
export interface BombInfo {
  readonly state: 'CARRIED' | 'PLANTED' | 'DEFUSED' | 'EXPLODED';
  /** Who is carrying it, or -1 while it is on the ground. */
  readonly carrierId: number;
  /** Which side attacks this round. */
  readonly attackers: ScoreTeam;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Fuse remaining, seconds. Zero unless planted. */
  readonly secondsLeft: number;
  /** 0..1 on the plant or defuse currently running. */
  readonly interactFraction: number;
  /** Who is doing it, so an interrupted plant does not resume under somebody else. */
  readonly interactEntity: number;
  /** Index into `objectiveZones` once planted, or -1. */
  readonly plantedSiteIndex: number;
}

/**
 * The writable face of `BombInfo`, for the single instance a mode owns and rewrites each tick.
 *
 * Mapped rather than declared twice so a field added to `BombInfo` cannot be forgotten here —
 * which is the failure mode of two hand-written interfaces that are meant to stay in step.
 */
export type MutableBombInfo = { -readonly [K in keyof BombInfo]: BombInfo[K] };

/** Which of two team scores is ahead, for the result of a timed match. */
export function leaderOf(a: number, b: number): ScoreTeam | 'DRAW' {
  if (a > b) return 'A';
  if (b > a) return 'B';
  return 'DRAW';
}
