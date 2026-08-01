import * as THREE from 'three';
import { EV, type GameBus } from '../core/Events';
import type { HealthConfig } from '../player/Health';
import type { DamageSystem } from './DamageSystem';
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
const MEASURED: readonly Readonly<{ id: number; range: number; lateral: number }>[] = [
  { id: DUMMY_IDS.r5, range: 5, lateral: -1.4 },
  { id: DUMMY_IDS.r15, range: 15, lateral: 2.2 },
  { id: DUMMY_IDS.r25, range: 25, lateral: -2.6 },
  { id: DUMMY_IDS.r40, range: 40, lateral: 4.6 },
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

const SPECS: readonly DummySpec[] = [
  ...measuredSpecs(),
  {
    id: DUMMY_IDS.popup,
    name: 'POP-UP',
    behaviour: 'popup',
    x: -11,
    y: 0,
    z: -17.0,
    yaw: FACING_WEST,
    upTime: 3.0,
    downTime: 2.0,
  },
  {
    id: DUMMY_IDS.strafe,
    name: 'STRAFE',
    behaviour: 'strafe',
    x: -4,
    y: 0,
    z: -9.4,
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
    x: FIRING_LINE.x + 10,
    y: 0,
    z: FIRING_LINE.z,
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
    z: FIRING_LINE.z + 4.2,
    yaw: FACING_WEST,
  },
  {
    id: DUMMY_IDS.fallerFar,
    name: 'FALLER 20 m',
    behaviour: 'faller',
    x: FIRING_LINE.x + 20,
    y: 0,
    z: FIRING_LINE.z + 4.2,
    yaw: FACING_WEST,
  },
  /** A second mover, further out and quicker, for leading practice. */
  {
    id: DUMMY_IDS.strafeFar,
    name: 'STRAFE 24 m',
    behaviour: 'strafe',
    x: FIRING_LINE.x + 24,
    y: 0,
    z: FIRING_LINE.z - 5.5,
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

export class TargetRange {
  readonly group = new THREE.Group();
  readonly dummies: TargetDummy[] = [];

  private readonly byId = new Map<number, TargetDummy>();
  private readonly materials: DummyMaterials & { dispose(): void };

  constructor(
    private readonly damage: DamageSystem,
    bus: GameBus,
    healthConfig: HealthConfig,
  ) {
    this.group.name = 'targets';
    this.materials = buildDummyMaterials();

    for (const spec of SPECS) {
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
