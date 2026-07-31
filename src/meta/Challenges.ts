import type { HitZone } from '../combat/HitboxRig';
import type { WeaponClass } from '../weapons/WeaponDefs';
import { CAMO_PREREQUISITES, type CamoId } from './Camos';

/**
 * Challenges (brief S6.5): thirty of them, every one driven off the EventBus.
 *
 * S6.5 defines the shape and this file honours it literally — **"a challenge is a
 * subscription plus a counter plus a completion rule"**. The subscription is
 * `ChallengeTracker`'s, which subscribes *once* per event kind rather than once per
 * challenge; the counter is a number in the save; and the completion rule is the `rule`
 * field below. Nothing polls anything.
 *
 * The rules are predicates over a *fact*, not over raw event payloads. `KillFact` is
 * assembled at the moment of a kill from things that live in four different systems —
 * the weapon, the player's stance, the damage that landed and the score — because
 * "kills after sliding" is a question none of those four can answer alone. Building the
 * fact once and testing thirty cheap predicates against it is both faster and far easier
 * to read than thirty subscriptions each reaching for their own context.
 *
 * Camo challenges are the exception and are absolute rather than incremental: their
 * progress is the *best* any single weapon has reached, because S6.6's save schema stores
 * camos as account-wide booleans. "25 kills with a single weapon" is therefore the honest
 * phrasing, and it is what the editor prints.
 */

export type ChallengeId = string;

export type ChallengeCategory = 'COMBAT' | 'PRECISION' | 'MOVEMENT' | 'TACTICAL' | 'MASTERY' | 'CAMO';

/** Everything known about one kill, assembled by `MatchProgression`. */
export interface KillFact {
  readonly weaponId: string;
  readonly weaponClass: WeaponClass;
  readonly zone: HitZone;
  readonly headshot: boolean;
  /** Metres from shooter to victim, taken from the killing `damage.dealt`. */
  readonly distance: number;
  /** True when the killing shot was fired while aimed. */
  readonly ads: boolean;
  readonly sliding: boolean;
  readonly airborne: boolean;
  /** True when the kill came from a grenade or a claymore rather than a weapon. */
  readonly equipment: boolean;
  /** Kills on the current magazine, including this one. */
  readonly killsThisMag: number;
  /** Kills inside `MULTIKILL_WINDOW` seconds, including this one. */
  readonly killsInWindow: number;
  /** The killer's streak after this kill. */
  readonly streak: number;
  /** True when the victim is whoever last killed the player. */
  readonly revenge: boolean;
}

/** A finished match, for the challenges that are about the whole thing. */
export interface MatchFact {
  readonly won: boolean;
  readonly kills: number;
  readonly deaths: number;
  readonly score: number;
  readonly bestStreak: number;
}

/** The per-weapon counters a camo challenge measures. */
export type WeaponStatKey = 'kills' | 'headshots' | 'longshots' | 'multikills';

export type ChallengeRule =
  | { readonly kind: 'kill'; readonly test: (k: KillFact) => boolean }
  /** One enemy blinded by your flashbang. */
  | { readonly kind: 'flash' }
  | { readonly kind: 'match'; readonly test: (m: MatchFact) => boolean }
  /** Absolute: the highest any one weapon has reached. */
  | { readonly kind: 'weaponBest'; readonly stat: WeaponStatKey }
  /** Absolute: how many of a camo set are already owned. */
  | { readonly kind: 'camoSet'; readonly camos: readonly CamoId[] };

export interface ChallengeDef {
  readonly id: ChallengeId;
  readonly name: string;
  readonly description: string;
  readonly category: ChallengeCategory;
  /** Progress needed to complete. */
  readonly target: number;
  /** XP awarded on completion. */
  readonly xp: number;
  /** Camo unlocked on completion, if any. */
  readonly camo?: CamoId;
  readonly rule: ChallengeRule;
}

/** Seconds inside which consecutive kills count as a multikill. */
export const MULTIKILL_WINDOW = 5;

/** Seconds after a slide ends during which a kill still counts as a slide kill. */
export const SLIDE_KILL_GRACE = 1.5;

/** Metres beyond which a kill is a longshot. Mirrors `XpRules.LONGSHOT_METRES`. */
export const LONGSHOT_METRES = 38;

/** Metres inside which a kill is point blank. */
export const POINT_BLANK_METRES = 5;

function killsOfClass(cls: WeaponClass) {
  return (k: KillFact): boolean => k.weaponClass === cls && !k.equipment;
}

export const CHALLENGES: readonly ChallengeDef[] = [
  // ---- combat --------------------------------------------------------------
  {
    id: 'first_blood',
    name: 'FIRST BLOOD',
    description: 'Get your first kill',
    category: 'COMBAT',
    target: 1,
    xp: 100,
    rule: { kind: 'kill', test: () => true },
  },
  {
    id: 'centurion',
    name: 'CENTURION',
    description: 'Get 100 kills',
    category: 'COMBAT',
    target: 100,
    xp: 2500,
    rule: { kind: 'kill', test: () => true },
  },
  {
    id: 'double_kill',
    name: 'DOUBLE UP',
    description: 'Get 10 double kills',
    category: 'COMBAT',
    target: 10,
    xp: 1200,
    rule: { kind: 'kill', test: (k) => k.killsInWindow === 2 },
  },
  {
    id: 'triple_kill',
    name: 'TRIPLE THREAT',
    description: 'Get 3 triple kills',
    category: 'COMBAT',
    target: 3,
    xp: 1500,
    rule: { kind: 'kill', test: (k) => k.killsInWindow === 3 },
  },
  {
    id: 'one_mag',
    name: 'ONE MAGAZINE',
    description: 'Get 15 multikills without reloading',
    category: 'COMBAT',
    target: 15,
    xp: 1500,
    rule: { kind: 'kill', test: (k) => !k.equipment && k.killsThisMag === 2 },
  },
  {
    id: 'revenge',
    name: 'PAYBACK',
    description: 'Kill 10 enemies who killed you last',
    category: 'COMBAT',
    target: 10,
    xp: 1000,
    rule: { kind: 'kill', test: (k) => k.revenge },
  },

  // ---- precision -----------------------------------------------------------
  {
    id: 'marksman_50',
    name: 'MARKSMAN',
    description: 'Get 50 headshots',
    category: 'PRECISION',
    target: 50,
    xp: 2000,
    rule: { kind: 'kill', test: (k) => k.headshot },
  },
  {
    id: 'longshot_25',
    name: 'REACH OUT',
    description: `Get 25 kills beyond ${LONGSHOT_METRES} m`,
    category: 'PRECISION',
    target: 25,
    xp: 1500,
    rule: { kind: 'kill', test: (k) => k.distance >= LONGSHOT_METRES },
  },
  {
    id: 'hipfire',
    name: 'FROM THE HIP',
    description: 'Get 25 kills without aiming down sights',
    category: 'PRECISION',
    target: 25,
    xp: 1000,
    rule: { kind: 'kill', test: (k) => !k.ads && !k.equipment },
  },
  {
    id: 'point_blank',
    name: 'POINT BLANK',
    description: `Get 20 kills inside ${POINT_BLANK_METRES} m`,
    category: 'PRECISION',
    target: 20,
    xp: 900,
    rule: { kind: 'kill', test: (k) => k.distance <= POINT_BLANK_METRES && !k.equipment },
  },

  // ---- movement ------------------------------------------------------------
  {
    id: 'slide_kill',
    name: 'DROP SHOT',
    description: 'Get 10 kills while sliding',
    category: 'MOVEMENT',
    target: 10,
    xp: 1200,
    rule: { kind: 'kill', test: (k) => k.sliding },
  },
  {
    id: 'airborne_kill',
    name: 'AIRBORNE',
    description: 'Get 5 kills with both feet off the ground',
    category: 'MOVEMENT',
    target: 5,
    xp: 1000,
    rule: { kind: 'kill', test: (k) => k.airborne },
  },

  // ---- tactical ------------------------------------------------------------
  {
    id: 'frag_kills',
    name: 'DEMOLITION',
    description: 'Get 15 kills with lethal equipment',
    category: 'TACTICAL',
    target: 15,
    xp: 1200,
    rule: { kind: 'kill', test: (k) => k.equipment },
  },
  {
    id: 'flash_assist',
    name: 'BLINDSIDE',
    description: 'Blind 25 enemies with flashbangs',
    category: 'TACTICAL',
    target: 25,
    xp: 800,
    rule: { kind: 'flash' },
  },
  {
    id: 'streak_5',
    name: 'ON A ROLL',
    description: 'Reach a 5 killstreak 10 times',
    category: 'TACTICAL',
    target: 10,
    xp: 1500,
    rule: { kind: 'kill', test: (k) => k.streak === 5 },
  },
  {
    id: 'streak_10',
    name: 'UNSTOPPABLE',
    description: 'Reach a 10 killstreak 3 times',
    category: 'TACTICAL',
    target: 3,
    xp: 2500,
    rule: { kind: 'kill', test: (k) => k.streak === 10 },
  },

  // ---- mastery: one per weapon class ---------------------------------------
  {
    id: 'ar_kills',
    name: 'RIFLEMAN',
    description: 'Get 75 kills with assault rifles',
    category: 'MASTERY',
    target: 75,
    xp: 1800,
    rule: { kind: 'kill', test: killsOfClass('AR') },
  },
  {
    id: 'smg_kills',
    name: 'CLOSE QUARTERS',
    description: 'Get 75 kills with submachine guns',
    category: 'MASTERY',
    target: 75,
    xp: 1800,
    rule: { kind: 'kill', test: killsOfClass('SMG') },
  },
  {
    id: 'lmg_kills',
    name: 'SUPPRESSION',
    description: 'Get 50 kills with light machine guns',
    category: 'MASTERY',
    target: 50,
    xp: 1500,
    rule: { kind: 'kill', test: killsOfClass('LMG') },
  },
  {
    id: 'sniper_kills',
    name: 'OVERWATCH',
    description: 'Get 40 kills with sniper rifles',
    category: 'MASTERY',
    target: 40,
    xp: 1800,
    rule: { kind: 'kill', test: killsOfClass('SNIPER') },
  },
  {
    id: 'shotgun_kills',
    name: 'BREACHER',
    description: 'Get 40 kills with shotguns',
    category: 'MASTERY',
    target: 40,
    xp: 1500,
    rule: { kind: 'kill', test: killsOfClass('SHOTGUN') },
  },
  {
    id: 'pistol_kills',
    name: 'SIDEARM',
    description: 'Get 25 kills with a sidearm',
    category: 'MASTERY',
    target: 25,
    xp: 1200,
    rule: { kind: 'kill', test: killsOfClass('PISTOL') },
  },

  // ---- match-level ---------------------------------------------------------
  {
    id: 'survivor',
    name: 'VETERAN',
    description: 'Win 10 matches',
    category: 'COMBAT',
    target: 10,
    xp: 3000,
    rule: { kind: 'match', test: (m) => m.won },
  },
  {
    id: 'untouchable',
    name: 'UNTOUCHABLE',
    description: 'Finish a match with 15 kills and 3 deaths or fewer',
    category: 'COMBAT',
    target: 3,
    xp: 2000,
    rule: { kind: 'match', test: (m) => m.kills >= 15 && m.deaths <= 3 },
  },
  {
    id: 'carried',
    name: 'MOST VALUABLE',
    description: 'Finish 5 matches with a streak of 8 or better',
    category: 'COMBAT',
    target: 5,
    xp: 2200,
    rule: { kind: 'match', test: (m) => m.bestStreak >= 8 },
  },

  // ---- camos ---------------------------------------------------------------
  {
    id: 'camo_digital',
    name: 'DIGITAL',
    description: 'Get 25 kills with a single weapon',
    category: 'CAMO',
    target: 25,
    xp: 500,
    camo: 'digital',
    rule: { kind: 'weaponBest', stat: 'kills' },
  },
  {
    id: 'camo_splinter',
    name: 'SPLINTER',
    description: 'Get 15 headshots with a single weapon',
    category: 'CAMO',
    target: 15,
    xp: 750,
    camo: 'splinter',
    rule: { kind: 'weaponBest', stat: 'headshots' },
  },
  {
    id: 'camo_tiger',
    name: 'TIGER',
    description: `Get 10 kills beyond ${LONGSHOT_METRES} m with a single weapon`,
    category: 'CAMO',
    target: 10,
    xp: 750,
    camo: 'tiger',
    rule: { kind: 'weaponBest', stat: 'longshots' },
  },
  {
    id: 'camo_fractal',
    name: 'FRACTAL',
    description: 'Get 5 one-magazine multikills with a single weapon',
    category: 'CAMO',
    target: 5,
    xp: 1000,
    camo: 'fractal',
    rule: { kind: 'weaponBest', stat: 'multikills' },
  },
  {
    id: 'camo_gold',
    name: 'GOLD',
    description: 'Get 100 kills with a single weapon',
    category: 'CAMO',
    target: 100,
    xp: 2000,
    camo: 'gold',
    rule: { kind: 'weaponBest', stat: 'kills' },
  },
  {
    id: 'camo_obsidian',
    name: 'OBSIDIAN',
    description: 'Earn every other camouflage',
    category: 'CAMO',
    target: CAMO_PREREQUISITES.length,
    xp: 5000,
    camo: 'obsidian',
    rule: { kind: 'camoSet', camos: CAMO_PREREQUISITES },
  },
];

export const CHALLENGE_IDS: readonly ChallengeId[] = CHALLENGES.map((c) => c.id);

const BY_ID = new Map<ChallengeId, ChallengeDef>(CHALLENGES.map((c) => [c.id, c]));

export function challengeDef(id: ChallengeId): ChallengeDef | undefined {
  return BY_ID.get(id);
}

export function challengesInCategory(category: ChallengeCategory): ChallengeDef[] {
  return CHALLENGES.filter((c) => c.category === category);
}

export const CHALLENGE_CATEGORIES: readonly ChallengeCategory[] = [
  'COMBAT',
  'PRECISION',
  'MOVEMENT',
  'TACTICAL',
  'MASTERY',
  'CAMO',
];
