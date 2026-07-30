import { DamageSystem, PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import { HUMANOID_RIG, type HitZone } from '../combat/HitboxRig';
import { TargetDummy, buildDummyMaterials, type DummyMaterials } from '../combat/TargetDummy';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/Events';
import { Btn, type InputCommand, type MutableInputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { DEFAULT_HEALTH_CONFIG, type HealthConfig } from '../player/Health';
import type { MovementConfig } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { DEFAULT_VIEWMODEL_CONFIG, type ViewmodelConfig } from '../weapons/ViewmodelConfig';
import {
  ATTACHMENT_IDS,
  measureAttachment,
  resolveWeaponDef,
  verifyAttachmentPurity,
  type AttachmentDelta,
  type AttachmentId,
  type PurityFinding,
} from '../weapons/Attachments';
import { ALL_WEAPONS, cloneWeaponDef, type WeaponDef } from '../weapons/WeaponDefs';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { ColliderSet } from '../world/ColliderSet';
import { CollisionWorld } from '../world/CollisionWorld';

/**
 * The M5 measurement rig (brief S6.5, S7, S8).
 *
 * `WeaponHarness` measures *one* weapon in detail — determinism, zones, penetration,
 * handling. This measures *the arsenal*: the TTK table for twelve weapons at four ranges
 * and two hit zones, what each attachment actually costs, and whether attachment
 * resolution is pure. All of it headless, against a real `WeaponSystem`, a real
 * `Ballistics` and a real `DamageSystem`, so the table in `docs/BALANCE.md` is a
 * measurement rather than an argument.
 *
 * ## What "TTK" means here
 *
 * Rounds are fired with the trigger held from a fixed position at a target that starts on
 * full health, and the clock runs from **the first round that lands to the one that
 * drops it**, counted in sim ticks. Two deliberate choices:
 *
 *  - **Spread and recoil are zeroed for the measurement.** A TTK table answers "how fast
 *    can this weapon kill", not "how likely is it to". Leaving the cone in would make
 *    every figure a distribution and the table a different document. The pellet cone is
 *    *not* zeroed — a shotgun's spread is the weapon, and its TTK at 25 m genuinely is
 *    "never", which is the spikiness S6.5 asks to be verified.
 *  - **Reloads count.** A weapon that empties its magazine before it kills keeps firing
 *    through the reload, because that is what actually happens.
 *
 * A weapon that cannot kill inside `MAX_SECONDS` reports `-1`, which the table prints as
 * a dash. That is a real result, not a failure to measure.
 */

const FLOOR_HALF = 300;
/** Facing +X, in this project's yaw convention (forward = -sin yaw, 0, -cos yaw). */
const FACE_EAST = -Math.PI / 2;
const SHOOTER_X = 0;
const SHOOTER_Z = 0;
const TARGET_ID = 900;

/** The four ranges S6.5 fixes the table at, metres. */
export const BALANCE_RANGES: readonly number[] = [5, 15, 25, 40];

/** Give up after this long. Longer than any honest kill and shorter than a hang. */
const MAX_SECONDS = 6;

export interface TtkCell {
  /** Seconds from first hit to death, or -1 when the weapon could not kill in time. */
  seconds: number;
  /**
   * Trigger pulls, which is what a player counts.
   *
   * Distinct from `hits` because of the shotgun: one shell is one pull and eight rays, and
   * a table that reported "6 shots" for a single one-shot kill would be describing the
   * pellets rather than the weapon.
   */
  pulls: number;
  /** Individual rays that landed, including the lethal one. Equals `pulls` except for pellets. */
  hits: number;
  /** Damage of the first landing ray, for sanity against the table. */
  firstHit: number;
}

export interface TtkRow {
  readonly weaponId: string;
  readonly weaponName: string;
  readonly weaponClass: string;
  readonly rpm: number;
  /** Indexed by `BALANCE_RANGES`. */
  readonly chest: TtkCell[];
  readonly head: TtkCell[];
}

export interface ArsenalReport {
  readonly ttk: TtkRow[];
  readonly attachments: AttachmentDelta[];
  readonly purity: PurityFinding[];
}

export class ArsenalHarness {
  readonly world: CollisionWorld;

  private readonly bus = new EventBus<GameEvents>();
  private readonly damage = new DamageSystem(this.bus);
  private readonly materials: DummyMaterials & { dispose(): void };
  private readonly target: TargetDummy;
  private readonly viewmodelConfig: ViewmodelConfig;

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

  constructor(
    private readonly movement: MovementConfig,
    healthConfig: HealthConfig = DEFAULT_HEALTH_CONFIG,
    viewmodelConfig: ViewmodelConfig = DEFAULT_VIEWMODEL_CONFIG,
  ) {
    this.viewmodelConfig = viewmodelConfig;

    const set = new ColliderSet(4);
    set.add({ x: 0, y: -1, z: 0 }, { x: FLOOR_HALF * 2, y: 2, z: FLOOR_HALF * 2 }, 0, 0, 0, 'floor');
    this.world = new CollisionWorld(
      set,
      { min: { x: -FLOOR_HALF, y: -8, z: -FLOOR_HALF }, max: { x: FLOOR_HALF, y: 24, z: FLOOR_HALF } },
      8,
    );
    this.world.configure(movement.maxSlopeDeg, movement.collisionSkin);

    this.materials = buildDummyMaterials();
    this.target = new TargetDummy(
      { id: TARGET_ID, name: 'BALANCE', behaviour: 'static', x: 10, y: 0, z: 0, yaw: Math.PI / 2 },
      // No regeneration, so a slow weapon is measured against 100 HP rather than against
      // 100 HP plus whatever came back while it was firing.
      { ...healthConfig, regenDelay: 999, regenRate: 0 },
      this.materials,
    );
    this.damage.register(this.target);
  }

  /** The baseline every measurement here is taken against. */
  get baseline(): WeaponDef {
    const first = ALL_WEAPONS[0];
    if (first === undefined) throw new Error('The arsenal is empty');
    return first;
  }

  /** Everything the S8 criteria ask for, in one call. */
  report(): ArsenalReport {
    return {
      ttk: this.measureTtkTable(),
      attachments: this.measureAttachments(),
      purity: verifyAttachmentPurity(this.baseline),
    };
  }

  /** Criterion 2: twelve weapons x four ranges x two hit zones. */
  measureTtkTable(): TtkRow[] {
    const rows: TtkRow[] = [];
    for (const def of ALL_WEAPONS) {
      const chest: TtkCell[] = [];
      const head: TtkCell[] = [];
      for (const range of BALANCE_RANGES) {
        chest.push(this.measureTtk(def, range, 'torso'));
        head.push(this.measureTtk(def, range, 'head'));
      }
      rows.push({
        weaponId: def.id,
        weaponName: def.name,
        weaponClass: def.class,
        rpm: def.rpm,
        chest,
        head,
      });
    }
    return rows;
  }

  /**
   * One cell of the table.
   *
   * The target is moved to the requested range and the shooter aims at the centre of the
   * chest or the head box. Because the *world* is a bare floor, nothing can occlude the
   * shot, and because the aim is exact and the cone is zeroed, every round that should
   * land does.
   */
  measureTtk(def: WeaponDef, range: number, zone: 'torso' | 'head'): TtkCell {
    const flat = cloneWeaponDef(def);
    // See the class comment: a TTK table is "how fast", not "how likely".
    flat.spread.hipStand = 0;
    flat.spread.hipMove = 0;
    flat.spread.ads = 0;
    flat.spread.perShot = 0;
    flat.spread.perShotMax = 0;
    flat.recoil.verticalScale = 0;
    flat.recoil.horizontalScale = 0;

    this.target.setPosition(SHOOTER_X + range, 0, SHOOTER_Z);
    this.target.reset();

    const player = new PlayerController({ ...this.movement }, this.world, this.bus);
    player.spawn(SHOOTER_X, 0.2, SHOOTER_Z, FACE_EAST);
    const weapons = new WeaponSystem(
      flat,
      null,
      this.world,
      this.damage,
      this.bus,
      this.viewmodelConfig,
      this.movement.walkSpeed,
    );
    weapons.reseed(0x9e3d_1177);

    // Aim at the centre of the box we want, from the eye, in the plane of the shot.
    const boxY = zone === 'head' ? headBoxY() : chestBoxY();
    const eyeY = player.sim.y + player.sim.eyeHeight;
    const pitch = Math.atan2(boxY - eyeY, range);

    let firstHitTick = -1;
    let lethalTick = -1;
    let hits = 0;
    let pulls = 0;
    let firstHit = 0;
    const maxTicks = Math.round(MAX_SECONDS / DT);

    const offDamage = this.bus.on('damage.dealt', (p) => {
      if (p.targetId !== TARGET_ID) return;
      hits++;
      if (firstHit === 0) firstHit = p.amount;
    });
    // Counted separately from the damage events: one shell is one pull and eight rays.
    const offFired = this.bus.on('weapon.fired', () => {
      if (lethalTick < 0) pulls++;
    });

    for (let t = 0; t < maxTicks; t++) {
      // ADS held as well as fire: the table is authored aimed, which is how the weapon is
      // used at 25 and 40 m and makes no difference at all once the cone is zero.
      this.writeCommand(t, FACE_EAST, pitch, Btn.Fire | Btn.Ads);
      player.step(this.cmd as InputCommand);
      const before = hits;
      weapons.step(this.cmd as InputCommand, player.sim);
      // The residual is consumed and thrown away: with the recoil scales at zero it is
      // always zero, and letting it accumulate would walk the aim off a target the table
      // says is being hit.
      weapons.takeViewResidual(this.residual);
      this.target.step();

      if (hits > before && firstHitTick < 0) firstHitTick = t;
      if (!this.target.health.alive) {
        lethalTick = t;
        break;
      }
    }
    offDamage();
    offFired();

    const seconds = lethalTick >= 0 && firstHitTick >= 0 ? (lethalTick - firstHitTick) * DT : -1;
    return { seconds, pulls, hits, firstHit };
  }

  /** Criterion 4: what each attachment measurably costs, on the baseline carbine. */
  measureAttachments(base?: WeaponDef): AttachmentDelta[] {
    const on = base ?? this.baseline;
    return ATTACHMENT_IDS.map((id) => measureAttachment(on, id));
  }

  /**
   * Criterion 4, the part a table cannot show: fire a magazine with and without the laser
   * and report the *measured* hip cone, rather than the number the def claims.
   */
  measureLaserSpread(base: WeaponDef): { withoutDeg: number; withDeg: number; deltaDeg: number } {
    const without = this.measureHipSpread(base);
    const withLaser = this.measureHipSpread(resolveWeaponDef(base, ['laser_tactical']));
    return { withoutDeg: without, withDeg: withLaser, deltaDeg: withLaser - without };
  }

  /**
   * The cone the *system* reports on the first round of a burst, standing still and hip
   * firing. Read out of `WeaponSystem.spreadDeg`, which is the same value the crosshair
   * and the ballistics use — a harness that recomputed it would be verifying the harness.
   */
  private measureHipSpread(def: WeaponDef): number {
    const player = new PlayerController({ ...this.movement }, this.world, this.bus);
    player.spawn(SHOOTER_X, 0.2, SHOOTER_Z, FACE_EAST);
    const weapons = new WeaponSystem(
      cloneWeaponDef(def),
      null,
      this.world,
      this.damage,
      this.bus,
      this.viewmodelConfig,
      this.movement.walkSpeed,
    );
    // Let the player land and settle first. Spawning at 0.2 m leaves them airborne on tick
    // zero, and `airScale` is 2.1 — the first reading of this measurement came back as 3.99
    // degrees for a 1.9 degree cone because it was taken in mid-air.
    for (let t = 0; t < 30; t++) {
      this.writeCommand(t, FACE_EAST, 0, 0);
      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
    }
    return weapons.spreadDeg;
  }

  /**
   * Criterion 5: fire one shotgun shell at a target and report which zone every pellet
   * found. Aimed at the neck, which is where a mixed head/torso spread comes from.
   */
  measurePelletSpread(def: WeaponDef, range: number): { zones: HitZone[]; hits: number; damage: number } {
    this.target.setPosition(SHOOTER_X + range, 0, SHOOTER_Z);
    this.target.reset();

    const player = new PlayerController({ ...this.movement }, this.world, this.bus);
    player.spawn(SHOOTER_X, 0.2, SHOOTER_Z, FACE_EAST);
    const flat = cloneWeaponDef(def);
    flat.spread.hipStand = 0;
    flat.spread.ads = 0;
    const weapons = new WeaponSystem(
      flat,
      null,
      this.world,
      this.damage,
      this.bus,
      this.viewmodelConfig,
      this.movement.walkSpeed,
    );
    weapons.reseed(0x51e5_0b0a);

    // The neck: high enough that the top of the cone reaches the head and the bottom
    // reaches the chest, which is exactly the mixed spread the criterion asks to see.
    const neckY = 1.5;
    const eyeY = player.sim.y + player.sim.eyeHeight;
    const pitch = Math.atan2(neckY - eyeY, range);

    for (let t = 0; t < 4; t++) {
      this.writeCommand(t, FACE_EAST, pitch, t === 0 ? 0 : Btn.Fire);
      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      this.target.step();
      if (weapons.lastPellets.count > 0 && weapons.lastPellets.hits > 0) break;
    }

    // Only pellets that actually found a body have a zone. `lastPellets.zones` carries a
    // default for the ones that missed, and reporting those as torso hits made the first
    // run of this measurement claim eight zone hits out of five landed pellets.
    const report = weapons.lastPellets;
    const zones: HitZone[] = [];
    for (let i = 0; i < report.count; i++) {
      if ((report.targets[i] ?? -1) < 0) continue;
      const zone = report.zones[i];
      if (zone !== undefined) zones.push(zone);
    }
    return { zones, hits: report.hits, damage: report.damage };
  }

  /**
   * Criterion 8: the slide-cancel retune, measured against real TTK.
   *
   * The brief asks whether "sliding into a room beats the fastest ADS in the game". That
   * question only became answerable in M5, for two reasons: the arsenal now *has* a fastest
   * ADS, and firing while sliding is now legal (the M4 playtest note). So this measures the
   * thing that actually decides the duel:
   *
   *  - **`fireableFraction`** — how much of a chained slide-cancel run the weapon is
   *    actually up for. A player who can move at 7.9 m/s *and shoot* is the exploit; one
   *    who can move at 7.9 m/s with the weapon down has paid for it.
   *  - **`peakSustainedWhileFireable`** — the fastest one-second window during which the
   *    weapon was up the whole time. This is the number to compare against `sprintSpeed`.
   *  - **`slideToFireSeconds`** — how long after committing to a slide the weapon can fire,
   *    which is what a defender's ADS is racing.
   *
   * Runs the same adversarial policy `Harness.measureMaxSustained` uses, with a real
   * `WeaponSystem` stepping alongside the controller.
   */
  measureSlideAggression(
    def: WeaponDef,
    seconds = 30,
  ): {
    averageSpeed: number;
    peakSustained: number;
    fireableFraction: number;
    averageSpeedWhileFireable: number;
    peakSustainedWhileFireable: number;
    slideToFireSeconds: number;
    slides: number;
  } {
    const player = new PlayerController({ ...this.movement }, this.world, this.bus);
    player.spawn(0, 0.2, 0, 0);
    const weapons = new WeaponSystem(
      cloneWeaponDef(def),
      null,
      this.world,
      this.damage,
      this.bus,
      this.viewmodelConfig,
      this.movement.walkSpeed,
    );

    const ticks = Math.round(seconds / DT);
    const window = Math.round(1 / DT);
    const speeds = new Float32Array(ticks);
    const fireable = new Uint8Array(ticks);

    let totalSpeed = 0;
    let fireableTicks = 0;
    let fireableSpeed = 0;
    let slides = 0;
    let wasSliding = false;
    let slideStartTick = -1;
    let slideToFireTicks = -1;

    for (let t = 0; t < ticks; t++) {
      this.cmd.seq = t;
      this.cmd.tickIndex = t;
      this.cmd.moveX = 0;
      this.cmd.moveZ = 0;
      this.cmd.yaw = 0;
      this.cmd.pitch = 0;
      this.cmd.buttons = 0;
      this.cmd.sampledAtMs = t * DT * 1000;
      slideCancelPolicy(player.sim, this.cmd);

      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      weapons.takeViewResidual(this.residual);

      const sim = player.sim;
      const speed = Math.hypot(sim.vx, sim.vz);
      const up = weapons.weapon.canFire;
      speeds[t] = speed;
      fireable[t] = up ? 1 : 0;
      totalSpeed += speed;
      if (up) {
        fireableTicks++;
        fireableSpeed += speed;
      }

      if (sim.slideActive && !wasSliding) {
        slides++;
        slideStartTick = t;
      }
      wasSliding = sim.slideActive;
      // The first time the weapon comes up after a slide begins is the number a defender's
      // ADS is racing.
      if (slideStartTick >= 0 && up && slideToFireTicks < 0) {
        slideToFireTicks = t - slideStartTick;
      }
    }

    let peakSustained = 0;
    let peakFireable = 0;
    for (let start = 0; start + window <= ticks; start++) {
      let sum = 0;
      let allUp = true;
      for (let i = 0; i < window; i++) {
        sum += speeds[start + i] ?? 0;
        if (fireable[start + i] !== 1) allUp = false;
      }
      const mean = sum / window;
      if (mean > peakSustained) peakSustained = mean;
      if (allUp && mean > peakFireable) peakFireable = mean;
    }

    return {
      averageSpeed: totalSpeed / ticks,
      peakSustained,
      fireableFraction: fireableTicks / ticks,
      averageSpeedWhileFireable: fireableTicks === 0 ? 0 : fireableSpeed / fireableTicks,
      peakSustainedWhileFireable: peakFireable,
      slideToFireSeconds: slideToFireTicks < 0 ? -1 : slideToFireTicks * DT,
      slides,
    };
  }

  /**
   * Criterion 8, the other half: one slide into a room, not a chain.
   *
   * Sprints to build the entry gate, slides once and *holds* it, and records when the
   * weapon becomes fireable and how far the player has travelled by then. This is the
   * number a defender's ADS is racing, and it is the one the brief's question is about.
   */
  measureSlideEntry(def: WeaponDef): {
    entrySpeed: number;
    slideToFireSeconds: number;
    distanceBeforeFireable: number;
    speedWhenFireable: number;
    slideSeconds: number;
  } {
    const player = new PlayerController({ ...this.movement }, this.world, this.bus);
    player.spawn(0, 0.2, 0, 0);
    const weapons = new WeaponSystem(
      cloneWeaponDef(def),
      null,
      this.world,
      this.damage,
      this.bus,
      this.viewmodelConfig,
      this.movement.walkSpeed,
    );

    const sim = player.sim;
    let entrySpeed = 0;
    let slideStart = -1;
    let fireTick = -1;
    let distance = 0;
    let speedWhenFireable = 0;
    let slideEnd = -1;
    let lastX = sim.x;
    let lastZ = sim.z;

    const ticks = Math.round(5 / DT);
    for (let t = 0; t < ticks; t++) {
      this.cmd.seq = t;
      this.cmd.tickIndex = t;
      this.cmd.moveX = 0;
      this.cmd.moveZ = 1;
      this.cmd.yaw = 0;
      this.cmd.pitch = 0;
      this.cmd.sampledAtMs = t * DT * 1000;
      // Double-tap into a tactical sprint for the first second, then commit to a slide and
      // hold it. Holding the trigger throughout, so the weapon fires the instant it can.
      // Double-tap sprint (press, release for one tick, press and hold) into a tactical
      // sprint, hold it long enough to clear the 0.3 s entry gate, then commit to a slide.
      //
      // The trigger is **not** held during the run-up, and that is not a convenience: M2
      // made firing suppress sprint, so a policy that holds fire while sprinting never
      // reaches the slide gate at all. It is pulled the tick the slide begins, which is
      // also what a player does.
      if (t < 4) this.cmd.buttons = Btn.Sprint;
      else if (t === 4) this.cmd.buttons = 0;
      else if (t < 60) this.cmd.buttons = Btn.Sprint;
      else this.cmd.buttons = Btn.Sprint | Btn.Crouch | Btn.Fire;

      player.step(this.cmd as InputCommand);
      weapons.step(this.cmd as InputCommand, player.sim);
      weapons.takeViewResidual(this.residual);

      if (sim.slideActive && slideStart < 0) {
        slideStart = t;
        entrySpeed = Math.hypot(sim.vx, sim.vz);
        lastX = sim.x;
        lastZ = sim.z;
      }
      if (slideStart >= 0) {
        if (fireTick < 0) {
          distance += Math.hypot(sim.x - lastX, sim.z - lastZ);
          lastX = sim.x;
          lastZ = sim.z;
          if (weapons.weapon.canFire) {
            fireTick = t;
            speedWhenFireable = Math.hypot(sim.vx, sim.vz);
          }
        }
        if (!sim.slideActive && slideEnd < 0) slideEnd = t;
      }
      if (slideEnd >= 0 && fireTick >= 0) break;
    }

    return {
      entrySpeed,
      slideToFireSeconds: fireTick < 0 || slideStart < 0 ? -1 : (fireTick - slideStart) * DT,
      distanceBeforeFireable: distance,
      speedWhenFireable,
      slideSeconds: slideEnd < 0 || slideStart < 0 ? -1 : (slideEnd - slideStart) * DT,
    };
  }

  /** The fastest ADS and the fastest sprint-to-fire in the arsenal, for the comparison. */
  static fastestHandling(): { adsId: string; adsSeconds: number; outId: string; outSeconds: number } {
    let adsId = '';
    let adsSeconds = Infinity;
    let outId = '';
    let outSeconds = Infinity;
    for (const def of ALL_WEAPONS) {
      if (def.adsTime < adsSeconds) {
        adsSeconds = def.adsTime;
        adsId = def.name;
      }
      if (def.sprintOutTime < outSeconds) {
        outSeconds = def.sprintOutTime;
        outId = def.name;
      }
    }
    return { adsId, adsSeconds, outId, outSeconds };
  }

  dispose(): void {
    this.damage.unregister(TARGET_ID);
    this.target.dispose();
    this.materials.dispose();
  }

  // -- internals -------------------------------------------------------------

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
}

/**
 * The adversarial slide-cancel policy, copied in shape from `Harness.chainSlideCancel`.
 *
 * Duplicated rather than imported because `Harness`'s version drives its own controller
 * through its own loop and this one has to run alongside a weapon. The behaviour is
 * identical: cancel as late as the rules allow, promote to tactical sprint whenever it is
 * legal, and re-enter a slide the instant the gate opens.
 */
function slideCancelPolicy(sim: PlayerController['sim'], cmd: MutableInputCommand): void {
  cmd.moveZ = 1;

  if (sim.slideActive) {
    const cancel = sim.slideElapsed > 0.12;
    cmd.buttons = Btn.Crouch | (cancel ? Btn.Jump : 0);
    return;
  }

  let buttons = Btn.Sprint;
  if (!sim.tacSprintActive && sim.tacSprintCooldown <= 0 && sim.tacLockout <= 0) {
    if (sim.tick % 2 === 1) buttons = 0;
  }
  if (sim.grounded && sim.slideCooldown <= 0 && sim.sprintHeldTime >= 0.3 && sim.speed > 4) {
    buttons |= Btn.Crouch;
  }
  cmd.buttons = buttons;
}

/** Centre height of the chest box in the shared rig, metres. */
function chestBoxY(): number {
  for (const box of HUMANOID_RIG.boxes) {
    if (box.name === 'chest') return box.oy;
  }
  return 1.26;
}

function headBoxY(): number {
  for (const box of HUMANOID_RIG.boxes) {
    if (box.name === 'head') return box.oy;
  }
  return 1.645;
}

/** Render the table as the Markdown that goes into `docs/BALANCE.md`. */
export function ttkTableToMarkdown(rows: readonly TtkRow[]): string {
  const header = ['| Weapon | Class | RPM | ' + BALANCE_RANGES.map((r) => `${r} m`).join(' | ') + ' |'];
  header.push('|---|---|---:|' + BALANCE_RANGES.map(() => '---:').join('|') + '|');

  const out: string[] = ['### Chest (upper torso)', '', ...header];
  for (const row of rows) {
    out.push(
      `| ${row.weaponName} | ${row.weaponClass} | ${row.rpm} | ` +
        row.chest.map(cell).join(' | ') +
        ' |',
    );
  }
  out.push('', '### Head', '', ...header);
  for (const row of rows) {
    out.push(
      `| ${row.weaponName} | ${row.weaponClass} | ${row.rpm} | ` + row.head.map(cell).join(' | ') + ' |',
    );
  }
  return out.join('\n');
}

function cell(c: TtkCell): string {
  if (c.seconds < 0) return '—';
  // Pellets are reported alongside the pull count only when they differ, which is only
  // ever the shotgun.
  const shots = c.hits === c.pulls ? `${c.pulls}` : `${c.pulls} (${c.hits}p)`;
  return `${c.seconds.toFixed(3)} / ${shots}`;
}

export { PLAYER_ENTITY_ID };
export type { AttachmentId };
