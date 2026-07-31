import { prestigeLabel } from './meta/Levels';
import type { ResolvedLoadout } from './meta/Loadouts';
import type { Profile } from './meta/Profile';
import type { GameModeId } from './modes/GameMode';
import { DEFAULT_MODE_ID, findMode, MODES } from './modes/ModeRegistry';
import { cloneWeaponDef, type WeaponDef } from './weapons/WeaponDefs';

/**
 * The bridge between the profile's equipped class and the objects a match is built from.
 *
 * Free functions rather than methods, because none of this needs the state machine — it is
 * a translation between two data shapes, and pulling it out of `Game.ts` keeps that file
 * about states and the loop.
 *
 * The subtle part is `copyWeaponDefInto`. `Game` owns three long-lived `WeaponDef` objects
 * that the tuning panel, the weapon system and the bot director captured references to when
 * the match was built; replacing one would leave three systems pointing at the previous
 * loadout. So a class change *copies into* them, which is the same trick M5's weapon picker
 * used and the reason nothing has to resubscribe when the player switches class.
 */

/** Where the equipped class lands. All three are mutated in place. */
export interface LoadoutTargets {
  /** The player's primary, resolved: base + attachments + perks. */
  readonly primary: WeaponDef;
  readonly secondary: WeaponDef;
  /** What the bots carry: the *base* of the player's primary, unmodified. */
  readonly botPrimary: WeaponDef;
}

/**
 * Resolve the equipped class and copy it into the match's weapon objects.
 *
 * The resolved loadout is returned so the caller hands `Match` the same object rather than
 * resolving a second time — two resolves of the same slot are equal, but "equal" and "the
 * same" are different claims and only one of them is checkable.
 */
export function applyEquippedLoadout(
  profile: Profile,
  modeId: GameModeId,
  targets: LoadoutTargets,
): ResolvedLoadout {
  const loadout = profile.resolveEquipped(findMode(modeId).unrestricted);
  copyWeaponDefInto(loadout.primary, targets.primary);
  copyWeaponDefInto(loadout.secondary, targets.secondary);
  copyWeaponDefInto(loadout.primaryBase, targets.botPrimary);
  return loadout;
}

/**
 * Overwrite one `WeaponDef`'s contents with another's, keeping the destination object.
 *
 * The nested records are replaced with the clone's rather than the source's, so the
 * destination shares nothing with the loadout it came from — writing to a live weapon must
 * never reach back into the registry.
 */
export function copyWeaponDefInto(src: WeaponDef, dst: WeaponDef): void {
  const nested = cloneWeaponDef(src);
  Object.assign(dst, nested);
  dst.damage = nested.damage;
  dst.damageFalloff = nested.damageFalloff;
  dst.spread = nested.spread;
  dst.recoil = nested.recoil;
  dst.voice = nested.voice;
  dst.attachmentSlots = nested.attachmentSlots;
  if (nested.scope !== undefined) dst.scope = nested.scope;
  else delete dst.scope;
}

/** A stored mode id that no longer exists falls back to the default rather than throwing. */
export function asModeId(id: string): GameModeId {
  return MODES.some((m) => m.id === id) ? (id as GameModeId) : DEFAULT_MODE_ID;
}

/** Level, class and lifetime record, for the line under the menu's title. */
export function profileLine(profile: Profile): string {
  const progress = profile.progress;
  const badge = profile.prestige > 0 ? `PRESTIGE ${prestigeLabel(profile.prestige)} · ` : '';
  const level = progress.atCap ? 'LEVEL 55 (MAX)' : `LEVEL ${progress.level}`;
  const next = progress.atCap
    ? 'PRESTIGE AVAILABLE'
    : `${(progress.span - Math.floor(progress.into)).toLocaleString()} XP TO NEXT`;
  const record = profile.save.profile;
  return (
    `${badge}${level} · ${next} · ${profile.equippedLoadout().name} · ` +
    `${record.matchesWon}/${record.matchesPlayed} WON`
  );
}
