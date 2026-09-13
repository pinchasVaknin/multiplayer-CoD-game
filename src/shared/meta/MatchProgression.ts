import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import type { ScoreSystem } from '../combat/ScoreSystem';
import { EV, type GameBus } from '../core/Events';
import type { PlayerSim } from '../player/PlayerState';
import { WEAPON_DEFS } from '../weapons/WeaponDefs';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import type { CamoId } from './Camos';
import { ChallengeTracker } from './ChallengeTracker';
import type { MatchFact } from './Challenges';
import { levelForXp } from './Levels';
import { MatchLedger } from './MatchLedger';
import type { ProgressionStore } from './ProgressionStore';
import { weaponLevelForXp } from './Unlocks';
import type { XpLine, XpReport } from './XpRules';

/**
 * One match's worth of progression, accumulated in memory and banked once at the end.
 *
 * The counting is `MatchLedger` (M13 Phase B) — the same ledger a dedicated server keeps per
 * seat — composed here for the local player, with the two things only a client has: a
 * `ChallengeTracker` fed every described kill, and a `ProgressionStore` the whole match is
 * folded into exactly once, from `finish`. Nothing here writes to storage before that,
 * allocates per event, or can change what a match does.
 *
 * **Subscription order is load-bearing.** `MatchFlow` subscribes to `entity.killed` in
 * `Match`'s constructor and the ledger subscribes after it, so by the time its handler runs
 * the mode has already called `ScoreSystem.recordKill` and the streak read out of the score
 * row is the streak *including* this kill. `EventBus` dispatches in subscription order, and
 * that is what keeps the streak a single tally rather than a private copy that could drift.
 */

export interface MatchProgressionDeps {
  readonly bus: GameBus;
  readonly profile: ProgressionStore;
  readonly score: ScoreSystem;
  readonly tracker: ChallengeTracker;
}

const evXp = { total: 0, xpBefore: 0, xpAfter: 0 };
const evLevel = { level: 1, prestige: 0, unlockCount: 0 };
const evChallenge = { id: '', name: '', xp: 0, camo: null as string | null };
const evCamo = { camoId: '', name: '' };

export class MatchProgression {
  private readonly ledger: MatchLedger;
  private readonly deps: MatchProgressionDeps;

  /**
   * What `finish` produced, so a second call answers the same thing rather than zeroes.
   *
   * Null until the match is closed out. See the note where `emptyXpReport` used to be.
   */
  private report: XpReport | null = null;

  constructor(deps: MatchProgressionDeps) {
    this.deps = deps;
    this.ledger = new MatchLedger({
      bus: deps.bus,
      score: deps.score,
      entityId: PLAYER_ENTITY_ID,
      onKill: (fact) => deps.tracker.onKill(fact),
      onFlash: () => deps.tracker.onFlash(),
    });
  }

  /** One sim tick of context. See `MatchLedger.sample`. */
  sample(sim: PlayerSim, weapons: WeaponSystem, tickIndex: number): void {
    this.ledger.sample(sim, weapons, tickIndex);
  }

  /** An objective was scored by hand. See `MatchLedger.noteObjective`. */
  noteObjective(count = 1): void {
    this.ledger.noteObjective(count);
  }

  /** Live totals, for the F1 read-out. */
  get liveXp(): number {
    return this.totalFrom(this.ledger.lines(false, false, this.ledger.secondsPlayed));
  }

  get killCount(): number {
    return this.ledger.killCount;
  }

  /**
   * Close the match: fold everything into the profile and produce the summary's report.
   *
   * Idempotent. `Game` reaches SUMMARY from the render pass one frame after the mode
   * declared the match over, and a harness that ends two matches back to back must not be
   * able to bank one twice.
   */
  finish(won: boolean, isMvp: boolean): XpReport {
    const already = this.report;
    if (already !== null) return already;

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
    this.deps.tracker.onMatchEnd(fact);

    // Weapon levels are banked before the XP lines are built for the same reason: a
    // weapon that levelled up on the last kill of the match should say so.
    const weaponLevelUps = this.applyWeaponTallies();

    /**
     * The floor, and the completion condition is where this method is called from (round 5, B6).
     *
     * B6 asked whether a player who quits at 30 seconds gets the flat award. They do not, and
     * nothing had to be built for that: XP is banked from `Game`'s entry into SUMMARY, so a
     * client that left never reaches a path that pays it. The condition is the call site, which
     * is why there is no "did they complete it" flag here to get out of step with a reconnect.
     */
    const lines = this.ledger.lines(won, isMvp, this.ledger.secondsPlayed, {
      // The challenge row counts *challenges*, not XP: its total is the sum of what each one
      // awarded. Storing the XP as the count printed "Challenges x100" for a single completion.
      challenges: this.deps.tracker.awardsThisMatch.length,
      challengeXp: this.deps.tracker.xpThisMatch,
      weaponLevels: weaponLevelUps.length,
    });
    const total = this.totalFrom(lines);

    const xpBefore = profile.xp;
    const levelBefore = levelForXp(xpBefore);
    const banked = profile.bankMatch(total, won);
    profile.flush();

    this.announce(total, xpBefore, banked.levelBefore, banked.levelAfter);

    this.report = {
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
    return this.report;
  }

  dispose(): void {
    this.ledger.dispose();
  }

  // -- internals --------------------------------------------------------------

  /** Fold the per-weapon deltas into the save. Returns weapons that gained a level. */
  private applyWeaponTallies(): string[] {
    const levelled: string[] = [];
    for (const [id, tally] of this.ledger.weaponTallies) {
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
