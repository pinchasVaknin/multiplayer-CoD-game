import { nowMs } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import type { WelcomeInfo } from '../shared/net/Messages';
import { metric } from './log';
import type { MatchInstance } from './instance/MatchInstance';
import type { Router } from './Router';
import type { PlayerId, Session } from './net/Session';

const log = logger('migration');

/**
 * Moving a player between instances (M11, §4.18).
 *
 * §4.18 calls this *"the piece most likely to be got wrong"* and gives five rules. Each one is
 * a line in `move` below:
 *
 * 1. **Exactly one instance on every tick.** The old seat is released and the new one created
 *    inside a single synchronous call, between two ticks of the master loop. There is no
 *    `await` in the middle, no callback, and no point at which the loop can run with the
 *    player in neither world or in both. That is not a comment on `move` — it is why `move` is
 *    synchronous when almost everything around it is not.
 * 2. **A named tick.** The seat assignment carries `effectiveTick`, and the router's answer
 *    changes on the same call, so the client and the server agree about which tick the old
 *    instance stopped mattering on.
 * 3. **The client is told explicitly**, and its obligations follow from the message: flush
 *    unacked commands, discard the prediction ring, resync the clock, clear interpolation.
 *    `NetClient.onWelcome` does all four on any seat assignment.
 * 4. **The loadout is captured and locked at migration time.** It is read from the session and
 *    handed to `seat()`, which passes it to `addPlayer` → `NetPlayer`, whose constructor sets
 *    `controller.speedScale`. The player entity does not exist before the perks are on it.
 * 5. **Failure leaves the player where they are, with a message.** Never a disconnect.
 */

export interface MigrationRecord {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly fromMatch: number;
  readonly toMatch: number;
  readonly tick: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly reason: string;
}

export class Migration {
  private readonly records: MigrationRecord[] = [];

  constructor(private readonly router: Router) {}

  /**
   * Move one connection from its current instance into `to`, on `tick`.
   *
   * Synchronous by design — see rule 1 above. Returns whether it worked; a false leaves the
   * player exactly where they were, still seated, still simulating.
   */
  move(session: Session, to: MatchInstance, tick: number, snapshotHz: number): boolean {
    const t0 = nowMs();
    const from = this.router.instanceOf(session.playerId);
    if (from === null) {
      this.record(session, -1, to.id, tick, t0, false, 'not seated anywhere');
      return false;
    }
    if (from === to) {
      // Not a failure and not worth a record: the flow can ask for this when a player joined
      // during a migration and was already put in the destination.
      return true;
    }

    /**
     * The loadout, read **now** (§4.18, §6.6, Tier 1 #20).
     *
     * Read at the top of the move rather than inside `seat`, so it is unambiguously the class
     * the player had at the moment of migration. The distinction has teeth: a `Loadout`
     * message arriving mid-move would otherwise be applied to an entity that had already been
     * created without it — which is the Lightweight divergence exactly, just narrower.
     */
    const loadout = session.loadout;

    // Release first, then seat. Both inside this call, so no tick sees the gap.
    //
    // `'migrated'`, explicitly: this player is about to be seated one instance over and is not
    // leaving anybody a body down, so the live match must not put a bot in their place (§6.7).
    // Treating a migration as a departure would add a bot on every cycle and turn §8.13's flat
    // hundred cycles into a staircase.
    this.router.release(session.playerId, 'migrated');
    const player = to.seat(session, loadout);
    if (player === null) {
      /**
       * The destination refused the seat.
       *
       * Put them back where they came from rather than leaving them nowhere. `seat` on the
       * origin is a fresh entity — the old one is gone — which means a respawn in the arena,
       * and that is the correct trade: a visible respawn beats a player who exists in no
       * world and whose commands are routed to null.
       */
      const restored = from.seat(session, loadout);
      if (restored === null) {
        log.error(
          `${session.displayName} could not be seated in ${to.id} or restored to ${from.id}. ` +
            'Closing the connection is the only remaining option.',
        );
        this.record(session, from.id, to.id, tick, t0, false, 'destination and origin both full');
        session.close('could not be seated');
        return false;
      }
      session.player = restored;
      this.router.noteMoved(session.playerId, from);
      session.sendSeat(seatInfo(from, restored.entityId, restored.team, tick, snapshotHz, true));
      session.notice('Could not join the match — staying in the arena.');
      this.record(session, from.id, to.id, tick, t0, false, 'destination full');
      return false;
    }

    session.player = player;
    this.router.noteMoved(session.playerId, to);

    /**
     * Tell the client, and tell it the tick.
     *
     * Sent after the seat exists on the server, so the first snapshot the client can possibly
     * apply from the new instance is one describing a world it has already been told about.
     * The reverse order is a client applying a snapshot whose entity ids belong to a match it
     * does not know it is in.
     */
    session.sendSeat(seatInfo(to, player.entityId, player.team, tick, snapshotHz, true));
    this.record(session, from.id, to.id, tick, t0, true, 'ok');
    return true;
  }

  /** Every migration this process has performed. The §7 migration log reads this. */
  get log(): readonly MigrationRecord[] {
    return this.records;
  }

  /**
   * Drop the oldest records once the list is long.
   *
   * A 12-hour soak (§8.30) runs roughly 720 cycles, and each migrates every connected player
   * twice. An unbounded array of records is a slow leak in the tool that exists to prove there
   * are none, which would be an embarrassing way to fail criterion 30.
   */
  private record(
    session: Session,
    fromMatch: number,
    toMatch: number,
    tick: number,
    startedMs: number,
    ok: boolean,
    reason: string,
  ): void {
    const entry: MigrationRecord = {
      playerId: session.playerId,
      displayName: session.displayName,
      fromMatch,
      toMatch,
      tick,
      durationMs: Math.round((nowMs() - startedMs) * 1000) / 1000,
      ok,
      reason,
    };
    this.records.push(entry);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);

    if (ok) {
      log.info(
        `${entry.displayName}: instance ${fromMatch} -> ${toMatch} on tick ${tick} ` +
          `in ${entry.durationMs}ms.`,
      );
    } else {
      log.warn(`${entry.displayName}: migration ${fromMatch} -> ${toMatch} failed — ${reason}.`);
    }
    metric('migration', ok ? 'moved' : 'failed', { ...entry });
  }
}

const MAX_RECORDS = 512;

function seatInfo(
  instance: MatchInstance,
  entityId: number,
  team: 'A' | 'B',
  tick: number,
  snapshotHz: number,
  migrated: boolean,
): WelcomeInfo {
  return {
    entityId,
    team,
    mapId: instance.match.mapEntry.id,
    modeId: instance.match.modeEntry.id,
    serverTick: tick,
    serverMs: nowMs(),
    snapshotHz,
    matchId: instance.id,
    effectiveTick: tick,
    migrated,
  };
}

export { seatInfo };
