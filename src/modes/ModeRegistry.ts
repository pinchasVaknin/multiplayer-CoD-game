import type { BotTier } from '../ai/DifficultyTiers';
import type { MapDef } from '../world/maps/types';
import { DEPOT_MAP } from '../world/maps/depot';
import { DUNES_MAP } from '../world/maps/dunes';
import { FOUNDRY_MAP } from '../world/maps/foundry';
import { GREYBOX_MAP } from '../world/maps/greybox';
import type { GameMode, GameModeId, ModeDeps } from './GameMode';
import { Domination } from './Domination';
import { FreeForAll } from './FreeForAll';
import { KillConfirmed } from './KillConfirmed';
import { Range } from './Range';
import { SearchAndDestroy, SND_CONFIG } from './SearchAndDestroy';
import { Tdm } from './Tdm';

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
    create: (deps) => new FreeForAll(deps),
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
    create: (deps) => new SearchAndDestroy(deps),
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

export function findMap(id: string): MapEntry {
  const found = MAPS.find((m) => m.id === id);
  if (found === undefined) throw new Error(`Unknown map "${id}"`);
  return found;
}
