import { ALL_EQUIPMENT, equipmentDef, type EquipmentId } from '../../shared/equipment/EquipmentDefs';
import { camoDef, CAMO_IDS } from '../../shared/meta/Camos';
import { fieldUpgradeDef, FIELD_UPGRADE_IDS } from '../../shared/meta/FieldUpgrades';
import { levelProgress, prestigeLabel } from '../../shared/meta/Levels';
import { resolveLoadout, type LoadoutSlot } from '../../shared/meta/Loadouts';
import type { Profile } from '../meta/Profile';
import { attachmentsForWeapon, weaponLevelProgress } from '../../shared/meta/Unlocks';
import { STREAK_DEFS, streakDef } from '../../shared/streaks/StreakDefs';
import { perkDef, perksOfTier, PERK_TIERS, type PerkTier } from '../../shared/perks/PerkDefs';
import { attachmentDef } from '../../shared/weapons/Attachments';
import { ALL_WEAPONS, requireWeapon, type WeaponDef } from '../../shared/weapons/WeaponDefs';
import { LoadoutStats } from './LoadoutStats';
import { WeaponPreview } from './WeaponPreview';

/**
 * Create-a-Class (brief S6.3): the `LOADOUT` state's screen.
 *
 * Five slots down the left, the selected slot's twelve rows in the middle, and the weapon
 * itself plus its resolved numbers on the right. Every edit goes through
 * `Profile.editLoadout`, which sanitises and persists — so the gating this screen draws is a
 * *courtesy*, and the enforcement is `sanitiseLoadout` behind it. Acceptance criterion 5 is
 * true even if every button here were wrong.
 *
 * The right-hand column is the point of the screen. `LoadoutStats` is repainted from
 * `resolveLoadout(slot)` on every edit, which is the same call `Game.buildWorld` makes on the
 * way into a match — so fitting a foregrip moves the ADS row here *because* it moved the
 * number the weapon will use, not because this file knows what a foregrip does. `WeaponPreview`
 * above it is the same idea applied to the picture: it is built by `buildWeaponModel`, the
 * viewmodel's own builder, so the weapon on this screen is the weapon you will be holding.
 *
 * Locked content is drawn struck through with its requirement rather than hidden, which is
 * the same choice M5's arsenal panel made for attachments that do not fit: "you cannot have
 * this yet, and here is what it costs" is the whole of a progression screen's job. Every one
 * of those requirements comes from `UnlockState` — see `optionsFor`, and B7 below.
 *
 * ## One action, and it saves (playtest round 4, B5)
 *
 * The editor had two buttons: Back, and "Start match", which is the one the report calls
 * *"exit to match"*. Both are gone. It is a leaf off the main menu now — `LEGAL_TRANSITIONS`
 * admits `LOADOUT -> MENU` and nothing else — so the one honest action is **Save and exit**,
 * and the flush lives in the state's exit handler where Escape passes through it too. Two
 * buttons with one destination would be two buttons that do the same thing.
 *
 * ## The DOM is built once and refreshed in place (playtest round 4, B11)
 *
 * *"Selecting a weapon scrolls the list back to the top."* It did, and the mechanism was
 * `edit()` calling `paint()` calling `screen.replaceChildren(...)`: the `.lo-options` element
 * the player had scrolled was thrown away on every click and its replacement was a fresh node,
 * and a fresh node's `scrollTop` is 0. Saving and restoring the scroll offset would have made
 * the symptom go away while leaving the whole screen rebuilt on every click.
 *
 * So `paint()` runs once per `show()` and nothing else calls it. Selection is a class toggle
 * on rows that already exist: every mutable piece of the screen registers a closure in
 * `refreshers`, and `refresh()` runs them. Opening a row appends its options; closing one
 * removes them; the elements around them are never touched. Preserved scroll is then the
 * *test* rather than the mechanism — nothing is preserved, because nothing was destroyed.
 *
 * An edit inside the open row can never change *which* options that row offers, which is what
 * makes the in-place refresh complete rather than approximate: Overkill changes the secondary
 * weapon list and lives in a perk row, a primary change re-lists the attachments row, and only
 * one row is open at a time. Each of those closed rows is rebuilt when it is next opened.
 */

export interface LoadoutEditorDeps {
  readonly host: HTMLElement;
  readonly profile: Profile;
  /** The one way out. `Game` transitions to MENU; the state's exit handler flushes the save. */
  readonly onSaveAndExit: () => void;
  /** True in the Shooting Range, where every gate is lifted. */
  readonly unrestricted: () => boolean;
  /** Texture anisotropy for the weapon preview. See `GameScreensDeps.anisotropy`. */
  readonly anisotropy: () => number;
}

type RowKind =
  | { kind: 'primary' }
  | { kind: 'secondary' }
  | { kind: 'attachments'; slot: 'primary' | 'secondary' }
  | { kind: 'camo'; slot: 'primary' | 'secondary' }
  | { kind: 'lethal' }
  | { kind: 'tactical' }
  | { kind: 'perk'; tier: PerkTier }
  | { kind: 'field' }
  | { kind: 'streak'; index: 0 | 1 | 2 };

const ROWS: readonly Readonly<{ label: string; row: RowKind }>[] = [
  { label: 'Primary', row: { kind: 'primary' } },
  { label: 'Attachments', row: { kind: 'attachments', slot: 'primary' } },
  { label: 'Camouflage', row: { kind: 'camo', slot: 'primary' } },
  { label: 'Secondary', row: { kind: 'secondary' } },
  { label: 'Sidearm attachments', row: { kind: 'attachments', slot: 'secondary' } },
  { label: 'Lethal', row: { kind: 'lethal' } },
  { label: 'Tactical', row: { kind: 'tactical' } },
  { label: 'Perk 1', row: { kind: 'perk', tier: 1 } },
  { label: 'Perk 2', row: { kind: 'perk', tier: 2 } },
  { label: 'Perk 3', row: { kind: 'perk', tier: 3 } },
  { label: 'Field upgrade', row: { kind: 'field' } },
  // Three streak rows, labelled with the key that spends each one (M7 playtest). Six shipped
  // streaks against three keys is a collision only the loadout can resolve.
  { label: 'Killstreak · key 3', row: { kind: 'streak', index: 0 } },
  { label: 'Killstreak · key 4', row: { kind: 'streak', index: 1 } },
  { label: 'Killstreak · key 5', row: { kind: 'streak', index: 2 } },
];

/** One expanded row: the element holding its options, and which row it belongs to. */
interface OpenRow {
  readonly index: number;
  readonly element: HTMLElement;
  /** Which weapon the preview should show while this row is open. See `previewSlotOf`. */
  readonly previewSlot: 'primary' | 'secondary';
}

/**
 * Which of the two weapons a row is about.
 *
 * Editing the sidearm's camo should show the sidearm. Everything that is not about a
 * particular weapon — perks, equipment, streaks — leaves the primary up, because that is the
 * weapon the stat panel below is describing.
 */
function previewSlotOf(row: RowKind): 'primary' | 'secondary' {
  switch (row.kind) {
    case 'secondary':
      return 'secondary';
    case 'attachments':
    case 'camo':
      return row.slot;
    default:
      return 'primary';
  }
}

export class LoadoutEditor {
  private readonly deps: LoadoutEditorDeps;
  private readonly screen: HTMLElement;
  private readonly stats = new LoadoutStats();
  private readonly preview: WeaponPreview;

  private slotIndex = 0;
  /** Which row is expanded, and the element that would have to be removed to close it. */
  private openRow: OpenRow | null = null;
  /**
   * Everything on screen whose *value* can change without its *structure* changing.
   *
   * Repopulated by `paint()` and by each row that opens; run by `refresh()`. This list is the
   * B11 fix: an edit walks it instead of rebuilding the document. See the class comment.
   */
  private readonly refreshers: (() => void)[] = [];
  /** How many of them belong to the screen itself rather than to the open row. */
  private staticRefresherCount = 0;
  /** The row bodies, so opening one has somewhere to put its options. */
  private readonly rowBodies: HTMLElement[] = [];
  /**
   * Which weapon the preview is showing, when it is not simply the slot's own.
   *
   * Set while the pointer or keyboard focus is on a weapon option, so the model on the right
   * is the weapon under the cursor. Cleared on the way out, which puts the equipped one back.
   */
  private hoveredWeaponId: string | null = null;

  constructor(deps: LoadoutEditorDeps) {
    this.deps = deps;
    this.preview = new WeaponPreview({ anisotropy: deps.anisotropy });
    this.screen = document.createElement('div');
    this.screen.className = 'op-screen lo';
    this.screen.hidden = true;
    deps.host.appendChild(this.screen);
  }

  show(): void {
    this.slotIndex = this.deps.profile.equippedIndex;
    this.openRow = null;
    this.hoveredWeaponId = null;
    this.screen.hidden = false;
    this.paint();
  }

  hide(): void {
    this.screen.hidden = true;
    this.preview.release();
  }

  /**
   * One frame of the weapon preview. Driven from `Game.draw`, not from a timer of its own.
   *
   * The same reasoning as the summary countdown's: a rotation ticked from the render pass
   * stops when the render pass stops, and `requestAnimationFrame` does not fire in a
   * background tab. A spinning weapon nobody is looking at is a GPU nobody asked for.
   */
  tick(dt: number): void {
    if (this.screen.hidden) return;
    this.preview.tick(dt);
  }

  dispose(): void {
    this.preview.dispose();
    this.screen.remove();
  }

  // -- painting ---------------------------------------------------------------

  /**
   * The slot being edited.
   *
   * In an unrestricted mode that is the range's own class rather than one of the five, so a
   * weapon tried on the range cannot follow the player into a match and a match class cannot
   * be trampled by an experiment (M7 playtest).
   */
  private get slot(): LoadoutSlot {
    if (this.deps.unrestricted()) return this.deps.profile.rangeLoadout();
    const found = this.deps.profile.loadouts[this.slotIndex];
    if (found === undefined) throw new Error(`Loadout slot ${this.slotIndex} does not exist`);
    return found;
  }

  /**
   * Build the screen. Called from `show()` and from nowhere else — see the class comment.
   */
  private paint(): void {
    this.refreshers.length = 0;
    this.rowBodies.length = 0;
    this.openRow = null;

    const right = document.createElement('div');
    right.className = 'lo-right';
    right.append(this.preview.element, this.stats.element);

    const columns = document.createElement('div');
    columns.className = 'lo-columns';
    columns.append(this.paintSlots(), this.paintRows(), right);

    const actions = document.createElement('div');
    actions.className = 'op-actions';
    /**
     * The one action (playtest round 4, B5).
     *
     * It reads "Save and exit" rather than "Back" because that is what it does, and because
     * the button it replaces was "Start match" — the report's *"exit to match"* — which
     * cleared the multiplayer join and launched a solo game from a screen whose whole job is
     * editing. There is one destination now, so there is one button.
     */
    const exit = button('Save and exit', () => this.deps.onSaveAndExit());
    exit.classList.add('op-btn--primary');
    actions.append(exit);

    this.screen.replaceChildren(this.paintHeader(), columns, actions);
    this.refresh();
  }

  /** Level, XP bar, prestige and tokens — the reason any of the rest is locked. */
  private paintHeader(): HTMLElement {
    const profile = this.deps.profile;
    const progress = levelProgress(profile.xp);

    const head = document.createElement('div');
    head.className = 'lo-head';

    const badge = document.createElement('div');
    badge.className = 'lo-head__level';
    const num = document.createElement('span');
    num.className = 'lo-head__level-num op-num';
    num.textContent = String(progress.level);
    const cap = document.createElement('span');
    cap.className = 'op-label';
    cap.textContent = profile.prestige > 0 ? `PRESTIGE ${prestigeLabel(profile.prestige)}` : 'LEVEL';
    badge.append(num, cap);

    const bar = document.createElement('div');
    bar.className = 'lo-head__bar';
    const fill = document.createElement('i');
    fill.style.transform = `scaleX(${progress.fraction.toFixed(4)})`;
    bar.appendChild(fill);

    const detail = document.createElement('div');
    detail.className = 'lo-head__detail op-label';
    detail.textContent = progress.atCap
      ? `MAX LEVEL · ${profile.unlockTokens} TOKEN(S)`
      : `${progress.into.toLocaleString()} / ${progress.span.toLocaleString()} XP TO ${progress.level + 1}`;

    const bars = document.createElement('div');
    bars.className = 'lo-head__bars';
    bars.append(bar, detail);

    head.append(badge, bars);
    if (this.deps.unrestricted()) {
      const note = document.createElement('div');
      note.className = 'lo-head__note op-label';
      note.textContent = 'SHOOTING RANGE — ALL CONTENT UNLOCKED, NO PROGRESS BANKED';
      head.appendChild(note);
    }
    return head;
  }

  private paintSlots(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lo-slots';
    const heading = document.createElement('span');
    heading.className = 'op-label';
    heading.textContent = 'Classes';
    wrap.appendChild(heading);

    this.deps.profile.loadouts.forEach((_slot, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'op-option lo-slot';

      const name = document.createElement('span');
      name.className = 'op-option__name';
      const blurb = document.createElement('span');
      blurb.className = 'op-option__blurb';
      option.append(name, blurb);
      /**
       * Changing slot closes the open row and refreshes; it does not repaint.
       *
       * The slot list, the row labels and the option lists are all the same shape whichever
       * class is selected — only their *values* differ — so a rebuild would throw the screen
       * away to change twelve strings. That is B11's mechanism, and it applies here too.
       */
      option.addEventListener('click', () => {
        this.slotIndex = index;
        this.closeOpenRow();
        this.refresh();
      });
      // Looked up rather than captured: `Profile.importSave` and `resetProgress` replace the
      // whole save object, and a closure holding the old slot would keep painting a class that
      // no longer exists.
      this.refreshers.push(() => {
        const slot = this.deps.profile.loadouts[index];
        if (slot === undefined) return;
        option.classList.toggle('op-option--on', index === this.slotIndex);
        option.classList.toggle('is-equipped', index === this.deps.profile.equippedIndex);
        name.textContent = slot.name;
        blurb.textContent = requireWeapon(slot.primary.weaponId).name;
      });
      wrap.appendChild(option);
    });

    const equip = button('Equip this class', () => {
      this.deps.profile.equipLoadout(this.slotIndex);
      this.refresh();
    });
    this.refreshers.push(() => {
      const isEquipped = this.slotIndex === this.deps.profile.equippedIndex;
      equip.textContent = isEquipped ? 'Equipped' : 'Equip this class';
      equip.disabled = isEquipped;
    });
    wrap.appendChild(equip);

    const rename = document.createElement('input');
    rename.type = 'text';
    rename.className = 'lo-rename';
    rename.maxLength = 16;
    rename.setAttribute('aria-label', 'Class name');
    rename.addEventListener('change', () => {
      const next = rename.value.trim().toUpperCase().slice(0, 16);
      if (next.length === 0) return;
      this.edit((slot) => {
        slot.name = next;
      });
    });
    // Written from the slot, but never over what is being typed: the field is its own writer
    // while it holds focus, and this one would fight it on every keystroke of a rename.
    this.refreshers.push(() => {
      if (document.activeElement === rename) return;
      const name = this.slot.name;
      if (rename.value !== name) rename.value = name;
    });
    wrap.appendChild(rename);
    return wrap;
  }

  private paintRows(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lo-rows';

    ROWS.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'lo-row';

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'lo-row__head';
      const label = document.createElement('span');
      label.className = 'op-label';
      label.textContent = entry.label;
      const value = document.createElement('span');
      value.className = 'lo-row__value';
      head.append(label, value);
      head.addEventListener('click', () => this.toggleRow(index));

      row.appendChild(head);
      this.rowBodies.push(row);
      this.refreshers.push(() => {
        value.textContent = this.describe(entry.row);
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  /** Expand a row, or collapse it if it is already the open one. */
  private toggleRow(index: number): void {
    const wasOpen = this.openRow?.index === index;
    this.closeOpenRow();
    if (wasOpen) return;

    const entry = ROWS[index];
    const body = this.rowBodies[index];
    if (entry === undefined || body === undefined) return;

    const options = this.paintOptions(entry.row);
    body.appendChild(options);
    body.classList.add('is-open');
    this.openRow = { index, element: options, previewSlot: previewSlotOf(entry.row) };
    // The options were built after `refresh()` last ran, so bring them up to date once.
    this.refresh();
  }

  /**
   * Collapse whatever is open, and forget the refreshers that belonged to it.
   *
   * The options of a closed row are gone from the document, so a closure still holding one is
   * work done on a detached node — harmless, and exactly the kind of quiet accumulation that
   * turns into a leak. `refreshers` is truncated back to the length it had before the row
   * opened, which is possible because a row's refreshers are always appended last.
   */
  private closeOpenRow(): void {
    const open = this.openRow;
    if (open === null) return;
    open.element.remove();
    this.rowBodies[open.index]?.classList.remove('is-open');
    this.openRow = null;
    this.refreshers.length = this.staticRefresherCount;
    this.hoveredWeaponId = null;
  }

  /** The current value of a row, as one line. */
  private describe(row: RowKind): string {
    const slot = this.slot;
    switch (row.kind) {
      case 'primary':
        return requireWeapon(slot.primary.weaponId).name;
      case 'secondary':
        return requireWeapon(slot.secondary.weaponId).name;
      case 'attachments': {
        const list = slot[row.slot].attachments;
        return list.length === 0 ? '—' : list.map((id) => attachmentDef(id).name).join(' · ');
      }
      case 'camo': {
        const camo = slot[row.slot].camo;
        return camo === null ? 'NONE' : camoDef(camo).name;
      }
      case 'lethal':
        return equipmentDef(slot.lethal).name;
      case 'tactical':
        return equipmentDef(slot.tactical).name;
      case 'perk': {
        const id = slot.perks[row.tier - 1];
        return id === null || id === undefined ? '—' : perkDef(id).name;
      }
      case 'field':
        return fieldUpgradeDef(slot.fieldUpgrade).name;
      case 'streak': {
        const id = slot.streaks[row.index];
        return id === null || id === undefined ? '—' : streakDef(id).name;
      }
    }
  }

  private paintOptions(row: RowKind): HTMLElement {
    this.staticRefresherCount = this.refreshers.length;
    const wrap = document.createElement('div');
    wrap.className = 'lo-options';
    for (const option of this.optionsFor(row)) wrap.appendChild(option);
    return wrap;
  }

  private optionsFor(row: RowKind): HTMLElement[] {
    const unlocks = this.deps.profile.unlocks;
    const free = this.deps.unrestricted();
    const out: HTMLElement[] = [];

    switch (row.kind) {
      case 'primary':
      case 'secondary': {
        const which = row.kind;
        for (const def of ALL_WEAPONS) {
          // The secondary slot takes sidearms, and primaries too once Overkill is on —
          // which is the entire perk, expressed as a filter rather than as a special case.
          if (which === 'secondary' && def.slot === 'primary' && !this.slot.perks.includes('overkill')) {
            continue;
          }
          if (which === 'primary' && def.slot === 'secondary') continue;
          const el = this.option(
            def.name,
            () => this.weaponBlurb(def),
            () => this.slot[which].weaponId === def.id,
            () => !free && !unlocks.weaponUnlocked(def.id),
            () => unlocks.weaponRequirement(def.id),
            () =>
              this.edit((s) => {
                s[which].weaponId = def.id;
                s[which].attachments = [];
              }),
          );
          // F15: the model on the right follows the cursor, so "the weapon you are choosing"
          // is visible before the choice is made rather than after it.
          this.previewOnHover(el, def.id);
          out.push(el);
        }
        break;
      }

      case 'attachments': {
        const which = row.slot;
        const def = requireWeapon(this.slot[which].weaponId);
        for (const id of attachmentsForWeapon(def)) {
          const attachment = attachmentDef(id);
          out.push(
            this.option(
              attachment.name,
              () => `${attachment.benefit} — ${attachment.cost}`,
              () => this.slot[which].attachments.includes(id),
              () => !free && !unlocks.attachmentUnlocked(def.id, id),
              () => unlocks.attachmentRequirement(def.id, id),
              () =>
                this.edit((s) => {
                  const list = s[which].attachments;
                  const at = list.indexOf(id);
                  if (at >= 0) list.splice(at, 1);
                  else list.push(id);
                }),
            ),
          );
        }
        if (out.length === 0) out.push(emptyNote('This weapon takes no attachments'));
        break;
      }

      case 'camo': {
        const which = row.slot;
        out.push(
          this.option(
            'NONE',
            () => 'Factory finish',
            () => this.slot[which].camo === null,
            () => false,
            () => '',
            () =>
              this.edit((s) => {
                s[which].camo = null;
              }),
          ),
        );
        for (const id of CAMO_IDS) {
          const camo = camoDef(id);
          out.push(
            this.option(
              camo.name,
              () => camo.requirement,
              () => this.slot[which].camo === id,
              () => !this.deps.profile.camoOwned(id),
              () => unlocks.camoRequirement(id),
              () =>
                this.edit((s) => {
                  s[which].camo = id;
                }),
            ),
          );
        }
        break;
      }

      case 'lethal':
      case 'tactical': {
        /**
         * The unlock level, which this row did not draw (playtest round 4, B7).
         *
         * *"The gas grenade shows no unlock level in the picker."* SMOKE is the gas grenade,
         * its row in `EQUIPMENT_UNLOCK_LEVEL` says 3, and the table was never missing anything
         * — this call site passed the literal string `'LOCKED'`, and `UnlockState` had no
         * `equipmentRequirement` to ask. So the gate read the level and the screen did not,
         * which is the same defect for SEMTEX at 8 and CLAYMORE at 16; smoke is simply the
         * first one a low-level player meets. Every requirement on this screen now comes from
         * `UnlockState`, and `scripts/check-unlocks.mjs` fails if a category stops asking.
         */
        const wantSlot = row.kind;
        for (const eq of ALL_EQUIPMENT) {
          if (eq.slot !== wantSlot) continue;
          out.push(
            this.option(
              eq.name,
              () => equipmentBlurb(eq.id),
              () => this.slot[wantSlot] === eq.id,
              () => !free && !unlocks.equipmentUnlocked(eq.id),
              () => unlocks.equipmentRequirement(eq.id),
              () =>
                this.edit((s) => {
                  s[wantSlot] = eq.id;
                }),
            ),
          );
        }
        break;
      }

      case 'perk': {
        const tier = row.tier;
        out.push(
          this.option(
            'NONE',
            () => 'Leave this tier empty',
            () => (this.slot.perks[tier - 1] ?? null) === null,
            () => false,
            () => '',
            () =>
              this.edit((s) => {
                s.perks[tier - 1] = null;
              }),
          ),
        );
        for (const perk of perksOfTier(tier)) {
          const blurb = perk.inert === true ? `${perk.blurb} (no consumer until M7)` : perk.blurb;
          out.push(
            this.option(
              perk.name,
              () => blurb,
              () => this.slot.perks[tier - 1] === perk.id,
              () => !free && !unlocks.perkUnlocked(perk.id),
              () => unlocks.perkRequirement(perk.id),
              () =>
                this.edit((s) => {
                  s.perks[tier - 1] = perk.id;
                }),
            ),
          );
        }
        break;
      }

      case 'streak': {
        // NONE first: three is a maximum, not a quota.
        out.push(
          this.option(
            'NONE',
            () => 'Leave this key empty',
            () => this.slot.streaks[row.index] == null,
            () => false,
            () => '',
            () =>
              this.edit((s) => {
                s.streaks[row.index] = null;
              }),
          ),
        );
        for (const def of STREAK_DEFS) {
          out.push(
            this.option(
              def.name,
              // "Costs", not "at": after round 4's B9 the number is a price that is debited
              // from a balance, not a threshold that opens something and stays crossed.
              () => `Costs ${def.requirement} kills · ${def.blurb}`,
              () => this.slot.streaks[row.index] === def.id,
              // A streak already on another key is shown but not selectable: equipping the
              // same one twice would waste a key and is never what somebody meant to do.
              () => this.slot.streaks.some((held, i) => held === def.id && i !== row.index),
              () => 'ON ANOTHER KEY',
              () =>
                this.edit((s) => {
                  s.streaks[row.index] = def.id;
                }),
            ),
          );
        }
        break;
      }
      case 'field': {
        for (const id of FIELD_UPGRADE_IDS) {
          const def = fieldUpgradeDef(id);
          out.push(
            this.option(
              def.name,
              () => `${def.blurb} · ${def.chargeSeconds}s charge`,
              () => this.slot.fieldUpgrade === id,
              () => !free && !unlocks.fieldUpgradeUnlocked(id),
              () => unlocks.fieldUpgradeRequirement(id),
              () =>
                this.edit((s) => {
                  s.fieldUpgrade = id;
                }),
            ),
          );
        }
        break;
      }
    }
    return out;
  }

  /** Per-weapon progress, printed under every weapon in the picker. */
  private weaponBlurb(def: WeaponDef): string {
    const stats = this.deps.profile.weapon(def.id);
    const level = weaponLevelProgress(stats.xp);
    const accuracy = this.deps.profile.weaponAccuracy(def.id);
    const parts = [
      `${def.class} · LV ${level.level}`,
      `${stats.kills} kills`,
      `${stats.headshots} hs`,
      accuracy < 0 ? 'no shots' : `${accuracy.toFixed(0)}% acc`,
    ];
    if (stats.longestShot > 0) parts.push(`longest ${stats.longestShot.toFixed(0)} m`);
    if (stats.timeUsed > 0) parts.push(`${formatDuration(stats.timeUsed)} used`);
    return parts.join(' · ');
  }

  /**
   * One option row, and the closure that keeps it current.
   *
   * Every argument past the label is a *predicate* rather than a value, which is the whole of
   * the B11 fix at this level: the element is built once and the closure decides what it says
   * this frame. `apply` is bound once and guarded by the same `locked` predicate the class is
   * drawn from, so a row that becomes locked stops responding without being rebuilt.
   */
  private option(
    name: string,
    blurb: () => string,
    on: () => boolean,
    locked: () => boolean,
    requirement: () => string,
    apply: () => void,
  ): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'op-option lo-option';

    const label = document.createElement('span');
    label.className = 'op-option__name';
    label.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'op-option__blurb';
    el.append(label, detail);
    el.addEventListener('click', () => {
      if (locked()) return;
      apply();
    });

    this.refreshers.push(() => {
      const isLocked = locked();
      const need = requirement();
      el.classList.toggle('op-option--on', on());
      el.classList.toggle('is-locked', isLocked);
      el.disabled = isLocked;
      detail.textContent = isLocked && need.length > 0 ? `${need} — ${blurb()}` : blurb();
    });
    return el;
  }

  /** Show a weapon while the pointer or the keyboard is on its row. */
  private previewOnHover(el: HTMLElement, weaponId: string): void {
    const enter = (): void => {
      this.hoveredWeaponId = weaponId;
      this.refreshPreview();
    };
    const leave = (): void => {
      if (this.hoveredWeaponId !== weaponId) return;
      this.hoveredWeaponId = null;
      this.refreshPreview();
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('focus', enter);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('blur', leave);
  }

  private edit(mutate: (slot: LoadoutSlot) => void): void {
    if (this.deps.unrestricted()) {
      mutate(this.deps.profile.rangeLoadout());
      this.deps.profile.flush();
    } else {
      this.deps.profile.editLoadout(this.slotIndex, mutate);
    }
    this.refresh();
  }

  /**
   * Every mutable value on screen, from the state that produced it. No DOM is created here.
   */
  private refresh(): void {
    for (const fn of this.refreshers) fn();
    this.refreshStats();
    this.refreshPreview();
  }

  /**
   * Repaint the right-hand panel from a fresh resolve.
   *
   * The same `resolveLoadout` the match uses, called with no caching, which is what makes
   * "these are the numbers you will play with" true rather than asserted.
   */
  private refreshStats(): void {
    const slot = this.slot;
    const resolved = resolveLoadout(slot, this.slotIndex);
    const modifiers: string[] = [];
    for (const id of slot.primary.attachments) modifiers.push(attachmentDef(id).name);
    for (const tier of PERK_TIERS) {
      const perk = slot.perks[tier - 1];
      if (perk !== null && perk !== undefined) modifiers.push(perkDef(perk).name);
    }
    this.stats.show(
      resolved.primaryBase,
      resolved.primary,
      modifiers.length === 0 ? 'BASE WEAPON' : modifiers.join(' · '),
    );
  }

  /**
   * What the preview is showing: the weapon under the cursor, or the open row's own.
   *
   * A hovered weapon is drawn bare. The camo belongs to the *equipped* weapon in that slot and
   * a weapon being hovered has not been equipped, so painting the class's finish onto it would
   * be showing a combination that does not exist. Choosing a camo repaints the equipped model
   * with it, which is the point of putting the two on one screen.
   */
  private refreshPreview(): void {
    if (this.screen.hidden) return;
    const which = this.openRow?.previewSlot ?? 'primary';
    const equipped = this.slot[which];
    const hovered = this.hoveredWeaponId;
    const weaponId = hovered ?? equipped.weaponId;
    this.preview.show(weaponId, hovered === null ? equipped.camo : null, requireWeapon(weaponId).name);
  }
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'op-btn';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function emptyNote(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lo-empty op-label';
  el.textContent = text;
  return el;
}

function equipmentBlurb(id: EquipmentId): string {
  const def = equipmentDef(id);
  const parts = [`x${def.count} per life`];
  if (def.damageProfile !== null) parts.push(`${def.damageProfile.damage.near} dmg · ${def.effectRadius} m`);
  if (def.flashSeconds > 0) parts.push(`${def.flashSeconds}s blind`);
  if (def.smokeSeconds > 0) parts.push(`${def.smokeSeconds}s cover`);
  if (def.cookable) parts.push('cookable');
  return parts.join(' · ');
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds.toFixed(0)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(0)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}
