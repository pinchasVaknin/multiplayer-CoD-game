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
import { BOT_CHARACTER_IDS, characterDefinition } from '../characters/CharacterCatalog';
import { categoryIcon, CATEGORY_VIEWBOX, type CategoryIconId } from './CategoryIcons';
import { CharacterStage } from './CharacterStage';
import { createScreen } from './Frame';
import { LoadoutStats } from './LoadoutStats';
import { ICON_VIEWBOX, iconFor, makeIconSvg } from './WeaponIcons';
import { WeaponPreview } from './WeaponPreview';

/**
 * Create-a-Class (brief S6.3; rebuilt on the design frame by M15, Phase B): the `LOADOUT`
 * state's screen.
 *
 * ## The shape (round 2, 2026-09-15)
 *
 * The operator on a lit disc on the left — the player's skin, holding the class's primary,
 * turning, the same `ActorAvatar` a match draws (`CharacterStage`) — and on the right **one
 * list**. Closed, the list is the six **category bars**, each showing only what is equipped:
 * PRIMARY, SECONDARY, EQUIPMENT (lethal and tactical), PERKS (three), KILLSTREAKS (three, each
 * with its key), FIELD UPGRADE — with the equipped weapon's silhouette or the category's
 * glyph at twice B2's size. Clicking a bar **replaces the whole list** with that category's
 * options, in the same bar shape, each with its own picture, name, blurb and state; a row of
 * tabs stands over the list where a category holds more than one thing to choose — WEAPON /
 * ATTACHMENTS / SKIN for the two weapons, LETHAL / TACTICAL, PERK 1 / 2 / 3, KEY 3 / 4 / 5 —
 * and a pager beside them, because a list longer than the column is **paged**, never
 * scrolled. The five class slots are tabs across the top, with the slot's name beside them.
 *
 * ## Three states, and the stage answers the list
 *
 * A bar is grey-white at rest (a vertical gradient through the letters, which is as metallic
 * as type gets without an image), grows a few percent and whitens under the pointer — the
 * whole bar, picture included, with a gap between bars so the grown one covers nothing — and
 * takes the accent when it is the equipped option or the open category. A press changes its
 * colour and nothing else: a bar that shrinks under the pointer has to know when the pointer
 * left it, and that is a state machine for a button.
 *
 * While a weapon category is open the **weapon stands on the stage** where the operator did —
 * the `WeaponPreview` at stage size, spinning, showing the weapon under the pointer or the
 * equipped one in its finish — and SAVE / CANCEL stand under it: SAVE keeps what was picked
 * and returns to the categories; CANCEL puts the class back the way it was when the category
 * opened. The other categories keep the operator on the stage, there being no grenade or
 * perk to stand there (no assets, M12's first paragraph).
 *
 * ## What each box still means
 *
 * Every edit goes through `Profile.editLoadout`, which sanitises and persists — so the gating
 * this screen draws is a *courtesy*, and the enforcement is `sanitiseLoadout` behind it.
 * Locked content is drawn with its requirement rather than hidden (M5's rule); every
 * requirement comes from `UnlockState` (round 4, B7). `LoadoutStats`, *"the point of the
 * screen"* (M6), is a band under the weapon lists: the same `resolveLoadout` the match makes,
 * on every edit. The SKIN tab (the reference's word for what this project has called camo
 * since M5 — the label changed, `CamoId` did not) shows the finish on the weapon standing on
 * the stage, because a held weapon is one shared material and does not carry a camo.
 *
 * ## Built once, refreshed in place (playtest round 4, B11 — the mechanism, kept)
 *
 * `paint()` runs once per `show()`. Every mutable piece registers a closure in `refreshers`
 * and `refresh()` runs them; opening a category appends its list's closures after
 * `staticRefresherCount` and closing it truncates back. B11 built this so a scrolled list
 * survived an edit; there is no scroll now, and the test is that the open list's *page*
 * survives one. A rebuilt tree would also be a lost tooltip and a jumped list.
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
  /** Whether the skin strip is open over the stage's foot (B5). */
  private skinsOpen = false;

  private slotIndex = 0;
  /**
   * The open category and tab, or null when the list shows the categories. `snapshot` is the
   * class as it was when the category opened, for CANCEL.
   */
  private open: { box: BoxDef; tab: number; snapshot: LoadoutSlot } | null = null;
  private page = 0;
  private pageCount = 1;
  /**
   * Everything on screen whose *value* can change without its *structure* changing. See the
   * class comment; this is B11's mechanism.
   */
  private readonly refreshers: (() => void)[] = [];
  private staticRefresherCount = 0;
  /** The list's three parts: the head (label, tabs, pager), the categories, the options. */
  private listHead: HTMLElement | null = null;
  private cats: HTMLElement | null = null;
  private opts: HTMLElement | null = null;
  /** The stat band under the list, shown for the weapon lists. */
  private band: HTMLElement | null = null;
  /** The stage's parts the weapon preview replaces, and the SAVE / CANCEL row. */
  private stageParts: HTMLElement[] = [];
  private stageBar: HTMLElement | null = null;
  private stageActions: HTMLElement | null = null;
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
    this.preview = new WeaponPreview({
      anisotropy: deps.anisotropy,
      width: STAGE_PREVIEW_WIDTH,
      height: STAGE_PREVIEW_HEIGHT,
      className: 'lo-preview--stage',
    });
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
    this.skinsOpen = false;
    this.paint();
    this.stage.show(this.deps.profile.skinId);
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
    if (this.weaponOnStage()) this.preview.tick(dt);
    else this.stage.tick(dt);
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
    this.openCategory(box, tab);
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

    const head = document.createElement('div');
    head.className = 'lo-list-head';
    head.hidden = true;
    this.listHead = head;

    const list = document.createElement('div');
    list.className = 'lo-list';
    const cats = this.paintCategories();
    const opts = document.createElement('div');
    opts.className = 'lo-opts';
    opts.hidden = true;
    this.cats = cats;
    this.opts = opts;
    list.append(cats, opts);

    const band = document.createElement('div');
    band.className = 'lo-band';
    band.hidden = true;
    band.appendChild(this.stats.element);
    this.band = band;

    right.append(head, list, band);

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

    const skins = this.paintSkins();
    // The operator's three parts, hidden together while a weapon stands in their place; the
    // arrow bar also steps aside for SAVE / CANCEL while a category is open (a drag still turns).
    this.stageParts = [this.stage.canvas, skins, bar];
    this.stageBar = bar;

    // SAVE keeps the picks and returns to the categories; CANCEL restores the snapshot first.
    const actions = document.createElement('div');
    actions.className = 'op-actions lo-stage__actions';
    actions.hidden = true;
    const cancel = button('Cancel', () => this.cancelCategory());
    cancel.classList.add('op-btn--quiet');
    const save = button('Save', () => this.saveCategory());
    save.classList.add('op-btn--primary');
    actions.append(cancel, save);
    this.stageActions = actions;

    wrap.append(this.stage.canvas, this.preview.element, skins, bar, actions);
    return wrap;
  }

  /**
   * CHANGE A SKIN (B5): a bar over the stage's foot, and the strip of every skin it opens.
   *
   * The strip lies *over* the canvas rather than under the bar, so the column's height never
   * changes and the frame never has to. The thumbnails are `scripts/skin-thumbs.mjs`'s renders
   * — seven live stages would be seven contexts and the whole library fetched to open a menu.
   * Picking writes the profile (a setting, kept across a progress reset like the callsign) and
   * puts the new body on the disc; other players see the dealt body until B6 (decision 2).
   */
  private paintSkins(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lo-skins';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lo-skins__toggle';
    const label = document.createElement('span');
    label.textContent = 'CHANGE A SKIN';
    const chevron = document.createElement('span');
    chevron.className = 'lo-skins__chevron';
    chevron.textContent = '›';
    toggle.append(label, chevron);
    toggle.addEventListener('click', () => {
      this.skinsOpen = !this.skinsOpen;
      this.refresh();
    });

    const strip = document.createElement('div');
    strip.className = 'lo-skins__strip';
    strip.setAttribute('role', 'listbox');
    strip.setAttribute('aria-label', 'Skins');
    for (const id of BOT_CHARACTER_IDS) {
      const def = characterDefinition(id);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'lo-skin';
      tile.setAttribute('role', 'option');
      const img = document.createElement('img');
      img.className = 'lo-skin__thumb';
      img.src = def.thumbUrl;
      img.alt = '';
      img.draggable = false;
      const name = document.createElement('span');
      name.className = 'lo-skin__name';
      name.textContent = def.name;
      tile.append(img, name);
      tile.addEventListener('click', () => {
        this.deps.profile.setSkin(id);
        this.stage.show(id);
        this.refresh();
      });
      this.refreshers.push(() => {
        const on = this.deps.profile.skinId === id;
        tile.classList.toggle('is-on', on);
        tile.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      strip.appendChild(tile);
    }

    this.refreshers.push(() => {
      wrap.classList.toggle('is-open', this.skinsOpen);
      toggle.setAttribute('aria-expanded', this.skinsOpen ? 'true' : 'false');
      strip.hidden = !this.skinsOpen;
    });

    wrap.append(toggle, strip);
    return wrap;
  }

  /** Open the skin strip — for the layout probe, which measures it. */
  openSkins(): void {
    this.skinsOpen = true;
    this.refresh();
  }

  /** The six category bars, each showing only what is equipped. Clicking one opens its list. */
  private paintCategories(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lo-cats';
    for (const box of BOXES) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'lo-bar lo-bar--cat';
      el.dataset['box'] = box.kind;

      const icon = document.createElement('span');
      icon.className = 'lo-bar__icon';
      const text = document.createElement('span');
      text.className = 'lo-bar__text';
      const cat = document.createElement('span');
      cat.className = 'lo-bar__cat op-label';
      cat.textContent = box.label;
      const value = document.createElement('span');
      value.className = 'lo-bar__value';
      text.append(cat, value);
      const chevron = document.createElement('span');
      chevron.className = 'lo-bar__chevron';
      chevron.textContent = '›';
      el.append(icon, text, chevron);

      el.addEventListener('click', () => {
        this.openCategory(box, 0);
        this.refresh();
      });
      this.refreshers.push(() => this.paintBoxValue(box, icon, value));
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

    // The icon: the weapon's own outline for the two weapon bars; the category's glyph for
    // the rest (`CategoryIcons`), there being no image assets (M12's first paragraph).
    const iconKey = weaponId ?? box.kind;
    if (icon.dataset['key'] !== iconKey) {
      icon.dataset['key'] = iconKey;
      icon.replaceChildren(
        weaponId !== null
          ? makeIconSvg(iconFor(weaponId), ICON_VIEWBOX, 'lo-bar__silhouette')
          : makeIconSvg(categoryIcon(CATEGORY_GLYPH[box.kind]), CATEGORY_VIEWBOX, 'lo-bar__glyph'),
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
        span.className = i === 0 ? 'lo-chip lo-chip--lead lo-metal' : 'lo-chip';
        span.textContent = chip.text;
        span.tabIndex = 0;
        this.attachTip(span, () => chip.tip);
        return span;
      }),
    );
  }

  // -- the list ---------------------------------------------------------------

  /**
   * Open a category at a tab: the list becomes that category's options, the head its label,
   * tabs and pager, the band its numbers where they apply. Switching tabs within the open
   * category keeps its snapshot; opening another takes a fresh one.
   */
  private openCategory(box: BoxDef, tab: number): void {
    const head = this.listHead;
    const opts = this.opts;
    const cats = this.cats;
    if (head === null || opts === null || cats === null) return;
    const snapshot = this.open?.box === box ? this.open.snapshot : cloneSlot(this.slot);
    this.closeList(false);
    const tabDef = box.tabs[tab] ?? box.tabs[0];
    if (tabDef === undefined) return;

    // The head: the category, its tabs, and the pager at the right end.
    const label = document.createElement('span');
    label.className = 'lo-list-head__label op-label';
    label.textContent = box.label;
    const tabs = document.createElement('div');
    tabs.className = 'op-tabs lo-list-head__tabs';
    box.tabs.forEach((t, index) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'op-tab';
      b.classList.toggle('op-tab--on', index === tab);
      b.textContent = t.label;
      b.addEventListener('click', () => {
        this.openCategory(box, index);
        this.refresh();
      });
      tabs.appendChild(b);
    });

    const withBand = showsBand(tabDef.list);
    const pageSize = withBand ? PAGE_WITH_BAND : PAGE_FULL;
    const options = this.optionsFor(tabDef.list);
    opts.replaceChildren(...options);
    this.page = 0;
    this.pageCount = Math.max(1, Math.ceil(options.length / pageSize));
    head.replaceChildren(label, tabs, this.paintPager(options, pageSize));

    head.hidden = false;
    cats.hidden = true;
    opts.hidden = false;
    if (this.band !== null) this.band.hidden = !withBand;
    this.open = { box, tab, snapshot };
  }

  /** SAVE: the picks stand; back to the categories. */
  private saveCategory(): void {
    this.closeList();
    this.refresh();
  }

  /** CANCEL: the class as it was when the category opened; back to the categories. */
  private cancelCategory(): void {
    const open = this.open;
    if (open === null) return;
    this.edit((slot) => assignSlot(slot, open.snapshot));
    this.closeList();
    this.refresh();
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
  private closeList(showCategories = true): void {
    const open = this.open;
    if (open === null) return;
    this.opts?.replaceChildren();
    this.open = null;
    this.refreshers.length = this.staticRefresherCount;
    this.hoveredWeaponId = null;
    if (!showCategories) return;
    if (this.listHead !== null) this.listHead.hidden = true;
    if (this.opts !== null) this.opts.hidden = true;
    if (this.cats !== null) this.cats.hidden = false;
    if (this.band !== null) this.band.hidden = true;
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
            makeIconSvg(iconFor(def.id), ICON_VIEWBOX, 'lo-bar__silhouette'),
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
              glyphIcon('attachment'),
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
            glyphIcon('camo'),
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
              glyphIcon('camo'),
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
              glyphIcon(eq.id === 'smoke' ? 'smoke' : wantSlot === 'lethal' ? 'lethal' : 'tactical'),
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
            glyphIcon('perk'),
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
              glyphIcon('perk'),
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
            glyphIcon('streak'),
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
              glyphIcon('streak'),
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
              glyphIcon('field'),
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
    icon: SVGSVGElement,
  ): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'lo-bar lo-bar--opt';

    const picture = document.createElement('span');
    picture.className = 'lo-bar__icon';
    picture.appendChild(icon);
    const text = document.createElement('span');
    text.className = 'lo-bar__text';
    const label = document.createElement('span');
    label.className = 'lo-bar__name lo-metal';
    label.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'lo-bar__blurb';
    text.append(label, detail);
    const state = document.createElement('span');
    state.className = 'lo-bar__state op-label';
    el.append(picture, text, state);
    el.addEventListener('click', () => {
      if (locked()) return;
      apply();
    });

    this.refreshers.push(() => {
      const isLocked = locked();
      const need = requirement();
      const isOn = on();
      el.classList.toggle('is-on', isOn);
      el.classList.toggle('is-locked', isLocked);
      el.disabled = isLocked;
      detail.textContent = blurb();
      state.textContent = isLocked ? need : isOn ? 'EQUIPPED' : '';
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
    const onStage = this.weaponOnStage();

    for (const part of this.stageParts) part.hidden = onStage;
    if (this.stageBar !== null) this.stageBar.hidden = onStage || this.open !== null;
    this.preview.element.hidden = !onStage;
    if (this.stageActions !== null) this.stageActions.hidden = this.open === null;

    if (onStage) {
      // The weapon under the pointer, or the equipped one — in its finish only when it is the
      // equipped one, because a hovered weapon has not been given this class's camo.
      const shown = this.hoveredWeaponId ?? equipped.weaponId;
      const camo = shown === equipped.weaponId ? equipped.camo : null;
      this.preview.show(shown, camo, requireWeapon(shown).name);
    } else {
      this.preview.release();
      this.stage.setWeapon(equipped.weaponId);
    }
  }

  /** Whether the open list is one of the two weapons', which is when the weapon takes the stage. */
  private weaponOnStage(): boolean {
    const list = this.open === null ? null : (this.open.box.tabs[this.open.tab]?.list ?? null);
    return list !== null && showsBand(list);
  }
}

/** Design-frame pixels of the weapon preview on the stage: the stage's width, at the band's aspect. */
const STAGE_PREVIEW_WIDTH = 860;
const STAGE_PREVIEW_HEIGHT = 480;

/** Option bars a page holds: with the stat band under the list, and without. */
const PAGE_WITH_BAND = 7;
const PAGE_FULL = 8;

/** The glyph a category bar shows when it has no weapon to show. */
const CATEGORY_GLYPH: Readonly<Record<BoxKind, CategoryIconId>> = {
  primary: 'attachment',
  secondary: 'attachment',
  equipment: 'equipment',
  perks: 'perk',
  streaks: 'streak',
  field: 'field',
};

function glyphIcon(id: CategoryIconId): SVGSVGElement {
  return makeIconSvg(categoryIcon(id), CATEGORY_VIEWBOX, 'lo-bar__glyph');
}

/** A copy of a class deep enough to restore from: every array its own. */
function cloneSlot(slot: LoadoutSlot): LoadoutSlot {
  return {
    name: slot.name,
    primary: { weaponId: slot.primary.weaponId, attachments: [...slot.primary.attachments], camo: slot.primary.camo },
    secondary: { weaponId: slot.secondary.weaponId, attachments: [...slot.secondary.attachments], camo: slot.secondary.camo },
    lethal: slot.lethal,
    tactical: slot.tactical,
    perks: [...slot.perks],
    fieldUpgrade: slot.fieldUpgrade,
    streaks: [...slot.streaks],
  };
}

/** Put `from` into `target` in place: the profile owns `target`, so it is written, not replaced. */
function assignSlot(target: LoadoutSlot, from: LoadoutSlot): void {
  target.name = from.name;
  target.primary.weaponId = from.primary.weaponId;
  target.primary.attachments = [...from.primary.attachments];
  target.primary.camo = from.primary.camo;
  target.secondary.weaponId = from.secondary.weaponId;
  target.secondary.attachments = [...from.secondary.attachments];
  target.secondary.camo = from.secondary.camo;
  target.lethal = from.lethal;
  target.tactical = from.tactical;
  target.perks = [...from.perks];
  target.fieldUpgrade = from.fieldUpgrade;
  target.streaks = [...from.streaks];
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
