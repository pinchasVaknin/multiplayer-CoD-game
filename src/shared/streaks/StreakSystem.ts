import { nowMs } from '../core/Clock';
import type { Combatant } from '../ai/Combatant';
import type { BotTeam } from '../ai/Combatant';
import type { ObjectiveProvider, ObjectiveTarget } from '../ai/ObjectiveIntent';
import type { ScoreSystem } from '../combat/ScoreSystem';
import { EV, type GameBus } from '../core/Events';
import type { InputCommand } from '../core/InputCommand';
import { CarePackage } from './CarePackage';
import { ChopperGunner } from './ChopperGunner';
import { CounterUav } from './CounterUav';
import { Killstreak, type StreakContext } from './KillstreakBase';
import { MortarStrike } from './MortarStrike';
import { SentryGun } from './SentryGun';
import { STREAK_DEFS, streakDef, type StreakDef, type StreakId } from './StreakDefs';
import { StreakLedger, type StreakEconomyReport, type StreakPrice } from './StreakLedger';
import { Uav } from './Uav';

/**
 * Who can afford what, what is currently in the world, and the three M6 perk hooks (M7).
 *
 * ## Kills are a currency, not a threshold (playtest round 4, B9 + B10)
 *
 * This class used to read `PlayerScore.streak` and ask whether it had *crossed* a requirement,
 * handing out an entitlement when it had. The comment here said so outright: someone who
 * reached twelve kills held six things and could spend three of them. A threshold is not a
 * price — crossing twelve opened everything costing twelve or less at once, and spending one
 * moved nothing.
 *
 * The economy is a **balance** now, and it lives in `StreakLedger`: kills accumulate,
 * activation debits the price, death zeroes the balance and clears the set of streaks already
 * bought this life. Twelve kills buys a chopper, *or* a UAV and a sentry, and not both.
 *
 * This class still never counts a kill. It folds `PlayerScore.kills` — the score stays the one
 * authority on what a kill is — but the number it folds *into* is a wallet rather than a second
 * opinion about the streak, and that separation is the point: it is what lets a care package
 * pay out and a cheat hand over thirty kills without either of them touching the scoreboard.
 *
 * ## The three perks
 *
 * All three M6 hooks are answered here and nowhere else:
 *
 *  - **Hardline** — `priceOf` subtracts `streakDiscount`. Every price the HUD, the purchase and
 *    the debug panel see is already discounted, so nothing downstream knows.
 *  - **Ghost** — handed to the UAV as `visibleToUav`.
 *  - **Cold-Blooded** — handed to the sentry (and any future streak that picks targets) as
 *    `targetable`.
 *
 * `Match` supplies both predicates, because whether an entity has a perk is a question about a
 * loadout and `streaks/` has no business knowing what a perk is.
 */

export interface StreakSystemDeps {
  readonly bus: GameBus;
  readonly score: ScoreSystem;
  readonly roster: readonly Combatant[];
  readonly context: Omit<StreakContext, 'targetable' | 'visibleToUav' | 'nextEntityId'>;
  /** Cold-Blooded. True when this entity may be targeted by a streak. */
  readonly targetable: (entityId: number) => boolean;
  /** Ghost. True when this entity shows up on a UAV sweep. */
  readonly visibleToUav: (entityId: number) => boolean;
  /** Kills subtracted from every price for this entity (Hardline). */
  readonly streakDiscount: (entityId: number) => number;
  /**
   * Whose streak progress is worth announcing (M11 Gate B).
   *
   * Was `localId: number`, which is exactly right in a browser — there is one HUD and it
   * belongs to one player — and cannot express a dedicated server, where every connected human
   * needs their own progress and none of them is "the" local one. A predicate answers both:
   * the client asks "is this me", the server asks "is this anybody I am talking to".
   */
  readonly reportProgressTo: (entityId: number) => boolean;

  /**
   * This entity's command for the current tick, or null (M11 Gate B).
   *
   * Only the Chopper Gunner reads it: a gunner flies with the same command their body would
   * have consumed. Was threaded through `simulate(tick, cmd)` as the single local player's
   * command, which on a server would have flown *every* chopper with whichever player's
   * command happened to be passed — so two gunners would have shared one stick.
   */
  readonly commandFor: (entityId: number) => InputCommand | null;
  /**
   * The three streaks this entity has equipped, in key order (M7 playtest).
   *
   * What may be bought is limited to these: six shipped streaks against three keys meant a
   * player who reached twelve kills held six things. The class decides which three, exactly as
   * it decides which three perks.
   *
   * Bots have no loadout, so they get the full list.
   */
  readonly equippedStreaks: (entityId: number) => readonly StreakId[];
}

/** Entity ids for streak-owned world objects. Above the bots' range, below nothing. */
const STREAK_ENTITY_BASE = 900;

export class StreakSystem implements ObjectiveProvider {
  /** Everything alive in the world right now. Read by the debug panel and the frame stats. */
  readonly active: Killstreak[] = [];

  /**
   * The balance, the spend and what has already been bought this life (round 4, B9 + B10).
   *
   * Replaces the two maps that were here — a list of earned entitlements and the highest
   * requirement already paid for — because neither of them was a price. See `StreakLedger`.
   */
  readonly ledger: StreakLedger;

  private readonly deps: StreakSystemDeps;
  private readonly ctx: StreakContext;
  private readonly unsubscribe: Array<() => void> = [];
  private nextInstanceId = 1;
  private nextEntityIdCounter = STREAK_ENTITY_BASE;

  /** Wall time inside the last `simulate`, ms. Reported in F1 (S7). */
  lastMs = 0;

  private readonly evProgress = { entityId: 0, streak: 0, nextId: null as string | null, requirement: 0 };
  private readonly evEarned = { entityId: 0, streakId: '', name: '', requirement: 0 };
  /** Reused by `pricesFor`, which the ledger's per-life audit calls once per closed life. */
  private readonly priceScratch: StreakPrice[] = [];
  private readonly evActivated = { entityId: 0, streakId: '', name: '', instanceId: 0 };
  private readonly evExpired = { entityId: 0, streakId: '', instanceId: 0 };

  constructor(deps: StreakSystemDeps) {
    this.deps = deps;
    this.ledger = new StreakLedger({ pricesOf: (id) => this.pricesFor(id) });
    this.ctx = {
      ...deps.context,
      targetable: deps.targetable,
      visibleToUav: deps.visibleToUav,
      nextEntityId: () => this.nextEntityIdCounter++,
    };
    this.subscribe();
  }

  // -- the wallet ------------------------------------------------------------

  /**
   * What a streak costs this entity, after Hardline.
   *
   * Never below one: a discount that made a streak free would fire it on the first kill of
   * every life, which is not what "reduces the requirement by one" means.
   *
   * Was `requirementFor`. The number is the same one `StreakDef.requirement` has always
   * carried; what changed is that it is now **charged** rather than merely reached, and a name
   * that says "requirement" while the code debits it is a name that hides the model.
   */
  priceOf(id: StreakId, entityId: number): number {
    return Math.max(1, streakDef(id).requirement - this.deps.streakDiscount(entityId));
  }

  /** Kills banked and not yet spent. The number keys 3/4/5 are spending. */
  balanceOf(entityId: number): number {
    return this.ledger.balanceOf(entityId);
  }

  /** The streaks this entity has already bought this life, and may not buy again (B10). */
  usedBy(entityId: number): readonly StreakId[] {
    return this.ledger.usedBy(entityId);
  }

  /** Everything this entity has equipped, priced. In `STREAK_DEFS` order. */
  pricesFor(entityId: number): readonly StreakPrice[] {
    const equipped = this.deps.equippedStreaks(entityId);
    const out = this.priceScratch;
    out.length = 0;
    for (const def of STREAK_DEFS) {
      if (!equipped.includes(def.id)) continue;
      out.push({ id: def.id, price: this.priceOf(def.id, entityId) });
    }
    return out;
  }

  /** Whether this entity could buy this streak right now: affordable and not yet used. */
  canAfford(entityId: number, id: StreakId): boolean {
    return this.ledger.canAfford(entityId, id, this.priceOf(id, entityId));
  }

  /**
   * The cheapest thing this entity cannot afford yet, and what it costs.
   *
   * The HUD's "6 / 8 · SENTRY" line. Read against the **balance** rather than against the
   * consecutive-kill counter, which is the whole difference between the two models: after
   * buying a UAV the line goes back up, because the money is gone.
   *
   * Streaks already bought this life are skipped — there is no progress toward one of those.
   */
  nextFor(entityId: number): { def: StreakDef; price: number } | null {
    const balance = this.ledger.balanceOf(entityId);
    let best: { def: StreakDef; price: number } | null = null;
    const equipped = this.deps.equippedStreaks(entityId);
    for (const def of STREAK_DEFS) {
      if (!equipped.includes(def.id)) continue;
      if (this.ledger.hasUsed(entityId, def.id)) continue;
      const price = this.priceOf(def.id, entityId);
      if (price <= balance) continue;
      if (best === null || price < best.price) best = { def, price };
    }
    return best;
  }

  // -- spending --------------------------------------------------------------

  /**
   * Buy a streak and put it in the world.
   *
   * `x/z/yaw` is where the caller wants it — the player's own position for a sentry or a
   * package, a marked point for a mortar. Streaks that do not care ignore it.
   *
   * **The debit is the entitlement check.** There is no separate "do they hold it" test any
   * more, because holding is no longer a thing: `charge` refuses a streak the balance cannot
   * cover and one already bought this life, and only the verdict `'ok'` moves any money. It is
   * also the only place a refusal is counted, which is why the caller asks it rather than
   * asking `canAfford` first and then charging — two questions is how a refusal goes unrecorded.
   *
   * **Whether the class carries this streak is deliberately not asked here.** It used to be
   * answered implicitly, because the pending list could only hold what had been earned; under a
   * balance there is no list, and the question moved to `Server.onStreakRequest` where the
   * other three untrusted questions already live. Keeping it here as well would have taken the
   * debug panel's "buy and use" buttons away from the three streaks a class does not carry,
   * which is acceptance criterion 1's whole instrument.
   */
  activate(entityId: number, id: StreakId, x: number, y: number, z: number, yaw: number): Killstreak | null {
    const owner = this.combatant(entityId);
    if (owner === undefined) return null;
    if (this.ledger.charge(entityId, id, this.priceOf(id, entityId)) !== 'ok') return null;

    const streak = this.build(id, entityId, owner.team, x, y, z, yaw);
    this.active.push(streak);
    streak.onActivate();

    const ev = this.evActivated;
    ev.entityId = entityId;
    ev.streakId = id;
    ev.name = streak.def.name;
    ev.instanceId = streak.instanceId;
    this.deps.bus.emit(EV.StreakActivated, ev);
    return streak;
  }

  /** The live chopper takeover, if the local player is in one. */
  activeChopperFor(entityId: number): ChopperGunner | null {
    for (const s of this.active) {
      if (s instanceof ChopperGunner && s.ownerId === entityId && !s.isRestored) return s;
    }
    return null;
  }

  // -- queries the HUD and the match ask -------------------------------------

  /** How long a UAV contact stays lit after the beam passes. Read by the minimap. */
  get contactFadeSeconds(): number {
    return this.deps.context.cfg.uavContactFadeSeconds;
  }

  /** The live UAV benefiting this team, if any. */
  uavFor(team: BotTeam): Uav | null {
    for (const s of this.active) {
      if (s instanceof Uav && s.ownerTeam === team) return s;
    }
    return null;
  }

  /** True when this team's minimap is scrambled by an enemy Counter-UAV. */
  minimapScrambledFor(team: BotTeam): boolean {
    for (const s of this.active) {
      if (s instanceof CounterUav && s.ownerTeam !== team) return true;
    }
    return false;
  }

  /** Live sentries, for the debug panel and acceptance criterion 7. */
  sentries(): SentryGun[] {
    const out: SentryGun[] = [];
    for (const s of this.active) if (s instanceof SentryGun) out.push(s);
    return out;
  }

  packages(): CarePackage[] {
    const out: CarePackage[] = [];
    for (const s of this.active) if (s instanceof CarePackage) out.push(s);
    return out;
  }

  // -- the loop --------------------------------------------------------------

  /**
   * One sim tick for every live streak.
   *
   * Iterated backwards so a streak that expires can be spliced out without the loop skipping
   * its neighbour, which is the classic version of this bug.
   */
  simulate(tick: number): void {
    const t0 = nowMs();
    for (let i = this.active.length - 1; i >= 0; i--) {
      const streak = this.active[i];
      if (streak === undefined) continue;

      // The chopper consumes its own owner's command, exactly as their body would. Asked per
      // streak rather than handed one command, so two gunners in the same match fly separately.
      if (streak instanceof ChopperGunner) {
        const cmd = this.deps.commandFor(streak.ownerId);
        if (cmd !== null) streak.step(cmd);
      }

      if (streak.onTick(tick)) continue;
      this.retire(i, streak);
    }
    this.lastMs = nowMs() - t0;
  }

  render(dt: number, alpha: number): void {
    for (const streak of this.active) streak.onRender(dt, alpha);
  }

  // -- ObjectiveProvider: care packages are contestable ----------------------

  /**
   * The best care package for this bot, or null.
   *
   * `StreakSystem` implements the same seam Domination's flags use, so a bot walks to a crate
   * with the ordinary pathing and fights on the way. `BotDirector` holds this alongside the
   * mode's provider and takes whichever offers the higher priority.
   */
  assign(bot: Combatant): ObjectiveTarget | null {
    let best: ObjectiveTarget | null = null;
    let bestD = Infinity;
    for (const streak of this.active) {
      if (!(streak instanceof CarePackage)) continue;
      const target = streak.objectiveTarget();
      if (target === null) continue;
      const d = Math.hypot(bot.px - target.x, bot.pz - target.z);
      // Not worth crossing a map for; a crate is an opportunity, not a mission.
      if (d > 30 || d >= bestD) continue;
      bestD = d;
      best = target;
    }
    return best;
  }

  onArrived(_bot: Combatant, _target: ObjectiveTarget): void {
    /* The package tests occupancy itself on every tick; arriving is the whole interaction. */
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * End everything, now.
   *
   * The chopper's single-exit rule depends on this being reachable from `MatchEnded` and from
   * `dispose`, so a takeover can never outlive the match that produced it.
   */
  endAll(): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const streak = this.active[i];
      if (streak !== undefined) this.retire(i, streak);
    }
  }

  /**
   * The owner has left the match entirely (M11 Gate B, §8.23).
   *
   * The fourth of §8.23's Chopper Gunner cases, and the one nothing covered. The other three
   * all arrive as events this class already subscribes to — `EV.EntityKilled` retires a
   * gunner's chopper, `EV.MatchEnded` and `EV.RoundEnded` end everything, and teardown goes
   * through `dispose`. A **disconnect** is none of those: no death is emitted, the match is
   * still running, and the instance is still alive. So a gunner who pulled their network cable
   * left a chopper in the sky flying on a command that would never arrive again, owned by an
   * entity id that no longer existed, crediting its kills to nobody and replicated to every
   * remaining client as a live entity until its duration ran out.
   *
   * Deliberately the **same path as death**, rather than a separate one. The rules are already
   * decided and they are the right ones here too: the chopper ends, because the player who was
   * flying it is gone; the balance is lost, because it is lost on death and a disconnect should
   * not be a way to bank it; and a sentry or care package they placed *stays*, because those
   * already outlive their owner's death and a placed object does not care who put it there.
   *
   * The ledger row goes too, which death does not do: a dead player is coming back and their
   * next life needs an anchor, a departed one is not, and a row nothing will ever fold again is
   * a leak with a life-start count attached to it.
   */
  onOwnerRemoved(entityId: number): void {
    this.onDeath(entityId);
    this.ledger.forget(entityId);
  }

  /**
   * The economy this match produced (round 4, B9). Read by the harnesses.
   *
   * Every life folded in, including the ones still open, so it can be taken mid-match and
   * taken twice. See `StreakEconomyReport` for which of its fields must be zero.
   */
  economyReport(): StreakEconomyReport {
    return this.ledger.report();
  }

  dispose(): void {
    this.endAll();
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.ledger.clear();
  }

  // -- internals -------------------------------------------------------------

  private retire(index: number, streak: Killstreak): void {
    this.active.splice(index, 1);
    streak.phase = 'EXPIRED';
    streak.onExpire();
    const ev = this.evExpired;
    ev.entityId = streak.ownerId;
    ev.streakId = streak.def.id;
    ev.instanceId = streak.instanceId;
    this.deps.bus.emit(EV.StreakExpired, ev);
  }

  private build(
    id: StreakId,
    ownerId: number,
    team: BotTeam,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): Killstreak {
    const def = streakDef(id);
    const instance = this.nextInstanceId++;
    switch (id) {
      case 'uav':
        return new Uav(def, ownerId, team, instance, this.ctx);
      case 'counter_uav':
        return new CounterUav(def, ownerId, team, instance, this.ctx);
      case 'care_package':
        return new CarePackage(def, ownerId, team, instance, this.ctx, x, z);
      case 'mortar':
        return new MortarStrike(def, ownerId, team, instance, this.ctx, x, z);
      case 'sentry':
        return new SentryGun(def, ownerId, team, instance, this.ctx, x, y, z, yaw);
      case 'chopper':
        return new ChopperGunner(def, ownerId, team, instance, this.ctx);
    }
  }

  private subscribe(): void {
    const bus = this.deps.bus;

    this.unsubscribe.push(
      bus.on(EV.EntityKilled, (p) => {
        // Death first: whoever died loses the balance and everything bought this life is
        // available again. The killer is credited afterwards, from the score's own count.
        this.onDeath(p.targetId);
        if (p.sourceId === p.targetId) return;
        this.checkEarned(p.sourceId);
      }),
    );

    /**
     * A claimed care package pays out in kills (round 4, B9).
     *
     * The crate used to hand over its contents directly, and under a currency that is the one
     * shape that breaks both rules at once: it could drop a streak the claimant has not
     * equipped, which no key indexes and no price is shown for, and it could hand back a
     * second use of a streak already bought this life. Paying the roll's price into the
     * balance keeps a single currency and a single once-per-life rule, and the gamble is
     * intact — a crate is still worth between five and twelve kills depending on the roll.
     */
    this.unsubscribe.push(
      bus.on(EV.CarePackageClaimed, (p) => {
        this.creditKills(p.entityId, this.priceOf(p.streakId as StreakId, p.entityId));
      }),
    );

    /**
     * A new life reached the world (round 4, B10).
     *
     * Subscribed for the **audit** and nothing else: the reset hangs off death, and measuring
     * it from the spawn means a life that arrived through some other door — a round start, a
     * networked spawn that emits no death — is counted rather than silently inheriting a
     * wallet. `StreakEconomyReport.dirtyLifeStarts` is that count, and it is the row P5's
     * per-life table has to decide about.
     *
     * `EV.PlayerSpawned` alone, and it covers bots too. `PlayerController.spawn` emits it and
     * **every** combatant goes through that door — `Bot.spawn` calls it at line 285 and
     * `NetPlayer.spawn` at line 240 — so `EV.BotSpawned` is a *second announcement of the same
     * spawn* carrying tier and nearest-enemy detail, not a second spawn. Listening to both
     * counted every bot life twice, which was measured before it was believed: 304 life-starts
     * against 154 actual ones in a five-bot-a-side match. That `PlayerController.spawn` is the
     * one door is also the answer P5 is looking for.
     */
    this.unsubscribe.push(bus.on(EV.PlayerSpawned, (p) => this.ledger.noteLifeStart(p.entityId)));

    /**
     * A round boundary, which under this economy is **not** a life boundary (round 4, P5).
     *
     * The decision, made explicitly rather than defaulted: a Search & Destroy survivor carries
     * their banked kills into the next round and stays blocked from re-buying a streak they
     * already spent. Only dying clears either, which is B10's wording taken literally —
     * *"until death resets it"* — and it means surviving a round is worth something.
     *
     * So the ledger is not reset here. It is only **counted**, so that the carry-overs the next
     * round's spawns will report have a number to be checked against. See
     * `StreakEconomyReport.roundCarryOvers`.
     */
    this.unsubscribe.push(bus.on(EV.RoundStarted, () => this.ledger.noteRoundBoundary()));

    // Nothing survives the end of a match — see the chopper's single-exit rule.
    this.unsubscribe.push(bus.on(EV.MatchEnded, () => this.endAll()));
    this.unsubscribe.push(bus.on(EV.RoundEnded, () => this.endAll()));
  }

  /**
   * Bank the kill and announce anything it has just made affordable.
   *
   * The credit is the score's own delta rather than a `+1` here, so a suicide and a team kill
   * — neither of which moves `PlayerScore.kills` — cannot pay for a streak, and this class
   * never has to learn the friendly-fire rule a second time.
   *
   * The announcement fires once per streak per life. It used to be "the requirement has just
   * been crossed", which under a balance would fire again every time a spend dropped the
   * balance under a price and later kills brought it back — the same streak, announced twice,
   * for a purchase the player already knows about.
   */
  private checkEarned(entityId: number): void {
    const row = this.deps.score.row(entityId);
    if (row === undefined) return;

    /**
     * A kill credited to somebody already dead is not banked (round 4, B10).
     *
     * A mutual kill is two `EntityKilled` events in one tick, and in one of the two orders the
     * loser's own death is processed first: `onDeath` zeroes the wallet, and then the kill they
     * landed on the way down credits it again — a balance carried into the next life, which is
     * the exact thing the reset exists to prevent. Measured at 1 dirty life-start in 152 before
     * this guard, which is the shape a rare ordering has.
     *
     * The anchor still moves, because the score has counted the kill and always will: leaving
     * it behind would bank the same kill into the next life instead, one life later and
     * invisible. An entity that is not on the roster at all is credited as before — a streak it
     * cannot spend does no harm, and the alternative is a lookup failure quietly starving
     * everybody.
     */
    if (this.combatant(entityId)?.health.alive === false) {
      this.ledger.discardKills(entityId, row.kills);
      return;
    }
    if (this.ledger.foldKills(entityId, row.kills) === 0) return;

    const balance = this.ledger.balanceOf(entityId);
    for (const def of STREAK_DEFS) {
      if (!this.deps.equippedStreaks(entityId).includes(def.id)) continue;
      const price = this.priceOf(def.id, entityId);
      if (price > balance) continue;
      if (this.ledger.hasUsed(entityId, def.id)) continue;
      if (this.ledger.hasAnnounced(entityId, def.id)) continue;
      this.ledger.noteAnnounced(entityId, def.id);
      const ev = this.evEarned;
      ev.entityId = entityId;
      ev.streakId = def.id;
      ev.name = def.name;
      ev.requirement = price;
      this.deps.bus.emit(EV.StreakEarned, ev);
    }
    this.publishProgress(entityId);
  }

  /**
   * Put kills in somebody's wallet without their scoring them. Debug and verification (S7).
   *
   * Exposed so acceptance criterion 1 can exercise activate/function/expire for all six
   * without first staging a twelve-kill streak, which would measure the score system rather
   * than the streak. Credits the **price** of the named streak rather than handing the streak
   * over, because after B9 there is nothing to hand over: the harness's "give them a chopper"
   * is "give them what a chopper costs", and everything downstream of that is shipping code.
   */
  debugGrant(entityId: number, id: StreakId): void {
    this.creditKills(entityId, this.priceOf(id, entityId));
  }

  /**
   * Pay kills into a wallet — the one door for everything that is not a scored kill.
   *
   * Public since round 4's F14, which is the third caller and the one the door was named for:
   * `MO951357` grants thirty kills of purchasing power without touching the scoreboard, and it
   * is implementable *because* the balance is credited from `PlayerScore.kills` rather than read
   * out of it. A model that derived the balance from the score could not have honoured that code
   * without a compensating deduction in the match results.
   *
   * Applies the same aliveness rule `checkEarned` does, and for the same reason: a wallet
   * belongs to a life, so a credit aimed at somebody who is already dead is dropped rather than
   * waiting there for their next one. Measured — the skirmish harness's repeating top-up pays
   * every seat including the dead ones, and without this it put 3 life-starts in 101 on the
   * wrong side of `dirtyLifeStarts`.
   */
  creditKills(entityId: number, kills: number): void {
    if (this.combatant(entityId)?.health.alive === false) {
      this.ledger.dropCredit(kills);
      return;
    }
    this.ledger.credit(entityId, kills);
    this.publishProgress(entityId);
  }

  /**
   * Dying zeroes the balance and clears what was bought this life.
   *
   * Both halves of the report: B9's "everything earned but not spent is lost", which was
   * already the rule, and B10's "until death resets it", which is new and is what stops one
   * life buying the same streak twice.
   */
  private onDeath(entityId: number): void {
    this.ledger.resetLife(entityId, this.deps.score.row(entityId)?.kills ?? 0);
    this.publishProgress(entityId);

    // A chopper gunner who is shot out of their own body comes back to it. This is one of the
    // two cases acceptance criterion 2 names, and it goes through the same single exit.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const streak = this.active[i];
      if (streak instanceof ChopperGunner && streak.ownerId === entityId) this.retire(i, streak);
    }
  }

  /** The balance and what it is short of. `streak` on the event is the balance now. */
  private publishProgress(entityId: number): void {
    if (!this.deps.reportProgressTo(entityId)) return;
    const next = this.nextFor(entityId);
    const ev = this.evProgress;
    ev.entityId = entityId;
    ev.streak = this.ledger.balanceOf(entityId);
    ev.nextId = next?.def.id ?? null;
    ev.requirement = next?.price ?? 0;
    this.deps.bus.emit(EV.StreakProgress, ev);
  }

  private combatant(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) if (c.entityId === entityId) return c;
    return undefined;
  }
}
