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
import { Uav } from './Uav';

/**
 * Who has earned what, what is currently in the world, and the three M6 perk hooks (M7).
 *
 * ## Earning is a fold over the score, not a second tally
 *
 * `PlayerScore.streak` already counts consecutive kills and already resets on death —
 * `ScoreSystem` has done both since M4, and M6's note is explicit that the streak read out of
 * the score "includes the kill being described". So this class never counts a kill. It watches
 * `entity.killed`, reads the streak the score just recorded, and asks whether that number has
 * crossed a requirement. A second counter here would be a second answer to "what is my streak",
 * and the two would disagree the first time somebody suicided.
 *
 * "Lost on death" falls out of the same place: the score zeroes the streak, so the next kill
 * starts from one. **Earned-but-unspent streaks are also lost**, which is the CoD rule and the
 * reason `pending` is cleared on death rather than banked.
 *
 * ## The three perks
 *
 * All three M6 hooks are answered here and nowhere else:
 *
 *  - **Hardline** — `requirementFor` subtracts `streakDiscount`. Every requirement the HUD, the
 *    earn test and the debug panel see is already discounted, so nothing downstream knows.
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
  /** Kills subtracted from every requirement for this entity (Hardline). */
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
   * Earning is limited to these: six shipped streaks against three keys meant a player who
   * reached twelve kills held six things and could spend three of them. The class decides
   * which three, exactly as it decides which three perks.
   *
   * Bots have no loadout, so they get the full list and their earning is unchanged.
   */
  readonly equippedStreaks: (entityId: number) => readonly StreakId[];
}

/** Entity ids for streak-owned world objects. Above the bots' range, below nothing. */
const STREAK_ENTITY_BASE = 900;

export class StreakSystem implements ObjectiveProvider {
  /** Everything alive in the world right now. Read by the debug panel and the frame stats. */
  readonly active: Killstreak[] = [];

  /** Earned and unspent, by entity id. Cleared on death. */
  private readonly pending = new Map<number, StreakId[]>();
  /** The highest requirement each entity has already been paid for this life. */
  private readonly awardedUpTo = new Map<number, number>();

  private readonly deps: StreakSystemDeps;
  private readonly ctx: StreakContext;
  private readonly unsubscribe: Array<() => void> = [];
  private nextInstanceId = 1;
  private nextEntityIdCounter = STREAK_ENTITY_BASE;

  /** Wall time inside the last `simulate`, ms. Reported in F1 (S7). */
  lastMs = 0;

  private readonly evProgress = { entityId: 0, streak: 0, nextId: null as string | null, requirement: 0 };
  private readonly evEarned = { entityId: 0, streakId: '', name: '', requirement: 0 };
  private readonly evActivated = { entityId: 0, streakId: '', name: '', instanceId: 0 };
  private readonly evExpired = { entityId: 0, streakId: '', instanceId: 0 };

  constructor(deps: StreakSystemDeps) {
    this.deps = deps;
    this.ctx = {
      ...deps.context,
      targetable: deps.targetable,
      visibleToUav: deps.visibleToUav,
      nextEntityId: () => this.nextEntityIdCounter++,
    };
    this.subscribe();
  }

  // -- earning ---------------------------------------------------------------

  /**
   * The requirement for a streak, for this entity, after Hardline.
   *
   * Never below one: a discount that made a streak free would fire it on the first kill of
   * every life, which is not what "reduces the requirement by one" means.
   */
  requirementFor(id: StreakId, entityId: number): number {
    return Math.max(1, streakDef(id).requirement - this.deps.streakDiscount(entityId));
  }

  /** What this entity has earned and not yet spent. */
  pendingFor(entityId: number): readonly StreakId[] {
    return this.pending.get(entityId) ?? EMPTY;
  }

  /** The next streak this entity is working toward, and how many kills it needs. */
  nextFor(entityId: number): { def: StreakDef; requirement: number } | null {
    const streak = this.deps.score.row(entityId)?.streak ?? 0;
    let best: { def: StreakDef; requirement: number } | null = null;
    const equipped = this.deps.equippedStreaks(entityId);
    for (const def of STREAK_DEFS) {
      if (!equipped.includes(def.id)) continue;
      const req = this.requirementFor(def.id, entityId);
      if (req <= streak) continue;
      if (best === null || req < best.requirement) best = { def, requirement: req };
    }
    return best;
  }

  // -- spending --------------------------------------------------------------

  /**
   * Spend a pending streak.
   *
   * `x/z/yaw` is where the caller wants it — the player's own position for a sentry or a
   * package, a marked point for a mortar. Streaks that do not care ignore it.
   */
  activate(entityId: number, id: StreakId, x: number, y: number, z: number, yaw: number): Killstreak | null {
    const held = this.pending.get(entityId);
    if (held === undefined) return null;
    const index = held.indexOf(id);
    if (index < 0) return null;

    const owner = this.combatant(entityId);
    if (owner === undefined) return null;

    const streak = this.build(id, entityId, owner.team, x, y, z, yaw);
    if (streak === null) return null;

    held.splice(index, 1);
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
   * flying it is gone; the pending streaks are lost, because they are lost on death and a
   * disconnect should not be a way to bank them; and a sentry or care package they placed
   * *stays*, because those already outlive their owner's death and a placed object does not
   * care who put it there.
   */
  onOwnerRemoved(entityId: number): void {
    this.onDeath(entityId);
  }

  dispose(): void {
    this.endAll();
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.pending.clear();
    this.awardedUpTo.clear();
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
  ): Killstreak | null {
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
        // Death first: whoever died loses their unspent streaks and their progress.
        this.onDeath(p.targetId);
        if (p.sourceId === p.targetId) return;
        this.checkEarned(p.sourceId);
      }),
    );

    // A claimed care package hands its contents straight to the claimant, unearned.
    this.unsubscribe.push(
      bus.on(EV.CarePackageClaimed, (p) => {
        this.grant(p.entityId, p.streakId as StreakId);
      }),
    );

    // Nothing survives the end of a match — see the chopper's single-exit rule.
    this.unsubscribe.push(bus.on(EV.MatchEnded, () => this.endAll()));
    this.unsubscribe.push(bus.on(EV.RoundEnded, () => this.endAll()));
  }

  /**
   * Award every streak the killer's new count has just reached.
   *
   * `awardedUpTo` is what makes it "just reached" rather than "is at or above": without it a
   * player on a twelve-streak would be re-awarded the UAV on every subsequent kill.
   */
  private checkEarned(entityId: number): void {
    const row = this.deps.score.row(entityId);
    if (row === undefined) return;
    const streak = row.streak;
    const already = this.awardedUpTo.get(entityId) ?? 0;

    for (const def of STREAK_DEFS) {
      if (!this.deps.equippedStreaks(entityId).includes(def.id)) continue;
      const requirement = this.requirementFor(def.id, entityId);
      if (requirement > streak || requirement <= already) continue;
      this.grant(entityId, def.id);
      const ev = this.evEarned;
      ev.entityId = entityId;
      ev.streakId = def.id;
      ev.name = def.name;
      ev.requirement = requirement;
      this.deps.bus.emit(EV.StreakEarned, ev);
    }
    this.awardedUpTo.set(entityId, Math.max(already, streak));
    this.publishProgress(entityId, streak);
  }

  /**
   * Hand somebody a streak without earning it. Debug and verification only (S7).
   *
   * Exposed so acceptance criterion 1 can exercise activate/function/expire for all six
   * without first staging a twelve-kill streak, which would measure the score system rather
   * than the streak.
   */
  debugGrant(entityId: number, id: StreakId): void {
    this.grant(entityId, id);
  }

  private grant(entityId: number, id: StreakId): void {
    const held = this.pending.get(entityId) ?? [];
    held.push(id);
    this.pending.set(entityId, held);
    const def = streakDef(id);
    // `onEarn` belongs to the streak, but a streak that has not been built yet has nowhere to
    // put it — so the announcement is the event above and this is where a future streak with
    // an earn-time effect would be constructed. Nothing in M7 needs one.
    void def;
  }

  /** Dying costs the streak *and* everything earned but not spent. */
  private onDeath(entityId: number): void {
    this.pending.delete(entityId);
    this.awardedUpTo.delete(entityId);
    this.publishProgress(entityId, 0);

    // A chopper gunner who is shot out of their own body comes back to it. This is one of the
    // two cases acceptance criterion 2 names, and it goes through the same single exit.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const streak = this.active[i];
      if (streak instanceof ChopperGunner && streak.ownerId === entityId) this.retire(i, streak);
    }
  }

  private publishProgress(entityId: number, streak: number): void {
    if (!this.deps.reportProgressTo(entityId)) return;
    const next = this.nextFor(entityId);
    const ev = this.evProgress;
    ev.entityId = entityId;
    ev.streak = streak;
    ev.nextId = next?.def.id ?? null;
    ev.requirement = next?.requirement ?? 0;
    this.deps.bus.emit(EV.StreakProgress, ev);
  }

  private combatant(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) if (c.entityId === entityId) return c;
    return undefined;
  }
}

const EMPTY: readonly StreakId[] = [];
