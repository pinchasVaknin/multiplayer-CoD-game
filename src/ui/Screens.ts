/**
 * The DOM overlays for the non-match game states.
 *
 * M1 has no menus (S8) — what exists here is the minimum the state machine and the
 * browser demand: a boot screen while the map bakes, and a click target, because
 * pointer lock can only be requested from a user gesture.
 */

export interface KeyHelpEntry {
  keys: string;
  action: string;
}

const KEY_HELP: readonly KeyHelpEntry[] = [
  { keys: 'W A S D', action: 'Move' },
  { keys: 'Shift', action: 'Sprint' },
  { keys: 'Shift Shift', action: 'Tactical sprint' },
  { keys: 'Ctrl / C', action: 'Crouch' },
  { keys: 'Sprint + Crouch', action: 'Slide' },
  { keys: 'Space', action: 'Jump / mantle' },
  { keys: 'Left mouse', action: 'Fire' },
  { keys: 'Right mouse', action: 'Aim down sights' },
  { keys: 'R', action: 'Reload' },
  { keys: 'Esc', action: 'Release cursor' },
  { keys: 'F1 / F2 / F3 / F4', action: 'Debug / collision / reset / hitboxes' },
];

/**
 * `Ctrl+W` closes a browser tab and no amount of `preventDefault` stops it; only the
 * Keyboard Lock API can, and only while the page is fullscreen. Saying so on the menu is
 * better than letting a player discover it mid-slide. See PLAN.md.
 */
const FULLSCREEN_HINT = 'F11 for fullscreen — required to capture Ctrl+W (crouch + forward)';

export class Screens {
  private readonly host: HTMLElement;
  private readonly screen: HTMLElement;
  private playHandler: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;

    this.screen = document.createElement('div');
    this.screen.className = 'op-screen';
    this.host.appendChild(this.screen);
  }

  showBoot(message: string): void {
    this.screen.hidden = false;
    this.screen.replaceChildren(
      title('OPERATOR'),
      subtitle(message),
    );
  }

  showMenu(subtitleText: string, onPlay: () => void): void {
    this.playHandler = onPlay;
    const button = document.createElement('button');
    button.className = 'op-btn';
    button.type = 'button';
    button.textContent = 'Click to play';
    button.addEventListener('click', () => this.playHandler?.());

    const keys = document.createElement('dl');
    keys.className = 'op-keys';
    for (const entry of KEY_HELP) {
      const dt = document.createElement('dt');
      dt.textContent = entry.keys;
      const dd = document.createElement('dd');
      dd.textContent = entry.action;
      keys.append(dt, dd);
    }

    this.screen.hidden = false;
    this.screen.replaceChildren(title('OPERATOR'), subtitle(subtitleText), button, keys, subtitle(FULLSCREEN_HINT));
    button.focus();
  }

  hide(): void {
    this.screen.hidden = true;
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
