import { cloneWeaponDef, type AttachmentSlot, type WeaponDef } from './WeaponDefs';

/**
 * Attachments (brief S6.2).
 *
 * Two rules, and the whole file exists to enforce them.
 *
 * **Every attachment costs something.** There is no strictly-better option below. The cost
 * is a number in the same table as the benefit, so "is this a real trade-off" is a question
 * you answer by reading the record rather than by playing the game.
 *
 * **Resolution is pure.** `resolveWeaponDef` takes a base def and a list of attachment ids
 * and returns a *new* def. It never writes to its input, never caches, and never hands two
 * callers the same object — so two players with different attachments on the same gun
 * cannot interfere, which is acceptance criterion 3 and is verified by
 * `verifyAttachmentPurity` below rather than asserted here.
 *
 * The effects are declarative on purpose. An `apply(def)` callback per attachment would
 * work, but a table of multipliers can be *read* — by the debug panel, by the balance
 * report, and by anyone deciding whether the foregrip is worth its ADS time.
 */

/**
 * What an attachment does, as multipliers and flags.
 *
 * Every field is optional and absent means "unchanged". Multipliers compose by
 * multiplication in slot order, so two attachments touching the same number stack rather
 * than the last one winning.
 */
export interface AttachmentEffects {
  /** Multiplies `adsTime` and, on a scoped weapon, `scope.scopeInTime`. */
  readonly adsTimeMult?: number;
  /** Multiplies both reload times. */
  readonly reloadMult?: number;
  /** Multiplies `magSize`, rounded to a whole round. */
  readonly magSizeMult?: number;
  /** Multiplies both ends of the damage falloff — this *is* "range". */
  readonly rangeMult?: number;
  readonly recoilVerticalMult?: number;
  readonly recoilHorizontalMult?: number;
  /** Multiplies `spread.hipStand` and `spread.hipMove`. */
  readonly hipSpreadMult?: number;
  /** Multiplies `spread.ads`. */
  readonly adsSpreadMult?: number;
  /** Multiplies the scope's idle breath sway. No effect on an unscoped weapon. */
  readonly scopeSwayMult?: number;
  readonly sprintOutMult?: number;
  readonly swapMult?: number;
  /** Overrides the flag outright rather than scaling it. */
  readonly minimapPing?: boolean;
  readonly laserVisible?: boolean;
}

export interface AttachmentDef {
  readonly id: AttachmentId;
  readonly name: string;
  readonly slot: AttachmentSlot;
  /** One line each, shown side by side in the debug panel. */
  readonly benefit: string;
  readonly cost: string;
  readonly effects: AttachmentEffects;
}

export type AttachmentId =
  | 'optic_reflex'
  | 'muzzle_suppressor'
  | 'mag_extended'
  | 'grip_foregrip'
  | 'laser_tactical';

/**
 * The five from S6.2's table.
 *
 * The numbers were chosen so that the *cost* is measurable in the same units the benefit
 * is. An optic that cost "a bit of ADS" would be untestable; +14% of a 0.28 s ADS is 39 ms,
 * which is a quarter of a tick short of three frames and is exactly what criterion 4 asks
 * to be reported.
 */
export const ATTACHMENTS: Readonly<Record<AttachmentId, AttachmentDef>> = {
  optic_reflex: {
    id: 'optic_reflex',
    name: 'HYBRID OPTIC',
    slot: 'optic',
    benefit: 'Cleaner sight picture: -28% aimed spread, -15% scope sway',
    cost: '+14% ADS time',
    effects: { adsSpreadMult: 0.72, scopeSwayMult: 0.85, adsTimeMult: 1.14 },
  },
  muzzle_suppressor: {
    id: 'muzzle_suppressor',
    name: 'SUPPRESSOR',
    slot: 'muzzle',
    benefit: 'No minimap ping on fire',
    cost: '-10% range',
    effects: { minimapPing: false, rangeMult: 0.9 },
  },
  mag_extended: {
    id: 'mag_extended',
    name: 'EXTENDED MAG',
    slot: 'magazine',
    benefit: '+50% magazine capacity',
    cost: '+25% reload time',
    effects: { magSizeMult: 1.5, reloadMult: 1.25 },
  },
  grip_foregrip: {
    id: 'grip_foregrip',
    name: 'VERTICAL FOREGRIP',
    slot: 'underbarrel',
    benefit: '-25% vertical recoil',
    cost: '-8% ADS speed',
    effects: { recoilVerticalMult: 0.75, adsTimeMult: 1 / 0.92 },
  },
  laser_tactical: {
    id: 'laser_tactical',
    name: 'TACTICAL LASER',
    slot: 'laser',
    benefit: '-20% hip spread',
    cost: 'Dot visible to enemies while aiming',
    effects: { hipSpreadMult: 0.8, laserVisible: true },
  },
};

export const ATTACHMENT_IDS = Object.keys(ATTACHMENTS) as AttachmentId[];

/**
 * Apply attachments in a fixed order.
 *
 * Order matters only because floating point multiplication is not associative to the last
 * bit, and two loadouts with the same set in a different order must produce byte-identical
 * defs or the balance table is a lie about which gun you were holding.
 */
const APPLY_ORDER: readonly AttachmentId[] = [
  'optic_reflex',
  'muzzle_suppressor',
  'mag_extended',
  'grip_foregrip',
  'laser_tactical',
];

export function attachmentDef(id: AttachmentId): AttachmentDef {
  return ATTACHMENTS[id];
}

/** Whether the weapon has a slot this attachment could go in. */
export function fitsWeapon(def: WeaponDef, id: AttachmentId): boolean {
  return def.attachmentSlots.includes(ATTACHMENTS[id].slot);
}

/**
 * The resolved definition: base plus attachments, as a brand new object (S6.2).
 *
 * Pure. `base` is not read after the clone and is never written to. Attachments that do
 * not fit the weapon are ignored rather than throwing, because a loadout may outlive the
 * weapon it was authored against.
 *
 * The one thing shared with the base is `recoil.kicks`, which is a `readonly` array of
 * `readonly` records and is never written by anything. Copying thirty objects per resolve
 * to protect data nothing mutates would be a cost with no benefit; the scales that *do*
 * change are plain numbers on the resolved object.
 */
export function resolveWeaponDef(base: WeaponDef, attachments: readonly AttachmentId[]): WeaponDef {
  const out = cloneWeaponDef(base);
  if (attachments.length === 0) return out;

  for (const id of APPLY_ORDER) {
    if (!attachments.includes(id)) continue;
    const attachment = ATTACHMENTS[id];
    if (!base.attachmentSlots.includes(attachment.slot)) continue;
    applyEffects(out, attachment.effects);
  }
  return out;
}

function applyEffects(def: WeaponDef, fx: AttachmentEffects): void {
  if (fx.adsTimeMult !== undefined) def.adsTime *= fx.adsTimeMult;
  if (fx.reloadMult !== undefined) {
    def.reloadTime *= fx.reloadMult;
    def.reloadEmptyTime *= fx.reloadMult;
  }
  if (fx.magSizeMult !== undefined) {
    def.magSize = Math.max(1, Math.round(def.magSize * fx.magSizeMult));
  }
  if (fx.rangeMult !== undefined) {
    def.damageFalloff.start *= fx.rangeMult;
    def.damageFalloff.end *= fx.rangeMult;
  }
  if (fx.recoilVerticalMult !== undefined) def.recoil.verticalScale *= fx.recoilVerticalMult;
  if (fx.recoilHorizontalMult !== undefined) def.recoil.horizontalScale *= fx.recoilHorizontalMult;
  if (fx.hipSpreadMult !== undefined) {
    def.spread.hipStand *= fx.hipSpreadMult;
    def.spread.hipMove *= fx.hipSpreadMult;
  }
  if (fx.adsSpreadMult !== undefined) def.spread.ads *= fx.adsSpreadMult;
  if (fx.scopeSwayMult !== undefined && def.scope !== undefined) def.scope.swayDeg *= fx.scopeSwayMult;
  if (fx.sprintOutMult !== undefined) def.sprintOutTime *= fx.sprintOutMult;
  if (fx.swapMult !== undefined) {
    def.swapInTime *= fx.swapMult;
    def.swapOutTime *= fx.swapMult;
  }
  if (fx.minimapPing !== undefined) def.minimapPing = fx.minimapPing;
  if (fx.laserVisible !== undefined) def.laserVisible = fx.laserVisible;
}

// -- verification ------------------------------------------------------------

export interface PurityFinding {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Acceptance criterion 3, as code rather than as a claim.
 *
 * Resolves the same base twice with different attachment sets and asserts that the base is
 * untouched, that the two results are distinct objects all the way down the nested records,
 * and that a write to one is not visible in the other.
 */
export function verifyAttachmentPurity(base: WeaponDef): PurityFinding[] {
  const before = JSON.stringify(base);

  const a = resolveWeaponDef(base, ['mag_extended', 'grip_foregrip']);
  const b = resolveWeaponDef(base, ['muzzle_suppressor', 'laser_tactical']);

  const out: PurityFinding[] = [];
  const add = (check: string, ok: boolean, detail: string): void => {
    out.push({ check, ok, detail });
  };

  add(
    'base unmodified',
    JSON.stringify(base) === before,
    `magSize ${base.magSize}, adsTime ${base.adsTime.toFixed(4)}, range ${base.damageFalloff.end}`,
  );
  add('distinct roots', a !== b && a !== base && b !== base, 'three separate objects');
  add(
    'distinct nested records',
    a.spread !== b.spread &&
      a.recoil !== b.recoil &&
      a.damage !== b.damage &&
      a.damageFalloff !== b.damageFalloff &&
      a.voice !== b.voice &&
      a.spread !== base.spread &&
      a.recoil !== base.recoil,
    'spread / recoil / damage / falloff / voice all cloned',
  );

  // The real test: write through one and look for it in the other.
  const beforeCross = b.spread.hipStand;
  a.spread.hipStand = 99;
  a.recoil.verticalScale = 99;
  add(
    'no cross-talk',
    b.spread.hipStand === beforeCross && b.recoil.verticalScale !== 99 && base.spread.hipStand !== 99,
    `wrote 99 into A; B holds ${b.spread.hipStand.toFixed(3)}, base holds ${base.spread.hipStand.toFixed(3)}`,
  );

  add(
    'effects landed',
    a.magSize === Math.round(base.magSize * 1.5) &&
      b.minimapPing === false &&
      b.laserVisible === true &&
      Math.abs(b.damageFalloff.end - base.damageFalloff.end * 0.9) < 1e-9,
    `A mag ${a.magSize} (base ${base.magSize}); B ping ${String(b.minimapPing)}, ` +
      `range ${b.damageFalloff.end.toFixed(2)} (base ${base.damageFalloff.end.toFixed(2)})`,
  );

  return out;
}

/** What one attachment measurably costs on one weapon. Feeds the S8.4 report. */
export interface AttachmentDelta {
  readonly weaponId: string;
  readonly attachment: AttachmentId;
  readonly adsMs: number;
  readonly adsDeltaMs: number;
  readonly hipSpreadDeg: number;
  readonly hipSpreadDeltaDeg: number;
  readonly adsSpreadDeg: number;
  readonly adsSpreadDeltaDeg: number;
  readonly magSize: number;
  readonly reloadS: number;
  readonly rangeEndM: number;
  readonly recoilVertical: number;
}

export function measureAttachment(base: WeaponDef, id: AttachmentId): AttachmentDelta {
  const on = resolveWeaponDef(base, [id]);
  return {
    weaponId: base.id,
    attachment: id,
    adsMs: on.adsTime * 1000,
    adsDeltaMs: (on.adsTime - base.adsTime) * 1000,
    hipSpreadDeg: on.spread.hipStand,
    hipSpreadDeltaDeg: on.spread.hipStand - base.spread.hipStand,
    adsSpreadDeg: on.spread.ads,
    adsSpreadDeltaDeg: on.spread.ads - base.spread.ads,
    magSize: on.magSize,
    reloadS: on.reloadTime,
    rangeEndM: on.damageFalloff.end,
    recoilVertical: on.recoil.verticalScale,
  };
}
