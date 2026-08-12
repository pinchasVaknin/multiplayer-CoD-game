/**
 * Who a dead player watches (M11 Gate B, §6.8).
 *
 * §6.8: *"Networked spectator flow for one-life rounds is new; M7's spectator was local."* M7's
 * version could reach into a `BotDirector` and pick a body off the roster. A networked client has
 * no roster — it has remote actors rebuilt from snapshots — so the selection has to be expressed
 * over what a client actually holds.
 *
 * ## Why the rule is a pure function
 *
 * It is the half that can be wrong in ways nobody sees until a playtest: following an enemy,
 * following a corpse, following yourself, or following nobody while living teammates are on the
 * screen. A camera cannot be asserted about headlessly — but *which entity id should I be
 * watching, given this roster* is an ordinary question with an ordinary answer, and this is that
 * question with the camera taken out of it.
 *
 * ## The rules, in order
 *
 * 1. **Never yourself.** You are the reason a spectator is needed.
 * 2. **Never an enemy.** Watching the other team through their own eyes is a wallhack with a
 *    cinematic framing, and Search & Destroy is precisely the mode where a round is decided by
 *    information. This is the rule that matters.
 * 3. **Only the living.** A corpse is a static camera pointed at the floor.
 * 4. **Lowest entity id among the candidates**, so two clients watching the same round agree, and
 *    so the choice does not flicker between two equally good targets as a `Map` reorders.
 */

export interface SpectatorCandidate {
  readonly entityId: number;
  readonly team: 'A' | 'B';
  /** Alive and participating. A body that is down is not a camera. */
  readonly alive: boolean;
}

/** No valid target. Distinct from entity 0, which is the server's empty spectator seat. */
export const NO_SPECTATOR_TARGET = -1;

/**
 * Pick a body to watch, or `NO_SPECTATOR_TARGET`.
 *
 * `preferred` is the target already being watched: it wins whenever it is still valid, so the
 * camera does not hop to a lower id the instant one respawns. Continuity is the whole reason a
 * spectator camera is watchable at all.
 */
export function pickSpectatorTarget(
  localId: number,
  localTeam: 'A' | 'B',
  candidates: Iterable<SpectatorCandidate>,
  preferred: number = NO_SPECTATOR_TARGET,
): number {
  let best = NO_SPECTATOR_TARGET;
  for (const c of candidates) {
    if (!isWatchable(c, localId, localTeam)) continue;
    if (c.entityId === preferred) return c.entityId;
    if (best === NO_SPECTATOR_TARGET || c.entityId < best) best = c.entityId;
  }
  return best;
}

/**
 * The next valid target after the one being watched, wrapping.
 *
 * Cycling is what makes this a spectator rather than a fixed camera, and wrapping by id keeps it
 * deterministic — pressing the key twice with three teammates alive returns to where it started
 * rather than walking a hash order.
 */
export function nextSpectatorTarget(
  localId: number,
  localTeam: 'A' | 'B',
  candidates: Iterable<SpectatorCandidate>,
  current: number,
): number {
  const ids: number[] = [];
  for (const c of candidates) {
    if (isWatchable(c, localId, localTeam)) ids.push(c.entityId);
  }
  if (ids.length === 0) return NO_SPECTATOR_TARGET;
  ids.sort((a, b) => a - b);

  const at = ids.indexOf(current);
  // Not currently on a valid target — start at the front rather than at an arbitrary offset.
  if (at < 0) return ids[0] ?? NO_SPECTATOR_TARGET;
  return ids[(at + 1) % ids.length] ?? NO_SPECTATOR_TARGET;
}

function isWatchable(c: SpectatorCandidate, localId: number, localTeam: 'A' | 'B'): boolean {
  if (c.entityId === localId) return false;
  if (c.team !== localTeam) return false;
  return c.alive;
}
