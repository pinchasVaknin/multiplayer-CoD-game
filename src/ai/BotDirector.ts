import * as THREE from 'three';
import type { DamageSystem } from '../combat/DamageSystem';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { Rng } from '../core/Rng';
import type { HealthConfig } from '../player/Health';
import type { MovementConfig } from '../player/MovementConfig';
import type { ViewmodelConfig } from '../weapons/ViewmodelConfig';
import type { WeaponDef } from '../weapons/WeaponDefs';
import type { CollisionWorld } from '../world/CollisionWorld';
import { bakeNavmesh, samplePatrolCells, type NavGrid } from '../world/Navmesh';
import type { MapDef } from '../world/maps/types';
import { AiScheduler, type SchedulerConfig } from './AiScheduler';
import { Bot } from './Bot';
import { drawBotWeapon } from './BotArsenal';
import type { BrainDeps } from './BotBrain';
import { buildBotMaterials, type BotMaterials } from './BotMesh';
import type { BotTeam, Combatant } from './Combatant';
import { CoverIndex } from './Cover';
import type { ObjectiveProvider } from './ObjectiveIntent';
import { BOT_TIERS, type BotTier, type PerceptionConfig, type TierTable } from './DifficultyTiers';
import { NoiseKind, Perception } from './Perception';
import { Pathfinder } from './Pathing';
import { makeSpawnChoice, SpawnSelector, type SpawnChoice } from './SpawnSelector';

/**
 * Everything that turns a pile of AI classes into a firefight.
 *
 * It owns the structures that are per-*match* rather than per-bot — the navmesh, the cover
 * index, the pathfinder, perception, the spawn selector, the scheduler — and it owns the
 * roster, which is bots *and* the player: they go in the same array because spawn safety
 * and perception have no business knowing which one is human.
 *
 * It is also the only subscriber that translates world events into AI input. Gunfire and
 * footsteps become entries in the noise field; damage becomes a flinch, a threat direction
 * and a reason to look somewhere; a kill becomes a fall in the direction the round was
 * travelling and a respawn timer. Nothing in `ai/` reaches out for any of that — it arrives.
 *
 * Entity ids start at `BOT_ID_BASE` so they can never collide with the player (0) or M2's
 * range dummies (1-6).
 */

export const BOT_ID_BASE = 100;

/** Seconds between dying and coming back. Comfortably longer than the fall animation. */
const RESPAWN_SECONDS = 4.5;

/** Navmesh resolution, metres. S6.5 asks for ~0.5. */
const NAV_CELL = 0.5;

/** Spacing of sampled patrol destinations, metres. */
const PATROL_SPACING = 7;

const NAMES = [
  'VULTURE',
  'RIPTIDE',
  'HALYARD',
  'CINDER',
  'MARLOW',
  'PENNANT',
  'OSPREY',
  'KESTREL',
  'BRAMBLE',
  'DOVETAIL',
  'ANVIL',
  'LATCH',
];

const evBotSpawn = {
  entityId: 0,
  team: 'A' as BotTeam,
  tier: 'REGULAR' as BotTier,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  nearestEnemy: 0,
};

/**
 * Whether somebody may come back, and a note when they do (M4).
 *
 * Implemented by `MatchFlow`. It is the one gate for bots and the player alike, so "no
 * respawns once the match is over" is a single rule rather than two that can drift — and it
 * is what stops a bot respawning behind the post-match summary screen.
 */
export interface RespawnPolicy {
  allowed(entityId: number): boolean;
  noted(entityId: number): void;
}

export interface BotDirectorDeps {
  readonly world: CollisionWorld;
  readonly mapDef: MapDef;
  readonly bus: GameBus;
  readonly damage: DamageSystem;
  readonly movement: MovementConfig;
  readonly healthConfig: HealthConfig;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly tiers: TierTable;
  readonly perceptionConfig: PerceptionConfig;
  readonly scheduler: SchedulerConfig;
  /** The local player, so perception and spawn safety see it like anything else. */
  readonly player: Combatant;
  readonly seed: number;
}

export interface NavStats {
  cells: number;
  walkable: number;
  pruned: number;
  links: number;
  /** Columns carrying two walkable surfaces. Non-zero means the map is multi-level. */
  stacked: number;
  bakeMs: number;
  patrolPoints: number;
  coverPoints: number;
  coverRejected: number;
  spawnCandidates: number;
}

export class BotDirector {
  /**
   * Set by `Match` once the mode exists. Null means "always allowed", which is what the M3
   * harness and the bot-only soak want: they have no match flow to ask.
   */
  respawnPolicy: RespawnPolicy | null = null;

  /**
   * Whose footsteps never reach the noise field (M6: the Dead Silence perk).
   *
   * Null means "everybody is audible", which is what every M3-M5 measurement was taken
   * against. It is a predicate rather than a set because the answer is a property of a
   * loadout the AI package has no business knowing about — `ai/` asks "can I hear this
   * entity", and `Match` answers.
   */
  silentFootsteps: ((entityId: number) => boolean) | null = null;

  /**
   * What the mode wants bots doing (M7). Null in a mode with no objectives.
   *
   * Set by `Match` once the mode exists. Same inversion as `silentFootsteps`: `ai/` asks a
   * question and something outside it answers, so nothing in this package imports a mode.
   */
  objectives: ObjectiveProvider | null = null;

  /**
   * A second provider, for objectives that are not the mode's (M7).
   *
   * A care package is contestable in *every* mode, including Team Deathmatch, so it cannot be
   * the mode's business. `BotBrain` asks both and takes whichever offers the higher priority,
   * which is what lets a crate pull a bot off a flag it was only casually defending.
   */
  streakObjectives: ObjectiveProvider | null = null;

  /**
   * True when every other combatant is an enemy regardless of side (M7, Free-for-All).
   *
   * FFA keeps the two-team substrate — see `modes/FreeForAll.ts` — and flips this so spawn
   * safety scores against all seven opponents rather than the four on the other side.
   */
  freeForAll = false;

  /**
   * Multiplier on every tier's `pushAggression` for this match (M7).
   *
   * Search & Destroy sets it to 0.35: with one life, running at somebody is a losing move,
   * and the brief asks for the FSM's push aggression to "drop sharply". A scale rather than a
   * second tier table, so a Veteran in S&D is the same Veteran playing more carefully.
   */
  pushAggressionScale = 1;

  readonly group = new THREE.Group();
  readonly nav: NavGrid;
  readonly perception: Perception;
  readonly pathfinder: Pathfinder;
  readonly cover: CoverIndex;
  readonly spawns: SpawnSelector;
  readonly scheduler: AiScheduler;
  readonly bots: Bot[] = [];
  readonly roster: Combatant[] = [];
  readonly navStats: NavStats;

  private readonly deps: BotDirectorDeps;
  private readonly brainDeps: BrainDeps;
  private readonly materials: BotMaterials;
  private readonly byId = new Map<number, Bot>();
  private readonly rng: Rng;
  private readonly choice: SpawnChoice = makeSpawnChoice();
  private readonly unsubscribe: Array<() => void> = [];
  private tick = 0;

  constructor(deps: BotDirectorDeps) {
    this.deps = deps;
    this.group.name = 'bots';
    this.rng = new Rng(deps.seed);
    this.materials = buildBotMaterials();

    this.nav = bakeNavmesh(deps.world, deps.mapDef.navBounds, {
      cellSize: NAV_CELL,
      capsuleRadius: deps.movement.capsuleRadius,
      standHeight: deps.movement.standHeight,
      stepHeight: deps.movement.stepHeight,
      // Ground snap is what a bot can walk down without it reading as a fall.
      maxDrop: deps.movement.groundSnapDist,
      minGroundY: Math.cos(deps.movement.maxSlopeDeg * (Math.PI / 180)),
      seeds: deps.mapDef.spawns.map((s) => s.position),
    });

    const patrolCells = samplePatrolCells(this.nav, PATROL_SPACING);
    this.perception = new Perception(deps.world);
    this.pathfinder = new Pathfinder(this.nav, deps.movement.stepHeight, deps.movement.groundSnapDist);
    this.cover = new CoverIndex(deps.mapDef.coverPoints, this.nav);
    this.spawns = new SpawnSelector(
      deps.mapDef.spawns,
      this.nav,
      this.rng,
      this.perception,
      deps.perceptionConfig,
    );
    this.scheduler = new AiScheduler(deps.scheduler);

    this.brainDeps = {
      nav: this.nav,
      pathfinder: this.pathfinder,
      cover: this.cover,
      perception: this.perception,
      patrolCells,
      objectives: () => this.objectives,
      streakObjectives: () => this.streakObjectives,
      pushScale: () => this.pushAggressionScale,
    };

    this.roster.push(deps.player);

    this.navStats = {
      cells: this.nav.stats.cells,
      walkable: this.nav.stats.walkable,
      pruned: this.nav.stats.pruned,
      links: this.nav.stats.links,
      stacked: this.nav.stats.stacked,
      bakeMs: this.nav.stats.bakeMs,
      patrolPoints: patrolCells.length,
      coverPoints: this.cover.count,
      coverRejected: this.cover.rejected,
      spawnCandidates: this.spawns.candidateCount,
    };

    this.subscribe();
  }

  get botCount(): number {
    return this.bots.length;
  }

  get(entityId: number): Bot | undefined {
    return this.byId.get(entityId);
  }

  /**
   * Build the roster. `teamA` are the player's side, `teamB` the opposition.
   *
   * Tiers are dealt round-robin from `tierMix` so a default match is a spread rather than
   * ten identical opponents; the harness overrides it to measure one tier at a time.
   *
   * **Each bot draws its own weapon** (M7 hotfix). Until M7 they all shared one def cloned
   * from the player's primary, so picking a sniper in Create-a-Class armed the entire map
   * with snipers. `drawBotWeapon` draws per tier from the director's seeded `Rng`, so the
   * roster is varied, reproducible, and completely independent of the player's class.
   */
  populate(teamA: number, teamB: number, tierMix: readonly BotTier[]): void {
    this.clear();
    let index = 0;
    const add = (team: BotTeam, count: number): void => {
      for (let i = 0; i < count; i++) {
        const tier = tierMix[index % Math.max(tierMix.length, 1)] ?? 'REGULAR';
        const bot = new Bot(
          {
            entityId: BOT_ID_BASE + index,
            displayName: NAMES[index % NAMES.length] ?? `BOT ${index}`,
            team,
            tier,
            seed: (this.deps.seed ^ (0x9e37_79b9 * (index + 1))) | 0,
          },
          {
            world: this.deps.world,
            bus: this.deps.bus,
            damage: this.deps.damage,
            movement: this.deps.movement,
            healthConfig: this.deps.healthConfig,
            weaponDef: drawBotWeapon(tier, this.rng),
            viewmodelConfig: this.deps.viewmodelConfig,
            tiers: this.deps.tiers,
            perceptionConfig: this.deps.perceptionConfig,
            brain: this.brainDeps,
            materials: this.materials,
          },
        );
        this.bots.push(bot);
        this.roster.push(bot);
        this.byId.set(bot.entityId, bot);
        this.deps.damage.register(bot);
        this.group.add(bot.mesh.group);
        this.spawnBot(bot);
        index++;
      }
    };
    add('A', teamA);
    add('B', teamB);
  }

  clear(): void {
    for (const bot of this.bots) {
      this.deps.damage.unregister(bot.entityId);
      this.group.remove(bot.mesh.group);
      bot.dispose();
    }
    this.bots.length = 0;
    this.byId.clear();
    this.roster.length = 0;
    this.roster.push(this.deps.player);
    this.cover.releaseAll();
    this.perception.noise.reset();
  }

  setAllTiers(tier: BotTier): void {
    for (const bot of this.bots) bot.tierName = tier;
  }

  /** Live retune from the debug panel. */
  applyHealthConfig(cfg: HealthConfig): void {
    for (const bot of this.bots) bot.health.setConfig(cfg);
  }

  /**
   * Arm every bot with one weapon, overriding the per-tier draw.
   *
   * A measurement lever, not part of normal play. From M7 each bot draws its own weapon
   * (`BotArsenal`), which is right for a match and wrong for a controlled experiment: M3's
   * per-tier hit-rate table only means something if the tiers are holding the same gun.
   * `BotHarness` and the arsenal panel call this to flatten the roster before measuring.
   */
  applyWeaponDef(def: WeaponDef): void {
    for (const bot of this.bots) bot.weapons.setDefinition(def);
  }

  // -- the tick -------------------------------------------------------------

  /**
   * One sim tick for every bot.
   *
   * The order matters: perception, then the tactical decision that reads it, then the path
   * request that reads that, then steering, which runs for every bot every tick. A bot
   * whose decision landed this tick acts on it this tick.
   */
  simulate(tick: number, nowMs: number): void {
    this.tick = tick;
    const bots = this.bots;
    const scheduler = this.scheduler;
    scheduler.beginTick(tick, bots.length);

    const interval = scheduler.perceptionInterval;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      if (bot === undefined) continue;
      bot.beginTick();

      if (!bot.health.alive) {
        const mayReturn = this.respawnPolicy?.allowed(bot.entityId) ?? true;
        if (mayReturn && bot.respawnTimer <= 0 && bot.deadTime > 1.2) this.spawnBot(bot);
        continue;
      }

      if (scheduler.perceptionDue(i)) {
        this.perception.sense(
          bot,
          bot.blackboard,
          this.roster,
          this.deps.perceptionConfig,
          bot.tier,
          bot.rng,
          interval,
        );
      }
      if (scheduler.tacticalDue(i)) bot.brain.decide(bot);
      if (scheduler.pathDue(i)) bot.brain.requestPath(bot);
      bot.advance(tick, nowMs, bots);
    }

    scheduler.runPathBudget(this.pathfinder);
    scheduler.endTick();
  }

  /** Render pass. Visual only: interpolation and the death animation. */
  updateVisuals(alpha: number, dt: number): void {
    for (const bot of this.bots) bot.updateVisual(alpha, dt);
  }

  /** Pick a spawn for anybody on `team`, including the player. Never fails. */
  selectSpawn(team: BotTeam, selfId: number, out: SpawnChoice): boolean {
    return this.spawns.select(team, this.roster, selfId, this.tick, out);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.clear();
    this.materials.dispose();
    this.group.clear();
  }

  // -- internals ------------------------------------------------------------

  private spawnBot(bot: Bot): void {
    if (!this.selectSpawn(bot.team, bot.entityId, this.choice)) {
      console.warn(`[BotDirector] no spawn candidate for team ${bot.team}; navmesh may be empty.`);
      return;
    }
    bot.spawn(this.choice.x, this.choice.y + 0.05, this.choice.z, this.choice.yaw);
    this.respawnPolicy?.noted(bot.entityId);
    evBotSpawn.entityId = bot.entityId;
    evBotSpawn.team = bot.team;
    evBotSpawn.tier = bot.tierName;
    evBotSpawn.x = this.choice.x;
    evBotSpawn.y = this.choice.y;
    evBotSpawn.z = this.choice.z;
    evBotSpawn.yaw = this.choice.yaw;
    evBotSpawn.nearestEnemy = this.choice.nearestEnemy;
    this.deps.bus.emit(EV.BotSpawned, evBotSpawn);
  }

  private subscribe(): void {
    const bus = this.deps.bus;

    // ---- hearing (S6.3) --------------------------------------------------
    this.unsubscribe.push(
      bus.on(EV.WeaponFired, (p) => {
        const shooter = this.byId.get(p.sourceId);
        if (shooter !== undefined) shooter.shotsFired++;
        this.perception.noise.emit(NoiseKind.Gunfire, p.sourceId, this.teamOf(p.sourceId), p.x, p.y, p.z);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.PlayerFootstep, (p) => {
        // Crouch-walking is silent by design: S6.3 gives footsteps a 12 m radius and
        // qualifies it with "non-crouch", which is the whole reason to ever crouch-walk.
        if (p.quiet) return;
        // Dead Silence (M6, S6.4). The step still sounds for the *player* — it is the
        // enemy's hearing that is cut, so the perk is felt by them and not by you.
        if (this.silentFootsteps?.(p.entityId) === true) return;
        this.perception.noise.emit(
          NoiseKind.Footstep,
          p.entityId,
          this.teamOf(p.entityId),
          p.x,
          p.y,
          p.z,
        );
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.PlayerLanded, (p) => {
        if (p.impactSpeed < 4) return;
        this.perception.noise.emit(
          NoiseKind.Landing,
          p.entityId,
          this.teamOf(p.entityId),
          p.x,
          p.y,
          p.z,
        );
      }),
    );

    // ---- damage ----------------------------------------------------------
    this.unsubscribe.push(
      bus.on(EV.DamageDealt, (p) => {
        const shooter = this.byId.get(p.sourceId);
        if (shooter !== undefined) {
          shooter.shotsHit++;
          shooter.damageDealt += p.amount;
        }
        const victim = this.byId.get(p.targetId);
        if (victim === undefined || p.lethal) return;
        const source = this.combatant(p.sourceId);
        const fromX = source?.px ?? p.x;
        const fromZ = source?.pz ?? p.z;
        // Direction the round was travelling, for the flinch.
        const dx = p.x - fromX;
        const dz = p.z - fromZ;
        victim.onHurt(fromX, fromZ, dx, dz, p.amount);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.EntityKilled, (p) => {
        const killer = this.byId.get(p.sourceId);
        if (killer !== undefined) killer.kills++;
        const victim = this.byId.get(p.targetId);
        if (victim === undefined) return;
        const source = this.combatant(p.sourceId);
        const dx = source === undefined ? 0 : victim.px - source.px;
        const dz = source === undefined ? 1 : victim.pz - source.pz;
        victim.onKilled(dx, dz, RESPAWN_SECONDS);
      }),
    );
  }

  private combatant(entityId: number): Combatant | undefined {
    for (const c of this.roster) {
      if (c.entityId === entityId) return c;
    }
    return undefined;
  }

  /**
   * Team of whoever made a noise. Range dummies and anything else unaccounted for get
   * 'NONE', so both sides hear them — which is right: a dummy is not on anybody's side.
   */
  private teamOf(entityId: number): BotTeam | 'NONE' {
    const bot = this.byId.get(entityId);
    if (bot !== undefined) return bot.team;
    if (entityId === this.deps.player.entityId) return this.deps.player.team;
    return 'NONE';
  }

  // -- reporting ------------------------------------------------------------

  /** Everything acceptance criteria 3, 5 and 6 ask for, in one object. */
  report(): BotReport {
    this.scheduler.recompute();
    const perTier: Record<string, TierReport> = {};
    for (const tier of BOT_TIERS) {
      let fired = 0;
      let hit = 0;
      let kills = 0;
      let deaths = 0;
      let bots = 0;
      for (const bot of this.bots) {
        if (bot.tierName !== tier) continue;
        bots++;
        fired += bot.shotsFired;
        hit += bot.shotsHit;
        kills += bot.kills;
        deaths += bot.deaths;
      }
      if (bots === 0) continue;
      perTier[tier] = { bots, shotsFired: fired, shotsHit: hit, hitRate: fired > 0 ? hit / fired : 0, kills, deaths };
    }

    return {
      bots: this.bots.length,
      nav: this.navStats,
      ai: {
        lastMs: this.scheduler.lastMs,
        p50Ms: this.scheduler.p50Ms,
        p99Ms: this.scheduler.p99Ms,
        worstMs: this.scheduler.worstMs,
        meanMs: this.scheduler.meanMs,
        samples: this.scheduler.sampleCount,
      },
      astar: {
        worstNodesPerTick: this.pathfinder.worstNodesPerTick,
        deferred: this.pathfinder.deferredRequests,
        budgetExhaustedTicks: this.pathfinder.budgetExhaustedTicks,
        completed: this.pathfinder.searchesCompleted,
        failed: this.pathfinder.searchesFailed,
      },
      spawns: { ...this.spawns.stats },
      perTier,
      stuckEvents: this.bots.reduce((n, b) => n + b.brain.stuckEvents, 0),
      pathFailures: this.bots.reduce((n, b) => n + b.brain.pathFailures, 0),
    };
  }

  resetCounters(): void {
    this.scheduler.reset();
    this.pathfinder.resetCounters();
    this.spawns.resetStats();
    this.perception.resetStats();
    for (const bot of this.bots) {
      bot.shotsFired = 0;
      bot.shotsHit = 0;
      bot.kills = 0;
      bot.deaths = 0;
      bot.damageDealt = 0;
      bot.brain.stuckEvents = 0;
      bot.brain.pathFailures = 0;
      bot.brain.replans = 0;
    }
  }

  /** Simulated seconds elapsed since the director started. Derived from ticks. */
  get simSeconds(): number {
    return this.tick * DT;
  }

  /** The tick the director last simulated. Read by the spawn visualisation. */
  get currentTick(): number {
    return this.tick;
  }

  /** Sprint speed from the shared movement config, for the lane-timing measurement. */
  get sprintSpeed(): number {
    return this.deps.movement.sprintSpeed;
  }
}

export interface TierReport {
  bots: number;
  shotsFired: number;
  shotsHit: number;
  hitRate: number;
  kills: number;
  deaths: number;
}

export interface BotReport {
  bots: number;
  nav: NavStats;
  ai: {
    lastMs: number;
    p50Ms: number;
    p99Ms: number;
    worstMs: number;
    meanMs: number;
    samples: number;
  };
  astar: {
    worstNodesPerTick: number;
    deferred: number;
    budgetExhaustedTicks: number;
    completed: number;
    failed: number;
  };
  spawns: {
    selections: number;
    safe: number;
    hidden: number;
    leastBad: number;
    coneViolations: number;
    visibleViolations: number;
    minEnemyDistance: number;
  };
  perTier: Record<string, TierReport>;
  stuckEvents: number;
  pathFailures: number;
}
