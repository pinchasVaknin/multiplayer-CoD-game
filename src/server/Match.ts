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

  /**
   * Each seated human's resolved class, by entity id.
   *
   * Kept alongside the player rather than on it because the consumers take a *predicate over an
   * entity id* — and those are asked about bots too, which have no loadout.
   */
  private readonly loadouts = new Map<number, ResolvedLoadout | null>();

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

    // Dead Silence, server-side. The client half has existed since M6 and decided nothing over
    // the network, because the bots that hear the footsteps live here and this hook was never set.
    this.bots.silentFootsteps = (entityId) => !this.perksOf(entityId).audibleFootsteps;

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

    this.spawnPlayer(player);
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
