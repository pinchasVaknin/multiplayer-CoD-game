import { DEFAULT_SCHEDULER, type SchedulerConfig } from '../shared/ai/AiScheduler';
import { BOT_ID_BASE, BotDirector, RESPAWN_SECONDS } from '../shared/ai/BotDirector';
import type { BotTeam, Combatant } from '../shared/ai/Combatant';
import { makeSpawnChoice, type SpawnChoice } from '../shared/ai/SpawnSelector';
import { isObjectiveProvider } from '../shared/ai/ObjectiveIntent';
import { SearchAndDestroy } from '../shared/modes/SearchAndDestroy';
import { Btn, isDown } from '../shared/core/InputCommand';
import { StreakSystem } from '../shared/streaks/StreakSystem';
import { SILENT_PRESENTATION } from '../shared/streaks/StreakPresentation';
import type { StreakEconomyReport } from '../shared/streaks/StreakLedger';
import {
  ALL_STREAK_IDS,
  DEFAULT_STREAK_CONFIG,
  type StreakId,
} from '../shared/streaks/StreakDefs';
import { Rng } from '../shared/core/Rng';
import { EquipmentSystem, makeEquipmentInventory, type EquipmentInventory } from '../shared/equipment/EquipmentSystem';
import { equipmentDef } from '../shared/equipment/EquipmentDefs';
import { LifeStockAudit, type LifeStockReport } from '../shared/equipment/LifeStockAudit';
import { BotThrower, type MutableThrowIntent } from '../shared/equipment/BotThrower';
import { ThrowController } from '../shared/equipment/ThrowController';
import { DEFAULT_EQUIPMENT_CONFIG, type EquipmentConfig } from '../shared/equipment/EquipmentConfig';
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
import type { GameMode, MatchResult, MatchVariant } from '../shared/modes/GameMode';
import { MatchFlow } from '../shared/modes/MatchFlow';
import {
  resolveLoadout,
  type LoadoutSlot,
  type ResolvedLoadout,
} from '../shared/meta/Loadouts';
import { findMap, findMode, type MapEntry, type ModeEntry } from '../shared/modes/ModeRegistry';
import { describePerkState, NO_PERKS, type PerkState } from '../shared/perks/PerkState';
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
import { loadMapCollision, type LoadedCollision } from '../shared/world/MapLoader';
import type { NavGrid } from '../shared/world/Navmesh';
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
 * - **No weapons for a human, no viewmodel, no melee.** Bots draw their own weapons
 *   (`ai/BotArsenal`), and the rest of that list is a local-player presentation system.
 * - **Killstreaks run here and cross the wire as of M11 Gate B** (§8.22). Earned from the
 *   authoritative score, spent through `MsgC.Streak`, replicated per recipient — bodies to
 *   everyone, earn state to their owner, UAV contacts to their team.
 * - **Equipment runs here as of M11 Gate B, and only half of it is replicated** (§8.24). The
 *   authoritative half is complete: bots throw, humans throw from the command their body just
 *   consumed, blasts resolve through the one damage door, and smoke occludes bot LOS — §6.8's
 *   requirement, and one that could only ever have been met here, because the bots whose sight
 *   is blocked live in this process.
 *
 *   What is **not** done is the projectile channel. A client predicts and draws its *own*
 *   grenade correctly — same command, same tick, same trajectory on both sides — but a grenade
 *   thrown by a bot or another player exists on the server, damages people, and is invisible.
 *   Named here rather than left to be found: this is §8.24's first half.
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
  /**
   * The master's absolute tick at construction. Defaults to 0 for the harnesses.
   *
   * The match does not use it as a clock. It exists so everything indexed by absolute tick is
   * stamped correctly **before the first `step`** — players seated during LOADING spawn then, so
   * their rig history is written before `step` has had a chance to say what tick it is.
   */
  readonly startTick?: number;
  /**
   * Collision and navmesh baked at process boot (M11, S4.19), or undefined to bake here.
   *
   * When present, construction does no flood fills at all — it wraps geometry that already
   * exists. That is what makes `LOADING` *"instantiation, not baking"* per S4.18, and it is
   * measured: see the boot report against the allocation time in PLAN.md.
   *
   * Undefined keeps the M9/M10 behaviour, which the batch harnesses still use: they build one
   * match, run it and exit, so a process-level cache would only be a cache with one reader.
   */
  readonly baked?: { readonly collision: LoadedCollision; readonly nav: NavGrid };
  /**
   * Shorten both match clocks, seconds. Harness only — see `ModeDeps.roundSecondsOverride`
   * for why there are two and why they must be shortened together.
   */
  readonly roundSecondsOverride?: number;
  /**
   * Which authored ruleset to run (M11, §6.4). `'SKIRMISH'` puts S&D on its best-of-5.
   * Undefined is `'STANDARD'`, which is what every earlier milestone's harness expects.
   */
  readonly variant?: MatchVariant;
  /**
   * Total combatants, overriding the mode's authored roster size. See `populate`.
   *
   * Distinct from `bots`, which is the *requested* count a mode with no authored size falls
   * back to. This one wins over both.
   */
  readonly rosterOverride?: number;
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

/** One player's grenade hand: what they are holding, and how far the cook has burned. */
interface PlayerHand {
  readonly thrower: ThrowController;
  readonly inventory: EquipmentInventory;
}

export class ServerMatch {
  readonly bus: GameBus = createGameBus();
  readonly world: CollisionWorld;
  readonly damage: DamageSystem;
  readonly score: ScoreSystem;
  readonly mode: GameMode;
  readonly flow: MatchFlow;
  readonly bots: BotDirector;
  /** The six killstreaks as instance-owned entities (M11 Gate B, §6.8). */
  readonly streaks: StreakSystem;
  /** Grenades and equipment, authoritative (M11 Gate B, §6.8, §8.24). */
  readonly equipment: EquipmentSystem;
  private readonly botThrower: BotThrower;
  private readonly equipmentRng: Rng;
  /** One cursor into the bot list, so one bot is considered per tick. See `stepBotThrows`. */
  private throwCursor = 0;
  /** One grenade hand per connected human. See `handOf`. */
  private readonly hands = new Map<number, PlayerHand>();
  /** What every life started holding (round 4, B3). See `sampleLifeStarts`. */
  private readonly lifeStock = new LifeStockAudit();
  /** Entities spawned this tick, sampled at the end of it. See `sampleLifeStarts`. */
  private readonly pendingLifeStarts: number[] = [];
  private readonly throwIntent: MutableThrowIntent = {
    hasTarget: false,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    sinceSeen: 0,
  };

  readonly mapEntry: MapEntry;
  readonly modeEntry: ModeEntry;

  /** Config objects. Cloned, so a future tuning message cannot mutate the shipped defaults. */
  readonly movementConfig: MovementConfig = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
  readonly healthConfig: HealthConfig = { ...DEFAULT_HEALTH_CONFIG };
  readonly viewmodelConfig: ViewmodelConfig = cloneViewmodelConfig(DEFAULT_VIEWMODEL_CONFIG);
  readonly tiers: TierTable = cloneTierTable(DEFAULT_TIERS);
  readonly perceptionConfig: PerceptionConfig = { ...DEFAULT_PERCEPTION };
  readonly schedulerConfig: SchedulerConfig = { ...DEFAULT_SCHEDULER };
  readonly equipmentConfig: EquipmentConfig = { ...DEFAULT_EQUIPMENT_CONFIG };

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

  /**
   * Each seated human's resolved class, by entity id.
   *
   * Kept alongside the player rather than on it because the consumers take a *predicate over an
   * entity id* — and those are asked about bots too, which have no loadout.
   */
  private readonly loadouts = new Map<number, ResolvedLoadout | null>();

  /**
   * Class changes waiting for their owner's next spawn (M11, §6.6).
   *
   * Separate from `loadouts`, which is what each player is *currently carrying*. Merging them
   * would mean `perksOf` started answering with a class that has not been applied yet — and
   * `perksOf` is what the Dead Silence hook and the streak system read, so they would act on a
   * loadout the player is not yet using.
   */
  private readonly pendingLoadouts = new Map<number, ResolvedLoadout>();

  private readonly spectator: Spectator;
  private readonly unsubscribe: Array<() => void> = [];
  private result: MatchResult | null = null;
  private ticks = 0;

  /**
   * The **absolute** tick this match was last stepped on.
   *
   * Distinct from `ticks`, which counts steps this match has taken. At M10 the one match is
   * created at tick 0 and stepped every tick thereafter, so the two are equal forever and
   * nothing can tell them apart. A flow that creates a match part-way through process uptime
   * makes them disagree permanently, and `Rewind` is indexed by the absolute one.
   */
  private currentTick = 0;
  private readonly spawnChoice: SpawnChoice = makeSpawnChoice();
  private nextPlayerId = HUMAN_ID_BASE;

  constructor(private readonly options: ServerMatchOptions) {
    this.currentTick = options.startTick ?? 0;
    this.mapEntry = findMap(options.mapId);
    this.modeEntry = findMode(asModeId(options.modeId));

    // ---- the world ---------------------------------------------------------
    // Collision and nav only. `client/world/MapRender.ts` holds the half that would have
    // needed a GPU, and this process never imports it.
    //
    // M11: pre-baked when the server passes one (S4.19), so `LOADING` is instantiation rather
    // than two flood fills on the path a player is meant to experience as seamless.
    const loaded = options.baked?.collision ?? loadMapCollision(this.mapEntry.def);
    this.world = loaded.collision;
    log.info(
      `${this.mapEntry.name}: ${loaded.stats.colliders} colliders, ` +
        `${loaded.stats.hashEntries} hash entries across ${loaded.stats.hashCells} cells` +
        (options.baked === undefined ? ' (baked here).' : ' (pre-baked at boot).'),
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
      nav: options.baked?.nav,
    });
    /**
     * Free-for-All, read off the registry rather than compared against the id.
     *
     * That is what `ClientMatch` does, and it is the difference between one fact and two.
     * `friendlyFire` went with it since M7 on the client and was never set here: FFA keeps the
     * two-team substrate internally, so half the roster was hostile, hunted by the AI, and
     * **immune** — `DamageSystem.apply` returned 0 for every shot at them and `Ballistics`
     * skipped their rigs entirely, so rounds passed straight through.
     */
    this.bots.freeForAll = this.modeEntry.freeForAll === true;
    if (this.modeEntry.freeForAll === true) this.damage.friendlyFire = true;

    // ---- the match ---------------------------------------------------------
    this.score = new ScoreSystem(this.bus);
    // The other half of `freeForAll`, and it has to be set here as well as on the director:
    // one flag decides who can be *shot*, the other decides whose death **counts**. See
    // `ScoreSystem.freeForAll` for the FFA ladder that crawled without it.
    this.score.freeForAll = this.modeEntry.freeForAll === true;
    this.mode = this.modeEntry.create({
      bus: this.bus,
      score: this.score,
      roster: this.bots.roster,
      mapDef: this.mapEntry.def,
      roundSecondsOverride: options.roundSecondsOverride,
      variant: options.variant,
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
      // Both clocks or neither. See `ModeDeps.roundSecondsOverride`.
      roundSecondsOverride: options.roundSecondsOverride,
    });
    this.bots.respawnPolicy = {
      allowed: (id) => this.flow.respawnAllowed(id),
      noted: (id) => this.flow.noteRespawn(id),
    };

    /**
     * Hand the bot director the mode's objectives (M11 Gate B, §6.8).
     *
     * **This was missing, and it made three of the five modes unplayable on a dedicated
     * server.** `ClientMatch` has set it since M7; `ServerMatch` never did, so
     * `BotDirector.objectives` was null in every networked match and `ObjectiveIntent` had
     * nothing to ask. Server-side bots therefore pursued no flag, chased no dog tag, and never
     * walked onto the bomb — and since a bot's entire interaction vocabulary is `onArrived`,
     * *no Search & Destroy round played over the network could be decided by a plant*. It read
     * as a mode that was merely quiet: rounds still ended, on elimination and the clock, so
     * nothing crashed and nothing logged.
     *
     * This is the M9 authority migration's standing failure mode. The mode moved to the server
     * and the wiring around it stayed on the client, where it kept working for single-player
     * and proved nothing about the half that had moved.
     */
    this.bots.objectives = isObjectiveProvider(this.mode) ? this.mode : null;
    /**
     * How hard the mode wants bots to push (M7).
     *
     * The other half of the same omission. S&D sets it below 1 so defenders hold sites instead
     * of hunting, and on the server every mode has been running at the default.
     */
    this.bots.pushAggressionScale = this.modeEntry.pushAggressionScale ?? 1;
    /**
     * Every human asks; every bot walks on (post-M8 playtest, generalised at M11 Gate B).
     *
     * `players` is the connected humans and is consulted live rather than snapshotted, because
     * seats are created and released throughout a match — a set captured at construction would
     * be empty, this instance having been built before anybody migrated into it.
     */
    if (this.mode instanceof SearchAndDestroy) {
      this.mode.manualPickup = (entityId) => this.getPlayer(entityId) !== undefined;
    }

    // Dead Silence, server-side. The client half has existed since M6 and decided nothing over
    // the network, because the bots that hear the footsteps live here and this hook was never set.
    this.bots.silentFootsteps = (entityId) => !this.perksOf(entityId).audibleFootsteps;

    /**
     * The six killstreaks, server-side (M11 Gate B, §6.8, §8.22).
     *
     * The header of this file used to read *"No killstreaks yet — `StreakSystem` needs a
     * `StreakPresentation`, and `SILENT_PRESENTATION` is ready for it, but streaks are earned by
     * a player's kill streak and the bot path for that is M11's business."* This is that
     * business. Nothing about `StreakSystem` needed changing to run here beyond the two hooks
     * that assumed a single local player — M9 already took the scene out of `streaks/`, which is
     * what makes a streak a thing that runs in Node at all.
     *
     * §4.15 puts *"killstreak earn, activation, entity state"* on the replicated side of the
     * line, so this is the only copy that decides anything: earning folds over the authoritative
     * score, activation is a client request the server grants, and the sentries and crates in
     * the world are entities here that clients draw.
     *
     * All three M6 perk hooks are answered from `perksOf`, which is the resolved loadout the
     * player migrated in with — the same one Tier 1 #20 is about. Ghost is the interesting one
     * and it is answered *twice*: here, so a Ghost player is never recorded as a UAV contact,
     * and again in `MatchInstance` as a per-recipient intel filter.
     */
    this.streaks = new StreakSystem({
      bus: this.bus,
      score: this.score,
      roster: this.bots.roster,
      // Every connected human, rather than one local player: each gets their own progress and
      // it is replicated to them alone.
      reportProgressTo: (id) => this.getPlayer(id) !== undefined,
      commandFor: (id) => this.getPlayer(id)?.lastCommand ?? null,
      targetable: (id) => this.perksOf(id).targetedByStreaks,
      visibleToUav: (id) => this.perksOf(id).visibleToUav,
      streakDiscount: (id) => this.perksOf(id).streakDiscount,
      // A bot has no class, so it keeps the full list and earns as it always has.
      equippedStreaks: (id) => this.equippedStreaksOf(id),
      context: {
        bus: this.bus,
        world: this.world,
        damage: this.damage,
        bots: this.bots,
        // The port M9 built for exactly this. Every call is correctly a no-op: a bang with
        // nobody to hear it is the client's business, driven by the replicated event.
        present: SILENT_PRESENTATION,
        mapDef: this.mapEntry.def,
        cfg: DEFAULT_STREAK_CONFIG,
        rng: new Rng(options.seed ^ 0x5bd1_e995),
        tiers: this.tiers,
        roster: this.bots.roster,
      },
    });
    // Care packages are contestable in every mode, so they ride the second provider slot rather
    // than the mode's — a crate is worth walking to whether or not there are flags.
    this.bots.streakObjectives = this.streaks;

    /**
     * Grenades and equipment, server-side (M11 Gate B, §6.8, §8.24).
     *
     * The header's *"no equipment thrower"* line was true and was the last of the four systems
     * `ClientMatch` composes that this file did not. Every piece is the shared M5 code driven
     * from a different place: one `EquipmentSystem` for the world, one `BotThrower` for the AI,
     * and one `ThrowController` **per connected human** — the client has a single controller for
     * its single local player, and a server needs one per hand holding a pin.
     *
     * §6.8's *"smoke occludes bot LOS server-side"* is the line below it, and it is the reason
     * this cannot be a client-side feature: the bots whose sight is being blocked live here, and
     * a smoke cloud the server does not know about blocks nothing that matters.
     */
    this.equipment = new EquipmentSystem({
      bus: this.bus,
      world: this.world,
      damage: this.damage,
      roster: this.bots.roster,
      cfg: this.equipmentConfig,
    });
    this.botThrower = new BotThrower(this.equipment, this.world, this.equipmentConfig);
    this.equipmentRng = new Rng(options.seed ^ 0x1b87_3593);
    /**
     * The §6.8 requirement, in one assignment.
     *
     * `Perception.occluder` is consulted on every line-of-sight test a bot makes, so a smoke
     * cloud in front of a doorway stops the bots behind it seeing through — the same field, the
     * same test and the same numbers the client has used since M5. Cleared in `dispose`, because
     * a director outliving the field it points at is a use-after-free in a language that will
     * not tell you.
     */
    this.bots.perception.occluder = this.equipment.smoke;

    this.unsubscribe.push(
      this.bus.on(EV.MatchEnded, () => {
        this.result = this.flow.result;
      }),
    );

    /**
     * A new round puts everybody back where they started (M11 Gate B; post-M8 playtest).
     *
     * **The third piece of match wiring that never crossed to the server at M9**, and the one
     * with the worst symptom. `ClientMatch` has subscribed to this since M8 and `ServerMatch`
     * never did, so in a networked Search & Destroy the humans were never put back at a round
     * boundary — and there is no other route home, because `maybeRespawn` gates on
     * `flow.respawnAllowed`, which in a one-life mode is false by construction
     * (`livesUsed < livesPerRound - 1` is `0 < 0`). A human who died in round one was dead for
     * the rest of the match: able to look around, unable to move, while the bots played on
     * around them. Exactly the failure `spawnPlayer`'s own comment warns about — *"a
     * permanently dead player is not a visibly broken one"* — arriving from the other end.
     *
     * Bots were fine, because `BotDirector.respawnAll` is driven from the client's copy of this
     * subscription in single-player and from the director's own round handling here. Only the
     * human half was missing, which is why nothing in the logs said so.
     *
     * Guarded by `usesRoundReset` exactly as the client's is: a single-round mode fires this
     * once, at the start, against a world that has just spawned everybody anyway.
     */
    this.unsubscribe.push(
      this.bus.on(EV.RoundStarted, () => {
        if (this.modeEntry.usesRoundReset !== true) return;
        this.bots.respawnAll();
        // `NetPlayer.spawn` already clears the respawn timer, resets health and bumps the
        // spawn serial, so this is the whole of a human's round reset.
        for (const player of this.players) {
          this.spawnPlayer(player);
          this.flow.noteRespawn(player.entityId);
        }
      }),
    );

    /**
     * A new life started (playtest round 4, B3).
     *
     * **The one door.** `PlayerController.spawn` emits this and every combatant in the game
     * goes through it — `Bot.spawn` calls it and so does `NetPlayer.spawn` — so one
     * subscription covers the humans and the bots, a death respawn and a Search & Destroy
     * round start alike. It replaces a refill that sat inside `spawnPlayer`, which was the
     * server's only new-life door *by inspection* rather than by construction: a second one
     * would have had to remember to copy the line.
     *
     * `EV.BotSpawned` is deliberately not also subscribed. It is a second announcement of the
     * same spawn carrying tier detail for the director, and listening to both counts every bot
     * life twice — measured in round 4's streak audit at 304 life-starts against 154 real ones.
     */
    this.unsubscribe.push(this.bus.on(EV.PlayerSpawned, (p) => this.beginLife(p.entityId)));

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
    this.currentTick = tickIndex;
    this.outgoing.begin();

    // Humans first, then bots. The order matters for exactly one reason and it is worth
    // stating: a bot's perception reads combatant poses, so stepping humans first means bots
    // react to where the humans are *this* tick rather than last. The reverse would give
    // every human one tick of free reaction time over every bot, forever.
    for (const player of this.players) this.stepPlayer(player, tickIndex);

    /**
     * The bots get the same freeze the humans have had since M10.
     *
     * `stepPlayer` has passed `inputFrozen` since M10 and the bots never received it, so during
     * WARMUP and ROUND_END the humans stood still and the bots played on — sprinting off their
     * spawns and, in Search & Destroy, starting the round before the round started.
     *
     * The mechanism already existed and the server simply never set it: `ClientMatch` has
     * assigned `bots.inputFrozen` since M7, and `Bot.advance` neuters the movement axes and the
     * trigger before the command reaches the controller — while still letting the bot
     * **perceive**, so that when the round goes live it acts on a world it has been watching
     * rather than waking up blind. Skipping `simulate()` outright would skip the perception too,
     * which is why this is the parity port and not the cheaper one.
     */
    this.bots.inputFrozen = this.inputFrozen;
    // `sampledAtMs` is instrumentation only and no simulation reads it; ticks are the clock.
    this.bots.simulate(tickIndex, tickIndex * DT * 1000);
    // Before the flow, which is what advances a plant timer — in the same order `ClientMatch`
    // does it, so the two runtimes resolve a plant that starts and completes on the same tick
    // identically.
    this.stepBombInteractions();
    /**
     * Equipment, in `ClientMatch.simulate`'s order (M11 Gate B, §8.24).
     *
     * Throwers first so a grenade released this tick is in the world before the world steps,
     * then the field integration, then one bot's throw evaluation. Getting this order wrong
     * costs a grenade one tick of flight, which is 16 ms of trajectory — small, constant, and
     * exactly the kind of systematic offset that makes a predicted arc land beside the
     * authoritative one for ever.
     */
    this.stepThrowers();
    this.equipment.simulate(0, 0, 0, PLAYER_TEAM, false);
    this.stepBotThrows();
    // Streaks tick after the bots that may have just shot one down, and before the flow that
    // may declare the match over and end them all. The same order `ClientMatch` uses.
    this.streaks.simulate(tickIndex);
    this.flow.simulate(tickIndex);

    for (const player of this.players) this.maybeRespawn(player);

    // After everybody has moved, before anything is sent. One call for the whole roster, so
    // there is no route by which an entity is stepped and not recorded — a hole in the
    // history is a rewind that silently resolves against the present.
    this.rewind.record(tickIndex);

    // Last, because a life that started this tick has now been through every system that
    // could have handed it something.
    this.sampleLifeStarts();

    this.ticks++;
  }

  /**
   * Every connected human's grenade hand (M11 Gate B, §8.24).
   *
   * One `ThrowController` and one `EquipmentInventory` per player, because both are per-hand
   * state: a cook timer, which slot is in it, and how many are left. `ClientMatch` has one of
   * each because it has one local player; a server needs one per human and the client's shape
   * does not generalise by itself.
   *
   * Driven from the command the player's body just consumed, so a pin pulled on tick N is the
   * pin the client predicted pulling on tick N — the throw is a *consequence* of the same
   * command, not a separate message that could arrive a tick either side of it.
   */
  private stepThrowers(): void {
    for (const player of this.players) {
      const cmd = player.lastCommand;
      if (cmd === null) continue;
      const hand = this.handOf(player.entityId);
      hand.thrower.step(
        cmd,
        player.controller.sim,
        player.entityId,
        hand.inventory,
        player.team,
        player.alive,
      );
    }
  }

  /**
   * One bot's throw evaluation per tick, round robin (M5).
   *
   * Verbatim from `MatchEquipment.stepBotThrows`, including the cursor: the trajectory check
   * runs the real integrator and is the most expensive thing in `ai/` per call, so spreading
   * it across ticks is what keeps it inside the §4.7 budget. At one bot per tick with a
   * 12-30 s cooldown each, a ten-bot match spends a few dozen of them a minute.
   */
  private stepBotThrows(): void {
    const bots = this.bots.bots;
    if (bots.length === 0) return;
    this.throwCursor = (this.throwCursor + 1) % bots.length;
    const bot = bots[this.throwCursor];
    if (bot === undefined || !bot.participating) return;

    const bb = bot.blackboard;
    this.throwIntent.hasTarget = bb.targetId >= 0;
    this.throwIntent.targetX = bb.lastKnownX;
    this.throwIntent.targetY = bb.lastKnownFeetY;
    this.throwIntent.targetZ = bb.lastKnownZ;
    this.throwIntent.sinceSeen = bb.sinceLos;

    this.botThrower.consider(
      bot,
      bot.tierName,
      this.tiers[bot.tierName],
      this.throwIntent,
      this.bots.roster,
      this.equipmentRng,
      // One evaluation per bot every `bots.length` ticks.
      DT * bots.length,
    );
  }

  /**
   * This player's grenade hand, created on first use.
   *
   * Lazily rather than in `addPlayer`, so a seat that never throws costs nothing — and so that
   * the map cannot be left holding a controller for an entity that has been removed, which
   * `removePlayer` guarantees by deleting it.
   */
  private handOf(entityId: number): PlayerHand {
    let hand = this.hands.get(entityId);
    if (hand === undefined) {
      const resolved = this.loadouts.get(entityId);
      hand = {
        thrower: new ThrowController(this.equipment, this.equipmentConfig),
        // The class's grenades, not the M5 defaults — the same read `ClientMatch` does when it
        // hands the inventory its loadout.
        inventory: makeEquipmentInventory(resolved?.lethal ?? 'frag', resolved?.tactical ?? 'flashbang'),
      };
      this.hands.set(entityId, hand);
    }
    return hand;
  }

  /**
   * Every connected human's Use key, against the bomb (M11 Gate B, §6.8).
   *
   * §6.8: *"Plant and defuse are interruptible and resolve server-side."* They did not resolve
   * server-side at all before this. The whole interaction — pick up, plant, defuse, cancel —
   * lived in `ClientMatch.stepBombInteraction`, driven by the local player's Use key, and the
   * dedicated server had no equivalent. Combined with the bots having no objectives (see the
   * constructor), **nobody in a networked Search & Destroy could touch the bomb**: not a bot,
   * because it had no target, and not a human, because the only code that reads Use for this
   * purpose was running on a client whose mode is not authoritative.
   *
   * A port of the client's logic rather than a new one, and deliberately so — the rules about
   * who may plant and where live in `SearchAndDestroy`, and this only reports that a particular
   * body is standing in the right place with the key held. The mode is still the only thing
   * that decides whether that means anything.
   *
   * Hold, not press: `beginInteract` is idempotent for the same actor, and releasing the key
   * cancels. That is what makes an interruption free — there is no state here to unwind, and a
   * player who dies mid-plant is handled by `onKill` inside the mode.
   */
  private stepBombInteractions(): void {
    const mode = this.mode;
    if (!(mode instanceof SearchAndDestroy)) return;

    for (const player of this.players) {
      const holding = isDown(player.lastButtons, Btn.Use);
      if (!holding || !player.alive) {
        // Only cancel what *this* player started. Another player's plant is not theirs to stop,
        // and neither is a bot's.
        if (mode.interactEntity === player.entityId) mode.cancelInteract();
        continue;
      }

      if (mode.bomb === 'PLANTED') {
        if (player.team !== mode.defenders) continue;
        const site = mode.plantedSite;
        if (site === null || !site.contains(player)) continue;
        mode.beginInteract(player, true);
        continue;
      }
      if (mode.bomb !== 'CARRIED') continue;
      if (player.team !== mode.attackers) continue;
      // One key does both, and pickup is tested first because you cannot plant a bomb you are
      // not carrying (post-M8 playtest).
      if (!mode.isCarrier(player.entityId)) {
        mode.tryPickup(player);
        continue;
      }
      if (mode.siteContaining(player) === null) continue;
      mode.beginInteract(player, false);
    }
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
  addPlayer(displayName: string, loadout?: LoadoutSlot | null): NetPlayer | null {
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

    /**
     * The *same* shared `resolveLoadout` the loadout editor calls per keystroke, so the weapon
     * this player holds on the server is built from the identical base def, attachment chain and
     * perk modifiers as the one they are looking down.
     *
     * Absent — any client that has not sent one yet — it falls back to the M10 pair, so nothing
     * that worked before changes.
     */
    const resolved = loadout == null ? null : resolveLoadout(loadout, 0);

    const player = new NetPlayer(entityId, displayName, team, {
      world: this.world,
      bus: this.bus,
      damage: this.damage,
      movement: this.movementConfig,
      healthConfig: this.healthConfig,
      viewmodelConfig: this.viewmodelConfig,
      weaponDef: resolved?.primary ?? AR_DEFAULT,
      secondaryDef: resolved?.secondary ?? PISTOL_DEFAULT,
      perks: resolved?.perkState ?? NO_PERKS,
    });
    this.loadouts.set(entityId, resolved);

    this.players.push(player);
    this.damage.register(player);
    this.bots.roster.push(player);
    this.rewind.register(player);
    this.score.register(entityId, displayName, team);

    /**
     * Spawn now — unless this is a one-life round already under way (§6.7, M7).
     *
     * §6.7: a human joining a running match *"is blocked mid-round in S&D per M7"*. One life a
     * round means a body that appears halfway through has an advantage nobody else in the round
     * has: everyone else has been shot at since the start. So they are seated, scored and
     * routed — they simply have no body until the round ends, at which point the `RoundStarted`
     * reset above puts them in with everybody else.
     *
     * `usesRoundReset` is the test rather than `livesPerRound`, because it is the same fact the
     * reset keys off: a mode whose rounds put everybody back is a mode where waiting for the
     * next round is a bounded wait.
     */
    if (this.joinBlockedMidRound()) {
      log.info(
        `${displayName} joined mid-round in ${this.modeEntry.id} — held out until the next round.`,
      );
    } else {
      this.spawnPlayer(player);
    }
    // The class is now a thing that can be wrong, and "what did the server think this player
    // brought" is the first question when a duel looks wrong.
    const perks = describePerkState(this.perksOf(entityId));
    log.info(
      `${displayName} seated as entity ${entityId} on team ${team} — ` +
        `${player.weapons.definition.id}/${resolved?.secondary.id ?? PISTOL_DEFAULT.id}, perks ${perks}` +
        (resolved === null ? ' (no loadout sent; server defaults)' : ''),
    );
    return player;
  }

  /**
   * The three streaks an entity may earn (M7 playtest, §6.8).
   *
   * Six shipped streaks against three keys means a player who reached twelve kills would hold
   * six things and be able to spend three, so the class decides which three — exactly as it
   * decides which three perks. A bot has no class and keeps the full list, which is what it
   * has always had.
   */
  private equippedStreaksOf(entityId: number): readonly StreakId[] {
    const resolved = this.loadouts.get(entityId);
    if (resolved == null) return ALL_STREAK_IDS;
    return resolved.streaks.filter((id): id is StreakId => id !== null);
  }

  /**
   * Whether a body arriving now would be joining a one-life round in progress (§6.7).
   *
   * `WARMUP` is deliberately not blocked: that is the 3-2-1 before a round, nobody has been
   * shot at yet, and it is the phase every player migrating in at match start arrives during.
   * Blocking there would hold *the whole lobby* out of round one.
   */
  private joinBlockedMidRound(): boolean {
    return this.modeEntry.usesRoundReset === true && this.flow.currentPhase === 'LIVE';
  }

  /**
   * The perks an entity is carrying. `NO_PERKS` for bots and for anyone without a loadout.
   *
   * Bots deliberately get the neutral state rather than a special case: "a bot has no loadout"
   * is already what `NO_PERKS` means.
   */
  perksOf(entityId: number): PerkState {
    return this.loadouts.get(entityId)?.perkState ?? NO_PERKS;
  }

  /** The resolved class an entity brought, or null. */
  loadoutOf(entityId: number): ResolvedLoadout | null {
    return this.loadouts.get(entityId) ?? null;
  }

  /**
   * Queue a class change, to take effect on this player's **next spawn** (M11, §6.6).
   *
   * §6.6: *"Changes take effect on the next warmup respawn, not immediately on the living
   * player."* That is CoD behaviour, and it is also the only version of this that is safe over
   * a wire — see `NetPlayer.applyLoadout` for why applying it to a standing body reintroduces
   * Tier 1 #20's divergence through a different door.
   *
   * Stored rather than applied, so there is exactly one place a class is ever swapped and it is
   * a place both runtimes already treat as a discontinuity.
   */
  setPendingLoadout(entityId: number, slot: LoadoutSlot): boolean {
    if (this.getPlayer(entityId) === undefined) return false;
    this.pendingLoadouts.set(entityId, resolveLoadout(slot, 0));
    return true;
  }

  /**
   * Cash a queued class change **now**, if this is the pre-match freeze (M11 Gate B).
   *
   * The quick selector's whole promise is that the class you press during the ten-second
   * countdown is the class you start the match with. "Next spawn" does not deliver that on its
   * own — the player is already standing, so their next spawn is after their first death, and
   * they would spend the opening life holding the class they were migrated in with.
   *
   * Respawning them is what makes it immediate, and the pre-match freeze is the one window
   * where that is free: nobody has moved, nobody has fired, and the movement axes are stripped
   * before they reach the controller, so a `speedScale` that changes here cannot be the source
   * of a misprediction. The spawn serial bump is the same discontinuity a death already
   * produces, which is exactly how the client is told to adopt the new pose without charging
   * itself for the difference (see `NetClient.respawned`).
   *
   * Round one only, and alive only. A round-two S&D freeze is three seconds and the player is
   * about to be spawned by the round reset anyway, so the ordinary deferral is both correct
   * and cheaper.
   */
  applyPendingLoadoutNow(entityId: number): boolean {
    if (!this.pendingLoadouts.has(entityId)) return false;
    if (this.flow.currentPhase !== 'WARMUP' || this.flow.round > 1) return false;
    const player = this.getPlayer(entityId);
    if (player === undefined || !player.alive) return false;
    this.spawnPlayer(player);
    return true;
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
    this.loadouts.delete(entityId);
    this.pendingLoadouts.delete(entityId);
    /**
     * Their chopper comes down with them (M11 Gate B, §8.23).
     *
     * The fourth Chopper Gunner case. Every other exit a gunner has is an event `StreakSystem`
     * already listens for; leaving the match is not one of them, so without this a disconnected
     * player's gunship kept flying, owned by an entity that had just stopped existing. See
     * `StreakSystem.onOwnerRemoved` for why this deliberately reuses the death rules.
     */
    this.streaks.onOwnerRemoved(entityId);
    // Their hand goes with them. A controller left in the map is a cook timer advancing for
    // an entity that no longer exists — the same shape as the orphaned chopper above.
    this.hands.delete(entityId);
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
   * Take a bot off the roster to make room for a human.
   *
   * Not just `bots.removeOne`: the director cannot unregister from `Rewind` (server-only), so
   * `populate()` registered the bot here and nothing ever unregistered it. **Route all bot
   * removal through this**, never `bots.removeOne` directly.
   *
   * This is not a hit-registration bug and the distinction matters — `DamageSystem` no longer
   * holds the bot, so no ray can resolve against it. What survives is a phantom in the
   * lag-compensation path: `Rewind.record` writes its frozen pose every tick forever, and every
   * subsequent `begin` saves, rewinds and restores a rig nobody can shoot, inflating `moved` and
   * `missed`. It corrupts the instrument rather than the game.
   */
  removeBotForSeat(team: BotTeam): boolean {
    const bot = this.bots.removeOne(team);
    if (bot === null) return false;
    this.rewind.unregister(bot.entityId);
    return true;
  }

  /**
   * Hand a leaver's seat to a fresh bot, so their side is not left a body down.
   *
   * In Search & Destroy, where `anyAlive` decides the round and one life means nobody comes
   * back, the last human on a team disconnecting **ends the round for everybody** — scored as an
   * elimination nobody achieved.
   *
   * The replacement spawns fresh rather than inheriting the body: a bot taking over a corpse
   * mid-round would be a body that died and is now alive with no spawn serial, which every
   * client renders as a corpse standing up.
   */
  replacePlayerWithBot(entityId: number): boolean {
    const player = this.getPlayer(entityId);
    if (player === undefined) return false;
    const team = player.team;
    this.removePlayer(entityId);

    const mix: readonly BotTier[] = this.mapEntry.tierMix;
    const tier = mix[this.bots.bots.length % Math.max(mix.length, 1)] ?? 'REGULAR';
    const bot = this.bots.addOne(team, tier);
    if (bot === null) {
      log.warn(`no bot could replace entity ${entityId} on team ${team} — the side is a body down.`);
      return false;
    }
    this.score.register(bot.entityId, bot.displayName, bot.team);
    // Bots are rewound too — a hole here is a shot that silently resolves against the present.
    this.rewind.register(bot);
    this.rewind.resetAt(bot.entityId, this.currentTick);
    log.info(`entity ${entityId} left; ${bot.displayName} took over on team ${team}.`);
    return true;
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

  /**
   * Which side a joining human goes on: **fewer humans first**, then fewer bodies.
   *
   * Bots are interchangeable; humans are the thing a player notices being on the wrong side of.
   * Counting the whole roster and breaking ties toward A is correct arithmetic and the wrong
   * question — a seat is granted and then a bot is removed *from the same side*, restoring the
   * body count to what it was, so the next joiner finds the identical tie and is sent to A as
   * well. Measured on a four-human TDM backfill: entities 1, 2, 3 and 4 all on team A.
   */
  private smallerTeam(): BotTeam {
    let humansA = 0;
    let humansB = 0;
    for (const p of this.players) {
      if (p.team === 'A') humansA++;
      else humansB++;
    }
    if (humansA !== humansB) return humansA < humansB ? 'A' : 'B';

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
      /**
       * `selectSpawn` is documented never to fail. If that ever stops being true, falling
       * back matters more than it looks: this is the only path back to `alive`, so returning
       * early here leaves the player dead **forever** — and a permanently dead player is not
       * a visibly broken one, it is a player who can still look around and cannot walk. That
       * is indistinguishable from a movement bug and would be debugged as one.
       *
       * So take the map's first authored spawn instead. It may be a poor spawn; it is not a
       * lost life.
       */
      const fallback = this.mapEntry.def.spawns?.[0];
      if (fallback === undefined) {
        log.error(`no spawn available for entity ${player.entityId} and no map fallback.`);
        return;
      }
      log.warn(`no scored spawn for entity ${player.entityId}; using the map's first.`);
      this.spawnChoice.x = fallback.position.x;
      this.spawnChoice.y = fallback.position.y;
      this.spawnChoice.z = fallback.position.z;
      this.spawnChoice.yaw = fallback.facingYaw;
    }
    /**
     * Apply a queued class change here, before the body goes live (M11, §6.6).
     *
     * The spawn is the discontinuity both sides already agree on, which is what makes this the
     * one safe moment. See `NetPlayer.applyLoadout`.
     */
    const pending = this.pendingLoadouts.get(player.entityId);
    if (pending !== undefined) {
      this.pendingLoadouts.delete(player.entityId);
      this.loadouts.set(player.entityId, pending);
      player.applyLoadout(pending.primary, pending.secondary, pending.perkState);
      log.info(
        `${player.displayName} respawned with class "${pending.name}" — ` +
          `${pending.primary.id}/${pending.secondary.id}, perks ${describePerkState(pending.perkState)}.`,
      );
    }

    // Equipment is per life (§6.3) and is refilled by `beginLife`, off the spawn below.
    const c = this.spawnChoice;
    player.spawn(c.x, c.y, c.z, c.yaw);
    // Backfill the whole history with the spawn pose, so a shot rewound into the window
    // before this player existed cannot resolve against a stale or origin rig. Stamped with
    // the **absolute** tick: `Rewind.record` is called from `step` with that one, and
    // `RigHistory` validates a slot by the tick that wrote it — so a history stamped with a
    // match-relative index is a history whose every slot fails its own validity check, and
    // lag compensation quietly declines to apply.
    this.rewind.resetAt(player.entityId, this.currentTick);
  }

  /** Bring a dead player back once their timer and the mode's gate both allow it. */
  private maybeRespawn(player: NetPlayer): void {
    if (player.alive || player.respawnTimer > 0) return;
    if (!this.flow.respawnAllowed(player.entityId)) return;
    this.flow.noteRespawn(player.entityId);
    this.spawnPlayer(player);
  }

  /**
   * The killstreak economy this match produced (playtest round 4, B9 + B10).
   *
   * Read by both harnesses. It carries its own red control: `thresholdGrants` is what the
   * model this replaced would have handed out over the same lives, computed from the same
   * kills, so the before and the after come out of one run and cannot be two different fights.
   */
  get streakEconomy(): StreakEconomyReport {
    return this.streaks.economyReport();
  }

  /**
   * What every life in this match started holding (playtest round 4, B3).
   *
   * `partialStock` must be 0. Read by both harnesses; safe to take mid-match, because the
   * audit is a running total rather than a walk of the roster.
   */
  get equipmentAudit(): LifeStockReport {
    return this.lifeStock.report();
  }

  /**
   * The per-life equipment reset, for whoever just spawned.
   *
   * The branch is the same one `MatchEquipment.onSpawned` makes on the client — a hand for the
   * body you own, a thrower state for everybody else — and not an `if (networked)`: it asks
   * *which kind of combatant this is*, which is a question the server has to answer anyway
   * because humans and bots hold their grenades in different places.
   *
   * `handOf` rather than a lookup: the hand is created on demand, and a life that starts before
   * its owner has ever thrown is exactly the life a lookup would skip.
   */
  private beginLife(entityId: number): void {
    this.pendingLifeStarts.push(entityId);

    if (this.getPlayer(entityId) !== undefined) {
      const hand = this.handOf(entityId);
      hand.thrower.reset();
      EquipmentSystem.refill(hand.inventory);
      return;
    }

    /**
     * A bot's grenades, which over the network nothing gave back (round 4, B3).
     *
     * `BotThrower.respawn` had exactly one caller in the project and it was on the client, so
     * a bot in a dedicated-server match threw the one lethal and the one tactical it starts
     * with and was unarmed for the rest of the match — `pickEquipment` skips a slot at zero,
     * silently, and a bot that stops throwing looks like a bot that decided not to. The same
     * authority migration as the entity id: the simulation moved to the server and the reset
     * stayed behind on the client.
     */
    this.botThrower.respawn(entityId);
  }

  /**
   * Sample the stock of every life that started this tick.
   *
   * Deferred to the end of the tick rather than read inside the spawn event, and that is the
   * whole reason it is honest: the refill above is another subscriber to the same event, so a
   * probe reading during the emit would be measuring subscription order. At the end of the tick
   * the life has been through every system that could have handed it anything, which is the
   * state the player actually wakes up in.
   */
  private sampleLifeStarts(): void {
    if (this.pendingLifeStarts.length === 0) return;

    for (const entityId of this.pendingLifeStarts) {
      if (this.getPlayer(entityId) !== undefined) {
        const inv = this.handOf(entityId).inventory;
        this.lifeStock.note(
          'human',
          inv.lethalCount,
          equipmentDef(inv.lethal).count,
          inv.tacticalCount,
          equipmentDef(inv.tactical).count,
        );
        continue;
      }
      const stock = this.botThrower.stockOf(entityId);
      const full = BotThrower.fullStock;
      this.lifeStock.note('bot', stock.lethal, full.lethal, stock.tactical, full.tactical);
    }
    this.pendingLifeStarts.length = 0;
  }

  /** Equipment thrown and detonated this match. Read by the harness (§8.24). */
  get equipmentStats(): {
    thrown: number;
    detonated: number;
    smokeLive: number;
    smokeBlocked: number;
  } {
    return {
      thrown: this.equipment.thrownTotal,
      detonated: this.equipment.detonatedTotal,
      /**
       * The two numbers §6.8's smoke claim actually rests on (M11 Gate B playtest).
       *
       * *"Smoke occludes bot LOS on the server"* was wired and never measured, and a wired
       * occluder that is never consulted looks exactly like a working one from outside. These
       * make the difference reportable: `smokeLive` says a cloud existed at all — without it a
       * zero below means "nothing was thrown", not "smoke does nothing — and `smokeBlocked` is
       * the count of sight lines `Perception` threw away because a cloud was in the way.
       */
      smokeLive: this.equipment.smoke.liveCount,
      smokeBlocked: this.bots.perception.smokeBlocked,
    };
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
    /**
     * Before the director, which streaks hold a reference to (§4.18).
     *
     * A live match is created and destroyed on every cycle, and §8.13 asks for a hundred of
     * them to leave `EventBus.liveSubscriptions` exactly flat. `StreakSystem.dispose` retires
     * every live streak — each of which may hold a damageable registration and bus handlers of
     * its own — so a match torn down with a sentry still standing releases it rather than
     * leaving it subscribed to a bus that outlives the world it was shooting into.
     */
    this.streaks.dispose();
    this.bots.streakObjectives = null;
    // Before the director is disposed: `Perception` holds this field and a director outliving
    // it is a reference into a world that no longer exists.
    this.bots.perception.occluder = null;
    this.equipment.clear();
    this.bots.dispose();
  }

  // -- internals ------------------------------------------------------------

  private populate(): void {
    /**
     * `rosterOverride` beats the mode's authored size, which beats the requested bot count.
     *
     * The override exists for the warmup arena (§6.3: *"2-3 bots"*), which runs FFA rules on a
     * mode entry that fixes the roster at eight. Without it the arena would fill the greybox
     * room with eight bots — a room authored as a two-lane weapon range — and the *"stand on a
     * range while you wait"* feel §6.3 asks for would be a brawl instead.
     */
    const total = this.options.rosterOverride ?? this.modeEntry.rosterSize ?? this.options.bots;
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
