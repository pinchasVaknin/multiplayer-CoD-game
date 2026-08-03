/**
 * The bot state machine's vocabulary and its one transition table (brief S6.2).
 *
 * Same shape as `player/Stance.ts`, for the same reason: the legal edges live in exactly
 * one place, so "can a bot go from SUPPRESS to FLANK" has one answer and it is not
 * spread across nine `if` statements in the brain. S6.2 is explicit that there must be no
 * hidden state in scattered booleans — the corollary is that there must be no hidden
 * *transitions* either.
 *
 * Every state can die. Only DEAD can lead back to IDLE, which is what makes a respawn the
 * single door back into the machine.
 */

export const BOT_STATES = [
  'IDLE',
  'PATROL',
  'INVESTIGATE',
  'ENGAGE',
  'SUPPRESS',
  'RELOAD',
  'SEEK_COVER',
  'FLANK',
  'PUSH',
  'OBJECTIVE',
  'DEAD',
] as const;

export type BotState = (typeof BOT_STATES)[number];

/**
 * Legal edges.
 *
 *  IDLE        settling after a spawn; leaves immediately for PATROL
 *  PATROL      walking a route, looking around
 *  INVESTIGATE moving to a heard or half-seen position
 *  ENGAGE      target visible, shooting at it
 *  SUPPRESS    target lost but recent; shooting at the last known position
 *  RELOAD      magazine empty or low, ideally out of sight
 *  SEEK_COVER  moving to a scored cover point
 *  FLANK       taking a wide route to the target's side
 *  PUSH        closing on the target
 *  OBJECTIVE   walking to a flag, a bomb site or a dog tag (M7)
 *  DEAD        the fall, then the respawn timer
 */
const LEGAL: Readonly<Record<BotState, readonly BotState[]>> = {
  // RELOAD is reachable from IDLE (M7): a bot can spawn needing one, and a refused
  // transition here is a bot that never moves again. See `LOW_MAGAZINE_FRACTION`.
  IDLE: ['PATROL', 'INVESTIGATE', 'ENGAGE', 'RELOAD', 'OBJECTIVE', 'DEAD'],
  PATROL: ['IDLE', 'INVESTIGATE', 'ENGAGE', 'RELOAD', 'OBJECTIVE', 'DEAD'],
  INVESTIGATE: ['PATROL', 'IDLE', 'ENGAGE', 'SUPPRESS', 'RELOAD', 'SEEK_COVER', 'OBJECTIVE', 'DEAD'],
  ENGAGE: ['SUPPRESS', 'RELOAD', 'SEEK_COVER', 'FLANK', 'PUSH', 'INVESTIGATE', 'OBJECTIVE', 'DEAD'],
  SUPPRESS: ['ENGAGE', 'INVESTIGATE', 'RELOAD', 'SEEK_COVER', 'PUSH', 'FLANK', 'OBJECTIVE', 'DEAD'],
  RELOAD: ['ENGAGE', 'SUPPRESS', 'PATROL', 'INVESTIGATE', 'SEEK_COVER', 'PUSH', 'FLANK', 'IDLE', 'OBJECTIVE', 'DEAD'],
  SEEK_COVER: ['ENGAGE', 'SUPPRESS', 'RELOAD', 'PUSH', 'FLANK', 'INVESTIGATE', 'PATROL', 'OBJECTIVE', 'DEAD'],
  FLANK: ['ENGAGE', 'SUPPRESS', 'RELOAD', 'SEEK_COVER', 'PUSH', 'INVESTIGATE', 'PATROL', 'OBJECTIVE', 'DEAD'],
  PUSH: ['ENGAGE', 'SUPPRESS', 'RELOAD', 'SEEK_COVER', 'FLANK', 'INVESTIGATE', 'PATROL', 'OBJECTIVE', 'DEAD'],
  // OBJECTIVE can be left for anything: a bot walking to a flag that gets shot at should
  // fight, and one whose flag is taken from under it should be free to pick a new job.
  OBJECTIVE: ['ENGAGE', 'SUPPRESS', 'RELOAD', 'SEEK_COVER', 'FLANK', 'PUSH', 'INVESTIGATE', 'PATROL', 'IDLE', 'DEAD'],
  DEAD: ['IDLE'],
};

export function isLegalBotTransition(from: BotState, to: BotState): boolean {
  return from === to || LEGAL[from].includes(to);
}

export function legalBotTargets(from: BotState): readonly BotState[] {
  return LEGAL[from];
}

/** States in which the bot is trying to put rounds on something. */
export function isFiringState(state: BotState): boolean {
  return (
    state === 'ENGAGE' ||
    state === 'SUPPRESS' ||
    state === 'PUSH' ||
    state === 'FLANK' ||
    // OBJECTIVE is a firing state (M7). Without it a bot sent to a flag or a bomb walks
    // through a firefight with its trigger disabled — which is exactly what happened the
    // first time Search & Destroy ran: defenders strolled past the attackers who had just
    // planted and defused unopposed, five rounds out of five.
    state === 'OBJECTIVE'
  );
}

/** States in which the bot is following a path to somewhere specific. */
export function isTravellingState(state: BotState): boolean {
  return (
    state === 'PATROL' ||
    state === 'INVESTIGATE' ||
    state === 'SEEK_COVER' ||
    state === 'FLANK' ||
    state === 'PUSH'
  );
}
