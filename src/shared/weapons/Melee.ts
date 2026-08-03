import { makeDamageRequest, type DamageRequest, type DamageSystem } from '../combat/DamageSystem';
import { makeRigHit, type RigHit } from '../combat/HitboxRig';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { clamp01 } from '../core/MathUtil';
import type { PlayerSim } from '../player/PlayerState';
import type { CollisionWorld } from '../world/CollisionWorld';
import { makeRayHit, type RayHit } from '../world/Geometry';
import { AR_DEFAULT, cloneWeaponDef, type WeaponDef } from './WeaponDefs';

/**
 * The knife (post-M8 playtest; given a blade in round 2).
 *
 * The state machine below is unchanged — QA's report was that the mechanic "works well
 * technically and kills in one hit" and only the *presentation* was wrong. Post-M8 shipped it
 * as a weapon bash because a second viewmodel looked like a lot of machinery for a half-second
 * arc. It is not, as it turns out: a knife has no magazine, no charging handle, no muzzle and
 * no sights, so it is one static group and one three-pose arc. See `weapons/KnifeMesh.ts` for
 * the model and `ViewmodelAnim.poseKnife` for the swing; nothing in this file needed to know.
 *
 * ## Why it is its own system and not a weapon
 *
 * The obvious implementation is a third `Inventory` slot, and it is wrong for the reason the
 * inventory exists: a slot is something you *swap to*, with a put-away, a take-out and a
 * `raise` that gates firing. A knife is none of that — it is a thing you do while holding the
 * rifle, and the rifle is still in your hands afterwards. Modelling it as a slot would mean a
 * swap animation on both sides of every swing and a weapon that can be "left out".
 *
 * So it is a small state machine that runs alongside `WeaponSystem`, borrows its own
 * `WeaponDef` for the damage door, and lowers the rifle for the duration by the same
 * `fireBlocked` flag a grenade throw already uses. One rule for "something else has the
 * hands", three things that can set it.
 *
 * ## The swing has three parts and only one of them touches anything
 *
 * `WINDUP` is the arm coming back, `STRIKE` is the single tick the hitbox test runs, and
 * `RECOVER` is the rifle coming back up. The test is one tick rather than a window because a
 * swept hitbox over eight ticks lets a player knife somebody who walked *behind* them
 * mid-animation — which is the classic melee-lunge bug and is not worth the reach it buys.
 *
 * The test itself is a ray from the eye against every registered rig, nearest first, with a
 * world segment check behind it so a knife cannot reach through a wall it is touching. That
 * is deliberately the same shape as `Ballistics` rather than a sphere overlap: a melee that
 * connects through geometry is the other classic bug, and the world already knows how to
 * answer "is there anything between these two points".
 */

/** Seconds the arm takes to come back before the strike lands. */
const WINDUP_SECONDS = 0.12;
/** Seconds after the strike before the weapon is usable again. */
const RECOVER_SECONDS = 0.42;
/** Seconds between the *start* of one swing and the earliest start of the next. */
const COOLDOWN_SECONDS = 0.72;

/**
 * Reach, metres, from the eye.
 *
 * Deliberately short. 2.0 m is roughly an arm plus a lunge and it is the number that makes
 * knifing a decision rather than a ranged option — at 3 m it starts winning fights the rifle
 * should have won.
 */
export const MELEE_RANGE = 2.0;

/**
 * Damage. Lethal against a full-health operator with a wide margin, and it stays lethal
 * through the limb multiplier, which is what stops a connecting knife reading as a whiff
 * because it clipped an arm.
 */
const MELEE_DAMAGE = 190;

export type MeleePhase = 'IDLE' | 'WINDUP' | 'STRIKE' | 'RECOVER';

let knifeDef: WeaponDef | null = null;

/**
 * The knife's `WeaponDef`.
 *
 * Built by cloning the carbine and overriding what matters, exactly as `streaks/StreakWeapons`
 * does and for the same reason: it guarantees every field the schema requires is present, so
 * adding one cannot leave the knife half-initialised. The killfeed reads `name` off this.
 */
export function meleeWeapon(): WeaponDef {
  if (knifeDef !== null) return knifeDef;
  const def = cloneWeaponDef(AR_DEFAULT);
  def.id = 'melee_knife';
  def.name = 'KNIFE';
  def.damage.near = MELEE_DAMAGE;
  def.damage.far = MELEE_DAMAGE;
  // Every zone kills. A knife that needed a torso hit would be a knife that misses.
  def.headshotMult = 1;
  def.limbMult = 1;
  def.upperTorsoMult = 1;
  // No falloff inside its own reach, and it can never be fired beyond it.
  def.damageFalloff.start = 1000;
  def.damageFalloff.end = 1001;
  def.penetration = 0;
  def.minimapPing = false;
  knifeDef = def;
  return def;
}

export interface MeleeDeps {
  readonly world: CollisionWorld;
  readonly damage: DamageSystem;
  readonly bus: GameBus;
  /** Who is swinging. Stamps the damage request, so the killfeed credits the right operator. */
  readonly sourceId: number;
}

const evSwing = { sourceId: 0, x: 0, y: 0, z: 0, hit: false, lethal: false };

export class Melee {
  phase: MeleePhase = 'IDLE';

  /** True on the tick a swing connected. Read by the feedback layer for the hitmarker. */
  hitThisTick = false;
  /** True on the tick a swing killed. */
  lethalThisTick = false;

  private timer = 0;
  private cooldown = 0;
  private readonly request: DamageRequest;
  private readonly rigHit: RigHit = makeRigHit();
  private readonly bestHit: RigHit = makeRigHit();
  private readonly ray: RayHit = makeRayHit();

  constructor(private readonly deps: MeleeDeps) {
    this.request = makeDamageRequest(meleeWeapon());
    this.request.sourceId = deps.sourceId;
  }

  /**
   * True while the knife owns the hands.
   *
   * Read by `Match` into `WeaponSystem.fireBlocked` and by the viewmodel, so what you can do
   * and what you can see agree — the same contract `ThrowController.busy` has.
   */
  get busy(): boolean {
    return this.phase !== 'IDLE';
  }

  /**
   * 0..1 through the whole swing, for the viewmodel.
   *
   * One number across all three phases rather than one per phase: the animation is a single
   * arc, and giving it three inputs would let the pose disagree with the state machine.
   */
  get fraction(): number {
    if (this.phase === 'IDLE') return 0;
    const total = WINDUP_SECONDS + RECOVER_SECONDS;
    const done = this.phase === 'WINDUP' ? WINDUP_SECONDS - this.timer : WINDUP_SECONDS + (RECOVER_SECONDS - this.timer);
    return clamp01(done / Math.max(total, 1e-3));
  }

  reset(): void {
    this.phase = 'IDLE';
    this.timer = 0;
    this.cooldown = 0;
    this.hitThisTick = false;
    this.lethalThisTick = false;
  }

  /**
   * One sim tick. `pressed` is the edge, computed in the sim from the bitfield (S4.2).
   *
   * `alive` is false while dead, for the same reason `ThrowController` takes it: a corpse
   * must not finish a swing, and a swing that survived a respawn would land on whoever
   * happened to be standing in front of the next life.
   */
  step(pressed: boolean, sim: PlayerSim, alive: boolean): void {
    this.hitThisTick = false;
    this.lethalThisTick = false;

    if (!alive) {
      this.reset();
      return;
    }

    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - DT);

    if (this.phase === 'IDLE') {
      if (pressed && this.cooldown <= 0) this.begin();
      return;
    }

    this.timer -= DT;
    if (this.timer > 0) return;

    if (this.phase === 'WINDUP') {
      // The one tick that touches anything.
      this.phase = 'STRIKE';
      this.strike(sim);
      this.phase = 'RECOVER';
      this.timer = RECOVER_SECONDS;
      return;
    }
    this.phase = 'IDLE';
    this.timer = 0;
  }

  // -- internals --------------------------------------------------------------

  private begin(): void {
    this.phase = 'WINDUP';
    this.timer = WINDUP_SECONDS;
    this.cooldown = COOLDOWN_SECONDS;
  }

  /**
   * Resolve the swing: nearest rig inside the reach, with nothing solid in between.
   *
   * The pitch term is kept, so knifing somebody below you on a ramp works and knifing the
   * floor does not connect with the man standing on the walkway above it.
   */
  private strike(sim: PlayerSim): void {
    const ox = sim.x;
    const oy = sim.y + sim.eyeHeight;
    const oz = sim.z;
    const cp = Math.cos(sim.pitch);
    const dx = -Math.sin(sim.yaw) * cp;
    const dy = Math.sin(sim.pitch);
    const dz = -Math.cos(sim.yaw) * cp;

    let bestT = MELEE_RANGE;
    let bestId = -1;
    for (const target of this.deps.damage.list) {
      if (target.entityId === this.deps.sourceId) continue;
      if (!target.health.alive || target.invulnerable === true) continue;
      if (!target.rig.raycast(ox, oy, oz, dx, dy, dz, MELEE_RANGE, this.rigHit)) continue;
      if (this.rigHit.t >= bestT) continue;
      bestT = this.rigHit.t;
      bestId = target.entityId;
      copyRigHit(this.rigHit, this.bestHit);
    }

    const px = ox + dx * bestT;
    const py = oy + dy * bestT;
    const pz = oz + dz * bestT;

    evSwing.sourceId = this.deps.sourceId;
    evSwing.x = px;
    evSwing.y = py;
    evSwing.z = pz;
    evSwing.hit = false;
    evSwing.lethal = false;

    // A wall between the eye and the target means the arm never got there. Checked after the
    // rig search rather than before, because the segment is only known once a target is.
    if (bestId < 0 || !this.deps.world.segmentClear(ox, oy, oz, px, py, pz, this.ray)) {
      this.deps.bus.emit(EV.MeleeSwing, evSwing);
      return;
    }

    const req = this.request;
    req.weapon = meleeWeapon();
    req.targetId = bestId;
    req.zone = this.bestHit.zone;
    req.upperTorso = this.bestHit.upper;
    req.distance = bestT;
    req.penetrationRetain = 1;
    req.x = px;
    req.y = py;
    req.z = pz;

    const dealt = this.deps.damage.apply(req);
    this.hitThisTick = dealt > 0;
    // `apply` returns 0 for a friendly in a mode with friendly fire off, which is a miss as
    // far as the swinger is concerned — no hitmarker for a knife that bounced off a teammate.
    this.lethalThisTick = dealt > 0 && !this.targetAlive(bestId);
    evSwing.hit = this.hitThisTick;
    evSwing.lethal = this.lethalThisTick;
    this.deps.bus.emit(EV.MeleeSwing, evSwing);
  }

  private targetAlive(entityId: number): boolean {
    return this.deps.damage.get(entityId)?.health.alive === true;
  }
}

function copyRigHit(src: RigHit, dst: RigHit): void {
  dst.t = src.t;
  dst.zone = src.zone;
  dst.boxIndex = src.boxIndex;
  dst.upper = src.upper;
  dst.nx = src.nx;
  dst.ny = src.ny;
  dst.nz = src.nz;
}
