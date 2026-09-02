import type { DebugOverlay } from './DebugOverlay';
import type { Spectator } from './Spectator';

/**
 * The F1 panel for the QA spectator (post-M8).
 *
 * Three independent checkboxes plus one "all of it" button, matching `Spectator`'s shape —
 * see that file for why the three are not one switch. The panel owns no state of its own: the
 * checkboxes are re-read from the `Spectator` on every text refresh, so a toggle flipped from
 * the console (`__operator.spectate.god(true)`) is reflected here rather than leaving the
 * panel disagreeing with the game about what is on.
 *
 * **That last property is what makes the panel honest about a refusal** (round 4, F14). Every
 * switch is now a cheat entitlement the server decides, so a click on a server with cheats
 * disabled changes nothing — and because the checkbox is redrawn from the live answer rather
 * than from the click, it simply springs back. Nothing had to be written for that to be true.
 *
 * The controls card at the bottom is deliberately verbose. This is a tool somebody picks up
 * once a milestone, and a free-cam whose vertical controls have to be guessed is a free-cam
 * that gets reported as broken.
 */
export class SpectatorPanel {
  private readonly spectator: Spectator;
  private readonly god: HTMLInputElement;
  private readonly hidden: HTMLInputElement;
  private readonly fly: HTMLInputElement;
  private readonly status: { el: HTMLElement; last: string };

  constructor(overlay: DebugOverlay, spectator: Spectator) {
    this.spectator = spectator;

    const section = overlay.section('Spectator (QA)', overlay.leftColumn);
    this.status = section.addField('State');

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'dbg-btn dbg-btn--block';
    all.textContent = 'Toggle full spectator';
    all.addEventListener('click', () => {
      // "Full" means all three; pressing it while any subset is on completes the set rather
      // than turning things off, which is what somebody reaching for one button wants. The rule
      // itself lives in `toggleCheat` now, so this button and `SPEC[]4` cannot disagree.
      spectator.full(!spectator.allActive);
      this.refresh();
    });
    section.addNode(all);

    this.god = this.checkbox(section, 'God mode — take no damage', (on) => spectator.setGodMode(on));
    this.hidden = this.checkbox(section, 'Invisible — bots ignore you', (on) => spectator.setInvisible(on));
    this.fly = this.checkbox(section, 'Free-cam — fly and noclip', (on) => spectator.setFreeCam(on));

    const help = document.createElement('p');
    help.className = 'dbg-note';
    help.textContent =
      'Free-cam: WASD flies along your look, Space up, Crouch down, Sprint ×4, ADS ×¼ for close work. ' +
      'These are cheat entitlements (round 4, F14): against a server they need CHEATS_ENABLED, and a ' +
      'refused click springs back. Invisible no longer implies god mode — use the full toggle for that, ' +
      'because a grenade already in the air does not care that nobody is aiming at you.';
    section.addNode(help);

    overlay.addTextHook(() => this.refresh());
  }

  /** Mirror the live state onto the controls. Cheap; runs at the overlay's 15 Hz text rate. */
  private refresh(): void {
    this.god.checked = this.spectator.godMode;
    this.hidden.checked = this.spectator.invisible;
    this.fly.checked = this.spectator.freeCam;

    const text = this.spectator.describe();
    if (text === this.status.last) return;
    this.status.last = text;
    this.status.el.textContent = text;
  }

  private checkbox(
    section: ReturnType<DebugOverlay['section']>,
    label: string,
    onChange: (on: boolean) => void,
  ): HTMLInputElement {
    const wrap = document.createElement('label');
    wrap.className = 'dbg-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = label;
    input.addEventListener('change', () => {
      onChange(input.checked);
      this.refresh();
    });
    wrap.append(input, text);
    section.addNode(wrap);
    return input;
  }
}
