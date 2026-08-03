import type { Combatant } from '../ai/Combatant';
import type { BotTier, TierConfig } from '../ai/DifficultyTiers';
import { BOT_TIERS } from '../ai/DifficultyTiers';
import { DT } from '../core/Loop';
import { DEG2RAD } from '../core/MathUtil';
import type { Rng } from '../core/Rng';
import type { CollisionWorld, MoveOutput } from '../world/CollisionWorld';
import { makeMoveOutput } from '../world/CollisionWorld';
import type { EquipmentConfig } from './EquipmentConfig';
import { ALL_EQUIPMENT, type EquipmentDef } from './EquipmentDefs';
import type { EquipmentSystem } from './EquipmentSystem';
import { previewTrajectory } from './Projectile';
import { simCos, simSin } from '../core/SimMath';

/**
 * Bots throwing grenades, gated by difficulty tier, without blowing themselves up
 * (brief S6.3).
 *
 * Two things make this honest rather than a dice roll:
 *
 * **The safety check runs the real integration.** `previewTrajectory` steps the same arc
 * through the same collision world the thrown object will use, so "where would this land"
 * is answered by the thing that decides where it lands. A closed-form parabola would be
 * right in the open and wrong in exactly the situation that matters — a bot throwing at a
 * doorway from behind a crate, where the grenade bounces back off the lip.
 *
 * **The tier gate is two-sided.** `TierConfig.grenadeChance` decides whether a tier throws
 * at all, and `EquipmentDef.minBotTier` decides what it is allowed to carry. A Recruit
 * throws nothing; only a Veteran plants claymores.
 *
 * This lives outside `BotBrain` deliberately. The brain is a 4 Hz decision loop over ten
 * states and is already the largest file in `ai/`; grenade policy is an independent, much
 * slower decision that needs the collision world and the equipment system, neither of
 * which the brain has. It is driven from `BotDirector` at its own rate.
 */

/** How long a bot's grenade intent is worth acting on after last seeing the target. */
const STALE_TARGET_SECONDS = 3.0;

/** Minimum range: closer than this and a grenade is slower than shooting. */
const MIN_THROW_RANGE = 7;

/** Seconds of arc to simulate when checking where one would land. */
const PREVIEW_SECONDS = 4.0;

interface ThrowerState {
  cooldown: number;
  /** How many of each slot this bot has left this life. */
  lethal: number;
  tactical: number;
}

export interface ThrowIntent {
  /** Last known enemy position. Not necessarily visible right now. */
  readonly targetX: number;
  readonly targetY: number;
  readonly targetZ: number;
  readonly sinceSeen: number;
  readonly hasTarget: boolean;
}

export class BotThrower {
  /** Diagnostics for the F1 panel. */
  throws = 0;
  rejectedUnsafe = 0;

  private readonly states = new Map<number, ThrowerState>();
  private readonly preview = new Float32Array(3 * 256);
  private readonly move: MoveOutput = makeMoveOutput();

  constructor(
    private readonly system: EquipmentSystem,
    private readonly world: CollisionWorld,
    private readonly cfg: EquipmentConfig,
  ) {}

  reset(): void {
    this.states.clear();
    this.throws = 0;
    this.rejectedUnsafe = 0;
  }

  /** Refill a bot's equipment. Called on spawn, exactly as the player's is. */
  respawn(entityId: number): void {
    this.states.set(entityId, { cooldown: 4, lethal: 1, tactical: 1 });
  }

  /**
   * One evaluation for one bot. Called from the AI scheduler's own rate, not per tick.
   *
   * `elapsed` is the wall gap since this bot's previous evaluation, so the cooldown
   * advances correctly under a staggered scheduler.
   */
  consider(
    self: Combatant,
    tier: BotTier,
    tierCfg: TierConfig,
    intent: ThrowIntent,
    roster: readonly Combatant[],
    rng: Rng,
    elapsed: number,
  ): boolean {
    const state = this.stateFor(self.entityId);
    state.cooldown -= elapsed > 0 ? elapsed : DT;
    if (state.cooldown > 0) return false;
    if (tierCfg.grenadeChance <= 0) return false;
    if (!intent.hasTarget || intent.sinceSeen > STALE_TARGET_SECONDS) return false;

    const range = Math.hypot(intent.targetX - self.px, intent.targetZ - self.pz);
    if (range < MIN_THROW_RANGE || range > tierCfg.grenadeRange) return false;

    // Re-armed on every evaluation whether or not it throws, so a bot that keeps failing
    // the safety check does not spend the whole match testing arcs.
    state.cooldown = tierCfg.grenadeCooldown;
    if (!rng.chance(tierCfg.grenadeChance)) return false;

    const def = this.pickEquipment(tier, state, rng);
    if (def === null) return false;

    const eyeX = self.px;
    const eyeY = self.py + self.eyeHeight;
    const eyeZ = self.pz;

    // Aim at the target with a pitch that lofts the arc onto it. Solved by trying a small
    // ladder of launch angles through the real integrator and keeping the first that lands
    // near enough — a closed-form solution would ignore the wall in the way.
    const yaw = Math.atan2(-(intent.targetX - eyeX), -(intent.targetZ - eyeZ));
    let bestPitch = 0;
    let bestError = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;

    for (const pitchDeg of [4, 10, 16, 24, 34]) {
      const pitch = pitchDeg * DEG2RAD;
      const landed = this.simulateThrow(def, eyeX, eyeY, eyeZ, yaw, pitch);
      if (landed === 0) continue;
      const lx = this.preview[(landed - 1) * 3] ?? 0;
      const ly = this.preview[(landed - 1) * 3 + 1] ?? 0;
      const lz = this.preview[(landed - 1) * 3 + 2] ?? 0;
      const miss = Math.hypot(lx - intent.targetX, lz - intent.targetZ);
      if (miss >= bestError) continue;
      bestError = miss;
      bestPitch = pitch;
      bestX = lx;
      bestY = ly;
      bestZ = lz;
    }

    // A throw that lands more than half a blast radius off the mark is a wasted grenade.
    if (bestError > def.effectRadius * 0.75) return false;

    // The hard rule: never near yourself, and never near a teammate.
    if (!this.isSafe(self, roster, bestX, bestY, bestZ, tierCfg.grenadeSafeRadius)) {
      this.rejectedUnsafe++;
      return false;
    }

    const thrown = this.system.throwFrom(
      def,
      self.entityId,
      self.team,
      eyeX,
      eyeY,
      eyeZ,
      yaw,
      bestPitch,
      self.vx,
      self.vz,
      // Bots do not cook. Judging a fuse by eye is a human skill and a cooking bot is
      // indistinguishable from an unfair one.
      0,
      false,
    );
    if (thrown === null) return false;

    if (def.slot === 'lethal') state.lethal--;
    else state.tactical--;
    this.throws++;
    return true;
  }

  /** Where a throw would land. Returns the number of preview points written. */
  private simulateThrow(
    def: EquipmentDef,
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
  ): number {
    const loft = pitch + def.throwLoftDeg * DEG2RAD;
    const cp = simCos(loft);
    const sp = simSin(loft);
    const sy = simSin(yaw);
    const cy = simCos(yaw);
    const dx = -sy * cp;
    const dy = sp;
    const dz = -cy * cp;
    const speed = def.throwSpeed;
    return previewTrajectory(
      def,
      this.cfg,
      this.world,
      x + dx * this.cfg.throwOffsetForward,
      y + this.cfg.throwOffsetUp + dy * this.cfg.throwOffsetForward,
      z + dz * this.cfg.throwOffsetForward,
      dx * speed,
      dy * speed,
      dz * speed,
      PREVIEW_SECONDS,
      this.preview,
      this.move,
    );
  }

  /**
   * "They must not grenade themselves" (S6.3), checked against the predicted landing
   * point and the whole friendly side rather than against the thrower alone — a bot that
   * kills its own team is the same bug with a better disguise.
   */
  private isSafe(
    self: Combatant,
    roster: readonly Combatant[],
    x: number,
    y: number,
    z: number,
    safeRadius: number,
  ): boolean {
    if (Math.hypot(x - self.px, y - (self.py + 1), z - self.pz) < safeRadius) return false;
    for (const c of roster) {
      if (c === self) continue;
      if (!c.participating) continue;
      if (c.team !== self.team) continue;
      if (Math.hypot(x - c.px, y - (c.py + 1), z - c.pz) < safeRadius * 0.7) return false;
    }
    return true;
  }

  private pickEquipment(tier: BotTier, state: ThrowerState, rng: Rng): EquipmentDef | null {
    const tierIndex = BOT_TIERS.indexOf(tier);
    let best: EquipmentDef | null = null;
    let count = 0;
    for (const def of ALL_EQUIPMENT) {
      if (tierIndex < def.minBotTier) continue;
      if (def.impact === 'plant') continue; // planted equipment is not a thrown answer
      const have = def.slot === 'lethal' ? state.lethal : state.tactical;
      if (have <= 0) continue;
      // Reservoir sample so the choice does not depend on declaration order.
      count++;
      if (rng.float() < 1 / count) best = def;
    }
    return best;
  }

  private stateFor(entityId: number): ThrowerState {
    let state = this.states.get(entityId);
    if (state === undefined) {
      state = { cooldown: 4, lethal: 1, tactical: 1 };
      this.states.set(entityId, state);
    }
    return state;
  }
}
