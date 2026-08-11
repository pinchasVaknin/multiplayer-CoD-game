import { logger } from '../shared/core/Log';
import type { MatchId } from '../shared/net/Skirmish';
import type { MatchInstance } from './instance/MatchInstance';
import type { PlayerId, Session } from './net/Session';

const log = logger('router');

/**
 * Which instance each connection belongs to, and the only answer to that question (M11, §4.18).
 *
 * §4.18: *"A player belongs to **exactly one instance on every tick**. Never zero, never two.
 * There is no intermediate state where a player is 'between' instances."*
 *
 * That invariant needs a single owner or it is not an invariant. Membership is recorded here
 * and nowhere else: `MatchInstance.seats` holds the *seat* (the entity, the encoder), but this
 * map decides who is where, and `move` is the only thing that writes both. A second place that
 * could disagree — a flag on the session, a lookup that scans both instances — is how a player
 * ends up simulated in one world and sent snapshots from another.
 *
 * ## Rejecting a message for an instance the sender is not in
 *
 * §8.15 asks for this explicitly. It is not a hypothetical: a client that is mid-migration has
 * a `Prepare` for match 3 and a seat in match 0, and a stale `Ready` for a match that has
 * already been destroyed is the ordinary case rather than an attack. Both are refused the same
 * way — counted, logged at debug volume, and dropped — because the server cannot tell a
 * confused client from a hostile one and does not need to.
 */
export class Router {
  private readonly byPlayer = new Map<PlayerId, MatchInstance>();

  /** Messages refused because their target instance was not the sender's. §8.15's number. */
  misroutedMessages = 0;

  /**
   * Put a connection into an instance for the first time.
   *
   * Distinct from `move` because there is no old instance to unseat from, and because a join
   * that silently succeeded when the player was already somewhere would break the invariant
   * quietly rather than loudly.
   */
  admit(session: Session, instance: MatchInstance): void {
    const existing = this.byPlayer.get(session.playerId);
    if (existing !== undefined) {
      log.error(
        `admit(${session.playerId}) but they are already in instance ${existing.id}. ` +
          'This is the "never two" half of the migration invariant; treating it as a move.',
      );
      this.release(session.playerId);
    }
    this.byPlayer.set(session.playerId, instance);
  }

  /**
   * Take a connection out of whatever instance holds it.
   *
   * Idempotent: a disconnect during a migration can reach here twice, from the session's
   * `onLeave` and from the migration's own cleanup, and the second should be a no-op rather
   * than an error.
   */
  release(playerId: PlayerId): void {
    const instance = this.byPlayer.get(playerId);
    if (instance === undefined) return;
    instance.unseat(playerId);
    this.byPlayer.delete(playerId);
  }

  /** The instance a connection is in, or null. The single source of truth. */
  instanceOf(playerId: PlayerId): MatchInstance | null {
    return this.byPlayer.get(playerId) ?? null;
  }

  /**
   * Record a completed move.
   *
   * Called by `Migration` **after** the new seat exists, so there is no tick on which the map
   * points at an instance the player has no entity in. The old seat is released first only in
   * the sense that `Migration` has already done it — this method does not unseat, precisely so
   * that the "never zero" window cannot open inside it.
   */
  noteMoved(playerId: PlayerId, to: MatchInstance): void {
    this.byPlayer.set(playerId, to);
  }

  /**
   * May this connection act on this instance?
   *
   * The gate for `Ready` and for anything else addressed to a specific match. Returns false and
   * counts a misroute when the answer is no.
   */
  mayAddress(session: Session, matchId: MatchId): boolean {
    const instance = this.byPlayer.get(session.playerId);
    if (instance !== null && instance !== undefined && instance.id === matchId) return true;
    this.misroutedMessages++;
    log.warn(
      `${session.displayName} (player ${session.playerId}) addressed instance ${matchId} ` +
        `while seated in ${instance?.id ?? 'none'} — rejected.`,
    );
    return false;
  }

  /** Everybody currently in an instance. Used by the shutdown path and by the panels. */
  get playerCount(): number {
    return this.byPlayer.size;
  }
}
