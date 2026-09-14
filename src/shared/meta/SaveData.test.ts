import { beforeAll, describe, expect, it } from 'vitest';
import { installLogSink } from '../core/Log';
import { levelForXp } from './Levels';
import {
  defaultSettings,
  makeSyntheticV0Save,
  migrateSave,
  normaliseSave,
  SAVE_VERSION,
  type SettingsV1,
} from './SaveData';

/**
 * Characterisation of the migration: a hand-written v1 and v2 save reach `SAVE_VERSION` with
 * the level and the XP they had, the v2 binding repairs happen exactly once, and the synthetic
 * v0 payload `verify/progression.js` migrates in the browser migrates the same way here.
 *
 * The saves are written by hand rather than generated from `defaultSave`, because the point
 * is the shape an *older* build wrote — the fields that did not exist yet are the migration.
 */

/** 42 000 XP is level 15 on the shipped table; the pair is consistent so nothing gets repaired. */
const XP = 42_000;
const LEVEL = 15;

function fallback(): SettingsV1 {
  return defaultSettings('TDM', 'mp_foundry', 90);
}

/** The M6/M7 layout: a profile block, but the seven-field settings of M1-M7 and no bindings. */
function saveV1(): Record<string, unknown> {
  return {
    version: 1,
    profile: { level: LEVEL, xp: XP, prestige: 0, unlockTokens: 0, permanentUnlocks: [], matchesPlayed: 12, matchesWon: 7 },
    weapons: { ar_carbine: { xp: 1200, kills: 88, headshots: 9, unlockedAttachments: [] } },
    loadouts: [],
    equippedLoadout: 2,
    challenges: {},
    camos: {},
    settings: { fov: 103, sensitivity: 1.4, invertY: true, masterVolume: 0.3, renderScale: 0.75, modeId: 'DOM', mapId: 'mp_dunes' },
  };
}

/** The M8 layout: the eleven new settings and a binding table, with ADS on the button M8 shipped wrong. */
function saveV2(): Record<string, unknown> {
  return {
    ...saveV1(),
    version: 2,
    settings: {
      fov: 95, sensitivity: 2, invertY: false, masterVolume: 0.7, renderScale: 1, modeId: 'KC', mapId: 'mp_foundry',
      adsSensitivity: 0.6, sfxVolume: 0.5, musicVolume: 0.2, uiVolume: 0.4,
      shadowQuality: 'high', showFps: true, motionBlur: false, colorblind: 'deuteranopia',
      bindings: { ads: ['Mouse1'], use: ['KeyE', 'KeyP'], jump: ['Space'] },
    },
  };
}

beforeAll(() => {
  // The migration reports through the logger; a test run does not want it on the console.
  installLogSink({ log() {} });
});

describe('migrateSave', () => {
  it('lifts a v1 save to SAVE_VERSION with its level and XP intact', () => {
    const out = migrateSave(saveV1(), 1, fallback());
    expect(out).not.toBeNull();
    expect(out?.version).toBe(SAVE_VERSION);
    expect(out?.profile.xp).toBe(XP);
    expect(out?.profile.level).toBe(LEVEL);
    expect(out?.profile.matchesWon).toBe(7);
    expect(out?.weapons['ar_carbine']?.kills).toBe(88);
    expect(out?.equippedLoadout).toBe(2);
  });

  it('derives the v2 audio buses from a v1 master volume and lifts master to 1', () => {
    const out = migrateSave(saveV1(), 1, fallback());
    expect(out?.settings.sfxVolume).toBeCloseTo(0.3, 12);
    expect(out?.settings.musicVolume).toBeCloseTo(0.18, 12);
    expect(out?.settings.uiVolume).toBeCloseTo(0.3, 12);
    expect(out?.settings.masterVolume).toBe(1);
    expect(out?.settings.fov).toBe(103);
    expect(out?.settings.invertY).toBe(true);
    expect(out?.settings.modeId).toBe('DOM');
  });

  it('a v1 save with no bindings gets the shipped defaults, ADS on Mouse2', () => {
    const out = migrateSave(saveV1(), 1, fallback());
    expect(out?.settings.bindings.ads).toEqual(['Mouse2']);
    expect(out?.settings.bindings.use).toEqual(['KeyT', 'KeyE']);
  });

  it('lifts a v2 save to SAVE_VERSION with its level and XP intact and its settings kept', () => {
    const out = migrateSave(saveV2(), 2, fallback());
    expect(out?.version).toBe(SAVE_VERSION);
    expect(out?.profile.xp).toBe(XP);
    expect(out?.profile.level).toBe(LEVEL);
    expect(out?.settings.fov).toBe(95);
    expect(out?.settings.sfxVolume).toBe(0.5);
    expect(out?.settings.masterVolume).toBe(0.7);
    expect(out?.settings.shadowQuality).toBe('high');
    expect(out?.settings.colorblind).toBe('deuteranopia');
    expect(out?.settings.showFps).toBe(true);
  });

  it('v2 -> v3 moves ADS from Mouse1 to Mouse2 and puts KeyT first on use', () => {
    const out = migrateSave(saveV2(), 2, fallback());
    expect(out?.settings.bindings.ads).toEqual(['Mouse2']);
    expect(out?.settings.bindings.use).toEqual(['KeyT', 'KeyE']);
    expect(out?.settings.bindings.jump).toEqual(['Space']);
  });

  it('the v2 -> v3 repair is applied only when coming from below v3', () => {
    const v3 = { ...saveV2(), version: 3 };
    const out = migrateSave(v3, 3, fallback());
    expect(out?.settings.bindings.ads).toEqual(['Mouse1']);
    expect(out?.settings.bindings.use).toEqual(['KeyE', 'KeyP']);
  });

  it('migrates the synthetic v0 the way verify/progression.js expects', () => {
    const v0 = makeSyntheticV0Save();
    const out = migrateSave(v0, 0, fallback());
    expect(out?.profile.xp).toBe(42_000);
    expect(out?.profile.level).toBe(levelForXp(42_000));
    expect(out?.profile.prestige).toBe(1);
    expect(out?.weapons['ar_carbine']?.kills).toBe(312);
    expect(out?.weapons['ar_retired_prototype']).toBeUndefined();
    expect(out?.settings.fov).toBe(103);
    expect(out?.loadouts[1]?.primary.weaponId).toBe('smg_wasp');
  });

  it('returns null for something that is not an object', () => {
    expect(migrateSave('nope', 1, fallback())).toBeNull();
    expect(migrateSave(null, 1, fallback())).toBeNull();
  });
});

describe('normaliseSave', () => {
  it('corrects a level the XP does not support and says so', () => {
    const damaged = { ...saveV2(), version: 3, profile: { level: 55, xp: XP } };
    const { save, losses } = normaliseSave(damaged, fallback());
    expect(save.profile.level).toBe(LEVEL);
    expect(losses.some((l) => l.startsWith('profile.level 55 disagreed'))).toBe(true);
  });

  it('drops an unknown weapon and reports it', () => {
    const damaged = { ...saveV2(), version: 3, weapons: { weapon_that_never_existed: { kills: 9 } } };
    const { save, losses } = normaliseSave(damaged, fallback());
    expect(save.weapons['weapon_that_never_existed']).toBeUndefined();
    expect(losses).toContain('dropped stats for unknown weapon "weapon_that_never_existed"');
  });

  it('starts a fresh profile, with a loss line, when handed a non-object', () => {
    const { save, losses } = normaliseSave(42, fallback());
    expect(save.version).toBe(SAVE_VERSION);
    expect(save.profile.level).toBe(1);
    expect(losses).toEqual(['save was not an object; started a fresh profile']);
  });
});
