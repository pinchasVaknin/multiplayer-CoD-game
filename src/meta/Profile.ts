import { SaveStore } from '../core/SaveStore';
import type { AttachmentId } from '../weapons/Attachments';
import { CAMO_PREREQUISITES, type CamoId } from './Camos';
import { CHALLENGES, challengeDef, type ChallengeId } from './Challenges';
import { canPrestige, levelForXp, levelProgress, TOKENS_PER_PRESTIGE } from './Levels';
import {
  defaultLoadouts,
  LOADOUT_SLOT_COUNT,
  resolveLoadout,
  type LoadoutSlot,
  type ResolvedLoadout,
} from './Loadouts';
import {
  defaultSave,
  makeWeaponSave,
  migrateSave,
  normaliseSave,
  readLegacySettings,
  SAVE_KEY,
  SAVE_VERSION,
  type ChallengeSaveData,
  type SaveV2,
  type SettingsV1,
  type WeaponSaveData,
} from './SaveData';
import { sanitiseLoadout, UnlockState, weaponLevelForXp } from './Unlocks';

/**
 * The one owner of the save file.
 *
 * Everything that reads or writes progression goes through this object, which is what
 * makes S6.6's "never every frame" a checkable property rather than a hope: every mutator
 * below ends in a single `touch()`, `SaveStore` coalesces bursts into one write 250 ms
 * later, and `writeCount` reports what actually happened. Nothing in the sim path calls
 * any of it — `MatchProgression` accumulates a match in memory and banks it once, at the
 * end.
 *
 * Loading is three stages and each one is separately reportable:
 *
 *   1. `SaveStore` parses, and calls `migrateSave` if the version differs.
 *   2. `normaliseSave` repairs anything structurally wrong at the current version.
 *   3. `sanitiseLoadout` removes anything the profile has not earned.
 *
 * Stages 2 and 3 both return lines, and `loadReport` keeps them for the console and for
 * the save inspector. A save is never discarded because one field was bad.
 */

export interface ProfileDeps {
  /** Used only when there is nothing to load. */
  readonly fallbackSettings: SettingsV1;
}

/** Slot index reported for the range class. Outside the five, so nothing collides. */
export const RANGE_SLOT_INDEX = 99;

export class Profile {
  readonly store: SaveStore<SaveV2>;
  /** Every repair and reversion the last load produced, oldest first. */
  readonly loadReport: string[] = [];

  private unlockCache: UnlockState;

  constructor(deps: ProfileDeps) {
    // Read the M1-M5 settings blob *before* the store loads, so a profile that has never
    // existed still starts with the player's FOV and sensitivity rather than the defaults.
    const fallback = readLegacySettings(deps.fallbackSettings);
    this.store = new SaveStore<SaveV2>(SAVE_KEY, SAVE_VERSION, defaultSave(fallback), (raw, from) =>
      migrateSave(raw, from, fallback),
    );

    // The store's own same-version path unions with the defaults at the top level only,
    // which cannot see a corrupt weapon record or a level that disagrees with its XP.
    // Running the repair on every load rather than only on a version change is what makes
    // "recover what is parseable" true of a damaged save as well as an old one.
    const repaired = normaliseSave(this.store.value, fallback);
    this.loadReport.push(...repaired.losses);
    this.store.replace(repaired.save);

    this.unlockCache = UnlockState.fromSave(this.save);
    this.sanitiseAll();
    this.report();
  }

  get save(): SaveV2 {
    return this.store.value as SaveV2;
  }

  get level(): number {
    return this.save.profile.level;
  }

  get xp(): number {
    return this.save.profile.xp;
  }

  get prestige(): number {
    return this.save.profile.prestige;
  }

  get unlockTokens(): number {
    return this.save.profile.unlockTokens;
  }

  get progress(): ReturnType<typeof levelProgress> {
    return levelProgress(this.save.profile.xp);
  }

  get settings(): SettingsV1 {
    return this.save.settings;
  }

  /** Writes to storage since the page loaded. Acceptance criterion 8 reads this. */
  get writeCount(): number {
    return this.store.writes;
  }

  get unlocks(): UnlockState {
    return this.unlockCache;
  }

  // -- loadouts ---------------------------------------------------------------

  get loadouts(): readonly LoadoutSlot[] {
    return this.save.loadouts;
  }

  get equippedIndex(): number {
    return this.save.equippedLoadout;
  }

  /** The slot that will spawn on the player. Always sanitised. */
  /**
   * The Shooting Range's own class (M7 playtest).
   *
   * Kept apart from the five competitive slots on purpose. The range is a testbed where
   * everything is unlocked, and letting it share a slot meant a weapon picked there either
   * had to survive into a real match — which would defeat progression — or be silently
   * reverted, which is what made the range feel like it was still locking things.
   *
   * Lives in the save so a range setup persists, and is repaired like any other slot.
   */
  rangeLoadout(): LoadoutSlot {
    const existing = this.save.rangeLoadout;
    if (existing !== undefined) return existing;
    const fresh = defaultLoadouts()[0];
    if (fresh === undefined) throw new Error('defaultLoadouts() produced no slots');
    fresh.name = 'RANGE';
    this.save.rangeLoadout = fresh;
    this.store.touch();
    return fresh;
  }

  equippedLoadout(): LoadoutSlot {
    const existing = this.save.loadouts[this.save.equippedLoadout] ?? this.save.loadouts[0];
    if (existing !== undefined) return existing;
    // Only reachable if the array was emptied out from under us — a hand-edited save, or
    // an import of something that was never a save at all. Rebuilding beats throwing on
    // the path into a match.
    const fresh = defaultLoadouts();
    this.save.loadouts = fresh;
    this.save.equippedLoadout = 0;
    this.store.touch();
    const first = fresh[0];
    if (first === undefined) throw new Error('defaultLoadouts() produced no slots');
    return first;
  }

  /**
   * The equipped slot, resolved.
   *
   * `unrestricted` is the Shooting Range: S9 keeps the range a testbed, and the M5
   * playtest note asks for every weapon to be reachable there. The gate is passed in
   * rather than read from a global so a normal match cannot accidentally get it.
   */
  resolveEquipped(unrestricted = false): ResolvedLoadout {
    // The range resolves its *own* slot, so nothing chosen there can leak into a real match
    // and nothing a real match needs can be overwritten by an experiment.
    if (unrestricted) return resolveLoadout(this.rangeLoadout(), RANGE_SLOT_INDEX);

    const index = this.save.equippedLoadout;
    const slot = this.equippedLoadout();
    if (!unrestricted) {
      // Sanitise immediately before use, not only at load: the level may have risen since
      // (unlocking things) and a save may have been hand-edited while the tab was open.
      const losses: string[] = [];
      if (sanitiseLoadout(slot, this.unlockCache, losses)) {
        for (const line of losses) console.warn(`[Profile] ${line}`);
        this.store.touch();
      }
    }
    return resolveLoadout(slot, index);
  }

  equipLoadout(index: number): void {
    const clamped = Math.max(0, Math.min(LOADOUT_SLOT_COUNT - 1, index));
    if (clamped === this.save.equippedLoadout) return;
    this.save.equippedLoadout = clamped;
    this.store.touch();
  }

  /**
   * Apply an edit to a slot and persist it.
   *
   * The mutator runs against the live slot and the result is sanitised before it is
   * written, so the editor cannot produce an illegal loadout even by mistake — and the
   * editor's own gating is then a courtesy to the player rather than the enforcement.
   */
  editLoadout(index: number, mutate: (slot: LoadoutSlot) => void): void {
    const slot = this.save.loadouts[index];
    if (slot === undefined) return;
    mutate(slot);
    const losses: string[] = [];
    sanitiseLoadout(slot, this.unlockCache, losses);
    for (const line of losses) console.info(`[Profile] ${line}`);
    this.store.touch();
  }

  // -- weapons ----------------------------------------------------------------

  weapon(weaponId: string): WeaponSaveData {
    const existing = this.save.weapons[weaponId];
    if (existing !== undefined) return existing;
    const fresh = makeWeaponSave();
    this.save.weapons[weaponId] = fresh;
    return fresh;
  }

  weaponLevel(weaponId: string): number {
    return weaponLevelForXp(this.weapon(weaponId).xp);
  }

  /** Accuracy as a percentage, or -1 when the weapon has never been fired. */
  weaponAccuracy(weaponId: string): number {
    const w = this.weapon(weaponId);
    if (w.shotsFired === 0) return -1;
    return (w.shotsHit / w.shotsFired) * 100;
  }

  // -- challenges and camos ---------------------------------------------------

  challenge(id: ChallengeId): ChallengeSaveData {
    const existing = this.save.challenges[id];
    if (existing !== undefined) return existing;
    const fresh: ChallengeSaveData = { progress: 0, completed: false };
    this.save.challenges[id] = fresh;
    return fresh;
  }

  camoOwned(id: CamoId): boolean {
    return this.save.camos[id] === true;
  }

  grantCamo(id: CamoId): void {
    if (this.save.camos[id] === true) return;
    this.save.camos[id] = true;
    this.refreshUnlocks();
    this.store.touch();
  }

  /** How many of the five OBSIDIAN needs are already owned. */
  camoPrerequisiteCount(): number {
    let count = 0;
    for (const id of CAMO_PREREQUISITES) {
      if (this.camoOwned(id)) count++;
    }
    return count;
  }

  // -- progression ------------------------------------------------------------

  /**
   * Bank a finished match.
   *
   * One call, one write. Everything the match earned — account XP, per-weapon XP and
   * stats, challenge progress, camos — has already been accumulated in memory by
   * `MatchProgression`; this is where it becomes durable, and it is the only place that
   * happens during play.
   */
  bankMatch(xpEarned: number, won: boolean): { levelBefore: number; levelAfter: number } {
    const profile = this.save.profile;
    const levelBefore = profile.level;
    profile.xp = Math.max(0, profile.xp + Math.max(0, Math.round(xpEarned)));
    profile.level = levelForXp(profile.xp);
    profile.matchesPlayed++;
    if (won) profile.matchesWon++;
    if (profile.level !== levelBefore) this.refreshUnlocks();
    this.store.touch();
    return { levelBefore, levelAfter: profile.level };
  }

  /** Grant XP outside a match — the debug simulator and the save inspector only. */
  grantXp(amount: number): void {
    const profile = this.save.profile;
    profile.xp = Math.max(0, profile.xp + Math.round(amount));
    profile.level = levelForXp(profile.xp);
    this.refreshUnlocks();
    this.store.touch();
  }

  canPrestige(): boolean {
    return canPrestige(this.save.profile.level, this.save.profile.prestige);
  }

  /**
   * Prestige (S6.1): reset the level and the unlocks, keep the icon, grant a token.
   *
   * Weapon stats and challenges are deliberately *not* reset. S6.1 says "reset level and
   * unlocks"; a player who has ground a weapon to GOLD has earned the camo, and taking a
   * hundred kills back would make prestige a punishment rather than a choice. What resets
   * is the account level and everything gated on it.
   */
  doPrestige(): boolean {
    if (!this.canPrestige()) return false;
    const profile = this.save.profile;
    profile.prestige++;
    profile.xp = 0;
    profile.level = 1;
    profile.unlockTokens += TOKENS_PER_PRESTIGE;
    this.refreshUnlocks();
    this.sanitiseAll();
    this.store.touch();
    console.info(
      `[Profile] prestige ${profile.prestige}; level reset to 1, ` +
        `${profile.unlockTokens} unlock token(s) available.`,
    );
    return true;
  }

  /** Spend one token to unlock an item permanently, across every future reset. */
  spendToken(id: string): boolean {
    const profile = this.save.profile;
    if (profile.unlockTokens <= 0) return false;
    if (profile.permanentUnlocks.includes(id)) return false;
    profile.unlockTokens--;
    profile.permanentUnlocks.push(id);
    this.refreshUnlocks();
    this.store.touch();
    return true;
  }

  /** Mark an attachment permanently available on a weapon, ahead of its kill threshold. */
  unlockAttachment(weaponId: string, attachment: AttachmentId): void {
    const stats = this.weapon(weaponId);
    if (stats.unlockedAttachments.includes(attachment)) return;
    stats.unlockedAttachments.push(attachment);
    this.refreshUnlocks();
    this.store.touch();
  }

  // -- settings ---------------------------------------------------------------

  patchSettings(changes: Partial<SettingsV1>): void {
    let changed = false;
    const settings = this.save.settings;
    for (const key of Object.keys(changes) as Array<keyof SettingsV1>) {
      const next = changes[key];
      if (next === undefined) continue;
      if (settings[key] === next) continue;
      // Every field of SettingsV1 is a primitive, so a per-key assignment through a
      // generic index is safe here and the alternative is six near-identical branches.
      Object.assign(settings, { [key]: next });
      changed = true;
    }
    if (changed) this.store.touch();
  }

  // -- maintenance ------------------------------------------------------------

  /** The "reset progress" button (S6.6). The confirmation lives in the menu. */
  resetProgress(): void {
    const settings = { ...this.save.settings };
    this.store.replace(defaultSave(settings));
    this.refreshUnlocks();
    this.loadReport.length = 0;
    this.store.flush();
    console.info('[Profile] progress reset; settings kept.');
  }

  /** Replace the whole save from imported JSON, repairing whatever arrives. */
  importSave(raw: unknown): string[] {
    const repaired = normaliseSave(raw, this.save.settings);
    this.store.replace(repaired.save);
    this.refreshUnlocks();
    this.sanitiseAll(repaired.losses);
    this.store.flush();
    this.loadReport.length = 0;
    this.loadReport.push(...repaired.losses);
    return repaired.losses;
  }

  /** Force a write now. Called on pagehide and at the end of a match. */
  flush(): void {
    this.store.flush();
  }

  /** Rebuild the unlock snapshot. Called whenever anything a gate reads has changed. */
  refreshUnlocks(): void {
    this.unlockCache = UnlockState.fromSave(this.save);
  }

  /** Every challenge that has an entry, with its definition. For the debug panel. */
  challengeRows(): Array<{ def: (typeof CHALLENGES)[number]; state: ChallengeSaveData }> {
    const out: Array<{ def: (typeof CHALLENGES)[number]; state: ChallengeSaveData }> = [];
    for (const id of Object.keys(this.save.challenges)) {
      const def = challengeDef(id);
      const state = this.save.challenges[id];
      if (def === undefined || state === undefined) continue;
      out.push({ def, state });
    }
    return out;
  }

  private sanitiseAll(into: string[] = this.loadReport): void {
    for (const slot of this.save.loadouts) sanitiseLoadout(slot, this.unlockCache, into);
  }

  private report(): void {
    const p = this.save.profile;
    const suffix = this.store.isPersistent ? '' : ' (storage unavailable; in memory only)';
    console.info(
      `[Profile] level ${p.level}${p.prestige > 0 ? ` · prestige ${p.prestige}` : ''} · ` +
        `${p.xp} XP · ${p.matchesPlayed} matches${suffix}`,
    );
    if (this.loadReport.length === 0) return;
    console.warn(`[Profile] recovered a damaged save; ${this.loadReport.length} field(s) repaired:`);
    for (const line of this.loadReport) console.warn(`[Profile]   ${line}`);
  }
}
