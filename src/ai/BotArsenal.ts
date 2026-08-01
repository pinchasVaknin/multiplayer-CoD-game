import type { Rng } from '../core/Rng';
import { cloneWeaponDef, requireWeapon, type WeaponDef } from '../weapons/WeaponDefs';
import type { BotTier } from './DifficultyTiers';

/**
 * What a bot brings to the fight (M7 hotfix).
 *
 * ## The bug this file exists to close
 *
 * Until M7 every bot on the map carried a clone of *the player's own primary*. M6 had already
 * noticed half of the problem and fixed it — `Game.botWeaponDef` was introduced so the enemy
 * team would not be issued the player's attachments and perks — but it fixed the wrong half.
 * The def handed over was `loadout.primaryBase`, the base of whatever the player had equipped,
 * so equipping a sniper in Create-a-Class armed all nine bots with snipers. The M6 playtest
 * reported it as "selecting a weapon equips it on all bots", and it was: the isolation was of
 * *modifiers*, not of the weapon choice underneath them.
 *
 * A bot's weapon is now a property of the bot, drawn here, and nothing about the player's
 * class reaches it. `MetaPanel` still needs the base of the player's primary to show perks as
 * a before-and-after, so that object survives — renamed `playerBaseDef`, because calling it
 * `botWeaponDef` was what made the bug look like correct behaviour for a milestone.
 *
 * ## Why the pools are per tier
 *
 * A weapon is a difficulty lever as much as the aim cone is. Handing a Recruit a sniper makes
 * it *harder* for the player to read the tier — the bot misses either way, but a sniper that
 * misses is a bot that does nothing at all for two seconds at a time. So the pools run from
 * forgiving to punishing: Recruits get close-range automatics that are unthreatening at
 * distance, Veterans get precision weapons that punish a player standing still in a lane.
 *
 * Weights are integers rather than probabilities so the table reads as "two carbines for every
 * shotgun" and cannot silently fail to sum to one.
 */

export interface BotWeaponEntry {
  readonly weaponId: string;
  /** Relative likelihood inside this tier's pool. */
  readonly weight: number;
}

/**
 * Per-tier draw pools.
 *
 * Every id is a shipped M5 weapon. The launcher class is deliberately absent: nothing in
 * `ai/` understands a projectile arc, and a bot that fires a rocket at its own feet is worse
 * than a bot with a rifle.
 */
export const BOT_ARSENAL: Readonly<Record<BotTier, readonly BotWeaponEntry[]>> = {
  RECRUIT: [
    { weaponId: 'ar_carbine', weight: 4 },
    { weaponId: 'smg_wasp', weight: 3 },
    { weaponId: 'shotgun_breacher', weight: 1 },
  ],
  REGULAR: [
    { weaponId: 'ar_carbine', weight: 3 },
    { weaponId: 'ar_vulcan', weight: 2 },
    { weaponId: 'smg_wasp', weight: 2 },
    { weaponId: 'smg_meridian', weight: 2 },
    { weaponId: 'shotgun_breacher', weight: 1 },
  ],
  HARDENED: [
    { weaponId: 'ar_vulcan', weight: 3 },
    { weaponId: 'ar_halcyon', weight: 2 },
    { weaponId: 'smg_meridian', weight: 2 },
    { weaponId: 'lmg_bastion', weight: 2 },
    { weaponId: 'sniper_kestrel', weight: 1 },
  ],
  VETERAN: [
    { weaponId: 'ar_halcyon', weight: 3 },
    { weaponId: 'ar_longbow', weight: 2 },
    { weaponId: 'lmg_monolith', weight: 1 },
    { weaponId: 'sniper_kestrel', weight: 2 },
    { weaponId: 'sniper_vantage', weight: 2 },
  ],
};

/**
 * Draw one weapon for a bot of this tier.
 *
 * Returns a **clone**, because a `WeaponSystem` writes into the def it is given (M5's
 * attachment resolution and M2's ammunition both do) and two bots sharing one object would
 * share a magazine. Seeded from the director's own `Rng`, so the same seed produces the same
 * loadout on every side of every run and a regression in bot behaviour stays reproducible.
 */
export function drawBotWeapon(tier: BotTier, rng: Rng): WeaponDef {
  const pool = BOT_ARSENAL[tier];
  let total = 0;
  for (const entry of pool) total += entry.weight;
  if (total <= 0) return cloneWeaponDef(requireWeapon('ar_carbine'));

  let roll = rng.float() * total;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll <= 0) return cloneWeaponDef(requireWeapon(entry.weaponId));
  }
  // Floating-point tail: the last entry is the one the roll belongs to.
  const last = pool[pool.length - 1];
  return cloneWeaponDef(requireWeapon(last === undefined ? 'ar_carbine' : last.weaponId));
}
