import { DEFAULT_SCHEDULER, type SchedulerConfig } from '../shared/ai/AiScheduler';
import { BOT_ID_BASE, BotDirector, RESPAWN_SECONDS } from '../shared/ai/BotDirector';
import type { BotTeam, Combatant } from '../shared/ai/Combatant';
import { makeSpawnChoice, type SpawnChoice } from '../shared/ai/SpawnSelector';
import { AR_DEFAULT, PISTOL_DEFAULT } from '../shared/weapons/WeaponDefs';
import { EventCollector } from './net/EventCollector';
import { Rewind } from './net/Rewind';
import { NetPlayer } from './NetPlayer';
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
import { MAX_PLAYERS } from '../shared/net/Protocol';
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

  /**
   * Connected humans (M10, S6.2).
   *
   * They sit alongside `bots.bots` rather than inside it, because a `NetPlayer` is driven by
   * an `InputBuffer` and a `Bot` by a `BotBrain` — but both are pushed into `bots.roster`, so
   * every system written against `Combatant` (perception, spawn safety, cover scoring) treats
   * them identically and none of it knows the difference.
   */
  readonly players: NetPlayer[] = [];

  /** Lag compensation (S4.13). Every damageable body registers its rig history here. */
  readonly rewind = new Rewind();

  /** Events produced this tick, for replication to every client (S4.15). */
  readonly outgoing = new EventCollector();

  private readonly spectator: Spectator;
  private readonly unsubscribe: Array<() => void> = [];
  private result: MatchResult | null = null;
  private ticks = 0;
  private readonly spawnChoice: SpawnChoice = makeSpawnChoice();
  private nextPlayerId = HUMAN_ID_BASE;

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

    /**
     * Death and flinch for connected humans (M10).
     *
     * `BotDirector` already does this for bots, keyed off its own `byId` map, and a human is
     * deliberately not in that map — it holds `Bot`s and a `NetPlayer` is not one. So the
     * same two events are handled here for the human half of the roster. The alternative,
     * making `BotDirector` aware of `NetPlayer`, would put a networking type into `shared/ai`
     * and break the partition for no gain.
     */
    this.unsubscribe.push(
      this.bus.on(EV.EntityKilled, (p) => {
        const victim = this.getPlayer(p.targetId);
        if (victim === undefined) return;
        const source = this.combatantAt(p.sourceId);
        const dx = source === undefined ? 0 : victim.px - source.px;
        const dz = source === undefined ? 1 : victim.pz - source.pz;
        victim.onKilled(dx, dz, RESPAWN_SECONDS);
      }),
    );

    this.unsubscribe.push(
      this.bus.on(EV.DamageDealt, (p) => {
        const shooter = this.getPlayer(p.sourceId);
        if (shooter !== undefined) shooter.shotsHit++;
        if (p.lethal) return;
        const victim = this.getPlayer(p.targetId);
        if (victim === undefined) return;
        const source = this.combatantAt(p.sourceId);
        const fromX = source?.px ?? p.x;
        const fromZ = source?.pz ?? p.z;
        victim.onHurt(p.x - fromX, p.z - fromZ);
      }),
    );

    this.unsubscribe.push(
      this.bus.on(EV.WeaponFired, (p) => {
        const shooter = this.getPlayer(p.sourceId);
        if (shooter !== undefined) shooter.shotsFired++;
      }),
    );

    // The replicated event stream. Subscribed here so it sees the authoritative bus and
    // nothing else — a client's own presentation bus is a different object entirely.
    for (const off of this.outgoing.subscribe(this.bus)) this.unsubscribe.push(off);

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
    this.outgoing.begin();

    // Humans first, then bots. The order matters for exactly one reason and it is worth
    // stating: a bot's perception reads combatant poses, so stepping humans first means bots
    // react to where the humans are *this* tick rather than last. The reverse would give
    // every human one tick of free reaction time over every bot, forever.
    for (const player of this.players) this.stepPlayer(player, tickIndex);

    // `sampledAtMs` is instrumentation only and no simulation reads it; ticks are the clock.
    this.bots.simulate(tickIndex, tickIndex * DT * 1000);
    this.flow.simulate(tickIndex);

    for (const player of this.players) this.maybeRespawn(player);

    // After everybody has moved, before anything is sent. One call for the whole roster, so
    // there is no route by which an entity is stepped and not recorded — a hole in the
    // history is a rewind that silently resolves against the present.
    this.rewind.record(tickIndex);

    this.ticks++;
  }

  /**
   * One human's tick, with lag compensation wrapped around the weapon (S4.13).
   *
   * The rewind brackets `NetPlayer.step` rather than the whole match tick, and only the
   * weapon inside it actually cares — but bracketing the whole call is both simpler and
   * safer than trying to predict whether this tick will fire. The cost is five number writes
   * per other entity, and `Rewind.begin` returns immediately when the applied rewind is zero
   * ticks, so the zero-latency path does no work at all and is provably identical to
   * single-player.
   */
  private stepPlayer(player: NetPlayer, tickIndex: number): void {
    const lagMs = this.viewLag(player.entityId);
    this.rewind.begin(player.entityId, tickIndex, lagMs);
    try {
      player.step(tickIndex, this.inputFrozen);
    } finally {
      // `finally` because a restore that is skipped leaves every rig in the past permanently,
      // and the next shot by anybody resolves against a world a fifth of a second stale.
      this.rewind.end();
    }
  }

  /**
   * The pre-match countdown and the post-round pause, exactly as the client computes them.
   *
   * Duplicated as a getter rather than shared because it is three tokens of logic over
   * `flow.currentPhase`, and the alternative — a `MatchFlow` method — would put a *policy*
   * decision ("shooting is not allowed yet") inside a class that owns the *clock*. Both
   * halves read the same phase from the same shared `MatchFlow`, which is what matters.
   */
  get inputFrozen(): boolean {
    const phase = this.flow.currentPhase;
    return phase === 'WARMUP' || phase === 'ROUND_END';
  }

  /**
   * How far in the past a given player was looking, in ms. Installed by the server.
   *
   * A hook rather than a direct dependency on `Session`, because the match is the *simulation*
   * and knows nothing about sockets. It asks a question — "how stale is this player's view" —
   * and the networking layer answers it. Unset, every player is treated as having a perfect
   * link, which is exactly right for the headless bot-only harness.
   */
  viewLagMsFor: ((entityId: number) => number) | null = null;

  /** Diagnostic (S8.6): resolve every shot against the present. See `ServerConfig`. */
  rewindDisabled = false;

  private viewLag(entityId: number): number {
    if (this.rewindDisabled) return 0;
    return this.viewLagMsFor === null ? 0 : this.viewLagMsFor(entityId);
  }

  // -- connected humans (M10) -------------------------------------------------

  /**
   * Seat a newly connected client, or return null when the match is full.
   *
   * The new player is put on the **smaller** side, counting bots as well as humans, so a
   * match that started 5v5 and gains two people does not end up 7v5. S9 puts team selection
   * in M11's lobby; until then, balance is the only sensible policy and it is one line.
   */
  addPlayer(displayName: string): NetPlayer | null {
    if (this.players.length >= MAX_PLAYERS) return null;

    const team = this.smallerTeam();
    const entityId = this.nextPlayerId++;
    if (entityId >= BOT_ID_FLOOR) {
      // Entity ids 1..99 are the human range; bots start at 100. Ten seats and a fresh id per
      // join means this is unreachable inside any real match length, but a wrapped id would
      // collide with a bot and put two bodies on one entity.
      this.nextPlayerId--;
      return null;
    }

    const player = new NetPlayer(entityId, displayName, team, {
      world: this.world,
      bus: this.bus,
      damage: this.damage,
      movement: this.movementConfig,
      healthConfig: this.healthConfig,
      viewmodelConfig: this.viewmodelConfig,
      // The default loadout. S9 puts Create-a-Class over the network in M11; this milestone
      // is "two people shooting at each other correctly", and that needs one rifle each.
      weaponDef: AR_DEFAULT,
      secondaryDef: PISTOL_DEFAULT,
    });

    this.players.push(player);
    this.damage.register(player);
    this.bots.roster.push(player);
    this.rewind.register(player);
    this.score.register(entityId, displayName, team);

    this.spawnPlayer(player);
    log.info(`${displayName} seated as entity ${entityId} on team ${team}.`);
    return player;
  }

  /**
   * Remove a disconnected client (S6.1, S8.11).
   *
   * *"A dropped client must not stall the server tick or leave a ghost entity in the world."*
   * Every registration made in `addPlayer` is undone here, in the same order, and the entity
   * simply stops appearing in snapshots — which the encoder turns into an explicit removal
   * for every client, so nobody is left rendering a body that is not there.
   */
  removePlayer(entityId: number): void {
    const at = this.players.findIndex((p) => p.entityId === entityId);
    if (at < 0) return;
    const player = this.players[at];
    if (player === undefined) return;

    this.players.splice(at, 1);
    this.damage.unregister(entityId);
    this.rewind.unregister(entityId);
    const rosterAt = this.bots.roster.indexOf(player);
    if (rosterAt >= 0) this.bots.roster.splice(rosterAt, 1);

    // The **scoreboard row stays**, deliberately. A leaver's kills already counted toward
    // their team's score, and TDM is won on team score — retracting the row on disconnect
    // would rewrite the result of a match that is still being played. The *entity* is gone
    // from the world, which is what S8.11 asks for; the record of what they did is not.
    log.info(`entity ${entityId} (${player.displayName}) left the match.`);
  }

  getPlayer(entityId: number): NetPlayer | undefined {
    return this.players.find((p) => p.entityId === entityId);
  }

  /**
   * Anybody on the roster by id — bot, human or the spectator seat.
   *
   * Used to find where a killing round came from, so a death or a flinch leans the right
   * way. The roster is the union of both halves, which is exactly why bots and humans were
   * put in one array.
   */
  private combatantAt(entityId: number): Combatant | undefined {
    for (const c of this.bots.roster) if (c.entityId === entityId) return c;
    return undefined;
  }

  /** Side with fewer participants, counting bots. Ties go to A. */
  private smallerTeam(): BotTeam {
    let a = 0;
    let b = 0;
    for (const c of this.bots.roster) {
      if (c === this.spectator) continue;
      if (c.team === 'A') a++;
      else b++;
    }
    return a <= b ? 'A' : 'B';
  }

  private spawnPlayer(player: NetPlayer): void {
    if (!this.bots.selectSpawn(player.team, player.entityId, this.spawnChoice)) {
      // `selectSpawn` is documented never to fail, and if that ever stops being true the
      // honest response is to leave the player where they are rather than drop them at the
      // world origin inside a wall.
      log.warn(`no spawn available for entity ${player.entityId}.`);
      return;
    }
    const c = this.spawnChoice;
    player.spawn(c.x, c.y, c.z, c.yaw);
    // Backfill the whole history with the spawn pose, so a shot rewound into the window
    // before this player existed cannot resolve against a stale or origin rig.
    this.rewind.resetAt(player.entityId, this.ticks);
  }

  /** Bring a dead player back once their timer and the mode's gate both allow it. */
  private maybeRespawn(player: NetPlayer): void {
    if (player.alive || player.respawnTimer > 0) return;
    if (!this.flow.respawnAllowed(player.entityId)) return;
    this.flow.noteRespawn(player.entityId);
    this.spawnPlayer(player);
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
    for (const bot of this.bots.bots) {
      this.score.register(bot.entityId, bot.displayName, bot.team);
      // Bots are rewound too (S4.13: *"rewinds every other entity"*). A bot strafing across
      // a doorway is exactly the target the half-metre error in S4.13 was measured against,
      // and leaving them out would make hit registration correct against humans and broken
      // against the eight other bodies in the match.
      this.rewind.register(bot);
    }
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

/**
 * Entity ids for connected humans.
 *
 * The id space was fixed by M3 and this fits inside it rather than changing it: 0 is the
 * local-player seat (here, the spectator), M2's range dummies sit in the low numbers, and
 * `BOT_ID_BASE` is 100. Humans take 1..99, which is ten times the seat count and leaves the
 * bot range untouched.
 */
const HUMAN_ID_BASE = 1;

/** First id belonging to a bot. A human id must never reach it. */
const BOT_ID_FLOOR = BOT_ID_BASE;

function asModeId(id: string): Parameters<typeof findMode>[0] {
  return id as Parameters<typeof findMode>[0];
}
