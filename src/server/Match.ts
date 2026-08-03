import { DEFAULT_SCHEDULER, type SchedulerConfig } from '../shared/ai/AiScheduler';
import { BotDirector } from '../shared/ai/BotDirector';
import type { BotTeam } from '../shared/ai/Combatant';
import {
  cloneTierTable,
  DEFAULT_PERCEPTION,
  DEFAULT_TIERS,
  type BotTier,
  type PerceptionConfig,
  type TierTable,
} from '../shared/ai/DifficultyTiers';
import { DamageSystem } from '../shared/combat/DamageSystem';
import { ScoreSystem } from '../shared/combat/ScoreSystem';
import { createGameBus, EV, type GameBus } from '../shared/core/Events';
import { DT } from '../shared/core/Loop';
import { logger } from '../shared/core/Log';
import type { GameMode, MatchResult } from '../shared/modes/GameMode';
import { MatchFlow } from '../shared/modes/MatchFlow';
import { findMap, findMode, type MapEntry, type ModeEntry } from '../shared/modes/ModeRegistry';
import { DEFAULT_HEALTH_CONFIG, type HealthConfig } from '../shared/player/Health';
import {
  cloneMovementConfig,
  DEFAULT_MOVEMENT_CONFIG,
  type MovementConfig,
} from '../shared/player/MovementConfig';
import {
  cloneViewmodelConfig,
  DEFAULT_VIEWMODEL_CONFIG,
  type ViewmodelConfig,
} from '../shared/weapons/ViewmodelConfig';
import type { CollisionWorld } from '../shared/world/CollisionWorld';
import { loadMapCollision } from '../shared/world/MapLoader';
import { Spectator } from './Spectator';

const log = logger('Match');

/**
 * A match, running with no renderer (brief S6.4).
 *
 * This is the milestone's gate made into a class: a `MapDef` in, colliders and a navmesh
 * baked, ten bots spawned, a `GameMode` ticking on the shared simulation, and a result out.
 * **No transport.** M9 explicitly builds no networking, so this runs alone; M10 wraps it.
 *
 * ## What it is not
 *
 * It is not `client/ClientMatch.ts` with the drawing removed. That file is the *client's*
 * composition root — it owns a viewmodel, a HUD, an audio graph, a camera rig and a local
 * player, and it is right that it does. This owns the authoritative half and nothing else,
 * which is why it is about a tenth of the size. The shared systems underneath are literally
 * the same modules; only the wiring differs.
 *
 * ## What is deliberately absent
 *
 * - **No local player.** S4.9: every player is a client. The roster's player seat is a
 *   `Spectator` that never participates — the same mechanism the M3 AFK harness used.
 * - **No weapons for a human, no viewmodel, no melee, no equipment thrower.** Bots draw their
 *   own weapons (`ai/BotArsenal`), and everything else in that list is a local-player system.
 * - **No killstreaks yet.** `StreakSystem` needs a `StreakPresentation`, and
 *   `SILENT_PRESENTATION` is ready for it — but streaks are earned by a player's kill streak
 *   and the bot path for that is M11's business. Left out rather than half-wired.
 * - **No progression.** `MatchProgression` needs a `ProgressionStore`, and S4.16 says there is
 *   no server database. XP is awarded server-side from M10 and persisted client-side.
 */

export interface ServerMatchOptions {
  /** Map id from the registry, e.g. `mp_foundry`. */
  readonly mapId: string;
  /** Mode id from the registry, e.g. `TDM`. */
  readonly modeId: string;
  /** Total bots across both sides. Split as evenly as possible. */
  readonly bots: number;
  /** A single tier for every bot, or 'MIX' for the map's authored spread. */
  readonly tier: BotTier | 'MIX';
  /** Deterministic seed. The same seed replays the same match. */
  readonly seed: number;
}

export interface ServerMatchResult {
  readonly mapId: string;
  readonly modeId: string;
  readonly winner: string;
  readonly reason: string;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly roundsA: number;
  readonly roundsB: number;
  /** Simulated seconds the match took. Ticks divided by 60, never wall clock. */
  readonly simSeconds: number;
  readonly ticks: number;
}

export class ServerMatch {
  readonly bus: GameBus = createGameBus();
  readonly world: CollisionWorld;
  readonly damage: DamageSystem;
  readonly score: ScoreSystem;
  readonly mode: GameMode;
  readonly flow: MatchFlow;
  readonly bots: BotDirector;

  readonly mapEntry: MapEntry;
  readonly modeEntry: ModeEntry;

  /** Config objects. Cloned, so a future tuning message cannot mutate the shipped defaults. */
  readonly movementConfig: MovementConfig = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
  readonly healthConfig: HealthConfig = { ...DEFAULT_HEALTH_CONFIG };
  readonly viewmodelConfig: ViewmodelConfig = cloneViewmodelConfig(DEFAULT_VIEWMODEL_CONFIG);
  readonly tiers: TierTable = cloneTierTable(DEFAULT_TIERS);
  readonly perceptionConfig: PerceptionConfig = { ...DEFAULT_PERCEPTION };
  readonly schedulerConfig: SchedulerConfig = { ...DEFAULT_SCHEDULER };

  private readonly spectator: Spectator;
  private readonly unsubscribe: Array<() => void> = [];
  private result: MatchResult | null = null;
  private ticks = 0;

  constructor(private readonly options: ServerMatchOptions) {
    this.mapEntry = findMap(options.mapId);
    this.modeEntry = findMode(asModeId(options.modeId));

    // ---- the world ---------------------------------------------------------
    // Collision and nav only. `client/world/MapRender.ts` holds the half that would have
    // needed a GPU, and this process never imports it.
    const loaded = loadMapCollision(this.mapEntry.def);
    this.world = loaded.collision;
    log.info(
      `${this.mapEntry.name}: ${loaded.stats.colliders} colliders, ` +
        `${loaded.stats.hashEntries} hash entries across ${loaded.stats.hashCells} cells.`,
    );

    // ---- the firefight -----------------------------------------------------
    this.damage = new DamageSystem(this.bus);
    this.spectator = new Spectator(PLAYER_TEAM, this.healthConfig);

    this.bots = new BotDirector({
      world: this.world,
      mapDef: this.mapEntry.def,
      bus: this.bus,
      damage: this.damage,
      movement: this.movementConfig,
      healthConfig: this.healthConfig,
      viewmodelConfig: this.viewmodelConfig,
      tiers: this.tiers,
      perceptionConfig: this.perceptionConfig,
      scheduler: this.schedulerConfig,
      player: this.spectator,
      seed: options.seed,
    });
    this.bots.freeForAll = this.modeEntry.id === 'FFA';

    // ---- the match ---------------------------------------------------------
    this.score = new ScoreSystem(this.bus);
    this.mode = this.modeEntry.create({
      bus: this.bus,
      score: this.score,
      roster: this.bots.roster,
      mapDef: this.mapEntry.def,
    });
    this.flow = new MatchFlow({
      bus: this.bus,
      score: this.score,
      roster: this.bots.roster,
      mode: this.mode,
      mapId: this.mapEntry.id,
      mapName: this.mapEntry.name,
      // There is no local side on a dedicated server. `localTeam` only decides whether the
      // announcer calls a win a victory, and nothing headless listens to the announcer.
      localTeam: PLAYER_TEAM,
      onSidesSwapped: (swapped) => this.bots.spawns.setSideSwap(swapped),
    });
    this.bots.respawnPolicy = {
      allowed: (id) => this.flow.respawnAllowed(id),
      noted: (id) => this.flow.noteRespawn(id),
    };

    this.unsubscribe.push(
      this.bus.on(EV.MatchEnded, () => {
        this.result = this.flow.result;
      }),
    );

    this.populate();
    // The flow starts in WARMUP and does not run its clock until told. The browser does this
    // on entering the MATCH state; here there is no state machine above us.
    this.flow.start();
  }

  /** True once the mode has declared a winner. The loop's stop condition. */
  get isOver(): boolean {
    return this.flow.isOver;
  }

  get tickCount(): number {
    return this.ticks;
  }

  /**
   * One simulation tick.
   *
   * The whole authoritative match in four calls, and every one of them is a module the
   * browser runs too. `BotDirector.simulate` is where bot brains produce `InputCommand`s and
   * feed them through the same `PlayerController.step` a remote human's commands will enter
   * at M10 — the symmetry S4.15 is built on.
   */
  step(tickIndex: number): void {
    // `sampledAtMs` is instrumentation only and no simulation reads it; ticks are the clock.
    this.bots.simulate(tickIndex, tickIndex * DT * 1000);
    this.flow.simulate(tickIndex);
    this.ticks++;
  }

  /** The outcome, or null while the match is still running. */
  outcome(): ServerMatchResult | null {
    const r = this.result;
    if (r === null) return null;
    return {
      mapId: this.mapEntry.id,
      modeId: this.modeEntry.id,
      winner: r.winner,
      reason: r.reason,
      scoreA: r.scoreA,
      scoreB: r.scoreB,
      roundsA: r.roundsA,
      roundsB: r.roundsB,
      simSeconds: Math.round(this.ticks * DT * 10) / 10,
      ticks: this.ticks,
    };
  }

  /**
   * Per-tier hit rate, for the S8 criterion-8 comparison against the M3 numbers.
   *
   * `BotDirector.report()` is the M3 reporter, unchanged and shared — which is the point of
   * the comparison. If the headless numbers differed from the browser's, it would be because
   * the *simulation* differed, not because two reporters counted differently.
   */
  report(): ReturnType<BotDirector['report']> {
    return this.bots.report();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.flow.dispose();
    this.score.dispose();
    this.bots.dispose();
  }

  // -- internals ------------------------------------------------------------

  private populate(): void {
    const total = this.modeEntry.rosterSize ?? this.options.bots;
    const teamB = Math.ceil(total / 2);
    const teamA = total - teamB;
    const mix: readonly BotTier[] =
      this.options.tier === 'MIX' ? this.mapEntry.tierMix : [this.options.tier];
    this.bots.populate(teamA, teamB, mix);
    for (const bot of this.bots.bots) this.score.register(bot.entityId, bot.displayName, bot.team);
    log.info(
      `${this.modeEntry.name} on ${this.mapEntry.name}: ${teamA} vs ${teamB} bots, seed ${this.options.seed}.`,
    );
  }
}

/**
 * The side the empty player seat nominally belongs to.
 *
 * It has no gameplay consequence — the spectator never participates — but the roster wants a
 * team and `MatchFlow` wants a local one.
 */
const PLAYER_TEAM: BotTeam = 'A';

function asModeId(id: string): Parameters<typeof findMode>[0] {
  return id as Parameters<typeof findMode>[0];
}
