import type { Combatant } from '../ai/Combatant';
import { DamageSystem } from '../combat/DamageSystem';
import { HitboxRig, HUMANOID_RIG } from '../combat/HitboxRig';
import { accuracy, ScoreSystem } from '../combat/ScoreSystem';
import { EV, createGameBus, type GameBus } from '../core/Events';
import { Btn, type InputCommand, type MutableInputCommand } from '../core/InputCommand';
import { DEFAULT_EQUIPMENT_CONFIG } from '../equipment/EquipmentConfig';
import { equipmentDef } from '../equipment/EquipmentDefs';
import { EquipmentSystem } from '../equipment/EquipmentSystem';
import { Health } from '../player/Health';
import { DEFAULT_MOVEMENT_CONFIG } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { DEFAULT_VIEWMODEL_CONFIG } from '../weapons/ViewmodelConfig';
import { requireWeapon } from '../weapons/WeaponDefs';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { ColliderSet } from '../world/ColliderSet';
import { CollisionWorld } from '../world/CollisionWorld';

/**
 * The three shapes that used to push accuracy over 100% (playtest round 5, B5).
 *
 * The report was `CINDER · ACC 267%` out of `25 shots / 62 hits`, and the mechanism is in
 * `combat/ShotAccounting`: the numerator counted **damage events** and the denominator counted
 * **trigger pulls**. This is the numeric half of the fix. It fires the real `WeaponSystem`
 * through the real `Ballistics` into the real `DamageSystem`, and detonates a real frag through
 * `EquipmentSystem`, with a real `ScoreSystem` subscribed to the same bus a match subscribes to
 * — then asks the row what it says.
 *
 * Every row carries both numbers: `legacy`, which is what the board printed before this session
 * (damage events over pulls), and `accuracy`, which is what it prints now (rays over rays). The
 * pair is the evidence. A row where they are equal is a shape that never inflated, and one of
 * the three is exactly that.
 *
 * ## The three shapes, and what each is expected to show
 *
 * - **multi-pellet** — a shotgun. One pull, eight rays, up to eight damage events. This is B5:
 *   the legacy figure runs far over 100 and the honest one cannot.
 * - **penetration** — a rifle through a wooden partition at two targets standing in line. The
 *   brief predicted this inflated too, *"a penetrating round produces one per victim"*. It does
 *   not: `Ballistics.fire` returns the moment a body is hit, and the penetration budget is spent
 *   on world geometry only. The two figures come out equal, which is the measurement that kills
 *   the hypothesis rather than an argument that it is wrong.
 * - **explosive** — the same rifle, plus one frag among three bodies. The blast arrives at
 *   `DamageSystem.apply` under the thrower's own `sourceId` and there is no trigger pull behind
 *   it at all, so it used to add three to the numerator and nothing to the denominator. This is
 *   the second, smaller half of B5 that nobody reported, and it is the shape a knife, a mortar
 *   and a Chopper Gunner's belt share.
 *
 * ## Why it is pure, and belongs at the top of a harness run
 *
 * Fixed seeds, a bare floor, targets that cannot die and cannot move, and a `WeaponSystem`
 * reseeded to a constant: the same rays go to the same places every time. One run is a fact
 * rather than a sample, which is what puts it beside `auditReplicatedScore` and `auditRosterDeal`
 * before the first match rather than inside one.
 */

/** Ticks of held trigger per ballistic shape. Long enough to empty a magazine and reload once. */
const FIRE_TICKS = 260;

const SHOOTER_ID = 0;
const TARGET_BASE = 900;
/** Yaw that looks down +X. Yaw 0 looks down -Z. */
const FACE_EAST = -Math.PI / 2;
const FLOOR_HALF = 300;

/** Nothing here may die: a dead target stops absorbing rounds and truncates the sample. */
const INDESTRUCTIBLE = { max: 1_000_000, regenDelay: 999, regenRate: 0 };

export interface AccuracyRow {
  /** Which of the three shapes this is. */
  readonly shape: string;
  readonly weaponId: string;
  /** `weapon.fired` events — trigger pulls. */
  readonly pulls: number;
  /** `damage.dealt` events with this shooter as the source. The old numerator. */
  readonly damageEvents: number;
  /** Distinct bodies this shooter damaged. One means no round reached a second one. */
  readonly victims: number;
  /** What the row says now. */
  readonly shotsFired: number;
  readonly shotsHit: number;
  /** Rays over rays, percent. -1 when nothing was fired. */
  readonly accuracy: number;
  /** Damage events over pulls, percent: what the board printed before this session. */
  readonly legacy: number;
}

export interface AccuracyAudit {
  readonly rows: readonly AccuracyRow[];
  readonly problems: string[];
}

/**
 * A target that stands still and cannot be killed.
 *
 * A full `Combatant` rather than a bare `Damageable` because `EquipmentSystem` walks the roster
 * to find bodies in the blast radius, and the explosive shape is the whole reason this file
 * exists. Everything a bot would move is a constant.
 */
class Post implements Combatant {
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly health = new Health(INDESTRUCTIBLE);
  readonly team = 'B' as const;
  readonly yaw = Math.PI / 2;
  readonly vx = 0;
  readonly vz = 0;
  readonly eyeHeight = 1.6;
  readonly aimHeight = 1.26;
  readonly quiet = false;
  readonly participating = true;
  readonly glinting = false;

  constructor(
    readonly entityId: number,
    readonly displayName: string,
    readonly px: number,
    readonly py: number,
    readonly pz: number,
  ) {
    this.rig.setTransform(px, py, pz, this.yaw);
  }
}

/** Chest height, read off the rig rather than guessed, so the aim is at a box that exists. */
function chestY(): number {
  for (const box of HUMANOID_RIG.boxes) {
    if (box.name === 'chest') return box.oy;
  }
  return 1.26;
}

/**
 * One shape: a world, a shooter, some posts, and the counters after holding the trigger.
 *
 * `partition` puts a wooden wall between the shooter and the targets, which is what makes the
 * penetration row a penetration row: the round spends budget crossing it and arrives at the
 * first body with less than it left with, exactly as a real wall does.
 */
function fireShape(
  shape: string,
  weaponId: string,
  postsAt: readonly number[],
  partition: boolean,
  frag: boolean,
): AccuracyRow {
  const bus: GameBus = createGameBus();
  const damage = new DamageSystem(bus);
  const score = new ScoreSystem(bus);

  const set = new ColliderSet(8);
  set.add({ x: 0, y: -1, z: 0 }, { x: FLOOR_HALF * 2, y: 2, z: FLOOR_HALF * 2 }, 0, 0, 0, 'floor');
  if (partition) {
    // Thin and soft, so a rifle round crosses it with damage left. A wall a round cannot cross
    // would make this row a measurement of the wall.
    set.add({ x: 3, y: 1.4, z: 0 }, { x: 0.08, y: 2.8, z: 6 }, 0, 0, 0, 'wood');
  }
  const world = new CollisionWorld(
    set,
    { min: { x: -FLOOR_HALF, y: -8, z: -FLOOR_HALF }, max: { x: FLOOR_HALF, y: 24, z: FLOOR_HALF } },
    8,
  );
  world.configure(DEFAULT_MOVEMENT_CONFIG.maxSlopeDeg, DEFAULT_MOVEMENT_CONFIG.collisionSkin);

  const posts: Post[] = postsAt.map((x, i) => new Post(TARGET_BASE + i, `POST${i}`, x, 0, 0));
  for (const post of posts) damage.register(post);

  score.register(SHOOTER_ID, 'SHOOTER', 'A');
  for (const post of posts) score.register(post.entityId, post.displayName, 'B');

  let pulls = 0;
  let damageEvents = 0;
  const victims = new Set<number>();
  const offFired = bus.on(EV.WeaponFired, (p) => {
    if (p.sourceId === SHOOTER_ID) pulls++;
  });
  const offDamage = bus.on(EV.DamageDealt, (p) => {
    if (p.sourceId !== SHOOTER_ID) return;
    damageEvents++;
    victims.add(p.targetId);
  });

  const player = new PlayerController({ ...DEFAULT_MOVEMENT_CONFIG }, world, bus);
  player.spawn(0, 0.2, 0, FACE_EAST);
  const def = requireWeapon(weaponId);
  const weapons = new WeaponSystem(
    def,
    null,
    world,
    damage,
    bus,
    DEFAULT_VIEWMODEL_CONFIG,
    DEFAULT_MOVEMENT_CONFIG.walkSpeed,
    SHOOTER_ID,
  );
  weapons.reseed(0x51e5_0b0a);

  const equipment = frag
    ? new EquipmentSystem({ bus, world, damage, roster: posts, cfg: DEFAULT_EQUIPMENT_CONFIG })
    : null;

  const eyeY = player.sim.y + player.sim.eyeHeight;
  const pitch = Math.atan2(chestY() - eyeY, postsAt[0] ?? 10);
  const cmd: MutableInputCommand = {
    seq: 0,
    tickIndex: 0,
    moveX: 0,
    moveZ: 0,
    yaw: FACE_EAST,
    pitch,
    buttons: 0,
    sampledAtMs: 0,
  };
  const residual = { yaw: 0, pitch: 0 };

  if (equipment !== null) {
    // Dropped at the posts' feet with the fuse nearly burned out, so the blast lands inside the
    // window this row is counting rather than after it. The throw arc is not what the counter
    // reacts to; the three `damage.dealt` events under the thrower's id are.
    const at = postsAt[0] ?? 10;
    equipment.throwFrom(equipmentDef('frag'), SHOOTER_ID, 'A', at, 1.2, 0, FACE_EAST, 0, 0, 0, 2.6, true);
  }

  for (let t = 0; t < FIRE_TICKS; t++) {
    cmd.seq = t;
    cmd.tickIndex = t;
    cmd.buttons = Btn.Fire | Btn.Ads;
    cmd.sampledAtMs = t * 16;
    player.step(cmd as InputCommand);
    weapons.step(cmd as InputCommand, player.sim);
    weapons.takeViewResidual(residual);
    equipment?.simulate(player.sim.x, player.sim.y, player.sim.z, 'A', false);
  }

  offFired();
  offDamage();

  const row = score.row(SHOOTER_ID);
  const shotsFired = row?.shotsFired ?? 0;
  const shotsHit = row?.shotsHit ?? 0;
  const result: AccuracyRow = {
    shape,
    weaponId,
    pulls,
    damageEvents,
    victims: victims.size,
    shotsFired,
    shotsHit,
    accuracy: row === undefined ? -1 : accuracy(row),
    legacy: pulls === 0 ? -1 : (damageEvents / pulls) * 100,
  };

  score.dispose();
  return result;
}

/**
 * Every shape, and what each one proves.
 *
 * The assertions are deliberately about the *invariant* rather than about the numbers: a
 * balance change that moves a shotgun's pellet count or a wall's material must not turn this
 * red, and a change that lets a damage event back into the numerator must.
 */
export function auditAccuracy(): AccuracyAudit {
  const problems: string[] = [];
  const rows: AccuracyRow[] = [
    fireShape('multi-pellet', 'shotgun_breacher', [6], false, false),
    fireShape('penetration', 'ar_carbine', [6, 6.7], true, false),
    // The control the row above is worthless without: the same wall, the same range, the far
    // post alone. If this one connects then the far post is genuinely on the ray, and
    // "penetration damaged one body" is a fact about `Ballistics` rather than about geometry.
    fireShape('penetration-control', 'ar_carbine', [6.7], true, false),
    fireShape('explosive', 'ar_carbine', [10, 10.8, 11.6], false, true),
  ];

  for (const row of rows) {
    if (row.shotsFired === 0) {
      problems.push(
        `${row.shape}: the shooter fired nothing in ${FIRE_TICKS} ticks, so this row measures ` +
          'the rig rather than the code. Check the aim, the range and the magazine.',
      );
      continue;
    }
    if (row.shotsHit === 0) {
      problems.push(
        `${row.shape}: nothing connected, so the numerator is untested. The posts are at a ` +
          'fixed range with the cone authored; a zero here means the shot is not going where ' +
          'this expects.',
      );
    }
    if (row.shotsHit > row.shotsFired) {
      problems.push(
        `${row.shape}: ${row.shotsHit} hits out of ${row.shotsFired} shots — ` +
          `${row.accuracy.toFixed(0)}%. That is B5: a hit is a ray that found a body and there ` +
          'cannot be more of them than there were rays. See combat/ShotAccounting.',
      );
    }
    if (row.shotsFired < row.pulls) {
      problems.push(
        `${row.shape}: ${row.shotsFired} shots from ${row.pulls} pulls. A pull sends at least ` +
          'one ray, so the denominator has lost rounds.',
      );
    }
  }

  const pellet = rows.find((r) => r.shape === 'multi-pellet');
  if (pellet !== undefined && pellet.legacy <= 100) {
    problems.push(
      `multi-pellet: the legacy figure came out at ${pellet.legacy.toFixed(0)}%, so this row no ` +
        'longer reproduces the report it exists to fence. Either the shotgun stopped firing ' +
        'multiple rays or the shot is missing; without the red half the green half proves nothing.',
    );
  }

  const through = rows.find((r) => r.shape === 'penetration');
  const control = rows.find((r) => r.shape === 'penetration-control');
  if (through !== undefined && through.victims !== 1) {
    problems.push(
      `penetration: ${through.victims} bodies took damage from a weapon that fires one ray. ` +
        'A round stops at the first body it reaches — if that has changed, a hit is no longer ' +
        'one ray and combat/ShotAccounting needs rewriting, not patching.',
    );
  }
  if (through !== undefined && through.damageEvents !== through.shotsHit) {
    problems.push(
      `penetration: ${through.damageEvents} damage events from ${through.shotsHit} connecting ` +
        'rays. One ray, one victim, one event is the property the accuracy column rests on.',
    );
  }
  if (control !== undefined && control.shotsHit === 0) {
    problems.push(
      'penetration-control: the far post alone took nothing, so it is not on the ray and the ' +
        'penetration row proves nothing. Move the posts, not the assertion.',
    );
  }

  const explosive = rows.find((r) => r.shape === 'explosive');
  if (explosive !== undefined && explosive.victims < 2) {
    problems.push(
      `explosive: only ${explosive.victims ?? 0} body took damage. The rifle can reach exactly ` +
        'one — the round stops there — so a second victim is the blast, and without it this row ' +
        'is vacuous. Check that the grenade detonated inside the window.',
    );
  }
  if (explosive !== undefined && explosive.accuracy >= explosive.legacy) {
    problems.push(
      `explosive: the row reads ${explosive.accuracy.toFixed(0)}% where the damage-event figure ` +
        `is ${explosive.legacy.toFixed(0)}%. The blast caught bodies no round was fired at, so ` +
        'the two must differ; equal means damage with no trigger pull behind it is back in the ' +
        'numerator.',
    );
  }

  return { rows, problems };
}
