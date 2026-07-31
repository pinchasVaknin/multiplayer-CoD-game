import type { Profile } from '../meta/Profile';
import { makeSyntheticV0Save, migrateSave, normaliseSave } from '../meta/SaveData';
import type { DebugOverlay, DebugSection } from './DebugOverlay';

/**
 * The save inspector (brief S7).
 *
 * S7 asks for four things and this does exactly those four: **view the raw save object,
 * edit values live, force a migration from a synthetic V0 save, and export/import as
 * JSON.** The textarea is the save; pressing APPLY runs the imported blob through the same
 * `normaliseSave` a real load uses, so hand-editing it is a genuine test of the repair path
 * rather than a back door around it.
 *
 * FORCE MIGRATION is the interesting button. It takes `makeSyntheticV0Save()` — a
 * hand-written payload in the pre-release schema, living in the source next to the
 * migration it tests — pushes it through `migrateSave`, and prints what survived and what
 * was dropped. That is acceptance criterion 7 as a button rather than as a claim, and it
 * runs against the *current* migration every time somebody presses it.
 *
 * Nothing here is reachable outside the F1 overlay, which is itself only reachable from
 * the pause menu. It is a development tool, and the reset it can perform is the same one
 * the menu offers behind a confirmation.
 */

export class SaveInspector {
  private readonly section: DebugSection;
  private readonly area: HTMLTextAreaElement;
  private readonly log: HTMLElement;
  private readonly profile: Profile;

  constructor(overlay: DebugOverlay, profile: Profile) {
    this.profile = profile;
    this.section = overlay.section('Save inspector', overlay.rightColumn);

    this.area = document.createElement('textarea');
    this.area.className = 'dbg-json';
    this.area.rows = 14;
    this.area.spellcheck = false;
    this.area.setAttribute('aria-label', 'Raw save JSON');

    this.log = document.createElement('div');
    this.log.className = 'dbg-log';

    const row1 = document.createElement('div');
    row1.className = 'dbg-buttons';
    row1.append(
      this.button('REFRESH', () => this.refresh()),
      this.button('APPLY', () => this.apply()),
      this.button('COPY', () => this.copy()),
    );

    const row2 = document.createElement('div');
    row2.className = 'dbg-buttons';
    row2.append(
      this.button('FORCE MIGRATION (V0)', () => this.forceMigration()),
      this.button('WRITE V0 AND RELOAD', () => this.writeV0AndReload()),
      this.button('RESET PROGRESS', () => this.reset()),
    );

    const row3 = document.createElement('div');
    row3.className = 'dbg-buttons';
    row3.append(
      this.button('+10,000 XP', () => this.grant(10_000)),
      this.button('+100,000 XP', () => this.grant(100_000)),
      this.button('PRESTIGE', () => this.prestige()),
    );

    this.section.addNode(row1);
    this.section.addNode(this.area);
    this.section.addNode(row2);
    this.section.addNode(row3);
    this.section.addNode(this.log);
    this.refresh();
  }

  /** Reload the textarea from the live document. */
  refresh(): void {
    this.area.value = JSON.stringify(this.profile.save, null, 2);
    const writes = this.profile.writeCount;
    this.say(
      `Loaded. ${writes} write${writes === 1 ? '' : 's'} since page load · ` +
        `${this.profile.store.isPersistent ? 'persistent' : 'IN MEMORY ONLY'}`,
    );
  }

  // -- actions ----------------------------------------------------------------

  /**
   * Parse the textarea and import it.
   *
   * A parse failure reports and changes nothing — the one place in this project where a
   * `catch` is legitimate, because the input is a human typing JSON by hand.
   */
  private apply(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.area.value);
    } catch (err) {
      this.say(`Not valid JSON: ${String(err)}`);
      return;
    }
    const losses = this.profile.importSave(parsed);
    this.refresh();
    this.say(
      losses.length === 0
        ? 'Imported cleanly; nothing had to be repaired.'
        : `Imported with ${losses.length} repair(s):`,
      losses,
    );
  }

  private copy(): void {
    const text = this.area.value;
    void navigator.clipboard?.writeText(text).then(
      () => this.say(`Copied ${text.length} characters to the clipboard.`),
      () => {
        console.info('[SaveInspector] clipboard unavailable; the save follows.');
        console.info(text);
        this.say('Clipboard unavailable — the save was printed to the console instead.');
      },
    );
  }

  /**
   * Acceptance criterion 7, in one press.
   *
   * Runs the synthetic V0 payload through the real migration and reports what came out,
   * without touching the live profile — so the check can be run mid-session.
   */
  private forceMigration(): void {
    const v0 = makeSyntheticV0Save();
    const migrated = migrateSave(v0, 0, this.profile.settings);
    if (migrated === null) {
      this.say('Migration refused the payload. That is a bug — V0 is object-shaped.');
      return;
    }
    const carbine = migrated.weapons['ar_carbine'];
    const lines = [
      `V0 xp ${String(v0['xp'])} -> level ${migrated.profile.level}, ${migrated.profile.xp} XP`,
      `prestige ${migrated.profile.prestige}`,
      `ar_carbine kills ${carbine?.kills ?? 0} (V0 had 312)`,
      `loadout 1 primary "${migrated.loadouts[0]?.primary.weaponId ?? '?'}"`,
      `settings fov ${migrated.settings.fov}, sens ${migrated.settings.sensitivity}`,
      `weapons carried across: ${Object.values(migrated.weapons).filter((w) => w.kills > 0).length}`,
    ];
    this.say('Migrated V0 -> V1 (live profile untouched):', lines);
  }

  /**
   * Write the synthetic V0 blob over the real key so the *next page load* migrates it.
   *
   * The difference from FORCE MIGRATION matters: this exercises the path `SaveStore` takes
   * at construction, including the version check, rather than calling the migration
   * directly. Deliberately destructive, and it says so.
   */
  private writeV0AndReload(): void {
    try {
      window.localStorage.setItem('operator.save', JSON.stringify(makeSyntheticV0Save()));
    } catch (err) {
      this.say(`Could not write: ${String(err)}`);
      return;
    }
    this.say('V0 save written. Reload the page to watch the migration run at boot.');
  }

  private reset(): void {
    this.profile.resetProgress();
    this.refresh();
    this.say('Progress reset. Settings kept.');
  }

  private grant(amount: number): void {
    this.profile.grantXp(amount);
    this.profile.flush();
    this.refresh();
    this.say(`Granted ${amount.toLocaleString()} XP — now level ${this.profile.level}.`);
  }

  private prestige(): void {
    if (!this.profile.canPrestige()) {
      this.say(`Not eligible: level ${this.profile.level}, prestige ${this.profile.prestige}.`);
      return;
    }
    this.profile.doPrestige();
    this.profile.flush();
    this.refresh();
    this.say(`Prestige ${this.profile.prestige}; ${this.profile.unlockTokens} token(s) available.`);
  }

  /**
   * Repair whatever is in the textarea without importing it.
   *
   * Used by the verification script through the console API: it wants to corrupt a field
   * and read the loss report, which should not require committing the damage.
   */
  static dryRun(profile: Profile, raw: unknown): string[] {
    return normaliseSave(raw, profile.settings).losses;
  }

  // -- plumbing ---------------------------------------------------------------

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dbg-btn';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  private say(headline: string, lines: readonly string[] = []): void {
    this.log.replaceChildren();
    const head = document.createElement('div');
    head.textContent = headline;
    this.log.appendChild(head);
    for (const line of lines) {
      const el = document.createElement('div');
      el.className = 'dbg-log__line';
      el.textContent = line;
      this.log.appendChild(el);
    }
  }
}
