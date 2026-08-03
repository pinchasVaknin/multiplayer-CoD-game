import { makeDamageRequest, type DamageRequest } from '../combat/DamageSystem';
import { DT } from '../core/Loop';
import { TAU } from '../core/MathUtil';
import { makeRayHit, type RayHit } from '../world/Geometry';
import { Killstreak, type StreakContext } from './KillstreakBase';
import type { StreakDef } from './StreakDefs';
import { mortarWeapon } from './StreakWeapons';

/** Module-level scratch: the sim path allocates nothing (S4.7). */
const scratchRay: RayHit = makeRayHit();

/**
 * Mortar Strike (brief S6.1): the player marks a zone, delayed shells land in sequence.
 *
 * The targeting overlay is `ui/MortarOverlay.ts` and is drawn from `MapDef` through the same
 * renderer the minimap uses, exactly as the brief asks. This class starts *after* the mark is
 * confirmed and knows nothing about how it was chosen — which is what lets a bot call one in
 * later with no UI at all.
 *
 * ## The sequence is the point
 *
 * Twelve shells at `mortarInterval` apart, scattered around the mark, is a *zone denial* over
 * six seconds rather than a single instant kill. That is the difference between "a mortar
 * landed on me" (unfair) and "a mortar is landing over there, move" (a decision). The delay
 * before the first shell exists for the same reason: the whistle is the warning, and a strike
 * with no warning is just damage.
 *
 * Damage goes through `DamageSystem.apply` like everything else, so mortar kills feed the
 * killfeed, the score, the challenge tracker and the streak counter with no new wiring — and
 * the brief's "the player body is out of play but **not invulnerable to a lucky mortar**" is
 * true for free, because a chopper gunner's body is still a registered damageable standing
 * where it was left.
 */
export class MortarStrike extends Killstreak {
  readonly markX: number;
  readonly markZ: number;

  /** Shells already landed. Read by the debug panel. */
  fired = 0;

  private timer: number;
  private readonly request: DamageRequest;

  constructor(
    def: StreakDef,
    ownerId: number,
    ownerTeam: 'A' | 'B',
    instanceId: number,
    ctx: StreakContext,
    markX: number,
    markZ: number,
  ) {
    super(def, ownerId, ownerTeam, instanceId, ctx);
    this.markX = markX;
    this.markZ = markZ;
    this.timer = ctx.cfg.mortarDelay;
    // A synthetic weapon: the mortar is not a `WeaponDef`, but `DamageRequest` wants one for
    // its falloff and zone multipliers. Built once and reused, so the sim path allocates none.
    this.request = makeDamageRequest(mortarWeapon(ctx.cfg.mortarDamage));
    this.request.sourceId = ownerId;
  }

  override onActivate(): void {
    this.ctx.present.mortarInbound(this.markX, 0, this.markZ);
  }

  override onTick(_tick: number): boolean {
    this.age += DT;
    this.timer -= DT;
    if (this.timer > 0) return true;
    if (this.fired >= this.ctx.cfg.mortarShells) {
      // Let the last impact's audio breathe before the streak reports itself done.
      return this.age < this.def.durationSeconds;
    }

    this.timer += this.ctx.cfg.mortarInterval;
    this.fired++;
    this.land();
    return true;
  }

  override onExpire(): void {
    /* Nothing persistent: the shells are Fx and damage, both already resolved. */
  }

  override describe(): string {
    return `MORTAR ${this.fired}/${this.ctx.cfg.mortarShells} · mark ${this.markX.toFixed(0)},${this.markZ.toFixed(0)}`;
  }

  /**
   * One shell.
   *
   * Scatter is uniform over the disc (sqrt-weighted radius), so the barrage covers the zone
   * rather than clustering on the mark — a centre-heavy distribution makes the middle lethal
   * and the edge decorative, which is the opposite of zone denial.
   */
  private land(): void {
    const cfg = this.ctx.cfg;
    const angle = this.ctx.rng.float() * TAU;
    const radius = Math.sqrt(this.ctx.rng.float()) * cfg.mortarScatter;
    const x = this.markX + Math.cos(angle) * radius;
    const z = this.markZ + Math.sin(angle) * radius;
    const y = groundAt(this.ctx, x, z);

    this.ctx.present.blast(x, y + 0.4, z, cfg.mortarRadius, true);
    this.ctx.present.mortarImpact(x, y, z);

    // Everything inside the blast, friend or foe. A mortar does not check dog tags — and the
    // brief explicitly wants a chopper gunner's abandoned body to be catchable by one.
    const r2 = cfg.mortarRadius * cfg.mortarRadius;
    for (const c of this.ctx.roster) {
      if (!c.participating) continue;
      const dx = c.px - x;
      const dy = c.py + c.aimHeight - (y + 0.4);
      const dz = c.pz - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;

      // Linear falloff from the centre. Cheap, legible, and survivable at the edge.
      const falloff = 1 - Math.sqrt(d2) / cfg.mortarRadius;
      const req = this.request;
      req.targetId = c.entityId;
      req.zone = 'torso';
      req.distance = 0;
      req.penetrationRetain = Math.max(0, Math.min(1, falloff));
      req.x = c.px;
      req.y = c.py + c.aimHeight;
      req.z = c.pz;
      this.ctx.damage.apply(req);
    }
  }
}

/** Where the floor is under a point, for placing the burst. */
function groundAt(ctx: StreakContext, x: number, z: number): number {
  const from = 40;
  if (!ctx.world.raycast(x, from, z, 0, -1, 0, from + 10, scratchRay)) return 0;
  return from - scratchRay.t;
}
