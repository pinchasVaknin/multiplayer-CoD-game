import type { CamoId } from './Camos';
import type { ChallengeId } from './Challenges';
import type { ChallengeSaveData, SaveV2, WeaponSaveData } from './SaveData';

/**
 * What progression *rules* need from whatever is storing progression (M9).
 *
 * S6.2 splits `SaveStore` from the rules that decide what an action is worth: the store
 * wraps `localStorage` and is client-only, the rules are shared because the server awards
 * them from M10. `MatchProgression` and `ChallengeTracker` are the rules, and both used to
 * hold a concrete `client/meta/Profile` — which dragged `localStorage` across the boundary
 * for the sake of six method calls.
 *
 * This is those six calls. `Profile` implements it structurally and nothing about the
 * browser path changed; at M10 a server-side implementation can bank XP into a match
 * result rather than into a save document, and the rules will not know the difference.
 *
 * Every type in the signatures below already lived in `shared/meta/SaveData.ts`, which is
 * the sign this seam was always there and merely undeclared.
 */
export interface ProgressionStore {
  /** The live save document. Read-only to the rules; they mutate through the methods. */
  readonly save: SaveV2;

  /** Career XP total. */
  readonly xp: number;
  /** Prestige level, 0 for a first-career player. */
  readonly prestige: number;

  /** Per-weapon stats and XP. Creates the record on first use. */
  weapon(weaponId: string): WeaponSaveData;

  /** Progress on one challenge. Creates the record on first use. */
  challenge(id: ChallengeId): ChallengeSaveData;

  /** Whether a camo has been earned on any weapon. */
  camoOwned(id: CamoId): boolean;

  /** Award a camo. Idempotent. */
  grantCamo(id: CamoId): void;

  /** Bank a match's XP and report the level either side of it, for the summary screen. */
  bankMatch(xpEarned: number, won: boolean): { levelBefore: number; levelAfter: number };

  /** Recompute what is unlocked after XP has moved. */
  refreshUnlocks(): void;

  /** Persist. A no-op for an implementation that does not persist. */
  flush(): void;
}
