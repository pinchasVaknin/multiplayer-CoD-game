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
import type { CharacterAssetService } from '../characters/CharacterAssetService';
import { DEFAULT_CHARACTER_ID } from '../characters/CharacterCatalog';
import { CharacterStage } from './CharacterStage';
import { createScreen } from './Frame';
import { LoadoutStats } from './LoadoutStats';
import { ICON_VIEWBOX, iconFor, makeIconSvg } from './WeaponIcons';
import { WeaponPreview } from './WeaponPreview';

/**
 * Create-a-Class (brief S6.3; rebuilt on the design frame by M15, Phase B): the `LOADOUT`
 * state's screen.
 *
 * ## The shape
 *
 * The operator on a lit disc on the left — the player's skin, holding the class's primary,
 * turning, the same `ActorAvatar` a match draws (`CharacterStage`) — and on the right a column
 * of **six boxes** that each show only what is equipped: PRIMARY, SECONDARY, EQUIPMENT (lethal
 * and tactical), PERKS (three), KILLSTREAKS (three, each with its key), FIELD UPGRADE. Fourteen
 * rows became six boxes because six fit a 1080 frame with room for an icon and two lines and
 * fourteen did not. The five class slots are tabs across the top, with the slot's name beside
 * them.
 *
 * ## The strip is docked, not dropped
 *
 * Clicking a box opens its options in a **zone under the column**, in the same place for
 * every box, with tabs across its top where a box has more than one thing to choose — WEAPON
 * / ATTACHMENTS / SKIN for the two weapons, LETHAL / TACTICAL, PERK 1 / 2 / 3, KEY 3 / 4 / 5.
 * The reference drops the strip directly under the box; under a rule that nothing may scroll
 * and nothing may leave the frame, a strip under KILLSTREAKS would either push FIELD UPGRADE
 * off the bottom or cover it, and a strip that flips above its box for the last two rows is a
 * strip in two places. So it is in one place: opening PERKS does not move KILLSTREAKS, and
 * the frame never has to grow. A list longer than the zone is **paged**, never scrolled —
 * the arrows at each end are the reference's — which is what closed the last row of A1's red
 * list.
 *
 * ## What each box still means
 *
 * Every edit goes through `Profile.editLoadout`, which sanitises and persists — so the gating
 * this screen draws is a *courtesy*, and the enforcement is `sanitiseLoadout` behind it.
 * Locked content is drawn with its requirement rather than hidden (M5's rule); every
 * requirement comes from `UnlockState` (round 4, B7). `LoadoutStats`, *"the point of the
 * screen"* (M6), is a band under the weapon tiles rather than a column: the same
 * `resolveLoadout` the match makes, on every edit. The SKIN tab (the reference's word for
 * what this project has called camo since M5 — the label changed, `CamoId` did not) shows the
 * finish on the `WeaponPreview` in that band, because a held weapon is one shared material
 * and does not carry a camo.
 *
 * ## Built once, refreshed in place (playtest round 4, B11 — the mechanism, kept)
 *
 * `paint()` runs once per `show()`. Every mutable piece registers a closure in `refreshers`
 * and `refresh()` runs them; opening a box appends the zone's closures after
 * `staticRefresherCount` and closing it truncates back. B11 built this so a scrolled list
 * survived an edit; there is no scroll now, and the test is that the open zone's *page*
 * survives one. A rebuilt tree would also be a lost tooltip and a jumped strip.
 *
 * ## One action, and it saves (playtest round 4, B5)
 *
 * The editor is a leaf off the main menu — `LEGAL_TRANSITIONS` admits `LOADOUT -> MENU` and
 * nothing else — so the one honest action is **Save and exit**, and the flush lives in the
 * state's exit handler where Escape passes through it too.
 */

export interface LoadoutEditorDeps {
  readonly host: HTMLElement;
  readonly profile: Profile;
  /** The one way out. `Game` transitions to MENU; the state's exit handler flushes the save. */
  readonly onSaveAndExit: () => void;
  /** True in the Shooting Range, where every gate is lifted. */
  readonly unrestricted: () => boolean;
  /** Texture anisotropy for the weapon preview and the held weapon. See `GameScreensDeps.anisotropy`. */
  readonly anisotropy: () => number;
  /** The skins, for the stage. The same service the match draws bodies from. */
  readonly characterAssets: CharacterAssetService;
}

type WeaponSlot = 'primary' | 'secondary';

/** One list of options: what the zone shows under one tab. */
type ListKind =
  | { kind: 'weapon'; slot: WeaponSlot }
  | { kind: 'attachments'; slot: WeaponSlot }
  | { kind: 'camo'; slot: WeaponSlot }
  | { kind: 'lethal' }
  | { kind: 'tactical' }
  | { kind: 'perk'; tier: PerkTier }
  | { kind: 'streak'; index: 0 | 1 | 2 }
  | { kind: 'field' };

type BoxKind = 'primary' | 'secondary' | 'equipment' | 'perks' | 'streaks' | 'field';

interface TabDef {
  readonly label: string;
  readonly list: ListKind;
}

interface BoxDef {
  readonly kind: BoxKind;
  readonly label: string;
  readonly tabs: readonly TabDef[];
}

const BOXES: readonly BoxDef[] = [
  {
    kind: 'primary',
    label: 'Primary',
    tabs: [
      { label: 'WEAPON', list: { kind: 'weapon', slot: 'primary' } },
      { label: 'ATTACHMENTS', list: { kind: 'attachments', slot: 'primary' } },
      { label: 'SKIN', list: { kind: 'camo', slot: 'primary' } },
    ],
  },
  {
    kind: 'secondary',
    label: 'Secondary',
    tabs: [
      { label: 'WEAPON', list: { kind: 'weapon', slot: 'secondary' } },
      { label: 'ATTACHMENTS', list: { kind: 'attachments', slot: 'secondary' } },
      { label: 'SKIN', list: { kind: 'camo', slot: 'secondary' } },
    ],
  },
  {
    kind: 'equipment',
    label: 'Equipment',
    tabs: [
      { label: 'LETHAL', list: { kind: 'lethal' } },
      { label: 'TACTICAL', list: { kind: 'tactical' } },
    ],
  },
  {
    kind: 'perks',
    label: 'Perks',
    tabs: [
      { label: 'PERK 1', list: { kind: 'perk', tier: 1 } },
      { label: 'PERK 2', list: { kind: 'perk', tier: 2 } },
      { label: 'PERK 3', list: { kind: 'perk', tier: 3 } },
    ],
  },
  {
    kind: 'streaks',
    label: 'Killstreaks',
    // Labelled with the key that spends each one (M7 playtest): six shipped streaks against
    // three keys is a collision only the loadout can resolve.
    tabs: [
      { label: 'KEY 3', list: { kind: 'streak', index: 0 } },
      { label: 'KEY 4', list: { kind: 'streak', index: 1 } },
      { label: 'KEY 5', list: { kind: 'streak', index: 2 } },
    ],
  },
  {
    kind: 'field',
    label: 'Field upgrade',
    tabs: [{ label: 'FIELD UPGRADE', list: { kind: 'field' } }],
  },
];

/** Tiles across the zone, and rows down it: two when the stat band is under them, else three. */
const PAGE_COLUMNS = 4;

/** Which weapon a list is about, for the stage's hands and the stat band. */
function weaponSlotOf(list: ListKind): WeaponSlot {
  switch (list.kind) {
    case 'weapon':
    case 'attachments':
    case 'camo':
      return list.slot;
    default:
      return 'primary';
  }
}

/** The lists whose tiles move a number the band shows. */
function showsBand(list: ListKind): boolean {
  return list.kind === 'weapon' || list.kind === 'attachments' || list.kind === 'camo';
}

export class LoadoutEditor {
  private readonly deps: LoadoutEditorDeps;
  private readonly screen: HTMLElement;
  /** The 1920x1080 box the editor is painted into (M15, A1). `screen` is the layer. */
  private readonly frame: HTMLElement;
  private readonly stats = new LoadoutStats();
  private readonly preview: WeaponPreview;
  private readonly stage: CharacterStage;
  private readonly tip: HTMLElement;
  /** The stage's one line of status, written from `tick` because the body arrives between edits. */
  private stageStatus: HTMLElement | null = null;

  private slotIndex = 0;
  /** The open box and tab, or null when the zone shows its hint. */
  private open: { box: BoxDef; tab: number; element: HTMLElement } | null = null;
  private page = 0;
  private pageCount = 1;
  /**
   * Everything on screen whose *value* can change without its *structure* changing. See the
   * class comment; this is B11's mechanism.
   */
  private readonly refreshers: (() => void)[] = [];
  private staticRefresherCount = 0;
  /** The zone the open box paints into, and the six boxes, so opening can find them. */
  private zone: HTMLElement | null = null;
  private readonly boxElements = new Map<BoxKind, HTMLElement>();
  /**
   * Which weapon the stage is holding, when it is not simply the slot's own.
   *
   * Set while the pointer or keyboard focus is on a weapon tile, so the operator holds the
   * weapon under the cursor (round 4, F15). Cleared on the way out.
   */
  private hoveredWeaponId: string | null = null;

  constructor(deps: LoadoutEditorDeps) {
    this.deps = deps;
    this.preview = new WeaponPreview({ anisotropy: deps.anisotropy });
    this.stage = new CharacterStage({ characterAssets: deps.characterAssets, anisotropy: deps.anisotropy });
    const { layer, frame } = createScreen('op-screen lo');
    this.screen = layer;
    this.frame = frame;
    this.screen.hidden = true;
    this.tip = document.createElement('div');
    this.tip.className = 'lo-tip';
    this.tip.hidden = true;
    deps.host.appendChild(this.screen);
  }

  show(): void {
    this.slotIndex = this.deps.profile.equippedIndex;
    this.open = null;
    this.page = 0;
    this.hoveredWeaponId = null;
    this.screen.hidden = false;
    this.paint();
    // B5 puts the player's pick here; until then the operator is the default body.
    this.stage.show(DEFAULT_CHARACTER_ID);
  }

  hide(): void {
    this.screen.hidden = true;
    this.hideTip();
    this.preview.release();
    this.stage.release();
  }

  /**
   * One frame of the stage and the camo preview. Driven from `Game.draw`, not from a timer
   * of its own, so a turning operator nobody is looking at is a GPU nobody asked for.
   */
  tick(dt: number): void {
    if (this.screen.hidden) return;
    this.stage.tick(dt);
    this.preview.tick(dt);
    const status = this.stageStatus;
    if (status !== null) {
      const text = this.stage.ready ? '' : 'LOADING OPERATOR…';
      if (status.textContent !== text) status.textContent = text;
    }
  }

  /**
   * Open a box by kind and tab index — for the layout probe, which measures each one, and
   * for nothing else in the product; the boxes are clicked.
   */
  openBox(kind: BoxKind, tab = 0): void {
    const box = BOXES.find((b) => b.kind === kind);
    if (box === undefined) return;
    this.showList(box, tab);
    this.refresh();
  }

  dispose(): void {
    this.preview.dispose();
    this.stage.dispose();
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

  /** Build the screen. Called from `show()` and from nowhere else — see the class comment. */
  private paint(): void {
    this.refreshers.length = 0;
    this.boxElements.clear();
    this.open = null;

    const stage = this.paintStage();
    const right = document.createElement('div');
    right.className = 'lo-right';
    const zone = document.createElement('section');
    zone.className = 'lo-zone';
    this.zone = zone;
    right.append(this.paintBoxes(), zone);
    this.paintZoneHint(zone);

    this.frame.replaceChildren(this.paintHeader(), stage, right, this.tip);
    this.staticRefresherCount = this.refreshers.length;
    this.refresh();
  }

  /** The title, the five class tabs with the slot's name, the level, and the one action. */
  private paintHeader(): HTMLElement {
    const head = document.createElement('header');
    head.className = 'lo-head';

    const titles = document.createElement('div');
    titles.className = 'lo-head__titles';
    const title = document.createElement('h1');
    title.className = 'lo-head__title';
    title.textContent = 'CREATE A CLASS';
    const sub = document.createElement('span');
    sub.className = 'op-label';
    sub.textContent = this.deps.unrestricted()
      ? 'SHOOTING RANGE — ALL CONTENT UNLOCKED, NO PROGRESS BANKED'
      : 'CUSTOMISE YOUR LOADOUT';
    titles.append(title, sub);

    head.append(titles, this.paintSlots(), this.paintLevel(), this.paintActions());
    return head;
  }

  /**
   * The five slots as tabs, the equipped one marked, and the open one's name beside them.
   *
   * Changing slot closes the open zone and refreshes; it does not repaint. The tabs, the
   * boxes and the zone are the same shape whichever class is selected — only their *values*
   * differ — so a rebuild would throw the screen away to change a dozen strings.
   */
  private paintSlots(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lo-slots';

    const tabs = document.createElement('div');
    tabs.className = 'lo-tabs';
    tabs.setAttribute('role', 'tablist');
    this.deps.profile.loadouts.forEach((_slot, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'lo-tab';
      tab.textContent = String(index + 1);
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => {
        this.slotIndex = index;
        this.closeList();
        this.refresh();
      });
      // Looked up rather than captured: `Profile.importSave` and `resetProgress` replace the
      // whole save object, and a closure holding the old slot would keep painting a class that
      // no longer exists.
      this.refreshers.push(() => {
        const on = index === this.slotIndex;
        tab.classList.toggle('is-on', on);
        tab.classList.toggle('is-equipped', index === this.deps.profile.equippedIndex);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.title = this.deps.profile.loadouts[index]?.name ?? '';
      });
      tabs.appendChild(tab);
    });

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
    // The menu is a DOM surface over a canvas that owns the keyboard: without this, typing
    // "W" in the name walks nobody, but the shortcut keys 1-5 would change the slot.
    rename.addEventListener('keydown', (e) => e.stopPropagation());
    // Written from the slot, but never over what is being typed: the field is its own writer
    // while it holds focus, and this one would fight it on every keystroke of a rename.
    this.refreshers.push(() => {
      if (document.activeElement === rename) return;
      const name = this.slot.name;
      if (rename.value !== name) rename.value = name;
    });

    const equip = button('Equip', () => {
      this.deps.profile.equipLoadout(this.slotIndex);
      this.refresh();
    });
    equip.classList.add('op-btn--quiet', 'lo-equip');
    this.refreshers.push(() => {
      const isEquipped = this.slotIndex === this.deps.profile.equippedIndex;
      equip.textContent = isEquipped ? 'Equipped' : 'Equip';
      equip.disabled = isEquipped;
    });

    wrap.append(tabs, rename, equip);
    return wrap;
  }

  /** Level, XP bar, prestige and tokens — the reason any of the rest is locked. */
  private paintLevel(): HTMLElement {
    const profile = this.deps.profile;
    const progress = levelProgress(profile.xp);

    const wrap = document.createElement('div');
    wrap.className = 'lo-level';

    const num = document.createElement('span');
    num.className = 'lo-level__num op-num';
    num.textContent = String(progress.level);
    const cap = document.createElement('span');
    cap.className = 'op-label';
    cap.textContent = profile.prestige > 0 ? `PRESTIGE ${prestigeLabel(profile.prestige)}` : 'LEVEL';

    const bar = document.createElement('div');
    bar.className = 'lo-level__bar';
    const fill = document.createElement('i');
    fill.style.transform = `scaleX(${progress.fraction.toFixed(4)})`;
    bar.appendChild(fill);

    const detail = document.createElement('span');
    detail.className = 'op-label lo-level__detail';
    detail.textContent = progress.atCap
      ? `MAX LEVEL · ${profile.unlockTokens} TOKEN(S)`
      : `${progress.into.toLocaleString()} / ${progress.span.toLocaleString()} XP TO ${progress.level + 1}`;

    const text = document.createElement('div');
    text.className = 'lo-level__text';
    text.append(cap, bar, detail);
    wrap.append(num, text);
    return wrap;
  }

  private paintActions(): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'op-actions lo-actions';
    /**
     * The one action (playtest round 4, B5): it reads "Save and exit" rather than "Back"
     * because that is what it does. There is one destination, so there is one button.
     */
    const exit = button('Save and exit', () => this.deps.onSaveAndExit());
    exit.classList.add('op-btn--primary');
    actions.appendChild(exit);
    return actions;
  }

  /** The operator on the disc, and the two arrows that turn it. */
  private paintStage(): HTMLElement {
    const wrap = document.createElement('section');
    wrap.className = 'lo-stage';

    const status = document.createElement('span');
    status.className = 'lo-stage__status op-label';
    status.textContent = 'LOADING OPERATOR…';
    this.stageStatus = status;

    const left = arrowButton('‹', 'Turn left', () => this.stage.nudge(-1));
    const right = arrowButton('›', 'Turn right', () => this.stage.nudge(1));
    const bar = document.createElement('div');
    bar.className = 'lo-stage__bar';
    bar.append(left, status, right);

    wrap.append(this.stage.canvas, bar);
    return wrap;
  }

  /** The six boxes, each showing only what is equipped. */
  private paintBoxes(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lo-boxes';
    for (const box of BOXES) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'lo-box';
      el.dataset['box'] = box.kind;

      const icon = document.createElement('span');
      icon.className = 'lo-box__icon';
      const text = document.createElement('span');
      text.className = 'lo-box__text';
      const cat = document.createElement('span');
      cat.className = 'lo-box__cat op-label';
      cat.textContent = box.label;
      const value = document.createElement('span');
      value.className = 'lo-box__value';
      text.append(cat, value);
      const chevron = document.createElement('span');
      chevron.className = 'lo-box__chevron';
      chevron.textContent = '›';
      el.append(icon, text, chevron);

      el.addEventListener('click', () => {
        if (this.open?.box === box) this.closeList();
        else this.showList(box, 0);
        this.refresh();
      });
      this.refreshers.push(() => {
        el.classList.toggle('is-open', this.open?.box === box);
        this.paintBoxValue(box, icon, value);
      });
      this.boxElements.set(box.kind, el);
      wrap.appendChild(el);
    }
    return wrap;
  }

  /**
   * What a box shows: a weapon's silhouette, name and finish; or chips, one per equipped
   * item, each with its explanation on hover (B4).
   */
  private paintBoxValue(box: BoxDef, icon: HTMLElement, value: HTMLElement): void {
    const slot = this.slot;
    const chips: { text: string; tip: string }[] = [];
    let weaponId: string | null = null;
    switch (box.kind) {
      case 'primary':
      case 'secondary': {
        const w = slot[box.kind];
        weaponId = w.weaponId;
        const def = requireWeapon(w.weaponId);
        chips.push({ text: def.name, tip: this.weaponBlurb(def) });
        chips.push({
          text: w.camo === null ? 'FACTORY FINISH' : camoDef(w.camo).name,
          tip: w.camo === null ? 'No camouflage fitted' : camoDef(w.camo).requirement,
        });
        if (w.attachments.length > 0) {
          for (const id of w.attachments) {
            const a = attachmentDef(id);
            chips.push({ text: a.name, tip: `${a.benefit} — ${a.cost}` });
          }
        }
        break;
      }
      case 'equipment':
        chips.push({ text: equipmentDef(slot.lethal).name, tip: equipmentBlurb(slot.lethal) });
        chips.push({ text: equipmentDef(slot.tactical).name, tip: equipmentBlurb(slot.tactical) });
        break;
      case 'perks':
        for (const tier of PERK_TIERS) {
          const id = slot.perks[tier - 1];
          if (id === null || id === undefined) chips.push({ text: '—', tip: `Perk ${tier}: empty` });
          else chips.push({ text: perkDef(id).name, tip: perkDef(id).blurb });
        }
        break;
      case 'streaks':
        ([0, 1, 2] as const).forEach((index) => {
          const id = slot.streaks[index];
          if (id === null || id === undefined) chips.push({ text: '—', tip: `Key ${index + 3}: empty` });
          else {
            const def = streakDef(id);
            chips.push({ text: def.name, tip: `Key ${index + 3} · costs ${def.requirement} kills · ${def.blurb}` });
          }
        });
        break;
      case 'field': {
        const def = fieldUpgradeDef(slot.fieldUpgrade);
        chips.push({ text: def.name, tip: `${def.blurb} · ${def.chargeSeconds}s charge` });
        break;
      }
    }

    // The icon: the weapon's own outline for the two weapon boxes; the category's initial
    // for the rest, there being no image assets (M12's first paragraph).
    const iconKey = weaponId ?? box.kind;
    if (icon.dataset['key'] !== iconKey) {
      icon.dataset['key'] = iconKey;
      icon.replaceChildren(
        weaponId !== null
          ? makeIconSvg(iconFor(weaponId), ICON_VIEWBOX, 'lo-box__silhouette')
          : glyph(box.label.charAt(0)),
      );
    }

    // Chips are rebuilt only when their text changes: a refresh after an unrelated edit
    // leaves them — and a tooltip open on one of them — alone.
    const key = chips.map((c) => c.text).join('');
    if (value.dataset['key'] === key) return;
    value.dataset['key'] = key;
    value.replaceChildren(
      ...chips.map((chip, i) => {
        const span = document.createElement('span');
        span.className = i === 0 ? 'lo-chip lo-chip--lead' : 'lo-chip';
        span.textContent = chip.text;
        span.tabIndex = 0;
        this.attachTip(span, () => chip.tip);
        return span;
      }),
    );
  }

  private paintZoneHint(zone: HTMLElement): void {
    const hint = document.createElement('p');
    hint.className = 'lo-zone__hint op-label';
    hint.textContent = 'Select a category to change what is equipped';
    zone.replaceChildren(hint);
    zone.classList.remove('is-open');
  }

  // -- the zone ---------------------------------------------------------------

  /** Open a box's list at a tab. Replaces whatever the zone held. */
  private showList(box: BoxDef, tab: number): void {
    const zone = this.zone;
    if (zone === null) return;
    this.closeList();
    const tabDef = box.tabs[tab] ?? box.tabs[0];
    if (tabDef === undefined) return;

    const content = document.createElement('div');
    content.className = 'lo-zone__content';

    // Tabs across the top, one per list this box holds; a single-list box shows its label.
    const tabs = document.createElement('div');
    tabs.className = 'op-tabs lo-zone__tabs';
    box.tabs.forEach((t, index) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'op-tab';
      b.classList.toggle('op-tab--on', index === tab);
      b.textContent = t.label;
      b.addEventListener('click', () => {
        this.showList(box, index);
        this.refresh();
      });
      tabs.appendChild(b);
    });

    const withBand = showsBand(tabDef.list);
    const rows = withBand ? 2 : 3;
    const pageSize = PAGE_COLUMNS * rows;
    const tiles = document.createElement('div');
    tiles.className = 'lo-tiles';
    tiles.style.setProperty('--lo-tile-rows', String(rows));
    const options = this.optionsFor(tabDef.list);
    for (const option of options) tiles.appendChild(option);
    this.page = 0;
    this.pageCount = Math.max(1, Math.ceil(options.length / pageSize));

    // The pager shares the tabs' row, at its right end: a row of its own was 28 px the zone
    // did not have under two rows of tiles and the band.
    tabs.appendChild(this.paintPager(options, pageSize));

    content.append(tabs, tiles);
    if (withBand) {
      const band = document.createElement('div');
      band.className = 'lo-zone__band';
      // The finish is shown on the preview; the numbers under everything else.
      band.appendChild(tabDef.list.kind === 'camo' ? this.preview.element : this.stats.element);
      content.appendChild(band);
    }

    zone.replaceChildren(content);
    zone.classList.add('is-open');
    this.open = { box, tab, element: content };
  }

  /** The page arrows and the count. Hidden when everything fits on one page. */
  private paintPager(options: readonly HTMLElement[], pageSize: number): HTMLElement {
    const pager = document.createElement('div');
    pager.className = 'lo-pager';
    const prev = arrowButton('‹', 'Previous page', () => {
      this.page = Math.max(0, this.page - 1);
      this.refresh();
    });
    const next = arrowButton('›', 'Next page', () => {
      this.page = Math.min(this.pageCount - 1, this.page + 1);
      this.refresh();
    });
    const count = document.createElement('span');
    count.className = 'lo-pager__count op-label';
    pager.append(prev, count, next);
    this.refreshers.push(() => {
      pager.hidden = this.pageCount <= 1;
      prev.disabled = this.page === 0;
      next.disabled = this.page >= this.pageCount - 1;
      count.textContent = `${this.page + 1} / ${this.pageCount}`;
      options.forEach((el, i) => {
        el.hidden = Math.floor(i / pageSize) !== this.page;
      });
    });
    return pager;
  }

  /**
   * Close the zone, and forget the refreshers that belonged to it.
   *
   * The tiles of a closed list are gone from the document, so a closure still holding one is
   * work done on a detached node — harmless, and exactly the kind of quiet accumulation that
   * turns into a leak. `refreshers` is truncated back to the length it had before the list
   * opened, which is possible because a list's refreshers are always appended last.
   */
  private closeList(): void {
    const open = this.open;
    if (open === null) return;
    open.element.remove();
    // The band's two panels are long-lived elements; take them out of the removed subtree.
    this.stats.element.remove();
    this.preview.element.remove();
    this.open = null;
    this.refreshers.length = this.staticRefresherCount;
    this.hoveredWeaponId = null;
    if (this.zone !== null) this.paintZoneHint(this.zone);
  }

  private optionsFor(list: ListKind): HTMLElement[] {
    const unlocks = this.deps.profile.unlocks;
    const free = this.deps.unrestricted();
    const out: HTMLElement[] = [];

    switch (list.kind) {
      case 'weapon': {
        const which = list.slot;
        for (const def of ALL_WEAPONS) {
          // The secondary slot takes sidearms, and primaries too once Overkill is on —
          // which is the entire perk, expressed as a filter rather than as a special case.
          if (which === 'secondary' && def.slot === 'primary' && !this.slot.perks.includes('overkill')) {
            continue;
          }
          if (which === 'primary' && def.slot === 'secondary') continue;
          const el = this.tile(
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
          // F15: the operator holds the weapon under the cursor, so "the weapon you are
          // choosing" is visible before the choice is made rather than after it.
          this.holdOnHover(el, def.id);
          out.push(el);
        }
        break;
      }

      case 'attachments': {
        const which = list.slot;
        const def = requireWeapon(this.slot[which].weaponId);
        for (const id of attachmentsForWeapon(def)) {
          const attachment = attachmentDef(id);
          out.push(
            this.tile(
              attachment.name,
              () => `${attachment.benefit} — ${attachment.cost}`,
              () => this.slot[which].attachments.includes(id),
              () => !free && !unlocks.attachmentUnlocked(def.id, id),
              () => unlocks.attachmentRequirement(def.id, id),
              () =>
                this.edit((s) => {
                  const held = s[which].attachments;
                  const at = held.indexOf(id);
                  if (at >= 0) held.splice(at, 1);
                  else held.push(id);
                }),
            ),
          );
        }
        if (out.length === 0) out.push(emptyNote('This weapon takes no attachments'));
        break;
      }

      case 'camo': {
        const which = list.slot;
        out.push(
          this.tile(
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
            this.tile(
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
         * The unlock level, which this list did not draw (playtest round 4, B7): every
         * requirement on this screen comes from `UnlockState`, and `scripts/check-unlocks.mjs`
         * fails if a category stops asking.
         */
        const wantSlot = list.kind;
        for (const eq of ALL_EQUIPMENT) {
          if (eq.slot !== wantSlot) continue;
          out.push(
            this.tile(
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
        const tier = list.tier;
        out.push(
          this.tile(
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
            this.tile(
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
          this.tile(
            'NONE',
            () => 'Leave this key empty',
            () => this.slot.streaks[list.index] == null,
            () => false,
            () => '',
            () =>
              this.edit((s) => {
                s.streaks[list.index] = null;
              }),
          ),
        );
        for (const def of STREAK_DEFS) {
          out.push(
            this.tile(
              def.name,
              // "Costs", not "at": after round 4's B9 the number is a price that is debited
              // from a balance, not a threshold that opens something and stays crossed.
              () => `Costs ${def.requirement} kills · ${def.blurb}`,
              () => this.slot.streaks[list.index] === def.id,
              // A streak already on another key is shown but not selectable: equipping the
              // same one twice would waste a key and is never what somebody meant to do.
              () => this.slot.streaks.some((held, i) => held === def.id && i !== list.index),
              () => 'ON ANOTHER KEY',
              () =>
                this.edit((s) => {
                  s.streaks[list.index] = def.id;
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
            this.tile(
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
   * One tile, and the closure that keeps it current.
   *
   * Every argument past the label is a *predicate* rather than a value, which is the whole of
   * the B11 fix at this level: the element is built once and the closure decides what it says
   * this frame. `apply` is bound once and guarded by the same `locked` predicate the class is
   * drawn from, so a tile that becomes locked stops responding without being rebuilt.
   */
  private tile(
    name: string,
    blurb: () => string,
    on: () => boolean,
    locked: () => boolean,
    requirement: () => string,
    apply: () => void,
  ): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'lo-tile';

    const label = document.createElement('span');
    label.className = 'lo-tile__name';
    label.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'lo-tile__blurb';
    el.append(label, detail);
    el.addEventListener('click', () => {
      if (locked()) return;
      apply();
    });

    this.refreshers.push(() => {
      const isLocked = locked();
      const need = requirement();
      el.classList.toggle('is-on', on());
      el.classList.toggle('is-locked', isLocked);
      el.disabled = isLocked;
      detail.textContent = isLocked && need.length > 0 ? `${need} — ${blurb()}` : blurb();
    });
    return el;
  }

  /** Put a weapon in the operator's hands while the pointer or the keyboard is on its tile. */
  private holdOnHover(el: HTMLElement, weaponId: string): void {
    const enter = (): void => {
      this.hoveredWeaponId = weaponId;
      this.refreshStage();
    };
    const leave = (): void => {
      if (this.hoveredWeaponId !== weaponId) return;
      this.hoveredWeaponId = null;
      this.refreshStage();
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('focus', enter);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('blur', leave);
  }

  // -- the tooltip (B4) --------------------------------------------------------

  /**
   * One tooltip for the screen, moved to whatever is hovered or focused.
   *
   * Positioned in frame pixels — the rects come back in window pixels and the frame is
   * zoomed, so the division by the frame's scale is what puts it where the chip is — and
   * flipped above the chip when below would leave the frame, which is a rect test rather
   * than a guess.
   */
  private attachTip(el: HTMLElement, text: () => string): void {
    const show = (): void => this.showTip(el, text());
    const hide = (): void => this.hideTip();
    el.addEventListener('pointerenter', show);
    el.addEventListener('focus', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('blur', hide);
  }

  private showTip(anchor: HTMLElement, text: string): void {
    const tip = this.tip;
    const frameRect = this.frame.getBoundingClientRect();
    const scale = frameRect.width / 1920 || 1;
    const a = anchor.getBoundingClientRect();
    tip.textContent = text;
    tip.hidden = false;
    // Measure after the text is set: the tip's size is the text's.
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const frameW = 1920;
    const frameH = frameRect.height / scale;
    const anchorLeft = (a.left - frameRect.left) / scale;
    const anchorTop = (a.top - frameRect.top) / scale;
    const anchorBottom = (a.bottom - frameRect.top) / scale;
    let left = anchorLeft;
    if (left + w > frameW - 16) left = Math.max(16, frameW - 16 - w);
    let top = anchorBottom + 8;
    tip.classList.remove('is-above');
    if (top + h > frameH - 16) {
      top = anchorTop - h - 8;
      tip.classList.add('is-above');
    }
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  private hideTip(): void {
    this.tip.hidden = true;
  }

  // -- state ---------------------------------------------------------------------

  private edit(mutate: (slot: LoadoutSlot) => void): void {
    if (this.deps.unrestricted()) {
      mutate(this.deps.profile.rangeLoadout());
      this.deps.profile.flush();
    } else {
      this.deps.profile.editLoadout(this.slotIndex, mutate);
    }
    this.refresh();
  }

  /** Every mutable value on screen, from the state that produced it. No DOM is created here. */
  private refresh(): void {
    for (const fn of this.refreshers) fn();
    this.refreshStats();
    this.refreshStage();
  }

  /**
   * Repaint the band from a fresh resolve.
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
   * What the operator holds and what the camo preview shows.
   *
   * The hands: the weapon under the cursor, or the open box's own, or the primary. The
   * preview: the open weapon box's equipped weapon in its finish — a hovered weapon has not
   * been equipped, so painting the class's finish onto it would show a combination that does
   * not exist, and the preview is only on screen for the SKIN tab anyway.
   */
  private refreshStage(): void {
    if (this.screen.hidden) return;
    const list = this.open === null ? null : (this.open.box.tabs[this.open.tab]?.list ?? null);
    const which = list === null ? 'primary' : weaponSlotOf(list);
    const equipped = this.slot[which];
    this.stage.setWeapon(this.hoveredWeaponId ?? equipped.weaponId);
    if (list !== null && list.kind === 'camo') {
      this.preview.show(equipped.weaponId, equipped.camo, requireWeapon(equipped.weaponId).name);
    }
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

function arrowButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lo-arrow';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function glyph(letter: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'lo-box__glyph';
  el.textContent = letter;
  return el;
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
