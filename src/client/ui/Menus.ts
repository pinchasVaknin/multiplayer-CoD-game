import { inputLabel, type ActionId, type BindingMap } from '../../shared/core/Keybinds';
import type { GameModeId } from '../../shared/modes/GameMode';
import { MAPS, MODES, modesForMap } from '../../shared/modes/ModeRegistry';


/**
 * The front end (brief S6.7): main -> play -> match.
 *
 * "It does not need to be elaborate, but it must not look like unstyled HTML." So it is two
 * pages, every value resolved from the design tokens in `styles/tokens.css`, and the mode and
 * map lists are built from `ModeRegistry` rather than hardcoded — a new mode in M7 appears
 * here for free, and a mode that only exists in this file could never be played.
 *
 * Pointer lock can only be requested from a user gesture, so the button that starts a match
 * is genuinely load-bearing rather than a formality.
 */

export interface MenuSelection {
  modeId: GameModeId;
  mapId: string;
}

export interface MenuDeps {
  readonly host: HTMLElement;
  readonly selection: MenuSelection;
  readonly onLaunch: () => void;
  /** M6: enter the `LOADOUT` state. */
  readonly onLoadout: () => void;
  /** M8: enter the `SETTINGS` state. */
  readonly onSettings: () => void;
  /** M6: wipe the profile. The confirmation is this file's, the wipe is `Profile`'s. */
  readonly onResetProgress: () => void;
  /** Shown under the title: build stats, or whatever the caller wants to say. */
  readonly statusLine: () => string;
  /** M6: level, class and record. Redrawn every time the menu is shown. */
  readonly profileLine: () => string;
  /** M8: the live binding table, so the controls card names the player's own keys. */
  readonly bindings: () => BindingMap;
}

type Page = 'MAIN' | 'PLAY';

/**
 * The controls card, built from the player's actual bindings (M8).
 *
 * It used to be a hard-coded list, which was fine until S6.3 made every key reassignable —
 * at which point a card that still said "W A S D" for a player who had moved to the arrow
 * keys would be worse than no card at all. Each row names the actions it summarises and the
 * card resolves them through `Keybinds`, so it is correct by construction.
 *
 * The last three rows are chords and modifiers rather than single actions, so they are
 * composed from the bindings of their parts.
 */
const CONTROL_ROWS: readonly Readonly<{ actions: readonly ActionId[]; label: string }>[] = [
  { actions: ['moveForward', 'moveLeft', 'moveBack', 'moveRight'], label: 'Move' },
  { actions: ['sprint'], label: 'Sprint (double-tap for tactical)' },
  { actions: ['crouch'], label: 'Crouch (with sprint, slide)' },
  { actions: ['jump'], label: 'Jump / mantle' },
  { actions: ['fire'], label: 'Fire' },
  { actions: ['ads'], label: 'Aim down sights' },
  { actions: ['reload'], label: 'Reload' },
  { actions: ['swapWeapon', 'slot1', 'slot2'], label: 'Swap weapon' },
  { actions: ['lethal', 'tactical'], label: 'Lethal / tactical' },
  { actions: ['fieldUpgrade'], label: 'Field upgrade' },
  { actions: ['streak1', 'streak2', 'streak3'], label: 'Killstreaks' },
  { actions: ['use'], label: 'Use / plant / defuse' },
  { actions: ['scoreboard'], label: 'Scoreboard' },
];

/**
 * `Ctrl+W` closes a browser tab and no amount of `preventDefault` stops it; only the Keyboard
 * Lock API can, and only while the page is fullscreen. Saying so on the menu is better than
 * letting a player discover it mid-slide. See PLAN.md.
 */
const FULLSCREEN_HINT = 'F11 for fullscreen — required to capture Ctrl+W (crouch + forward)';

export class Menus {
  private readonly deps: MenuDeps;
  private readonly screen: HTMLElement;
  private page: Page = 'MAIN';
  /** Whether the reset button is one click from doing it. Cleared on every `show`. */
  private resetArmed = false;

  constructor(deps: MenuDeps) {
    this.deps = deps;
    this.screen = document.createElement('div');
    this.screen.className = 'op-screen';
    this.screen.hidden = true;
    deps.host.appendChild(this.screen);
  }

  showBoot(message: string): void {
    this.page = 'MAIN';
    this.screen.hidden = false;
    this.screen.replaceChildren(title('OPERATOR'), subtitle(message));
  }

  /** Open the front end at its main page. */
  show(): void {
    this.page = 'MAIN';
    this.resetArmed = false;
    this.screen.hidden = false;
    this.paint();
  }

  hide(): void {
    this.screen.hidden = true;
  }

  get isVisible(): boolean {
    return !this.screen.hidden;
  }

  dispose(): void {
    this.screen.remove();
  }

  // -- pages -----------------------------------------------------------------

  private paint(): void {
    if (this.page === 'MAIN') this.paintMain();
    else this.paintPlay();
  }

  private paintMain(): void {
    const play = this.button('Play', () => {
      this.page = 'PLAY';
      this.paint();
    });
    play.classList.add('op-btn--primary');

    const loadout = this.button('Create a class', () => this.deps.onLoadout());
    const settings = this.button('Settings', () => this.deps.onSettings());

    const bindings = this.deps.bindings();
    const keys = document.createElement('dl');
    keys.className = 'op-keys';
    for (const row of CONTROL_ROWS) {
      // Only the first binding of each action: the card is a reminder, not the settings
      // screen, and a row reading "L Ctrl / C / L Shift" helps nobody.
      const combo = row.actions
        .map((id) => bindings[id]?.[0])
        .filter((input): input is string => input !== undefined)
        .map(inputLabel)
        .join(' ');
      if (combo === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = combo;
      const dd = document.createElement('dd');
      dd.textContent = row.label;
      keys.append(dt, dd);
    }
    const esc = document.createElement('dt');
    esc.textContent = 'Esc';
    const escLabel = document.createElement('dd');
    escLabel.textContent = 'Pause';
    keys.append(esc, escLabel);

    const profile = document.createElement('p');
    profile.className = 'op-screen__sub op-accent';
    profile.textContent = this.deps.profileLine();

    this.screen.replaceChildren(
      title('OPERATOR'),
      subtitle(this.deps.statusLine()),
      profile,
      play,
      loadout,
      settings,
      keys,
      subtitle(FULLSCREEN_HINT),
      this.resetControl(),
    );
    play.focus();
  }

  /**
   * "Reset progress", behind a confirmation (S6.6).
   *
   * A two-step button rather than a `window.confirm`: the page owns pointer lock and a
   * native modal steals focus in a way the input layer then has to recover from. The
   * second press has to be a deliberate second click, and clicking anything else — or
   * re-entering the menu — puts it back.
   */
  private resetControl(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'op-danger';
    const button = this.button(
      this.resetArmed ? 'Confirm — erase all progress' : 'Reset progress',
      () => {
        if (!this.resetArmed) {
          this.resetArmed = true;
          this.paint();
          return;
        }
        this.resetArmed = false;
        this.deps.onResetProgress();
        this.paint();
      },
    );
    button.classList.add(this.resetArmed ? 'op-btn--danger' : 'op-btn--quiet');
    wrap.appendChild(button);
    if (this.resetArmed) {
      const warn = document.createElement('span');
      warn.className = 'op-label';
      warn.textContent = 'LEVEL, UNLOCKS, CAMOS AND CLASSES. SETTINGS ARE KEPT.';
      wrap.appendChild(warn);
    }
    return wrap;
  }

  private paintPlay(): void {
    const modeList = this.picker(
      'Mode',
      // Only what this map can run: Domination needs flags and S&D needs bomb sites, and
      // offering a mode whose objectives the map does not author throws on match build.
      modesForMap(this.deps.selection.mapId).map((m) => ({ id: m.id, name: m.name, blurb: m.blurb })),
      this.deps.selection.modeId,
      (id) => {
        this.deps.selection.modeId = id as GameModeId;
        this.paint();
      },
    );

    // A mode may pin its map — the Shooting Range only exists where the dummies are. The
    // picker still shows the map so the player knows where they are going; it simply
    // cannot be changed, which is more informative than hiding the column.
    const forced = MODES.find((m) => m.id === this.deps.selection.modeId)?.forcedMapId ?? null;
    const mapList = this.picker(
      'Map',
      MAPS.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb })),
      forced ?? this.deps.selection.mapId,
      (id) => {
        if (forced !== null) return;
        this.deps.selection.mapId = id;
        this.paint();
      },
      forced !== null,
    );

    const launch = this.button('Start match', () => this.deps.onLaunch());
    launch.classList.add('op-btn--primary');
    const back = this.button('Back', () => {
      this.page = 'MAIN';
      this.paint();
    });
    back.classList.add('op-btn--quiet');

    const actions = document.createElement('div');
    actions.className = 'op-actions';
    actions.append(back, launch);

    const columns = document.createElement('div');
    columns.className = 'op-pickers';
    columns.append(modeList, mapList);

    this.screen.replaceChildren(title('OPERATOR'), subtitle('Select mode and map'), columns, actions);
    launch.focus();
  }

  // -- primitives ------------------------------------------------------------

  private picker(
    label: string,
    entries: readonly Readonly<{ id: string; name: string; blurb: string }>[],
    selected: string,
    onPick: (id: string) => void,
    locked = false,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'op-picker';
    wrap.classList.toggle('is-locked', locked);

    const heading = document.createElement('span');
    heading.className = 'op-label';
    heading.textContent = locked ? `${label} — fixed by this mode` : label;
    wrap.appendChild(heading);

    for (const entry of entries) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'op-option';
      option.classList.toggle('op-option--on', entry.id === selected);
      option.disabled = locked && entry.id !== selected;
      option.setAttribute('aria-pressed', entry.id === selected ? 'true' : 'false');

      const name = document.createElement('span');
      name.className = 'op-option__name';
      name.textContent = entry.name;
      const blurb = document.createElement('span');
      blurb.className = 'op-option__blurb';
      blurb.textContent = entry.blurb;

      option.append(name, blurb);
      option.addEventListener('click', () => onPick(entry.id));
      wrap.appendChild(option);
    }
    return wrap;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-btn';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }
}

function title(text: string): HTMLElement {
  const h = document.createElement('h1');
  h.className = 'op-screen__title';
  h.textContent = text;
  return h;
}

function subtitle(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'op-screen__sub';
  p.textContent = text;
  return p;
}
