import type { Damageable } from '../combat/DamageSystem';

/**
 * A participant in a firefight.
 *
 * This is the interface that makes S6.1's symmetry real. The player and a bot are the
 * same thing to everything in `ai/`: a `Damageable` (so the M2 damage path applies
 * unchanged in both directions) plus a pose, a facing and a team. Perception, spawn
 * safety and cover scoring are written against this and never against `PlayerSim` or
 * `Bot`, which is why "can a bot see the player" and "can a bot see another bot" are one
 * piece of code rather than two that drift apart.
 */

export type BotTeam = 'A' | 'B';

export function opposingTeam(team: BotTeam): BotTeam {
  return team === 'A' ? 'B' : 'A';
}

export interface Combatant extends Damageable {
  readonly team: BotTeam;

  /** Feet position on the current sim tick. */
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  /** Facing, radians. Yaw 0 looks down -Z. */
  readonly yaw: number;
  /** Horizontal velocity, m/s. */
  readonly vx: number;
  readonly vz: number;

  /** Eye height above the feet, metres. Where this combatant sees from. */
  readonly eyeHeight: number;
  /** Torso-centre height above the feet, metres. Where a bot aims. */
  readonly aimHeight: number;
  /** Crouched or sliding: audible only at close range (S6.3). */
  readonly quiet: boolean;
  /** False while dead or waiting to respawn. */
  readonly participating: boolean;
  /**
   * Holding a scope up with the objective lens catching the light (M5, S6.1).
   *
   * Perception treats a glint as a free contact: it bypasses the vision cone, because the
   * whole point of a glint is that it is what makes you turn round. It does not bypass
   * line of sight — you cannot see a glint through a wall.
   */
  readonly glinting: boolean;
}
