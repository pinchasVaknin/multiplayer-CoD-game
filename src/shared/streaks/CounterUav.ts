import { DT } from '../core/Loop';
import { Killstreak } from './KillstreakBase';

/**
 * Counter-UAV (brief S6.1): the enemy minimap is scrambled.
 *
 * Deliberately not "the enemy UAV is cancelled". Cancelling is invisible to the side being
 * countered — they simply stop getting contacts and cannot tell whether that is a counter or an
 * empty sweep. Scrambling is *legible*: the map goes to noise and the player knows they have
 * been blinded, which is the information the streak is really selling.
 *
 * The streak itself is almost nothing, and that is correct. It raises one flag for the duration;
 * `StreakSystem.minimapScrambledFor` answers the question and the HUD does the drawing. Putting
 * the noise here would give a killstreak an opinion about how a canvas is rendered.
 *
 * Against bots the effect is real rather than cosmetic: `StreakSystem` reports the scramble and
 * `Match` gates the enemy team's minimap, which is the only radar a bot ever had — bots navigate
 * on perception and the navmesh, so there is nothing further to take away from them.
 */
export class CounterUav extends Killstreak {
  override onActivate(): void {
    this.ctx.present.counterUav();
  }

  override onTick(_tick: number): boolean {
    this.age += DT;
    return this.age < this.def.durationSeconds;
  }

  override onExpire(): void {
    /* Nothing owned: the flag lives in `StreakSystem` and goes with this instance. */
  }

  override describe(): string {
    return `COUNTER-UAV ${this.secondsRemaining.toFixed(1)}s · scrambling team ${this.ownerTeam === 'A' ? 'B' : 'A'}`;
  }
}
