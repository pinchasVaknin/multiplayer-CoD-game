import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import type { HitZone } from '../combat/HitboxRig';
import type { ScoreSystem } from '../combat/ScoreSystem';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import type { PlayerSim } from '../player/PlayerState';
import type { WeaponClass } from '../weapons/WeaponDefs';
import { WEAPON_DEFS } from '../weapons/WeaponDefs';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { CamoId } from './Camos';
import { ChallengeTracker } from './ChallengeTracker';
import {
  MULTIKILL_WINDOW,
  SLIDE_KILL_GRACE,
  type KillFact,
  type MatchFact,
} from './Challenges';
import { levelForXp } from './Levels';
import type { Profile } from './Profile';
import { weaponLevelForXp } from './Unlocks';
import {
  emptyXpReport,
  LONGSHOT_METRES,
  WEAPON_XP_FRACTION,
  xpSource,
  XP_SOURCES,
  type XpLine,
  type XpReport,
  type XpSourceId,
} from './XpRules';

/**
 * One match's worth of progression, accumulated in memory and banked once at the end.
 *
 * This is the only thing in `meta/` that touches the EventBus, and everything it does is
 * counting. That is the shape acceptance criterion 9 requires: the sim path gains six
 * subscriptions that increment integers and one per-tick `sample` that writes eight
 * fields, and **nothing here writes to storage, allocates per event, or can change what a
 * match does**. The profile is touched exactly once, from `finish`.
 *
 * The interesting work is `buildKillFact`. "Kills after sliding" and "one-magazine
 * multikills" are questions no single system can answer — the stance is in `PlayerSim`,
 * the magazine is in `Weapon`, the range is in the `damage.dealt` that preceded the kill,
 * and the streak is in `ScoreSystem` — so the fact is assembled here, once, and thirty
 * challenge predicates are tested against it.
 *
 * **Subscription order is load-bearing.** `MatchFlow` subscribes to `entity.killed` in
 * `Match`'s constructor and this class subscribes after it, so by the time the handler
 * below runs, the mode has already called `ScoreSystem.recordKill` and the streak read out
 * of the score row is the streak *including* this kill. `EventBus` dispatches in
 * subscription order, and that is what keeps the streak a single tally rather than a
 * private copy that could drift.
 */

/** Blast profiles carry their own weapon ids; a kill from one is an equipment kill. */
const EQUIPMENT_WEAPON_PREFIX = 'eq_';

/** Kills remembered for the multikill window. Nothing in this game exceeds four. */
const KILL_RING = 8;

export interface MatchProgressionDeps {
  readonly bus: GameBus;
  readonly profile: Profile;
  readonly score: ScoreSystem;
  readonly tracker: ChallengeTracker;
}

/** Per-weapon deltas, accumulated for the match and folded into the save at the end. */
interface WeaponTally {
  kills: number;
  headshots: number;
  longshots: number;
  multikills: number;
  shotsFired: number;
  shotsHit: number;
  longestShot: number;
  timeUsed: number;
  xp: number;
}

function makeTally(): WeaponTally {
  return {
    kills: 0,
    headshots: 0,
    longshots: 0,
    multikills: 0,
    shotsFired: 0,
    shotsHit: 0,
    longestShot: 0,
    timeUsed: 0,
    xp: 0,
  };
}

const evXp = { total: 0, xpBefore: 0, xpAfter: 0 };
const evLevel = { level: 1, prestige: 0, unlockCount: 0 };
const evChallenge = { id: '', name: '', xp: 0, camo: null as string | null };
const evCamo = { camoId: '', name: '' };

export class MatchProgression {
  /** Per-source counts, keyed by XP source. Read by the summary. */
  private readonly counts = new Map<XpSourceId, number>();
  private readonly weaponTallies = new Map<string, WeaponTally>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly killTicks: number[] = new Array<number>(KILL_RING).fill(-99999);
  private killRingHead = 0;

  private readonly deps: MatchProgressionDeps;

  // ---- context sampled once per tick, so a kill can be described ------------
  private heldWeaponId = '';
  private heldWeaponClass: WeaponClass = 'AR';
  private adsFraction = 0;
  private sliding = false;
  private airborne = false;
  private sinceSlide = 999;
  private tick = 0;

  // ---- kill context --------------------------------------------------------
  /** Range of the most recent damage the local player dealt, metres. */
  private lastDamageDistance = 0;
  private lastDamageTarget = -1;
  private killsThisMag = 0;
  private lastKilledBy = -1;

  private objectives = 0;
  private finished = false;

  constructor(deps: MatchProgressionDeps) {
    this.deps = deps;
    const bus = deps.bus;

    this.unsubscribe.push(
      bus.on(EV.WeaponFired, (p) => {
        if (p.sourceId !== PLAYER_ENTITY_ID) return;
        const tally = this.tally(p.weaponId);
        tally.shotsFired += p.pellets;
        tally.shotsHit += p.pelletsHit;
      }),
      bus.on(EV.DamageDealt, (p) => {
        if (p.sourceId !== PLAYER_ENTITY_ID) return;
        this.lastDamageDistance = p.distance;
        this.lastDamageTarget = p.targetId;
        const tally = this.tally(p.weaponId);
        if (p.distance > tally.longestShot) tally.longestShot = p.distance;
      }),
      bus.on(EV.EntityKilled, (p) => this.onKilled(p.sourceId, p.targetId, p.weaponId, p.zone)),
      bus.on(EV.EquipmentFlashed, (p) => {
        if (p.sourceId !== PLAYER_ENTITY_ID || p.targetId === PLAYER_ENTITY_ID) return;
        deps.tracker.onFlash();
      }),
      bus.on(EV.WeaponReloadFinished, (p) => {
        if (p.sourceId === PLAYER_ENTITY_ID) this.killsThisMag = 0;
      }),
      bus.on(EV.WeaponSwapped, (p) => {
        if (p.sourceId === PLAYER_ENTITY_ID) this.killsThisMag = 0;
      }),
      bus.on(EV.PlayerSpawned, (p) => {
        if (p.entityId === PLAYER_ENTITY_ID) this.killsThisMag = 0;
      }),
    );
  }

  /**
   * One sim tick of context.
   *
   * Eight field writes and one `Map.get`, both on keys that already exist after the first
   * tick — allocation free in the steady state, which is what S4.7 asks of anything on
   * this path.
   */
  sample(sim: PlayerSim, weapons: WeaponSystem, tickIndex: number): void {
    this.tick = tickIndex;
    const def = weapons.definition;
    this.heldWeaponId = def.id;
    this.heldWeaponClass = def.class;
    this.adsFraction = weapons.weapon.adsFraction;
    this.sliding = sim.slideActive;
    this.airborne = !sim.grounded && !sim.slideActive;
    this.sinceSlide = sim.slideActive ? 0 : Math.min(999, this.sinceSlide + DT);
    this.tally(def.id).timeUsed += DT;
  }

  /**
   * An objective was scored (S6.1's 200/objective).
   *
   * No mode in this build emits one — TDM has none and S9 defers the modes that do — so
   * the only callers are the XP simulator and the verification script. The path is real
   * and measured rather than speculative, and M7's Domination should call it from
   * `onCapture`. See PLAN.md, "problems found in the brief".
   */
  noteObjective(count = 1): void {
    this.objectives += count;
  }

  /** Live totals, for the F1 read-out. */
  get liveXp(): number {
    return this.totalFrom(this.buildLines(false, false, 0));
  }

  get killCount(): number {
    return this.counts.get('kill') ?? 0;
  }

  /**
   * Close the match: fold everything into the profile and produce the summary's report.
   *
   * Idempotent. `Game` reaches SUMMARY from the render pass one frame after the mode
   * declared the match over, and a harness that ends two matches back to back must not be
   * able to bank one twice.
   */
  finish(won: boolean, isMvp: boolean): XpReport {
    if (this.finished) return emptyXpReport();
    this.finished = true;

    const profile = this.deps.profile;
    const row = this.deps.score.row(PLAYER_ENTITY_ID);
    const bestStreak = row?.bestStreak ?? 0;

    // Match-level challenges are evaluated before the XP lines are built, so a challenge
    // completed by the final scoreline pays out in the same summary that shows it.
    const fact: MatchFact = {
      won,
      kills: row?.kills ?? 0,
      deaths: row?.deaths ?? 0,
      score: row?.score ?? 0,
      bestStreak,
    };
    this.counts.set('assist', row?.assists ?? 0);
    if (this.objectives > 0) this.counts.set('objective', this.objectives);
    this.deps.tracker.onMatchEnd(fact);

    // Weapon levels are banked before the XP lines are built for the same reason: a
    // weapon that levelled up on the last kill of the match should say so.
    const weaponLevelUps = this.applyWeaponTallies();
    this.counts.set('weaponLevel', weaponLevelUps.length);
    // The challenge row counts *challenges*, not XP: its total is the sum of what each one
    // awarded, which `buildLines` reads separately. Storing the XP here instead printed
    // "Challenges x100" for a single 100 XP completion.
    this.counts.set('challenge', this.deps.tracker.awardsThisMatch.length);

    const lines = this.buildLines(won, isMvp, bestStreak);
    const total = this.totalFrom(lines);

    const xpBefore = profile.xp;
    const levelBefore = levelForXp(xpBefore);
    const banked = profile.bankMatch(total, won);
    profile.flush();

    this.announce(total, xpBefore, banked.levelBefore, banked.levelAfter);

    return {
      lines,
      total,
      xpBefore,
      levelBefore,
      levelAfter: banked.levelAfter,
      weaponLevelUps,
      challengesCompleted: this.deps.tracker.awardsThisMatch.map((a) => a.id),
      camosUnlocked: this.deps.tracker.awardsThisMatch
        .map((a) => a.camo)
        .filter((c): c is CamoId => c !== null),
    };
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  // -- internals --------------------------------------------------------------

  private onKilled(sourceId: number, targetId: number, weaponId: string, zone: HitZone): void {
    if (targetId === PLAYER_ENTITY_ID) {
      // Remember who did it, so PAYBACK can be a real challenge rather than a flavour text.
      this.lastKilledBy = sourceId;
      this.killsThisMag = 0;
      return;
    }
    if (sourceId !== PLAYER_ENTITY_ID) return;

    const fact = this.buildKillFact(targetId, weaponId, zone);
    this.bump('kill', 1);
    if (fact.headshot) this.bump('headshot', 1);
    if (fact.distance >= LONGSHOT_METRES) this.bump('longshot', 1);

    const tally = this.tally(fact.weaponId);
    tally.kills++;
    if (fact.headshot) tally.headshots++;
    if (fact.distance >= LONGSHOT_METRES) tally.longshots++;
    if (fact.killsThisMag === 2) tally.multikills++;

    // Per-weapon XP is a fraction of what this kill paid the account, so a weapon can
    // never level from something the player was not rewarded for.
    const killXp =
      xpSource('kill').value +
      (fact.headshot ? xpSource('headshot').value : 0) +
      (fact.distance >= LONGSHOT_METRES ? xpSource('longshot').value : 0);
    tally.xp += killXp * WEAPON_XP_FRACTION;

    this.deps.tracker.onKill(fact);
  }

  private buildKillFact(targetId: number, weaponId: string, zone: HitZone): KillFact {
    const equipment = weaponId.startsWith(EQUIPMENT_WEAPON_PREFIX);
    // A grenade kill is attributed to the grenade, not to whatever was in your hands.
    const resolvedId = equipment ? weaponId : this.heldWeaponId || weaponId;
    const def = WEAPON_DEFS[resolvedId];

    if (!equipment) this.killsThisMag++;
    this.killTicks[this.killRingHead] = this.tick;
    this.killRingHead = (this.killRingHead + 1) % KILL_RING;

    const windowTicks = MULTIKILL_WINDOW / DT;
    let killsInWindow = 0;
    for (const t of this.killTicks) {
      if (this.tick - t <= windowTicks) killsInWindow++;
    }

    const distance = this.lastDamageTarget === targetId ? this.lastDamageDistance : 0;
    const streak = this.deps.score.row(PLAYER_ENTITY_ID)?.streak ?? 0;

    return {
      weaponId: resolvedId,
      weaponClass: equipment ? 'LAUNCHER' : (def?.class ?? this.heldWeaponClass),
      zone,
      headshot: zone === 'head',
      distance,
      ads: this.adsFraction > 0.5,
      // A kill in the beat after a slide still reads as a slide kill to the player, which
      // is what the challenge is about — the shot is fired before the stance has settled.
      sliding: this.sliding || this.sinceSlide <= SLIDE_KILL_GRACE,
      airborne: this.airborne,
      equipment,
      killsThisMag: equipment ? 0 : this.killsThisMag,
      killsInWindow,
      streak,
      revenge: targetId === this.lastKilledBy,
    };
  }

  private bump(id: XpSourceId, by: number): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + by);
  }

  private tally(weaponId: string): WeaponTally {
    const existing = this.weaponTallies.get(weaponId);
    if (existing !== undefined) return existing;
    const fresh = makeTally();
    this.weaponTallies.set(weaponId, fresh);
    return fresh;
  }

  /** Fold the per-weapon deltas into the save. Returns weapons that gained a level. */
  private applyWeaponTallies(): string[] {
    const levelled: string[] = [];
    for (const [id, tally] of this.weaponTallies) {
      // Grenades have a `WeaponDef`-shaped damage profile but are not weapons anybody
      // levels; they have no entry in the registry and must not create one.
      if (WEAPON_DEFS[id] === undefined) continue;
      const stats = this.deps.profile.weapon(id);
      const before = weaponLevelForXp(stats.xp);
      stats.kills += tally.kills;
      stats.headshots += tally.headshots;
      stats.longshots += tally.longshots;
      stats.multikills += tally.multikills;
      stats.shotsFired += tally.shotsFired;
      stats.shotsHit += tally.shotsHit;
      stats.timeUsed += tally.timeUsed;
      stats.xp += tally.xp;
      if (tally.longestShot > stats.longestShot) stats.longestShot = tally.longestShot;
      if (weaponLevelForXp(stats.xp) > before) levelled.push(id);
    }
    // Kills just moved, so the camo challenges that read them can change.
    this.deps.tracker.refreshAbsolute();
    this.deps.profile.refreshUnlocks();
    return levelled;
  }

  private buildLines(won: boolean, isMvp: boolean, bestStreak: number): XpLine[] {
    const out: XpLine[] = [];
    for (const source of XP_SOURCES) {
      let count = this.counts.get(source.id) ?? 0;
      if (source.id === 'win') count = won ? 1 : 0;
      if (source.id === 'mvp') count = isMvp ? 1 : 0;
      if (source.id === 'streak') count = bestStreak;
      if (count <= 0) continue;
      // A challenge carries its own award, so the row's total is the sum of what completed
      // rather than `count x value` — the one source in the table whose XP is data.
      const xp =
        source.id === 'challenge'
          ? this.deps.tracker.xpThisMatch
          : source.kind === 'flat'
            ? source.value
            : count * source.value;
      out.push({ id: source.id, label: source.label, count, xp, kind: source.kind });
    }
    return out;
  }

  private totalFrom(lines: readonly XpLine[]): number {
    let total = 0;
    for (const line of lines) total += line.xp;
    return Math.round(total);
  }

  private announce(total: number, xpBefore: number, levelBefore: number, levelAfter: number): void {
    const bus = this.deps.bus;
    evXp.total = total;
    evXp.xpBefore = xpBefore;
    evXp.xpAfter = xpBefore + total;
    bus.emit(EV.MetaXpAwarded, evXp);

    for (const award of this.deps.tracker.awardsThisMatch) {
      evChallenge.id = award.id;
      evChallenge.name = award.name;
      evChallenge.xp = award.xp;
      evChallenge.camo = award.camo;
      bus.emit(EV.MetaChallengeCompleted, evChallenge);
      if (award.camo === null) continue;
      evCamo.camoId = award.camo;
      evCamo.name = award.camo.toUpperCase();
      bus.emit(EV.MetaCamoUnlocked, evCamo);
    }

    if (levelAfter <= levelBefore) return;
    evLevel.level = levelAfter;
    evLevel.prestige = this.deps.profile.prestige;
    evLevel.unlockCount = levelAfter - levelBefore;
    bus.emit(EV.MetaLevelUp, evLevel);
  }
}
