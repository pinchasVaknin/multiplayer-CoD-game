import type { Combatant } from '../ai/Combatant';
import { CombatBehaviour } from '../ai/CombatBehaviour';
import { BotBlackboard } from '../ai/BotBlackboard';
import type { TierConfig } from '../ai/DifficultyTiers';
import { buildLayout, HitboxRig, type RigLayout } from '../combat/HitboxRig';
import { makeDamageRequest, type Damageable, type DamageRequest } from '../combat/DamageSystem';
import { Ballistics, makeShotTrace, type ShotTrace } from '../weapons/Ballistics';
import { EV } from '../core/Events';
import { DT } from '../core/Loop';
import { angleDelta, clamp, DEG2RAD } from '../core/MathUtil';
import { Health } from '../player/Health';
import { makeRayHit, type RayHit } from '../world/Geometry';
import { Killstreak, type StreakContext } from './KillstreakBase';
import type { StreakDef } from './StreakDefs';
import { sentryWeapon } from './StreakWeapons';
import { simCos, simSin } from '../core/SimMath';

/** Module-level scratch. The sim path allocates nothing (S4.7). */
const scratchRay: RayHit = makeRayHit();

/**
 * Sentry Gun (brief S6.1): placeable, auto-targets, destructible, 90 s.
 *
 * ## "It should use the *bot* aim model, not a perfect one"
 *
 * That line is the whole design of this file, and it is why the sentry owns a real
 * `CombatBehaviour` and a real `BotBlackboard` rather than a `lookAt` and a timer. Everything
 * that makes a bot miss applies unchanged:
 *
 *  - The aim is slewed at a turn rate, so a sentry cannot answer somebody who walks behind it
 *    instantly — it has to physically come round.
 *  - `onContact` snaps the error out to the first-burst cone, so the opening rounds are wrong
 *    on purpose and the target is *told* it is being shot at before it can be killed.
 *  - The error then converges, so standing still in front of a sentry gets steadily worse.
 *  - The trigger is gated on the aim having arrived, so it never sprays through a turn.
 *
 * The sentry gets its own `TierConfig` rather than borrowing a bot's, because a turret is not a
 * difficulty setting — but every *field* is one a bot tier has, so the model is genuinely
 * shared rather than re-implemented. Acceptance criterion 7 asks for the hit rate, and
 * `shotsFired`/`shotsHit` are counted here for exactly that.
 *
 * ## Destructible, and Cold-Blooded
 *
 * The sentry is a `Damageable` with a `HitboxRig`, registered with `DamageSystem` like any
 * combatant — so shooting it down uses the ordinary ballistics path and produces an ordinary
 * killfeed entry. `ctx.targetable` is the M6 Cold-Blooded hook: a target that fails it is never
 * acquired, which is the perk's entire effect and is invisible to this class.
 */
export class SentryGun extends Killstreak implements Damageable {
  readonly entityId: number;
  readonly displayName = 'SENTRY';
  readonly health: Health;
  readonly rig = new HitboxRig(SENTRY_RIG);
  readonly team: 'A' | 'B';

  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The direction it was placed facing; it watches an arc around this. */
  readonly restYaw: number;

  /** Acceptance criterion 7. */
  shotsFired = 0;
  shotsHit = 0;
  kills = 0;

  /** Who it is shooting at, for the debug panel. -1 when idle. */
  targetId = -1;

  private readonly combat = new CombatBehaviour();
  private readonly blackboard = new BotBlackboard();
  private readonly tier: TierConfig;
  private readonly request: DamageRequest;
  private readonly ballistics: Ballistics;
  private readonly trace: ShotTrace = makeShotTrace();

  /**
   * Where the turret is pointing, relative to the base's placed facing (M9).
   *
   * The turret used to be a `THREE.Object3D` this class rotated directly. It is two numbers;
   * `client/streaks/SentryMesh.ts` reads them and rotates its own node. The hitbox rig is
   * driven from the same aim in `applyPose`, so what a shot tests against and what a player
   * sees still come from one place — they simply are not the same object any more.
   */
  turretYaw = 0;
  turretPitch = 0;

  private fireTimer = 0;
  private reaction = 0;
  private destroyed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    def: StreakDef,
    ownerId: number,
    ownerTeam: 'A' | 'B',
    instanceId: number,
    ctx: StreakContext,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    super(def, ownerId, ownerTeam, instanceId, ctx);
    this.entityId = ctx.nextEntityId();
    this.team = ownerTeam;
    this.x = x;
    this.y = y;
    this.z = z;
    this.restYaw = yaw;
    // No regeneration: a sentry that heals is a sentry nobody can remove.
    this.health = new Health({ max: ctx.cfg.sentryHealth, regenDelay: Infinity, regenRate: 0 });
    this.tier = sentryTier(ctx);
    this.request = makeDamageRequest(sentryWeapon(ctx.cfg.sentryDamage));
    this.request.sourceId = this.entityId;
    // The same trace everything else in the project shoots with: rigs, world, penetration,
    // falloff and the damage door, in one call (S4.3/S4.4).
    this.ballistics = new Ballistics(ctx.world, ctx.damage, ctx.bus);
    this.combat.reset(yaw, 0);
  }

  override onActivate(): void {
    this.rig.setTransform(this.x, this.y, this.z, this.restYaw);
    this.ctx.damage.register(this);

    // Shot down: the ordinary damage path kills it like anything else.
    this.unsubscribe = this.ctx.bus.on(EV.EntityKilled, (p) => {
      if (p.targetId !== this.entityId) return;
      this.destroyed = true;
      const ev = {
        streakId: this.def.id,
        instanceId: this.instanceId,
        ownerId: this.ownerId,
        byId: p.sourceId,
        x: this.x,
        y: this.y,
        z: this.z,
      };
      this.ctx.bus.emit(EV.StreakDestroyed, ev);
      this.ctx.present.blast(this.x, this.y + 0.5, this.z, 2.2, true);
      this.ctx.present.sentryDestroyed(this.x, this.y, this.z);
    });

    this.ctx.present.sentryDeploy(this.x, this.y, this.z);
  }

  override onTick(_tick: number): boolean {
    this.age += DT;
    if (this.destroyed) return false;

    const target = this.acquire();
    this.targetId = target?.entityId ?? -1;

    if (target === undefined) {
      // Nothing in the arc: sweep back toward the placed facing rather than freezing.
      this.combat.lookToward(this.tier, this.restYaw, 0);
      this.reaction = 0;
      return this.age < this.def.durationSeconds;
    }

    // The blackboard is what `CombatBehaviour` reads. Filled through `noteSighting`, the same
    // call `Perception` uses for a bot — which is what makes the velocity estimate (and so the
    // lead, and so the misses on a moving target) identical to a bot's rather than a copy.
    const bb = this.blackboard;
    const eyeY = this.y + SENTRY_EYE_HEIGHT;
    const first = target.entityId !== bb.targetId;
    const aimY = target.py + target.aimHeight;
    const range = Math.hypot(target.px - this.x, aimY - eyeY, target.pz - this.z);
    bb.noteSighting(target.entityId, target.px, aimY, target.pz, target.py, range, SENTRY_SENSE_INTERVAL);

    // A fresh contact pays the reaction delay and starts wide (the miss-first-burst rule).
    if (first) {
      this.combat.onContact(this.tier, this.ctx.rng);
      this.reaction = this.ctx.cfg.sentryReactionSeconds;
    }
    if (this.reaction > 0) this.reaction -= DT;
    bb.reactionPaid = this.reaction <= 0;

    this.combat.updateAim(this.tier, bb, this.x, eyeY, this.z, this.ctx.rng);
    this.combat.updateTrigger(
      this.tier,
      SENTRY_PROFILE,
      bb,
      this.ctx.rng,
      // A sentry has no magazine; a constant keeps the burst counter counting rounds.
      999,
      true,
      bb.lastKnownRange,
      true,
    );

    this.stepFiring();
    this.applyPose();
    return this.age < this.def.durationSeconds;
  }

  override onExpire(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx.damage.unregister(this.entityId);
  }

  override describe(): string {
    const hitRate = this.shotsFired > 0 ? ((this.shotsHit / this.shotsFired) * 100).toFixed(1) : '—';
    const state = this.destroyed ? 'DESTROYED' : this.targetId >= 0 ? `-> #${this.targetId}` : 'scanning';
    return `SENTRY #${this.instanceId} ${state} · hp ${this.health.current.toFixed(0)} · ${this.shotsHit}/${this.shotsFired} (${hitRate}%) · ${this.secondsRemaining.toFixed(0)}s`;
  }

  // -- internals --------------------------------------------------------------

  /**
   * The closest enemy inside range, inside the watched arc, with a clear line.
   *
   * Cold-Blooded (M6) is applied first, so a protected target is never even considered — the
   * sentry does not track it, does not turn toward it, and does not report it as a target.
   */
  private acquire(): Combatant | undefined {
    const cfg = this.ctx.cfg;
    const eyeY = this.y + SENTRY_EYE_HEIGHT;
    let best: Combatant | undefined;
    let bestD = Infinity;

    for (const c of this.ctx.roster) {
      if (!c.participating || c.team === this.team) continue;
      if (!this.ctx.targetable(c.entityId)) continue;

      const tx = c.px;
      const ty = c.py + c.aimHeight;
      const tz = c.pz;
      const d = Math.hypot(tx - this.x, ty - eyeY, tz - this.z);
      if (d > cfg.sentryRange || d >= bestD) continue;

      // Inside the arc it was placed watching. A sentry covers a lane, not a sphere.
      const bearing = Math.atan2(-(tx - this.x), -(tz - this.z));
      if (Math.abs(angleDelta(this.restYaw, bearing)) > cfg.sentryArcDeg * DEG2RAD) continue;

      if (!this.ctx.world.segmentClear(this.x, eyeY, this.z, tx, ty, tz, scratchRay)) continue;
      bestD = d;
      best = c;
    }
    return best;
  }

  /** Rate-limited fire. Every round goes down the ordinary ballistics path. */
  private stepFiring(): void {
    const interval = 60 / Math.max(1, this.ctx.cfg.sentryRpm);
    this.fireTimer -= DT;
    if (!this.combat.wantsFire || this.fireTimer > 0) return;
    this.fireTimer = interval;

    const eyeY = this.y + SENTRY_EYE_HEIGHT;
    const yaw = this.combat.aimYaw;
    const pitch = this.combat.aimPitch;
    const cp = simCos(pitch);
    const dx = -simSin(yaw) * cp;
    const dy = simSin(pitch);
    const dz = -simCos(yaw) * cp;

    this.shotsFired++;
    this.ctx.present.sentryShot(this.x, eyeY, this.z);

    const def = sentryWeapon(this.ctx.cfg.sentryDamage);
    this.request.weapon = def;
    this.ballistics.fire(this.x, eyeY, this.z, dx, dy, dz, def, this.request, this.trace);

    this.ctx.present.tracer(this.x, eyeY, this.z, this.trace.endX, this.trace.endY, this.trace.endZ);
    if (this.trace.hitTarget) this.shotsHit++;
    if (this.trace.lethal) this.kills++;
  }

  private applyPose(): void {
    // The turret's own yaw is relative to the base, which was placed facing `restYaw`.
    this.turretYaw = angleDelta(this.restYaw, this.combat.aimYaw);
    this.turretPitch = clamp(-this.combat.aimPitch, -0.7, 0.7);
    this.rig.setTransform(this.x, this.y, this.z, this.combat.aimYaw);
  }
}

/** Where the sentry sees and shoots from, above its base. */
const SENTRY_EYE_HEIGHT = 0.74;

/**
 * The interval `noteSighting` differentiates positions over.
 *
 * A sentry senses every tick, so this is `DT`. It matters because the blackboard derives target
 * velocity from consecutive sightings, and a wrong interval would give the aim solution a wrong
 * lead — which is the difference between a turret that tracks and one that trails.
 */
const SENTRY_SENSE_INTERVAL = DT;

/**
 * The sentry's aim tier.
 *
 * Every field is one a bot tier has, so `CombatBehaviour` is genuinely shared rather than
 * re-implemented — but the values are its own. It is deliberately between Regular and Hardened:
 * a sentry that never misses is a turret nobody can walk past, and one that never hits is
 * scenery. The wide `firstBurstConeDeg` is what gives a player crossing its arc the warning
 * burst that lets them back out.
 */
function sentryTier(ctx: StreakContext): TierConfig {
  // Spread a real tier rather than list every field: a field added to `TierConfig` must not be
  // able to leave the sentry half-initialised, and the point is that this *is* the bot model.
  return {
    ...ctx.tiers.HARDENED,
    aimConeDeg: 3.4,
    firstBurstConeDeg: 7.5,
    firstBurstHold: 0.5,
    trackingErrorDeg: 0.32,
    convergeRate: 3.1,
    turnRateDeg: ctx.cfg.sentryTurnRateDeg,
    leadFraction: 0.55,
    burstMin: 5,
    burstMax: 9,
    burstPauseMin: 0.22,
    burstPauseMax: 0.4,
    engageRange: ctx.cfg.sentryRange,
    // A turret has no sights to come up and never moves, so these are inert for it.
    adsRange: 0,
    flankChance: 0,
    pushAggression: 0,
    rangeErrorStart: 14,
    rangeErrorPerTenM: 0.7,
  };
}

/** A sentry's "weapon profile": it never moves, so only the trigger gates matter. */
const SENTRY_PROFILE = {
  preferredRange: 14,
  minComfortRange: 0,
  pushScale: 0,
  engageScale: 1,
  adsScale: 0,
} as const;

/**
 * The sentry's hitbox: one box, roughly the size of the model.
 *
 * Deliberately not `HUMANOID_RIG` — a turret has no head to shoot off, and giving it head
 * multipliers would make it die to a lucky spray in a way a 260 HP object should not.
 */
const SENTRY_RIG: RigLayout = buildLayout('sentry', [
  { name: 'body', zone: 'torso', ox: 0, oy: 0.68, oz: 0, sx: 0.42, sy: 0.42, sz: 0.42 },
  { name: 'legs', zone: 'leg', ox: 0, oy: 0.3, oz: 0, sx: 0.36, sy: 0.6, sz: 0.36 },
]);
