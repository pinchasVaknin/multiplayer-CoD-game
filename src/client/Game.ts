import * as THREE from 'three';
import { DEFAULT_SCHEDULER, type SchedulerConfig } from '../shared/ai/AiScheduler';
import {
  cloneTierTable,
  DEFAULT_PERCEPTION,
  DEFAULT_TIERS,
  type PerceptionConfig,
  type TierTable,
} from '../shared/ai/DifficultyTiers';
import { EV, createGameBus, type GameBus } from '../shared/core/Events';
import { Input } from './input/Input';
import { defaultBindings } from '../shared/core/Keybinds';
import type { InputCommand } from '../shared/core/InputCommand';
import { MAX_STEPS_PER_FRAME, type FrameSample } from '../shared/core/Loop';
import { Loop } from './engine/FrameLoop';
import { ChopperCamera } from './streaks/ChopperCamera';
import { DEG2RAD } from '../shared/core/MathUtil';
import { LocalBotTransport, type ICommandQueue } from '../shared/net/Transport';
import { isServerConfigured, multiplayerJoinOptions } from './net/JoinOptions';
import { handshake, HandshakeError, type HandshakeOptions } from './net/Handshake';
import { logger } from '../shared/core/Log';
import type { SummaryInfo, WelcomeInfo } from '../shared/net/Messages';
import type { SkirmishSink } from '../shared/net/NetClient';
import { toNetLoadout, type NetLoadout } from '../shared/net/Skirmish';
import { LoadingScreen } from './ui/LoadingScreen';
import { VoteOverlay } from './ui/VoteOverlay';
import { MapBuildQueue, type BuildReport } from './world/MapBuildQueue';
import type { NetworkedMatchOptions } from './MatchWorld';
import { CameraRig, type CameraDrive } from './engine/CameraRig';
import { ProceduralAudio } from './engine/ProceduralAudio';
import { ProceduralTextures } from './engine/ProceduralTextures';
import { Renderer } from './engine/Renderer';
import { parseHarnessOptions } from './debug/BotHarness';
import type { BotHarness } from './debug/BotHarness';
import type { DebugSuite } from './debug/DebugSuite';
import { FrameStats } from './debug/FrameStats';
import { installConsoleApi } from './debug/ConsoleApi';
import { Harness } from './debug/Harness';
import { MatchHarness } from './debug/MatchHarness';
import { Speedometer } from './debug/Speedometer';
import { isLegalGameTransition, type GameStateId } from '../shared/core/GameStates';
import type { Match } from './ClientMatch';
import type { MatchResult } from '../shared/modes/GameMode';
import type { XpReport } from '../shared/meta/XpRules';
import { PLAYER_ENTITY_ID } from '../shared/combat/DamageSystem';
import { MatchWorld } from './MatchWorld';
import { GameScreens } from './GameScreens';
import { applyEquippedLoadout, asModeId } from './GameLoadout';
import type { ResolvedLoadout } from '../shared/meta/Loadouts';
import { Profile } from './meta/Profile';
import { defaultSettings, type SettingsV1 } from '../shared/meta/SaveData';
import {
  DEFAULT_MAP_ID,
  DEFAULT_MODE_ID,
  findMap,
  findMode,
  resolveMapId,
  resolveModeId,
} from '../shared/modes/ModeRegistry';
import { DEFAULT_CAMERA_CONFIG, FOV_MAX, FOV_MIN, type CameraConfig } from './player/CameraConfig';
import { DEFAULT_HEALTH_CONFIG, type HealthConfig } from '../shared/player/Health';
import { DEFAULT_MOVEMENT_CONFIG, cloneMovementConfig, type MovementConfig } from '../shared/player/MovementConfig';
import type { PlayerController } from '../shared/player/PlayerController';
import { ViewmodelLayer } from './player/Viewmodel';
import type { MenuSelection } from './ui/Menus';
import { FpsCounter } from './ui/FpsCounter';
import { palette } from './ui/Palette';
import { Settings } from './ui/Settings';
import {
  cloneEquipmentConfig,
  DEFAULT_EQUIPMENT_CONFIG,
  type EquipmentConfig,
} from '../shared/equipment/EquipmentConfig';
import { AR_DEFAULT, cloneWeaponDef, PISTOL_DEFAULT, type WeaponDef } from '../shared/weapons/WeaponDefs';
import { cloneViewmodelConfig, DEFAULT_VIEWMODEL_CONFIG, type ViewmodelConfig } from '../shared/weapons/ViewmodelConfig';
import type { LoadedMap } from './world/MapRender';

/**
 * Application root and the top-level state machine (S6.3): BOOT -> MENU -> MATCH -> SUMMARY.
 *
 * ## The world is per-match, and it lives next door
 *
 * M1-M3 built the map, the player and the match once at boot and kept them for the life of
 * the page, because there was only ever one of each. M4 has a map *choice* and a summary
 * screen you come back from, so the world is built on entering MATCH and **fully disposed on
 * leaving SUMMARY** — S6.3's "loading a map twice must not double anything".
 *
 * M4 put that in this file as `buildWorld` / `teardownWorld` plus six nullable fields, and by
 * M6 those fields were threaded through `simulate`, `draw`, five state handlers and eight
 * getters. M7 moved the whole lifecycle to `MatchWorld`, so what is left here is the state
 * machine, the loop and the front end — and the six fields that were always null together
 * became one field that is sometimes null. Every method below asks once, at the top.
 *
 * What survives a match is what is genuinely process-wide: the renderer, the textures, the
 * audio graph, the input listener, the frame-stats buffer, the profile and the config objects
 * the tuning panel holds references to. All of them are fields here and are handed to
 * `MatchWorld` rather than owned by it. `MatchHarness` runs the build/teardown cycle
 * repeatedly and logs the heap at each boundary, which is the test that the split is honest.
 */

interface StateHandlers {
  enter?: (from: GameStateId) => void;
  exit?: (to: GameStateId) => void;
}

const stateChangePayload = { from: 'BOOT' as GameStateId, to: 'BOOT' as GameStateId };

const netLog = logger('join');

/**
 * Milliseconds of building per frame once the loading screen is up (§4.18).
 *
 * Two orders of magnitude above the background budget, and deliberately: the match has already
 * started without this client, the screen is covering the world, and every frame spent
 * trickling chunks is a frame they are not playing. The background path optimises for not being
 * noticed; this one optimises for being over.
 */
const LOADING_DRAIN_BUDGET_MS = 200;

/** The §7 window: *"misprediction count in the first 60 ticks after migration"*. */
const POST_MIGRATION_WINDOW_TICKS = 60;

/** Windows kept for the panel. A long session migrates twice a minute; this is an hour of them. */
const MAX_MIGRATION_WINDOWS = 120;

/**
 * The server's authoritative summary, in the shape the M6 summary screen already renders.
 *
 * A projection and nothing more: no number is recomputed, no winner is re-derived. The point
 * is that the screen built in M6 for single-player renders a networked result without knowing
 * it is one, which is the same seam S3 asks for on the event bus.
 */
function netMatchResult(net: SummaryInfo): MatchResult {
  return {
    kind: 'match',
    winner: net.winner as MatchResult['winner'],
    reason: net.reason,
    scoreA: net.scoreA,
    scoreB: net.scoreB,
    roundsA: 0,
    roundsB: 0,
  };
}

export class Game {
  readonly bus: GameBus = createGameBus();
  readonly movementConfig: MovementConfig = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
  readonly cameraConfig: CameraConfig = { ...DEFAULT_CAMERA_CONFIG };
  /**
   * The live primary and secondary.
   *
   * These are *mutable clones* the tuning panel writes into, which is why they are fields
   * rather than the shipped defs. M5's weapon picker replaces their contents wholesale by
   * copying a different `WeaponDef` over them (`setPrimary`), so the tuning panel keeps
   * pointing at the same two objects across a weapon change and nothing has to resubscribe.
   */
  readonly weaponDef: WeaponDef = cloneWeaponDef(AR_DEFAULT);
  readonly secondaryDef: WeaponDef = cloneWeaponDef(PISTOL_DEFAULT);
  /**
   * The base of the player's primary: the resolved loadout with attachments and perks
   * stripped back off. Read by the M6 modifier panel; see `MatchDeps.playerBaseDef`.
   */
  readonly playerBaseDef: WeaponDef = cloneWeaponDef(AR_DEFAULT);
  readonly viewmodelConfig: ViewmodelConfig = cloneViewmodelConfig(DEFAULT_VIEWMODEL_CONFIG);
  readonly healthConfig: HealthConfig = { ...DEFAULT_HEALTH_CONFIG };
  readonly equipmentConfig: EquipmentConfig = cloneEquipmentConfig(DEFAULT_EQUIPMENT_CONFIG);
  readonly tiers: TierTable = cloneTierTable(DEFAULT_TIERS);
  readonly perceptionConfig: PerceptionConfig = { ...DEFAULT_PERCEPTION };
  readonly schedulerConfig: SchedulerConfig = { ...DEFAULT_SCHEDULER };

  /**
   * Frame statistics and the speedometer outlive a match deliberately: the three-match heap
   * run needs one continuous frame-time history across the boundaries it is measuring.
   */
  readonly stats = new FrameStats();
  readonly speedo = new Speedometer();
  /**
   * M8. Process-wide, like `stats`: a player who turns on an FPS counter expects it on the
   * menu as well as in a match, and the HUD is torn down between rounds.
   */
  private readonly fpsCounter: FpsCounter;
  /** M8. The settings screen. Built at boot and kept, like every other front-end screen. */
  private readonly settingsScreen: Settings;

  private readonly scene = new THREE.Scene();
  private readonly renderer: Renderer;
  private readonly textures: ProceduralTextures;
  private readonly viewmodel: ViewmodelLayer;
  private readonly cameraRig: CameraRig;
  private readonly audio = new ProceduralAudio();
  private readonly screens: GameScreens;
  private readonly uiHost: HTMLElement;
  private readonly debugHost: HTMLElement;
  /** M6: the one save object. Owns settings, progression, loadouts and challenges. */
  readonly profile: Profile;
  private readonly transport: ICommandQueue = new LocalBotTransport(64);

  /**
   * The server to join, or null for single-player (M10).
   *
   * Read once at construction from the query string. Null is the default and is what every
   * path built in M1-M8 still takes — HARD RULE 8 requires opening the page to behave exactly
   * as it did, and it does.
   */

  /**
   * The connection and the `Welcome`, once the handshake has completed (M10, playtest
   * round 2).
   *
   * `buildWorld` reads the map and the mode **out of this** rather than out of
   * `this.selection`. That inversion is the fix for the reported map/mode desync: the client
   * used to load whatever the front end had selected and then dial a server that was running
   * something else, and every consequence of the two disagreeing — spawning outside the
   * world, walking through walls, a rubber-band on every step — looked like a netcode fault
   * and was a loading fault.
   *
   * Null in single-player and while nothing is connected.
   */
  private server: NetworkedMatchOptions | null = null;

  /** True while the handshake is in flight, so a second click cannot start a second one. */
  private joining = false;

  // ---- M11: the skirmish flow ----------------------------------------------

  /** Set by the Play Multiplayer button. Wins over `?server=`. See `launchMatch`. */
  private multiplayerJoin: HandshakeOptions | null = null;

  /** The non-blocking vote overlay (§4.20). Built at boot, shown only while balloting. */
  private readonly voteOverlay: VoteOverlay;

  /** The chunked background map build (§6.5). Pumped from the render pass. */
  private readonly buildQueue: MapBuildQueue;

  /** The §4.18 fallback, for a client whose build did not finish before the migration. */
  private readonly loadingScreen: LoadingScreen;

  /** Frames the migration is held so the loading screen can paint. See the migration branch. */
  private loadingHeldFrames = 0;

  /** The last completed background build, for the §7 panel. */
  private lastBuildReport: BuildReport | null = null;

  /**
   * Post-migration misprediction windows (§7, §8.9).
   *
   * *"Misprediction count in the first 60 ticks after migration, which is the direct regression
   * test for Tier 1 #20."* One entry per migration, opened when the move lands and closed sixty
   * ticks later. Bounded, because a long session migrates twice a minute and an unbounded array
   * in a diagnostic is a slow leak in the tool built to find them.
   */
  private readonly migrationWindows: { matchId: number; tick: number; mispredictions: number }[] = [];
  private openWindow: { untilTick: number; baseline: number; index: number } | null = null;

  /**
   * A migration the server has announced, acted on from the render pass.
   *
   * Same reasoning as `pendingRotation`: it arrives inside a snapshot decode, and tearing the
   * world down from there is a null dereference in the middle of an event dispatch.
   */
  private pendingMigration: WelcomeInfo | null = null;

  /** The most recent summary from a live match, held until SUMMARY renders it (§6.9). */
  private pendingNetSummary: SummaryInfo | null = null;

  /** The instance a `Prepare` named, so the readiness report is addressed to it (§6.5). */
  private pendingMatchId = -1;

  /**
   * How long the server said to hold the summary, seconds (§6.9: 12-15 s).
   *
   * Held rather than counted down here: the server migrates everybody back on its own clock,
   * and a client that decided for itself when the summary was over would leave early and sit
   * in a torn-down world. This exists so the screen can *say* how long is left, not so it can
   * act on it. Zero in single-player, where the player leaves when they press Continue.
   */
  private summaryHoldSeconds = 0;

  /**
   * Set when the server rotates to a new match while we are in one.
   *
   * Acted on from the render pass rather than from inside the network update, for the same
   * reason `pendingSummary` is: tearing down the world from inside a callback the world is
   * currently iterating is how you get a null dereference in the middle of an event dispatch.
   */
  private pendingRotation: WelcomeInfo | null = null;

  /** True for the duration of `applyRotation`. See `teardownWorld`. */
  private rotating = false;

  /**
   * Keeps the connection alive while the tab is hidden (M10).
   *
   * `requestAnimationFrame` is **completely suspended** in a background tab — not throttled,
   * suspended — so the frame loop stops, `simulate` stops, and with it every ping and every
   * command. Measured: a hidden tab sends nothing at all, and the server's 10-second
   * inactivity timeout (S6.1) drops it. Alt-tabbing for fifteen seconds would disconnect you.
   *
   * So when the page goes hidden the network gets its own timer. It pumps the same
   * `NetSession.update()` the frame loop would have — polling, acking and pinging — and the
   * commands it samples are empty, because `Input.clearHeld` fires on blur. The player stands
   * still and stays connected, which is what everyone expects alt-tab to do.
   *
   * The *simulation* deliberately does not run on this timer. The client's tick number comes
   * from the synced server clock (S4.11), so on returning it resynchronises by itself rather
   * than trying to catch up on a minute of missed ticks.
   */
  private hiddenNetTimer: ReturnType<typeof setInterval> | null = null;
  private readonly input: Input;
  private readonly loop: Loop;
  private readonly selection: MenuSelection;
  /** M9. Process-wide: the takeover is per-match, the camera object need not be. */
  private readonly chopperCamera = new ChopperCamera();

  /**
   * The per-match world: the map, the player, the match and its debug tooling.
   *
   * One nullable field rather than six, because they were only ever all present or all
   * absent. Null outside a match; `MatchWorld` itself has no optional members.
   */
  private world: MatchWorld | null = null;

  // ---- process-wide -------------------------------------------------------
  private readonly harness: Harness;
  private readonly matchHarness: MatchHarness;

  private readonly states = new Map<GameStateId, StateHandlers>();
  private state: GameStateId = 'BOOT';

  private readonly drainBuffer: InputCommand[] = [];
  private readonly drive: CameraDrive = {
    sprint: false,
    tacSprint: false,
    slide: false,
    adsFraction: 0,
    adsFovScale: 1,
    adsViewmodelFovScale: 1,
  };
  private lastRenderMs = performance.now();
  /** Set when the mode declares the match over; SUMMARY is entered from the render pass. */
  private pendingSummary = false;
  /** Whether F1 was open when the match was paused, so resuming can put it back. */
  private overlayWasOpenBeforePause = false;
  /** Where the settings screen's Back button goes. Captured on entry (M8). */
  private settingsReturn: GameStateId = 'MENU';
  /** Where Back from the loadout editor goes. Captured on entry. See the LOADOUT state. */
  private loadoutReturn: GameStateId = 'MENU';

  constructor(canvas: HTMLCanvasElement, uiHost: HTMLElement, debugHost: HTMLElement) {
    // M6: one save object for everything (S6.6). Settings used to live in their own store;
    // `Profile` carries the old blob across on first load so nobody's FOV resets.
    this.profile = new Profile({
      fallbackSettings: defaultSettings(DEFAULT_MODE_ID, DEFAULT_MAP_ID, DEFAULT_CAMERA_CONFIG.fov),
    });
    const settings = this.profile.settings;
    this.cameraConfig.fov = clampFov(settings.fov);
    /**
     * The saved selection, resolved against the registry rather than trusted.
     *
     * `normaliseSave` validates every other field of the save but stores `mapId` and
     * `modeId` as bare strings, so a save written before the map ids were prefixed carries
     * `foundry` where the registry now has `mp_foundry`. Resolving here rather than at each
     * of the six `findMap`/`findMode` call sites means the selection is *known good* from
     * construction on, and those calls keep throwing — which is correct for a code path
     * that asks for a map that does not exist.
     */
    this.selection = {
      modeId: resolveModeId(asModeId(settings.modeId)).id,
      mapId: resolveMapId(settings.mapId).id,
    };

    this.renderer = new Renderer(canvas);
    this.renderer.setSize(window.innerWidth, window.innerHeight, settings.renderScale);
    this.textures = new ProceduralTextures(this.renderer.three);
    this.uiHost = uiHost;
    this.debugHost = debugHost;
    this.viewmodel = new ViewmodelLayer(this.cameraConfig);
    this.viewmodel.resize(this.renderer.aspect);
    // The capsule radius is what bounds how close the eye can get to a wall, and therefore
    // how far out the near plane may sit before it clips one. See `CameraRig.nearFor`.
    this.cameraRig = new CameraRig(
      this.cameraConfig,
      this.renderer.aspect,
      this.movementConfig.capsuleRadius,
    );

    this.screens = new GameScreens({
      host: uiHost,
      profile: this.profile,
      audio: this.audio,
      selection: this.selection,
      // Connect before building anything, so the server dictates the map. See `launchMatch`.
      /**
       * Play Solo's Start button. Never connects — see `launchMatch`.
       *
       * `multiplayerJoin` is cleared first because it survives a return to the menu: a player
       * who played multiplayer, quit to the menu and then chose Play Solo would otherwise be
       * dialled straight back into the arena by the leftover options.
       */
      onLaunch: () => {
        this.multiplayerJoin = null;
        void this.launchMatch();
      },
      onPlayMultiplayer: () => void this.playMultiplayer(),
      serverConfigured: () => isServerConfigured(window.location.search),
      displayName: () => this.profile.settings.callsign,
      onDisplayName: (name) => this.profile.patchSettings({ callsign: name }),
      onLoadout: () => this.transitionTo('LOADOUT'),
      onSettings: () => this.transitionTo('SETTINGS'),
      onLoadoutBack: () => this.transitionTo(this.loadoutReturn),
      onQuitToMenu: () => this.transitionTo('MENU'),
      onResume: () => this.resumeFromPause(),
      onToggleOverlay: () => this.toggleOverlayFromPause(),
      onLeaveSummary: () => this.transitionTo('MENU'),
      statusLine: () => this.statusLine(),
      pauseStatusLine: () => this.pauseStatusLine(),
      unrestricted: () => findMode(this.selection.modeId).unrestricted,
    });

    this.input = new Input({
      canvas,
      sensitivity: settings.sensitivity,
      invertY: settings.invertY,
      bindings: settings.bindings,
    });
    this.input.onLockChange((locked) => this.onPointerLockChange(locked));
    this.input.onEscape(() => this.onEscape());
    /**
     * Digit keys vote while a ballot is open (M11, §6.4).
     *
     * Returning true consumes the key, so 1-5 do not also swap weapons and call in killstreaks
     * during the twenty seconds a ballot is up. The overlay answers false whenever no ballot is
     * open, which is every other moment of the game.
     */
    this.input.onDigit((digit) => this.voteOverlay.handleDigit(digit));

    this.fpsCounter = new FpsCounter(uiHost, this.stats);

    /**
     * The vote overlay and the background build, both process-wide (M11).
     *
     * Built at boot and kept, like every other front-end surface: they outlive a match by
     * design. The build queue in particular *must* — its whole purpose is to be working on the
     * next map while the current world is still up, and a queue owned by the world would be
     * disposed by the transition it exists to make seamless.
     */
    this.loadingScreen = new LoadingScreen(uiHost);

    this.voteOverlay = new VoteOverlay({
      host: uiHost,
      onVote: (phase, option) => this.world?.net?.client.sendVote(phase, option),
      currentTick: () => this.world?.net?.client.stats.clientTick ?? 0,
    });

    this.buildQueue = new MapBuildQueue({
      textures: this.textures,
      shadowQuality: () => this.profile.settings.shadowQuality,
      onComplete: (mapId, _built, report) => {
        this.lastBuildReport = report;
        // Report ready the moment the build lands, which is what `READY_WAIT` is waiting on.
        // The map itself is held by the queue until the migration that needs it arrives.
        const client = this.world?.net?.client;
        // Addressed to the match being prepared, not the one we are seated in — the whole
        // point is that we are still in the arena while this builds. The server rejects and
        // logs a `Ready` for any other instance (§8.15).
        client?.sendReady(this.pendingMatchId);
        netLog.info(
          `background build for ${mapId}: ${report.elapsedMs}ms wall, ${report.workMs}ms work, ` +
            `${report.chunks} chunks, worst chunk ${report.worstChunkMs}ms.`,
        );
      },
    });
    this.settingsScreen = new Settings({
      host: uiHost,
      read: () => this.profile.settings,
      onChange: (patch) => this.applySettings(patch),
      onBack: () => this.transitionTo(this.settingsReturn),
      onResetBindings: () => this.applySettings({ bindings: defaultBindings() }),
    });

    this.loop = new Loop({
      sim: (tick) => this.simulate(tick),
      render: (alpha) => this.draw(alpha),
      onFrame: (sample) => this.onFrame(sample),
    });

    this.harness = new Harness(this.movementConfig);
    this.matchHarness = new MatchHarness({
      game: this,
      loop: this.loop,
      stats: this.stats,
    });

    this.registerStates();
    // M8: push the loaded settings through the one apply path, so what is on screen at boot
    // is what the save says and there is no separate "initial" wiring to drift from it.
    this.applySettings({});
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
    // The page may already be hidden when the game boots — an unfocused tab, or a headless
    // run. Evaluating once at construction rather than waiting for a change that has already
    // happened is what makes that case work rather than silently never connecting.
    this.onVisibility();
  }

  get currentState(): GameStateId {
    return this.state;
  }

  get activeMatch(): Match | null {
    return this.world?.match ?? null;
  }

  get menuSelection(): MenuSelection {
    return this.selection;
  }

  /**
   * The loaded map, or null outside a match.
   *
   * Public because `public/verify/*.js` reach for `game.map` and `game.player` to drive the
   * real collision world and the real controller. Until M7 those were private fields the
   * scripts read anyway — TypeScript's `private` is compile-time only — so the refactor that
   * moved them into `MatchWorld` would have silently broken six shipped acceptance suites.
   * They are getters now, which is what they always were in practice.
   */
  get map(): LoadedMap | null {
    return this.world?.map ?? null;
  }

  get player(): PlayerController | null {
    return this.world?.player ?? null;
  }

  /** The per-match debug tooling, or null outside a match. */
  get debugSuite(): DebugSuite | null {
    return this.world?.debug ?? null;
  }

  /**
   * The input seam, for the console API and the verification scripts.
   *
   * Read-only in practice: nothing outside `Game` drives it, and the two things a script
   * wants to know — whether the cursor is captured and whether a click would recapture it —
   * are not observable any other way.
   */
  /** Backing-buffer pixels per CSS pixel. Read by the render-scale sweep (M8). */
  get rendererPixelRatio(): number {
    return this.renderer.pixelRatio;
  }

  /**
   * The loop, for the hand-over tools (M8).
   *
   * Exposed rather than passed, because `installConsoleApi` is called from inside `BOOT`
   * and the tools it builds outlive every match. Read-only in practice: the only things
   * that drive the loop are `Game` and the two harnesses that already hold it.
   */
  get loopHandle(): Loop {
    return this.loop;
  }

  get inputState(): Input {
    return this.input;
  }

  get activeBotHarness(): BotHarness | null {
    return this.world?.botHarness ?? null;
  }

  /** The live player simulation state, or undefined outside a match. */
  get playerSim(): PlayerController['sim'] | undefined {
    return this.world?.player.sim;
  }

  /** Debug lever: burn this many milliseconds inside every frame (S7). */
  setSyntheticLoad(ms: number): void {
    this.loop.syntheticLoadMs = ms;
  }

  /** Kick the machine. BOOT starts the loop, then hands over to MENU. */
  start(): void {
    this.enterState('BOOT');
  }

  transitionTo(next: GameStateId): void {
    if (next === this.state) return;
    if (!isLegalGameTransition(this.state, next)) {
      throw new Error(`Illegal game transition ${this.state} -> ${next}`);
    }
    const handlers = this.states.get(next);
    if (handlers === undefined) {
      throw new Error(
        `Game state "${next}" has no handler registered. It is declared in GameStates.ts ` +
          `but not implemented in this milestone.`,
      );
    }
    const from = this.state;
    this.states.get(from)?.exit?.(next);
    this.state = next;
    // Post-M8: physical inputs only resolve to game actions inside a match. A front-end
    // screen owns the page, and the wheel and the arrow keys have to reach it — see
    // `Input.bindingsActive` for the scroll bug this closes.
    this.input.setBindingsActive(next === 'MATCH');
    handlers.enter?.(from);
    stateChangePayload.from = from;
    stateChangePayload.to = next;
    this.bus.emit(EV.GameStateChanged, stateChangePayload);
  }

  // -- state wiring --------------------------------------------------------

  private registerStates(): void {
    this.states.set('BOOT', {
      enter: () => {
        this.screens.menus.showBoot('Loading…');
        // The loop runs from boot so the menu is composited and the frame source is live
        // before any map exists. Deliberately a timeout rather than requestAnimationFrame:
        // rAF never fires in a background tab, and booting into a tab the user has not
        // focused yet would hang forever.
        this.loop.start();
        this.transport.open();
        installConsoleApi(this, this.harness, this.matchHarness);
        window.setTimeout(() => {
          this.transitionTo('MENU');
          this.startBotHarnessIfRequested();
        }, 32);
      },
    });

    this.states.set('MENU', {
      enter: () => {
        this.screens.menus.show();
        this.input.clearHeld();
      },
      exit: () => this.screens.menus.hide(),
    });

    /**
     * LOADOUT (M6). Declared in `GameStates.ts` since M1 with no handler; this is it.
     *
     * No world is built and no simulation runs — Create-a-Class is a front-end screen that
     * reads and writes the profile, and every edit persists through `Profile` as it is
     * made rather than on the way out. It is reachable from the menu and from the pause
     * screen, which is S6.3's "between spawns".
     */
    this.states.set('LOADOUT', {
      enter: (from) => {
        /**
         * Remember where Back goes (M11, §6.6).
         *
         * The editor is reachable from the menu, from the pause screen and — new in M11 — from
         * inside the warmup arena, and Back must return to whichever one sent it. Before this,
         * Back always went to `MENU`, which tore the world down: a player who opened Create a
         * Class from a live arena to change a perk was dropped out of the server to do it.
         *
         * Same capture-on-entry as `settingsReturn`, and for the same reason.
         */
        this.loadoutReturn = from === 'MENU' ? 'MENU' : from;
        this.input.clearHeld();
        this.screens.loadoutEditor.show();
      },
      exit: (to) => {
        this.screens.loadoutEditor.hide();
        if (to === 'MENU') {
          this.teardownWorld();
          return;
        }
        // Back into a match that is still standing: hand the new class over live. A world
        // that was never torn down is the paused case, and `buildWorld` would no-op.
        if (this.world !== null) this.world.match.applyLoadout(this.applyLoadout());

        /**
         * Tell the server, which applies it on the next spawn (§6.6, Tier 1 #20).
         *
         * The local half above changes what this client predicts with; this is the half that
         * changes what the server simulates with. They must land on the same tick or the gap
         * between them is a misprediction on every tick inside it — so the server defers to the
         * next spawn, and the client's own `applyLoadout` is likewise a next-spawn change on a
         * living player. See `ServerMatch.setPendingLoadout`.
         *
         * The same ids are then locked into the `MatchRequest` at migration, which is what
         * carries the edit into the live match.
         */
        const client = this.world?.net?.client;
        const loadout = this.netLoadout();
        if (client !== undefined && loadout !== null) {
          client.sendLoadout(loadout);
          netLog.info(`sent class "${loadout.name}" to the server; applies on next spawn.`);
        }
      },
    });

    /**
     * SETTINGS (M8). A front-end screen with no world, like LOADOUT.
     *
     * `settingsReturn` is where Back goes, captured on the way in — the screen is reachable
     * from the menu and from the pause screen and must come back to whichever one sent it,
     * because a player who paused a match to fix their sensitivity has a match waiting.
     */
    this.states.set('SETTINGS', {
      enter: (from) => {
        this.settingsReturn = from === 'PAUSED' ? 'PAUSED' : 'MENU';
        this.input.clearHeld();
        this.settingsScreen.show();
      },
      exit: (to) => {
        this.settingsScreen.hide();
        if (to === 'MENU') this.teardownWorld();
      },
    });

    this.states.set('MATCH', {
      enter: () => {
        this.audio.start();
        this.buildWorld();
        this.world?.match.setActive(true);
        // The click that started the match must not also pull the trigger.
        this.input.clearHeld();
        // The AFK harness has nobody to capture the cursor for, and asking for it without
        // a user gesture logs a rejection — which would put noise in the console the soak
        // run is there to prove is quiet.
        if (this.world?.botHarness == null && !this.matchHarness.isRunning) {
          // Armed rather than merely requested: resuming from the pause screen with Escape
          // has no user gesture, and resuming with the button can land inside Chrome's
          // post-Escape cooldown. Armed, the next click gets the cursor back either way.
          this.input.armPointerLock(true);
          // Only bites while the page is fullscreen; see Input.lockKeyboard and PLAN.md.
          this.input.lockKeyboard();
        }
      },
      exit: (to) => {
        this.input.unlockKeyboard();
        this.input.armPointerLock(false);
        this.audio.setSlide(false, 0, 0, 0, 0);
        // Pausing keeps the match active and the world built: it is the same match, simply
        // not advancing. Only leaving for good deactivates it.
        if (to === 'PAUSED') return;
        this.input.exitPointerLock();
        this.world?.match.setActive(false);
        // Going back to the menu without a result tears down here; going to SUMMARY keeps
        // the world alive so the scene is still behind the summary screen.
        if (to === 'MENU') this.teardownWorld();
      },
    });

    /**
     * PAUSED (M5). The world stays built and `simulate` stops advancing it.
     *
     * Deliberately not a `Loop.stop()`: the render pass still has to run so the pause
     * screen is composited over a live scene, and `FrameStats` should keep sampling so the
     * histogram does not develop a hole every time somebody pauses.
     */
    this.states.set('PAUSED', {
      enter: () => {
        this.input.clearHeld();
        // Disarmed while paused: a click belongs to the pause menu's buttons, not to
        // recapturing the cursor the player just released.
        this.input.armPointerLock(false);
        this.input.exitPointerLock();
        // Everything else on screen goes away. The overlay is interactive DOM over a
        // modal screen, which is exactly the clash the pause menu was reported for; the
        // pause menu has a button to bring it back deliberately.
        this.hideOverlayForPause();
        this.screens.pauseMenu.show();
      },
      exit: (to) => {
        this.screens.pauseMenu.hide();
        if (to === 'MENU') {
          this.world?.match.setActive(false);
          this.teardownWorld();
        }
      },
    });

    this.states.set('SUMMARY', {
      enter: () => {
        const match = this.world?.match ?? null;
        /**
         * The server's result wins over the local one (M11, §6.9).
         *
         * Over the network the authoritative outcome arrives as `MsgS.Summary`, built by the
         * instance from its own `ScoreSystem` **before teardown**. The client's `MatchFlow` has
         * a result too, reconstructed from replicated state, and where they disagree the
         * server is right by definition — §4.15 puts scores and match flow on the replicated
         * side of the table.
         *
         * The local one is still the fallback, because single-player has no other.
         */
        const net = this.pendingNetSummary;
        this.pendingNetSummary = null;
        const result = net !== null ? netMatchResult(net) : (match?.flow.result ?? null);
        this.summaryHoldSeconds = net?.holdSeconds ?? 0;
        if (match === null || result === null) {
          // Nothing to summarise: this can only happen if SUMMARY is entered by hand.
          this.transitionTo('MENU');
          return;
        }
        // Bank the match here rather than in `MatchEnded`: by this point nothing else is
        // going to change, and the profile is written exactly once (S6.6). `bankProgression`
        // is idempotent, so a harness that re-enters SUMMARY cannot double-count.
        const banks = findMode(this.selection.modeId).banksProgress;
        // "Did I win" is the server's team assignment, not the single-player constant.
        const won = result.winner === match.localTeam;
        /**
         * The server's XP, when there is a server (§6.9).
         *
         * *"XP and challenge progress are awarded by the instance from authoritative events and
         * delivered with the summary, **before teardown**. The client persists them to its own
         * `localStorage` save."* So the client does not compute the total over the network — it
         * receives it, animates it, and banks it. Locally it still computes its own, because in
         * single-player there is nobody else to.
         *
         * Both paths end at `Profile.bankMatch`, which is the one place XP becomes durable.
         */
        const report = net !== null ? this.bankServerXp(net, won) : match.bankProgression(won);
        this.screens.showSummary(
          match,
          result,
          this.mapEntry().name,
          banks ? report : null,
          this.profile.prestige,
          this.summaryHoldSeconds,
        );
      },
      exit: () => {
        this.screens.hideSummary();
        this.teardownWorld();
      },
    });
  }

  private enterState(id: GameStateId): void {
    this.state = id;
    this.input.setBindingsActive(id === 'MATCH');
    this.states.get(id)?.enter?.(id);
  }

  // -- world ---------------------------------------------------------------

  /**
   * The map this match is played on.
   *
   * **The server's answer wins when there is one** (M10, playtest round 2). S4.9 makes the
   * server authoritative over the simulation, and the map is not a presentation choice — it
   * is the collision world every position in every snapshot is expressed against. A client
   * that loaded a different one was not "showing the wrong level", it was predicting against
   * different geometry and being corrected by a server that could see through its walls.
   */
  private mapEntry(): ReturnType<typeof findMap> {
    const server = this.server;
    if (server !== null) return findMap(server.welcome.mapId);
    // A mode may pin its map — the Shooting Range only exists on the grey-box testbed,
    // because that is where the target dummies are built.
    const forced = findMode(this.selection.modeId).forcedMapId;
    return findMap(forced ?? this.selection.mapId);
  }

  /** The mode. The server's when connected, for the same reason as the map. */
  private modeEntry(): ReturnType<typeof findMode> {
    const server = this.server;
    if (server !== null) return findMode(asModeId(server.welcome.modeId));
    return findMode(this.selection.modeId);
  }

  /**
   * Resolve the equipped class into the three long-lived weapon objects.
   *
   * **The mode is the server's when there is one** (M11 playtest). It used to be
   * `this.selection.modeId` — the *local menu* selection — and that is a divergence with teeth:
   * `applyEquippedLoadout` passes the mode's `unrestricted` flag into `resolveEquipped`, and
   * the Shooting Range lifts every unlock gate *and resolves a different slot entirely*. A
   * player whose menu was last left on the range would join a networked FFA, send the class
   * from their equipped slot, and then locally resolve the **range** slot — a different weapon,
   * different perks, and therefore a different `speedScale` from the one the server applied.
   *
   * That is Tier 1 #20 all over again, arriving from the client's side rather than the
   * server's, and it presents identically: a constant per-tick disagreement about speed that
   * reads as rubberbanding.
   */
  private applyLoadout(): ResolvedLoadout {
    return applyEquippedLoadout(this.profile, this.modeEntry().id, {
      primary: this.weaponDef,
      secondary: this.secondaryDef,
      playerBase: this.playerBaseDef,
    });
  }

  /**
   * Build the world this match is played in. Called on entering MATCH, so the map the player
   * picked is the map that loads and a second match starts from nothing rather than from
   * whatever the first one left behind.
   */
  private buildWorld(): void {
    if (this.world !== null) return;
    const modeEntry = this.modeEntry();
    this.world = new MatchWorld({
      bus: this.bus,
      scene: this.scene,
      renderer: this.renderer,
      textures: this.textures,
      viewmodel: this.viewmodel,
      cameraRig: this.cameraRig,
      audio: this.audio,
      input: this.input,
      loop: this.loop,
      transport: this.transport,
      server: this.server,
      uiHost: this.uiHost,
      debugHost: this.debugHost,
      stats: this.stats,
      speedo: this.speedo,
      matchHarness: this.matchHarness,
      profile: this.profile,
      movementConfig: this.movementConfig,
      cameraConfig: this.cameraConfig,
      viewmodelConfig: this.viewmodelConfig,
      healthConfig: this.healthConfig,
      equipmentConfig: this.equipmentConfig,
      weaponDef: this.weaponDef,
      secondaryDef: this.secondaryDef,
      playerBaseDef: this.playerBaseDef,
      tiers: this.tiers,
      perceptionConfig: this.perceptionConfig,
      schedulerConfig: this.schedulerConfig,
      mapEntry: this.mapEntry(),
      modeEntry,
      loadout: this.applyLoadout(),
      onMatchEnded: () => {
        this.pendingSummary = true;
      },
      onConfigChanged: () => this.onConfigChanged(),
      onWeaponConfigChanged: () => this.onWeaponConfigChanged(),
      // M11 (§7). Suppliers rather than values: all three outlive this world, which is the
      // whole point of them — the build spans the transition that replaces it.
      lastBuild: () => this.lastBuildReport,
      buildProgress: () => this.buildQueue.progress,
      migrationWindows: () => this.migrationWindows,
    });
  }

  /**
   * Drop the world. `MatchWorld.dispose` is the mirror of its own constructor.
   *
   * `keepConnection` is the map-rotation case: the server has started a new match on the same
   * socket, so the world goes and the connection stays. Everything else — leaving to the
   * menu, quitting from the pause screen, finishing the summary — is a real departure and
   * closes the link, which is what frees the seat on the server without waiting for a timeout.
   */
  private teardownWorld(options: { keepConnection?: boolean } = {}): void {
    this.pendingSummary = false;
    this.pendingRotation = null;
    // A rotation keeps the socket no matter which teardown runs. The SUMMARY state tears the
    // world down on its way out and has no way to know a rotation is why it is leaving.
    const keep = options.keepConnection === true || this.rotating;
    this.world?.dispose({ keepConnection: keep });
    this.world = null;
    this.speedo.reset();
    if (!keep) this.server = null;
  }

  /**
   * Start a match: connect first if there is a server, and only then build a world (M10,
   * playtest round 2).
   *
   * The ordering is the entire fix for the map/mode desync. `MatchWorld`'s constructor loads
   * a map and spawns the player into it, and it used to run *before* anything was dialled —
   * so the map came from the local menu selection and could not possibly have been the
   * server's. Now nothing is built until the server has said what it is running.
   *
   * A failed join stays in the menu with the reason on screen. It deliberately does **not**
   * fall back to single-player: a player who asked to join a server and silently got a bot
   * match instead would have no way to tell, and would report it as "the server is empty".
   */
  /**
   * Open the sixty-tick misprediction window for a migration that has just landed (§7).
   *
   * The baseline is the running misprediction total at the moment of the move, so what is
   * reported is what happened *inside* the window rather than the count since the page loaded.
   * See `SkirmishPanel` for what a non-zero value means.
   */
  private openMigrationWindow(matchId: number): void {
    const client = this.world?.net?.client;
    if (client === undefined) return;
    const tick = client.effectiveTick;
    this.migrationWindows.push({ matchId, tick, mispredictions: 0 });
    if (this.migrationWindows.length > MAX_MIGRATION_WINDOWS) this.migrationWindows.shift();
    this.openWindow = {
      untilTick: client.stats.clientTick + POST_MIGRATION_WINDOW_TICKS,
      baseline: client.prediction.stats.mispredictions,
      index: this.migrationWindows.length - 1,
    };
  }

  /** Close the window once it has run its sixty ticks. Called from the render pass. */
  private pumpMigrationWindow(): void {
    const open = this.openWindow;
    const client = this.world?.net?.client;
    if (open === null || client === undefined) return;
    const entry = this.migrationWindows[open.index];
    if (entry === undefined) {
      this.openWindow = null;
      return;
    }
    entry.mispredictions = client.prediction.stats.mispredictions - open.baseline;
    if (client.stats.clientTick >= open.untilTick) this.openWindow = null;
  }

  /**
   * Bank the server's XP award, and shape it for the M6 summary bar (§6.9).
   *
   * The lines come from the instance, which built them from authoritative events before it was
   * torn down. Everything else — the level before and after, the lifetime total the bar
   * animates from — is local, because progression is client-side and there is no account on the
   * server to ask (§6.9: *"no accounts, no server-side database"*).
   *
   * That trade-off is deliberate and is documented in `README.md`: a player can edit their own
   * unlocks, and it affects only them.
   */
  private bankServerXp(net: SummaryInfo, won: boolean): XpReport {
    const total = net.xp.reduce((sum, line) => sum + line.amount, 0);
    const xpBefore = this.profile.xp;
    const { levelBefore, levelAfter } = this.profile.bankMatch(total, won);
    return {
      lines: net.xp.map((line) => ({
        // The server's lines are already the human-readable breakdown; they carry no source id
        // because the id space is a client-side progression concept the server has no view of.
        id: 'match',
        label: line.label,
        count: 1,
        xp: line.amount,
        kind: 'flat' as const,
      })),
      total,
      xpBefore,
      levelBefore,
      levelAfter,
      // Weapon levels, challenges and camos stay client-side and are not awarded over the wire.
      // The server tracks no per-weapon progression, and inventing one here would be a number
      // with no authority behind it.
      weaponLevelUps: [],
      challengesCompleted: [],
      camosUnlocked: [],
    };
  }

  /**
   * This client's class, as ids on the wire (Tier 1 #20).
   *
   * Read from the profile every time rather than cached, so a class edited in the loadout
   * editor is the class the next connection sends. The ids are the same ones `resolveLoadout`
   * takes locally, which is what makes the server's resolution and the client's agree.
   */
  private netLoadout(): NetLoadout | null {
    /**
     * Sanitise **before** copying to the wire (M11 playtest).
     *
     * `resolveEquipped` sanitises the slot in place against the player's unlocks — a class
     * carrying something they have not earned has it stripped — and it does that at *resolve*
     * time, which is when the world is built. `toNetLoadout` reads the same slot at *handshake*
     * time, which is earlier.
     *
     * So the raw slot went over the wire and the stripped slot was resolved locally, and the
     * two sides ran different classes. If the difference touched a movement perk, client and
     * server disagreed about speed on every tick for the whole session.
     *
     * Resolving first collapses that: the slot is sanitised, and the copy that crosses the wire
     * is the one the client will itself resolve. The return value is discarded on purpose —
     * what is wanted is the side effect on the slot, and the caller that needs the resolved
     * form has `applyLoadout` for it.
     */
    this.profile.resolveEquipped(this.modeEntry().unrestricted);
    return toNetLoadout(this.profile.equippedLoadout());
  }

  /**
   * The server-to-client skirmish messages (§6.4, §6.5, §6.9).
   *
   * Every one of these is deferred to the render pass or handed to a screen; none of them
   * touches the world directly, because all of them arrive inside a snapshot decode.
   */
  private skirmishSink(): SkirmishSink {
    return {
      onVoteState: (info) => this.voteOverlay.apply(info),
      onPrepare: (matchId, mapId) => {
        this.pendingMatchId = matchId;
        /**
         * Start building the chosen map now, while the player is still shooting (§6.5).
         *
         * This is the mechanism that removes the loading screen. The server has nothing to
         * load — its maps were baked at boot — so the whole cost of a map transition is this,
         * and it is paid during warmup rather than at the transition.
         */
        this.buildQueue.start(mapId);
      },
      onMigrated: (welcome) => {
        /**
         * Discard the streaks the instance we are leaving told us about (Gate B, §4.18).
         *
         * §4.18's obligation list on a migration is flush, discard, resync, clear — and this is
         * the same rule applied to a channel that did not exist when it was written. The
         * replica is overwritten wholesale by the next frame from the new instance, but "the
         * next frame" is up to a snapshot interval away, and a sentry from the arena standing
         * in the live match's opening frames is exactly the stale-state artefact the list is
         * there to prevent.
         */
        this.world?.match.clearReplicatedStreaks();
        this.world?.match.clearReplicatedProjectiles();
        this.pendingMigration = welcome;
        this.openMigrationWindow(welcome.matchId);
      },
      onSummary: (info) => {
        this.pendingNetSummary = info;
      },
      onNotice: (text) => {
        /**
         * A line the server wants the player to read: allocation failed, the arena was
         * rebuilt (§4.17, §4.18).
         *
         * Emitted onto the bus rather than drawn here, so it reaches the HUD's existing
         * announcement channel and obeys the same timing and styling as every other piece of
         * feedback. S3's rule that *"a networked event and a local one must be
         * indistinguishable to the client"* applies to this too.
         */
        this.voteOverlay.notice(text);
        netLog.info(`server notice: ${text}`);
      },
    };
  }

  /**
   * Play Multiplayer (M11, §6.1).
   *
   * One click to shooting. There is no server picker, no ready-up and no lobby — the address
   * is configuration (§4.9), the callsign is prefilled, and the only screen between the button
   * and the arena is the word "connecting". Everything a traditional flow does in a static menu
   * this one does later, while the player is holding a gun.
   *
   * It reuses `launchMatch` rather than duplicating the connect path, so the map/mode desync
   * fix from M10's playtest — *build nothing until the server has said what it is running* —
   * covers this entry too by construction.
   */
  private async playMultiplayer(): Promise<void> {
    const join = multiplayerJoinOptions(window.location.search, this.profile.settings.callsign);
    if (join === null) {
      // The button is disabled in this case, so reaching here means the config changed under
      // us. Say so rather than failing silently.
      this.screens.menus.showBoot('NO SERVER CONFIGURED — SET VITE_SERVER_URL OR ?SERVER=');
      window.setTimeout(() => {
        if (this.state === 'MENU') this.screens.menus.show();
      }, 3000);
      return;
    }
    this.multiplayerJoin = join;
    await this.launchMatch();
  }

  private async launchMatch(): Promise<void> {
    /**
     * **Only the Play Multiplayer button connects** (M11 playtest, §6.2).
     *
     * This used to fall back to `this.joinOptions`, which is non-null whenever `?server=` is on
     * the URL or `VITE_SERVER_URL` is baked in — so on any build configured for multiplayer,
     * **Play Solo connected to the server too**. The player got a warmup arena and a vote cycle
     * from a button that promised neither.
     *
     * §6.2 is explicit that Play Solo is *"the existing local path: the client drives the shared
     * simulation locally, exactly as it did before M9"*. So the address is now configuration for
     * the multiplayer button and nothing else: `?server=` decides where that button dials and
     * whether it is enabled, and never what Play Solo does.
     */
    const join = this.multiplayerJoin;
    if (join === null || this.server !== null) {
      // Single-player, or a connection that is already up (resuming, or a rotation).
      this.transitionTo('MATCH');
      return;
    }
    if (this.joining) return;

    this.joining = true;
    this.screens.menus.showBoot(`CONNECTING TO ${hostOf(join.url)}…`);
    try {
      // The class goes with the `Hello`, not after it. See `handshake` and Tier 1 #20.
      const result = await handshake({ ...join, loadout: this.netLoadout() });
      this.server = {
        link: result.link,
        welcome: result.welcome,
        receivedAtMs: result.receivedAtMs,
        pending: result.pending,
        displayName: join.displayName,
        wantRewindDebug: join.wantRewindDebug,
        onNewMatch: (welcome) => {
          this.pendingRotation = welcome;
        },
        // The class rides the handshake so the seat is built with it (Tier 1 #20). By this
        // point `handshake` has already sent the `Hello`, so this copy is what a *rebuilt*
        // session — a rotation or a migration — will send if it ever reconnects.
        loadout: this.netLoadout(),
        skirmish: this.skirmishSink(),
        prebuiltMap: null,
      };
      this.joining = false;
      this.transitionTo('MATCH');
    } catch (err) {
      this.joining = false;
      const reason = err instanceof HandshakeError ? err.message : String(err);
      netLog.error(`could not join ${join.url}: ${reason}`);
      this.screens.menus.showBoot(`COULD NOT JOIN — ${reason.toUpperCase()}`);
      // Back to a usable menu rather than leaving the player on a dead screen.
      window.setTimeout(() => {
        if (this.state === 'MENU') this.screens.menus.show();
      }, 4000);
    }
  }

  /**
   * The server rotated to another match on the connection we already hold.
   *
   * Called from the render pass, never from inside the network update — see
   * `pendingRotation`. The world is destroyed and rebuilt because the *map may have changed*,
   * and a client that merely reset its state would keep the previous map's colliders. That is
   * the same desync as joining the wrong map, arriving by a different route.
   *
   * The link survives the teardown (`keepConnection`), because the server has not disconnected
   * us — it has reseated us in a new match and told us so with a second `Welcome`.
   */
  private applyRotation(welcome: WelcomeInfo): void {
    const previous = this.server;
    if (previous === null) return;
    netLog.info(`server rotated to ${welcome.modeId} on ${welcome.mapId} — rebuilding the world.`);

    /**
     * `rotating` makes every teardown on this path keep the socket, including the one the
     * SUMMARY state runs on its way out, which has no idea a rotation is why it is leaving.
     */
    this.rotating = true;
    try {
      // The new match, adopted *before* anything rebuilds — `buildWorld` reads the map and
      // mode straight off it, and the MATCH state's own enter handler is one of the callers.
      // `pending` is cleared rather than carried: it belongs to the drain that produced the
      // *first* welcome, and replaying those frames into a new match would apply state from
      // the previous one. A rotation's own welcome arrives through `NetClient.receive`, which
      // never drops what follows it.
      /**
       * Adopt the background build, if it is for the map we are moving to (§6.5).
       *
       * `take` hands over ownership and clears the queue, so the map is disposed by the world
       * that adopts it rather than by two owners or none. A miss — no build, or a build for a
       * different map — leaves this null and `MatchWorld` builds synchronously, which is the
       * §4.18 slow-client path: a visible hitch instead of a seamless transition, and correct.
       */
      const prebuiltMap = this.buildQueue.take(welcome.mapId);
      if (prebuiltMap === null && welcome.mapId !== previous.welcome.mapId) {
        netLog.warn(
          `no background build ready for ${welcome.mapId}; building it now (expect a hitch).`,
        );
      }
      this.server = {
        ...previous,
        welcome,
        receivedAtMs: performance.now(),
        pending: undefined,
        prebuiltMap,
      };
      this.teardownWorld({ keepConnection: true });

      if (this.state === 'MATCH') {
        this.buildWorld();
        this.world?.match.setActive(true);
      } else {
        // From SUMMARY (the usual case — a rotation follows a match ending) or from PAUSED.
        // Re-entering MATCH builds the world through the state's own enter handler rather
        // than duplicating it here.
        this.transitionTo('MATCH');
      }
      this.input.clearHeld();
    } finally {
      this.rotating = false;
    }
  }

  /**
   * `?harness=botmatch` boots straight into an AFK bot match (S7).
   *
   * The roster is populated *before* the flow starts so `Match.setActive` sees a non-empty
   * one and skips the default firefight — otherwise a full roster would be built and thrown
   * away on the same frame.
   */
  private startBotHarnessIfRequested(): void {
    const options = parseHarnessOptions(window.location.search);
    if (options === null) return;
    if (options.map !== null) this.selection.mapId = options.map;
    // M7: the harness can run any mode. Applied before the transition, so the world is built
    // from the same registry entry a player's choice would have produced.
    if (options.mode !== null) this.selection.modeId = options.mode;

    /**
     * M8: `?matches=N` hands the run to `MatchHarness` instead of playing one match here.
     *
     * They answer different questions and always did — `BotHarness` proves a *firefight* is
     * stable, `MatchHarness` proves a *build and teardown cycle* is — and until M8 they were
     * two tools with two entry points. One flag now picks between them, and the bot count,
     * speed, tier, map and mode from the same query string apply to both.
     */
    if (options.matches > 1) {
      void this.matchHarness.run(options.matches);
      return;
    }

    this.transitionTo('MATCH');
    this.world?.startBotHarness(options);
  }

  private onConfigChanged(): void {
    this.world?.applyMovementConfig();
    this.cameraConfig.fov = clampFov(this.cameraConfig.fov);
    this.profile.patchSettings({ fov: this.cameraConfig.fov });
  }

  /**
   * Apply a settings change, live, and persist it (M8, brief S6.3).
   *
   * **One function, called with a patch, that re-applies everything.** The alternative — a
   * switch on which key changed — is eleven branches that each have to be kept in step with
   * the screen, and the first one anybody forgets is a setting that silently does nothing,
   * which is the exact failure S6.3 opens by naming. Re-applying all of them costs a
   * handful of property writes on a user gesture and cannot drift.
   *
   * Persistence is separate and deliberately lazy: `Profile.patchSettings` marks the save
   * dirty and `SaveStore` coalesces the burst a slider drag produces into one write 250 ms
   * later. Live is immediate; written is a quarter of a second behind.
   */
  applySettings(patch: Partial<SettingsV1>): void {
    this.profile.patchSettings(patch);
    const s = this.profile.settings;

    // ---- look ------------------------------------------------------------
    this.input.setSensitivity(s.sensitivity);
    this.input.setAdsSensitivity(s.adsSensitivity);
    this.input.setInvertY(s.invertY);
    if (patch.bindings !== undefined) this.input.setBindings(s.bindings);
    this.cameraConfig.fov = clampFov(s.fov);

    // ---- audio -----------------------------------------------------------
    this.audio.setMasterVolume(s.masterVolume);
    this.audio.setBusVolume('sfx', s.sfxVolume);
    this.audio.setBusVolume('music', s.musicVolume);
    this.audio.setBusVolume('ui', s.uiVolume);

    // ---- video -----------------------------------------------------------
    this.renderer.setSize(window.innerWidth, window.innerHeight, s.renderScale);
    this.cameraRig.resize(this.renderer.aspect);
    this.viewmodel.resize(this.renderer.aspect);
    this.renderer.setShadowQuality(s.shadowQuality, this.scene);
    this.renderer.setMotionBlur(s.motionBlur);
    // A trail of the frame before a resolution change is a smear at the wrong size.
    this.renderer.resetMotionBlur();

    // ---- presentation ----------------------------------------------------
    // The palette writes CSS custom properties and notifies the canvases; everything that
    // draws a gameplay colour reads one of the two. See `ui/Palette.ts`.
    palette.set(s.colorblind);
    this.fpsCounter.setVisible(s.showFps);
  }

  private onWeaponConfigChanged(): void {
    this.world?.applyWeaponConfig();
  }

  // -- loop ----------------------------------------------------------------

  /**
   * Start or stop the background-tab network heartbeat. Bound to `visibilitychange`.
   */
  private readonly onVisibility = (): void => {
    this.onVisibilityChanged();
  };

  private onVisibilityChanged(): void {
    const hidden = document.hidden;
    if (hidden && this.hiddenNetTimer === null) {
      this.hiddenNetTimer = setInterval(() => this.pumpNetworkWhileHidden(), 50);
      return;
    }
    if (!hidden && this.hiddenNetTimer !== null) {
      clearInterval(this.hiddenNetTimer);
      this.hiddenNetTimer = null;
    }
  }

  private pumpNetworkWhileHidden(): void {
    const world = this.world;
    if (world === null) return;
    const net = world.net;
    if (net === null) return;
    world.match.netFrozen = net.frozen;
    net.update();
    /**
     * Serviced here as well as in the render pass, because the render pass is not running.
     *
     * `requestAnimationFrame` is *suspended* in a hidden tab, so `draw` — where these
     * transitions used to be handled and nowhere else — simply never happens. The network
     * keeps running on this timer by design, which means a client could be told the server
     * had rotated to a different map, acknowledge it, and then sit on the previous map's
     * world indefinitely: alt-tab through the post-match hold and you come back to a client
     * playing Foundry against a server running Depot. That is the same desync the handshake
     * fix removed, arriving by a different route.
     */
    this.servicePendingTransitions();
  }

  /**
   * Apply state changes that were requested from inside a callback, now that the callback
   * has returned.
   *
   * Both of these tear down or replace the world, and both are raised from deep inside
   * something that is currently iterating it — a bus dispatch for the match ending, a
   * snapshot decode for the rotation. Doing the work in place is how you get a null
   * dereference half-way through an event dispatch, so they are flags, and this is where
   * they are cashed.
   */
  private servicePendingTransitions(): void {
    // The match ended during a sim tick. A paused match cannot end, so the flag simply
    // survives until the match resumes.
    if (this.pendingSummary && this.state === 'MATCH') {
      this.pendingSummary = false;
      this.transitionTo('SUMMARY');
    }

    /**
     * The server started a new match on this connection. Rebuild.
     *
     * Deliberately after the summary transition and not before: a rotation follows a match
     * ending, and the player should get to see the result of the one they just played rather
     * than have it replaced by the next map loading underneath them. The post-match hold on
     * the server (`MATCH_END_HOLD_SECONDS`) is what buys the time for that.
     */
    const rotation = this.pendingRotation;
    if (rotation !== null) {
      this.pendingRotation = null;
      this.applyRotation(rotation);
    }

    /**
     * A migration (M11, §4.18, §6.7).
     *
     * Handled through `applyRotation`, because from this class's point of view the two are the
     * same event: *"the server has put you in a different world; rebuild."* Sharing the path is
     * what guarantees a migration also does the things a rotation learned to do — keep the
     * socket, clear the prediction state, adopt the new entity id — rather than a second
     * implementation that has to remember all of them.
     *
     * What is different is the map: a migration usually has one waiting from the background
     * build, and `applyRotation` picks it up through `takePrebuilt`.
     */
    const migration = this.pendingMigration;
    if (migration !== null) {
      /**
       * The background build won: adopt it and move, all in this frame (§6.5).
       *
       * This is the path the whole design exists to produce — a brief fade and you are in the
       * new map, with no loading screen and no stall, because the meshing happened while you
       * were still shooting in the arena.
       */
      if (this.buildQueue.hasReady(migration.mapId) || migration.mapId === this.currentMapId()) {
        this.pendingMigration = null;
        this.applyRotation(migration);
        return;
      }

      /**
       * The background build did not finish: show the screen, **then** build (§4.18).
       *
       * The migration is held for one frame rather than acted on now. That frame is what lets
       * the browser paint the loading screen; showing it and building in the same task paints
       * nothing, and the player gets a frozen frame of the world they have already left — which
       * is indistinguishable from a crash.
       *
       * `loadingHeldFrames` is the deferral. One frame is enough for a paint and is the least
       * this can cost.
       */
      if (!this.loadingScreen.visible) {
        this.loadingScreen.show(migration.mapId);
        this.loadingHeldFrames = 1;
        return;
      }
      this.loadingScreen.update(this.buildQueue.progress);
      if (this.loadingHeldFrames > 0) {
        this.loadingHeldFrames--;
        return;
      }

      /**
       * Drain whatever is left of the build in one go, then move.
       *
       * A large budget on purpose: the match has already started without this client and every
       * further frame spent trickling chunks is a frame they are not in it. The screen is up,
       * so a long task here costs nothing visually — which is exactly the trade the chunked
       * path refuses to make during warmup and the right one to make here.
       */
      if (this.buildQueue.building) {
        this.buildQueue.pump(LOADING_DRAIN_BUDGET_MS);
        this.loadingScreen.update(this.buildQueue.progress);
        return;
      }

      this.pendingMigration = null;
      this.applyRotation(migration);
      this.loadingScreen.hide();
    }
  }

  /** The map the world is currently built on, or '' when there is none. */
  private currentMapId(): string {
    return this.world?.map.def.id ?? '';
  }

  private simulate(tick: number): void {
    const world = this.world;
    if (world === null) return;
    // A paused match does not advance. The render pass still runs, so the pause screen is
    // composited over a live scene and the frame histogram keeps sampling.
    if (this.state === 'PAUSED') return;

    // Input crosses the netcode boundary even in single player: the sim only ever
    // sees command data, which is what keeps the command seam real (S4.2).
    //
    // A dead player submits neutral commands rather than being skipped: the sim still
    // runs for them, the corpse still collides, and the seam stays honest — which is
    // exactly what a real server would send while waiting on a respawn. Tab is the one
    // exception, so the scoreboard is reachable from the death screen (M5).
    const now = performance.now();
    const inMatch = this.state === 'MATCH';
    const dead = world.match.isPlayerDead;
    /**
     * The pre-match freeze (post-M8 playtest).
     *
     * Applied at the *sampler*, which is the only place it can be: movement is integrated by
     * `player.step` below, before the match ever sees the command, so a check inside `Match`
     * would arrive a frame late and after the player had already moved. `sampleSpectating`
     * is exactly the command a frozen player should send — zeroed axes, zeroed buttons, live
     * view angles — so the countdown reuses it rather than growing a fourth sampler that
     * would have to be kept in step with it.
     *
     * The camera is untouched by any of this: yaw and pitch are integrated in the mousemove
     * handler and stamped onto whatever command is produced, so looking around still works.
     */
    /**
     * Networked (M10): the session owns the tick.
     *
     * `NetClient` decides *which* tick to simulate from the synced server clock rather than
     * from this frame's accumulator — S4.11's rule that a client never increments its own
     * tick number — so the whole local step loop is skipped rather than adapted. It samples
     * through `MatchWorld.sampleForNet`, which applies the same three-way choice made below.
     *
     * The `inMatch` guard still applies: a paused or menu-bound client stops sending input,
     * and the server fills the gap by repeating the last command (S6.2), which is exactly
     * right — a player who alt-tabbed keeps standing where they were.
     */
    const net = world.net;
    if (net !== null) {
      world.match.netFrozen = net.frozen;
      if (inMatch) net.update();
      world.debug.simulate(world.player, this.movementConfig);

      /**
       * The connection died. Leave, rather than standing in a world nothing is driving.
       *
       * Without this a dropped client keeps its map, its HUD and its last snapshot on screen
       * forever: the local flow is inert by design, so nothing ticks, nothing changes, and it
       * is indistinguishable from a frozen game. The player is put back in the menu with the
       * reason, which is the difference between "the server went away" and "it hung".
       */
      if (net.state === 'disconnected' || net.state === 'rejected') {
        netLog.warn(`connection ended: ${net.client.closeReason}`);
        this.transitionTo('MENU');
      }
      return;
    }

    const frozen = world.match.inputFrozen;
    const cmd = !inMatch
      ? this.input.sampleNeutral(tick, now)
      : dead || frozen
        ? this.input.sampleSpectating(tick, now)
        : this.input.sample(tick, now);
    this.transport.submit(cmd);
    const count = this.transport.drain(this.drainBuffer, MAX_STEPS_PER_FRAME);
    for (let i = 0; i < count; i++) {
      const drained = this.drainBuffer[i];
      if (drained === undefined) continue;
      world.player.step(drained);
      // The weapon consumes the same command the player did, one tick at a time, so
      // fire rate and reload timing are as frame-rate independent as movement is (S4.1).
      world.match.simulate(drained);
    }
    world.debug.simulate(world.player, this.movementConfig);
  }

  private draw(alpha: number): void {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastRenderMs) / 1000);
    this.lastRenderMs = now;

    this.fpsCounter.update(dt);

    /**
     * The countdown and the background build, once per frame (M11, §6.4, §6.5).
     *
     * Both before the world check, because both matter with no world: the overlay's clock must
     * keep running through a transition, and the build must keep making progress while the
     * world is being swapped underneath it — that swap is the moment it exists to cover.
     *
     * The build is pumped **after** the frame's game logic in the sense that matters: it takes
     * a small fixed budget and yields, so a frame that was already expensive simply does one
     * chunk fewer. See `MapBuildQueue`.
     */
    this.voteOverlay.tick();
    this.pumpMigrationWindow();
    const buildMs = this.buildQueue.pump();
    if (buildMs > 0) this.stats.noteBackgroundBuildMs(buildMs);

    const world = this.world;
    if (world === null) {
      // No world: the menu is DOM over an empty canvas, and the canvas still has to be
      // cleared or it holds the last frame of the previous match behind the front end.
      this.renderer.clear();
      return;
    }

    const player = world.player;
    const sim = player.sim;
    const match = world.match;
    const def = this.weaponDef;

    // Sampled before the camera is composed: the interpolated aim-recoil offset is part
    // of where the camera points, so it cannot be produced after the fact (S6.2).
    match.sampleVisual(alpha);
    const yaw = this.input.yaw + match.visual.aimYaw * DEG2RAD;
    const pitch = this.input.pitch + match.visual.aimPitch * DEG2RAD;

    this.drive.sprint = sim.sprintActive;
    this.drive.tacSprint = sim.tacSprintActive;
    this.drive.slide = sim.slideActive;
    this.drive.adsFraction = match.visual.adsFraction;
    // M8: the ADS sensitivity multiplier is blended by how far the sights are up, so the
    // look speed changes with the picture rather than on the button edge.
    this.input.setAdsFraction(match.visual.adsFraction);
    this.drive.adsFovScale = def.adsFovScale;
    this.drive.adsViewmodelFovScale = def.adsViewmodelFovScale;

    this.cameraRig.update(
      player.prev,
      player.curr,
      alpha,
      yaw,
      pitch,
      this.drive,
      this.cameraConfig,
      dt,
      this.viewmodel,
    );

    const cam = this.cameraRig.camera;
    if (this.audio.isRunning) {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, fx, 0, fz, 0, 1, 0);
      // The slide scrape is a sustained source, so it is driven per frame from the
      // stance rather than fired from an event (see PLAN.md, M1 playtest note).
      this.audio.setSlide(sim.slideActive, sim.x, sim.y, sim.z, sim.speed, sim.groundMaterial);
    }
    // Recycling runs whatever the context is doing. Skipping it while suspended is how
    // voices used to accumulate: nothing was freeing them, and something still had to.
    this.audio.update();

    match.render(alpha, cam, dt, yaw, pitch);
    // M8: dust and haze ride the render clock, not the sim tick — they drive no gameplay
    // value, so S4.1's constant-dt rule does not apply and a fixed step would make the
    // cloud stutter at frame rates that are not 60.
    world.particulate?.update(cam.position.x, cam.position.y, cam.position.z, dt);
    world.debug.render(cam, alpha, dt);

    /**
     * A live Chopper Gunner owns the view (M7).
     *
     * Asked rather than pushed: the streak hands back a camera while it is running and null
     * once it has been restored, so there is nothing for `Game` to undo and no state here that
     * could disagree with the streak about whose camera it is. That is what makes acceptance
     * criterion 2 — "returns control cleanly, including if the player is killed or the match
     * ends" — a property of one method rather than of four call sites.
     */
    const chopper = match.streaks.activeChopperFor(PLAYER_ENTITY_ID);
    // M9: the streak reports a pose and a lens; `ChopperCamera` keeps the actual camera.
    const takeover = this.chopperCamera.cameraFor(chopper, this.renderer.aspect);
    if (takeover !== null) {
      /**
       * A grey render pass over the world with the bodies drawn by side, not a filter over
       * the ordinary image (S6.1). No viewmodel: the player is not holding anything.
       *
       * Post-M8 the two body groups are handed over separately so the pass can tell friend
       * from foe. Which is which is decided *here*, because the local team is a fact about
       * the match and `engine/` has no business knowing what a team is — it is given a cold
       * group and a hot one.
       */
      // From the side the *server* assigned, not the single-player constant: a networked gunner
      // on team B had the thermal pass draw their own side hot and the enemy cold — the optic
      // reading exactly backwards, in the one streak whose entire value is telling friend from
      // foe.
      const friendly = match.localTeam;
      const enemyTeam = friendly === 'A' ? 'B' : 'A';
      this.renderer.renderGunship(
        this.scene,
        takeover,
        match.botRenderer.groupFor(enemyTeam),
        match.botRenderer.groupFor(friendly),
      );
    } else {
      this.renderer.render(this.scene, cam, this.viewmodel);
    }
    world.debug.update(dt);

    // Between frames, with nothing part-way through a dispatch. Also serviced from the
    // hidden-tab heartbeat, because this pass does not run in a background tab at all.
    this.servicePendingTransitions();
  }

  private onFrame(sample: FrameSample): void {
    const match = this.world?.match;
    this.stats.push(sample.frameMs, sample.simMs, sample.renderMs, sample.steps, sample.starved);
    this.stats.pushBreakdown(
      match?.lastModeMs ?? 0,
      match?.ui.lastUpdateMs ?? 0,
      match?.streaks.lastMs ?? 0,
      match?.streaks.active.length ?? 0,
    );
  }

  // -- events --------------------------------------------------------------

  private statusLine(): string {
    const map = this.mapEntry();
    return `${map.name} · ${map.def.brushes.length} brushes · ${map.def.props.length} props`;
  }


  /**
   * The cursor was released — almost always Esc (M5, from the M4 playtest notes).
   *
   * M4 quit the match outright here, which is why Esc lost your game. It now pauses: the
   * world stays built, the sim stops, and the pause screen goes over the top. Quitting is a
   * button on that screen rather than a side effect of a key the browser owns.
   */
  private onPointerLockChange(locked: boolean): void {
    if (locked) return;
    // Esc with the targeting map up is a *cancel*, not a pause — the overlay says so, and a
    // player who backed out of marking a mortar should be back in the fight, not on a menu.
    // The browser has taken the cursor either way; the match stays armed, so the next click
    // recaptures it. See `Input.armPointerLock`.
    if (this.cancelMortarOverlay()) return;
    if (this.state === 'MATCH') this.transitionTo('PAUSED');
  }

  /**
   * Close the mortar targeting map if it is open. Returns whether it was.
   *
   * Cancelling deliberately does **not** spend the streak: `MortarOverlay.cancel` leaves it
   * pending, so a mis-opened map costs nothing.
   */
  private cancelMortarOverlay(): boolean {
    const overlay = this.world?.match.mortarOverlay;
    if (overlay === undefined || !overlay.isOpen) return false;
    overlay.cancel();
    return true;
  }

  /**
   * Escape, when the browser did *not* consume it to release pointer lock.
   *
   * That is the paused case, and the un-paused-but-not-locked case (the AFK harness, or a
   * player who clicked away). Pausing from a locked match arrives through
   * `onPointerLockChange` instead, so exactly one of the two fires.
   */
  private onEscape(): void {
    // The Esc stack, from the M5 playtest notes: with the overlay open, Esc closes the
    // overlay and stops. It used to fall straight through to "resume", which meant a
    // player closing a panel was thrown back into a firefight.
    const overlay = this.world?.debug.overlay;
    if (overlay !== undefined && overlay.isVisible) {
      overlay.setVisible(false);
      this.overlayWasOpenBeforePause = false;
      return;
    }
    // Above the pause branches for the same reason the F1 overlay is: a player closing a
    // panel must not be thrown back into a firefight, and one cancelling a mortar mark must
    // not be dropped onto the pause screen.
    if (this.cancelMortarOverlay()) return;
    if (this.state === 'SETTINGS') {
      // A binding row that is waiting for a key eats Escape as "cancel the capture"; only
      // once nothing is armed does Escape leave the screen.
      if (this.settingsScreen.handleEscape()) return;
      this.transitionTo(this.settingsReturn);
      return;
    }
    if (this.state === 'LOADOUT') {
      this.transitionTo(this.world === null ? 'MENU' : 'PAUSED');
      return;
    }
    if (this.state === 'PAUSED') {
      this.resumeFromPause();
      return;
    }
    if (this.state === 'MATCH' && !this.input.isLocked) this.transitionTo('PAUSED');
  }

  /**
   * The pause screen's debug button. Once the overlay has been opened on purpose it stays
   * open through the resume, rather than being closed again by the pause book-keeping.
   */
  private toggleOverlayFromPause(): void {
    const overlay = this.world?.debug.overlay;
    if (overlay === undefined) return;
    overlay.setVisible(!overlay.isVisible);
    this.overlayWasOpenBeforePause = overlay.isVisible;
  }

  private resumeFromPause(): void {
    if (this.state !== 'PAUSED') return;
    this.transitionTo('MATCH');
    this.restoreOverlayAfterPause();
  }

  /**
   * Take the F1 overlay off screen for the duration of the pause.
   *
   * It is a large, interactive, full-screen panel and the pause screen is modal; two of
   * those on top of each other is the "UI bugs" the pause menu was reported for. Whether
   * it was open is remembered so resuming puts the player back where they were.
   */
  private hideOverlayForPause(): void {
    const overlay = this.world?.debug.overlay;
    if (overlay === undefined) return;
    this.overlayWasOpenBeforePause = overlay.isVisible;
    overlay.setVisible(false);
  }

  private restoreOverlayAfterPause(): void {
    if (!this.overlayWasOpenBeforePause) return;
    this.world?.debug.overlay.setVisible(true);
  }

  private pauseStatusLine(): string {
    const match = this.world?.match;
    if (match === undefined) return this.mapEntry().name;
    const mode = match.mode;
    return `${mode.name} · ${this.mapEntry().name} · ${mode.teamScore('A')} – ${mode.teamScore('B')}`;
  }

  private readonly onResize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, this.profile.settings.renderScale);
    this.cameraRig.resize(this.renderer.aspect);
    this.viewmodel.resize(this.renderer.aspect);
  };

  private readonly onPageHide = (): void => {
    this.profile.patchSettings({ modeId: this.selection.modeId, mapId: this.selection.mapId });
    this.profile.flush();
    this.audio.suspend();
  };
}

function clampFov(v: number): number {
  return Math.min(FOV_MAX, Math.max(FOV_MIN, v));
}

/** Just the host, for a "connecting to…" line. A whole `ws://` URL is noise on a title card. */
function hostOf(url: string): string {
  const withoutScheme = url.replace(/^wss?:\/\//i, '');
  const end = withoutScheme.indexOf('/');
  return (end < 0 ? withoutScheme : withoutScheme.slice(0, end)).toUpperCase();
}
