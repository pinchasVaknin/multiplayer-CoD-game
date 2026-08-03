import { DT } from '../core/Loop';
import type { TunableMeta } from './MovementConfig';

/**
 * Health and regeneration (brief S6.4).
 *
 * Deliberately free of any EventBus coupling: the player and every target dummy own one
 * of these, and the *owner* decides what an event about its health is called. That is
 * what lets M3 hand the same class to a bot without a rename.
 *
 * Runs on sim ticks. `DT` is the constant, never a frame delta.
 */

export interface HealthConfig {
  max: number;
  /** Quiet seconds after the last damage before regeneration starts. */
  regenDelay: number;
  /** HP per second once regeneration has started. */
  regenRate: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  max: 100,
  regenDelay: 4.2,
  regenRate: 40,
};

export const HEALTH_TUNABLES: Readonly<Record<keyof HealthConfig, TunableMeta>> = {
  max: { label: 'Max health', group: 'Health', min: 10, max: 400, step: 5, unit: '' },
  regenDelay: { label: 'Regen delay', group: 'Health', min: 0, max: 12, step: 0.1, unit: 's' },
  regenRate: { label: 'Regen rate', group: 'Health', min: 1, max: 200, step: 1, unit: '/s' },
};

export const HEALTH_CONFIG_KEYS = Object.keys(DEFAULT_HEALTH_CONFIG) as Array<keyof HealthConfig>;

export function healthConfigToSource(cfg: HealthConfig): string {
  const lines = ['export const DEFAULT_HEALTH_CONFIG: HealthConfig = {'];
  for (const key of HEALTH_CONFIG_KEYS) {
    lines.push(`  ${key}: ${Math.round(cfg[key] * 1e4) / 1e4},`);
  }
  lines.push('};');
  return lines.join('\n');
}

export class Health {
  current: number;
  /**
   * Absorbed before `current` and never regenerated (M6, the ARMOUR PLATE field upgrade).
   *
   * A separate pool rather than a raised `max`: regeneration must not refill a plate, and
   * the low-health vignette and heartbeat are driven off `fraction`, which should describe
   * *your* health rather than the armour in front of it. Zero for everybody who never
   * calls `grantOverhealth`, which is every bot and every target dummy — so every M2-M5
   * measurement still describes the same class.
   */
  overhealth = 0;
  /** Seconds since the last damage. Starts high so a fresh entity is not "recovering". */
  sinceDamage = 999;
  alive = true;

  /** True on exactly the tick health changed. Owners read this to emit an event. */
  changedThisTick = false;
  /** Signed change applied on the tick `changedThisTick` was set. */
  lastDelta = 0;

  constructor(private cfg: HealthConfig) {
    this.current = cfg.max;
  }

  setConfig(cfg: HealthConfig): void {
    this.cfg = cfg;
    if (this.current > cfg.max) this.current = cfg.max;
  }

  get max(): number {
    return this.cfg.max;
  }

  get fraction(): number {
    return this.cfg.max > 0 ? this.current / this.cfg.max : 0;
  }

  get regenerating(): boolean {
    return this.alive && this.sinceDamage >= this.cfg.regenDelay && this.current < this.cfg.max;
  }

  reset(): void {
    this.current = this.cfg.max;
    this.overhealth = 0;
    this.sinceDamage = 999;
    this.alive = true;
    this.changedThisTick = false;
    this.lastDelta = 0;
  }

  /** Restore to full without clearing the damage timer's meaning. */
  healFull(): void {
    if (!this.alive) return;
    const before = this.current;
    this.current = this.cfg.max;
    if (this.current === before) return;
    this.changedThisTick = true;
    this.lastDelta = this.current - before;
  }

  /** Add to the absorbing pool. Not capped by `max`; it is not health. */
  grantOverhealth(amount: number): void {
    if (!this.alive || amount <= 0) return;
    this.overhealth += amount;
    this.changedThisTick = true;
    this.lastDelta = 0;
  }

  /**
   * Apply damage. Returns true if this was the lethal hit — true exactly once, so a
   * burst that overkills cannot fire two kill events.
   */
  applyDamage(amount: number): boolean {
    if (!this.alive || amount <= 0) return false;
    let incoming = amount;
    if (this.overhealth > 0) {
      const absorbed = Math.min(this.overhealth, incoming);
      this.overhealth -= absorbed;
      incoming -= absorbed;
      this.sinceDamage = 0;
      this.changedThisTick = true;
      if (incoming <= 0) {
        this.lastDelta = 0;
        return false;
      }
    }
    const before = this.current;
    this.current = Math.max(0, this.current - incoming);
    this.sinceDamage = 0;
    this.changedThisTick = true;
    this.lastDelta = this.current - before;
    if (this.current > 0) return false;
    this.alive = false;
    return true;
  }

  /** One sim tick of regeneration. */
  step(): void {
    this.changedThisTick = false;
    this.lastDelta = 0;
    if (!this.alive) return;
    this.sinceDamage += DT;
    if (this.sinceDamage < this.cfg.regenDelay) return;
    if (this.current >= this.cfg.max) return;
    const before = this.current;
    this.current = Math.min(this.cfg.max, this.current + this.cfg.regenRate * DT);
    this.changedThisTick = true;
    this.lastDelta = this.current - before;
  }
}
