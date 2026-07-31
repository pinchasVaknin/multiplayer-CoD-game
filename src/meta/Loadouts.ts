import type { EquipmentId } from '../equipment/EquipmentDefs';
import { perkDef, type PerkId, type PerkTier } from '../perks/PerkDefs';
import { perkWeaponEffects, resolvePerkState, type PerkState } from '../perks/PerkState';
import { resolveWeaponDef, type AttachmentId } from '../weapons/Attachments';
import { requireWeapon, type WeaponDef } from '../weapons/WeaponDefs';
import type { CamoId } from './Camos';
import type { FieldUpgradeId } from './FieldUpgrades';

/**
 * Create-a-Class (brief S6.3).
 *
 * Five slots, each holding a primary with attachments, a secondary, a lethal, a tactical,
 * three perks — one per tier — and a field upgrade. The record below is what the save file
 * stores and what the editor writes; nothing about it is derived, so a loadout survives a
 * schema change as long as the ids do.
 *
 * **`resolveLoadout` is the whole point of the file.** It turns a slot into the two
 * `WeaponDef`s the player will actually hold, and it does it through
 * `resolveWeaponDef` — the same pure function M5's gameplay uses, now taking the perks'
 * modifiers alongside the attachments. The loadout editor calls this per keystroke and
 * `Game.buildWorld` calls it once a match; both get the same numbers because there is only
 * one place they can come from. That is acceptance criterion 3, and it is a property of
 * the code rather than a claim about it.
 */

export const LOADOUT_SLOT_COUNT = 5;

export interface WeaponLoadout {
  weaponId: string;
  attachments: AttachmentId[];
  camo: CamoId | null;
}

export interface LoadoutSlot {
  name: string;
  primary: WeaponLoadout;
  secondary: WeaponLoadout;
  lethal: EquipmentId;
  tactical: EquipmentId;
  /** One per tier, indexed 0..2 for tiers 1..3. Null is a legal, empty slot. */
  perks: Array<PerkId | null>;
  fieldUpgrade: FieldUpgradeId;
}

/** A slot with everything resolved and ready to hand to a match. */
export interface ResolvedLoadout {
  readonly slotIndex: number;
  readonly name: string;
  /** Base def, before attachments and perks. What the bots carry. */
  readonly primaryBase: WeaponDef;
  readonly secondaryBase: WeaponDef;
  /** What the player holds: base + attachments + perks, a brand new object each call. */
  readonly primary: WeaponDef;
  readonly secondary: WeaponDef;
  readonly primaryCamo: CamoId | null;
  readonly secondaryCamo: CamoId | null;
  readonly lethal: EquipmentId;
  readonly tactical: EquipmentId;
  readonly fieldUpgrade: FieldUpgradeId;
  readonly perkState: PerkState;
}

/**
 * The five shipped classes.
 *
 * **Everything here is legal on a fresh level-1 profile**, which is a stronger constraint
 * than it looks: at level 1 the arsenal is the carbine and the sidearm, tier 2 is empty
 * until level 5, and the only attachments are the ones that weapon's own kill count has
 * earned — which is none. So all five start with the same weapon, and that is correct
 * rather than lazy. A default set that showed a sniper the player cannot equip would be
 * silently rewritten by `sanitiseLoadout` on first load, and a rewritten default is
 * indistinguishable from a bug.
 *
 * What varies is what *can* vary at level 1: equipment, the two available perks, and the
 * field upgrade. The names are the intent for each slot, and the editor is where they
 * grow into it.
 */
export function defaultLoadouts(): LoadoutSlot[] {
  return [
    makeSlot('ASSAULT', 'frag', 'flashbang', ['lightweight', null, 'quickdraw'], 'munitions'),
    makeSlot('SCOUT', 'frag', 'flashbang', ['lightweight', null, null], 'munitions'),
    makeSlot('BREACH', 'frag', 'flashbang', [null, null, 'quickdraw'], 'munitions'),
    makeSlot('SUPPORT', 'frag', 'flashbang', [null, null, null], 'munitions'),
    makeSlot('MARKSMAN', 'frag', 'flashbang', ['lightweight', null, 'quickdraw'], 'munitions'),
  ];
}

/** The weapon every profile starts with. Both are `unlockLevel` 1. */
const STARTER_PRIMARY = 'ar_carbine';
const STARTER_SECONDARY = 'pistol_talon';

function makeSlot(
  name: string,
  lethal: EquipmentId,
  tactical: EquipmentId,
  perks: Array<PerkId | null>,
  fieldUpgrade: FieldUpgradeId,
): LoadoutSlot {
  return {
    name,
    primary: { weaponId: STARTER_PRIMARY, attachments: [], camo: null },
    secondary: { weaponId: STARTER_SECONDARY, attachments: [], camo: null },
    lethal,
    tactical,
    perks: [...perks],
    fieldUpgrade,
  };
}

export function cloneLoadout(src: LoadoutSlot): LoadoutSlot {
  return {
    name: src.name,
    primary: { ...src.primary, attachments: [...src.primary.attachments] },
    secondary: { ...src.secondary, attachments: [...src.secondary.attachments] },
    lethal: src.lethal,
    tactical: src.tactical,
    perks: [...src.perks],
    fieldUpgrade: src.fieldUpgrade,
  };
}

/** The perks a slot actually carries, with the empty tiers dropped. */
export function activePerks(slot: LoadoutSlot): PerkId[] {
  const out: PerkId[] = [];
  for (const id of slot.perks) {
    if (id !== null) out.push(id);
  }
  return out;
}

/** Which perk, if any, occupies a tier. */
export function perkInTier(slot: LoadoutSlot, tier: PerkTier): PerkId | null {
  return slot.perks[tier - 1] ?? null;
}

export function setPerkInTier(slot: LoadoutSlot, tier: PerkTier, id: PerkId | null): void {
  // A perk may only sit in its own tier: the editor never offers it elsewhere, and a save
  // that claims otherwise is rejected by `sanitiseLoadout` rather than honoured here.
  if (id !== null && perkDef(id).tier !== tier) return;
  slot.perks[tier - 1] = id;
}

/**
 * Turn a slot into the thing a match consumes.
 *
 * Pure and cheap enough to call per keystroke: two clones and a handful of
 * multiplications. Nothing is cached, which is deliberate — `verifyAttachmentPurity`
 * checks that two resolves of the same base cannot interfere, and a cache would be the
 * one way to break that.
 */
export function resolveLoadout(slot: LoadoutSlot, slotIndex: number): ResolvedLoadout {
  const perks = activePerks(slot);
  const perkState = resolvePerkState(perks);
  const modifiers = perkWeaponEffects(perks);

  const primaryBase = requireWeapon(slot.primary.weaponId);
  const secondaryBase = requireWeapon(slot.secondary.weaponId);

  return {
    slotIndex,
    name: slot.name,
    primaryBase,
    secondaryBase,
    primary: resolveWeaponDef(primaryBase, slot.primary.attachments, modifiers),
    secondary: resolveWeaponDef(secondaryBase, slot.secondary.attachments, modifiers),
    primaryCamo: slot.primary.camo,
    secondaryCamo: slot.secondary.camo,
    lethal: slot.lethal,
    tactical: slot.tactical,
    fieldUpgrade: slot.fieldUpgrade,
    perkState,
  };
}
