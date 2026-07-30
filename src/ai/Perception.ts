import { DEG2RAD } from '../core/MathUtil';
import type { Rng } from '../core/Rng';
import type { CollisionWorld } from '../world/CollisionWorld';
import { makeRayHit, type RayHit } from '../world/Geometry';
import type { BotBlackboard } from './BotBlackboard';
import type { BotTeam, Combatant } from './Combatant';
import type { PerceptionConfig, TierConfig } from './DifficultyTiers';

/**
 * Sight and hearing (brief S6.3).
 *
 * Runs at ~10 Hz per bot, staggered by `AiScheduler`, and its only output is the bot's
 * blackboard. Three rules shape it:
 *
 * **A 110 degree cone, then a raycast, in that order.** The cone and the range check are
 * arithmetic; the raycast walks the spatial hash. Rejecting on the cheap test first is
 * what keeps ten bots inside the AI budget — with five enemies each at 10 Hz that is 500
 * candidate checks a second, of which only the handful actually in front of someone cost
 * a ray.
 *
 * **Sight is tested against the torso and then the head.** One ray at chest height calls
 * a bot blind to anyone whose chest is behind a barrier but whose head is over it, which
 * on this map is most of the interesting cases. Two rays is the cheapest honest answer.
 *
 * **Hearing produces a place to look, never a target.** S6.3 is explicit: a heard event
 * is an investigate position, not knowledge of where someone is. So the noise field
 * carries the position of the *sound*, the bot walks to it, and if nobody is there it
 * goes back to patrolling — which is exactly what makes suppressing fire and footstep
 * discipline mean something.
 */

export const enum NoiseKind {
  Gunfire = 0,
  Footstep = 1,
  Landing = 2,
}

interface NoiseRecord {
  serial: number;
  kind: NoiseKind;
  sourceId: number;
  team: BotTeam | 'NONE';
  x: number;
  y: number;
  z: number;
}

/** Recent noises. A ring, because a firefight makes a lot of them and none last long. */
const NOISE_CAPACITY = 96;

export class NoiseField {
  private readonly records: NoiseRecord[] = [];
  private head = 0;
  private serial = 0;

  constructor() {
    for (let i = 0; i < NOISE_CAPACITY; i++) {
      this.records.push({ serial: 0, kind: NoiseKind.Footstep, sourceId: -1, team: 'NONE', x: 0, y: 0, z: 0 });
    }
  }

  get currentSerial(): number {
    return this.serial;
  }

  /** Record a sound. Allocation free: the ring slot is overwritten in place. */
  emit(
    kind: NoiseKind,
    sourceId: number,
    team: BotTeam | 'NONE',
    x: number,
    y: number,
    z: number,
  ): void {
    const slot = this.records[this.head];
    if (slot === undefined) return;
    this.serial++;
    slot.serial = this.serial;
    slot.kind = kind;
    slot.sourceId = sourceId;
    slot.team = team;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    this.head = (this.head + 1) % NOISE_CAPACITY;
  }

  reset(): void {
    this.serial = 0;
    this.head = 0;
    for (const r of this.records) r.serial = 0;
  }

  /**
   * Nearest audible noise newer than `afterSerial` made by someone not on `team`, or
   * null. Gunfire carries much further than footsteps, and crouching silences the latter.
   */
  nearestAudible(
    afterSerial: number,
    team: BotTeam,
    x: number,
    z: number,
    cfg: PerceptionConfig,
  ): NoiseRecord | null {
    let best: NoiseRecord | null = null;
    let bestDist = Infinity;
    for (const r of this.records) {
      if (r.serial <= afterSerial) continue;
      if (r.team === team) continue;
      const radius = r.kind === NoiseKind.Gunfire ? cfg.gunfireHearing : cfg.footstepHearing;
      const dist = Math.hypot(r.x - x, r.z - z);
      if (dist > radius) continue;
      if (dist >= bestDist) continue;
      bestDist = dist;
      best = r;
    }
    return best;
  }
}

/** Diagnostics for the scheduler read-out (S7). */
export interface PerceptionStats {
  coneChecks: number;
  losRays: number;
  sightings: number;
}

/**
 * Anything that can block a sight line without being world geometry (M5).
 *
 * `SmokeField` is the only implementation. It is an interface rather than a direct
 * dependency because `ai/` must not reach into `equipment/`, and because a perception
 * system that works with no smoke in the world is the one every M3 measurement was taken
 * against — a null occluder has to stay a legal state.
 */
export interface SightOccluder {
  /** True when the segment is obscured enough that nobody can pick a target through it. */
  blocksSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
}

/**
 * How blind a combatant is right now, 0..1 (M5). Above this, no target is acquired at all.
 *
 * Below it the bot still sees but shoots badly — `CombatBehaviour` widens the aim cone by
 * the same figure — so a partial flash degrades rather than switching the bot off.
 */
export const BLIND_SIGHT_THRESHOLD = 0.35;

/** What the flash field looks like from in here. Same reasoning as `SightOccluder`. */
export interface BlindSource {
  /** 0 = unaffected, 1 = fully blind. */
  blindness(entityId: number): number;
}

export class Perception {
  readonly stats: PerceptionStats = { coneChecks: 0, losRays: 0, sightings: 0 };
  readonly noise = new NoiseField();

  /**
   * Set by the match once equipment exists. Both default to null and every M3 number was
   * measured with them null, which is what makes "smoke changed this" a measurable claim
   * rather than a rewrite.
   */
  occluder: SightOccluder | null = null;
  blindSource: BlindSource | null = null;

  /** Diagnostics: sightings that smoke prevented since the last reset (S7). */
  smokeBlocked = 0;

  private readonly ray: RayHit = makeRayHit();

  constructor(private readonly world: CollisionWorld) {}

  resetStats(): void {
    this.stats.coneChecks = 0;
    this.stats.losRays = 0;
    this.stats.sightings = 0;
    this.smokeBlocked = 0;
  }

  /**
   * One perception sample for one bot. `interval` is the wall-clock gap since this bot's
   * previous sample, which is what turns two sightings into a velocity estimate.
   */
  sense(
    self: Combatant,
    bb: BotBlackboard,
    roster: readonly Combatant[],
    cfg: PerceptionConfig,
    tier: TierConfig,
    rng: Rng,
    interval: number,
  ): void {
    const eyeX = self.px;
    const eyeY = self.py + self.eyeHeight;
    const eyeZ = self.pz;

    // A flashed bot does not look for targets at all until the worst of it has passed
    // (S6.3: "AI blind for 3 s"). It keeps investigating and keeps hearing, which is what
    // makes a flash a window rather than a kill.
    const blind = this.blindSource?.blindness(self.entityId) ?? 0;
    if (blind > BLIND_SIGHT_THRESHOLD) {
      bb.visibleEnemies = 0;
      bb.noteNoSighting();
      this.hear(self, bb, cfg);
      return;
    }

    const halfCone = Math.cos(cfg.visionConeDeg * 0.5 * DEG2RAD);
    const fx = -Math.sin(self.yaw);
    const fz = -Math.cos(self.yaw);

    let bestId = -1;
    let bestScore = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;
    let bestFeetY = 0;
    let bestRange = 0;
    let visible = 0;

    for (const other of roster) {
      if (other === self) continue;
      if (other.team === self.team) continue;
      if (!other.participating || !other.health.alive) continue;

      const dx = other.px - eyeX;
      const dz = other.pz - eyeZ;
      const flat = Math.hypot(dx, dz);
      if (flat > cfg.visionRange) continue;

      this.stats.coneChecks++;
      if (flat > cfg.proximityRadius && flat > 1e-4 && !other.glinting) {
        // Cone test in the horizontal plane: pitch does not narrow peripheral vision.
        // A scope glint skips it — noticing one is exactly the thing that makes you turn.
        const dot = (dx * fx + dz * fz) / flat;
        if (dot < halfCone) continue;
      }

      const aimX = other.px;
      const aimY = other.py + other.aimHeight;
      const aimZ = other.pz;
      this.stats.losRays++;
      let clear = this.world.segmentClear(eyeX, eyeY, eyeZ, aimX, aimY, aimZ, this.ray);
      let hitY = aimY;
      if (!clear) {
        // Chest blocked; the head may still be showing over the same piece of cover.
        const headY = other.py + other.rig.standingHeight - 0.12;
        this.stats.losRays++;
        clear = this.world.segmentClear(eyeX, eyeY, eyeZ, aimX, headY, aimZ, this.ray);
        // Aim at what is actually exposed, not at the chest behind the wall.
        hitY = headY - 0.1;
      }
      if (!clear) continue;

      // Smoke is checked after the geometry ray, not instead of it: it is a *second*
      // occluder over the same segment, and running it first would pay for a volume walk
      // on every candidate a wall was going to reject anyway (S6.3).
      if (this.occluder !== null && this.occluder.blocksSight(eyeX, eyeY, eyeZ, aimX, hitY, aimZ)) {
        this.smokeBlocked++;
        continue;
      }

      visible++;
      // Nearest wins, with a bonus for the target already being engaged so a bot does
      // not flick between two enemies at similar range every perception tick.
      const score = flat - (other.entityId === bb.targetId ? 6 : 0);
      if (score >= bestScore) continue;
      bestScore = score;
      bestId = other.entityId;
      bestX = aimX;
      bestY = hitY;
      bestZ = aimZ;
      bestFeetY = other.py;
      bestRange = Math.hypot(dx, aimY - eyeY, dz);
    }

    bb.visibleEnemies = visible;

    if (bestId >= 0) {
      // A fresh contact — new enemy, or the old one long lost — pays the reaction delay.
      const fresh = bb.targetId !== bestId || bb.sinceLos > 1.2;
      if (fresh) bb.armReaction(rng.range(tier.reactionMin, tier.reactionMax));
      this.stats.sightings++;
      bb.noteSighting(bestId, bestX, bestY, bestZ, bestFeetY, bestRange, interval);
      return;
    }

    bb.noteNoSighting();
    this.hear(self, bb, cfg);
  }

  /** Fold any new audible noise into the blackboard as somewhere to go and look. */
  private hear(self: Combatant, bb: BotBlackboard, cfg: PerceptionConfig): void {
    const heard = this.noise.nearestAudible(bb.noiseCursor, self.team, self.px, self.pz, cfg);
    bb.noiseCursor = this.noise.currentSerial;
    if (heard === null) return;
    // A noise is a place, not a person. Positions are jittered by nothing at all — the
    // imprecision comes from the sound being where the *shot* was, not where the shooter
    // now is, and from the bot having to walk there to find out.
    bb.noteInvestigate(heard.x, heard.y, heard.z);
  }

  /** Line of sight between two arbitrary points. Used by cover scoring and spawn safety. */
  clearLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.world.segmentClear(ax, ay, az, bx, by, bz, this.ray);
  }
}
