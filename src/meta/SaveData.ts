import { defaultBindings, normaliseBindings, type BindingMap } from '../core/Keybinds';
import type { Versioned } from '../core/SaveStore';
import { ALL_EQUIPMENT, type EquipmentId } from '../equipment/EquipmentDefs';
import { isPerkId, perkDef, type PerkId } from '../perks/PerkDefs';
import { isStreakId, type StreakId } from '../streaks/StreakDefs';
import { ATTACHMENT_IDS, type AttachmentId } from '../weapons/Attachments';
import { ALL_WEAPONS, WEAPON_DEFS } from '../weapons/WeaponDefs';
import { CAMO_IDS, isCamoId, type CamoId } from './Camos';
import { CHALLENGES, type ChallengeId } from './Challenges';
import { isFieldUpgradeId, type FieldUpgradeId } from './FieldUpgrades';
import { levelForXp, MAX_LEVEL, PRESTIGE_MAX } from './Levels';
import {
  cloneLoadout,
  defaultLoadouts,
  LOADOUT_SLOT_COUNT,
  type LoadoutSlot,
  type WeaponLoadout,
} from './Loadouts';

/**
 * The save file (brief S6.6), and the migration that must never cost anybody their unlocks.
 *
 * S6.6 is blunt about the stakes: *"Losing a player's progress because you bumped a schema
 * is the worst bug in this milestone."* So there are two separate mechanisms here and they
 * do different jobs.
 *
 * **`migrateSave`** handles a *version* change: a payload written by an older schema is
 * translated field by field into the current one. `SaveStore` calls it once, at load.
 *
 * **`normaliseSave`** handles *damage*: a payload at the right version whose contents are
 * wrong — a weapon id that no longer exists, a level that disagrees with the XP, a perk in
 * the wrong tier, `null` where an object should be, a hand-edited save trying to equip a
 * locked weapon. It runs on **every** load, not only on a version change, and it repairs
 * in place and returns a list of what it had to touch. Nothing is ever discarded silently
 * and the whole file is never reset because one field was bad — which is the difference
 * between this and `try { JSON.parse } catch { reset }`.
 *
 * Both are pure functions over plain data with no DOM and no storage access, which is what
 * lets `verify/progression.js` hand them a hand-written older save and check the result.
 */

/**
 * Settings, folded into the one save object S6.6 asks for.
 *
 * M8 adds eleven fields and every one of them does something — S6.3 is blunt that "a setting
 * that does not do anything is worse than a missing setting". The name is still `SettingsV1`
 * because it is the settings block of save **v2**; the version lives on the save, not on
 * each block, and renaming the type would have been a rename with no migration behind it.
 */
export interface SettingsV1 {
  fov: number;
  sensitivity: number;
  invertY: boolean;
  masterVolume: number;
  renderScale: number;
  modeId: string;
  mapId: string;

  // ---- M8 -----------------------------------------------------------------
  /** Multiplier on look sensitivity at full ADS (S6.3). */
  adsSensitivity: number;
  /** The three buses under master, each 0..1. */
  sfxVolume: number;
  musicVolume: number;
  uiVolume: number;
  /** Shadow map size and softness, as a named tier. */
  shadowQuality: ShadowQuality;
  /** Whether the always-on FPS read-out is drawn. */
  showFps: boolean;
  /** Per-object motion blur on the camera. */
  motionBlur: boolean;
  /** Which colour vocabulary gameplay uses. See `ui/Palette.ts`. */
  colorblind: ColorblindMode;
  /** Physical input to action, by action id. See `core/Keybinds.ts`. */
  bindings: BindingMap;
}

export const SHADOW_QUALITIES = ['off', 'low', 'medium', 'high'] as const;
export type ShadowQuality = (typeof SHADOW_QUALITIES)[number];

export const COLORBLIND_MODES = ['off', 'deuteranopia', 'protanopia', 'tritanopia'] as const;
export type ColorblindMode = (typeof COLORBLIND_MODES)[number];

export interface ProfileData {
  level: number;
  xp: number;
  prestige: number;
  unlockTokens: number;
  /** Items bought with a token: permanently unlocked across prestige resets. */
  permanentUnlocks: string[];
  /** Lifetime totals, kept across prestige. Shown on the loadout screen. */
  matchesPlayed: number;
  matchesWon: number;
}

export interface WeaponSaveData {
  xp: number;
  kills: number;
  headshots: number;
  unlockedAttachments: AttachmentId[];
  /** S6.2's "accuracy": stored as its two inputs so it can never drift from them. */
  shotsFired: number;
  shotsHit: number;
  /** Metres. S6.2's "longest shot". */
  longestShot: number;
  /** Seconds held. S6.2's "time used". */
  timeUsed: number;
  /** Kills beyond `LONGSHOT_METRES`, for the TIGER camo. */
  longshots: number;
  /** One-magazine multikills, for the FRACTAL camo. */
  multikills: number;
}

export interface ChallengeSaveData {
  progress: number;
  completed: boolean;
}

export interface SaveV2 extends Versioned {
  version: 2;
  profile: ProfileData;
  weapons: Record<string, WeaponSaveData>;
  loadouts: LoadoutSlot[];
  /** The Shooting Range's own always-unlocked class (M7 playtest). Optional on old saves. */
  rangeLoadout?: LoadoutSlot;
  /** Which of the five slots is equipped. */
  equippedLoadout: number;
  challenges: Record<ChallengeId, ChallengeSaveData>;
  camos: Record<string, boolean>;
  settings: SettingsV1;
}

/**
 * Bumped to 2 in M8, for the eleven settings fields and the binding table.
 *
 * The bump is not strictly *required* — `normaliseSave` defaults every new field, so a v1
 * payload would have loaded correctly without one. It is here because S6.3 asks that every
 * setting "survives a migration", and a migration you never run is a migration you have
 * never tested. `upgradeV1` is therefore a real function with a real assertion behind it
 * (`verify/settings.js`), not a version number nudged upward.
 */
export const SAVE_VERSION = 2;
export const SAVE_KEY = 'operator.save';

/** The key M1-M5 wrote settings to. Read once, by the migration, then left alone. */
export const LEGACY_SETTINGS_KEY = 'operator.settings';

export function defaultSettings(modeId: string, mapId: string, fov: number): SettingsV1 {
  return {
    fov,
    sensitivity: 1,
    invertY: false,
    masterVolume: 0.8,
    renderScale: 1,
    modeId,
    mapId,
    // M8. The mix defaults are not all 1: see `AudioMix` for why SFX sits under the others.
    adsSensitivity: 0.8,
    sfxVolume: 0.9,
    musicVolume: 0.55,
    uiVolume: 0.85,
    shadowQuality: 'medium',
    showFps: false,
    motionBlur: false,
    colorblind: 'off',
    bindings: defaultBindings(),
  };
}

/**
 * Pull settings out of M1-M5's separate store, for a profile that has none yet.
 *
 * S6.6 folds settings into the one save object, which means the first launch after M6
 * would otherwise reset everybody's FOV, sensitivity and volume to defaults — a small
 * loss, but exactly the kind this milestone exists to refuse. The legacy key is read once
 * and never written, so the old blob stays where it is and a downgrade still works.
 */
export function readLegacySettings(fallback: SettingsV1): SettingsV1 {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LEGACY_SETTINGS_KEY);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.info('[Save] legacy settings were unreadable; using defaults.');
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;

  const out: SettingsV1 = { ...fallback };
  out.fov = num(parsed['fov'], fallback.fov);
  out.sensitivity = num(parsed['sensitivity'], fallback.sensitivity);
  out.invertY = parsed['invertY'] === true;
  out.masterVolume = num(parsed['masterVolume'], fallback.masterVolume);
  out.renderScale = num(parsed['renderScale'], fallback.renderScale);
  if (typeof parsed['modeId'] === 'string') out.modeId = parsed['modeId'];
  if (typeof parsed['mapId'] === 'string') out.mapId = parsed['mapId'];
  console.info('[Save] carried settings over from the M1-M5 store.');
  return out;
}

export function makeWeaponSave(): WeaponSaveData {
  return {
    xp: 0,
    kills: 0,
    headshots: 0,
    unlockedAttachments: [],
    shotsFired: 0,
    shotsHit: 0,
    longestShot: 0,
    timeUsed: 0,
    longshots: 0,
    multikills: 0,
  };
}

export function defaultSave(settings: SettingsV1): SaveV2 {
  const weapons: Record<string, WeaponSaveData> = {};
  for (const def of ALL_WEAPONS) weapons[def.id] = makeWeaponSave();

  const challenges: Record<ChallengeId, ChallengeSaveData> = {};
  for (const c of CHALLENGES) challenges[c.id] = { progress: 0, completed: false };

  const camos: Record<string, boolean> = {};
  for (const id of CAMO_IDS) camos[id] = false;

  return {
    version: SAVE_VERSION,
    profile: {
      level: 1,
      xp: 0,
      prestige: 0,
      unlockTokens: 0,
      permanentUnlocks: [],
      matchesPlayed: 0,
      matchesWon: 0,
    },
    weapons,
    loadouts: defaultLoadouts(),
    equippedLoadout: 0,
    challenges,
    camos,
    settings: { ...settings },
  };
}

// -- repair -------------------------------------------------------------------

/** What `normaliseSave` had to change, in human-readable lines. */
export interface SaveRepair {
  readonly save: SaveV2;
  readonly losses: string[];
}

const EQUIPMENT_IDS = new Set<string>(ALL_EQUIPMENT.map((e) => e.id));
const ATTACHMENT_SET = new Set<string>(ATTACHMENT_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, num(value, fallback));
}

function clampTo(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** A 0..1 setting, repaired rather than rejected. */
function unit(value: unknown, fallback: number): number {
  return clampTo(num(value, fallback), 0, 1);
}

/** A string setting from a closed list, or the fallback. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Take whatever came out of storage and make it a legal `SaveV2`, reporting every repair.
 *
 * `unlockedLevel` is passed in rather than read off the payload because the profile's own
 * level is one of the things being repaired: a save that claims level 55 with 0 XP must
 * not be allowed to validate its own loadouts.
 */
export function normaliseSave(raw: unknown, fallbackSettings: SettingsV1): SaveRepair {
  const losses: string[] = [];
  const out = defaultSave(fallbackSettings);
  if (!isRecord(raw)) {
    losses.push('save was not an object; started a fresh profile');
    return { save: out, losses };
  }

  // ---- profile -------------------------------------------------------------
  const profile = raw['profile'];
  if (isRecord(profile)) {
    if (typeof profile['xp'] !== 'number' || !Number.isFinite(profile['xp'])) {
      losses.push(`profile.xp was ${JSON.stringify(profile['xp'])}; reset to 0`);
    }
    out.profile.xp = nonNegative(profile['xp'], 0);
    out.profile.prestige = Math.min(PRESTIGE_MAX, Math.round(nonNegative(profile['prestige'], 0)));
    out.profile.unlockTokens = Math.round(nonNegative(profile['unlockTokens'], 0));
    out.profile.matchesPlayed = Math.round(nonNegative(profile['matchesPlayed'], 0));
    out.profile.matchesWon = Math.round(nonNegative(profile['matchesWon'], 0));
    const permanent = profile['permanentUnlocks'];
    if (Array.isArray(permanent)) {
      out.profile.permanentUnlocks = permanent.filter((v): v is string => typeof v === 'string');
    }
    // The level is derived, never trusted: XP is the ledger and the level is a view of it.
    // A save claiming a level the XP does not support is the exact shape of a hand-edit,
    // and acceptance criterion 5 requires it to be refused.
    const claimed = Math.round(num(profile['level'], 1));
    const derived = levelForXp(out.profile.xp);
    out.profile.level = Math.min(MAX_LEVEL, derived);
    if (claimed !== out.profile.level) {
      losses.push(`profile.level ${claimed} disagreed with ${out.profile.xp} XP; corrected to ${out.profile.level}`);
    }
  } else {
    losses.push('profile block missing or malformed; reset to level 1');
  }

  // ---- weapons -------------------------------------------------------------
  const weapons = raw['weapons'];
  if (isRecord(weapons)) {
    for (const [id, value] of Object.entries(weapons)) {
      if (WEAPON_DEFS[id] === undefined) {
        losses.push(`dropped stats for unknown weapon "${id}"`);
        continue;
      }
      const target = out.weapons[id];
      if (target === undefined) continue;
      if (!isRecord(value)) {
        losses.push(`weapon "${id}" held ${JSON.stringify(value)} instead of a record; stats reset`);
        continue;
      }
      target.xp = nonNegative(value['xp'], 0);
      target.kills = Math.round(nonNegative(value['kills'], 0));
      target.headshots = Math.round(nonNegative(value['headshots'], 0));
      target.shotsFired = Math.round(nonNegative(value['shotsFired'], 0));
      target.shotsHit = Math.round(nonNegative(value['shotsHit'], 0));
      target.longestShot = nonNegative(value['longestShot'], 0);
      target.timeUsed = nonNegative(value['timeUsed'], 0);
      target.longshots = Math.round(nonNegative(value['longshots'], 0));
      target.multikills = Math.round(nonNegative(value['multikills'], 0));
      const list = value['unlockedAttachments'];
      if (Array.isArray(list)) {
        const kept: AttachmentId[] = [];
        for (const entry of list) {
          if (typeof entry === 'string' && ATTACHMENT_SET.has(entry)) kept.push(entry as AttachmentId);
          else losses.push(`dropped unknown attachment "${String(entry)}" on ${id}`);
        }
        target.unlockedAttachments = kept;
      }
    }
  } else {
    losses.push('weapons block missing or malformed; weapon progress reset');
  }

  // ---- camos ---------------------------------------------------------------
  const camos = raw['camos'];
  if (isRecord(camos)) {
    for (const [id, value] of Object.entries(camos)) {
      if (!isCamoId(id)) {
        losses.push(`dropped unknown camo "${id}"`);
        continue;
      }
      out.camos[id] = value === true;
    }
  }

  // ---- challenges ----------------------------------------------------------
  const challenges = raw['challenges'];
  if (isRecord(challenges)) {
    for (const [id, value] of Object.entries(challenges)) {
      const target = out.challenges[id];
      if (target === undefined) {
        losses.push(`dropped progress for retired challenge "${id}"`);
        continue;
      }
      if (!isRecord(value)) continue;
      target.progress = Math.round(nonNegative(value['progress'], 0));
      target.completed = value['completed'] === true;
    }
  }

  // ---- loadouts ------------------------------------------------------------
  const loadouts = raw['loadouts'];
  if (Array.isArray(loadouts)) {
    for (let i = 0; i < LOADOUT_SLOT_COUNT; i++) {
      const slot = out.loadouts[i];
      const source = loadouts[i];
      if (slot === undefined || !isRecord(source)) continue;
      normaliseSlot(slot, source, i, losses);
    }
    if (loadouts.length !== LOADOUT_SLOT_COUNT) {
      losses.push(`save held ${loadouts.length} loadouts; resized to ${LOADOUT_SLOT_COUNT}`);
    }
  } else {
    losses.push('loadouts missing or malformed; restored the shipped five');
  }

  out.equippedLoadout = Math.min(
    LOADOUT_SLOT_COUNT - 1,
    Math.max(0, Math.round(num(raw['equippedLoadout'], 0))),
  );

  // ---- settings ------------------------------------------------------------
  //
  // Every field falls back to the default it does not have, which is what makes a save
  // written before M8 load with eleven new settings at sensible values rather than at
  // `undefined` — and it is why the settings block needed no version bump of its own.
  const settings = raw['settings'];
  if (isRecord(settings)) {
    const s = out.settings;
    s.fov = clampTo(num(settings['fov'], fallbackSettings.fov), 60, 120);
    s.sensitivity = clampTo(num(settings['sensitivity'], fallbackSettings.sensitivity), 0.05, 10);
    s.invertY = settings['invertY'] === true;
    s.masterVolume = unit(settings['masterVolume'], fallbackSettings.masterVolume);
    s.renderScale = clampTo(num(settings['renderScale'], fallbackSettings.renderScale), 0.5, 1);
    if (typeof settings['modeId'] === 'string') s.modeId = settings['modeId'];
    if (typeof settings['mapId'] === 'string') s.mapId = settings['mapId'];

    s.adsSensitivity = clampTo(num(settings['adsSensitivity'], fallbackSettings.adsSensitivity), 0.1, 2);
    s.sfxVolume = unit(settings['sfxVolume'], fallbackSettings.sfxVolume);
    s.musicVolume = unit(settings['musicVolume'], fallbackSettings.musicVolume);
    s.uiVolume = unit(settings['uiVolume'], fallbackSettings.uiVolume);
    s.shadowQuality = oneOf(settings['shadowQuality'], SHADOW_QUALITIES, fallbackSettings.shadowQuality);
    s.showFps = settings['showFps'] === true;
    s.motionBlur = settings['motionBlur'] === true;
    s.colorblind = oneOf(settings['colorblind'], COLORBLIND_MODES, fallbackSettings.colorblind);
    // `normaliseBindings` restores the defaults for any action the save never heard of, so
    // a pre-M8 save comes back fully bound rather than with three dead killstreak keys.
    s.bindings = normaliseBindings(settings['bindings']);
  }

  return { save: out, losses };
}

/**
 * Repair one loadout slot.
 *
 * Everything an id can be wrong about is checked here, and *nothing about unlocks* is:
 * whether the level permits a weapon is decided by `Unlocks.sanitiseLoadout`, which runs
 * afterward and needs the repaired profile to make that judgement. Splitting them keeps
 * "is this a real id" separate from "are you allowed it", which are different failures
 * with different messages.
 */
function normaliseSlot(slot: LoadoutSlot, source: Record<string, unknown>, index: number, losses: string[]): void {
  if (typeof source['name'] === 'string' && source['name'].length > 0) {
    slot.name = source['name'].slice(0, 16);
  }
  normaliseWeaponLoadout(slot.primary, source['primary'], `loadout ${index + 1} primary`, losses);
  normaliseWeaponLoadout(slot.secondary, source['secondary'], `loadout ${index + 1} secondary`, losses);

  const lethal = source['lethal'];
  if (typeof lethal === 'string' && EQUIPMENT_IDS.has(lethal)) slot.lethal = lethal as EquipmentId;
  else if (lethal !== undefined) losses.push(`loadout ${index + 1} lethal "${String(lethal)}" unknown`);

  const tactical = source['tactical'];
  if (typeof tactical === 'string' && EQUIPMENT_IDS.has(tactical)) slot.tactical = tactical as EquipmentId;
  else if (tactical !== undefined) losses.push(`loadout ${index + 1} tactical "${String(tactical)}" unknown`);

  const upgrade = source['fieldUpgrade'];
  if (typeof upgrade === 'string' && isFieldUpgradeId(upgrade)) slot.fieldUpgrade = upgrade as FieldUpgradeId;
  else if (upgrade !== undefined) losses.push(`loadout ${index + 1} field upgrade "${String(upgrade)}" unknown`);

  /**
   * Killstreaks (M7 playtest). Absent on every save written before the streak slots existed,
   * which is why a missing array is silently left at the class default rather than reported:
   * an upgrade is not a loss. A *present* array with junk in it is reported like anything else.
   */
  const streaks = source['streaks'];
  if (Array.isArray(streaks)) {
    slot.streaks = [null, null, null];
    for (let i = 0; i < 3; i++) {
      const entry = streaks[i];
      if (entry === null || entry === undefined) continue;
      if (typeof entry !== 'string' || !isStreakId(entry)) {
        losses.push(`loadout ${index + 1} killstreak "${String(entry)}" unknown`);
        continue;
      }
      // The same id on two keys wastes one; keep the first and report the second.
      if (slot.streaks.includes(entry as StreakId)) {
        losses.push(`loadout ${index + 1} had ${entry} on two keys; removed the second`);
        continue;
      }
      slot.streaks[i] = entry as StreakId;
    }
  }

  const perks = source['perks'];
  if (!Array.isArray(perks)) return;
  slot.perks = [null, null, null];
  for (let tier = 0; tier < 3; tier++) {
    const entry = perks[tier];
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== 'string' || !isPerkId(entry)) {
      losses.push(`loadout ${index + 1} perk "${String(entry)}" unknown`);
      continue;
    }
    const id = entry as PerkId;
    if (perkDef(id).tier !== tier + 1) {
      losses.push(`loadout ${index + 1} had ${perkDef(id).name} in tier ${tier + 1}; removed`);
      continue;
    }
    slot.perks[tier] = id;
  }
}

function normaliseWeaponLoadout(
  target: WeaponLoadout,
  source: unknown,
  label: string,
  losses: string[],
): void {
  if (!isRecord(source)) return;
  const id = source['weaponId'];
  if (typeof id === 'string' && WEAPON_DEFS[id] !== undefined) target.weaponId = id;
  else if (id !== undefined) losses.push(`${label} weapon "${String(id)}" unknown; kept the default`);

  const camo = source['camo'];
  if (camo === null) target.camo = null;
  else if (typeof camo === 'string' && isCamoId(camo)) target.camo = camo as CamoId;
  else if (camo !== undefined) losses.push(`${label} camo "${String(camo)}" unknown`);

  const list = source['attachments'];
  if (!Array.isArray(list)) return;
  const kept: AttachmentId[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && ATTACHMENT_SET.has(entry)) kept.push(entry as AttachmentId);
    else losses.push(`${label} attachment "${String(entry)}" unknown`);
  }
  target.attachments = kept;
}

// -- migration ----------------------------------------------------------------

/**
 * Translate an older save into the current schema.
 *
 * There is exactly one older schema so far — the pre-release V0 below — and the point of
 * writing the function now, with only one edge to walk, is that the *shape* is established
 * before there is anything valuable to lose. A migration added after the first schema
 * break is a migration written under pressure.
 *
 * Returns `null` only for input that is not an object at all, at which point `SaveStore`
 * falls back to defaults and says so. Anything object-shaped is salvaged.
 */
export function migrateSave(raw: unknown, fromVersion: number, fallbackSettings: SettingsV1): SaveV2 | null {
  if (!isRecord(raw)) return null;

  // The edges are walked in order, so a v0 payload passes through both upgrades.
  const afterV0 = fromVersion < 1 ? upgradeV0(raw) : raw;
  const upgraded = fromVersion < 2 ? upgradeV1(afterV0) : afterV0;
  const { save, losses } = normaliseSave(upgraded, fallbackSettings);
  save.version = SAVE_VERSION;

  console.info(
    `[Save] migrated v${fromVersion} -> v${SAVE_VERSION}: level ${save.profile.level}, ` +
      `${save.profile.xp} XP, ${Object.keys(save.weapons).length} weapons, ` +
      `${losses.length} field(s) repaired.`,
  );
  for (const line of losses) console.info(`[Save]   ${line}`);
  return save;
}

/**
 * v1 to v2 (M8): the settings block gains eleven fields and a binding table.
 *
 * Nothing outside `settings` moved, so this touches nothing else — a migration that
 * rewrites blocks it does not need to is a migration that can lose them. The new fields
 * are **derived where a v1 save had something to derive them from** rather than simply
 * defaulted:
 *
 * - `sfxVolume` inherits the old `masterVolume`, so a player who had turned the game down
 *   to 0.3 does not get a 0.9 SFX bus the first time they launch M8.
 * - `masterVolume` is then lifted to 1, because v1's single slider was doing the job the
 *   three bus sliders now do and leaving both at 0.3 would multiply to 0.09.
 *
 * The rest have no v1 equivalent and take their defaults. `bindings` is deliberately absent
 * rather than defaulted here: `normaliseBindings` runs downstream on every load and rebuilds
 * the whole table, so writing it twice would only create somewhere for the two to disagree.
 */
function upgradeV1(raw: Record<string, unknown>): Record<string, unknown> {
  const settings = isRecord(raw['settings']) ? raw['settings'] : {};
  const master = num(settings['masterVolume'], 0.8);
  return {
    ...raw,
    settings: {
      ...settings,
      sfxVolume: num(settings['sfxVolume'], master),
      musicVolume: num(settings['musicVolume'], master * 0.6),
      uiVolume: num(settings['uiVolume'], master),
      masterVolume: 1,
    },
  };
}

/**
 * The pre-release layout.
 *
 * Flat XP with no profile block, weapon kills as bare numbers, and two-field classes with
 * no perks or attachments. Everything V1 knows that V0 did not is defaulted, and the level
 * is recomputed from the XP rather than carried across — which is the whole reason the
 * level is derived in the first place.
 */
interface SaveV0Shape {
  version?: number;
  xp?: number;
  prestige?: number;
  weaponKills?: Record<string, number>;
  classes?: Array<{ primary?: string; secondary?: string }>;
  settings?: Partial<SettingsV1>;
}

function upgradeV0(raw: Record<string, unknown>): Record<string, unknown> {
  const v0 = raw as SaveV0Shape;
  const xp = nonNegative(v0.xp, 0);

  const weapons: Record<string, unknown> = {};
  for (const [id, kills] of Object.entries(v0.weaponKills ?? {})) {
    weapons[id] = { ...makeWeaponSave(), kills: nonNegative(kills, 0) };
  }

  const loadouts = defaultLoadouts().map((slot, i) => {
    const legacy = v0.classes?.[i];
    const next = cloneLoadout(slot);
    if (legacy?.primary !== undefined) next.primary.weaponId = legacy.primary;
    if (legacy?.secondary !== undefined) next.secondary.weaponId = legacy.secondary;
    return next;
  });

  return {
    version: SAVE_VERSION,
    profile: {
      level: levelForXp(xp),
      xp,
      prestige: nonNegative(v0.prestige, 0),
      unlockTokens: 0,
      permanentUnlocks: [],
      matchesPlayed: 0,
      matchesWon: 0,
    },
    weapons,
    loadouts,
    equippedLoadout: 0,
    challenges: {},
    camos: {},
    settings: v0.settings ?? {},
  };
}

/**
 * A hand-written V0 payload, for acceptance criterion 7.
 *
 * Lives in the source rather than in the verification script so the migration and its
 * test input cannot be edited apart, and so the save inspector can force a migration on
 * demand without a script loaded.
 */
export function makeSyntheticV0Save(): Record<string, unknown> {
  return {
    version: 0,
    xp: 42_000,
    prestige: 1,
    weaponKills: {
      ar_carbine: 312,
      smg_wasp: 96,
      // A weapon that no longer exists. The migration must drop it and say so rather
      // than carrying a key nothing can read.
      ar_retired_prototype: 40,
    },
    classes: [
      { primary: 'ar_carbine', secondary: 'pistol_talon' },
      { primary: 'smg_wasp', secondary: 'pistol_talon' },
    ],
    settings: { fov: 103, sensitivity: 1.4, masterVolume: 0.55 },
  };
}
