import * as THREE from 'three';
import { DEFAULT_SCHEDULER } from '../../shared/ai/AiScheduler';
import { BotDirector } from '../../shared/ai/BotDirector';
import type { BotTeam, Combatant } from '../../shared/ai/Combatant';
import { DEFAULT_PERCEPTION, DEFAULT_TIERS, tiersFor } from '../../shared/ai/DifficultyTiers';
import { isObjectiveProvider } from '../../shared/ai/ObjectiveIntent';
import { DamageSystem, PLAYER_ENTITY_ID } from '../../shared/combat/DamageSystem';
import { HitboxRig, HUMANOID_RIG } from '../../shared/combat/HitboxRig';
import { ScoreSystem } from '../../shared/combat/ScoreSystem';
import { Disposable } from '../../shared/core/Disposable';
import { createGameBus, EV, type GameBus } from '../../shared/core/Events';
import { DT } from '../../shared/core/Loop';
import { logger } from '../../shared/core/Log';
import { Rng } from '../../shared/core/Rng';
import type { GameMode } from '../../shared/modes/GameMode';
import { MatchFlow } from '../../shared/modes/MatchFlow';
import { findMode, type MapEntry } from '../../shared/modes/ModeRegistry';
import { DEFAULT_HEALTH_CONFIG, Health } from '../../shared/player/Health';
import { DEFAULT_MOVEMENT_CONFIG } from '../../shared/player/MovementConfig';
import type { ViewerContext } from '../../shared/ui/TeamColour';
import { DEFAULT_VIEWMODEL_CONFIG } from '../../shared/weapons/ViewmodelConfig';
import { WEAPON_DEFS } from '../../shared/weapons/WeaponDefs';
import type { NavGrid } from '../../shared/world/Navmesh';
import { BotRenderer } from '../ai/BotRenderer';
import type { CharacterAssetService } from '../characters/CharacterAssetService';
import { characterDefinition } from '../characters/CharacterCatalog';
import { RandomCharacterSelector } from '../characters/RandomCharacterSelector';
import { Fx } from '../engine/Fx';
import type { LoadedMap } from './MapRender';

const log = logger('skirmish');

/**
 * The fight behind the menu (M15, Phase E): a bots-only Team Deathmatch on the backdrop map,
 * simulated on the frame loop's fixed step and drawn through the dolly's camera.
 *
 * ## What it is made of
 *
 * The shape is `server/Match.ts`'s, which is the shape of a match with nobody at the keyboard:
 * the map's own `CollisionWorld`, a `BotDirector` over a navmesh, `DamageSystem`, `ScoreSystem`,
 * the mode, and `MatchFlow` — with a never-participating combatant in the player's seat, the
 * same empty seat the dedicated server runs with. The systems are the shared modules the real
 * match simulates with; only the wiring is here. On top of them, the two client pieces a fight
 * needs to be *seen*: `BotRenderer` for the bodies — the same skins, the same animations, dealt
 * from a deck of its own — and `Fx` for the muzzle lights, tracers and impacts.
 *
 * ## What it is not
 *
 * **Not `client/ClientMatch.ts`.** That is the composition root of a match the player is in:
 * a viewmodel, a HUD, an audio graph, a camera rig, a local player, the netcode seam. None of
 * that exists here, and a `Match` built without it would be a `Match` with most of itself
 * switched off. This owns the bots' half and nothing else, which is why it is a fifteenth of the
 * size.
 *
 * **On its own bus.** `Game.bus` has the HUD, the announcer, the killfeed and the audio on it;
 * a kill behind the menu must reach none of them. The skirmish creates a `GameBus` of its own,
 * every system subscribes to that, and `dispose` retires them the way `ServerMatch.dispose`
 * does — flow, score, director — so `EventBus.liveSubscriptions` is flat across a cycle, which
 * is the first of the three numbers this phase ships on.
 *
 * ## The warm-up, skipped in place
 *
 * Round one opens with a ten-second freeze (`MATCH_START_SECONDS`), during which every bot
 * stands still. A menu that opened on ten seconds of statues would be a worse menu than the
 * dolly alone, so while the flow is in WARMUP the skirmish takes several sim steps per loop
 * step: the freeze passes in a second and a quarter of wall clock, and since nothing moves
 * during it, nothing is seen to hurry. `DT` is 1/60 for every one of those steps — this is
 * the `TickAccumulator.timeScale` trick, not a different timestep.
 *
 * ## When it ends
 *
 * A Team Deathmatch runs to its kill limit or its clock and then is over. `isOver` says so;
 * the backdrop disposes this one and builds the next with the next seed and the navmesh it
 * already baked. The bodies cut to new spawns — it is a backdrop.
 */

export interface MenuSkirmishDeps {
  readonly scene: THREE.Scene;
  readonly map: LoadedMap;
  readonly mapEntry: MapEntry;
  readonly characterAssets: CharacterAssetService;
  readonly anisotropy: () => number;
  readonly seed: number;
  /** A navmesh baked for this map already, so the second skirmish on it does not bake again. */
  readonly nav?: NavGrid;
}

/** Sim steps per loop step while the round-one freeze runs. See the header. */
const WARMUP_STEPS_PER_TICK = 8;
/** The mode. Deathmatch hunts continuously and ends on kills; nothing waits on an objective. */
const MODE_ID = 'TDM';
/** The side the empty seat nominally belongs to. It never participates, so it never matters. */
const SEAT_TEAM: BotTeam = 'A';

/**
 * The empty player seat, as the server's `Spectator` fills it: a combatant that is never
 * `participating`, so no bot hunts it, no spawn is scored against it and perception skips it.
 * It is not registered with the damage system, so nothing can address it. `server/` cannot
 * be imported here, and thirty lines restated is the price of the boundary.
 */
class EmptySeat implements Combatant {
  readonly entityId = PLAYER_ENTITY_ID;
  readonly displayName = 'SPECTATOR';
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly health = new Health({ ...DEFAULT_HEALTH_CONFIG });
  readonly team = SEAT_TEAM;
  readonly px = 0;
  readonly py = 0;
  readonly pz = 0;
  readonly yaw = 0;
  readonly vx = 0;
  readonly vz = 0;
  readonly eyeHeight = 1.65;
  readonly aimHeight = 1.26;
  readonly quiet = true;
  readonly glinting = false;

  get participating(): boolean {
    return false;
  }
}

export class MenuSkirmish extends Disposable {
  readonly bus: GameBus = createGameBus();
  readonly bots: BotDirector;
  readonly score: ScoreSystem;
  readonly mode: GameMode;
  readonly flow: MatchFlow;

  private readonly deps: MenuSkirmishDeps;
  private readonly damage: DamageSystem;
  private readonly renderer: BotRenderer;
  private readonly fx: Fx;
  private readonly viewer: ViewerContext = { team: SEAT_TEAM, freeForAll: false };
  private tick = 0;

  constructor(deps: MenuSkirmishDeps) {
    super();
    this.deps = deps;
    const { map, mapEntry } = deps;
    const modeEntry = findMode(MODE_ID);
    const movement = DEFAULT_MOVEMENT_CONFIG;
    const healthConfig = { ...DEFAULT_HEALTH_CONFIG };

    // ---- the firefight, as the server wires it ------------------------------------
    this.damage = new DamageSystem(this.bus);
    this.bots = new BotDirector({
      world: map.collision,
      mapDef: map.def,
      bus: this.bus,
      damage: this.damage,
      movement,
      healthConfig,
      viewmodelConfig: DEFAULT_VIEWMODEL_CONFIG,
      tiers: DEFAULT_TIERS,
      perceptionConfig: DEFAULT_PERCEPTION,
      scheduler: DEFAULT_SCHEDULER,
      player: new EmptySeat(),
      seed: deps.seed,
      nav: deps.nav,
    });
    this.bots.freeForAll = false;
    this.damage.freeForAll = false;

    this.score = new ScoreSystem(this.bus);
    this.score.freeForAll = false;
    this.score.records = true;
    this.mode = modeEntry.create({
      bus: this.bus,
      score: this.score,
      roster: this.bots.roster,
      mapDef: map.def,
    });
    this.flow = new MatchFlow({
      bus: this.bus,
      score: this.score,
      roster: this.bots.roster,
      mode: this.mode,
      mapId: mapEntry.id,
      mapName: mapEntry.name,
      localTeam: SEAT_TEAM,
      onSidesSwapped: (swapped) => this.bots.spawns.setSideSwap(swapped),
    });
    this.bots.respawnPolicy = {
      allowed: (id) => this.flow.respawnAllowed(id),
      noted: (id) => this.flow.noteRespawn(id),
    };
    this.bots.objectives = isObjectiveProvider(this.mode) ? this.mode : null;
    this.bots.pushAggressionScale = modeEntry.pushAggressionScale ?? 1;

    // A full roster: the map's team size a side, and nobody's seat held back for a human.
    const size = mapEntry.teamSize;
    this.bots.populate(size, size, tiersFor('MIX', mapEntry.tierMix));
    for (const bot of this.bots.bots) this.score.register(bot.entityId, bot.displayName, bot.team);
    this.flow.start();

    // ---- the picture ------------------------------------------------------------------
    // Its own deck, seeded from the skirmish's seed, so the menu shows the roster of skins and
    // consecutive menus deal it differently. Skins load through the same service the match
    // draws from and stay cached for it.
    const selector = new RandomCharacterSelector(new Rng(deps.seed ^ 0x5a17_c0de));
    this.renderer = new BotRenderer(
      () => this.bots.bots,
      () => this.viewer,
      deps.anisotropy(),
      (actor) => deps.characterAssets.avatarProvider(characterDefinition(selector.characterIdFor(actor.entityId))),
    );
    // No nameplates, no health bars, no pads: a backdrop is a picture, not a HUD.
    this.renderer.setIndicatorsVisible(false);
    deps.scene.add(this.renderer.group);

    this.fx = new Fx(deps.anisotropy());
    deps.scene.add(this.fx.group);
    this.own(
      this.bus.on(EV.WeaponFired, (p) => {
        const def = WEAPON_DEFS[p.weaponId];
        if (def === undefined) return;
        // The world light only: the flash mesh belongs to a viewmodel, and there is none.
        this.fx.fireMuzzleFlash(p.x, p.y, p.z, def.muzzleFlashScale, false);
        if (p.tracer) this.fx.spawnTracer(p.x, p.y, p.z, p.endX, p.endY, p.endZ);
      }),
    );
    this.own(
      this.bus.on(EV.BulletImpact, (p) => {
        this.fx.spawnImpact(p.x, p.y, p.z, p.nx, p.ny, p.nz, p.material, p.penetrated);
      }),
    );

    log.info(`${modeEntry.name} on ${mapEntry.name} behind the menu: ${size} vs ${size} bots, seed ${deps.seed}.`);
  }

  /** The navmesh this skirmish walks, for the next one on the same map. */
  get nav(): NavGrid {
    return this.bots.nav;
  }

  /** True once the mode has declared a winner. The backdrop's cue to build the next. */
  get isOver(): boolean {
    return this.flow.isOver;
  }

  /**
   * One fixed step of the fight, from the loop's `sim` — several while the freeze runs, see
   * the header. The order is `ServerMatch.step`'s for the systems that are here: the director
   * with the flow's freeze, then the flow.
   */
  step(): void {
    const steps = this.flow.currentPhase === 'WARMUP' ? WARMUP_STEPS_PER_TICK : 1;
    for (let i = 0; i < steps; i++) {
      const phase = this.flow.currentPhase;
      this.bots.inputFrozen = phase === 'WARMUP' || phase === 'ROUND_END';
      this.bots.simulate(this.tick, this.tick * DT * 1000);
      this.flow.simulate(this.tick);
      this.tick++;
      if (this.flow.isOver) return;
    }
  }

  /** One render frame: the bodies between their sim poses, and the effects at render rate. */
  render(alpha: number, dt: number, camera: THREE.PerspectiveCamera): void {
    this.renderer.update(alpha, dt, camera);
    this.fx.update(dt);
  }

  override dispose(): void {
    super.dispose();
    this.flow.dispose();
    this.score.dispose();
    this.bots.dispose();
    this.deps.scene.remove(this.renderer.group);
    this.renderer.dispose();
    this.deps.scene.remove(this.fx.group);
    this.fx.dispose();
  }
}
