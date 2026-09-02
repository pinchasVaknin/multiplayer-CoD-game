import { logger } from '../../shared/core/Log';
import { InstanceState, WARMUP_MATCH_ID } from '../../shared/net/Skirmish';
import { GREYBOX_MAP } from '../../shared/world/maps/greybox';
import { ServerMatch } from '../Match';
import type { MapBakery } from '../MapBakery';
import { MatchInstance, type MatchInstanceDeps } from './MatchInstance';

const log = logger('warmup');

/**
 * The permanent skirmish arena (M11, §6.3).
 *
 * §4.9: *"The process holds **exactly one** `WarmupMatch`, from boot until shutdown. It is
 * never destroyed and never empty of purpose: it is a live skirmish arena that players drop
 * into instantly."*
 *
 * ## Why it is a range and not a lobby
 *
 * §6.3 asks for the M1 greybox room with the M2 target dummies, free-for-all rules with damage
 * live, no score and no win condition, and two to three bots. That is not a waiting room with a
 * gun bolted on — it is the shooting range this project already had, with other people in it.
 * *"Waiting for a match should feel like standing on a range, because that is what it is."*
 *
 * ## Nobody dies here, and nothing is recorded (playtest round 4, F7)
 *
 * §6.3 originally said *"damage live and instant respawn"*, and the fourth playtest changed the
 * requirement: no dying in the waiting area, and no rating or results in it. The amended clause
 * is in PLAN.md and the code says the same thing in two places, both set from `variant`:
 *
 *  - `DamageSystem.combatantsInvulnerable` — a hit on a person is resolved and reported and
 *    takes no health. **The dummies are unaffected**, because "damage live" and "players
 *    killable" turned out to be two facts wearing one flag, and the first is the one that makes
 *    this a range rather than a corridor. There is no instant respawn any more because there is
 *    nothing to respawn from.
 *  - `ScoreSystem.records` — no row, so no kills, no deaths, no accuracy and no ladder on Tab.
 *    §6.3's "no score" was built as a zeroed *limit*, which is a different claim.
 *
 * The consequence worth stating: **there is nothing to wait for here**. A player who never
 * votes and never migrates has a working game. That is what makes the flow's promise — *"click
 * Play Multiplayer, be shooting within a second"* — structurally true rather than a matter of
 * how fast allocation happens to be.
 *
 * ## Lifecycle
 *
 * `BOOTING -> RUNNING`, and there is no path to `DESTROYED` (§4.18). It survives every player
 * disconnecting and reconnecting, because it is not made of players. The one case that can
 * take it out is its own step throwing, and §4.18 is explicit that the answer there is to
 * **rebuild it in place** rather than let the process die — see `Server.onWarmupFault`.
 */

export interface WarmupOptions {
  readonly bakery: MapBakery;
  readonly snapshotHz: number;
  readonly interpolationDelayMs: number;
  readonly seed: number;
  readonly startTick: number;
  /** Bots in the arena. §6.3 asks for 2-3, so a lone player has something to shoot. */
  readonly bots: number;
}

export class WarmupMatch extends MatchInstance {
  constructor(options: WarmupOptions) {
    super(buildDeps(options));
    this.setState(InstanceState.RUNNING, 'arena is always live');
    log.info(
      `warmup arena up on ${this.match.mapEntry.name} — ` +
        `${this.match.bots.bots.length} bots, FFA rules, instant respawn.`,
    );
  }

  /**
   * A tripwire, not a policy.
   *
   * `FFA_WARMUP_CONFIG` switches both of Free-for-All's win conditions off, so this is
   * unreachable — and that is exactly why it is worth checking. An arena that reached
   * `MATCH_END` would freeze every connected player on a final banner with no rotation behind
   * it and no path out, which is the M10 bug the rotation existed to fix arriving from a new
   * direction, and it would present as *"multiplayer stopped working"* with nothing in the
   * logs. One comparison per tick buys a log line that names the cause.
   *
   * Latched, because the condition is permanent once true and an unlatched warning would emit
   * sixty lines a second for as long as the process lived.
   */
  override step(absoluteTick: number): void {
    super.step(absoluteTick);
    if (this.match.isOver && !this.warnedOver) {
      this.warnedOver = true;
      log.error(
        'the warmup arena declared a winner, which FFA_WARMUP_CONFIG should make impossible. ' +
          'The arena is now frozen for every connected player. Check FreeForAll.checkWinCondition.',
      );
    }
  }

  private warnedOver = false;
}

function buildDeps(options: WarmupOptions): MatchInstanceDeps {
  /**
   * FFA on the greybox room, with the range's dummies still standing.
   *
   * `FFA` rather than `RANGE` is the deliberate choice, and it is what §6.3 asks for: *"free-
   * for-all rules with damage live"*. `RANGE` sets `populatesRoster: false` — nobody shooting
   * back — which is right for a testbed and wrong for an arena two people are meant to duel in.
   * That is still true after F7 took the killing out of it: the bots shoot at you, they are
   * scored by nothing and they cannot be dropped, and the room is a range with company.
   *
   * The dummies survive that choice because they are **map data**, not mode data: they are
   * authored into `GREYBOX_MAP` and loaded by the shared collision loader regardless of which
   * mode is running over it. That is the M1 decision to author maps as data paying off for the
   * fourth time.
   */
  const match = new ServerMatch({
    mapId: GREYBOX_MAP.id,
    modeId: 'FFA',
    bots: options.bots,
    rosterOverride: options.bots,
    tier: 'MIX',
    seed: options.seed,
    startTick: options.startTick,
    baked: options.bakery.instanceView(GREYBOX_MAP.id),
    // Switches off FFA's kill limit and its clock. See `FFA_WARMUP_CONFIG`.
    variant: 'WARMUP',
  });

  return {
    id: WARMUP_MATCH_ID,
    // Index 0: the arena is the instance that has always existed, so it keeps the unshifted
    // snapshot phase and a live match is the one that moves out of its way.
    instanceIndex: 0,
    match,
    snapshotHz: options.snapshotHz,
    interpolationDelayMs: options.interpolationDelayMs,
    startTick: options.startTick,
  };
}
