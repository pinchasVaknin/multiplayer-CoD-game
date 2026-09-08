import type { DamageSystem } from '../combat/DamageSystem';
import { logger } from '../core/Log';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { Rng } from '../core/Rng';
import type { HealthConfig } from '../player/Health';
import type { MovementConfig } from '../player/MovementConfig';
import type { ViewmodelConfig } from '../weapons/ViewmodelConfig';
import type { WeaponDef } from '../weapons/WeaponDefs';
import type { CollisionWorld } from '../world/CollisionWorld';
import {
  bakeNavmesh,
  NAV_DEFAULT_LAYERS,
  samplePatrolCells,
  type NavBakeOptions,
  type NavGrid,
} from '../world/Navmesh';
import type { MapDef } from '../world/maps/types';
import { AiScheduler, type SchedulerConfig } from './AiScheduler';
import { Bot } from './Bot';
import { drawBotWeapon } from './BotArsenal';
import { cloneWeaponDef, requireWeapon } from '../weapons/WeaponDefs';
import type { BrainDeps } from './BotBrain';
import type { BotTeam, Combatant } from './Combatant';
import { CoverIndex } from './Cover';
import type { ObjectiveProvider } from './ObjectiveIntent';
import { BOT_TIERS, type BotTier, type PerceptionConfig, type TierTable } from './DifficultyTiers';
import { NoiseKind, Perception } from './Perception';
import { Pathfinder } from './Pathing';
import { dealTiers } from './RosterDeal';
import { hitsFrom, shotsFrom } from '../combat/ShotAccounting';
import { makeSpawnChoice, SpawnSelector, type SpawnChoice } from './SpawnSelector';
import { simCos } from '../core/SimMath';

const log = logger('BotDirector');

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

/**
 * How many bots one match may ever create, including mid-match replacements.
 *
 * Entity ids go on the wire as a byte and 255 is the `NO_ENTITY` sentinel, so ids must stay
 * under it. `BOT_ID_BASE + 150` is 250, which leaves the sentinel alone and is an order of
 * magnitude past what a real match reaches. `addOne` refuses past it rather than wrapping,
 * because a wrapped id is a body that inherits another's rig history and, on every client,
 * its mesh.
 */
const MAX_BOT_INDEX = 150;

/**
 * Seconds between dying and coming back. Comfortably longer than the fall animation.
 *
 * Exported from M10: a networked human respawns on the server, and it must be the *same*
 * number a bot uses or the two halves of the roster come back on different clocks. This is
 * S3's "config is shared and singular" applied to the one timer that used to be private
 * because only bots could die on a server.
 */
export const RESPAWN_SECONDS = 4.5;

/** Navmesh resolution, metres. S6.5 asks for ~0.5. */
const NAV_CELL = 0.5;

/** Spacing of sampled patrol destinations, metres. */
const PATROL_SPACING = 7;

/**
 * M8. How far a bot will deliberately step off, on a map that bakes climb links.
 *
 * 2.8 m is a container roof to the yard, which is the descent Depot's whole vertical
 * vocabulary needs. It is deliberately under Foundry's 4 m catwalk: that edge stays
 * unlinked, so the M4 rule that bots do not walk off the deck survives untouched.
 */
const NAV_DROP_HEIGHT = 2.8;

/**
 * The bake options a map is navmeshed with (M11, S4.19).
 *
 * Lifted out of `BotDirector`'s constructor so that the boot-time bake and any local bake
 * produce the **same graph**. A second copy of this option list is the kind of drift that
 * would present as bots pathing correctly in warmup and walking into walls in a live match,
 * with nothing in either code path looking wrong.
 */
export function navBakeOptionsFor(mapDef: MapDef, movement: MovementConfig): NavBakeOptions {
  return {
    cellSize: NAV_CELL,
    capsuleRadius: movement.capsuleRadius,
    standHeight: movement.standHeight,
    stepHeight: movement.stepHeight,
    // Ground snap is what a bot can walk down without it reading as a fall.
    maxDrop: movement.groundSnapDist,
    // M8. Opt-in per map, and the two halves arrive together: the same ledge window `Mantle`
    // uses for climbing up, and a bounded step-off for coming back down. A map that does not
    // ask for them bakes exactly the graph M3 baked.
    mantleHeight: mapDef.navClimb === true ? movement.mantleMaxHeight : 0,
    dropHeight: mapDef.navClimb === true ? NAV_DROP_HEIGHT : 0,
    minGroundY: simCos(movement.maxSlopeDeg * (Math.PI / 180)),
    seeds: mapDef.spawns.map((s) => s.position),
    layers: mapDef.navLayers ?? NAV_DEFAULT_LAYERS,
  };
}

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
  /**
   * A navmesh baked elsewhere, or undefined to bake one here (M11, S4.19).
   *
   * The bake is the expensive half of building a match — it is a flood fill over every cell of
   * the map — and S4.19 requires it to happen once at server boot rather than on the path a
   * player experiences as a seamless transition.
   *
   * A `NavGrid` is safe to share: every array on it is `readonly` and filled during the bake,
   * and the two things that search it — `Pathfinder` and `SpawnSelector` — allocate their own
   * per-instance scratch rather than writing back into the grid. The mutable half of the AI's
   * spatial state is the **cover reservations**, and `CoverIndex` is constructed per director
   * below, so two instances never contend for the same piece of cover.
   *
   * Undefined keeps M3's behaviour exactly, which is what the browser and the single-player
   * path still want: one match, one bake, nothing to cache it in.
   */
  readonly nav?: NavGrid;
  /**
   * Issue every bot this weapon instead of drawing from its tier's pool. Harness only.
   *
   * Playtest round 5 B5 asks for a run *"with a roster forced to shotguns"*, and a statistic
   * about pellets measured on a roster that is one shotgun in eight is a statistic about
   * carbines. It changes no balance number: `drawBotWeapon` already returns any of these, and
   * this only removes the draw. Undefined everywhere but `--bot-weapon`.
   */
  readonly botWeaponId?: string;
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
  /** M8. Surfaces per column this map baked. */
  layers: number;
  /** M8. Of `links`, how many need a mantle. The Depot verticality number. */
  climbLinks: number;
  /** M8. `walkable` as a fraction of the columns inside `navBounds`, 0..1. */
  coverage: number;
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
  private ffa = false;

  /**
   * Free-for-All (M7). Propagated to perception and spawn safety, which are the two systems
   * that decide who counts as an enemy.
   */
  get freeForAll(): boolean {
    return this.ffa;
  }

  set freeForAll(on: boolean) {
    this.ffa = on;
    this.perception.freeForAll = on;
    this.spawns.freeForAll = on;
  }

  /**
   * Multiplier on every tier's `pushAggression` for this match (M7).
   *
   * Search & Destroy sets it to 0.35: with one life, running at somebody is a losing move,
   * and the brief asks for the FSM's push aggression to "drop sharply". A scale rather than a
   * second tier table, so a Veteran in S&D is the same Veteran playing more carefully.
   */
  pushAggressionScale = 1;

  /**
   * Nobody moves or shoots (post-M8 playtest).
   *
   * Set by `Match` for the duration of the 3-2-1 and the between-rounds hold. Bots keep
   * *thinking* — perception, the tactical decision and pathing all still run, so the moment
   * the round goes live they act on a world they have been watching rather than waking up
   * blind — but `Bot.advance` neuters the movement axes and the trigger before the command
   * reaches the controller. Freezing only the human would be worse than not freezing at all.
   */
  inputFrozen = false;

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
  private readonly byId = new Map<number, Bot>();
  private readonly rng: Rng;
  private readonly choice: SpawnChoice = makeSpawnChoice();
  private readonly unsubscribe: Array<() => void> = [];
  private tick = 0;

  /**
   * The next bot index to mint. Monotonic within a match; reset only by `populate`.
   *
   * Deliberately **not** derived from `bots.length`, which falls when `removeOne` takes a bot off
   * for a joining human — deriving from it would hand the next bot an id somebody is still using,
   * inheriting another body's rig history, its cover reservation, and on every client its mesh
   * and its interpolation buffer.
   */
  private nextIndex = 0;

  constructor(deps: BotDirectorDeps) {
    this.deps = deps;
    this.rng = new Rng(deps.seed);

    this.nav =
      deps.nav ??
      bakeNavmesh(deps.world, deps.mapDef.navBounds, navBakeOptionsFor(deps.mapDef, deps.movement));

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
      layers: this.nav.layers,
      climbLinks: this.nav.stats.climbLinks,
      // Against *columns*, not nodes: a map whose upper layers are mostly empty air would
      // otherwise report a coverage that fell as it gained levels, which is backwards.
      coverage: this.nav.columnCount > 0 ? this.nav.stats.walkable / this.nav.columnCount : 0,
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
   * Build the roster.
   *
   * `teamA` and `teamB` are bot counts, not body counts — a side is short a bot exactly when
   * something else holds that seat, which in a solo match is the player.
   *
   * **The two sides are dealt from `RosterDeal.dealTiers`, not from a cursor** (playtest round
   * 5, B4). This used to be one cursor that filled team A to completion and then started team
   * B, which made a tier's side a pure function of its index in `tierMix`: Foundry puts
   * `VETERAN` at index 4 and a solo 5v5 deals four bots to A, so it was team B's first bot in
   * every match ever played. `dealTiers` reads the mix from the same place for both sides and
   * gives the short side the stronger half; see that file for the decision and for why a
   * seed-varied deal would have fixed nothing in solo.
   *
   * **Each bot draws its own weapon** (M7 hotfix). Until M7 they all shared one def cloned
   * from the player's primary, so picking a sniper in Create-a-Class armed the entire map
   * with snipers. `drawBotWeapon` draws per tier from the director's seeded `Rng`, so the
   * roster is varied, reproducible, and completely independent of the player's class.
   */
  populate(teamA: number, teamB: number, tierMix: readonly BotTier[]): void {
    this.clear();
    this.nextIndex = 0;
    const deal = dealTiers(teamA, teamB, tierMix);
    for (const tier of deal.a) this.createBot('A', tier);
    for (const tier of deal.b) this.createBot('B', tier);
  }

  /** The tiers on one side, in creation order. The roster's own answer to "what is this side". */
  tiersOn(team: BotTeam): BotTier[] {
    const out: BotTier[] = [];
    for (const bot of this.bots) if (bot.team === team) out.push(bot.tierName);
    return out;
  }

  /**
   * Mint one more bot mid-match — the inverse of `removeOne`, for a player leaving.
   *
   * Null past `MAX_BOT_INDEX` rather than wrapping. A caller that gets null has a side one body
   * down, which is a visible imbalance; a wrapped id is two bodies on one entity, which is not.
   */
  addOne(team: BotTeam, tier: BotTier): Bot | null {
    if (this.nextIndex >= MAX_BOT_INDEX) return null;
    return this.createBot(team, tier);
  }

  /**
   * Take one bot off `team` to make room for a human, newest first. Null if that side has none.
   *
   * Releases everything a bot holds **in `shared/`** — roster slot, id map, `DamageSystem`
   * registration, cover reservation. It cannot release the one thing the bot holds in `server/`,
   * its `Rewind` history, because this package is forbidden to import a server-only structure —
   * so route removal through `ServerMatch.removeBotForSeat`, never this directly.
   */
  removeOne(team: BotTeam): Bot | null {
    for (let i = this.bots.length - 1; i >= 0; i--) {
      const bot = this.bots[i];
      if (bot === undefined || bot.team !== team) continue;
      this.bots.splice(i, 1);
      const at = this.roster.indexOf(bot);
      if (at >= 0) this.roster.splice(at, 1);
      this.byId.delete(bot.entityId);
      this.deps.damage.unregister(bot.entityId);
      this.cover.release(bot.entityId);
      return bot;
    }
    return null;
  }

  /**
   * One bot, built and seated. The body of the old inline `populate` loop, extracted.
   *
   * The id comes from `nextIndex` and nothing else, and incrementing it here is what makes that
   * true on every path — `populate` and `addOne` mint through the same three lines.
   */
  private createBot(team: BotTeam, tier: BotTier): Bot {
    const index = this.nextIndex;
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
        weaponDef:
          this.deps.botWeaponId === undefined
            ? drawBotWeapon(tier, this.rng)
            : cloneWeaponDef(requireWeapon(this.deps.botWeaponId)),
        viewmodelConfig: this.deps.viewmodelConfig,
        tiers: this.deps.tiers,
        perceptionConfig: this.deps.perceptionConfig,
        brain: this.brainDeps,
      },
    );
    this.bots.push(bot);
    this.roster.push(bot);
    this.byId.set(bot.entityId, bot);
    this.deps.damage.register(bot);
    this.spawnBot(bot);
    this.nextIndex++;
    return bot;
  }

  clear(): void {
    for (const bot of this.bots) {
      this.deps.damage.unregister(bot.entityId);
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
      bot.advance(tick, nowMs, bots, this.inputFrozen);
    }

    scheduler.runPathBudget(this.pathfinder);
    scheduler.endTick();
  }

  /** Pick a spawn for anybody on `team`, including the player. Never fails. */
  selectSpawn(team: BotTeam, selfId: number, out: SpawnChoice): boolean {
    return this.spawns.select(team, this.roster, selfId, this.tick, out);
  }

  /**
   * Put every bot back on a spawn, alive, whatever state they were in (post-M8 playtest).
   *
   * The start of a Search & Destroy round, and nothing else. It deliberately bypasses the
   * respawn gate rather than asking it: with `livesPerRound = 1` the gate's answer is
   * permanently "no", which is correct for a *death* mid-round and exactly wrong for the
   * round boundary — a round that could not put its players back would be a round nobody can
   * play. That is the same reason the very first spawn of a match is not gated either.
   *
   * Living bots are respawned too, not just dead ones. "Hard reset to the original spawn
   * points" is the requirement, and a survivor left standing where the last round ended is
   * the half of it that would still be broken.
   */
  respawnAll(): void {
    for (const bot of this.bots) this.spawnBot(bot);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.clear();
  }

  // -- internals ------------------------------------------------------------

  private spawnBot(bot: Bot): void {
    if (!this.selectSpawn(bot.team, bot.entityId, this.choice)) {
      log.warn(`no spawn candidate for team ${bot.team}; navmesh may be empty.`);
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
        // Rays, not pulls, and both halves from this one event (round 5, B5). The acceptance
        // hit-rate per tier is this divided by itself, so it was a shotgun bot away from
        // reading over 100% — see `combat/ShotAccounting`.
        const shooter = this.byId.get(p.sourceId);
        if (shooter !== undefined) {
          shooter.shotsFired += shotsFrom(p);
          shooter.shotsHit += hitsFrom(p);
        }
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
        // Damage only: a bot's frag is not a round it fired. Counted here it made the tier
        // hit-rate a number about grenades.
        if (shooter !== undefined) shooter.damageDealt += p.amount;
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
    // Anyone else on the roster: the local player seat, and from M10 every connected human.
    // Resolving through the roster rather than naming `deps.player` is what makes a remote
    // player's footsteps audible to bots on the right side — before this, a human other than
    // seat zero made noise attributed to 'NONE' and both teams heard it as neutral.
    const other = this.combatant(entityId);
    if (other !== undefined) return other.team;
    return 'NONE';
  }

  // -- reporting ------------------------------------------------------------

  /** Everything acceptance criteria 3, 5 and 6 ask for, in one object. */
  report(): BotReport {
    this.scheduler.recompute();
    /**
     * Both tables come off one pass, and the per-team one is playtest round 5's B4.
     *
     * "REGULAR bots went 40-38" is a number that cannot answer the question B4 asked, which was
     * never about a tier — it was about a *side*. A tier that is only ever dealt to one team
     * looks perfectly ordinary in a table with no team column, which is how a VETERAN going
     * 36-5 for the opposition reads as balance rather than as a deal.
     */
    const perTier: Record<string, TierReport> = {};
    const perTeamTier: Record<BotTeam, Record<string, TierReport>> = { A: {}, B: {} };
    for (const tier of BOT_TIERS) {
      const both = emptyTierReport();
      const sides: Record<BotTeam, TierReport> = { A: emptyTierReport(), B: emptyTierReport() };
      for (const bot of this.bots) {
        if (bot.tierName !== tier) continue;
        for (const into of [both, sides[bot.team]]) {
          into.bots++;
          into.shotsFired += bot.shotsFired;
          into.shotsHit += bot.shotsHit;
          into.kills += bot.kills;
          into.deaths += bot.deaths;
        }
      }
      if (both.bots === 0) continue;
      both.hitRate = both.shotsFired > 0 ? both.shotsHit / both.shotsFired : 0;
      perTier[tier] = both;
      for (const team of ['A', 'B'] as const) {
        const side = sides[team];
        if (side.bots === 0) continue;
        side.hitRate = side.shotsFired > 0 ? side.shotsHit / side.shotsFired : 0;
        perTeamTier[team][tier] = side;
      }
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
      perTeamTier,
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

function emptyTierReport(): TierReport {
  return { bots: 0, shotsFired: 0, shotsHit: 0, hitRate: 0, kills: 0, deaths: 0 };
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
  /** The same tally, split by side (playtest round 5, B4). A tier absent from a side is absent. */
  perTeamTier: Record<BotTeam, Record<string, TierReport>>;
  stuckEvents: number;
  pathFailures: number;
}
