/**
 * The pause screen (M5, from the M4 playtest notes).
 *
 * Esc used to quit the match outright: pointer lock dropped, `Game` saw the unlock and went
 * straight back to the menu, and a match in progress was gone. That is a reasonable thing
 * for a build with no pause state to do and an unreasonable thing for a game to do.
 *
 * So Esc now enters `PAUSED`. The world stays built and the simulation stops advancing;
 * this screen goes over the top of it. Three buttons, because there are exactly three
 * things a paused player wants: carry on, look at the numbers, or leave.
 *
 * **Debug overlay is a button here** rather than only F1, which is the second half of the
 * M4 note: the tuning panel needs a mouse, a mouse needs pointer lock released, and
 * releasing pointer lock used to mean quitting. Paused, the cursor is already free.
 */

export interface PauseMenuDeps {
  readonly host: HTMLElement;
  readonly onResume: () => void;
  readonly onToggleDebug: () => void;
  readonly onQuit: () => void;
  /** Shown under the title. Map, mode and the score, so the pause is informative. */
  readonly statusLine: () => string;
}

export class PauseMenu {
  private readonly screen: HTMLElement;
  private readonly status: HTMLElement;
  private readonly deps: PauseMenuDeps;
  private readonly resumeButton: HTMLButtonElement;
  /**
   * M6. Bound after construction because `Game` registers its states — and therefore
   * learns how to reach LOADOUT — after the menus exist.
   */
  private onLoadout: (() => void) | null = null;
  /** M8. Same late binding as `onLoadout`, and for the same reason. */
  private onSettings: (() => void) | null = null;

  constructor(deps: PauseMenuDeps) {
    this.deps = deps;

    this.screen = document.createElement('div');
    this.screen.className = 'op-screen op-screen--pause';
    this.screen.hidden = true;

    const heading = document.createElement('h1');
    heading.className = 'op-screen__title';
    heading.textContent = 'PAUSED';

    this.status = document.createElement('p');
    this.status.className = 'op-screen__sub';

    this.resumeButton = button('Resume', () => deps.onResume());
    this.resumeButton.classList.add('op-btn--primary');
    // S6.3's "between spawns": the class change lands on the live match on the way back.
    const loadout = button('Create a class', () => this.onLoadout?.());
    // M8: paused is where a player actually notices their sensitivity is wrong, and the
    // cursor is already free here.
    const settings = button('Settings', () => this.onSettings?.());
    const debug = button('Debug overlay', () => deps.onToggleDebug());
    const quit = button('Quit to menu', () => deps.onQuit());
    quit.classList.add('op-btn--quiet');

    const actions = document.createElement('div');
    actions.className = 'op-actions op-actions--stack';
    actions.append(this.resumeButton, loadout, settings, debug, quit);

    const hint = document.createElement('p');
    hint.className = 'op-screen__sub';
    // F1 is no longer bound during play (M5 playtest note); the overlay is a button here.
    hint.textContent = 'Esc to resume · overlay above · Tab for the scoreboard';

    this.screen.append(heading, this.status, actions, hint);
    deps.host.appendChild(this.screen);
  }

  setOnLoadout(fn: () => void): void {
    this.onLoadout = fn;
  }

  setOnSettings(fn: () => void): void {
    this.onSettings = fn;
  }

  show(): void {
    this.status.textContent = this.deps.statusLine();
    this.screen.hidden = false;
    this.resumeButton.focus();
  }

  hide(): void {
    this.screen.hidden = true;
    // Focus stays on a button otherwise, and `Input.domFocusGuard` would keep swallowing
    // keys after the match resumed.
    this.resumeButton.blur();
  }

  get isVisible(): boolean {
    return !this.screen.hidden;
  }

  dispose(): void {
    this.screen.remove();
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
