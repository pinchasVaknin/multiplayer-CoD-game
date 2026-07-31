import type { BlindSource } from '../ai/Perception';
import type { Combatant } from '../ai/Combatant';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { clamp01, RAD2DEG } from '../core/MathUtil';
import type { EquipmentConfig } from './EquipmentConfig';

/**
 * Who is flashed, and how badly (brief S6.3).
 *
 * The brief's requirement is the interesting one: the effect is **scaled by angle to the
 * blast and by whether the target had line of sight**. So this is not a radius test with a
 * boolean output — it is a number per victim, and the same number drives all three
 * consequences:
 *
 *   - the player's screen white-out and audio low-pass,
 *   - a bot's inability to acquire a target (`Perception` refuses above a threshold),
 *   - a bot's aim error below that threshold (`CombatBehaviour` scales its cone).
 *
 * One number, three effects, so a bot and a player are punished by the same curve. A
 * separate "AI blind flag" would drift from what the player experiences within a milestone.
 *
 * Blindness holds at full for the first part of its life and then fades, because a flash
 * that started fading immediately reads as a bright light rather than as being blinded.
 */

export interface FlashState {
  /** Seconds of effect remaining. */
  remaining: number;
  /** Seconds the effect started with — the fade is relative to this. */
  total: number;
}

/** What the last flash did to somebody, for the S8.7 report. */
export interface FlashSample {
  readonly targetId: number;
  readonly angleDeg: number;
  readonly distance: number;
  readonly hadLos: boolean;
  readonly intensity: number;
  readonly seconds: number;
}

const evFlash = {
  targetId: 0,
  sourceId: 0,
  intensity: 0,
  angleDeg: 0,
  distance: 0,
  hadLos: true,
};

export class FlashField implements BlindSource {
  private readonly states = new Map<number, FlashState>();

  /** Every application since the last reset, newest last. Read by the debug panel. */
  readonly samples: FlashSample[] = [];

  /**
   * Per-entity multiplier on incoming intensity (M6: the Battle Hardened perk).
   *
   * Applied at the *source*, before the state is stored and before the event is emitted,
   * so the number the player's white-out uses, the number a bot's perception threshold
   * compares against and the number the debug report prints are all the same one. Scaling
   * only the player's visuals would have made the perk a lie in exactly the direction
   * players notice: still blind to the AI, less blind on screen.
   *
   * Null means "nobody resists", which is what every M5 flash measurement described.
   */
  resistance: ((entityId: number) => number) | null = null;

  constructor(
    private readonly bus: GameBus,
    private readonly cfg: EquipmentConfig,
  ) {}

  /** 0 = unaffected, 1 = fully blind. The `BlindSource` contract `Perception` consumes. */
  blindness(entityId: number): number {
    const state = this.states.get(entityId);
    if (state === undefined) return 0;
    const elapsed = state.total - state.remaining;
    const hold = state.total * this.cfg.flashHoldFraction;
    if (elapsed <= hold) return 1;
    const fadeLength = Math.max(state.total - hold, 1e-3);
    return clamp01((state.total - elapsed) / fadeLength);
  }

  get affectedCount(): number {
    return this.states.size;
  }

  step(): void {
    for (const [id, state] of this.states) {
      state.remaining -= DT;
      if (state.remaining <= 0) this.states.delete(id);
    }
  }

  clear(): void {
    this.states.clear();
    this.samples.length = 0;
  }

  /**
   * Apply a flash to one combatant.
   *
   * `hadLos` is supplied by the caller rather than computed here because the caller
   * already owns the collision world and has just raycast for the blast damage; asking
   * twice would double the ray count for no new information.
   *
   * Returns the applied intensity, 0 when the target was out of range or fully shielded.
   */
  apply(
    target: Combatant,
    sourceId: number,
    blastX: number,
    blastY: number,
    blastZ: number,
    radius: number,
    fullSeconds: number,
    hadLos: boolean,
  ): number {
    const dx = blastX - target.px;
    const dz = blastZ - target.pz;
    const dy = blastY - (target.py + target.eyeHeight);
    const distance = Math.hypot(dx, dy, dz);
    if (distance > radius) return 0;

    // Angle between where the target is looking and the direction to the blast. The
    // horizontal plane only: a flash on the floor in front of you is still in your eyes.
    const flat = Math.hypot(dx, dz);
    const fx = -Math.sin(target.yaw);
    const fz = -Math.cos(target.yaw);
    const cos = flat < 1e-4 ? 1 : (dx * fx + dz * fz) / flat;
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, cos))) * RAD2DEG;

    const resist = this.resistance?.(target.entityId) ?? 1;
    const intensity = this.intensityFor(angleDeg, distance, radius, hadLos) * resist;
    if (intensity <= 0.02) return 0;

    const seconds = fullSeconds * intensity;
    const existing = this.states.get(target.entityId);
    if (existing === undefined || seconds > existing.remaining) {
      this.states.set(target.entityId, { remaining: seconds, total: seconds });
    }

    this.samples.push({
      targetId: target.entityId,
      angleDeg,
      distance,
      hadLos,
      intensity,
      seconds,
    });
    if (this.samples.length > 32) this.samples.shift();

    evFlash.targetId = target.entityId;
    evFlash.sourceId = sourceId;
    evFlash.intensity = intensity;
    evFlash.angleDeg = angleDeg;
    evFlash.distance = distance;
    evFlash.hadLos = hadLos;
    this.bus.emit(EV.EquipmentFlashed, evFlash);
    return intensity;
  }

  /**
   * The scaling curve, exposed so acceptance criterion 7 can be *evaluated* rather than
   * inferred from gameplay: it asks for the magnitude at 0, 45, 90 and 180 degrees.
   *
   * Angle falls off on a cosine-shaped half-angle curve down to `flashRearFraction`, so
   * facing away is a real reprieve rather than immunity — you are still lit up, you simply
   * are not looking at it. Distance falls off linearly to the radius, and no line of sight
   * multiplies the whole thing by `flashNoLosFraction`.
   */
  intensityFor(angleDeg: number, distance: number, radius: number, hadLos: boolean): number {
    const cfg = this.cfg;
    const half = Math.max(cfg.flashHalfAngleDeg, 1);
    // 1 at 0 deg, 0.5 at the half angle, tending to 0 at 180.
    const angleFalloff = 1 / (1 + (angleDeg / half) ** 2);
    const angleTerm = cfg.flashRearFraction + (1 - cfg.flashRearFraction) * angleFalloff;
    const distanceTerm = clamp01(1 - distance / Math.max(radius, 1e-3));
    const losTerm = hadLos ? 1 : cfg.flashNoLosFraction;
    return clamp01(angleTerm * distanceTerm * losTerm);
  }
}
