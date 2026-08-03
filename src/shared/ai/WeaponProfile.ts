import type { WeaponClass } from '../weapons/WeaponDefs';

/**
 * How a bot fights with the weapon it happens to be holding (M6 playtest item).
 *
 * Until M7 every bot carried the same rifle, so "how do I fight" had exactly one answer and
 * the tier table was the only thing that varied. `BotArsenal` broke that assumption
 * deliberately, and a Recruit holding a shotgun that opens fire at 45 m and never closes is
 * worse than the shared-rifle roster it replaced — it reads as a bot that does not know what
 * it is carrying, because it is.
 *
 * This is the missing half: a small set of multipliers keyed on weapon class that bend the
 * tier's own numbers rather than replacing them. **The tier still decides how good a bot is;
 * the weapon decides where it wants to be standing.** Keeping them multiplicative is what
 * stops a shotgun Veteran from becoming a different difficulty — it is the same aim cone and
 * the same reaction time, applied at six metres instead of thirty.
 *
 * Nothing here touches accuracy. A weapon that is bad at range is already bad at range
 * because `DifficultyTiers`' range-error term widens the cone with distance (M6) and the
 * weapon's own damage falloff does the rest.
 */

export interface WeaponCombatProfile {
  /**
   * The distance this weapon wants to fight at, metres. A bot further away than this pushes;
   * a bot closer than `minComfortRange` backs off.
   */
  readonly preferredRange: number;
  /**
   * Below this the weapon is being used wrong and the bot disengages to re-open the gap.
   * Zero for anything that is happy in a doorway.
   */
  readonly minComfortRange: number;
  /** Multiplier on the tier's `pushAggression`. Above 1 closes, below 1 holds. */
  readonly pushScale: number;
  /** Multiplier on the tier's `engageRange`: a shotgun must not open up down a lane. */
  readonly engageScale: number;
  /** Multiplier on the tier's `adsRange`. Below 1 aims earlier, above 1 hip-fires longer. */
  readonly adsScale: number;
}

/**
 * One row per class.
 *
 * `preferredRange` is roughly where each weapon's damage profile stops being a compromise —
 * inside the falloff start for the automatics, past it for the precision weapons. The
 * shotgun's 0.3 `engageScale` is the load-bearing number: at Veteran that is a 46 m engage
 * range cut to 14, which is the difference between a shotgun bot and a bot with a shotgun.
 */
export const WEAPON_PROFILES: Readonly<Record<WeaponClass, WeaponCombatProfile>> = {
  SHOTGUN: { preferredRange: 6, minComfortRange: 0, pushScale: 1.9, engageScale: 0.3, adsScale: 2.5 },
  SMG: { preferredRange: 11, minComfortRange: 0, pushScale: 1.55, engageScale: 0.62, adsScale: 1.5 },
  PISTOL: { preferredRange: 9, minComfortRange: 0, pushScale: 1.4, engageScale: 0.5, adsScale: 1.3 },
  AR: { preferredRange: 21, minComfortRange: 4, pushScale: 1.0, engageScale: 1.0, adsScale: 1.0 },
  LMG: { preferredRange: 23, minComfortRange: 6, pushScale: 0.65, engageScale: 1.05, adsScale: 0.85 },
  MARKSMAN: { preferredRange: 30, minComfortRange: 12, pushScale: 0.45, engageScale: 1.15, adsScale: 0.5 },
  SNIPER: { preferredRange: 36, minComfortRange: 16, pushScale: 0.28, engageScale: 1.3, adsScale: 0.22 },
  // Nothing in `BotArsenal` draws a launcher — `ai/` has no arc solver — but the record must
  // be total, and the rifle profile is the right answer if one is ever handed over by hand.
  LAUNCHER: { preferredRange: 21, minComfortRange: 4, pushScale: 1.0, engageScale: 1.0, adsScale: 1.0 },
};

export function weaponProfileFor(cls: WeaponClass): WeaponCombatProfile {
  return WEAPON_PROFILES[cls];
}
