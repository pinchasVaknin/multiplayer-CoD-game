import type { GameModeId } from '../modes/GameMode';
import { MAPS, MODES } from '../modes/ModeRegistry';

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
  /** Shown under the title: build stats, or whatever the caller wants to say. */
  readonly statusLine: () => string;
}

type Page = 'MAIN' | 'PLAY';

const KEY_HELP: readonly Readonly<[string, string]>[] = [
  ['W A S D', 'Move'],
  ['Shift', 'Sprint'],
  ['Shift Shift', 'Tactical sprint'],
  ['Ctrl / C', 'Crouch'],
  ['Sprint + Crouch', 'Slide'],
  ['Space', 'Jump / mantle'],
  ['Left mouse', 'Fire'],
  ['Right mouse', 'Aim down sights'],
  ['R', 'Reload'],
  ['Tab', 'Scoreboard'],
  ['Esc', 'Release cursor'],
  ['F1 / F2 / F4', 'Debug / collision / AI'],
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

    const keys = document.createElement('dl');
    keys.className = 'op-keys';
    for (const [combo, action] of KEY_HELP) {
      const dt = document.createElement('dt');
      dt.textContent = combo;
      const dd = document.createElement('dd');
      dd.textContent = action;
      keys.append(dt, dd);
    }

    this.screen.replaceChildren(
      title('OPERATOR'),
      subtitle(this.deps.statusLine()),
      play,
      keys,
      subtitle(FULLSCREEN_HINT),
    );
    play.focus();
  }

  private paintPlay(): void {
    const modeList = this.picker(
      'Mode',
      MODES.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb })),
      this.deps.selection.modeId,
      (id) => {
        this.deps.selection.modeId = id as GameModeId;
        this.paint();
      },
    );

    const mapList = this.picker(
      'Map',
      MAPS.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb })),
      this.deps.selection.mapId,
      (id) => {
        this.deps.selection.mapId = id;
        this.paint();
      },
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
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'op-picker';

    const heading = document.createElement('span');
    heading.className = 'op-label';
    heading.textContent = label;
    wrap.appendChild(heading);

    for (const entry of entries) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'op-option';
      option.classList.toggle('op-option--on', entry.id === selected);
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
