import type { Game } from '../Game';
import type { Harness } from './Harness';
import type { MatchHarness } from './MatchHarness';

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
  };
  Object.defineProperty(window, '__operator', { value: api, configurable: true });
}
