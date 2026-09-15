import * as THREE from 'three';
import { logger } from '../../shared/core/Log';
import type { ShadowQuality } from '../../shared/meta/SaveData';
import { navBakeOptionsFor } from '../../shared/ai/BotDirector';
import { findMap } from '../../shared/modes/ModeRegistry';
import { DEFAULT_MOVEMENT_CONFIG } from '../../shared/player/MovementConfig';
import type { LaneDef, MapDef, Vec3Lit } from '../../shared/world/maps/types';
import { loadMapCollision } from '../../shared/world/MapLoader';
import { bakeNavmesh } from '../../shared/world/NavBake';
import type { ProceduralTextures } from '../engine/ProceduralTextures';
import type { NavGrid } from '../../shared/world/Navmesh';
import type { CharacterAssetService } from '../characters/CharacterAssetService';
import { MapBuildQueue } from './MapBuildQueue';
import { applyAmbient, type LoadedMap } from './MapRender';
import { MenuSkirmish } from './MenuSkirmish';
import { Particulate } from './Particulate';

const log = logger('backdrop');

/**
 * The menu's backdrop: a world that is not a match (M15, A3).
 *
 * The main menu's left half is the game's own renderer drawing a real map — the one the solo
 * picker points at, so the menu shows where the player is going — with the camera on a slow
 * dolly along one of the map's authored lanes at eye height. It is the brief's "cinematic
 * background video" answered without a video (decision 1: no video asset exists and none is
 * wanted at 5–20 MB against a 391 kB client), and it is the whole of the backdrop for Phase
 * A; the bodies and the shooting are Phase E — `MenuSkirmish`, below — on E's numbers.
 *
 * ## What this is, and is not
 *
 * The world is a `LoadedMap` (mesh, lights, sky — the map's own root) plus `applyAmbient` and
 * the map's particulate, and a camera this class moves. That is the same three things
 * `MatchWorld` puts in the scene before it builds a player into them — which is why the
 * map's half of `dispose` is one `scene.remove` and one `LoadedMap.dispose`, the same two
 * lines `MatchWorld.dispose` ends with.
 *
 * On that map, when `combat` is on (Phase E), a `MenuSkirmish`: a bots-only deathmatch on the
 * shared simulation, stepped from the loop's fixed step through `simulate` and drawn through
 * the dolly's camera. It is still **no `Match`** in `ClientMatch`'s sense — no player, no HUD,
 * no audio, no netcode — and it is on a bus of its own, so nothing that listens to the game's
 * bus hears a shot fired behind the menu. `combat` off is Phase A's backdrop exactly, which is
 * the fallback E's numbers were measured against.
 *
 * ## Built the way §6.5 builds
 *
 * Through its own `MapBuildQueue` — the chunked builder at its 5 ms budget, pumped from the
 * render pass — so a map that costs seconds of mesh construction arrives over a couple of
 * hundred frames while the menu is already up, rather than as a stall on the first one. Its
 * own instance rather than `Game`'s: that queue's `onComplete` reports readiness to a server
 * for a match being prepared, and the arena is `MATCH`, where this class has already been
 * disposed. Two queues never pump on the same frame; if they ever did, the cost would be
 * 10 ms rather than 5, and both budgets are checked after the chunk.
 *
 * ## One map in the scene, ever
 *
 * `MatchWorld` adds its map to the same `THREE.Scene`. So `Game.buildWorld` disposes this
 * before it constructs one, and `MENU`'s `enter` prepares it again on the way back — for the
 * map the picker names now, which is idempotent when it has not changed and a rebuild when it
 * has. A world outside the state the state machine builds worlds for is a new thing, and this
 * is the whole of the rule that keeps it from being two: the backdrop exists only while
 * `Game.world` is null, and `buildWorld` is the one place that makes it non-null.
 *
 * ## The dolly, and the wall it does not go through
 *
 * The middle lane's `a → center` at eye height is a straight line the bots walk, and on the
 * three shipped maps it is a street or a hall. It is still checked: at adoption the segment is
 * sampled every 25 cm with a standing capsule against the map's own `CollisionWorld`, and the
 * dolly runs over the collision-free prefix only. A prefix shorter than `MIN_RUN` holds the
 * camera at `a` and sways it, which is a worse menu than a moving one and a better one than a
 * camera inside a wall. Phase C's spline replaces the straight line; the check stays.
 */

/** The player's eye above the ground it stands on (`PlayerSnapshot.eyeHeight`). */
const EYE_HEIGHT = 1.65;
/** A cinematic lens, wider than the rig's default is not; narrower than the ADS is. */
const FOV_DEG = 62;
/** Metres per second along the lane. A walk is 2.5; this is a push. */
const DOLLY_SPEED = 0.55;
/** The slow look left and right, degrees either side of the lane and seconds per cycle. */
const SWAY_DEG = 2.5;
const SWAY_PERIOD_S = 14;
/** A slight downward pitch reads as a person; level reads as a survey. Radians. */
const PITCH = -0.035;
/** The collision probe: a standing capsule, sampled along the lane. */
const PROBE_STEP = 0.25;
const PROBE_RADIUS = 0.3;
const PROBE_HEIGHT = 1.8;
/** Below this many free metres the dolly holds and sways instead of pushing. */
const MIN_RUN = 4;

export interface MenuBackdropDeps {
  readonly scene: THREE.Scene;
  readonly textures: ProceduralTextures;
  readonly shadowQuality: () => ShadowQuality;
  /** The skins, for the skirmish's bodies (E). The same service the match draws from. */
  readonly characterAssets: CharacterAssetService;
  readonly anisotropy: () => number;
}

interface Dolly {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  /** Unit direction from `a` toward the lane centre, on the ground. */
  readonly dx: number;
  readonly dz: number;
  /** The collision-free length the camera may travel from `a`. */
  readonly run: number;
  /** The lane's own heading, so the camera looks where a player walking it would. */
  readonly yaw: number;
}

export class MenuBackdrop {
  private readonly deps: MenuBackdropDeps;
  private readonly queue: MapBuildQueue;
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 400);

  private map: LoadedMap | null = null;
  private particulate: Particulate | null = null;
  private dolly: Dolly | null = null;
  /**
   * The fight on the map (E), or null with `combat` off or no map yet. Rebuilt with the next
   * seed when its match is over.
   */
  private skirmish: MenuSkirmish | null = null;
  /** Navmeshes baked so far, by map id: a bake is once per map per page, not once per menu. */
  private readonly navs = new Map<string, NavGrid>();
  /** Consecutive skirmishes deal different decks and fight different fights. */
  private skirmishesBuilt = 0;
  /**
   * Whether the map behind the menu carries the fight (E). On by default; a console can turn
   * it off (`__p7.game.backdrop.combat = false`) for the isolation half of a measurement,
   * and the flag is the switch the phase ships behind: off is Phase A's dolly alone.
   */
  combat = true;
  /** Seconds since the map was adopted; the dolly and the sway run on it. */
  private elapsed = 0;
  /** The map asked for, whether built, building or waiting. */
  private wantedMapId = '';

  constructor(deps: MenuBackdropDeps) {
    this.deps = deps;
    this.queue = new MapBuildQueue({
      textures: deps.textures,
      shadowQuality: deps.shadowQuality,
      onComplete: (mapId) => {
        const built = this.queue.take(mapId);
        if (built === null) return;
        this.adopt(built);
      },
    });
  }

  /** The map on screen, building, or waiting; empty when there is none. */
  get mapId(): string {
    return this.wantedMapId;
  }

  /** Whether a map is in the scene right now. */
  get ready(): boolean {
    return this.map !== null;
  }

  /**
   * Ask for `mapId` behind the menu.
   *
   * Idempotent for the map already shown or already building; a different id disposes what
   * is there and starts the new build. An id the registry does not know is logged and
   * ignored — the menu is fine with a bare canvas, and a throw here would take the menu
   * with it.
   */
  prepare(mapId: string): void {
    if (mapId === this.wantedMapId) return;
    let entry;
    try {
      entry = findMap(mapId);
    } catch {
      log.warn(`no map "${mapId}" to draw behind the menu.`);
      return;
    }
    this.release();
    this.wantedMapId = mapId;
    if (this.combat) this.bakeNav(entry.def);
    this.queue.start(mapId);
  }

  /**
   * The skirmish's navmesh, baked here rather than on the frame the map lands (E).
   *
   * A bake is ~230 ms on Foundry and cannot be chunked, so it goes where a stall is not seen:
   * before the map's first frame, on a menu that has not started moving yet, once per map per
   * page. Against a `loadMapCollision` of the same def rather than the built map's collision —
   * the same geometry, so the same grid, and exactly how the server's `MapBakery` bakes at
   * boot before any match wraps it. Measured before this: a 475 ms frame as the map appeared.
   */
  private bakeNav(def: MapDef): void {
    if (this.navs.has(def.id)) return;
    const t0 = performance.now();
    const nav = bakeNavmesh(loadMapCollision(def).collision, def.navBounds, navBakeOptionsFor(def, DEFAULT_MOVEMENT_CONFIG));
    this.navs.set(def.id, nav);
    log.info(`${def.name}: navmesh for the fight behind the menu baked in ${(performance.now() - t0).toFixed(0)} ms.`);
  }

  /**
   * One fixed simulation step, from the loop's `sim` while there is no world (E): the fight
   * advances on the same clock a match does. Nothing to do without a map or with `combat` off;
   * a finished fight is replaced here, on the step that found it over.
   */
  simulate(): void {
    const map = this.map;
    if (map === null) return;
    if (!this.combat) {
      this.dropSkirmish();
      return;
    }
    if (this.skirmish?.isOver === true) this.dropSkirmish();
    const fight = this.skirmish ?? this.buildSkirmish(map);
    fight.step();
  }

  /**
   * One render frame's worth: pump the build, move the camera, drift the motes — and, with a
   * fight on, pose its bodies between sim steps and advance its effects.
   *
   * Returns the camera to render the scene through, or null while nothing is built yet —
   * the caller clears the canvas in that case, exactly as it did before this class existed.
   */
  frame(dt: number, aspect: number, alpha = 1): THREE.PerspectiveCamera | null {
    this.queue.pump();
    const map = this.map;
    if (map === null) return null;

    this.elapsed += dt;
    const cam = this.camera;
    if (cam.aspect !== aspect) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }

    const d = this.dolly;
    if (d !== null) {
      // A cosine ease from `a` to the end of the run and back: no stop at either end, and
      // the same push-and-pull however long the run is.
      const period = d.run > 0 ? (2 * d.run) / DOLLY_SPEED : 1;
      const s = d.run * (0.5 - 0.5 * Math.cos((2 * Math.PI * this.elapsed) / period));
      const sway = (SWAY_DEG * Math.PI) / 180 * Math.sin((2 * Math.PI * this.elapsed) / SWAY_PERIOD_S);
      cam.position.set(d.ax + d.dx * s, d.ay + EYE_HEIGHT, d.az + d.dz * s);
      cam.rotation.set(PITCH, d.yaw + sway, 0, 'YXZ');
    }

    // The same call the match makes, on the same clock: decoration rides the render dt.
    this.particulate?.update(cam.position.x, cam.position.y, cam.position.z, dt);
    this.skirmish?.render(alpha, dt, cam);
    return cam;
  }

  /** Take the map out of the scene and off the GPU. Safe to call with nothing built. */
  dispose(): void {
    this.release();
    this.wantedMapId = '';
  }

  // -- internals -------------------------------------------------------------

  private adopt(built: LoadedMap): void {
    const scene = this.deps.scene;
    this.map = built;
    scene.add(built.root);
    applyAmbient(scene, built.def);
    const particulateDef = built.def.particulate;
    this.particulate = particulateDef === undefined ? null : new Particulate(particulateDef);
    if (this.particulate !== null) built.root.add(this.particulate.points);

    this.dolly = planDolly(built);
    this.elapsed = 0;
    const d = this.dolly;
    log.info(
      `${built.def.name} behind the menu: dolly run ${d.run.toFixed(1)} m` +
        (d.run < MIN_RUN ? ' (held — the lane is blocked at eye height)' : '') +
        '.',
    );
  }

  private buildSkirmish(map: LoadedMap): MenuSkirmish {
    const mapEntry = findMap(map.def.id);
    const built = new MenuSkirmish({
      scene: this.deps.scene,
      map,
      mapEntry,
      characterAssets: this.deps.characterAssets,
      anisotropy: this.deps.anisotropy,
      seed: 0x4e5a_1000 + this.skirmishesBuilt++,
      nav: this.navs.get(map.def.id),
    });
    this.navs.set(map.def.id, built.nav);
    this.skirmish = built;
    return built;
  }

  private dropSkirmish(): void {
    this.skirmish?.dispose();
    this.skirmish = null;
  }

  private release(): void {
    this.queue.cancel();
    this.dropSkirmish();
    const map = this.map;
    if (map !== null) {
      this.deps.scene.remove(map.root);
      this.particulate?.dispose();
      this.particulate = null;
      map.dispose();
      this.map = null;
    }
    this.dolly = null;
  }
}

/**
 * The lane to ride and how far along it the camera may go.
 *
 * The middle lane by index, which on every shipped map is the one down the spine; a map with
 * no lanes (the greybox, the range) gets `spawns[0] → navBounds' centre`, which is
 * `ModePanel.measureLanes`' fallback for the same absence.
 */
function planDolly(map: LoadedMap): Dolly {
  const def: MapDef = map.def;
  const lane = pickLane(def, map);
  const dx0 = lane.center.x - lane.a.x;
  const dz0 = lane.center.z - lane.a.z;
  const length = Math.hypot(dx0, dz0);
  const dx = length > 0 ? dx0 / length : 0;
  const dz = length > 0 ? dz0 / length : 1;

  // Walk the segment with a standing capsule; stop at the first sample that is inside
  // anything. The run is the free prefix, capped at the lane itself.
  let run = 0;
  for (let s = 0; s <= length; s += PROBE_STEP) {
    const x = lane.a.x + dx * s;
    const z = lane.a.z + dz * s;
    if (map.collision.overlapCapsule(x, lane.a.y, z, PROBE_RADIUS, PROBE_HEIGHT)) break;
    run = s;
  }
  if (run < MIN_RUN) run = 0;

  return {
    ax: lane.a.x,
    ay: lane.a.y,
    az: lane.a.z,
    dx,
    dz,
    run,
    // three.js yaw: facing -Z is 0, and +X is -π/2. The direction (dx, dz) faces
    // atan2(-dx, -dz), which is the yaw a body walking the lane would carry.
    yaw: Math.atan2(-dx, -dz),
  };
}

function pickLane(def: MapDef, map: LoadedMap): LaneDef {
  const lanes = def.lanes;
  if (lanes !== undefined && lanes.length > 0) {
    const middle = lanes[Math.floor(lanes.length / 2)];
    if (middle !== undefined) return middle;
  }
  const spawn: Vec3Lit = map.spawns[0]?.position ?? { x: 0, y: 0, z: 0 };
  const b = map.navBounds;
  return {
    name: 'MAP',
    a: spawn,
    b: spawn,
    center: { x: (b.min.x + b.max.x) / 2, y: spawn.y, z: (b.min.z + b.max.z) / 2 },
  };
}
