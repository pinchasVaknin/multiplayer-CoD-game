import {
  DamageSystem,
  damageAtRange,
  makeDamageRequest,
  PLAYER_ENTITY_ID,
  type DamageRequest,
} from '../../shared/combat/DamageSystem';
import { HUMANOID_RIG, type HitZone } from '../../shared/combat/HitboxRig';
import { TargetDummy, buildDummyMaterials, type DummyMaterials } from '../combat/TargetDummy';
import { EventBus } from '../../shared/core/EventBus';
import { EV, type GameEvents } from '../../shared/core/Events';
import { Btn, type InputCommand, type MutableInputCommand } from '../../shared/core/InputCommand';
import { DT } from '../../shared/core/Loop';
import { RAD2DEG } from '../../shared/core/MathUtil';
import type { HealthConfig } from '../../shared/player/Health';
import type { MovementConfig } from '../../shared/player/MovementConfig';
import { PlayerController } from '../../shared/player/PlayerController';
import { Ballistics, makeShotTrace, type ShotTrace } from '../../shared/weapons/Ballistics';
import type { ViewmodelConfig } from '../../shared/weapons/ViewmodelConfig';
import { cloneWeaponDef, shotInterval, type WeaponDef } from '../../shared/weapons/WeaponDefs';
import { WeaponSystem } from '../../shared/weapons/WeaponSystem';
import { ColliderSet } from '../../shared/world/ColliderSet';
import { CollisionWorld } from '../../shared/world/CollisionWorld';

/**
 * Headless weapon harness — the M2 counterpart to `Harness` (brief S8).
 *
 * Everything the acceptance criteria ask about the weapon is a property of the
 * simulation, so it should be provable by running the simulation rather than by a human
 * squinting at a screen. This drives real `InputCommand`s through a real
 * `PlayerController` and a real `WeaponSystem` against a purpose-built collision world,
 * with no renderer, no audio context and no DOM in the loop.
 *
 * The one exception is `measureZoneDamage`, which calls `Ballistics` directly with an
 * exact aim vector: the point there is to isolate the rig and the falloff maths from the
 * spread cone, which would otherwise put a fraction of a degree of noise on every reading.
 *
 * Available in the browser console as `__operator.weaponHarness`.
 */

const FLOOR_HALF = 200;
/** Lane z for the thin-panel penetration test, and for the thick one. */
const THIN_LANE = 0;
const THICK_LANE = 8;
const WALL_X = 10;
const TARGET_X = 20;
/** Facing +X, in this project's yaw convention (forward = -sin yaw, 0, -cos yaw). */
const FACE_EAST = -Math.PI / 2;

export interface ShotPlacement {
  /** Degrees right of the first round of the burst. */
  x: number;
  /** Degrees above the first round of the burst. */
  y: number;
}

export interface BurstResult {
  shots: number;
  placements: ShotPlacement[];
  /** Total elapsed sim time from first to last round, seconds. */
  spanSeconds: number;
  measuredRpm: number;
}

export interface DeterminismResult {
  shotsA: number;
  shotsB: number;
  /** Largest angular disagreement between the two magazines, degrees. */
  maxDeviationDeg: number;
  identical: boolean;
}

export interface ZoneDamageRow {
  zone: HitZone;
  /** True if the ray actually reached the zone that was aimed at. */
  hit: boolean;
  distance: number;
  damage: number;
  baseDamage: number;
  multiplier: number;
  falloffLoss: number;
}

export interface PenetrationResult {
  surface: string;
  thickness: number;
  blocked: boolean;
  surfacesPenetrated: number;
  penetrationCost: number;
  retain: number;
  damage: number;
  unobstructedDamage: number;
  penetrationLoss: number;
}

export interface TimingResult {
  adsSeconds: number;
  reloadTacticalSeconds: number;
  reloadEmptySeconds: number;
  sprintToFireSeconds: number;
  shotIntervalSeconds: number;
  measuredRpm: number;
}

export class WeaponHarness {
  readonly world: CollisionWorld;

  private readonly bus = new EventBus<GameEvents>();
  private readonly damage = new DamageSystem(this.bus);
  private readonly ballistics: Ballistics;
  private readonly request: DamageRequest;
  private readonly trace: ShotTrace = makeShotTrace();
  private readonly materials: DummyMaterials & { dispose(): void };
  private readonly thinTarget: TargetDummy;
  private readonly thickTarget: TargetDummy;
  private readonly rangeTarget: TargetDummy;

  private readonly cmd: MutableInputCommand = {
    seq: 0,
    tickIndex: 0,
    moveX: 0,
    moveZ: 0,
    yaw: FACE_EAST,
    pitch: 0,
    buttons: 0,
    sampledAtMs: 0,
  };
  private readonly residual = { yaw: 0, pitch: 0 };
  private readonly recorded: ShotPlacement[] = [];
  private recordYaw0 = 0;
  private recordPitch0 = 0;
  private recording = false;

  constructor(
    private readonly movement: MovementConfig,
    private readonly def: WeaponDef,
    private readonly viewmodelConfig: ViewmodelConfig,
    private readonly healthConfig: HealthConfig,
  ) {
    const set = new ColliderSet(8);
    set.add({ x: 0, y: -1, z: 0 }, { x: FLOOR_HALF * 2, y: 2, z: FLOOR_HALF * 2 }, 0, 0, 0, 'floor');
    set.add({ x: WALL_X, y: 1.3, z: THIN_LANE }, { x: 0.05, y: 2.6, z: 4 }, 0, 0, 0, 'metal');
    set.add({ x: WALL_X, y: 1.3, z: THICK_LANE }, { x: 0.6, y: 2.6, z: 4 }, 0, 0, 0, 'concrete');
    this.world = new CollisionWorld(
      set,
      { min: { x: -FLOOR_HALF, y: -8, z: -FLOOR_HALF }, max: { x: FLOOR_HALF, y: 24, z: FLOOR_HALF } },
      8,
    );
    this.world.configure(movement.maxSlopeDeg, movement.collisionSkin);

    this.ballistics = new Ballistics(this.world, this.damage, this.bus);
    this.request = makeDamageRequest(def);
    this.request.sourceId = PLAYER_ENTITY_ID;

    this.materials = buildDummyMaterials();
    const yaw = Math.PI / 2; // facing -X, back down the firing line
    this.thinTarget = this.makeTarget(101, 'THIN', TARGET_X, THIN_LANE, yaw);
    this.thickTarget = this.makeTarget(102, 'THICK', TARGET_X, THICK_LANE, yaw);
    this.rangeTarget = this.makeTarget(103, 'RANGE', 5, -20, yaw);
  }

  // -- criterion 2: the pattern is deterministic ---------------------------

  /** Hold the trigger from a fixed position and record where every round went. */
  fireMagazine(seed = 0xa11ce): BurstResult {
    const { player, weapons } = this.freshRig(seed);
    this.recorded.length = 0;
    this.recording = true;
    const off = this.bus.on(EV.WeaponFired, (p) => this.record(p.dx, p.dy, p.dz, p.shotIndex));

    let yaw = FACE_EAST;
    let pitch = 0;
    let firstTick = -1;
    let lastTick = -1;
    const magSize = weapons.weapon.mag;

    for (let t = 0; t < 3600; t++) {
      const before = weapons.weapon.mag;
      this.writeCommand(t, yaw, pitch, Btn.Fire);
      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      if (weapons.takeViewResidual(this.residual)) {
        yaw += this.residual.yaw;
        pitch += this.residual.pitch;
      }
      if (weapons.weapon.mag < before) {
        if (firstTick < 0) firstTick = t;
        lastTick = t;
      }
      if (weapons.weapon.mag === 0) break;
    }

    off();
    this.recording = false;
    const span = firstTick >= 0 && lastTick > firstTick ? (lastTick - firstTick) * DT : 0;
    return {
      shots: this.recorded.length,
      placements: this.recorded.map((p) => ({ x: p.x, y: p.y })),
      spanSeconds: span,
      measuredRpm: span > 0 ? ((magSize - 1) / span) * 60 : 0,
    };
  }

  /**
   * Acceptance criterion 2: two magazines fired from the same position with the trigger
   * held must land in the same places. Same seed, because the small random cone is
   * seeded (S6.2) — that is the whole reason `Math.random` is banned in gameplay.
   */
  verifyDeterminism(seed = 0xa11ce): DeterminismResult {
    const a = this.fireMagazine(seed);
    const b = this.fireMagazine(seed);
    let worst = 0;
    const n = Math.min(a.placements.length, b.placements.length);
    for (let i = 0; i < n; i++) {
      const pa = a.placements[i];
      const pb = b.placements[i];
      if (pa === undefined || pb === undefined) continue;
      worst = Math.max(worst, Math.hypot(pa.x - pb.x, pa.y - pb.y));
    }
    return {
      shotsA: a.placements.length,
      shotsB: b.placements.length,
      maxDeviationDeg: worst,
      identical: a.placements.length === b.placements.length && worst < 1e-9,
    };
  }

  // -- criterion 3: hitbox multipliers -------------------------------------

  /** Fire one exact round at the centre of a zone's box from `distance` metres. */
  measureZoneDamage(zone: HitZone, distance: number): ZoneDamageRow {
    const target = this.rangeTarget;
    target.reset();
    target.rig.setTransform(distance, 0, -20, Math.PI / 2);

    const box = HUMANOID_RIG.boxes.find((b) => b.zone === zone);
    const aimY = box === undefined ? 1.1 : box.oy;
    const aimX = box === undefined ? 0 : box.ox;

    // The eye sits at the same height as the target's zone so `distance` is the true
    // slant range and the falloff reading is not quietly a hypotenuse.
    const ox = 0;
    const oy = aimY;
    const oz = -20 - aimX;
    const dx = distance - ox;
    const inv = 1 / Math.hypot(dx, 0, 0);

    this.request.weapon = this.def;
    this.damage.lastHit.valid = false;
    this.ballistics.fire(ox, oy, oz, dx * inv, 0, 0, this.def, this.request, this.trace);

    // Read the numbers back out of the DamageSystem rather than recomputing them here:
    // a harness that does its own arithmetic verifies the harness, not the game.
    const hit = this.damage.lastHit;
    return {
      zone: hit.valid ? hit.zone : zone,
      hit: hit.valid,
      distance: hit.valid ? hit.distance : this.trace.distance,
      damage: hit.valid ? hit.finalDamage : 0,
      baseDamage: hit.valid ? hit.baseDamage : 0,
      multiplier: hit.valid ? hit.zoneMultiplier : zoneMult(this.def, zone),
      falloffLoss: hit.valid ? hit.falloffLoss : 0,
    };
  }

  /** Head, torso and limb at one range, in one call. */
  measureZones(distance: number): ZoneDamageRow[] {
    return [
      this.measureZoneDamage('head', distance),
      this.measureZoneDamage('torso', distance),
      this.measureZoneDamage('leg', distance),
    ];
  }

  // -- criterion 4: wall penetration ---------------------------------------

  measurePenetration(): PenetrationResult[] {
    return [this.shootThrough('metal 0.05 m', THIN_LANE, 0.05), this.shootThrough('concrete 0.60 m', THICK_LANE, 0.6)];
  }

  private shootThrough(label: string, lane: number, thickness: number): PenetrationResult {
    const target = lane === THIN_LANE ? this.thinTarget : this.thickTarget;
    target.reset();
    target.rig.setTransform(TARGET_X, 0, lane, Math.PI / 2);

    this.request.weapon = this.def;
    this.damage.lastHit.valid = false;
    // Chest height, straight down the lane.
    this.ballistics.fire(0, 1.26, lane, 1, 0, 0, this.def, this.request, this.trace);

    const hit = this.damage.lastHit;
    const clean = damageAtRange(this.def, hit.valid ? hit.distance : TARGET_X);
    return {
      surface: label,
      thickness,
      blocked: !this.trace.hitTarget,
      surfacesPenetrated: this.trace.surfacesPenetrated,
      penetrationCost: this.trace.penetrationCost,
      retain: this.trace.penetrationRetain,
      damage: hit.valid ? hit.finalDamage : 0,
      /** What the same shot would have done with nothing in the way. */
      unobstructedDamage: clean,
      penetrationLoss: hit.valid ? hit.penetrationLoss : 0,
    };
  }

  // -- criterion 1 and 7: handling timings ---------------------------------

  measureTimings(): TimingResult {
    return {
      adsSeconds: this.measureAds(),
      reloadTacticalSeconds: this.measureReload(false),
      reloadEmptySeconds: this.measureReload(true),
      sprintToFireSeconds: this.measureSprintToFire(),
      shotIntervalSeconds: shotInterval(this.def),
      measuredRpm: this.fireMagazine().measuredRpm,
    };
  }

  private measureAds(): number {
    const { player, weapons } = this.freshRig();
    for (let t = 0; t < 600; t++) {
      this.writeCommand(t, FACE_EAST, 0, Btn.Ads);
      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      if (weapons.weapon.adsFraction >= 1) return (t + 1) * DT;
    }
    return -1;
  }

  private measureReload(empty: boolean): number {
    const { player, weapons } = this.freshRig();
    const weapon = weapons.weapon;
    if (empty) weapon.mag = 0;
    else weapon.mag = weapon.definition.magSize - 1;

    let started = -1;
    for (let t = 0; t < 900; t++) {
      const buttons = t === 0 ? Btn.Reload : 0;
      this.writeCommand(t, FACE_EAST, 0, buttons);
      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      if (started < 0 && weapon.reloading) started = t;
      if (started >= 0 && !weapon.reloading) return (t - started) * DT;
    }
    return -1;
  }

  /**
   * Sprint, release, and count until the weapon will actually fire. This is the number
   * S6.6 calls a core balance lever, measured from the state machine rather than read
   * back out of the config.
   */
  private measureSprintToFire(): number {
    const { player, weapons } = this.freshRig();
    // Hold sprint until the weapon is fully down.
    for (let t = 0; t < 600; t++) {
      this.writeCommand(t, FACE_EAST, 0, Btn.Sprint);
      this.cmd.moveZ = 1;
      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      if (weapons.weapon.raise <= 0) break;
    }
    for (let t = 0; t < 600; t++) {
      this.writeCommand(1000 + t, FACE_EAST, 0, 0);
      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      if (weapons.weapon.canFire) return (t + 1) * DT;
    }
    return -1;
  }

  /** Everything the M2 acceptance criteria ask for, in one call. */
  report(): WeaponReport {
    return {
      determinism: this.verifyDeterminism(),
      zonesAt5m: this.measureZones(5),
      zonesAtFalloffStart: this.measureZones(this.def.damageFalloff.start),
      zonesBeyondFalloffEnd: this.measureZones(this.def.damageFalloff.end + 6),
      penetration: this.measurePenetration(),
      timings: this.measureTimings(),
    };
  }

  dispose(): void {
    this.thinTarget.dispose();
    this.thickTarget.dispose();
    this.rangeTarget.dispose();
    this.materials.dispose();
  }

  // -- internals -------------------------------------------------------------

  private makeTarget(id: number, name: string, x: number, z: number, yaw: number): TargetDummy {
    const dummy = new TargetDummy(
      { id, name, behaviour: 'static', x, y: 0, z, yaw },
      { ...this.healthConfig, max: 100000 },
      this.materials,
    );
    this.damage.register(dummy);
    return dummy;
  }

  /** A fresh player and weapon on the harness world, so runs cannot contaminate. */
  private freshRig(seed = 0xa11ce): { player: PlayerController; weapons: WeaponSystem } {
    const player = new PlayerController({ ...this.movement }, this.world, this.bus);
    player.spawn(0, 0.2, -60, FACE_EAST);
    const weapons = new WeaponSystem(
      cloneWeaponDef(this.def),
      // No secondary: every measurement here is about one weapon, and a holstered pistol
      // would be a second magazine the harness has to keep out of its own numbers.
      null,
      this.world,
      this.damage,
      this.bus,
      this.viewmodelConfig,
      this.movement.walkSpeed,
    );
    weapons.reseed(seed);
    return { player, weapons };
  }

  private writeCommand(tick: number, yaw: number, pitch: number, buttons: number): void {
    this.cmd.seq = tick;
    this.cmd.tickIndex = tick;
    this.cmd.moveX = 0;
    this.cmd.moveZ = 0;
    this.cmd.yaw = yaw;
    this.cmd.pitch = pitch;
    this.cmd.buttons = buttons;
    this.cmd.sampledAtMs = tick * DT * 1000;
  }

  private record(dx: number, dy: number, dz: number, shotIndex: number): void {
    if (!this.recording) return;
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy)));
    const yaw = Math.atan2(-dx, -dz);
    if (shotIndex === 0) {
      this.recordYaw0 = yaw;
      this.recordPitch0 = pitch;
    }
    let dYaw = yaw - this.recordYaw0;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.recorded.push({ x: -dYaw * RAD2DEG, y: (pitch - this.recordPitch0) * RAD2DEG });
  }
}

export interface WeaponReport {
  determinism: DeterminismResult;
  zonesAt5m: ZoneDamageRow[];
  zonesAtFalloffStart: ZoneDamageRow[];
  zonesBeyondFalloffEnd: ZoneDamageRow[];
  penetration: PenetrationResult[];
  timings: TimingResult;
}

function zoneMult(def: WeaponDef, zone: HitZone): number {
  if (zone === 'head') return def.headshotMult;
  if (zone === 'torso') return 1;
  return def.limbMult;
}
