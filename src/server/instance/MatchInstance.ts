import type { Bot } from '../../shared/ai/Bot';
import { nowMs } from '../../shared/core/Clock';
import { Btn, isDown } from '../../shared/core/InputCommand';
import { logger } from '../../shared/core/Log';
import {
  bombStateCode,
  makeSnapshotHeader,
  phaseIndex,
  SFlag,
  type SnapshotHeader,
} from '../../shared/net/Messages';
import {
  InstanceState,
  MAX_PROJECTILES,
  MAX_SMOKE,
  MAX_STREAK_ENTITIES,
  MAX_STREAK_OFFERS,
  MAX_TAGS,
  MAX_UAV_CONTACTS,
  OBJ_TEAM_A,
  OBJ_TEAM_B,
  PEFlag,
  ownerCode,
  SEFlag,
  type InstanceStateId,
  type MatchId,
  type ObjectiveState,
  type ProjectileState,
  type SmokeState,
  type StreakEntityState,
  type StreakOfferState,
  type UavContactState,
} from '../../shared/net/Skirmish';
import { ALL_EQUIPMENT, type EquipmentId } from '../../shared/equipment/EquipmentDefs';
import { hashModeState, type ModeStateFacts } from '../../shared/debug/ModeStateHash';
import { CarePackage } from '../../shared/streaks/CarePackage';
import { ChopperGunner } from '../../shared/streaks/ChopperGunner';
import type { Killstreak } from '../../shared/streaks/KillstreakBase';
import { MortarStrike } from '../../shared/streaks/MortarStrike';
import { SentryGun } from '../../shared/streaks/SentryGun';
import { STREAK_DEFS, type StreakId } from '../../shared/streaks/StreakDefs';
import { Uav } from '../../shared/streaks/Uav';
import { EFlag, makeEntitySnapshot, weaponIndexOf, type EntitySnapshot } from '../../shared/net/Snapshot';
import type { LoadoutSlot } from '../../shared/meta/Loadouts';
import type { ReclaimedSeat, ServerMatch } from '../Match';
import type { NetPlayer } from '../NetPlayer';
import type { Session } from '../net/Session';
import { SnapshotEncoder } from '../net/SnapshotEncoder';
import { InstanceClock } from './InstanceClock';

const log = logger('instance');

/**
 * One running world, and everything the process needs to talk to it (M11, §4.18).
 *
 * M10's `GameServer` was a match, a loop, a socket listener and a rotation policy in one
 * class. This is the match half, lifted out so that two of them can exist: the permanent
 * warmup arena and, when a vote resolves, one live match.
 *
 * ## What an instance owns, and what it does not
 *
 * **Owns**: a `ServerMatch` (the authoritative simulation), a per-client `SnapshotEncoder`, a
 * clock, its own lifecycle state, and the set of sessions seated in it. All of this is
 * per-instance and none of it is shared — §4.19: *"A single shared mutable object between two
 * matches is a correctness failure that will present as an unreproducible desync."*
 *
 * **Does not own**: the loop, the sockets, the routing decision, or the map bake. It is
 * stepped by the master loop, it is handed sessions by `Migration`, and its world geometry is
 * baked once at boot and shared read-only.
 *
 * ## The step is wrapped by the caller, not here
 *
 * §4.18: *"An exception inside one instance must not take down the process."* The wrapping
 * lives in `Server.tick` rather than in `step()`, because the two subclasses need different
 * recoveries — a `LiveMatch` migrates its players out and is destroyed, a `WarmupMatch` must
 * be rebuilt in place because there is nowhere to migrate anyone *to*. A base class that
 * swallowed its own exceptions would have to guess which.
 */

export interface MatchInstanceDeps {
  readonly id: MatchId;
  /** Position in the snapshot stagger (§4.19). The arena is 0; a live match is 1. */
  readonly instanceIndex: number;
  readonly match: ServerMatch;
  readonly snapshotHz: number;
  readonly interpolationDelayMs: number;
  readonly startTick: number;
}

/**
 * Why a seat is being released.
 *
 * `'migrated'` is a player who is still connected and is being seated elsewhere in the same
 * call; `'disconnected'` is a player who is gone. The bot-replacement rule in §6.7 applies to
 * exactly one of them.
 */
export type UnseatCause = 'disconnected' | 'migrated';

/** What the router needs to know about a seat without reaching into the simulation. */
export interface Seat {
  readonly session: Session;
  readonly player: NetPlayer;
}

export abstract class MatchInstance {
  readonly id: MatchId;
  readonly match: ServerMatch;
  readonly clock: InstanceClock;

  protected state_: InstanceStateId = InstanceState.BOOTING;

  /** Sessions seated in this instance, keyed by the stable connection id. */
  protected readonly seats = new Map<number, Seat>();
  private readonly encoders = new Map<number, SnapshotEncoder>();

  private readonly header: SnapshotHeader = makeSnapshotHeader();
  private readonly entities: EntitySnapshot[] = [];
  /** Reused per tick. Nothing in the per-tick send path allocates (S4.7). */
  private readonly objectiveScratch: ObjectiveState[] = [];
  private readonly streakScratch: StreakEntityState[] = [];
  private readonly contactScratch: UavContactState[] = [];
  private readonly offerScratch: StreakOfferState[] = [];
  private readonly projectileScratch: ProjectileState[] = [];
  private readonly smokeScratch: SmokeState[] = [];
  /** Whether the last projectile frame was empty. See `sendProjectiles`. */
  private projectilesWereEmpty = false;
  /** Scratch for the §7 hash. Nothing on the per-tick send path allocates (S4.7). */
  private readonly hashZones: {
    owner: number;
    capturing: number;
    progress: number;
    countA: number;
    countB: number;
  }[] = [];
  private readonly hashTagIds: number[] = [];
  private entityCount = 0;

  /** Milliseconds the last step took. Per-instance half of the §7 instance panel. */
  lastStepMs = 0;
  meanStepMs = 0;
  private stepSamples = 0;

  protected readonly deps: MatchInstanceDeps;

  constructor(deps: MatchInstanceDeps) {
    this.deps = deps;
    this.id = deps.id;
    this.match = deps.match;
    this.clock = new InstanceClock(deps.startTick, deps.snapshotHz, deps.instanceIndex);

    // Pooled per instance, per S4.7's "pool everything recurring". Sized for the largest
    // roster any mode fields plus headroom for backfill.
    for (let i = 0; i < 64; i++) this.entities.push(makeEntitySnapshot());

    // The match asks how stale each shooter's view is; the session knows, because it owns the
    // RTT estimate. The only wire between the simulation and the network layer, and it points
    // the right way — the sim asks a question, it is not told an answer.
    this.match.viewLagMsFor = (entityId) => {
      const seat = this.seatByEntity(entityId);
      if (seat === null) return 0;
      return seat.session.rttMs * 0.5 + deps.interpolationDelayMs;
    };
  }

  get state(): InstanceStateId {
    return this.state_;
  }

  /** Whether the master loop should step this instance on this tick. */
  get running(): boolean {
    return this.state_ === InstanceState.RUNNING;
  }

  get playerCount(): number {
    return this.seats.size;
  }

  get botCount(): number {
    return this.match.bots.bots.length;
  }

  /** Every seated session. Iterated by the vote cycle and by broadcast paths. */
  get sessions(): Iterable<Seat> {
    return this.seats.values();
  }

  hasPlayer(playerId: number): boolean {
    return this.seats.has(playerId);
  }

  seatOf(playerId: number): Seat | null {
    return this.seats.get(playerId) ?? null;
  }

  private seatByEntity(entityId: number): Seat | null {
    for (const seat of this.seats.values()) {
      if (seat.player.entityId === entityId) return seat;
    }
    return null;
  }

  // -- seating ---------------------------------------------------------------

  /**
   * Put a connection in this world.
   *
   * The loadout is resolved **here**, as the entity is created, which is what makes §6.6's
   * *"locked at the moment of migration, not at spawn time"* true rather than aspirational:
   * `ServerMatch.addPlayer` hands it straight to `NetPlayer`, whose constructor sets
   * `controller.speedScale` from the resolved perks. There is no window in which the player
   * exists and the perks have not been applied — which is precisely the window Tier 1 #20
   * lived in.
   *
   * `reclaim` is a returning player taking back the id and the side they left with (round 4,
   * F8). It changes nothing else about seating — the encoder is fresh, the acks are reset and
   * the next snapshot is a full one, all of which a reconnect needs anyway and all of which a
   * first join already got.
   */
  seat(session: Session, loadout: LoadoutSlot | null, reclaim?: ReclaimedSeat | null): NetPlayer | null {
    const player = this.match.addPlayer(session.displayName, loadout, reclaim);
    if (player === null) return null;
    this.seats.set(session.playerId, { session, player });
    this.encoders.set(player.entityId, new SnapshotEncoder());
    // A new encoder has no baseline, so the next snapshot to this client is a full one. Reset
    // the acks with it, or the encoder would be asked to delta against a snapshot id that
    // belonged to the instance this player just left.
    session.ackedSnapshot = 0;
    session.lastSnapshotId = 0;
    return player;
  }

  /**
   * Take a connection out of this world, leaving nothing of it behind.
   *
   * `cause` matters and is not cosmetic. A player who **disconnected** has left a side a body
   * down and, in a live match, is replaced by a bot (§6.7). A player who **migrated** is still
   * playing, one instance over, and replacing them would grow the roster by one on every cycle.
   * Only the caller can tell the two apart, so only the caller says which.
   */
  unseat(playerId: number, cause: UnseatCause = 'disconnected'): void {
    const seat = this.seats.get(playerId);
    if (seat === undefined) return;
    this.releaseEntity(seat.player.entityId, cause);
    this.encoders.delete(seat.player.entityId);
    this.seats.delete(playerId);
  }

  /**
   * Drop the simulation entity behind a seat. Overridden by `LiveMatch` to leave a bot behind.
   *
   * Split out so the subclass can substitute the removal without having to repeat the encoder
   * and seat-map bookkeeping around it — which is the half that, if forgotten, keeps a
   * destroyed instance alive through a `Seat` holding a `NetPlayer`.
   */
  protected releaseEntity(entityId: number, _cause: UnseatCause): void {
    this.match.removePlayer(entityId);
  }

  // -- the tick --------------------------------------------------------------

  /**
   * One authoritative step, plus this instance's share of the outbound traffic.
   *
   * Ordering matches M10's `GameServer.tick` and for the same reasons: simulate, then
   * snapshot (a snapshot describes the world *after* the tick), then events.
   */
  step(absoluteTick: number): void {
    const t0 = nowMs();
    this.clock.advance(absoluteTick);

    this.match.step(absoluteTick);

    /**
     * Force a snapshot on any tick that ends the stepping (handover Tier 2 §A).
     *
     * *"The sim runs at 60 Hz and snapshots go out at 20, so `shouldSnapshot` is true on one
     * tick in three. If the deciding tick is not a snapshot tick, the header carrying
     * `phase = MATCH_END` is never sent, and the client's `MatchFlow.applyReplicated` never
     * sees the transition that fires `EV.MatchEnded`."*
     *
     * Everything downstream of a match ending hangs off that event — the summary screen, the
     * announcer, the world teardown, `Game.pendingSummary` — and none of them fire. The
     * symptom reads as three separate bugs: the bots stop, the player keeps walking, no
     * summary appears, and the menu is unreachable because the client never left `MATCH`.
     * Measured at M11: 9 of 15 matches never replicated `MATCH_END`, against the 2-in-3 the
     * theory predicts; with the guard, 15 of 15.
     *
     * This did not bite at M10 because `GameServer.tick` kept ticking after `match.isOver`
     * (endHold, then rotate), so the phase always reached a snapshot tick within ~50 ms. It
     * bites here because this is exactly the flow the handover warned about: a match that ends
     * and stops stepping on the same tick.
     */
    const ending = this.state_ === InstanceState.RUNNING && this.match.isOver;
    if (this.clock.shouldSnapshot() || ending) {
      this.buildEntities();
      this.sendSnapshots(absoluteTick);
      // Objective state rides the snapshot cadence: it is world state, not an event, and a
      // client that had entities from tick N and flags from tick N-3 would draw a capture ring
      // around a body that is no longer standing in it.
      this.sendObjectives();
      this.sendTags();
      this.sendBomb();
      this.sendStreaks();
      this.sendProjectiles();
      /**
       * Last, deliberately (§7).
       *
       * Every channel above describes tick N. The hash says "this is what tick N looked like",
       * and a client can only answer it honestly once it has applied all of them. Sent earlier,
       * it would be compared against a client still holding tick N-1 and would report a
       * mismatch on every single sample.
       */
      this.sendStateHash(absoluteTick);
    }
    this.sendEvents();

    this.lastStepMs = nowMs() - t0;
    this.stepSamples++;
    // Exponential mean rather than a running average: the number that matters is what the
    // instance costs *now*, and an average over an hour of uptime cannot show a regression.
    this.meanStepMs =
      this.stepSamples === 1 ? this.lastStepMs : this.meanStepMs * 0.98 + this.lastStepMs * 0.02;
  }

  /**
   * Flatten the roster into replicable records.
   *
   * Built once per snapshot tick and shared by every client in this instance. The content is
   * the same for everyone; only the delta baseline differs. Per-recipient filtering — Ghost —
   * is applied in `sendSnapshots` against this list rather than by building it N times, so an
   * instance where nobody runs Ghost pays nothing for the feature.
   */
  private buildEntities(): void {
    let n = 0;
    for (const player of this.match.players) {
      const e = this.entities[n];
      if (e === undefined) break;
      writePlayer(e, player);
      n++;
    }
    for (const bot of this.match.bots.bots) {
      const e = this.entities[n];
      if (e === undefined) break;
      writeBot(e, bot);
      n++;
    }
    this.entityCount = n;
  }

  private sendSnapshots(tickIndex: number): void {
    const flow = this.match.flow;
    const mode = this.match.mode;

    for (const seat of this.seats.values()) {
      const { session, player } = seat;
      if (session.closed) continue;
      const encoder = this.encoders.get(player.entityId);
      if (encoder === undefined) continue;

      const h = this.header;
      h.serverTick = tickIndex;
      h.ackSeq = player.ackSeq;
      h.ackTick = player.ackTick;
      h.scoreA = mode.teamScore('A');
      h.scoreB = mode.teamScore('B');
      h.timeLeft = Math.round(flow.secondsRemaining);
      h.flags =
        (this.match.inputFrozen ? SFlag.InputFrozen : 0) | (flow.isOver ? SFlag.MatchOver : 0);
      h.starvation = player.input.takeStarvation();
      h.phase = phaseIndex(flow.currentPhase);
      h.phaseSeconds = flow.phaseSecondsRemaining;
      h.round = flow.round;

      const frame = encoder.encode(
        h,
        session.ackedSnapshot,
        // This client's own authoritative sim state, at full precision. It is compared
        // against a prediction rather than drawn, and quantisation error in a comparison is
        // indistinguishable from a misprediction.
        player.simState,
        this.entities,
        this.entityCount,
      );
      if (frame.length === 0) continue;
      session.lastSnapshotId = h.snapshotId;
      session.send(frame);
    }
  }

  /**
   * Replicate the mode's objective zones (M11 Gate B, §6.8).
   *
   * §6.8: *"The instance owns every piece of mode state; clients render what they are told and
   * hold no authoritative timers."* Domination is the case that made this necessary: the server
   * captured flags correctly all along, and the client drew its own copy — permanently neutral,
   * because a networked client's `Domination` has an empty roster and counts nobody standing on
   * anything. The flags worked and were invisible.
   *
   * Skipped entirely for a mode with no objectives, which is TDM, FFA and the arena — three of
   * the five, and the ones that would otherwise pay a frame for a message of length zero.
   */
  private sendObjectives(): void {
    const zones = this.match.mode.objectiveZones;
    if (zones.length === 0) return;

    this.objectiveScratch.length = 0;
    for (const zone of zones) {
      this.objectiveScratch.push({
        owner: ownerCode(zone.owner),
        capturing: ownerCode(zone.capturingTeam),
        // 0..1 to a byte. A flag takes several seconds to capture, so 1/255 is far finer than
        // the eye or the capture ring can show.
        progress: Math.max(0, Math.min(255, Math.round(zone.progress * 255))),
        countA: zone.countA,
        countB: zone.countB,
      });
    }

    for (const seat of this.seats.values()) {
      if (!seat.session.closed) seat.session.sendObjectives(this.objectiveScratch);
    }
  }

  /**
   * Replicate Kill Confirmed's dog tags (M11 Gate B, §6.8).
   *
   * Sent **including when the list is empty**, which is why the seam returns `null` for a mode
   * with no tags rather than an empty array: the transition from one tag to none is exactly as
   * much news as the transition from none to one, and a channel that only reported non-empty
   * lists would leave the last tag of every firefight lying on the client's floor for ever.
   *
   * Authoritative pickup is already the server's, and §6.8's *"two players reaching a tag on the
   * same tick resolves once, deterministically"* is a property of `KillConfirmed.onTick`: it
   * walks the roster in a fixed order, takes the first collector it finds and splices the tag
   * out in the same pass, so a second collector on the same tick finds nothing to collect. What
   * this adds is that the *client* no longer has an opinion — it runs no pickup test at all.
   */
  private sendTags(): void {
    const tags = this.match.mode.dogTags;
    if (tags === null) return;
    for (const seat of this.seats.values()) {
      if (!seat.session.closed) seat.session.sendTags(tags);
    }
  }

  /**
   * Replicate Search & Destroy's bomb (M11 Gate B, §6.8).
   *
   * The fuse is the reason this is not optional. §6.8: *"a client-side timer will drift and will
   * decide a round wrongly."* On a networked client it does not drift — `onTick` never runs, so
   * it does not move at all.
   */
  private sendBomb(): void {
    const info = this.match.mode.bombInfo;
    if (info === null) return;
    for (const seat of this.seats.values()) {
      if (!seat.session.closed) seat.session.sendBomb(info);
    }
  }

  /**
   * Killstreaks, per recipient (M11 Gate B, §6.8, §8.22).
   *
   * The only message in the protocol built per seat rather than broadcast, because three of its
   * four parts are private and one of them is the whole value of a killstreak.
   *
   * ## The two filters, and why they are different
   *
   * **Bodies are common.** A sentry and a care package are physical objects that both teams can
   * see, walk into and shoot. The entity list is built once and every seat gets the same one.
   *
   * **Intel is not.** A UAV's contacts go only to the team whose UAV recorded them. Broadcasting
   * them and trusting the client to ignore the other team's would put a UAV's entire value in
   * the untrusted half of the system (§4.16) — and "trust the client to not look" is precisely
   * the shape of bug a wallhack is.
   *
   * **Ghost is inside the intel filter, not beside it.** `Uav.onTick` already declines to record
   * a contact for anyone whose `visibleToUav` is false, so a Ghost player never enters this list
   * in the first place. Note what is *not* happening: their entity stays in `buildEntities` and
   * their body is drawn normally. Ghost hides you from UAV intel; it does not make you invisible,
   * and an entity filter — the obvious reading of §8.22's *"absent from the snapshot"* — would
   * ship a different perk from the one M6 designed.
   */
  private sendStreaks(): void {
    const streaks = this.match.streaks;

    // The common half, built once. Nothing here is per recipient.
    this.streakScratch.length = 0;
    for (const streak of streaks.active) {
      if (this.streakScratch.length >= MAX_STREAK_ENTITIES) break;
      this.streakScratch.push(describeStreak(streak));
    }

    for (const seat of this.seats.values()) {
      const { session, player } = seat;
      if (session.closed) continue;

      /**
       * The price list, not an inventory (round 4, B9 + B10).
       *
       * Built from `pricesFor`, which is the same accessor the ledger's own audit uses, so the
       * number on the player's HUD and the number they are charged cannot come apart. `used` is
       * read per offer rather than sent as a second list, because a price and its availability
       * are one fact about one key and splitting them is how the two get out of step.
       */
      this.offerScratch.length = 0;
      for (const priced of streaks.pricesFor(player.entityId)) {
        if (this.offerScratch.length >= MAX_STREAK_OFFERS) break;
        this.offerScratch.push({
          kind: streakKindIndex(priced.id),
          price: priced.price,
          used: streaks.usedBy(player.entityId).includes(priced.id),
        });
      }

      const next = streaks.nextFor(player.entityId);
      const uav = streaks.uavFor(player.team);

      // Only this player's team's UAV, and only the contacts it actually recorded.
      this.contactScratch.length = 0;
      if (uav !== null) {
        for (const c of uav.contacts) {
          if (!c.active) continue;
          if (this.contactScratch.length >= MAX_UAV_CONTACTS) break;
          this.contactScratch.push({
            entityId: c.entityId,
            x: c.x,
            z: c.z,
            ageCs: Math.round(c.age * 100),
          });
        }
      }

      session.sendStreaks({
        offers: this.offerScratch,
        balance: streaks.balanceOf(player.entityId),
        nextKind: next === null ? -1 : streakKindIndex(next.def.id),
        nextPrice: next?.price ?? 0,
        scrambled: streaks.minimapScrambledFor(player.team),
        sweepAngle: uav === null ? -1 : uav.sweepAngle,
        contacts: this.contactScratch,
        entities: this.streakScratch,
      });
    }
  }

  /**
   * Grenades in flight and smoke on the ground (M11 Gate B, §6.8, §8.24).
   *
   * Broadcast, unlike the streak view: a grenade is a physical object with no secrets, so there
   * is one payload and everybody gets it. What differs per client is how it is *used* — your own
   * grenade is a correction to something you predicted, everybody else's is the only copy you
   * have — and that is a decision the client makes with the entity id it already knows is its
   * own.
   *
   * Skipped entirely when nothing is in the air and no smoke is burning, which is most ticks of
   * most matches. The alternative is a two-byte frame at 20 Hz per client forever, for a message
   * whose whole content is "still nothing".
   */
  private sendProjectiles(): void {
    const pool = this.match.equipment.projectiles;
    const field = this.match.equipment.smoke;

    this.projectileScratch.length = 0;
    for (const p of pool.items) {
      if (!p.active) continue;
      if (this.projectileScratch.length >= MAX_PROJECTILES) break;
      this.projectileScratch.push({
        serial: p.serial,
        kind: equipmentKindIndex(p.def.id),
        ownerId: p.ownerId,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        flags:
          (p.resting ? PEFlag.Resting : 0) |
          (p.phase === 'ARMED' ? PEFlag.Armed : 0) |
          (p.stuckTo >= 0 ? PEFlag.Stuck : 0),
      });
    }

    this.smokeScratch.length = 0;
    for (const v of field.volumes) {
      if (!v.active) continue;
      if (this.smokeScratch.length >= MAX_SMOKE) break;
      this.smokeScratch.push({
        x: v.x,
        y: v.y,
        z: v.z,
        radius: v.radius,
        remainingDs: Math.round(v.remaining * 10),
      });
    }

    /**
     * The empty case is a real state and is sent **once**, not never.
     *
     * A client told only about non-empty frames would keep drawing the last grenade of every
     * firefight for ever — the same trap the dog tags set, and avoided the same way. So the
     * frame is skipped only while the previous one was *also* empty.
     */
    const empty = this.projectileScratch.length === 0 && this.smokeScratch.length === 0;
    if (empty && this.projectilesWereEmpty) return;
    this.projectilesWereEmpty = empty;

    for (const seat of this.seats.values()) {
      if (!seat.session.closed) {
        seat.session.sendProjectiles(this.projectileScratch, this.smokeScratch);
      }
    }
  }

  /**
   * Hash this tick's mode state and send it (§7, §8.21).
   *
   * Built from the **same quantisation the wire uses**, not from the raw simulation values: the
   * server holds a capture progress of 0.4372 and the client holds 111/255, and hashing the raw
   * number would report a divergence on every objective in the game. That is a units bug
   * dressed as a finding, and it is the first thing a comparator like this gets wrong.
   */
  private sendStateHash(tick: number): void {
    if (this.seats.size === 0) return;
    const hash = hashModeState(this.modeStateFacts());
    for (const seat of this.seats.values()) {
      if (!seat.session.closed) seat.session.sendStateHash(tick, hash);
    }
  }

  /** The authoritative mode state, flattened exactly as the channels above send it. */
  private modeStateFacts(): ModeStateFacts {
    const mode = this.match.mode;
    const flow = this.match.flow;

    this.hashZones.length = 0;
    for (const zone of mode.objectiveZones) {
      this.hashZones.push({
        owner: ownerCode(zone.owner),
        capturing: ownerCode(zone.capturingTeam),
        progress: Math.max(0, Math.min(255, Math.round(zone.progress * 255))),
        countA: Math.min(255, zone.countA),
        countB: Math.min(255, zone.countB),
      });
    }

    this.hashTagIds.length = 0;
    const tags = mode.dogTags;
    if (tags !== null) {
      // The same truncation `writeTags` applies — the newest win — so a match with more than
      // the cap on the floor hashes what was actually sent rather than what was held.
      const skip = Math.max(0, tags.length - MAX_TAGS);
      for (let i = skip; i < tags.length; i++) {
        const t = tags[i];
        if (t !== undefined) this.hashTagIds.push(t.id & 0xffff);
      }
    }

    const info = mode.bombInfo;
    return {
      scoreA: mode.teamScore('A'),
      scoreB: mode.teamScore('B'),
      round: flow.round,
      phase: phaseIndex(flow.currentPhase),
      zones: this.hashZones,
      tagIds: this.hashTagIds,
      bomb:
        info === null
          ? null
          : {
              state: bombStateCode(info.state),
              carrierId: info.carrierId,
              attackers: info.attackers === 'B' ? OBJ_TEAM_B : OBJ_TEAM_A,
              plantedSite: info.plantedSiteIndex,
              timerCs: Math.max(0, Math.min(0xffff, Math.round(info.secondsLeft * 100))),
              interactProgress: Math.max(0, Math.min(255, Math.round(info.interactFraction * 255))),
              interactEntity: info.interactEntity,
            },
    };
  }

  private sendEvents(): void {
    const frame = this.match.outgoing.finish();
    if (frame === null) return;
    for (const seat of this.seats.values()) {
      if (seat.session.closed) continue;
      seat.session.send(frame);
    }
  }

  /** Send one pre-encoded frame to everybody seated here. */
  broadcast(frame: Uint8Array): void {
    for (const seat of this.seats.values()) {
      if (!seat.session.closed) seat.session.send(frame);
    }
  }

  // -- teardown --------------------------------------------------------------

  /**
   * Release everything (§4.18).
   *
   * *"A `LiveMatch` is now created and destroyed on every cycle, so any per-match leak
   * accumulates continuously in a long-lived process."* The list §4.18 gives is: every
   * `EventBus` subscription, every timer and pending promise, object pools, snapshot buffers,
   * hitbox history ring buffers, bot brains, path caches, and every reference held by the
   * router, the session layer and the allocator.
   *
   * Most of that is reached through `ServerMatch.dispose`, which unsubscribes the match's own
   * bus handlers and disposes the flow, the score system and the bot director. What is added
   * here is the network half: the encoders (each holds a full baseline snapshot), the entity
   * pool, and the seat map — the last of which is how the *session layer* would otherwise keep
   * a destroyed instance alive through a `Seat` holding a `NetPlayer`.
   *
   * Subclasses override to add their own, and must call `super.dispose()`.
   */
  dispose(): void {
    this.match.viewLagMsFor = null;
    this.match.dispose();
    this.encoders.clear();
    this.seats.clear();
    // The pool is per instance and would otherwise be 64 live objects per destroyed match.
    this.entities.length = 0;
    this.entityCount = 0;
    this.state_ = InstanceState.DESTROYED;
  }

  protected setState(next: InstanceStateId, why: string): void {
    if (this.state_ === next) return;
    log.info(`instance ${this.id}: ${stateName(this.state_)} -> ${stateName(next)} (${why})`);
    this.state_ = next;
  }
}

function stateName(state: InstanceStateId): string {
  for (const [name, value] of Object.entries(InstanceState)) {
    if (value === state) return name;
  }
  return String(state);
}

// -- entity flattening --------------------------------------------------------
//
// Lifted verbatim from M10's `GameServer`. The only change is where it lives: an entity list
// is a property of a world, and there are two worlds now.

function writePlayer(e: EntitySnapshot, p: NetPlayer): void {
  const sim = p.controller.sim;
  const weapon = p.weapons.weapon;
  e.entityId = p.entityId;
  e.displayName = p.displayName;
  e.x = sim.x;
  e.y = sim.y;
  e.z = sim.z;
  e.yaw = sim.yaw;
  e.pitch = sim.pitch;
  e.vx = sim.vx;
  e.vz = sim.vz;
  e.stance = sim.stance;
  e.heightScale = p.rig.heightScale;
  e.health = clampByte(p.health.current);
  e.weaponIndex = weaponIndexOf(p.weapons.definition.id);
  e.flags =
    (p.alive ? EFlag.Alive : 0) |
    (isDown(p.lastButtons, Btn.Fire) ? EFlag.Firing : 0) |
    (weapon.reloading ? EFlag.Reloading : 0) |
    (weapon.adsFraction > 0.5 ? EFlag.Ads : 0) |
    (sim.sprintActive || sim.tacSprintActive ? EFlag.Sprinting : 0) |
    (sim.grounded ? EFlag.Grounded : 0) |
    (p.team === 'B' ? EFlag.TeamB : 0);
  copyVisual(e, p.visual);
}

function writeBot(e: EntitySnapshot, b: Bot): void {
  const sim = b.controller.sim;
  const weapon = b.weapons.weapon;
  e.entityId = b.entityId;
  e.displayName = b.displayName;
  e.x = sim.x;
  e.y = sim.y;
  e.z = sim.z;
  e.yaw = sim.yaw;
  e.pitch = sim.pitch;
  e.vx = sim.vx;
  e.vz = sim.vz;
  e.stance = sim.stance;
  e.heightScale = b.rig.heightScale;
  e.health = clampByte(b.health.current);
  e.weaponIndex = weaponIndexOf(b.weapons.definition.id);
  e.flags =
    (b.health.alive ? EFlag.Alive : 0) |
    (isDown(b.lastCommand.buttons, Btn.Fire) ? EFlag.Firing : 0) |
    (weapon.reloading ? EFlag.Reloading : 0) |
    (weapon.adsFraction > 0.5 ? EFlag.Ads : 0) |
    (sim.sprintActive || sim.tacSprintActive ? EFlag.Sprinting : 0) |
    (sim.grounded ? EFlag.Grounded : 0) |
    EFlag.Bot |
    (b.team === 'B' ? EFlag.TeamB : 0);
  copyVisual(e, b.visual);
}

/**
 * The M3 visual serials, verbatim.
 *
 * Directions become a single angle on the wire: a fall or a flinch only ever uses the
 * horizontal direction, so two components carrying a normalised vector is two bytes spent
 * saying what one angle says exactly.
 */
function copyVisual(
  e: EntitySnapshot,
  v: {
    deathSerial: number;
    deathDirX: number;
    deathDirZ: number;
    spawnSerial: number;
    flinchSerial: number;
    flinchDirX: number;
    flinchDirZ: number;
  },
): void {
  e.deathSerial = v.deathSerial;
  e.deathAngle = Math.atan2(v.deathDirX, v.deathDirZ);
  e.spawnSerial = v.spawnSerial;
  e.flinchSerial = v.flinchSerial;
  e.flinchAngle = Math.atan2(v.flinchDirX, v.flinchDirZ);
}

function clampByte(v: number): number {
  const i = Math.round(v);
  return i < 0 ? 0 : i > 255 ? 255 : i;
}

// -- streak flattening (M11 Gate B, §8.22) ------------------------------------

/**
 * One live streak, as the wire sees it.
 *
 * `instanceof` here rather than a virtual method on `Killstreak`, deliberately and against the
 * usual instinct. `streaks/` is shared code that knows nothing about a wire format, and putting
 * a `toNetState()` on the base class would push a networking concern into six gameplay classes
 * to save one switch in the one place that has the concern. The same reasoning that keeps
 * `EntitySnapshot` flattening in this file rather than on `NetPlayer`.
 *
 * The kinds that are pure intel or pure effect — UAV, Counter-UAV, Mortar — still send a record.
 * A UAV has no mesh, but the *fact that one is up* is what the HUD's "UAV ONLINE" banner and the
 * minimap sweep are drawn from, and an absent record cannot say that.
 */
function describeStreak(streak: Killstreak): StreakEntityState {
  const base = {
    instanceId: streak.instanceId,
    kind: streakKindIndex(streak.def.id),
    ownerId: streak.ownerId,
    team: ownerCode(streak.ownerTeam),
    yaw: 0,
    pitch: 0,
    // 255 is "cannot be shot down", which is every kind except the sentry.
    health: 255,
    fraction: 0,
    flags: SEFlag.Alive,
  };

  if (streak instanceof SentryGun) {
    return {
      ...base,
      x: streak.x,
      y: streak.y,
      z: streak.z,
      yaw: streak.turretYaw,
      pitch: streak.turretPitch,
      health: clampByte(streak.health.current),
      flags: streak.health.alive ? SEFlag.Alive | SEFlag.Landed : 0,
    };
  }

  if (streak instanceof CarePackage) {
    return {
      ...base,
      x: streak.x,
      y: streak.y,
      z: streak.z,
      fraction: clampByte(streak.claimFraction * 255),
      flags:
        SEFlag.Alive |
        (streak.landed ? SEFlag.Landed : 0) |
        (streak.claimantId >= 0 ? SEFlag.Claiming : 0),
    };
  }

  if (streak instanceof ChopperGunner) {
    return { ...base, x: streak.x, y: streak.y, z: streak.z, yaw: streak.yaw, pitch: streak.pitch };
  }

  if (streak instanceof Uav) {
    // No body. The sweep bearing rides the per-recipient half of the message, where it can be
    // withheld from the other team; this record only says a UAV is up and whose it is.
    return { ...base, x: 0, y: 0, z: 0 };
  }

  if (streak instanceof MortarStrike) {
    return { ...base, x: streak.markX, y: 0, z: streak.markZ };
  }

  // Counter-UAV, and anything added later: presence, owner and team, which is all a streak with
  // no body in the world can meaningfully say.
  return { ...base, x: 0, y: 0, z: 0 };
}

/**
 * A streak id as an index into `STREAK_DEFS`.
 *
 * An index rather than the string, for the same reason the objective channel uses one: both
 * runtimes build their table from the same module in the same order, so the index *is* the
 * identity and costs one byte where `'chopper_gunner'` costs fifteen.
 */
/** An equipment id as its index in `ALL_EQUIPMENT`. Index is identity, as everywhere else. */
function equipmentKindIndex(id: EquipmentId): number {
  const at = ALL_EQUIPMENT.findIndex((d) => d.id === id);
  return at < 0 ? 0 : at;
}

function streakKindIndex(id: StreakId): number {
  const at = STREAK_DEFS.findIndex((d) => d.id === id);
  return at < 0 ? 0 : at;
}
