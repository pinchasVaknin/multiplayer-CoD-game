import { randomBytes } from 'node:crypto';
import { nowMs } from '../../shared/core/Clock';
import { logger } from '../../shared/core/Log';
import type { LoadoutSlot } from '../../shared/meta/Loadouts';
import type { MatchId } from '../../shared/net/Skirmish';
import { RECONNECT_GRACE_MS, RECONNECT_TOKEN_BYTES } from '../../shared/net/Protocol';
import type { PlayerId } from './Session';

const log = logger('reconnect');

/**
 * Seats held open for players who have dropped (M11 Gate B, playtest round 4, F8).
 *
 * F8 asks for *"reconnect and joining a match that is already running, after a disconnect"*, and
 * the thing that was missing was never the machinery — a returning client is seated, resynced
 * and simulated by code that has worked since M10. What was missing is that **nothing connected
 * the two connections**. A `Hello` carried a name and a class, neither of which identifies
 * anybody, so a player who came back was a stranger: a new `playerId`, a new entity, a new
 * scoreboard row, and a seat in the arena while their kills sat on the live match's board
 * attributed to a bot.
 *
 * This is the missing link and nothing else. It holds no simulation state, owns no entity and
 * decides nothing about the world: it maps *a secret this client was given* onto *the seat it
 * had*, for a bounded time, and the caller does the seating.
 *
 * ## What a reservation is worth, and to whom
 *
 * The token is a **bearer capability**. Anyone holding one takes the seat, so three properties
 * carry the whole of its security and each is a line below:
 *
 * 1. **It cannot be guessed.** 128 bits from `randomBytes`, never derived from a name, a
 *    `playerId`, a tick or a counter. See `RECONNECT_TOKEN_BYTES`.
 * 2. **A live session's token opens nothing.** A reservation is created in `onLeave` and
 *    nowhere else, so while a player is connected there is no entry to match — a stolen token
 *    cannot evict somebody who is still playing. That is a property of *when* entries exist
 *    rather than a check anybody has to remember to write.
 * 3. **It is good exactly once.** `claim` deletes the entry it returns, and the returning
 *    connection mints a fresh token of its own. A token that has been redeemed, or observed and
 *    replayed later, matches nothing.
 *
 * Lookup is a `Map.get` on the hex form rather than a byte-by-byte comparison, which is what
 * keeps it free of a timing side channel without a constant-time routine somebody would
 * eventually forget to use.
 *
 * ## Why only a running live match reserves anything
 *
 * A drop from the **arena** reserves nothing, deliberately. Since round 4's F7 the arena records
 * no score at all (`ScoreSystem.records` is false there), holds no objective state and hands
 * every arrival an instant seat — so there is nothing about an arena seat that a fresh join does
 * not give back for free, and reserving one would be a map entry protecting nothing. What that
 * buys is a bound: **the registry can only ever hold as many entries as the live match has had
 * players**, and every one of them dies with that instance. `forgetMatch` is called from the
 * teardown, so a hundred allocate/destroy cycles leave it empty rather than a hundred entries
 * deep — which is the thing §8.13's leak run would otherwise notice.
 *
 * ## Expiry is evaluated on the way in, not by a timer
 *
 * An entry past its deadline stays in the map until somebody asks for it. That is what makes
 * *"your seat was held and the grace ran out"* distinguishable from *"I have never seen this
 * token"* — and those deserve different answers, because the first is worth telling the player
 * and the second is an ordinary join with nothing to say. A sweeping timer would delete the
 * evidence that the distinction rests on, and would need a second structure to remember it.
 */
export interface Reservation {
  /** The connection that left. Kept for the log, so a return can be tied to a departure. */
  readonly playerId: PlayerId;
  readonly displayName: string;
  /** The instance the seat is in. Resolved at claim time — the instance may be gone by then. */
  readonly matchId: MatchId;
  /**
   * The entity id to give back, and the reason the whole thing works.
   *
   * `ServerMatch.nextPlayerId` only ever increments, so an id that has been handed out is never
   * handed out again inside that instance — a reserved id cannot collide with a later joiner
   * however long the reservation is held. It is also the key to everything else the player
   * wants back: `ScoreSystem` rows, `Rewind` history and the equipment hand are all keyed by it,
   * so reclaiming the id reclaims the record by construction rather than by copying it about.
   */
  readonly entityId: number;
  /**
   * The side they were on.
   *
   * Reserved as well as the id, because `ServerMatch.addPlayer` balances new arrivals onto the
   * smaller team — so a returning player who was merely re-seated could come back on the other
   * side. In Search & Destroy that is not a cosmetic difference: it is a spawn inside the
   * enemy's half, which is an exploit rather than a reconnect.
   */
  readonly team: 'A' | 'B';
  /** The class they were playing, so the body is rebuilt with the perks it had (Tier 1 #20). */
  readonly loadout: LoadoutSlot | null;
  /** When the grace expires. Compared at claim time; see the note above about sweeping. */
  readonly expiresAtMs: number;
}

/** The registry in five numbers. See `ReconnectRegistry.stats`. */
export interface ReconnectStats {
  readonly held: number;
  readonly reserved: number;
  readonly claimed: number;
  readonly expired: number;
  readonly unknown: number;
}

/** Why a claim did not produce a seat. Each one is a different thing to tell the player. */
export type ClaimFailure = 'unknown' | 'expired';

export type ClaimResult =
  | { readonly ok: true; readonly reservation: Reservation }
  | { readonly ok: false; readonly why: ClaimFailure };

export class ReconnectRegistry {
  private readonly byToken = new Map<string, Reservation>();

  /** Reservations made, claimed, and refused for each reason. The §7 numbers. */
  reserved = 0;
  claimed = 0;
  expiredClaims = 0;
  unknownClaims = 0;

  /** How many seats are being held right now, expired ones included. Watched by the leak run. */
  get size(): number {
    return this.byToken.size;
  }

  /**
   * One line of numbers, for §7 and for the harness.
   *
   * `held` is the one to read after a run: it is the registry's whole footprint, and it must
   * come back to zero once the live match it belongs to is gone. Every other field is a
   * denominator for it — a `held` of zero out of zero reservations is a probe that never fired,
   * which is the same shape every other counter in this project carries its denominator for.
   */
  get stats(): ReconnectStats {
    return {
      held: this.byToken.size,
      reserved: this.reserved,
      claimed: this.claimed,
      expired: this.expiredClaims,
      unknown: this.unknownClaims,
    };
  }

  /**
   * A fresh capability for one connection.
   *
   * `randomBytes` rather than `Math.random`: the latter is seeded, predictable from a handful of
   * outputs, and would make every seat on the server claimable by anybody who watched a few
   * connections. This is the one place in the project where that difference is a security
   * property rather than a preference.
   */
  mint(): Uint8Array {
    return new Uint8Array(randomBytes(RECONNECT_TOKEN_BYTES));
  }

  /**
   * Hold this seat for whoever holds this token, until the grace expires.
   *
   * Called from `onLeave`, and only for a seat in a running live match — see the class comment
   * for why an arena seat reserves nothing.
   */
  reserve(token: Uint8Array, seat: Omit<Reservation, 'expiresAtMs'>): void {
    const key = keyOf(token);
    if (key === null) return;
    this.byToken.set(key, { ...seat, expiresAtMs: nowMs() + RECONNECT_GRACE_MS });
    this.reserved++;
    log.info(
      `holding entity ${seat.entityId} on team ${seat.team} in match ${seat.matchId} for ` +
        `${seat.displayName} (player ${seat.playerId}) — ${RECONNECT_GRACE_MS}ms of grace.`,
    );
  }

  /**
   * Redeem a token, or say why not.
   *
   * Consumes the entry on every outcome that names one, expiry included: a grace that has run
   * out is over, and leaving the entry behind would let a client retry it until the match ended.
   */
  claim(token: Uint8Array | null): ClaimResult {
    const key = keyOf(token);
    if (key === null) {
      this.unknownClaims++;
      return { ok: false, why: 'unknown' };
    }
    const found = this.byToken.get(key);
    if (found === undefined) {
      this.unknownClaims++;
      return { ok: false, why: 'unknown' };
    }
    this.byToken.delete(key);
    if (nowMs() > found.expiresAtMs) {
      this.expiredClaims++;
      log.info(
        `${found.displayName} (player ${found.playerId}) came back for entity ${found.entityId} ` +
          'after the grace had expired — they join as a new player.',
      );
      return { ok: false, why: 'expired' };
    }
    this.claimed++;
    return { ok: true, reservation: found };
  }

  /**
   * Drop every reservation naming an instance that no longer exists.
   *
   * Called from the live match's teardown, which is what bounds this map: a seat in a destroyed
   * world is not a seat, so an entry that outlived its instance could never be redeemed and
   * would only ever be a row nobody deletes. §8.13 counts subscriptions and heap over a hundred
   * cycles, and a map that grew by one entry per player per match is exactly the shape it exists
   * to catch.
   */
  forgetMatch(matchId: MatchId): void {
    let dropped = 0;
    for (const [key, held] of this.byToken) {
      if (held.matchId !== matchId) continue;
      this.byToken.delete(key);
      dropped++;
    }
    if (dropped > 0) {
      log.info(`match ${matchId} is gone — released ${dropped} held seat(s).`);
    }
  }

  /** Everything, for a shutdown. */
  clear(): void {
    this.byToken.clear();
  }
}

/**
 * A token as a map key, or null if it is not one.
 *
 * Hex rather than the array itself, because a `Map` keyed on `Uint8Array` compares by reference
 * and would never match a token that has been round-tripped through the wire. The length check
 * is here rather than at the call sites so there is one definition of what a token *is*.
 */
function keyOf(token: Uint8Array | null | undefined): string | null {
  if (token == null || token.length !== RECONNECT_TOKEN_BYTES) return null;
  let out = '';
  for (const b of token) out += b.toString(16).padStart(2, '0');
  return out;
}
