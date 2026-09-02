/**
 * The pause screen (M5, from the M4 playtest notes).
 *
 * Esc used to quit the match outright: pointer lock dropped, `Game` saw the unlock and went
 * straight back to the menu, and a match in progress was gone. That is a reasonable thing
 * for a build with no pause state to do and an unreasonable thing for a game to do.
 *
 * So Esc now enters `PAUSED`. The world stays built and the simulation stops advancing;
 * this screen goes over the top of it. Four buttons, because there are exactly four
 * things a paused player wants: carry on, fix a setting, look at the numbers, or leave.
 *
 * **Debug overlay is a button here** rather than only F1, which is the second half of the
 * M4 note: the tuning panel needs a mouse, a mouse needs pointer lock released, and
 * releasing pointer lock used to mean quitting. Paused, the cursor is already free.
 *
 * **From round 4's F14 that button is gated rather than deleted.** F14 asks for the overlay to
 * leave the ordinary options and become reachable only through `DEBUG666`, so it appears only
 * for a session that has typed it — an ordinary player never sees it, which is what "removed
 * from the ordinary options" means. Deleting it outright was the other reading and it is worse:
 * the x and Escape close the panel without revoking the entitlement (B1's tri-state), so with no
 * button the code would have to be retyped every time the panel was closed, and the x would have
 * become exactly the one-way door P7 asks to confirm it has not become.
 *
 * **The cheat field is the input for every code**, and it is a text field rather than a
 * key-sequence detector on purpose. `DEBUG666` shares D, E, B, U and G with movement and Use;
 * `SPEC[]n`'s brackets are not keystrokes on a keyboard that does not have them. A field here
 * satisfies both standing input rules *by construction* rather than by a check somebody has to
 * write: `Input.bindingsActive` is already false outside `MATCH`, and `Input.domFocusGuard`
 * already stops the game seeing a key while a form control has focus. So the player types the
 * literal text, brackets and all, and nothing is consumed from anybody.
 *
 * **Create-a-Class is deliberately not one of them** (playtest round 4, B8). It was, from M6
 * until round 4, and the editor was made an overlay in round 2 specifically so that opening
 * it from here did not cost the player their seat. The doctrine changed instead: the editor
 * is a front-end screen, and inside a match the only way to change class is keys 1-5. So the
 * route is gone rather than made safe — `LEGAL_TRANSITIONS` no longer admits `PAUSED ->
 * LOADOUT` at all, which is what makes this a rule instead of an omission.
 */

export interface PauseMenuDeps {
  readonly host: HTMLElement;
  readonly onResume: () => void;
  readonly onToggleDebug: () => void;
  readonly onQuit: () => void;
  /** Shown under the title. Map, mode and the score, so the pause is informative. */
  readonly statusLine: () => string;
  /**
   * A code was submitted (playtest round 4, F14).
   *
   * This screen does not parse it and does not know what any of them mean — it collects a string
   * and shows whatever answer comes back. `Game.requestCheat` is the one door that decides
   * whether the answer is local or the server's.
   */
  readonly onCheatCode: (code: string) => void;
}

export class PauseMenu {
  private readonly screen: HTMLElement;
  private readonly status: HTMLElement;
  private readonly deps: PauseMenuDeps;
  private readonly resumeButton: HTMLButtonElement;
  /**
   * M8. Bound after construction because `Game` registers its states — and therefore
   * learns how to reach SETTINGS — after the menus exist.
   */
  private onSettings: (() => void) | null = null;

  /** F14. The code field, the line under it, and the button the entitlement reveals. */
  private readonly codeInput: HTMLInputElement;
  private readonly codeResult: HTMLElement;
  private readonly debugButton: HTMLButtonElement;

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
    // M8: paused is where a player actually notices their sensitivity is wrong, and the
    // cursor is already free here.
    const settings = button('Settings', () => this.onSettings?.());
    // F14: present only for a session that has unlocked it. `setDebugAvailable` is the one
    // writer and `Game.updateHudSurfaces` is its one caller, so the button's presence is a pure
    // function of the entitlement rather than something toggled at two separate moments.
    this.debugButton = button('Debug overlay', () => deps.onToggleDebug());
    this.debugButton.hidden = true;
    const quit = button('Quit to menu', () => deps.onQuit());
    quit.classList.add('op-btn--quiet');

    const actions = document.createElement('div');
    actions.className = 'op-actions op-actions--stack';
    actions.append(this.resumeButton, settings, this.debugButton, quit);

    const hint = document.createElement('p');
    hint.className = 'op-screen__sub';
    // F1 is no longer bound during play (M5 playtest note); the overlay is a button here.
    // The class line is the whole of B8: 1-5 is the in-match route, and the only one.
    hint.textContent = 'Esc to resume · 1-5 to change class · Tab for the scoreboard';

    /**
     * The code field (F14).
     *
     * A `<form>`, so Enter submits without a keydown listener of our own — which also means the
     * key never reaches `Input` at all, because a submit is a form event rather than a binding.
     * `autocomplete` is off because a browser offering to remember somebody's cheat codes is
     * noise, and this is not a password field.
     */
    const codeForm = document.createElement('form');
    codeForm.className = 'op-code';
    this.codeInput = document.createElement('input');
    this.codeInput.type = 'text';
    this.codeInput.className = 'op-code__input';
    this.codeInput.placeholder = 'Code';
    this.codeInput.autocomplete = 'off';
    this.codeInput.spellcheck = false;
    // Room for every code in the table and no room for a paragraph. The server bounds it too,
    // at `CHEAT_CODE_MAX`, because a limit only a client enforces is not a limit.
    this.codeInput.maxLength = 24;
    const codeSubmit = document.createElement('button');
    codeSubmit.type = 'submit';
    codeSubmit.className = 'op-btn op-btn--quiet op-code__go';
    codeSubmit.textContent = 'Enter';
    codeForm.append(this.codeInput, codeSubmit);
    codeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.codeInput.value.trim();
      if (code === '') return;
      this.codeInput.value = '';
      deps.onCheatCode(code);
    });

    this.codeResult = document.createElement('p');
    this.codeResult.className = 'op-screen__sub op-code__result';

    this.screen.append(heading, this.status, actions, hint, codeForm, this.codeResult);
    deps.host.appendChild(this.screen);
  }

  /**
   * Whether the debug overlay is reachable from here (F14).
   *
   * Idempotent, and called every frame from the one pass that decides every other surface, which
   * is why it can be a plain assignment: there is no moment at which somebody has to remember to
   * refresh it — including the moment the player types the code on this very screen.
   */
  setDebugAvailable(on: boolean): void {
    this.debugButton.hidden = !on;
  }

  /** What happened to the last code. One writer, `Game.requestCheat` and its reply. */
  setCodeResult(text: string): void {
    this.codeResult.textContent = text;
  }

  setOnSettings(fn: () => void): void {
    this.onSettings = fn;
  }

  show(): void {
    this.status.textContent = this.deps.statusLine();
    // Last pause's answer is not this one's, and a stale "code accepted" beside an empty field
    // reads as though something had just happened.
    this.codeResult.textContent = '';
    this.codeInput.value = '';
    this.screen.hidden = false;
    this.resumeButton.focus();
  }

  hide(): void {
    this.screen.hidden = true;
    // Focus stays on a button otherwise, and `Input.domFocusGuard` would keep swallowing
    // keys after the match resumed. The code field is blurred for the same reason, and it is the
    // sharper case: a text input that kept focus into a live match would eat W, A, S and D.
    this.resumeButton.blur();
    this.codeInput.blur();
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
