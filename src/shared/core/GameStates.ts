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
 * BOOT -> MENU -> LOADOUT -> MATCH -> SUMMARY, plus the back-edges that a real
 * front end needs. M1 only ever walked BOOT -> MENU -> MATCH -> MENU; LOADOUT is
 * declared here because the shape is fixed, but it has no state handler registered
 * yet and `Game.transitionTo` will refuse to enter it with a loud error rather than
 * silently doing nothing. See PLAN.md.
 *
 * **PAUSED is new in M5** and is the fix for the M4 playtest note that Esc quit the match
 * outright. It sits beside MATCH rather than replacing it: the world stays built, the
 * simulation stops advancing, and MATCH is re-entered on resume — which is why the edge
 * runs both ways and why PAUSED can also leave to MENU (quit) but never to SUMMARY.
 *
 * **SETTINGS is new in M8** and sits beside LOADOUT: a front-end screen with no world of its
 * own, reachable from the menu and from the pause screen, returning to whichever it came
 * from. Like LOADOUT it can be left straight into a match, because a player who has just
 * fixed their sensitivity should not have to walk back through two menus to use it.
 */
const LEGAL_TRANSITIONS: Readonly<Record<GameStateId, readonly GameStateId[]>> = {
  BOOT: ['MENU'],
  MENU: ['LOADOUT', 'SETTINGS', 'MATCH'],
  LOADOUT: ['MENU', 'MATCH', 'PAUSED'],
  SETTINGS: ['MENU', 'MATCH', 'PAUSED'],
  /**
   * **MATCH -> LOADOUT is new in M11** (§6.6) and belongs to the warmup arena.
   *
   * *"There is no lobby, so Edit Class must be reachable from inside the warmup arena — the
   * same loadout editor built in M6, opened as an overlay."* The flow deliberately has no
   * static screen to put it on, so the only place left is the world itself.
   *
   * The edge is unconditional here because this table describes what is *legal*, not what is
   * *offered*: `Game` opens the editor only while the player is in the arena, never inside a
   * live match, because a class change mid-match is a different feature with different rules.
   */
  MATCH: ['SUMMARY', 'MENU', 'PAUSED', 'LOADOUT'],
  PAUSED: ['MATCH', 'MENU', 'LOADOUT', 'SETTINGS'],
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
  SUMMARY: ['MENU', 'LOADOUT', 'MATCH'],
};

export function isLegalGameTransition(from: GameStateId, to: GameStateId): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalTargetsFrom(from: GameStateId): readonly GameStateId[] {
  return LEGAL_TRANSITIONS[from];
}
