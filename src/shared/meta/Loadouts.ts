import type { EquipmentId } from '../equipment/EquipmentDefs';
import type { StreakId } from '../streaks/StreakDefs';
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
  /**
   * Exactly three killstreaks, in the order keys 3, 4 and 5 spend them (M7 playtest).
   *
   * Six shipped streaks and three keys is a collision the player cannot resolve at runtime,
   * so the choice moves into the class where every other loadout decision already lives. A
   * null is a legal empty slot for the same reason a perk tier can be empty — somebody may
   * genuinely want two.
   */
  streaks: Array<StreakId | null>;
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
  /** The three equipped streaks, in key order. */
  readonly streaks: ReadonlyArray<StreakId | null>;
  readonly perkState: PerkState;
}

/**
 * The five shipped classes.
 *
 * **Everything here is legal on a fresh level-1 profile**, and that constraint used to
 * decide the whole table rather than merely bound it: until playtest round 5 the level-1
 * arsenal was one primary, so all five slots named the carbine and differed only in
 * whether they took the two perks available at level 1. That is what F10 reported — five
 * classes and one class — and the fix is upstream of this file. Three primaries open at
 * level 1 now (see `Unlocks.ts` for the principle and `npm run progression` for the
 * assertion), so there is finally something for five slots to disagree about.
 *
 * The constraint itself has not moved. A default that named a locked weapon would be
 * silently rewritten by `sanitiseLoadout` on first load, and a rewritten default is
 * indistinguishable from a bug; the probe runs `sanitiseLoadout` over all five and fails
 * if it changes anything.
 *
 * **Two names still share the carbine, and it is the same reason as before, narrowed.**
 * SUPPORT wants an LMG and MARKSMAN wants a sniper, and those are the two archetypes the
 * ladder deliberately holds back — the BASTION at 15 and the KESTREL at 11. Both fall back
 * to the carbine because it is the only level-1 primary that holds a fight past 15 m
 * (`docs/BALANCE.md`'s band table), and both become themselves when the ladder pays out.
 * What separates them meanwhile is what a level-1 profile can actually vary: the two
 * available perks and the streak trio.
 */
export function defaultLoadouts(): LoadoutSlot[] {
  return [
    // The all-rounder takes both perks it can have and the three cheapest streaks.
    makeSlot('ASSAULT', 'ar_carbine', ['lightweight', null, 'quickdraw'], ['uav', 'care_package', 'mortar']),
    // Movement and information. QUICKDRAW buys least on the fastest ADS in the arsenal.
    makeSlot('SCOUT', 'smg_wasp', ['lightweight', null, null], ['uav', 'counter_uav', 'care_package']),
    // Close the distance, then a room at a time. The sentry holds the room afterwards.
    makeSlot('BREACH', 'shotgun_breacher', ['lightweight', null, 'quickdraw'], ['uav', 'care_package', 'sentry']),
    // Holds ground, so neither perk on offer fits: LIGHTWEIGHT is movement and QUICKDRAW is
    // a rifle's problem. Its own perks and its LMG arrive together, at 14 and 15.
    makeSlot('SUPPORT', 'ar_carbine', [null, null, null], ['uav', 'care_package', 'sentry']),
    // Holds an angle rather than a position: QUICKDRAW, no movement perk, and the two
    // streaks that answer a lane — a sweep and a barrage.
    makeSlot('MARKSMAN', 'ar_carbine', [null, null, 'quickdraw'], ['uav', 'counter_uav', 'mortar']),
  ];
}

/** The sidearm every profile starts with. `unlockLevel` 1, and the only one there is. */
const STARTER_SECONDARY = 'pistol_talon';

/**
 * Lethal and tactical are not parameters.
 *
 * At level 1 there is exactly one of each — FRAG and FLASHBANG; SMOKE is 3, SEMTEX 8 and
 * the CLAYMORE 16 — so a per-class argument here could only ever be handed the same value
 * five times, and a parameter with one legal argument is a parameter that lies about what
 * varies. The same goes for the field upgrade: MUNITIONS is the only one under level 6.
 */
function makeSlot(
  name: string,
  primary: string,
  perks: Array<PerkId | null>,
  streaks: ReadonlyArray<StreakId | null>,
): LoadoutSlot {
  return {
    name,
    primary: { weaponId: primary, attachments: [], camo: null },
    secondary: { weaponId: STARTER_SECONDARY, attachments: [], camo: null },
    lethal: 'frag',
    tactical: 'flashbang',
    perks: [...perks],
    fieldUpgrade: 'munitions',
    // Streaks are gated by kills rather than by level, so all six are legal at level 1 and
    // they are the widest axis a fresh profile has. The rule the trios keep is the one that
    // was already here: a fresh profile should be able to *earn* everything it has equipped,
    // so nothing above the SENTRY's eight kills appears and the CHOPPER GUNNER's twelve is
    // in none of them.
    streaks: [...streaks],
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
    streaks: [...src.streaks],
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
    streaks: [...slot.streaks],
    perkState,
  };
}
