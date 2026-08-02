import { ALL_EQUIPMENT, equipmentDef, type EquipmentId } from '../equipment/EquipmentDefs';
import { camoDef, CAMO_IDS } from '../meta/Camos';
import { fieldUpgradeDef, FIELD_UPGRADE_IDS } from '../meta/FieldUpgrades';
import { levelProgress, prestigeLabel } from '../meta/Levels';
import { resolveLoadout, type LoadoutSlot } from '../meta/Loadouts';
import type { Profile } from '../meta/Profile';
import { attachmentsForWeapon, weaponLevelProgress } from '../meta/Unlocks';
import { STREAK_DEFS, streakDef } from '../streaks/StreakDefs';
import { perkDef, perksOfTier, PERK_TIERS, type PerkTier } from '../perks/PerkDefs';
import { attachmentDef } from '../weapons/Attachments';
import { ALL_WEAPONS, requireWeapon, type WeaponDef } from '../weapons/WeaponDefs';
import { LoadoutStats } from './LoadoutStats';

/**
 * Create-a-Class (brief S6.3): the `LOADOUT` state's screen.
 *
 * Five slots down the left, the selected slot's twelve rows in the middle, and the
 * resolved weapon on the right. Every edit goes through `Profile.editLoadout`, which
 * sanitises and persists — so the gating this screen draws is a *courtesy*, and the
 * enforcement is `sanitiseLoadout` behind it. Acceptance criterion 5 is true even if
 * every button here were wrong.
 *
 * The right-hand panel is the point of the screen. It is repainted from
 * `resolveLoadout(slot)` on every click, which is the same call `Game.buildWorld` makes on
 * the way into a match — so fitting a foregrip moves the ADS row here *because* it moved
 * the number the weapon will use, not because this file knows what a foregrip does.
 *
 * Locked content is drawn struck through with its requirement rather than hidden, which is
 * the same choice M5's arsenal panel made for attachments that do not fit: "you cannot have
 * this yet, and here is what it costs" is the whole of a progression screen's job.
 */

export interface LoadoutEditorDeps {
  readonly host: HTMLElement;
  readonly profile: Profile;
  readonly onBack: () => void;
  readonly onLaunch: () => void;
  /** True in the Shooting Range, where every gate is lifted. */
  readonly unrestricted: () => boolean;
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

export class LoadoutEditor {
  private readonly deps: LoadoutEditorDeps;
  private readonly screen: HTMLElement;
  private readonly stats = new LoadoutStats();

  private slotIndex = 0;
  /** Which row is expanded, as its index in `ROWS`, or -1. */
  private openRow = -1;

  constructor(deps: LoadoutEditorDeps) {
    this.deps = deps;
    this.screen = document.createElement('div');
    this.screen.className = 'op-screen lo';
    this.screen.hidden = true;
    deps.host.appendChild(this.screen);
  }

  show(): void {
    this.slotIndex = this.deps.profile.equippedIndex;
    this.openRow = -1;
    this.screen.hidden = false;
    this.paint();
  }

  hide(): void {
    this.screen.hidden = true;
  }

  dispose(): void {
    this.screen.remove();
  }

  // -- painting ---------------------------------------------------------------

  private get slot(): LoadoutSlot {
    const found = this.deps.profile.loadouts[this.slotIndex];
    if (found === undefined) throw new Error(`Loadout slot ${this.slotIndex} does not exist`);
    return found;
  }

  private paint(): void {
    const columns = document.createElement('div');
    columns.className = 'lo-columns';
    columns.append(this.paintSlots(), this.paintRows(), this.stats.element);

    const actions = document.createElement('div');
    actions.className = 'op-actions';
    const back = button('Back', () => this.deps.onBack());
    back.classList.add('op-btn--quiet');
    const launch = button('Start match', () => this.deps.onLaunch());
    launch.classList.add('op-btn--primary');
    actions.append(back, launch);

    this.screen.replaceChildren(this.paintHeader(), columns, actions);
    this.refreshStats();
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

    this.deps.profile.loadouts.forEach((slot, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'op-option lo-slot';
      option.classList.toggle('op-option--on', index === this.slotIndex);
      option.classList.toggle('is-equipped', index === this.deps.profile.equippedIndex);

      const name = document.createElement('span');
      name.className = 'op-option__name';
      name.textContent = slot.name;
      const blurb = document.createElement('span');
      blurb.className = 'op-option__blurb';
      blurb.textContent = requireWeapon(slot.primary.weaponId).name;
      option.append(name, blurb);
      option.addEventListener('click', () => {
        this.slotIndex = index;
        this.openRow = -1;
        this.paint();
      });
      wrap.appendChild(option);
    });

    const equip = button(
      this.slotIndex === this.deps.profile.equippedIndex ? 'Equipped' : 'Equip this class',
      () => {
        this.deps.profile.equipLoadout(this.slotIndex);
        this.paint();
      },
    );
    equip.disabled = this.slotIndex === this.deps.profile.equippedIndex;
    wrap.appendChild(equip);

    const rename = document.createElement('input');
    rename.type = 'text';
    rename.className = 'lo-rename';
    rename.value = this.slot.name;
    rename.maxLength = 16;
    rename.setAttribute('aria-label', 'Class name');
    rename.addEventListener('change', () => {
      const next = rename.value.trim().toUpperCase().slice(0, 16);
      if (next.length === 0) return;
      this.edit((slot) => {
        slot.name = next;
      });
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
      row.classList.toggle('is-open', index === this.openRow);

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'lo-row__head';
      const label = document.createElement('span');
      label.className = 'op-label';
      label.textContent = entry.label;
      const value = document.createElement('span');
      value.className = 'lo-row__value';
      value.textContent = this.describe(entry.row);
      head.append(label, value);
      head.addEventListener('click', () => {
        this.openRow = this.openRow === index ? -1 : index;
        this.paint();
      });

      row.appendChild(head);
      if (index === this.openRow) row.appendChild(this.paintOptions(entry.row));
      wrap.appendChild(row);
    });
    return wrap;
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
    const wrap = document.createElement('div');
    wrap.className = 'lo-options';
    for (const option of this.optionsFor(row)) wrap.appendChild(option);
    return wrap;
  }

  private optionsFor(row: RowKind): HTMLElement[] {
    const unlocks = this.deps.profile.unlocks;
    const free = this.deps.unrestricted();
    const slot = this.slot;
    const out: HTMLElement[] = [];

    switch (row.kind) {
      case 'primary':
      case 'secondary': {
        const which = row.kind;
        const overkill = slot.perks.includes('overkill');
        for (const def of ALL_WEAPONS) {
          // The secondary slot takes sidearms, and primaries too once Overkill is on —
          // which is the entire perk, expressed as a filter rather than as a special case.
          if (which === 'secondary' && def.slot === 'primary' && !overkill) continue;
          if (which === 'primary' && def.slot === 'secondary') continue;
          const locked = !free && !unlocks.weaponUnlocked(def.id);
          out.push(
            this.option(def.name, this.weaponBlurb(def), slot[which].weaponId === def.id, locked,
              locked ? unlocks.weaponRequirement(def.id) : '',
              () =>
                this.edit((s) => {
                  s[which].weaponId = def.id;
                  s[which].attachments = [];
                }),
            ),
          );
        }
        break;
      }

      case 'attachments': {
        const which = row.slot;
        const def = requireWeapon(slot[which].weaponId);
        for (const id of attachmentsForWeapon(def)) {
          const attachment = attachmentDef(id);
          const locked = !free && !unlocks.attachmentUnlocked(def.id, id);
          const on = slot[which].attachments.includes(id);
          out.push(
            this.option(
              attachment.name,
              `${attachment.benefit} — ${attachment.cost}`,
              on,
              locked,
              locked ? unlocks.attachmentRequirement(def.id, id) : '',
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
          this.option('NONE', 'Factory finish', slot[which].camo === null, false, '', () =>
            this.edit((s) => {
              s[which].camo = null;
            }),
          ),
        );
        for (const id of CAMO_IDS) {
          const camo = camoDef(id);
          const locked = !this.deps.profile.camoOwned(id);
          out.push(
            this.option(camo.name, camo.requirement, slot[which].camo === id, locked, 'LOCKED', () =>
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
        const wantSlot = row.kind;
        for (const eq of ALL_EQUIPMENT) {
          if (eq.slot !== wantSlot) continue;
          const locked = !free && !unlocks.equipmentUnlocked(eq.id);
          out.push(
            this.option(eq.name, equipmentBlurb(eq.id), slot[wantSlot] === eq.id, locked, 'LOCKED', () =>
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
        const current = slot.perks[tier - 1] ?? null;
        out.push(
          this.option('NONE', 'Leave this tier empty', current === null, false, '', () =>
            this.edit((s) => {
              s.perks[tier - 1] = null;
            }),
          ),
        );
        for (const perk of perksOfTier(tier)) {
          const locked = !free && !unlocks.perkUnlocked(perk.id);
          const blurb = perk.inert === true ? `${perk.blurb} (no consumer until M7)` : perk.blurb;
          out.push(
            this.option(
              perk.name,
              blurb,
              slot.perks[tier - 1] === perk.id,
              locked,
              `LEVEL ${perk.unlockLevel}`,
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
          this.option('NONE', 'Leave this key empty', slot.streaks[row.index] == null, false, '', () =>
            this.edit((s) => {
              s.streaks[row.index] = null;
            }),
          ),
        );
        for (const def of STREAK_DEFS) {
          // A streak already on another key is shown but not selectable: equipping the same
          // one twice would waste a key and is never what somebody meant to do.
          const usedElsewhere = slot.streaks.some((held, i) => held === def.id && i !== row.index);
          out.push(
            this.option(
              def.name,
              `${def.requirement} kills · ${def.blurb}`,
              slot.streaks[row.index] === def.id,
              usedElsewhere,
              'ON ANOTHER KEY',
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
          const locked = !free && !unlocks.fieldUpgradeUnlocked(id);
          out.push(
            this.option(
              def.name,
              `${def.blurb} · ${def.chargeSeconds}s charge`,
              slot.fieldUpgrade === id,
              locked,
              `LEVEL ${def.unlockLevel}`,
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

  private option(
    name: string,
    blurb: string,
    on: boolean,
    locked: boolean,
    requirement: string,
    apply: () => void,
  ): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'op-option lo-option';
    el.classList.toggle('op-option--on', on);
    el.classList.toggle('is-locked', locked);
    el.disabled = locked;

    const label = document.createElement('span');
    label.className = 'op-option__name';
    label.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'op-option__blurb';
    detail.textContent = locked && requirement.length > 0 ? `${requirement} — ${blurb}` : blurb;
    el.append(label, detail);
    if (!locked) el.addEventListener('click', apply);
    return el;
  }

  private edit(mutate: (slot: LoadoutSlot) => void): void {
    this.deps.profile.editLoadout(this.slotIndex, mutate);
    this.paint();
  }

  /**
   * Repaint the right-hand panel from a fresh resolve.
   *
   * The same `resolveLoadout` the match uses, called with no caching, which is what makes
   * "these are the numbers you will play with" true rather than asserted.
   */
  private refreshStats(): void {
    const resolved = resolveLoadout(this.slot, this.slotIndex);
    const modifiers: string[] = [];
    for (const id of this.slot.primary.attachments) modifiers.push(attachmentDef(id).name);
    for (const tier of PERK_TIERS) {
      const perk = this.slot.perks[tier - 1];
      if (perk !== null && perk !== undefined) modifiers.push(perkDef(perk).name);
    }
    this.stats.show(
      resolved.primaryBase,
      resolved.primary,
      modifiers.length === 0 ? 'BASE WEAPON' : modifiers.join(' · '),
    );
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
