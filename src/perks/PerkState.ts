import type { AttachmentEffects } from '../weapons/Attachments';
import { perkDef, type PerkId, type PerkStateEffects } from './PerkDefs';

/**
 * A loadout's three perks, resolved.
 *
 * Two outputs, because perks do two different kinds of thing:
 *
 * **`weaponEffects`** is a list of `AttachmentEffects` handed straight to
 * `resolveWeaponDef` alongside the attachments. Quickdraw, Sleight of Hand and Amped go
 * through the identical multiplication chain a foregrip does, which is what makes the
 * loadout editor's numbers and the gameplay's numbers the same numbers by construction —
 * acceptance criterion 3.
 *
 * **`PerkState`** is everything a weapon field cannot express. It is a plain readonly
 * record with sensible neutrals, so "no perks" is a real state rather than a null check
 * at every consumer: `NO_PERKS` has a speed multiplier of 1, audible footsteps and full
 * flash intensity, which is exactly what M1-M5 already did.
 *
 * Nothing here mutates anything. `resolvePerkState` reads the defs and returns a new
 * object; two loadouts holding the same perk cannot interfere.
 */

export interface PerkState {
  readonly perks: readonly PerkId[];
  /** Ground speed cap multiplier. 1 is the M1 behaviour. */
  readonly moveSpeedMult: number;
  /** False when footsteps must not reach the bots' noise field. */
  readonly audibleFootsteps: boolean;
  /** Multiplies incoming flash intensity. 1 is the M5 behaviour. */
  readonly flashResistMult: number;
  readonly scavenger: boolean;
  readonly tracker: boolean;
  readonly overkill: boolean;
  /** Inert until M7. False once Ghost is equipped. */
  readonly visibleToUav: boolean;
  /** Inert until M7. False once Cold-Blooded is equipped. */
  readonly targetedByStreaks: boolean;
  /** Inert until M7. Kills subtracted from every streak requirement. */
  readonly streakDiscount: number;
}

export const NO_PERKS: PerkState = {
  perks: [],
  moveSpeedMult: 1,
  audibleFootsteps: true,
  flashResistMult: 1,
  scavenger: false,
  tracker: false,
  overkill: false,
  visibleToUav: true,
  targetedByStreaks: true,
  streakDiscount: 0,
};

/**
 * Fold a perk list into one state.
 *
 * Multipliers compose by multiplication and flags by OR, so two perks touching the same
 * quantity stack. Nothing in the shipped twelve overlaps, and the composition rule is
 * still the right one — a field upgrade or a killstreak granting a temporary speed boost
 * has somewhere to go that does not overwrite Lightweight.
 */
export function resolvePerkState(ids: readonly PerkId[]): PerkState {
  if (ids.length === 0) return NO_PERKS;

  let moveSpeedMult = 1;
  let audibleFootsteps = true;
  let flashResistMult = 1;
  let scavenger = false;
  let tracker = false;
  let overkill = false;
  let ghost = false;
  let coldBlooded = false;
  let streakDiscount = 0;

  for (const id of ids) {
    const fx: PerkStateEffects = perkDef(id).state;
    if (fx.moveSpeedMult !== undefined) moveSpeedMult *= fx.moveSpeedMult;
    if (fx.silentFootsteps === true) audibleFootsteps = false;
    if (fx.flashResistMult !== undefined) flashResistMult *= fx.flashResistMult;
    if (fx.scavenger === true) scavenger = true;
    if (fx.tracker === true) tracker = true;
    if (fx.overkill === true) overkill = true;
    if (fx.ghost === true) ghost = true;
    if (fx.coldBlooded === true) coldBlooded = true;
    if (fx.streakDiscount !== undefined) streakDiscount += fx.streakDiscount;
  }

  return {
    perks: [...ids],
    moveSpeedMult,
    audibleFootsteps,
    flashResistMult,
    scavenger,
    tracker,
    overkill,
    visibleToUav: !ghost,
    targetedByStreaks: !coldBlooded,
    streakDiscount,
  };
}

/**
 * The perks' weapon-side modifiers, in perk order.
 *
 * Returned as a list rather than pre-folded because `resolveWeaponDef` applies
 * attachments in a fixed order for reproducibility and perks have to join that same
 * chain; folding them here would put the multiplication in two places.
 */
export function perkWeaponEffects(ids: readonly PerkId[]): AttachmentEffects[] {
  const out: AttachmentEffects[] = [];
  for (const id of ids) {
    const fx = perkDef(id).weapon;
    // An empty effects record would still cost a pass through the applier. Most perks
    // have one, so skipping them is the common case rather than a micro-optimisation.
    if (Object.keys(fx).length > 0) out.push(fx);
  }
  return out;
}

/** Compact one-line description, for the debug panel and the editor's summary row. */
export function describePerkState(state: PerkState): string {
  if (state.perks.length === 0) return 'none';
  return state.perks.map((id) => perkDef(id).name).join(' · ');
}
