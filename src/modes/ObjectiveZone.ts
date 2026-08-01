import type { Combatant } from '../ai/Combatant';
import type { BotTeam } from '../ai/Combatant';
import { DT } from '../core/Loop';
import type { ObjectiveDef } from '../world/maps/types';

/**
 * A capture zone: who is standing in it, and how far along the capture is (M7).
 *
 * Shared by Domination's flags and Search & Destroy's bomb sites, because "count the bodies
 * inside a radius and advance a timer" is the same rule in both and two copies of it is two
 * places for the occupancy test to disagree with the HUD ring.
 *
 * ## The rules that are not obvious
 *
 * **Contested means frozen, not reversed.** With both teams inside, progress holds where it
 * is. Reversing it rewards whoever arrived second and makes a defended flag feel like a loss
 * even when you held it; freezing makes the fight the thing that decides it, which is what
 * the zone is for.
 *
 * **More bodies is faster, but sub-linearly.** The second attacker adds 60% of the first, the
 * third 60% of that. A flag that three people take three times as fast is a flag nobody ever
 * contests; one that ignores the extra bodies makes stacking pointless. `CAPTURE_STACK_FALLOFF`
 * is the compromise and it is a config number, not an inline one.
 *
 * **Losing a zone runs the timer back down rather than snapping.** A flag half-taken and then
 * abandoned decays at `DECAY_RATE`, so a player who was interrupted has something to come back
 * to and an attacker cannot bank progress forever.
 *
 * Everything advances on `DT`, never on a frame delta (S4.1).
 */

export interface ZoneConfig {
  /** Seconds for one attacker alone to take a neutral zone. */
  readonly captureSeconds: number;
  /** Each additional body contributes this fraction of the one before it. */
  readonly stackFalloff: number;
  /** Fraction of capture rate at which abandoned progress bleeds away. */
  readonly decayRate: number;
  /** Vertical tolerance, metres. A catwalk above a flag is not standing on it. */
  readonly heightTolerance: number;
}

export const DEFAULT_ZONE_CONFIG: ZoneConfig = {
  captureSeconds: 6,
  stackFalloff: 0.6,
  decayRate: 0.5,
  heightTolerance: 2.6,
};

export class ObjectiveZone {
  readonly def: ObjectiveDef;
  /** Who owns it, or 'NONE' while neutral. */
  owner: BotTeam | 'NONE' = 'NONE';
  /**
   * Capture progress, 0..1, belonging to `capturingTeam`.
   *
   * While a zone is owned, progress is the *attacker's*: it climbs to 1, at which point
   * ownership flips and progress resets. There is no separate "neutralise" phase — the brief
   * gives Domination three flags and 200 points, not a two-stage capture.
   */
  progress = 0;
  capturingTeam: BotTeam | 'NONE' = 'NONE';

  /** Bodies inside, by team, recomputed every tick. Read by the HUD and the debug panel. */
  countA = 0;
  countB = 0;

  private readonly cfg: ZoneConfig;

  constructor(def: ObjectiveDef, cfg: ZoneConfig = DEFAULT_ZONE_CONFIG) {
    this.def = def;
    this.cfg = cfg;
  }

  get id(): string {
    return this.def.id;
  }

  get label(): string {
    return this.def.label;
  }

  get contested(): boolean {
    return this.countA > 0 && this.countB > 0;
  }

  /** True while somebody is making headway. Drives the HUD ring's colour. */
  get active(): boolean {
    return this.progress > 0 && this.capturingTeam !== 'NONE';
  }

  reset(owner: BotTeam | 'NONE'): void {
    this.owner = owner;
    this.progress = 0;
    this.capturingTeam = 'NONE';
    this.countA = 0;
    this.countB = 0;
  }

  contains(c: Combatant): boolean {
    if (!c.participating) return false;
    const p = this.def.position;
    const dy = c.py - p.y;
    if (Math.abs(dy) > this.cfg.heightTolerance) return false;
    const dx = c.px - p.x;
    const dz = c.pz - p.z;
    return dx * dx + dz * dz <= this.def.radius * this.def.radius;
  }

  /**
   * One tick. Returns the team that just took the zone, or null.
   *
   * The caller is expected to have refreshed `countA`/`countB` via `recount` first — split
   * so a mode can walk the roster once for every zone rather than once per zone.
   */
  step(): BotTeam | null {
    const cfg = this.cfg;
    const a = this.countA;
    const b = this.countB;

    // Contested: nothing moves. The gunfight is the tie-breaker.
    if (a > 0 && b > 0) return null;

    const attackers = a > 0 ? a : b;
    const team: BotTeam | 'NONE' = a > 0 ? 'A' : b > 0 ? 'B' : 'NONE';

    if (team === 'NONE' || team === this.owner) {
      // Empty, or held by the people already holding it: bleed any part-capture away.
      if (this.progress <= 0) {
        this.capturingTeam = 'NONE';
        return null;
      }
      this.progress -= (cfg.decayRate / cfg.captureSeconds) * DT;
      if (this.progress <= 0) {
        this.progress = 0;
        this.capturingTeam = 'NONE';
      }
      return null;
    }

    // A new attacker resets whatever the other side had banked.
    if (this.capturingTeam !== team) {
      this.capturingTeam = team;
      this.progress = 0;
    }

    this.progress += (stackRate(attackers, cfg.stackFalloff) / cfg.captureSeconds) * DT;
    if (this.progress < 1) return null;

    this.progress = 0;
    this.capturingTeam = 'NONE';
    this.owner = team;
    return team;
  }
}

/**
 * Effective capture rate for `n` bodies: 1 + f + f^2 + ... — the geometric series, which is
 * why stacking helps and then stops helping.
 */
export function stackRate(n: number, falloff: number): number {
  let rate = 0;
  let weight = 1;
  for (let i = 0; i < n; i++) {
    rate += weight;
    weight *= falloff;
  }
  return rate;
}

/** Refresh every zone's occupancy from one pass over the roster. */
export function recountZones(zones: readonly ObjectiveZone[], roster: readonly Combatant[]): void {
  for (const zone of zones) {
    zone.countA = 0;
    zone.countB = 0;
  }
  for (const c of roster) {
    if (!c.participating) continue;
    for (const zone of zones) {
      if (!zone.contains(c)) continue;
      if (c.team === 'A') zone.countA++;
      else zone.countB++;
    }
  }
}
