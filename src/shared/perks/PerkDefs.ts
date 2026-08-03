import type { AttachmentEffects } from '../weapons/Attachments';

/**
 * Perks (brief S6.4). Twelve, three tiers of four, each with a real effect hook.
 *
 * The organising rule is the one M5's attachments established and S6.4 restates: **perks
 * apply through the same resolved-def / modifier pipeline as attachments — pure,
 * composable, no mutation of shared state.** So a perk that changes a weapon number
 * carries an `AttachmentEffects` and goes through `resolveWeaponDef`'s machinery
 * unchanged, and there is exactly one place in the project where a `WeaponDef` is
 * modified.
 *
 * The perks that do *not* change a weapon number cannot be expressed that way, and
 * pretending otherwise would be worse than admitting it. Those carry a `state` flag
 * instead, which lands on `PerkState` and is read by the system that owns the behaviour:
 * movement for Lightweight, `BotDirector`'s noise field for Dead Silence, `FlashField`
 * for Battle Hardened, `PerksRuntime` for Scavenger and Tracker, loadout validation for
 * Overkill. One perk, one hook, and the hook is named here so "what does this actually
 * do" is answerable by reading the record.
 *
 * Three perks are inert by instruction. S9 puts killstreaks out of scope and says to
 * "leave the Hardline/Ghost/Cold-Blooded hooks ready but inert" — so their flags are real,
 * queried by real functions (`PerkState.visibleToUav`, `.targetedByStreaks`,
 * `.streakDiscount`) and reported in the F1 panel, and the thing that does not exist yet
 * is the killstreak that would ask.
 */

export type PerkId =
  | 'lightweight'
  | 'scavenger'
  | 'battle_hardened'
  | 'sleight_of_hand'
  | 'ghost'
  | 'dead_silence'
  | 'tracker'
  | 'hardline'
  | 'quickdraw'
  | 'amped'
  | 'overkill'
  | 'cold_blooded';

/** Which of the three slots a perk occupies. One per tier, exactly as S6.3 asks. */
export type PerkTier = 1 | 2 | 3;

/**
 * A perk's non-weapon effects.
 *
 * Every field is optional and absent means "unchanged", the same contract
 * `AttachmentEffects` uses. Numeric fields compose by multiplication and booleans by OR,
 * so two perks touching the same quantity stack rather than the last one winning — which
 * matters the moment a killstreak or a field upgrade wants to grant one temporarily.
 */
export interface PerkStateEffects {
  /** Multiplies every ground speed cap. Lightweight's +7% is 1.07. */
  readonly moveSpeedMult?: number;
  /** Footsteps stop entering the bots' noise field entirely. */
  readonly silentFootsteps?: boolean;
  /** Multiplies incoming flash intensity at the source, so bots and the player agree. */
  readonly flashResistMult?: number;
  /** Collects a magazine from a nearby body. */
  readonly scavenger?: boolean;
  /** Draws enemy footstep trails for the local player. */
  readonly tracker?: boolean;
  /** The secondary slot may hold a primary. */
  readonly overkill?: boolean;
  /** Inert until M7: invisible to UAV sweeps. */
  readonly ghost?: boolean;
  /** Inert until M7: not acquired by sentries and streak weapons. */
  readonly coldBlooded?: boolean;
  /** Inert until M7: kills subtracted from every streak requirement. */
  readonly streakDiscount?: number;
}

export interface PerkDef {
  readonly id: PerkId;
  readonly name: string;
  readonly tier: PerkTier;
  /** One line, shown in the editor under the name. */
  readonly blurb: string;
  /** Which system carries this out. Printed in the debug panel beside the measurement. */
  readonly hook: string;
  /** Account level this perk becomes selectable at. */
  readonly unlockLevel: number;
  /** Weapon-number changes, resolved by the same pure function attachments use. */
  readonly weapon: AttachmentEffects;
  /** Everything a weapon number cannot express. */
  readonly state: PerkStateEffects;
  /** True while the effect has no consumer yet (S9). Surfaced in the editor and the panel. */
  readonly inert?: boolean;
}

/**
 * The twelve.
 *
 * Tiers are grouped so each one is a genuine choice rather than an obvious pick: tier 1
 * is sustain, tier 2 is stealth and intel, tier 3 is handling — and Overkill sits in tier
 * 3 against Quickdraw so a second primary costs you the fastest ADS in the game.
 */
export const PERKS: Readonly<Record<PerkId, PerkDef>> = {
  // ---- tier 1: sustain -----------------------------------------------------
  lightweight: {
    id: 'lightweight',
    name: 'LIGHTWEIGHT',
    tier: 1,
    blurb: '+7% movement speed',
    hook: 'PlayerController.speedScale',
    unlockLevel: 1,
    weapon: {},
    state: { moveSpeedMult: 1.07 },
  },
  scavenger: {
    id: 'scavenger',
    name: 'SCAVENGER',
    tier: 1,
    blurb: 'Resupply ammunition from bodies',
    hook: 'PerksRuntime scavenger pickups',
    unlockLevel: 4,
    weapon: {},
    state: { scavenger: true },
  },
  battle_hardened: {
    id: 'battle_hardened',
    name: 'BATTLE HARDENED',
    tier: 1,
    blurb: '-60% flash effect',
    hook: 'FlashField.resistance',
    unlockLevel: 14,
    weapon: {},
    state: { flashResistMult: 0.4 },
  },
  sleight_of_hand: {
    id: 'sleight_of_hand',
    name: 'SLEIGHT OF HAND',
    tier: 1,
    blurb: '-35% reload time',
    hook: 'WeaponDef.reloadTime / reloadEmptyTime',
    unlockLevel: 9,
    weapon: { reloadMult: 0.65 },
    state: {},
  },

  // ---- tier 2: stealth and intel -------------------------------------------
  ghost: {
    id: 'ghost',
    name: 'GHOST',
    tier: 2,
    blurb: 'Undetectable by UAV sweeps',
    hook: 'PerkState.visibleToUav — inert until M7',
    unlockLevel: 20,
    weapon: {},
    state: { ghost: true },
    inert: true,
  },
  dead_silence: {
    id: 'dead_silence',
    name: 'DEAD SILENCE',
    tier: 2,
    blurb: 'Footsteps inaudible to the enemy',
    hook: 'BotDirector noise field gate',
    // The cheapest perk in tier 2, and deliberately not level 1: tier 2 is empty for the
    // first four levels, which is what makes reaching 5 feel like it gave you something.
    unlockLevel: 5,
    weapon: {},
    state: { silentFootsteps: true },
  },
  tracker: {
    id: 'tracker',
    name: 'TRACKER',
    tier: 2,
    blurb: 'Enemies leave visible footstep trails',
    hook: 'PerksRuntime trail buffer',
    unlockLevel: 26,
    weapon: {},
    state: { tracker: true },
  },
  hardline: {
    id: 'hardline',
    name: 'HARDLINE',
    tier: 2,
    blurb: 'Killstreaks require one fewer kill',
    hook: 'PerkState.streakDiscount — inert until M7',
    unlockLevel: 17,
    weapon: {},
    state: { streakDiscount: 1 },
    inert: true,
  },

  // ---- tier 3: handling ----------------------------------------------------
  quickdraw: {
    id: 'quickdraw',
    name: 'QUICKDRAW',
    tier: 3,
    blurb: '-30% aim down sights time',
    hook: 'WeaponDef.adsTime',
    unlockLevel: 1,
    weapon: { adsTimeMult: 0.7 },
    state: {},
  },
  amped: {
    id: 'amped',
    name: 'AMPED',
    tier: 3,
    blurb: '-40% weapon swap time',
    hook: 'WeaponDef.swapInTime / swapOutTime',
    unlockLevel: 7,
    weapon: { swapMult: 0.6 },
    state: {},
  },
  overkill: {
    id: 'overkill',
    name: 'OVERKILL',
    tier: 3,
    blurb: 'Carry two primary weapons',
    hook: 'Loadout validation and the editor',
    unlockLevel: 23,
    weapon: {},
    state: { overkill: true },
  },
  cold_blooded: {
    id: 'cold_blooded',
    name: 'COLD-BLOODED',
    tier: 3,
    blurb: 'Not targeted by sentries or streak weapons',
    hook: 'PerkState.targetedByStreaks — inert until M7',
    unlockLevel: 30,
    weapon: {},
    state: { coldBlooded: true },
    inert: true,
  },
};

export const PERK_IDS = Object.keys(PERKS) as PerkId[];

export function perkDef(id: PerkId): PerkDef {
  return PERKS[id];
}

/** Every perk in a tier, in declaration order. Drives the three columns of the editor. */
export function perksOfTier(tier: PerkTier): PerkDef[] {
  return PERK_IDS.map((id) => PERKS[id]).filter((p) => p.tier === tier);
}

export function isPerkId(value: string): value is PerkId {
  return Object.prototype.hasOwnProperty.call(PERKS, value);
}

export const PERK_TIERS: readonly PerkTier[] = [1, 2, 3];
