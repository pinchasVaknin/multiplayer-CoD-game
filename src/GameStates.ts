/**
 * The game's top-level state vocabulary and its legal transition table.
 *
 * Lives outside Game.ts so that the EventBus payload types can reference it without
 * a circular import.
 */

export type GameStateId = 'BOOT' | 'MENU' | 'LOADOUT' | 'MATCH' | 'SUMMARY';

export const GAME_STATES: readonly GameStateId[] = ['BOOT', 'MENU', 'LOADOUT', 'MATCH', 'SUMMARY'];

/**
 * BOOT -> MENU -> LOADOUT -> MATCH -> SUMMARY, plus the back-edges that a real
 * front end needs. M1 only ever walks BOOT -> MENU -> MATCH -> MENU; LOADOUT and
 * SUMMARY are declared here because the shape is fixed, but they have no state
 * handler registered yet and `Game.transitionTo` will refuse to enter them with a
 * loud error rather than silently doing nothing. See PLAN.md.
 */
const LEGAL_TRANSITIONS: Readonly<Record<GameStateId, readonly GameStateId[]>> = {
  BOOT: ['MENU'],
  MENU: ['LOADOUT', 'MATCH'],
  LOADOUT: ['MENU', 'MATCH'],
  MATCH: ['SUMMARY', 'MENU'],
  SUMMARY: ['MENU', 'LOADOUT'],
};

export function isLegalGameTransition(from: GameStateId, to: GameStateId): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalTargetsFrom(from: GameStateId): readonly GameStateId[] {
  return LEGAL_TRANSITIONS[from];
}
