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
import { STREAK_DEFS, type StreakId } from '../streaks/StreakDefs';
import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import { perkWeaponEffects, resolvePerkState } from '../perks/PerkState';
import { ATTACHMENTS, resolveWeaponDef } from '../weapons/Attachments';
import { ALL_WEAPONS, type WeaponDef } from '../weapons/WeaponDefs';
import { ttkTableToMarkdown } from './ArsenalHarness';
import type { Harness } from './Harness';
import { Handover } from './Handover';
import type { MatchHarness } from './MatchHarness';
import { simulateXp, simulationToLines } from './XpSimulator';
import { cssHex, palette } from '../ui/Palette';

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
  /**
   * M8. The four hand-over measurements S6.5 asks for, in one export format.
   *
   * Built here rather than per-match because three of the four outlive a match — the frame
   * buffer, the heap boundaries and the render-scale sweep all span the thing they measure.
   */
  const handover = new Handover({ game, loop: game.loopHandle, stats: game.stats, matchHarness });

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

    // ---- M8 ---------------------------------------------------------------
    /** "Sprint every wall" on the current map (S8, criterion 2). One call, one table. */
    snagSweep: () => game.debugSuite?.snagHarness.run(),
    snagReport: () => game.debugSuite?.snagHarness.lastReport,

    // ---- post-M8: the QA spectator ----------------------------------------
    /**
     * God mode, invisibility and free-cam, from the console as well as from F1.
     *
     * Reachable without opening the overlay on purpose: the overlay is a large modal panel
     * and half the reason to spectate is to *watch the screen*. `__operator.spectate.all()`
     * is the one-liner; the three below are the individual switches, and each returns the
     * spectator's state line so a console session reads back what it just did.
     */
    spectate: {
      all: (on = true) => {
        game.debugSuite?.spectator.full(on);
        return game.debugSuite?.spectator.describe();
      },
      god: (on = true) => {
        game.debugSuite?.spectator.setGodMode(on);
        return game.debugSuite?.spectator.describe();
      },
      invisible: (on = true) => {
        game.debugSuite?.spectator.setInvisible(on);
        return game.debugSuite?.spectator.describe();
      },
      noclip: (on = true) => {
        game.debugSuite?.spectator.setFreeCam(on);
        return game.debugSuite?.spectator.describe();
      },
      off: () => {
        game.debugSuite?.spectator.reset();
        return game.debugSuite?.spectator.describe();
      },
      state: () => game.debugSuite?.spectator.describe(),
    },

    // ---- the hand-over tools (S6.5). Documented in DEBUG.md. ---------------
    handover,
    /** Frame-time p50/p95/p99/worst plus the whole buffer, as JSON. */
    frameReport: () => handover.frameReport(),
    /** Input latency, in milliseconds and in frames. Needs a live match. */
    latencyReport: () => handover.latencyReport(),
    /** Drive the per-tick sim path and watch the heap, with a control. Needs a live match. */
    allocationProbe: (ticks?: number) => handover.allocationProbe(ticks),
    /** Walk every render scale and report the percentiles at each. Needs a live match. */
    renderSweep: (secondsPerStep?: number) => handover.renderScaleSweep(secondsPerStep),
    /** Everything but the heap run, for pasting into an issue. */
    fullReport: () => handover.fullReport(),
    /** Copy any of the above to the clipboard as JSON. */
    copyReport: (report: unknown) => handover.copy(report),
    /** The live settings record, so a script can assert what a change actually did. */
    settings: () => game.profile.settings,
    applySettings: (patch: unknown) => game.applySettings(patch as Record<string, never>),
    palette: () => paletteSnapshot(),
    matchReport: () => matchHarness.report(),
    runMatches: (count: number) => matchHarness.run(count),
    tiers: game.tiers,
    perceptionConfig: game.perceptionConfig,
    schedulerConfig: game.schedulerConfig,

    // ---- M7 ---------------------------------------------------------------
    streaks: () => game.activeMatch?.streaks,
    streakDefs: STREAK_DEFS,
    /** Live streak entities, one line each (S7). */
    streakState: () => game.activeMatch?.streaks.active.map((s) => s.describe()),
    sentries: () => game.activeMatch?.streaks.sentries(),
    packages: () => game.activeMatch?.streaks.packages(),
    /** Grant a streak without earning it, then spend it where the player is standing. */
    giveStreak: (id: string) => game.activeMatch?.streaks.debugGrant(PLAYER_ENTITY_ID, id as StreakId),
    useStreak: (id: string) => {
      const match = game.activeMatch;
      const sim = game.playerSim;
      if (match === null || sim === undefined) return undefined;
      return match.streaks.activate(PLAYER_ENTITY_ID, id as StreakId, sim.x, sim.y, sim.z, sim.yaw);
    },
    /** The effective requirement for a streak, after Hardline. */
    streakRequirement: (id: string) =>
      game.activeMatch?.streaks.requirementFor(id as StreakId, PLAYER_ENTITY_ID),
    streakPending: () => game.activeMatch?.streaks.pendingFor(PLAYER_ENTITY_ID),

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

/** The live gameplay palette, for the colourblind acceptance check. */
function paletteSnapshot(): Record<string, string> {
  const p = palette.current;
  return {
    mode: palette.currentMode,
    friendly: cssHex(p.friendly),
    hostile: cssHex(p.hostile),
    neutral: cssHex(p.neutral),
    hitmarker: cssHex(p.hitmarker),
    hitmarkerKill: cssHex(p.hitmarkerKill),
  };
}
