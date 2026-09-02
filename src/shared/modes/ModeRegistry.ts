import type { BotTier } from '../ai/DifficultyTiers';
import { logger } from '../core/Log';
import type { MapDef } from '../world/maps/types';
import { DEPOT_MAP } from '../world/maps/depot';
import { DUNES_MAP } from '../world/maps/dunes';
import { FOUNDRY_MAP } from '../world/maps/foundry';
import { GREYBOX_MAP } from '../world/maps/greybox';
import { ScoreSystem } from '../combat/ScoreSystem';
import { createGameBus } from '../core/Events';
import type { GameMode, GameModeId, ModeDeps } from './GameMode';
import { Domination } from './Domination';
import { FFA_CONFIG, FFA_WARMUP_CONFIG, FreeForAll } from './FreeForAll';
import { KillConfirmed } from './KillConfirmed';
import { Range } from './Range';
import { SearchAndDestroy, SND_CONFIG, SND_SKIRMISH_CONFIG } from './SearchAndDestroy';
import { Tdm } from './Tdm';

const log = logger('ModeRegistry');

/**
 * What the menu can offer, and how a match is built from a choice (brief S6.7).
 *
 * One mode and two maps. Foundry is the M4 map and the default; TESTBED is M1's grey-box
 * room, kept selectable because the M2 weapon range and the M2/M3 acceptance scripts live
 * in it — dropping it from the menu would have quietly retired three verification suites to
 * make a list look tidier.
 *
 * The registry is the only place that knows the concrete mode classes, so `Game` and the
 * menu both work in terms of an id and never import `Tdm`.
 */

export interface ModeEntry {
  readonly id: GameModeId;
  readonly name: string;
  /** One line, shown under the mode's name in the menu. */
  readonly blurb: string;
  readonly create: (deps: ModeDeps) => GameMode;
  /**
   * M6. Whether this mode fills the map with bots. The range does not.
   *
   * A mode-level flag rather than a map-level one: the grey-box map is also a legitimate
   * TDM arena and had a bot roster in M4 and M5.
   */
  readonly populatesRoster: boolean;
  /**
   * M6. Whether unlock gates are lifted for this mode.
   *
   * True only on the range, where the entire point is testing weapons the account has not
   * earned yet. `banksProgress` moves with it: a mode that hands you everything must not
   * be able to hand you XP for using it.
   */
  readonly unrestricted: boolean;
  /** Whether a finished match writes to the profile. */
  readonly banksProgress: boolean;
  /** Which map this mode forces, or null to let the player choose. */
  readonly forcedMapId: string | null;
  /**
   * M7. Total combatants including the player, or null to use the map's own team size.
   *
   * Only Free-for-All sets it: S6.2 fixes FFA at eight players regardless of which map it is
   * played on, where every other mode takes the roster the map was balanced for.
   */
  readonly rosterSize?: number;
  /**
   * M7. Whether every other combatant is hostile regardless of side.
   *
   * True in FFA only. The two-team substrate stays — see `FreeForAll` — and this flag is what
   * makes spawn safety and the bot brain treat all seven opponents as threats.
   */
  readonly freeForAll?: boolean;
  /**
   * M7. Which map objectives this mode requires. A mode listed here is hidden on a map that
   * does not author them, rather than throwing when the match is built.
   */
  readonly requiresObjective?: 'flag' | 'bombsite';
  /**
   * M7. Multiplier on every tier's push aggression while this mode is running.
   *
   * Only Search & Destroy sets it. One life per round means a trade is a loss, so bots hold
   * angles instead of closing — the brief's "push aggression should drop sharply".
   */
  readonly pushAggressionScale?: number;
  /**
   * Post-M8. Whether the start of a round puts every combatant back on a spawn.
   *
   * True only for Search & Destroy, and it is a *mode* property rather than something derived
   * from `roundsToWin > 1`: a hard reset is right for a mode where a round is a fresh
   * engagement with one life each, and would be wrong for a hypothetical multi-round
   * Domination where holding ground across a round break is the point. Modes that never
   * declare it keep M4's behaviour exactly.
   */
  readonly usesRoundReset?: boolean;
}

export const MODES: readonly ModeEntry[] = [
  {
    id: 'TDM',
    name: 'TEAM DEATHMATCH',
    blurb: 'First to 75 kills, or ten minutes',
    create: (deps) => new Tdm(deps),
    populatesRoster: true,
    unrestricted: false,
    banksProgress: true,
    forcedMapId: null,
  },
  {
    id: 'DOM',
    name: 'DOMINATION',
    blurb: 'Three flags · 200 points · one a flag every five seconds',
    create: (deps) => new Domination(deps),
    populatesRoster: true,
    unrestricted: false,
    banksProgress: true,
    forcedMapId: null,
    requiresObjective: 'flag',
  },
  {
    id: 'KC',
    name: 'KILL CONFIRMED',
    blurb: 'Kills drop tags · collect to score, deny to refuse · 65 tags',
    create: (deps) => new KillConfirmed(deps),
    populatesRoster: true,
    unrestricted: false,
    banksProgress: true,
    forcedMapId: null,
  },
  {
    id: 'FFA',
    name: 'FREE-FOR-ALL',
    blurb: 'Eight operators · no teams · first to 30',
    // The permanent arena is FFA with both limits switched off (§6.3). See `FFA_WARMUP_CONFIG`.
    create: (deps) => new FreeForAll(deps, deps.variant === 'WARMUP' ? FFA_WARMUP_CONFIG : FFA_CONFIG),
    populatesRoster: true,
    unrestricted: false,
    banksProgress: true,
    forcedMapId: null,
    rosterSize: 8,
    freeForAll: true,
  },
  {
    id: 'SND',
    name: 'SEARCH & DESTROY',
    blurb: 'One life · plant or defuse · best of nine, sides swap at five',
    // The only mode that reads `ModeDeps.variant`: the skirmish ballot runs a best of five
    // (§6.4), the menu runs M7's best of three. See `SND_SKIRMISH_CONFIG`.
    create: (deps) =>
      new SearchAndDestroy(deps, deps.variant === 'SKIRMISH' ? SND_SKIRMISH_CONFIG : SND_CONFIG),
    populatesRoster: true,
    pushAggressionScale: SND_CONFIG.cautionScale,
    unrestricted: false,
    banksProgress: true,
    forcedMapId: null,
    requiresObjective: 'bombsite',
    usesRoundReset: true,
  },
  {
    id: 'RANGE',
    name: 'SHOOTING RANGE',
    blurb: 'Every weapon unlocked · dummies · nobody shooting back',
    create: (deps) => new Range(deps),
    populatesRoster: false,
    unrestricted: true,
    banksProgress: false,
    // The dummies are built into the grey-box map, so the range is only that map.
    forcedMapId: GREYBOX_MAP.id,
  },
];

export interface MapEntry {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly def: MapDef;
  /** Bots per side for a default match here. */
  readonly teamSize: number;
  /** Dealt round-robin, so a match is a spread of skill rather than one tier. */
  readonly tierMix: readonly BotTier[];
  /** Whether the M2 target range is built into this map. */
  readonly targetRange: boolean;
}

export const MAPS: readonly MapEntry[] = [
  {
    id: FOUNDRY_MAP.id,
    name: FOUNDRY_MAP.name,
    blurb: 'Industrial · three lanes · catwalks',
    def: FOUNDRY_MAP,
    // 5v5 is four bots alongside the player and five against (S6).
    teamSize: 5,
    tierMix: ['REGULAR', 'HARDENED', 'RECRUIT', 'REGULAR', 'VETERAN', 'HARDENED', 'REGULAR', 'RECRUIT'],
    targetRange: false,
  },
  {
    id: DUNES_MAP.id,
    name: DUNES_MAP.name,
    blurb: 'Desert village · long streets · tight alleys',
    def: DUNES_MAP,
    // 5v5, same as Foundry. Dunes is bigger in area but the fight concentrates in three
    // lanes exactly as Foundry's does, so a larger roster would only thin it out.
    teamSize: 5,
    tierMix: ['REGULAR', 'HARDENED', 'RECRUIT', 'REGULAR', 'VETERAN', 'HARDENED', 'REGULAR', 'RECRUIT'],
    targetRange: false,
  },
  {
    id: DEPOT_MAP.id,
    name: DEPOT_MAP.name,
    blurb: 'Night cargo yard · stacked containers · climb it',
    def: DEPOT_MAP,
    teamSize: 5,
    tierMix: ['HARDENED', 'REGULAR', 'VETERAN', 'REGULAR', 'HARDENED', 'RECRUIT', 'REGULAR', 'VETERAN'],
    targetRange: false,
  },
  {
    id: GREYBOX_MAP.id,
    name: GREYBOX_MAP.name,
    blurb: 'Grey-box range · movement and weapon testbed',
    def: GREYBOX_MAP,
    teamSize: 4,
    tierMix: ['REGULAR', 'HARDENED', 'RECRUIT', 'REGULAR'],
    targetRange: true,
  },
];

export const DEFAULT_MODE_ID: GameModeId = 'TDM';
export const DEFAULT_MAP_ID = FOUNDRY_MAP.id;

export function findMode(id: GameModeId): ModeEntry {
  const found = MODES.find((m) => m.id === id);
  if (found === undefined) throw new Error(`Unknown game mode "${id}"`);
  return found;
}

/**
 * Modes that can actually be played on this map (M7).
 *
 * Domination needs flags and Search & Destroy needs bomb sites; the grey-box testbed authors
 * neither. Filtering here means the menu never offers a match that would throw on construction,
 * and adding a second map with objectives makes both modes appear on it with no further work.
 */
export function modesForMap(mapId: string): ModeEntry[] {
  const map = MAPS.find((m) => m.id === mapId);
  const kinds = new Set((map?.def.objectives ?? []).map((o) => o.kind));
  return MODES.filter((mode) => {
    if (mode.forcedMapId !== null && mode.forcedMapId !== mapId) return false;
    return mode.requiresObjective === undefined || kinds.has(mode.requiresObjective);
  });
}

/**
 * Every registered mode's brief, built the way a match builds it (playtest round 4, F10).
 *
 * ## Why this is a run rather than a grep
 *
 * `GameMode.brief` is `abstract`, so a mode that omits it entirely is a **compile error** and
 * needs no check at all. What a type cannot say is that the string is worth reading: three of
 * the six are getters that assemble the sentence from the map's authored objectives, so
 * "Domination briefs you to capture nothing" is a live question about content, and no regular
 * expression over the source can answer it. `scripts/check-unlocks.mjs` says the same thing
 * about its own limits from the other side.
 *
 * Each mode is constructed against **the first map it can legally run on** — the same
 * `modesForMap` filter the menu uses — because Search & Destroy throws on a map with no bomb
 * sites and Domination on one with no flags, and a mode that cannot be built anywhere is a
 * different fault which this reports as such rather than crashing on.
 *
 * Pure, allocating a throwaway bus and score per mode and keeping neither. Nothing here
 * subscribes to anything that outlives the call.
 */
export function auditModeBriefs(): ModeBriefAudit {
  const rows: ModeBriefRow[] = [];
  const problems: string[] = [];
  const seen = new Map<string, GameModeId>();

  for (const entry of MODES) {
    const map = MAPS.find((m) => modesForMap(m.id).some((mode) => mode.id === entry.id));
    if (map === undefined) {
      problems.push(`${entry.id} can be played on no registered map; its brief cannot be built.`);
      continue;
    }
    let brief: string;
    try {
      brief = entry
        .create({
          bus: createGameBus(),
          score: new ScoreSystem(createGameBus()),
          roster: [],
          mapDef: map.def,
        })
        .brief.trim();
    } catch (err) {
      problems.push(`${entry.id} threw while being built on ${map.id}: ${String(err)}`);
      continue;
    }
    rows.push({ id: entry.id, mapId: map.id, brief });
    if (brief === '') {
      problems.push(
        `${entry.id} has an empty brief. The pre-match banner would be blank for ten seconds, ` +
          'which reads as a mode with no objective rather than as a missing string.',
      );
    }
    const duplicate = seen.get(brief);
    if (duplicate !== undefined) {
      problems.push(
        `${entry.id} and ${duplicate} brief identically ("${brief}"). Two modes with one ` +
          'sentence is a copy-paste, and the second mode is the one nobody notices is wrong.',
      );
    } else if (brief !== '') {
      seen.set(brief, entry.id);
    }
  }

  if (rows.length !== MODES.length && problems.length === 0) {
    problems.push('fewer briefs than registered modes with nothing to say why — audit is broken.');
  }
  return { rows, problems };
}

export interface ModeBriefRow {
  readonly id: GameModeId;
  /** The map it was built on, because three of the briefs name that map's objectives. */
  readonly mapId: string;
  readonly brief: string;
}

export interface ModeBriefAudit {
  readonly rows: readonly ModeBriefRow[];
  readonly problems: readonly string[];
}

export function findMap(id: string): MapEntry {
  const found = MAPS.find((m) => m.id === id);
  if (found === undefined) throw new Error(`Unknown map "${id}"`);
  return found;
}

/**
 * The map a *saved setting* names, or the default if it names one that no longer exists.
 *
 * Found while verifying M9, and older than M9. `normaliseSave` has validated every other
 * field of the save since M6 but has never checked `mapId` or `modeId` against this
 * registry — they are stored as bare strings. A save written before the map ids were
 * prefixed (`foundry` rather than `mp_foundry`) therefore survives migration intact and
 * then throws out of `findMap` on the first paint of the main menu, which presents as a
 * front end permanently stuck on "Loading…" with a clean console, because the throw
 * happens inside a state-enter handler.
 *
 * A stale id in a save is not an exceptional condition — it is what happens to anybody who
 * played an earlier build — so it resolves rather than throws. `findMap` keeps throwing,
 * because a *code* path asking for a map that does not exist is a bug and should say so.
 */
export function resolveMapId(id: string): MapEntry {
  const found = MAPS.find((m) => m.id === id);
  if (found !== undefined) return found;
  log.warn(`saved map "${id}" no longer exists; falling back to ${DEFAULT_MAP_ID}.`);
  return findMap(DEFAULT_MAP_ID);
}

/** As `resolveMapId`, for the mode. Same reasoning, same failure. */
export function resolveModeId(id: string): ModeEntry {
  const found = MODES.find((m) => m.id === id);
  if (found !== undefined) return found;
  log.warn(`saved mode "${id}" no longer exists; falling back to ${DEFAULT_MODE_ID}.`);
  return findMode(DEFAULT_MODE_ID);
}
