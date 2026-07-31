import { EQUIPMENT_DEFS } from '../equipment/EquipmentDefs';
import type { Game } from '../Game';
import { CAMOS } from '../meta/Camos';
import { CHALLENGES } from '../meta/Challenges';
import { FIELD_UPGRADES } from '../meta/FieldUpgrades';
import { LEVEL_XP } from '../meta/Levels';
import type { LoadoutSlot } from '../meta/Loadouts';
import { makeSyntheticV0Save, migrateSave, normaliseSave } from '../meta/SaveData';
import { sanitiseLoadout, UnlockState } from '../meta/Unlocks';
import { PERKS, type PerkId } from '../perks/PerkDefs';
import { perkWeaponEffects, resolvePerkState } from '../perks/PerkState';
import { ATTACHMENTS, resolveWeaponDef } from '../weapons/Attachments';
import { ALL_WEAPONS, type WeaponDef } from '../weapons/WeaponDefs';
import { ttkTableToMarkdown } from './ArsenalHarness';
import type { Harness } from './Harness';
import type { MatchHarness } from './MatchHarness';
import { simulateXp, simulationToLines } from './XpSimulator';

/**
 * `window.__operator`, the console surface the acceptance measurements are read from.
 *
 * Documented in DEBUG.md. Read-only handles plus the headless harnesses; nothing here mutates
 * gameplay except the two debug levers that exist for that purpose (`setSyntheticLoad` and the
 * harness runs).
 *
 * **Everything per-match is behind a getter rather than captured.** From M4 the match, the map,
 * the overlay and the panels are all thrown away and rebuilt on every round of play, so a
 * captured reference would be a handle to a match that no longer exists — and, worse, would keep
 * it alive and turn the heap harness into a liar about its own subject.
 */
export function installConsoleApi(game: Game, harness: Harness, matchHarness: MatchHarness): void {
  const api = {
    game,
    harness,
    matchHarness,
    weaponHarness: () => game.debugSuite?.weaponHarness,
    weaponDebug: () => game.debugSuite?.weaponDebug,

    // ---- M5 ---------------------------------------------------------------
    /** The whole roster, so a verification script can walk it without importing modules. */
    weapons: ALL_WEAPONS,
    equipmentDefs: EQUIPMENT_DEFS,
    attachments: ATTACHMENTS,
    arsenal: () => game.debugSuite?.arsenalHarness,
    arsenalReport: () => game.debugSuite?.arsenalHarness.report(),
    balanceTable: () => {
      const rows = game.debugSuite?.arsenalHarness.measureTtkTable();
      return rows === undefined ? undefined : ttkTableToMarkdown(rows);
    },
    attachmentDeltas: () => game.debugSuite?.arsenalHarness.measureAttachments(),
    equipment: () => game.activeMatch?.equipment,
    /** Pointer-lock state, which is otherwise unobservable from a script. */
    pointer: () => ({
      locked: game.inputState.isLocked,
      armed: game.inputState.pointerLockArmed,
      keyboardCapture: game.inputState.keyboardCaptureActive,
    }),
    equipmentConfig: game.equipmentConfig,
    secondaryDef: game.secondaryDef,
    match: () => game.activeMatch,
    weapon: () => game.activeMatch?.weapons,
    weaponDef: game.weaponDef,
    viewmodelConfig: game.viewmodelConfig,
    speedometer: () => game.speedo,
    stats: () => game.stats,
    latency: () => game.activeMatch?.latency,
    sim: () => game.playerSim,
    setSyntheticLoad: (ms: number) => game.setSyntheticLoad(ms),
    report: () => harness.report(),
    weaponReport: () => game.debugSuite?.weaponHarness.report(),
    bots: () => game.activeMatch?.bots,
    botReport: () => game.activeMatch?.bots.report(),
    botHarness: () => game.activeBotHarness,
    harnessReport: () => game.activeBotHarness?.report(),
    flow: () => game.activeMatch?.flow,
    mode: () => game.activeMatch?.mode,
    score: () => game.activeMatch?.score,
    laneReport: () => game.debugSuite?.modePanel.laneReport(),
    matchReport: () => matchHarness.report(),
    runMatches: (count: number) => matchHarness.run(count),
    tiers: game.tiers,
    perceptionConfig: game.perceptionConfig,
    schedulerConfig: game.schedulerConfig,

    // ---- M6 ---------------------------------------------------------------
    /**
     * The profile is process-wide, unlike everything above it: it outlives every match
     * and is the same object across a whole session, so it is a direct handle rather than
     * a getter. Everything per-match below it is still behind one.
     */
    profile: game.profile,
    save: () => game.profile.save,
    unlocks: () => game.profile.unlocks,
    loadouts: () => game.profile.loadouts,
    resolveLoadout: (unrestricted = false) => game.profile.resolveEquipped(unrestricted),
    perks: PERKS,
    perkState: () => game.activeMatch?.meta.state,
    /**
     * Resolve a def with a perk set, through the pipeline gameplay uses.
     *
     * Exposed so the acceptance suite can measure a perk's weapon effect without equipping
     * it — the alternative is a script that edits the loadout, starts a match and reads a
     * number back, which measures three things at once.
     */
    perkResolve: (base: WeaponDef, ids: readonly PerkId[]) =>
      resolveWeaponDef(base, [], perkWeaponEffects(ids)),
    perkStateOf: (ids: readonly PerkId[]) => resolvePerkState(ids),
    /** Force a loadout legal at a given level, and report what had to change. */
    sanitise: (slot: LoadoutSlot, level: number, losses: string[]) =>
      sanitiseLoadout(slot, new UnlockState(level, game.profile.save.weapons, [], game.profile.save.camos), losses),
    /** The event bus, so a script can drive a real event rather than poking a field. */
    bus: game.bus,
    challenges: CHALLENGES,
    challengeProgress: () => game.profile.challengeRows(),
    camos: CAMOS,
    fieldUpgrades: FIELD_UPGRADES,
    levelTable: LEVEL_XP,
    progression: () => game.activeMatch?.meta.progression,
    /** Fast-forward N matches of average performance and report the curve (S7). */
    simulateXp: (matches: number, startXp = 0) => {
      const sim = simulateXp(matches, startXp);
      for (const line of simulationToLines(sim)) console.info(line);
      return sim;
    },
    /** Run the migration against the hand-written V0 payload without touching the save. */
    testMigration: () => migrateSave(makeSyntheticV0Save(), 0, game.profile.settings),
    syntheticV0: makeSyntheticV0Save,
    /** Repair a payload and report the losses, without importing it. */
    inspectSave: (raw: unknown) => normaliseSave(raw, game.profile.settings),
    saveWrites: () => ({
      writes: game.profile.writeCount,
      lastWriteMs: game.profile.store.lastWriteMs,
      persistent: game.profile.store.isPersistent,
    }),
  };
  Object.defineProperty(window, '__operator', { value: api, configurable: true });
}
