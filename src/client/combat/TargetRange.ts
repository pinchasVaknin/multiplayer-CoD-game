import * as THREE from 'three';
import { EV, type GameBus } from '../../shared/core/Events';
import type { HealthConfig } from '../../shared/player/Health';
import { makeGroundProbe, type CollisionWorld } from '../../shared/world/CollisionWorld';
import type { DamageSystem } from '../../shared/combat/DamageSystem';
import { buildDummyMaterials, TargetDummy, type DummyMaterials, type DummySpec } from './TargetDummy';

/**
 * The M2 firing range (brief S6.8).
 *
 * Laid out against the grey-box room's existing measurement lane so the acceptance
 * numbers can be read off the world rather than trusted: the player spawns on the firing
 * line at (-20, -14) facing east, and the targets sit at known distances that bracket the
 * weapon's falloff — one inside `damageFalloff.start`, one on it, and two beyond
 * `damageFalloff.end` behind the penetration panels.
 *
 * Targets are laterally fanned rather than lined up, because targets in a row shadow each
 * other and half the range becomes unusable.
 */

/** Entity ids. 0 is the player (see DamageSystem.PLAYER_ENTITY_ID). */
export const DUMMY_IDS = {
  r5: 1,
  r15: 2,
  r25: 3,
  r40: 4,
  popup: 5,
  strafe: 6,
  penThin: 7,
  penThick: 8,
  // M7, from the M6 playtest notes.
  infinite: 9,
  fallerNear: 10,
  fallerFar: 11,
  strafeFar: 12,
} as const;

const FACING_WEST = Math.PI / 2;

/** Where the player stands to shoot. The grey-box room's marked firing line. */
export const FIRING_LINE = { x: -20, z: -14 } as const;

/**
 * The four measurement ranges the balance table is authored at (S6.5, S7).
 *
 * Each dummy is offset laterally so they do not shadow each other in a line, and its `x`
 * is then solved so the *straight-line* distance from the firing line is exactly the
 * stated range rather than approximately it. A range marked 25 m that is really 25.4 m
 * would put the falloff read-outs a metre out, which is the whole thing this range exists
 * to measure.
 */
/**
 * Laterals re-fanned post-M8, and the 25 m dummy moved again in round 2.
 *
 * The M7 set (-1.4, +2.2, -2.6, +4.6) put the 15 m dummy at a bearing of +8.4° and the 40 m
 * dummy at +6.6°, which is the same direction as far as a 0.5 m-wide silhouette is
 * concerned: the near one stood in front of the far one and the 40 m read could not be taken
 * without walking off the firing line.
 *
 * The rule the new numbers satisfy is the *shadow cone*: a dummy of half-width `w` at range
 * `r` hides a band of half-width `w · R/r` at every range `R` beyond it, centred on
 * `lateral · R/r`. Every pair below clears that band with a metre to spare, so each of the
 * four is visible from the firing line with all the others standing.
 *
 * **Round 2: the 25 m dummy goes -2.4 -> +1.2.** The shadow cone is not only cast by other
 * dummies — the bullseye boards are 1.4 m of solid brush at 10, 16 and 22 m, and re-fanning
 * them out of the north wall (see `maps/greybox.ts`) moved the 16 m board's cone to cover
 * -4.2..-2.0 at 25 m. The 25 m dummy was sitting inside it. The lateral it moves to is the
 * gap between the 22 m board's cone and the corridor to the penetration bay, which is the
 * only free band on that side of the lane; the whole set is checked against the real
 * collision world rather than against this arithmetic, because the arithmetic is what put a
 * board in a wall last time.
 */
const MEASURED: readonly Readonly<{ id: number; range: number; lateral: number }>[] = [
  { id: DUMMY_IDS.r5, range: 5, lateral: 2.4 },
  { id: DUMMY_IDS.r15, range: 15, lateral: 1.6 },
  { id: DUMMY_IDS.r25, range: 25, lateral: 1.2 },
  { id: DUMMY_IDS.r40, range: 40, lateral: 8.0 },
];

function measuredSpecs(): DummySpec[] {
  return MEASURED.map((m) => ({
    id: m.id,
    name: `${m.range} M`,
    behaviour: 'static' as const,
    x: FIRING_LINE.x + Math.sqrt(Math.max(0, m.range * m.range - m.lateral * m.lateral)),
    y: 0,
    z: FIRING_LINE.z + m.lateral,
    yaw: FACING_WEST,
  }));
}

/**
 * Three bays, from the M7 playtest (S3 of the fix list).
 *
 * The range had grown into a scatter of twelve targets in one space, which meant a burst
 * meant for a DPS reading clipped a drill dummy and a group meant for the accuracy wall
 * landed on a faller. Each bay now does exactly one job and low dividers keep them apart:
 *
 *   z = -16.4  ACCURACY  the wall and the three bullseyes. No characters at all.
 *   z = -14    (the marked firing line runs between the two)
 *   z =  -5.5  DRILL     statics and movers, the only bay with things that behave like people.
 *   z =  +4.5  DPS       one dummy that cannot die, alone, so a magazine measures one thing.
 */
// The accuracy bay holds no dummies at all — it is the wall and the bullseyes, authored in
// the map rather than here, which is the point of it being its own bay.
const BAY_DRILL_Z = -5.5;
const BAY_DPS_Z = 4.5;

const SPECS: readonly DummySpec[] = [
  ...measuredSpecs(),
  {
    id: DUMMY_IDS.popup,
    name: 'POP-UP',
    behaviour: 'popup',
    x: FIRING_LINE.x + 9,
    y: 0,
    z: BAY_DRILL_Z + 1.2,
    yaw: FACING_WEST,
    upTime: 3.0,
    downTime: 2.0,
  },
  {
    id: DUMMY_IDS.strafe,
    name: 'STRAFE',
    behaviour: 'strafe',
    x: FIRING_LINE.x + 16,
    y: 0,
    z: BAY_DRILL_Z - 1.0,
    yaw: FACING_WEST,
    travel: 2.2,
    speed: 2.6,
  },
  /**
   * The infinite dummy (M7, M6 playtest item).
   *
   * Straight ahead at a round ten metres, because a DPS figure is only comparable between
   * weapons if the range it was measured at is a number you can state. It never dies, so a
   * whole magazine — reloads and all — goes into it and the read-out is sustained damage
   * rather than a kill.
   */
  {
    id: DUMMY_IDS.infinite,
    name: 'DPS — INFINITE',
    behaviour: 'infinite',
    // Alone in its own bay at a round ten metres: a sustained-damage figure is only
    // comparable between weapons if nothing else was ever in the way.
    x: FIRING_LINE.x + 10,
    y: 0,
    z: BAY_DPS_Z,
    yaw: FACING_WEST,
  },
  /**
   * Two fallers on the near lane.
   *
   * A faller answers the one question a static target cannot: *was that burst lethal?* It
   * drops flat the instant it dies and stands back up a couple of seconds later, so the
   * answer is visible without reading a number off a board.
   */
  {
    id: DUMMY_IDS.fallerNear,
    name: 'FALLER 8 m',
    behaviour: 'faller',
    x: FIRING_LINE.x + 8,
    y: 0,
    z: BAY_DRILL_Z,
    yaw: FACING_WEST,
  },
  {
    id: DUMMY_IDS.fallerFar,
    name: 'FALLER 20 m',
    behaviour: 'faller',
    x: FIRING_LINE.x + 20,
    y: 0,
    z: BAY_DRILL_Z + 2.4,
    yaw: FACING_WEST,
  },
  /** A second mover, further out and quicker, for leading practice. */
  {
    id: DUMMY_IDS.strafeFar,
    name: 'STRAFE 24 m',
    behaviour: 'strafe',
    x: FIRING_LINE.x + 24,
    y: 0,
    z: BAY_DRILL_Z - 2.2,
    yaw: FACING_WEST,
    travel: 4.5,
    speed: 4.2,
  },
  {
    id: DUMMY_IDS.penThin,
    name: 'BEHIND THIN',
    behaviour: 'static',
    x: 22.5,
    y: 0,
    z: -13.5,
    yaw: FACING_WEST,
  },
  {
    id: DUMMY_IDS.penThick,
    name: 'BEHIND THICK',
    behaviour: 'static',
    x: 22.5,
    y: 0,
    z: -10.4,
    yaw: FACING_WEST,
  },
];

/**
 * Where a dummy's feet actually land, given the geometry under its authored position.
 *
 * A thin probe capsule dropped from head height. `CollisionWorld.probeGround` only reports
 * *walkable* contacts, which is the right filter: a dummy should stand on a floor, a step or
 * a ramp, and should not perch on the sloped side of a barricade it happens to overlap.
 *
 * Falls back to the authored `y` when nothing is found — an authored position over the pit
 * is a map error, and silently teleporting the dummy to the pit floor would hide it.
 */
const groundProbe = makeGroundProbe();
const PROBE_FROM = 2.2;
const PROBE_DEPTH = 5;

function groundedSpec(spec: DummySpec, world: CollisionWorld): DummySpec {
  const from = spec.y + PROBE_FROM;
  if (!world.probeGround(spec.x, from, spec.z, 0.2, 0.4, PROBE_DEPTH, groundProbe)) return spec;
  const y = from - groundProbe.distance;
  // Only report a change worth making; a millimetre of probe noise is not a relocation.
  if (Math.abs(y - spec.y) < 0.02) return spec;
  return { ...spec, y };
}

export class TargetRange {
  readonly group = new THREE.Group();
  readonly dummies: TargetDummy[] = [];

  private readonly byId = new Map<number, TargetDummy>();
  private readonly materials: DummyMaterials & { dispose(): void };

  /**
   * `world` is post-M8 and is only used at construction, to put each dummy on the floor.
   *
   * The specs above are authored in plan view with `y: 0`, which is correct for the flat part
   * of the room and wrong everywhere else — the near faller sat at `x = 0, z = -3.1`, which is
   * on top of the 0.3 m step, and the DPS dummy sat inside the 1.5 m ledge. Both were buried
   * to the knee or the chest, which is the reported "models clipping into the ground/ramps".
   *
   * Snapping against the real collision world rather than hand-correcting two `y` values is
   * what stops it coming back: the range is authored over a testbed whose geometry exists to
   * be moved, and the next brush somebody nudges would bury a dummy again.
   */
  constructor(
    private readonly damage: DamageSystem,
    bus: GameBus,
    healthConfig: HealthConfig,
    world?: CollisionWorld,
  ) {
    this.group.name = 'targets';
    this.materials = buildDummyMaterials();

    for (const authored of SPECS) {
      const spec = world === undefined ? authored : groundedSpec(authored, world);
      const dummy = new TargetDummy(spec, healthConfig, this.materials);
      this.dummies.push(dummy);
      this.byId.set(spec.id, dummy);
      this.group.add(dummy.group);
      this.damage.register(dummy);
    }

    // The printed read-out is driven off the damage event rather than off the ballistics
    // call site, so what a target displays is what the DamageSystem actually applied.
    bus.on(EV.DamageDealt, (p) => {
      const dummy = this.byId.get(p.targetId);
      if (dummy === undefined) return;
      dummy.noteHit(p.amount, p.zone, p.distance);
    });
  }

  get(id: number): TargetDummy | undefined {
    return this.byId.get(id);
  }

  /** One sim tick for every target. Each dummy decides when its read-out needs redrawing. */
  step(): void {
    for (const dummy of this.dummies) dummy.step();
  }

  updateVisuals(alpha: number, camera: THREE.Camera): void {
    const p = camera.position;
    for (const dummy of this.dummies) dummy.updateVisual(alpha, p.x, p.y, p.z);
  }

  resetAll(): void {
    for (const dummy of this.dummies) dummy.reset();
  }

  dispose(): void {
    for (const dummy of this.dummies) {
      this.damage.unregister(dummy.entityId);
      dummy.dispose();
    }
    this.dummies.length = 0;
    this.byId.clear();
    this.materials.dispose();
    this.group.clear();
  }
}
