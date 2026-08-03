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
  MATCH: ['SUMMARY', 'MENU', 'PAUSED'],
  PAUSED: ['MATCH', 'MENU', 'LOADOUT', 'SETTINGS'],
  SUMMARY: ['MENU', 'LOADOUT'],
};

export function isLegalGameTransition(from: GameStateId, to: GameStateId): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalTargetsFrom(from: GameStateId): readonly GameStateId[] {
  return LEGAL_TRANSITIONS[from];
}
