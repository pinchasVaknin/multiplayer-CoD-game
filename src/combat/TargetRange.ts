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
  near: 1,
  popup: 2,
  strafe: 3,
  falloff: 4,
  penThin: 5,
  penThick: 6,
} as const;

const FACING_WEST = Math.PI / 2;

const SPECS: readonly DummySpec[] = [
  {
    id: DUMMY_IDS.near,
    name: 'A · CLOSE',
    behaviour: 'static',
    x: -15,
    y: 0,
    z: -12.8,
    yaw: FACING_WEST,
  },
  {
    id: DUMMY_IDS.popup,
    name: 'B · POP-UP',
    behaviour: 'popup',
    x: -11,
    y: 0,
    z: -16.2,
    yaw: FACING_WEST,
    upTime: 3.0,
    downTime: 2.0,
  },
  {
    id: DUMMY_IDS.strafe,
    name: 'C · STRAFE',
    behaviour: 'strafe',
    x: -4,
    y: 0,
    z: -10.5,
    yaw: FACING_WEST,
    travel: 2.2,
    speed: 2.6,
  },
  {
    id: DUMMY_IDS.falloff,
    name: 'D · FALLOFF',
    behaviour: 'static',
    x: 6,
    y: 0,
    z: -16.4,
    yaw: FACING_WEST,
  },
  {
    id: DUMMY_IDS.penThin,
    name: 'E · BEHIND THIN',
    behaviour: 'static',
    x: 22.5,
    y: 0,
    z: -13.5,
    yaw: FACING_WEST,
  },
  {
    id: DUMMY_IDS.penThick,
    name: 'F · BEHIND THICK',
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
