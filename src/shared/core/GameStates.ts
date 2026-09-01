/**
 * The game's top-level state vocabulary and its legal transition table.
 *
 * Lives outside Game.ts so that the EventBus payload types can reference it without
 * a circular import.
 */

export type GameStateId =
  | 'BOOT'
  | 'MENU'
  | 'LOADOUT'
  | 'SETTINGS'
  | 'MATCH'
  | 'PAUSED'
  | 'SUMMARY';

export const GAME_STATES: readonly GameStateId[] = [
  'BOOT',
  'MENU',
  'LOADOUT',
  'SETTINGS',
  'MATCH',
  'PAUSED',
  'SUMMARY',
];

/**
 * BOOT -> MENU -> MATCH -> SUMMARY, with LOADOUT and SETTINGS hanging off the menu, plus
 * the back-edges that a real front end needs. M1 only ever walked
 * BOOT -> MENU -> MATCH -> MENU.
 *
 * **PAUSED is new in M5** and is the fix for the M4 playtest note that Esc quit the match
 * outright. It sits beside MATCH rather than replacing it: the world stays built, the
 * simulation stops advancing, and MATCH is re-entered on resume — which is why the edge
 * runs both ways and why PAUSED can also leave to MENU (quit) but never to SUMMARY.
 *
 * **SETTINGS is new in M8** and sits beside LOADOUT: a front-end screen with no world of its
 * own, reachable from the menu and from the pause screen, returning to whichever it came
 * from. Unlike LOADOUT it can be left straight into a match, because a player who has just
 * fixed their sensitivity should not have to walk back through two menus to use it.
 *
 * **LOADOUT is a leaf off the menu, and only that** (playtest round 4, B8). It reversed twice:
 * M11 §6.6 added `MATCH -> LOADOUT` for the warmup arena, round 2 made the editor an overlay
 * so that edge stopped costing the player their seat, and round 4 removed the edge outright.
 * The doctrine is now *the editor is a front-end screen; inside a match the only way to change
 * class is keys 1-5* — so LOADOUT is entered from MENU and leaves to MENU, and nothing else
 * is legal. This table is where that is enforced: a route added by accident throws
 * `Illegal game transition` on the frame it is taken rather than being caught by a grep.
 */
const LEGAL_TRANSITIONS: Readonly<Record<GameStateId, readonly GameStateId[]>> = {
  BOOT: ['MENU'],
  MENU: ['LOADOUT', 'SETTINGS', 'MATCH'],
  LOADOUT: ['MENU'],
  SETTINGS: ['MENU', 'MATCH', 'PAUSED'],
  MATCH: ['SUMMARY', 'MENU', 'PAUSED'],
  PAUSED: ['MATCH', 'MENU', 'SETTINGS'],
  /**
   * **SUMMARY -> MATCH is new in M10** (playtest round 2) and belongs to the dedicated server.
   *
   * In single-player the summary is terminal: the player reads it and chooses what to do next,
   * and there is nothing that could start another match without them. On a dedicated server
   * there is — the server rotates to the next map on its own clock, and it does not wait for
   * anybody's summary screen. The client is told with a second `Welcome` and has to rebuild
   * its world onto the new map from wherever it happens to be standing.
   *
   * Without this edge `Game.applyRotation` threw `Illegal game transition SUMMARY -> MATCH`
   * from inside a timer callback, the pending rotation had already been cleared, and the
   * client sat on the previous map for the whole of the next match. Which is the state leak
   * this milestone is closing, produced by the fix for it.
   */
  SUMMARY: ['MENU', 'MATCH'],
};

export function isLegalGameTransition(from: GameStateId, to: GameStateId): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalTargetsFrom(from: GameStateId): readonly GameStateId[] {
  return LEGAL_TRANSITIONS[from];
}
