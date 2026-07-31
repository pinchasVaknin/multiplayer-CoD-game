import type { CamoId } from './Camos';
import {
  CHALLENGES,
  type ChallengeDef,
  type ChallengeId,
  type KillFact,
  type MatchFact,
  type WeaponStatKey,
} from './Challenges';
import type { Profile } from './Profile';

/**
 * Challenge progress, driven off facts rather than off a clock (brief S6.5).
 *
 * S6.5's shape — subscription, counter, completion rule — is honoured with one important
 * economy: **this class subscribes to nothing.** `MatchProgression` owns the EventBus
 * subscriptions and assembles a `KillFact` once per kill from the four systems that each
 * hold part of the answer; thirty predicates are then tested against that one fact. Thirty
 * separate subscriptions each rebuilding the same context would be thirty times the work
 * for the same result, and — worse — thirty places where "was the player sliding" could
 * be answered differently.
 *
 * Two rule kinds are *absolute* rather than incremental. `weaponBest` reads the highest
 * value any single weapon has reached and `camoSet` counts owned camos, so both are
 * recomputed from the save rather than counted up. That is what makes them survive a
 * reload with no bookkeeping: the answer is a function of the stats, not a tally that
 * could drift from them.
 *
 * Nothing here writes to storage. Progress lands in the live save document and `Profile`
 * banks it once, at the end of the match (S6.6: "write on match end… never every frame").
 */

export interface ChallengeAward {
  readonly id: ChallengeId;
  readonly name: string;
  readonly xp: number;
  readonly camo: CamoId | null;
}

export class ChallengeTracker {
  /** Completions since the last `reset`. Drives the summary's challenge lines. */
  readonly awardsThisMatch: ChallengeAward[] = [];

  private readonly killRules: ChallengeDef[] = [];
  private readonly flashRules: ChallengeDef[] = [];
  private readonly matchRules: ChallengeDef[] = [];
  private readonly absoluteRules: ChallengeDef[] = [];

  constructor(private readonly profile: Profile) {
    for (const def of CHALLENGES) {
      switch (def.rule.kind) {
        case 'kill':
          this.killRules.push(def);
          break;
        case 'flash':
          this.flashRules.push(def);
          break;
        case 'match':
          this.matchRules.push(def);
          break;
        case 'weaponBest':
        case 'camoSet':
          this.absoluteRules.push(def);
          break;
      }
    }
  }

  reset(): void {
    this.awardsThisMatch.length = 0;
  }

  /** XP earned from completions since the last `reset`. */
  get xpThisMatch(): number {
    let total = 0;
    for (const award of this.awardsThisMatch) total += award.xp;
    return total;
  }

  onKill(fact: KillFact): void {
    for (const def of this.killRules) {
      if (def.rule.kind !== 'kill') continue;
      if (!def.rule.test(fact)) continue;
      this.advance(def, 1);
    }
  }

  /** One enemy blinded by the local player's flashbang. */
  onFlash(): void {
    for (const def of this.flashRules) this.advance(def, 1);
  }

  onMatchEnd(fact: MatchFact): void {
    for (const def of this.matchRules) {
      if (def.rule.kind !== 'match') continue;
      if (!def.rule.test(fact)) continue;
      this.advance(def, 1);
    }
    this.refreshAbsolute();
  }

  /**
   * Recompute every absolute rule.
   *
   * Runs twice at most: granting the five prerequisite camos can complete OBSIDIAN, whose
   * own rule counts them — so a second pass is needed and a third can never change
   * anything, because OBSIDIAN is the only camo no challenge depends on.
   */
  refreshAbsolute(): void {
    for (let pass = 0; pass < 2; pass++) {
      let granted = false;
      for (const def of this.absoluteRules) {
        const value = this.absoluteValue(def);
        if (this.setProgress(def, value)) granted = true;
      }
      if (!granted) return;
    }
  }

  /** Live progress for one challenge, for the debug panel. */
  progressOf(id: ChallengeId): { progress: number; target: number; completed: boolean } | null {
    const def = CHALLENGES.find((c) => c.id === id);
    if (def === undefined) return null;
    const state = this.profile.challenge(id);
    return { progress: state.progress, target: def.target, completed: state.completed };
  }

  // -- internals --------------------------------------------------------------

  private absoluteValue(def: ChallengeDef): number {
    if (def.rule.kind === 'camoSet') {
      let count = 0;
      for (const id of def.rule.camos) {
        if (this.profile.camoOwned(id)) count++;
      }
      return count;
    }
    if (def.rule.kind !== 'weaponBest') return 0;
    const stat: WeaponStatKey = def.rule.stat;
    let best = 0;
    for (const weapon of Object.values(this.profile.save.weapons)) {
      const value = weapon[stat];
      if (value > best) best = value;
    }
    return best;
  }

  private advance(def: ChallengeDef, by: number): void {
    const state = this.profile.challenge(def.id);
    if (state.completed) return;
    state.progress += by;
    this.checkComplete(def, state.progress);
  }

  /** Returns true when this set completed the challenge. */
  private setProgress(def: ChallengeDef, value: number): boolean {
    const state = this.profile.challenge(def.id);
    if (state.completed) return false;
    if (value <= state.progress && value < def.target) {
      // Absolute rules can only move forward: a weapon stat never falls, and clamping
      // here means a reset weapon cannot un-earn a camo.
      return false;
    }
    state.progress = Math.max(state.progress, value);
    return this.checkComplete(def, state.progress);
  }

  private checkComplete(def: ChallengeDef, progress: number): boolean {
    if (progress < def.target) return false;
    const state = this.profile.challenge(def.id);
    if (state.completed) return false;
    state.completed = true;
    state.progress = def.target;
    if (def.camo !== undefined) this.profile.grantCamo(def.camo);
    this.awardsThisMatch.push({
      id: def.id,
      name: def.name,
      xp: def.xp,
      camo: def.camo ?? null,
    });
    return true;
  }
}
