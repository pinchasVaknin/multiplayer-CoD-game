/**
 * Field upgrades (brief S6.3's loadout slot).
 *
 * S6.3 lists a field upgrade as part of a class and says nothing about what one does, and
 * S9 puts killstreaks out of scope — so the temptation is a dropdown of names. Hard Rule 1
 * forbids that, so these four are the ones that could be built honestly out of systems
 * that already exist, and each is a single call into one of them:
 *
 * | Upgrade      | What it actually does                                    |
 * |--------------|----------------------------------------------------------|
 * | MUNITIONS    | Refills both weapons' reserve ammo and both equipment slots |
 * | STIM         | Full heal and the regeneration delay cleared              |
 * | SMOKE SCREEN | Spawns a real cloud in `SmokeField` — bots stop seeing through it |
 * | ARMOUR PLATE | Grants overhealth absorbed before health                  |
 *
 * They charge over time rather than on score, because score-charged upgrades need the
 * streak plumbing S9 defers. One key (`X`), one charge, one activation.
 */

export type FieldUpgradeId = 'munitions' | 'stim' | 'smokescreen' | 'armour';

export interface FieldUpgradeDef {
  readonly id: FieldUpgradeId;
  readonly name: string;
  readonly blurb: string;
  /** Seconds from empty to ready. */
  readonly chargeSeconds: number;
  readonly unlockLevel: number;
  /** Overhealth granted, HP. Zero for everything but ARMOUR PLATE. */
  readonly overhealth: number;
  /** Smoke radius and duration. Zero for everything but SMOKE SCREEN. */
  readonly smokeRadius: number;
  readonly smokeSeconds: number;
  /** Whether activation refills ammunition and equipment. */
  readonly resupply: boolean;
  /** Whether activation restores health outright. */
  readonly heal: boolean;
}

export const FIELD_UPGRADES: Readonly<Record<FieldUpgradeId, FieldUpgradeDef>> = {
  munitions: {
    id: 'munitions',
    name: 'MUNITIONS BOX',
    blurb: 'Refill reserve ammunition and equipment',
    chargeSeconds: 105,
    unlockLevel: 1,
    overhealth: 0,
    smokeRadius: 0,
    smokeSeconds: 0,
    resupply: true,
    heal: false,
  },
  stim: {
    id: 'stim',
    name: 'STIM',
    blurb: 'Immediate full heal',
    chargeSeconds: 75,
    unlockLevel: 6,
    overhealth: 0,
    smokeRadius: 0,
    smokeSeconds: 0,
    resupply: false,
    heal: true,
  },
  smokescreen: {
    id: 'smokescreen',
    name: 'SMOKE SCREEN',
    blurb: 'Deploy a smoke cloud on your position',
    chargeSeconds: 90,
    unlockLevel: 13,
    overhealth: 0,
    // Wider and shorter-lived than a thrown smoke: this is a way out, not an area denial.
    smokeRadius: 5.2,
    smokeSeconds: 8,
    resupply: false,
    heal: false,
  },
  armour: {
    id: 'armour',
    name: 'ARMOUR PLATE',
    blurb: '+50 overhealth, absorbed before your own',
    chargeSeconds: 120,
    unlockLevel: 21,
    overhealth: 50,
    smokeRadius: 0,
    smokeSeconds: 0,
    resupply: false,
    heal: false,
  },
};

export const FIELD_UPGRADE_IDS = Object.keys(FIELD_UPGRADES) as FieldUpgradeId[];

export function fieldUpgradeDef(id: FieldUpgradeId): FieldUpgradeDef {
  return FIELD_UPGRADES[id];
}

export function isFieldUpgradeId(value: string): value is FieldUpgradeId {
  return Object.prototype.hasOwnProperty.call(FIELD_UPGRADES, value);
}
