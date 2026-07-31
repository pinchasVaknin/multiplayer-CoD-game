import { ALL_EQUIPMENT, type EquipmentId } from '../equipment/EquipmentDefs';
import { PERK_IDS, perkDef, type PerkId } from '../perks/PerkDefs';
import { ATTACHMENT_IDS, attachmentDef, fitsWeapon, type AttachmentId } from '../weapons/Attachments';
import { requireWeapon, WEAPON_DEFS, type WeaponDef } from '../weapons/WeaponDefs';
import { CAMO_IDS, type CamoId } from './Camos';
import { fieldUpgradeDef, FIELD_UPGRADE_IDS, type FieldUpgradeId } from './FieldUpgrades';
import type { LoadoutSlot } from './Loadouts';
import type { SaveV1, WeaponSaveData } from './SaveData';

/**
 * What is unlocked, and what it takes (brief S6.2).
 *
 * Three gates, and they are deliberately different from one another because they answer
 * different questions:
 *
 * **Account level** gates weapons, perks, equipment and field upgrades. Weapons use the
 * `unlockLevel` values M5 authored into the defs and enforced nowhere — S6.2's "enforce
 * the `unlockLevel` values" is this file, and the numbers were not touched.
 *
 * **Per-weapon kills** gate that weapon's attachments. A suppressor is something you earn
 * *with the gun*, not something you are handed for playing at all, and tying it to kills
 * rather than to the account level is what makes picking up an unfamiliar weapon a project.
 *
 * **Per-weapon XP** drives a weapon level, which is what the editor prints and what the
 * end-of-match summary rewards. It is derived from the same XP the account earns, scaled
 * by `WEAPON_XP_FRACTION`, so a weapon can never level from something the player was not
 * paid for.
 *
 * A **permanent unlock token** overrides all three for one item id. S6.1: prestige "grants
 * one permanent unlock token that permanently unlocks any single item across resets", so
 * `permanentUnlocks` survives the level reset and is consulted first everywhere below.
 *
 * `sanitiseLoadout` is acceptance criterion 5. It runs after `normaliseSave` on every load
 * and after every edit, and it is the reason a hand-edited save cannot equip a locked
 * weapon: the loadout the match consumes has been through it.
 */

/** Kills with a weapon that unlock each of its attachments, in unlock order. */
export const ATTACHMENT_KILL_THRESHOLDS: Readonly<Record<AttachmentId, number>> = {
  laser_tactical: 5,
  optic_reflex: 12,
  mag_extended: 25,
  grip_foregrip: 40,
  muzzle_suppressor: 60,
};

/** Account level each piece of equipment becomes selectable at. */
export const EQUIPMENT_UNLOCK_LEVEL: Readonly<Record<EquipmentId, number>> = {
  frag: 1,
  flashbang: 1,
  smoke: 3,
  semtex: 8,
  claymore: 16,
};

/**
 * Per-weapon XP for each weapon level, 1..10.
 *
 * Flatter than the account curve on purpose: a weapon should reach its ceiling inside a
 * few sessions of using it, or nobody ever tries the eleventh gun.
 */
export const WEAPON_LEVEL_XP: readonly number[] = [
  400, 700, 1100, 1600, 2200, 2900, 3700, 4600, 5600,
];

export const MAX_WEAPON_LEVEL = WEAPON_LEVEL_XP.length + 1;

/** The weapon level a per-weapon XP total buys. */
export function weaponLevelForXp(xp: number): number {
  let remaining = Math.max(0, xp);
  let level = 1;
  for (const step of WEAPON_LEVEL_XP) {
    if (remaining < step) break;
    remaining -= step;
    level++;
  }
  return level;
}

/** XP into the current weapon level, and what the level costs. */
export function weaponLevelProgress(xp: number): { level: number; into: number; span: number } {
  let remaining = Math.max(0, xp);
  let level = 1;
  for (const step of WEAPON_LEVEL_XP) {
    if (remaining < step) return { level, into: remaining, span: step };
    remaining -= step;
    level++;
  }
  return { level, into: 0, span: 0 };
}

/**
 * The unlock state a level and a save produce.
 *
 * Built once per edit rather than queried piecemeal: the editor asks "is this locked" for
 * every weapon, every attachment and every perk on every repaint, and a snapshot is both
 * faster and impossible to answer inconsistently mid-frame.
 */
export class UnlockState {
  private readonly permanent: ReadonlySet<string>;

  constructor(
    readonly level: number,
    private readonly weapons: Readonly<Record<string, WeaponSaveData>>,
    permanentUnlocks: readonly string[],
    private readonly camos: Readonly<Record<string, boolean>>,
    /** Set by the Shooting Range, where S9's testbed rules apply. See `Range.ts`. */
    readonly unrestricted = false,
  ) {
    this.permanent = new Set(permanentUnlocks);
  }

  /** Built from a save. The one constructor anything outside this file should use. */
  static fromSave(save: SaveV1, unrestricted = false): UnlockState {
    return new UnlockState(
      save.profile.level,
      save.weapons,
      save.profile.permanentUnlocks,
      save.camos,
      unrestricted,
    );
  }

  /** A token spent on this id overrides every other gate, at any prestige. */
  isPermanent(id: string): boolean {
    return this.permanent.has(id);
  }

  weaponUnlocked(weaponId: string): boolean {
    if (this.unrestricted || this.isPermanent(weaponId)) return true;
    const def = WEAPON_DEFS[weaponId];
    if (def === undefined) return false;
    return this.level >= def.unlockLevel;
  }

  /** Kills still needed with this weapon before the attachment is available. */
  attachmentKillsRemaining(weaponId: string, attachment: AttachmentId): number {
    if (this.unrestricted || this.isPermanent(attachmentKey(weaponId, attachment))) return 0;
    const needed = ATTACHMENT_KILL_THRESHOLDS[attachment];
    const stats = this.weapons[weaponId];
    const explicit = stats?.unlockedAttachments.includes(attachment) ?? false;
    if (explicit) return 0;
    return Math.max(0, needed - (stats?.kills ?? 0));
  }

  attachmentUnlocked(weaponId: string, attachment: AttachmentId): boolean {
    return this.attachmentKillsRemaining(weaponId, attachment) === 0;
  }

  perkUnlocked(id: PerkId): boolean {
    if (this.unrestricted || this.isPermanent(id)) return true;
    return this.level >= perkDef(id).unlockLevel;
  }

  equipmentUnlocked(id: EquipmentId): boolean {
    if (this.unrestricted || this.isPermanent(id)) return true;
    return this.level >= (EQUIPMENT_UNLOCK_LEVEL[id] ?? 1);
  }

  fieldUpgradeUnlocked(id: FieldUpgradeId): boolean {
    if (this.unrestricted || this.isPermanent(id)) return true;
    return this.level >= fieldUpgradeDef(id).unlockLevel;
  }

  camoUnlocked(id: CamoId): boolean {
    return this.camos[id] === true;
  }

  /** What a locked item says on its chip. Empty when the item is available. */
  weaponRequirement(weaponId: string): string {
    if (this.weaponUnlocked(weaponId)) return '';
    return `LEVEL ${requireWeapon(weaponId).unlockLevel}`;
  }

  attachmentRequirement(weaponId: string, attachment: AttachmentId): string {
    const remaining = this.attachmentKillsRemaining(weaponId, attachment);
    if (remaining === 0) return '';
    return `${remaining} MORE KILLS`;
  }

  /** Everything a token could still be spent on, for the prestige screen. */
  tokenCandidates(): string[] {
    const out: string[] = [];
    for (const def of Object.values(WEAPON_DEFS)) {
      if (!this.weaponUnlocked(def.id)) out.push(def.id);
    }
    for (const id of PERK_IDS) {
      if (!this.perkUnlocked(id)) out.push(id);
    }
    for (const eq of ALL_EQUIPMENT) {
      if (!this.equipmentUnlocked(eq.id)) out.push(eq.id);
    }
    for (const id of FIELD_UPGRADE_IDS) {
      if (!this.fieldUpgradeUnlocked(id)) out.push(id);
    }
    return out;
  }

  /** Human label for a token candidate id. */
  static labelFor(id: string): string {
    const weapon = WEAPON_DEFS[id];
    if (weapon !== undefined) return weapon.name;
    for (const perk of PERK_IDS) {
      if (perk === id) return perkDef(perk).name;
    }
    for (const eq of ALL_EQUIPMENT) {
      if (eq.id === id) return eq.name;
    }
    for (const upgrade of FIELD_UPGRADE_IDS) {
      if (upgrade === id) return fieldUpgradeDef(upgrade).name;
    }
    return id;
  }
}

/** Attachments are unlocked per weapon, so a token has to name the pair. */
export function attachmentKey(weaponId: string, attachment: AttachmentId): string {
  return `${weaponId}:${attachment}`;
}

/**
 * Force a loadout to be legal, reporting everything it had to change.
 *
 * Acceptance criterion 5 in one function. Every path into a match goes through it: load,
 * every editor edit, and `Game.buildWorld`. Editing `localStorage` to name a locked
 * weapon therefore cannot put that weapon in the player's hands — the equipped loadout is
 * a sanitised one, and the reversion is reported rather than silent.
 */
export function sanitiseLoadout(slot: LoadoutSlot, unlocks: UnlockState, losses: string[]): boolean {
  let changed = false;
  const label = slot.name;

  const fixWeapon = (which: 'primary' | 'secondary'): void => {
    const entry = slot[which];
    if (!unlocks.weaponUnlocked(entry.weaponId)) {
      const was = entry.weaponId;
      entry.weaponId = which === 'primary' ? FALLBACK_PRIMARY : FALLBACK_SECONDARY;
      entry.attachments = [];
      losses.push(
        `${label} ${which} "${was}" is locked (${unlocks.weaponRequirement(was)}); reverted to ${entry.weaponId}`,
      );
      changed = true;
      return;
    }
    const def = requireWeapon(entry.weaponId);
    const kept: AttachmentId[] = [];
    for (const id of entry.attachments) {
      if (!fitsWeapon(def, id)) {
        losses.push(`${label} ${which}: ${attachmentDef(id).name} does not fit ${def.name}; removed`);
        changed = true;
        continue;
      }
      if (!unlocks.attachmentUnlocked(def.id, id)) {
        losses.push(
          `${label} ${which}: ${attachmentDef(id).name} not yet earned on ${def.name} ` +
            `(${unlocks.attachmentRequirement(def.id, id)}); removed`,
        );
        changed = true;
        continue;
      }
      kept.push(id);
    }
    // One attachment per slot. A save naming two optics is not something the editor can
    // produce, and honouring it would let a hand-edit stack the same multiplier twice.
    const bySlot = new Set<string>();
    entry.attachments = kept.filter((id) => {
      const key = attachmentDef(id).slot;
      if (bySlot.has(key)) {
        losses.push(`${label} ${which}: two attachments in the ${key} slot; kept the first`);
        changed = true;
        return false;
      }
      bySlot.add(key);
      return true;
    });
    if (entry.camo !== null && !unlocks.camoUnlocked(entry.camo)) {
      losses.push(`${label} ${which}: camo "${entry.camo}" not earned; cleared`);
      entry.camo = null;
      changed = true;
    }
  };

  fixWeapon('primary');
  fixWeapon('secondary');

  // Overkill is the one rule that makes the secondary slot's *class* legal or not.
  const hasOverkill = slot.perks.includes('overkill');
  const secondary = requireWeapon(slot.secondary.weaponId);
  if (secondary.slot === 'primary' && !hasOverkill) {
    losses.push(`${label}: ${secondary.name} in the secondary slot needs OVERKILL; reverted`);
    slot.secondary.weaponId = FALLBACK_SECONDARY;
    slot.secondary.attachments = [];
    changed = true;
  }

  if (!unlocks.equipmentUnlocked(slot.lethal)) {
    losses.push(`${label}: lethal "${slot.lethal}" is locked; reverted to frag`);
    slot.lethal = 'frag';
    changed = true;
  }
  if (!unlocks.equipmentUnlocked(slot.tactical)) {
    losses.push(`${label}: tactical "${slot.tactical}" is locked; reverted to flashbang`);
    slot.tactical = 'flashbang';
    changed = true;
  }
  if (!unlocks.fieldUpgradeUnlocked(slot.fieldUpgrade)) {
    losses.push(`${label}: field upgrade "${slot.fieldUpgrade}" is locked; reverted to munitions`);
    slot.fieldUpgrade = 'munitions';
    changed = true;
  }

  for (let tier = 0; tier < 3; tier++) {
    const id = slot.perks[tier];
    if (id === null || id === undefined) continue;
    if (unlocks.perkUnlocked(id)) continue;
    losses.push(`${label}: ${perkDef(id).name} is locked (level ${perkDef(id).unlockLevel}); removed`);
    slot.perks[tier] = null;
    changed = true;
  }

  return changed;
}

/** What a locked slot falls back to. Both are `unlockLevel` 1 and cannot themselves fail. */
const FALLBACK_PRIMARY = 'ar_carbine';
const FALLBACK_SECONDARY = 'pistol_talon';

/** Everything unlocked exactly at this level, for the level-up flourish's caption. */
export function unlocksAtLevel(level: number): string[] {
  const out: string[] = [];
  for (const def of Object.values(WEAPON_DEFS) as WeaponDef[]) {
    if (def.unlockLevel === level) out.push(def.name);
  }
  for (const id of PERK_IDS) {
    if (perkDef(id).unlockLevel === level) out.push(perkDef(id).name);
  }
  for (const eq of ALL_EQUIPMENT) {
    if ((EQUIPMENT_UNLOCK_LEVEL[eq.id] ?? 1) === level) out.push(eq.name);
  }
  for (const id of FIELD_UPGRADE_IDS) {
    if (fieldUpgradeDef(id).unlockLevel === level) out.push(fieldUpgradeDef(id).name);
  }
  return out;
}

/** Every attachment a weapon can take, in unlock order. Drives the editor's rows. */
export function attachmentsForWeapon(def: WeaponDef): AttachmentId[] {
  return ATTACHMENT_IDS.filter((id) => fitsWeapon(def, id)).sort(
    (a, b) => ATTACHMENT_KILL_THRESHOLDS[a] - ATTACHMENT_KILL_THRESHOLDS[b],
  );
}

/** Camos the profile has earned, in declaration order. */
export function ownedCamos(save: SaveV1): CamoId[] {
  return CAMO_IDS.filter((id) => save.camos[id] === true);
}
