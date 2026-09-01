import * as THREE from 'three';
import type { SchedulerConfig } from '../shared/ai/AiScheduler';
import type { PerceptionConfig, TierTable } from '../shared/ai/DifficultyTiers';
import { EV, type GameBus } from '../shared/core/Events';
import type { Input } from './input/Input';
import type { Loop } from './engine/FrameLoop';
import type { ICommandQueue } from '../shared/net/Transport';
import type { CameraRig } from './engine/CameraRig';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import type { ProceduralTextures } from './engine/ProceduralTextures';
import type { Renderer } from './engine/Renderer';
import { BotHarness, type BotHarnessOptions } from './debug/BotHarness';
import { DebugSuite } from './debug/DebugSuite';
import { DivergenceChecker } from '../shared/debug/DivergenceChecker';
import type { BuildReport } from './world/MapBuildQueue';
import type { FrameStats } from './debug/FrameStats';
import type { MatchHarness } from './debug/MatchHarness';
import type { Speedometer } from './debug/Speedometer';
import { Match } from './ClientMatch';
import { KillConfirmed } from '../shared/modes/KillConfirmed';
import { SearchAndDestroy } from '../shared/modes/SearchAndDestroy';
import { STREAK_DEFS, type StreakId } from '../shared/streaks/StreakDefs';
import type { EquipmentConfig } from '../shared/equipment/EquipmentConfig';
import type { ResolvedLoadout } from '../shared/meta/Loadouts';
import type { Profile } from './meta/Profile';
import type { MapEntry, ModeEntry } from '../shared/modes/ModeRegistry';
import type { CameraConfig } from './player/CameraConfig';
import type { HealthConfig } from '../shared/player/Health';
import type { MovementConfig } from '../shared/player/MovementConfig';
import { PlayerController } from '../shared/player/PlayerController';
import type { ViewmodelLayer } from './player/Viewmodel';
import type { ViewmodelConfig } from '../shared/weapons/ViewmodelConfig';
import type { WeaponDef } from '../shared/weapons/WeaponDefs';
import type { InputCommand } from '../shared/core/InputCommand';
import type { WelcomeInfo } from '../shared/net/Messages';
import { LocalIdentity } from '../shared/combat/LocalIdentity';
import type { BrowserLink } from './net/BrowserLink';
import type { SkirmishSink } from '../shared/net/NetClient';
import { ownerFromCode, type NetLoadout } from '../shared/net/Skirmish';
import { NetSession } from './net/NetSession';
import { logger } from '../shared/core/Log';
import type { RenderableActor } from '../shared/ai/BotVisualState';
import { applyAmbient, loadMap, type LoadedMap } from './world/MapRender';
import { Particulate } from './world/Particulate';

/**
 * The world a match is played in, as one object with one lifetime (M7).
 *
 * ## Why this file exists
 *
 * M4 made the world per-match: the map, the player, the match and all of its debug tooling
 * are built on entering MATCH and **fully disposed on leaving SUMMARY**, because S6.3 says
 * loading a map twice must not double anything. That was implemented as `buildWorld` and
 * `teardownWorld` inside `Game.ts` plus six nullable fields, and by M6 those six fields were
 * woven through `simulate`, `draw`, five state handlers and eight getters — around thirty
 * call sites, every one of them an optional chain on a field that is either all present or
 * all absent. `Game.ts` reached 905 lines and PLAN.md named the split as the first M7 job.
 *
 * The fix is not to move code, it is to move the *nullability*. Six fields that are always
 * null together are one field that is sometimes null, so `Game` now holds a single
 * `MatchWorld | null` and asks once. Inside here nothing is optional: a `MatchWorld` that
 * exists has a map, a player, a match and a debug suite, which is why this file has no `?.`
 * in it and why `Game.simulate` no longer has four.
 *
 * ## The mirror rule still holds
 *
 * The constructor and `dispose` are exact mirrors — every field the one sets, the other
 * clears; every group the one adds to the scene, the other removes. That is the property
 * `MatchHarness` is really testing when it runs three matches and logs the heap at each
 * boundary, and it is easier to check now that both halves are adjacent in one file instead
 * of ninety lines apart in the state machine.
 *
 * What deliberately does **not** live here is anything genuinely process-wide: the renderer,
 * the textures, the audio graph, the input listener, the frame-stats buffer, the profile and
 * the config objects the tuning panel holds references to. Those are handed in.
 */

/**
 * Seed for everything in `ai/`. Fixed, so two runs of the harness with the same roster
 * produce the same firefight and a regression in bot behaviour is reproducible.
 */
export const AI_SEED = 0x0fe7_a105;

const netLog = logger('world');

export interface MatchWorldDeps {
  // ---- process-wide handles ------------------------------------------------
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly renderer: Renderer;
  readonly textures: ProceduralTextures;
  readonly viewmodel: ViewmodelLayer;
  readonly cameraRig: CameraRig;
  readonly audio: ProceduralAudio;
  readonly input: Input;
  readonly loop: Loop;
  readonly uiHost: HTMLElement;
  readonly debugHost: HTMLElement;
  readonly stats: FrameStats;
  readonly speedo: Speedometer;
  readonly matchHarness: MatchHarness;
  readonly profile: Profile;

  // ---- the long-lived config objects the tuning panel writes into ----------
  readonly movementConfig: MovementConfig;
  readonly cameraConfig: CameraConfig;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly healthConfig: HealthConfig;
  readonly equipmentConfig: EquipmentConfig;
  readonly weaponDef: WeaponDef;
  readonly secondaryDef: WeaponDef;
  readonly playerBaseDef: WeaponDef;
  readonly tiers: TierTable;
  readonly perceptionConfig: PerceptionConfig;
  readonly schedulerConfig: SchedulerConfig;

  // ---- what this particular match is --------------------------------------
  readonly mapEntry: MapEntry;
  /** M9 (S7): handed to the debug overlay, which reports the source of simulation. */
  readonly transport: ICommandQueue;
  readonly modeEntry: ModeEntry;
  readonly loadout: ResolvedLoadout;

  /**
   * The match declared itself over. `Game` defers the SUMMARY transition to the render pass
   * rather than transitioning from inside a sim tick: tearing the HUD down half-way through
   * the tick that produced the winning kill is how you get a null dereference in the middle
   * of an event dispatch.
   */
  readonly onMatchEnded: () => void;
  readonly onConfigChanged: () => void;
  readonly onWeaponConfigChanged: () => void;

  /**
   * Whether the game screen is `MATCH` (playtest round 4, B4).
   *
   * A supplier rather than a flag, and read at the moment the command is built rather than
   * pushed in when the screen changes: the screen outlives every surface drawn over it and
   * there is exactly one writer of it, the state machine. It decides what a command *contains*
   * — nothing, while a front-end screen owns the page — and deliberately not whether the
   * socket is serviced. Those were one decision until B4, and the summary screen paid for it:
   * a client that stopped reading the socket for a 14 s hold was closed by the server's 10 s
   * timeout four seconds before it would have been migrated home.
   */
  readonly inMatch: () => boolean;

  // ---- M11 (§7): instrumentation owned by `Game`, shown by this world's panel ----
  readonly lastBuild: () => BuildReport | null;
  readonly buildProgress: () => { done: number; total: number; label: string } | null;
  readonly migrationWindows: () => readonly { matchId: number; tick: number; mispredictions: number }[];

  /**
   * Play this match against a dedicated server instead of locally (M10, S6).
   *
   * Null is single-player, which is every path M1-M8 built and must keep working unchanged
   * (HARD RULE 8). When set, the world builds a `NetSession`, the match is told it is
   * networked, and the bodies on screen come from snapshots rather than from a local roster.
   */
  readonly server: NetworkedMatchOptions | null;
}

/**
 * A connection that is already up, and the match the server said it is running (M10,
 * playtest round 2).
 *
 * This used to be the *address to dial*, and the world was built before anything was dialled
 * — which is how the client came to load one map while the server ran another. The world is
 * now built **from** the handshake rather than before it, so what arrives here is a live link
 * and a decoded `Welcome`, and `deps.mapEntry` above is resolved from `welcome.mapId`.
 */
export interface NetworkedMatchOptions {
  /** Open, handshaken, and carrying the S7 condition simulators it was created with. */
  readonly link: BrowserLink;
  readonly welcome: WelcomeInfo;
  /** When the `Welcome` landed, for seeding the clock. See `NetClient.adopt`. */
  readonly receivedAtMs: number;
  /** Frames the handshake drained behind the `Welcome`. See `HandshakeResult.pending`. */
  readonly pending?: readonly Uint8Array[];
  readonly displayName: string;
  readonly wantRewindDebug: boolean;
  /** The server rotated to another match. The world has to be rebuilt from the new welcome. */
  readonly onNewMatch: (welcome: WelcomeInfo) => void;
  /** M11: the skirmish messages. Handled by `Game`, which owns the overlay and the build. */
  readonly skirmish?: SkirmishSink;
  /** M11: the class to send with the `Hello` (Tier 1 #20). */
  readonly loadout?: NetLoadout | null;
  /**
   * M11 (§6.5): a map this client already built in the background, adopted instead of
   * building a new one.
   *
   * This is the payoff of the whole design. When it is present, constructing the world does
   * no meshing and no texture work at all — the transition costs a scene swap rather than the
   * seconds §6.5 exists to move off the critical path. Null falls back to building here, which
   * is the §4.18 slow-client case: late, visible, and correct.
   */
  readonly prebuiltMap?: LoadedMap | null;
}

export class MatchWorld {
  readonly map: LoadedMap;
  readonly player: PlayerController;
  readonly match: Match;
  /** The F1 overlay and every visualiser and panel that hangs off it. */
  readonly debug: DebugSuite;
  /**
   * §7's state-divergence checker. Per world, because it is per match.
   *
   * Lives here rather than in `DebugSuite` because it is fed from the network path and must
   * run whether or not the debug overlay has ever been opened — a check that only samples
   * while somebody is looking at it is not a check.
   */
  readonly divergence = new DivergenceChecker();
  /** M8. Airborne dust or haze, or null on a map that authors none. */
  readonly particulate: Particulate | null;

  /** The connection, or null in single-player (M10). */
  readonly net: NetSession | null;

  /**
   * Which entity this client is, for everything that filters events by "was that me?".
   *
   * Created here rather than in `Game` because it belongs to a *match*: the id is assigned
   * per match by the server and reassigned on a rotation, so an identity that outlived the
   * world would answer for the seat we held in the previous one. Single-player never touches
   * it and it reads `PLAYER_ENTITY_ID` throughout.
   */
  private readonly identity = new LocalIdentity();

  /** The AFK bot-match driver, when `?harness=botmatch` asked for one. */
  private harness: BotHarness | null = null;

  private readonly deps: MatchWorldDeps;
  private readonly matchEndedSubscription: () => void;

  constructor(deps: MatchWorldDeps) {
    this.deps = deps;

    /**
     * Adopt the background build if it produced the map we need (M11, §6.5).
     *
     * The identity check is not paranoia: the build is started when the map vote resolves and
     * adopted when the migration lands, and between those two the allocation can fail or a
     * different map can win a re-run cycle. Adopting a map for the wrong world would put the
     * player in geometry the server is not simulating, which is the M10 map-desync bug —
     * spawning outside the world, walking through walls that are not there — arriving by a
     * new route.
     */
    const prebuilt = deps.server?.prebuiltMap ?? null;
    const map =
      prebuilt !== null && prebuilt.def.id === deps.mapEntry.def.id
        ? prebuilt
        : loadMap(deps.mapEntry.def, deps.textures, deps.profile.settings.shadowQuality);
    this.map = map;
    deps.scene.add(map.root);
    applyAmbient(deps.scene, map.def);

    // Added to the map's own root rather than to the scene, so the one `scene.remove` in
    // `dispose` takes it with everything else and there is no second thing to forget.
    const particulateDef = map.def.particulate;
    this.particulate = particulateDef === undefined ? null : new Particulate(particulateDef);
    if (this.particulate !== null) map.root.add(this.particulate.points);
    map.collision.configure(deps.movementConfig.maxSlopeDeg, deps.movementConfig.collisionSkin);

    const player = new PlayerController(deps.movementConfig, map.collision, deps.bus);
    this.player = player;

    const spawn = map.spawns[0];
    if (spawn === undefined) throw new Error('Map has no spawn zones');
    player.spawn(spawn.position.x, spawn.position.y, spawn.position.z, spawn.facingYaw);
    deps.input.setView(spawn.facingYaw, 0);

    /**
     * The session is built **before** the match, because the match's renderer needs to be
     * pointed at the session's actor list at construction — and after the player, because the
     * session predicts through that controller.
     */
    const server = deps.server;
    this.net =
      server === null
        ? null
        : new NetSession({
            link: server.link,
            welcome: server.welcome,
            receivedAtMs: server.receivedAtMs,
            pending: server.pending,
            displayName: server.displayName,
            bus: deps.bus,
            controller: player,
            identity: this.identity,
            wantRewindDebug: server.wantRewindDebug,
            onNewMatch: server.onNewMatch,
            skirmish: server.skirmish,
            loadout: server.loadout,
            // Both of these are filled in properly the moment the match exists — see below.
            // They are indirected through `this.match` rather than captured, because the
            // match cannot exist before the session it is being handed to.
            sample: (tick) => this.sampleCommand(tick),
            applyWeapon: (cmd) => this.applyWeaponForNet(cmd),
          });

    this.match = new Match({
      bus: deps.bus,
      networked: server !== null,
      identity: this.identity,
      localTeam: server?.welcome.team,
      localName: server?.displayName,
      actors: this.net === null ? undefined : () => netSessionActors(this.net),
      /**
       * Spend a streak by asking the server (Gate B, §8.22).
       *
       * Undefined in single-player, where `ClientMatch` activates locally against its own
       * system — the branch is on the presence of this callback's owner rather than on a flag,
       * so a local match cannot accidentally send.
       */
      onStreakRequest:
        this.net === null
          ? undefined
          : (id, markX, markZ) => {
              this.net?.client.sendStreak(streakKindIndex(id), markX, markZ);
            },
      scene: deps.scene,
      viewmodel: deps.viewmodel,
      cameraRig: deps.cameraRig,
      cameraConfig: deps.cameraConfig,
      audio: deps.audio,
      input: deps.input,
      world: map.collision,
      player,
      movementConfig: deps.movementConfig,
      weaponDef: deps.weaponDef,
      secondaryDef: deps.secondaryDef,
      playerBaseDef: deps.playerBaseDef,
      viewmodelConfig: deps.viewmodelConfig,
      healthConfig: deps.healthConfig,
      equipmentConfig: deps.equipmentConfig,
      uiHost: deps.uiHost,
      anisotropy: deps.textures.anisotropy,
      map: deps.mapEntry,
      mode: deps.modeEntry,
      tiers: deps.tiers,
      perceptionConfig: deps.perceptionConfig,
      schedulerConfig: deps.schedulerConfig,
      seed: AI_SEED,
      loadout: deps.loadout,
      profile: deps.profile,
      banksProgress: deps.modeEntry.banksProgress,
    });

    /**
     * Point the session at the match, now that both exist.
     *
     * These are the two places replicated state lands. They are assigned here rather than
     * passed into the session's constructor because the session is built first — the match's
     * renderer needs its actor list — so the reference can only be handed over afterwards.
     */
    const net = this.net;
    if (net !== null) {
      net.onMatchState = (state) => {
        this.match.flow.applyReplicated(state);
      };
      net.onLocalState = (health, alive) => {
        this.match.applyReplicatedSelf(health, alive);
      };

      /**
       * The §7 divergence checker.
       *
       * Fed the raw header and the score this client derived *from replicated events* through
       * its own `ScoreSystem` — two independent paths to the same number. See
       * `DivergenceChecker` for why comparing against `MatchFlow` instead would be a test that
       * cannot fail.
       */
      /**
       * Objective state, straight into the zones the renderer already walks (Gate B, §6.8).
       *
       * `MatchObjectives` reads `mode.zones` for Domination and `mode.sites` for S&D, and on a
       * networked client those objects exist but are never ticked — the local mode's roster is
       * empty, so `recountZones` counts nobody and every flag stays neutral for ever. The server
       * was capturing correctly the whole time; the client was drawing its own blank copy.
       *
       * Index is identity: both sides build their zone list from `MapDef.objectives`, in order.
       * A length mismatch means the two runtimes disagree about the map, which is a far larger
       * problem than a flag — so it is logged rather than silently truncated.
       */
      net.onObjectives = (states) => {
        const zones = this.match.mode.objectiveZones;
        if (states.length !== zones.length) {
          netLog.warn(
            `objective count mismatch: server sent ${states.length}, this map has ${zones.length}. ` +
              'Client and server disagree about the map.',
          );
          return;
        }
        for (let i = 0; i < zones.length; i++) {
          const zone = zones[i];
          const state = states[i];
          if (zone === undefined || state === undefined) continue;
          zone.owner = ownerFromCode(state.owner);
          zone.capturingTeam = ownerFromCode(state.capturing);
          zone.progress = state.progress / 255;
          zone.countA = state.countA;
          zone.countB = state.countB;
        }
      };

      /**
       * Kill Confirmed's tags, and Search & Destroy's bomb (Gate B, §6.8).
       *
       * Both land in the mode objects `MatchObjectives` already walks, for the same reason the
       * zones do: the renderer is correct and was being fed nothing. `updateTags` pools its
       * meshes by `tag.id`, and the ids are the server's, so a tag keeps its mesh from the frame
       * it lands to the frame it is collected.
       *
       * Guarded by a type test rather than assumed, because the mode a client holds is whatever
       * the server told it to build — and a `Tags` frame arriving one tick after a migration
       * into a TDM match would otherwise write tags onto a mode that has no floor for them.
       */
      net.onTags = (tags) => {
        const mode = this.match.mode;
        if (mode instanceof KillConfirmed) mode.applyReplicatedTags(tags);
      };

      net.onBomb = (info) => {
        const mode = this.match.mode;
        if (mode instanceof SearchAndDestroy) mode.applyReplicatedBomb(info);
      };

      /**
       * Killstreaks (Gate B, §8.22).
       *
       * Straight into the match's replica, which the HUD, the minimap and the streak renderer
       * are pointed at whenever the match is networked. Nothing is filtered here: the server
       * already sent this seat exactly what it is entitled to see.
       */
      net.onStreaks = (view) => {
        this.match.applyReplicatedStreaks(view);
      };

      /**
       * Grenades and smoke (Gate B, §8.24).
       *
       * Broadcast rather than per recipient — a grenade has no secrets — and the split between
       * "mine, predicted" and "theirs, replicated" happens inside the match, which is the only
       * place that knows which entity id is this client's.
       */
      net.onProjectiles = (projectiles, smoke) => {
        this.match.applyReplicatedProjectiles(projectiles, smoke);
      };

      net.onAuthoritativeState = (header) => {
        this.divergence.check(
          header,
          this.match.flow,
          this.match.mode.teamScore('A'),
          this.match.mode.teamScore('B'),
        );
      };

      /**
       * The killfeed and the scoreboard resolve ids to names, and on a networked client the
       * only place those names exist is the snapshot. See `NetSession.directory`.
       */
      this.match.flow.setKillfeedDirectory(net.directory());
      net.onRosterEntry = (entityId, name, team) => {
        this.match.score.register(entityId, name, team);
      };

      /**
       * Take up the connection the handshake already made.
       *
       * Nothing is awaited here any more, and that is the point: the socket was opened and
       * the `Welcome` decoded *before* this constructor ran, which is what let `deps.mapEntry`
       * be the server's map instead of the client's guess. A connection failure never reaches
       * this far — `Game` catches it and stays in the menu with a reason on screen.
       */
      net.start();
      netLog.info(`world built for ${net.welcome.modeId} on ${net.welcome.mapId} (server's choice).`);
    }

    this.matchEndedSubscription = deps.bus.on(EV.MatchEnded, () => deps.onMatchEnded());

    this.debug = new DebugSuite({
      host: deps.debugHost,
      bus: deps.bus,
      loop: deps.loop,
      renderer: deps.renderer,
      scene: deps.scene,
      audio: deps.audio,
      player,
      cameraRig: deps.cameraRig,
      map,
      mapEntry: deps.mapEntry,
      transport: deps.transport,
      netSession: () => this.net,
      match: this.match,
      movementConfig: deps.movementConfig,
      cameraConfig: deps.cameraConfig,
      weaponDef: deps.weaponDef,
      viewmodelConfig: deps.viewmodelConfig,
      healthConfig: deps.healthConfig,
      equipmentConfig: deps.equipmentConfig,
      tiers: deps.tiers,
      perceptionConfig: deps.perceptionConfig,
      schedulerConfig: deps.schedulerConfig,
      stats: deps.stats,
      speedo: deps.speedo,
      matchHarness: deps.matchHarness,
      profile: deps.profile,
      onConfigChanged: deps.onConfigChanged,
      onWeaponConfigChanged: deps.onWeaponConfigChanged,
      // M11 (§7). Owned by `Game` because they outlive a world: the build runs across the very
      // transition that replaces this suite, and the migration windows span both sides of it.
      divergence: this.divergence,
      lastBuild: deps.lastBuild,
      buildProgress: deps.buildProgress,
      migrationWindows: deps.migrationWindows,
    });
  }

  get botHarness(): BotHarness | null {
    return this.harness;
  }

  /**
   * The command this client sends, or steps locally, this tick. Both runtimes, one rule.
   *
   * `NetClient` applies the authoritative half of it again from the replicated flags, and the
   * two agreeing is what keeps prediction from fighting the server through a countdown.
   *
   * The three-way choice `Game.simulate` has always described, in one place instead of two.
   * The networked half of it used to have only the last two branches, and the first one was
   * implemented by not calling `NetClient.update` at all off the `MATCH` screen — which is not
   * the same statement: it neutralises the input by going silent, and a silent client is a
   * client the server reaps. See `MatchWorldDeps.inMatch`.
   *
   * - Not in a match — a front-end screen owns the page: nothing at all, so the body stands
   *   where it was left (S6.2's repeat-last-command covers the gap the same way).
   * - Dead, or a UI surface has focus, or the pre-match freeze is on: view angles only.
   *   `sampleSpectating` keeps `Btn.Scoreboard` through a death on purpose (M4), which is what
   *   makes the board reachable from the death screen. The freeze is applied here rather than
   *   inside `Match` because movement is integrated before the match ever sees the command, so
   *   a check one layer in would arrive a frame after the player had already moved.
   * - Otherwise the real thing.
   *
   * The camera is untouched by all of it: yaw and pitch are integrated in the mousemove handler
   * and stamped onto whatever command comes out, so looking around still works.
   */
  sampleCommand(tick: number): InputCommand {
    const input = this.deps.input;
    const nowMsValue = performance.now();
    if (!this.deps.inMatch()) return input.sampleNeutral(tick, nowMsValue);
    if (this.match.isPlayerDead || this.match.inputSuppressed) {
      return input.sampleSpectating(tick, nowMsValue);
    }
    return input.sample(tick, nowMsValue);
  }

  /**
   * Advance everything that consumes a command but must never be replayed.
   *
   * The weapon, and only the weapon. See `Prediction` for the full reasoning: replaying it
   * would fire its rounds again and empty the magazine at the replay rate.
   */
  private applyWeaponForNet(cmd: InputCommand): void {
    this.match.simulate(cmd);
  }

  /**
   * Attach the AFK bot-match driver (`?harness=botmatch`).
   *
   * Built here rather than in `Game` so the harness has the same lifetime as the world it is
   * driving — a harness that outlived a teardown would be holding a match that no longer
   * exists, which is the exact shape of leak the heap run is built to catch.
   */
  startBotHarness(options: BotHarnessOptions): BotHarness {
    const harness = new BotHarness(options, this.match, this.deps.loop, this.deps.stats);
    this.harness = harness;
    harness.start();
    return harness;
  }

  /**
   * Live retune from the tuning panel: push movement config into the two things that cached
   * it at construction. The FOV and the profile write are `Game`'s, because they outlive the
   * world.
   */
  applyMovementConfig(): void {
    const cfg = this.deps.movementConfig;
    this.player.setConfig(cfg);
    this.map.collision.configure(cfg.maxSlopeDeg, cfg.collisionSkin);
  }

  /**
   * Live retune of the weapon and health numbers.
   *
   * Health still reaches the bots, because both sides regenerating differently would break
   * the damage maths that makes TTK legible. The *weapon* deliberately does not: from M7 each
   * bot draws its own from `BotArsenal`, so pushing the player's def across the roster would
   * undo the variety the draw exists to create. `BotDirector.applyWeaponDef` is still there
   * for the controlled measurements that want a flat roster.
   */
  applyWeaponConfig(): void {
    const deps = this.deps;
    this.match.weapons.setDefinition(deps.weaponDef);
    this.match.playerHealth.setConfig(deps.healthConfig);
    for (const dummy of this.match.range?.dummies ?? []) {
      dummy.health.setConfig(deps.healthConfig);
      dummy.markLabelDirty();
    }
    this.match.bots.applyHealthConfig(deps.healthConfig);
  }

  /**
   * Take the world apart. The exact mirror of the constructor.
   *
   * Order matters only in that the debug tooling holds references to the match and the map,
   * so it goes first. Everything added to the scene is removed and everything with a
   * `dispose` gets it — including the map's geometries and materials, which are the largest
   * thing a match allocates.
   */
  /**
   * Take the world apart.
   *
   * `keepConnection` is for a **map rotation** (M10, playtest round 2). The server ending one
   * match and starting another is not a disconnect: the socket stays up, the seat stays
   * assigned, and only the world has to be rebuilt. Closing the link here and reopening it
   * would drop the player out of a match they never left, and on a busy server they might not
   * get back in.
   */
  dispose(options: { keepConnection?: boolean } = {}): void {
    this.matchEndedSubscription();
    if (options.keepConnection === true) this.net?.detach();
    else this.net?.disconnect('left the match');

    this.debug.dispose();
    this.harness?.stop();
    this.harness = null;

    this.match.dispose();

    this.deps.scene.remove(this.map.root);
    this.particulate?.dispose();
    this.map.dispose();

    this.deps.scene.fog = null;
    this.deps.scene.background = null;
  }
}

/** Narrow the nullable field for the renderer's supplier without a cast at the call site. */
function netSessionActors(net: NetSession | null): Iterable<RenderableActor> {
  return net === null ? EMPTY_ACTORS : net.renderables();
}

const EMPTY_ACTORS: readonly RenderableActor[] = [];

/**
 * A streak id as its index in `STREAK_DEFS` (Gate B, §8.22).
 *
 * The mirror of the server's own lookup in `MatchInstance`. Both runtimes build the table from
 * the same module in the same order, so the index is identity — and a string on the wire for a
 * value drawn from a fixed six-entry table is fifteen bytes spent saying what one says.
 */
function streakKindIndex(id: StreakId): number {
  const at = STREAK_DEFS.findIndex((d) => d.id === id);
  return at < 0 ? 0 : at;
}
