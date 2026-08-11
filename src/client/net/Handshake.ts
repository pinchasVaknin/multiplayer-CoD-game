import { logger } from '../../shared/core/Log';
import { decodeHeader, writeHello, type WelcomeInfo } from '../../shared/net/Messages';
import { HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION, rejectText } from '../../shared/net/Protocol';
import type { NetConditions } from '../../shared/net/NetSim';
import { ByteReader, ByteWriter } from '../../shared/net/Wire';
import { BrowserLink } from './BrowserLink';

const log = logger('handshake');

/**
 * Open a connection and find out what match is running, *before* building a world (M10,
 * playtest round 2).
 *
 * ## The ordering bug this file exists to fix
 *
 * `MatchWorld`'s constructor loaded a map, spawned the player into it, built the match — and
 * only then dialled the server. The map it loaded came from `Game.selection`, which is the
 * *client's own menu choice*, saved in the local profile. The server's map came from the
 * `MAP` environment variable. Nothing reconciled them.
 *
 * `Welcome` has carried `mapId` and `modeId` since the protocol was written. `NetClient`
 * decoded both and stored them in two public fields, and **nothing in the client ever read
 * either one.** So the two halves quietly disagreed, and the symptoms all pointed somewhere
 * else:
 *
 * - The player spawned at coordinates chosen by the server against *its* map, which on the
 *   client's map is somewhere outside the geometry.
 * - Movement predicted against the client's colliders and was corrected against the server's,
 *   so every step produced a misprediction and a rubber-band.
 * - Walls the client could see were not in the server's world, so the player walked through
 *   them — and walls the server had were invisible.
 *
 * Every one of those reads as a netcode failure. None of them is. The netcode was doing
 * exactly what it was told with two different worlds.
 *
 * ## Why the handshake had to move out of `NetClient`
 *
 * The dependency runs in a circle: prediction needs a `PlayerController`, which needs the
 * map's `CollisionWorld`, which needs to know *which map* — which only the server can say,
 * over a connection that `NetClient` owns. Cutting it means doing the handshake on a bare
 * link first, with nothing built yet, and handing the open link and the answer to a
 * `NetClient` afterwards via `NetClient.adopt`.
 *
 * The protocol is unchanged: one `Hello` out, one `Welcome` back. This is the same exchange
 * happening thirty lines earlier.
 */

export interface HandshakeResult {
  readonly link: BrowserLink;
  readonly welcome: WelcomeInfo;
  /** When the `Welcome` landed, for seeding the clock honestly. See `NetClient.adopt`. */
  readonly receivedAtMs: number;
  /**
   * Frames that arrived **after** the `Welcome` but in the same drain.
   *
   * `BrowserLink.poll` hands the whole queue to its callback and then clears it, so anything
   * behind the `Welcome` in the same batch has already been dequeued by the time the handshake
   * resolves — and this used to drop them on the floor.
   *
   * Harmless for a fresh connect: nothing follows a `Welcome` for a client that has not asked
   * for anything yet. **A reconnect breaks that assumption**, because the server reseats a
   * returning player and sends the seat assignment immediately after, so the two land
   * microseconds apart and reliably share a batch.
   *
   * Carried out rather than discarded, and replayed into the session the moment it exists.
   * Ordinarily empty.
   */
  readonly pending: readonly Uint8Array[];
}

export interface HandshakeOptions {
  readonly url: string;
  readonly displayName: string;
  readonly conditions: NetConditions;
  readonly wantRewindDebug: boolean;
}

/**
 * A handshake that failed, with a reason fit to put on screen.
 *
 * Distinguished from a generic `Error` so the caller can tell "the server refused us" from
 * "something threw" — the first is a message for the player and the second is a bug.
 */
export class HandshakeError extends Error {
  constructor(
    message: string,
    /** True when the server answered and said no, rather than never answering. */
    readonly refused: boolean,
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

/**
 * Connect, say hello, and wait for the server to say what it is running.
 *
 * Rejects rather than resolving on every failure path, so the caller has one place to catch:
 * an unreachable host, a refused connection, a protocol mismatch, or a server that accepted
 * the socket and then said nothing.
 */
export async function handshake(options: HandshakeOptions): Promise<HandshakeResult> {
  const link = new BrowserLink(options.url, options.conditions);

  try {
    await link.open();
  } catch (err) {
    throw new HandshakeError(err instanceof Error ? err.message : String(err), false);
  }

  // The `#rw` suffix is how a client opts into the rewind debug feed without the protocol
  // growing a field only a debug panel reads. Mirrored from `NetClient.connect`.
  const name = options.wantRewindDebug ? `${options.displayName}#rw` : options.displayName;
  link.send(writeHello(new ByteWriter(256), name));

  try {
    const { welcome, receivedAtMs, pending } = await awaitWelcome(link);
    log.info(
      `server is running ${welcome.modeId} on ${welcome.mapId}; ` +
        `we are entity ${welcome.entityId} on team ${welcome.team}.`,
    );
    return { link, welcome, receivedAtMs, pending };
  } catch (err) {
    link.close('handshake failed');
    throw err;
  }
}

/**
 * Poll the link until it produces a `Welcome`, a refusal, or the deadline.
 *
 * Polled on a timer rather than the frame loop because the frame loop is not running yet —
 * this happens between leaving the menu and building the world. 16 ms is a frame's worth,
 * which keeps the join feeling immediate without spinning.
 */
function awaitWelcome(
  link: BrowserLink,
): Promise<{ welcome: WelcomeInfo; receivedAtMs: number; pending: Uint8Array[] }> {
  return new Promise((resolve, reject) => {
    const reader = new ByteReader(new Uint8Array(0));
    const startedAt = performance.now();
    let settled = false;

    /** Frames behind the `Welcome` in the same drain. See `HandshakeResult.pending`. */
    const pending: Uint8Array[] = [];

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn();
    };

    const timer = setInterval(() => {
      if (settled) return;

      if (link.state === 'closed') {
        finish(() =>
          reject(new HandshakeError(link.reason || 'the server closed the connection', true)),
        );
        return;
      }

      link.poll((bytes) => {
        /**
         * Already have the welcome: keep the rest of this batch rather than discarding it.
         *
         * Copied because `poll` clears its queue immediately after this callback returns and
         * the underlying buffers are the link's to reuse.
         */
        if (settled) {
          pending.push(bytes.slice());
          return;
        }
        reader.reuse(bytes);
        const msg = decodeHeader(reader);

        switch (msg.kind) {
          case 'welcome': {
            /**
             * The version check the server also makes, made here too.
             *
             * S6.1 wants a mismatch refused *loudly* at both ends. The server refuses a bad
             * client before decoding a gameplay byte; this refuses a bad server before
             * building a world from map and mode strings a skewed build may have renamed.
             */
            if (msg.version !== PROTOCOL_VERSION) {
              finish(() =>
                reject(
                  new HandshakeError(
                    `server speaks protocol v${msg.version}, this build speaks v${PROTOCOL_VERSION}`,
                    true,
                  ),
                ),
              );
              return;
            }
            const welcome: WelcomeInfo = {
              entityId: msg.entityId,
              team: msg.team,
              mapId: msg.mapId,
              modeId: msg.modeId,
              serverTick: msg.serverTick,
              serverMs: msg.serverMs,
              snapshotHz: msg.snapshotHz,
              // M11: which instance this seat is in, and from which tick. On a handshake the
              // answer is always the warmup arena at the current tick (§6.7 makes warmup the
              // only entry point), but it is read off the message rather than assumed — the
              // day that stops being true, an assumption here would be a client applying an
              // arena's world to a live match.
              matchId: msg.matchId,
              effectiveTick: msg.effectiveTick,
              migrated: msg.migrated,
            };
            /**
             * `settled` is set by `finish` *before* the resolve runs, so any frame still to be
             * delivered in this same `poll` batch takes the `pending` branch above rather than
             * the switch. That ordering is the whole mechanism.
             */
            const receivedAtMs = performance.now();
            finish(() => resolve({ welcome, receivedAtMs, pending }));
            return;
          }
          case 'reject':
            finish(() => reject(new HandshakeError(rejectText(msg.code), true)));
            return;
          case 'bye':
            finish(() => reject(new HandshakeError(msg.reason, true)));
            return;
          default:
          /**
           * Anything else arriving before the `Welcome` is dropped on the floor.
           *
           * In practice that is at most one snapshot, when the server's snapshot tick lands
           * between seating us and the microtask that sends the welcome. It costs nothing:
           * the encoder keeps sending *full* snapshots until the client acks one, so the
           * next one 50 ms later carries everything the dropped one did.
           */
        }
      });

      if (performance.now() - startedAt > HANDSHAKE_TIMEOUT_MS) {
        finish(() =>
          reject(new HandshakeError('the server accepted the connection but never replied', false)),
        );
      }
    }, 16);
  });
}
