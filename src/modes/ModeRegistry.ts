import type { BotTier } from '../ai/DifficultyTiers';
import type { MapDef } from '../world/maps/types';
import { FOUNDRY_MAP } from '../world/maps/foundry';
import { GREYBOX_MAP } from '../world/maps/greybox';
import type { GameMode, GameModeId, ModeDeps } from './GameMode';
import { Range } from './Range';
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

export function findMap(id: string): MapEntry {
  const found = MAPS.find((m) => m.id === id);
  if (found === undefined) throw new Error(`Unknown map "${id}"`);
  return found;
}
