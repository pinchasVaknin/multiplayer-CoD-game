import {
  ACTIONS,
  inputLabel,
  isPointerInput,
  mouseInput,
  type ActionDef,
  type ActionId,
  type BindingMap,
} from '../core/Keybinds';
import {
  COLORBLIND_MODES,
  SHADOW_QUALITIES,
  type ColorblindMode,
  type SettingsV1,
  type ShadowQuality,
} from '../meta/SaveData';

/**
 * The settings screen (brief S6.3).
 *
 * S6.3 opens with the rule the whole screen is built around: *"A setting that does not do
 * anything is worse than a missing setting."* So there is nothing here that is not wired —
 * every control below writes through `onChange`, which hands the whole settings record back
 * to `Game` to apply immediately. Nothing is queued, nothing needs an Apply button, and
 * nothing waits for a restart.
 *
 * ## Live, and persisted, are two different things
 *
 * Applying is synchronous; persisting is not. Every change calls
 * `Profile.patchSettings`, and `SaveStore` coalesces a burst of writes into one flush 250 ms
 * later — which matters because dragging a slider is dozens of changes a second and a
 * `localStorage.setItem` per frame would be visible in the frame times. The setting is live
 * on the frame you release the mouse; the write lands a quarter of a second afterwards.
 *
 * ## Rebinding captures at the window, in the capture phase
 *
 * The rebinding rows have to see a raw key *before* `core/Input` does, or pressing `W` to
 * rebind would also walk the player forward. A capture-phase listener on `window` runs
 * ahead of every bubble-phase listener in the project, and `stopPropagation` there ends the
 * dispatch before `Input` is reached. That is the only place in the project outside
 * `core/Input.ts` that touches a raw keyboard event, and it exists to stop the input layer
 * seeing something rather than to do gameplay with it.
 */

export interface SettingsDeps {
  readonly host: HTMLElement;
  /** The live settings record. Read on `show`, written through `onChange`. */
  readonly read: () => SettingsV1;
  /** Apply and persist. Called with only the fields that changed. */
  readonly onChange: (patch: Partial<SettingsV1>) => void;
  readonly onBack: () => void;
  /** Put every binding back to the shipped default. */
  readonly onResetBindings: () => void;
}

type Tab = 'CONTROLS' | 'BINDINGS' | 'AUDIO' | 'VIDEO';

const TABS: readonly Tab[] = ['CONTROLS', 'BINDINGS', 'AUDIO', 'VIDEO'];

const SHADOW_LABELS: Readonly<Record<ShadowQuality, string>> = {
  off: 'Off',
  low: 'Low — 1024, hard',
  medium: 'Medium — 2048',
  high: 'High — 4096, soft',
};

const COLORBLIND_LABELS: Readonly<Record<ColorblindMode, string>> = {
  off: 'Off — green / red',
  deuteranopia: 'Deuteranopia — blue / orange',
  protanopia: 'Protanopia — blue / orange',
  tritanopia: 'Tritanopia — teal / magenta',
};

export class Settings {
  private readonly deps: SettingsDeps;
  private readonly screen: HTMLElement;
  private tab: Tab = 'CONTROLS';

  /** Which binding slot is waiting for a key, or null. */
  private capturing: { action: ActionId; slot: number } | null = null;
  /** Shown under the binding list after a rebind took a key off something else. */
  private notice = '';

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.screen = document.createElement('div');
    this.screen.className = 'op-screen op-screen--wide';
    this.screen.hidden = true;
    deps.host.appendChild(this.screen);
  }

  show(): void {
    this.screen.hidden = false;
    this.capturing = null;
    this.notice = '';
    this.paint();
  }

  hide(): void {
    this.stopCapture();
    this.screen.hidden = true;
  }

  get isVisible(): boolean {
    return !this.screen.hidden;
  }

  /**
   * Escape, forwarded from the state machine.
   *
   * Returns whether it was consumed: while a binding row is armed, Escape cancels the
   * capture rather than leaving the screen — a player who opened a rebind by accident
   * should not be thrown back to the menu by the key they used to back out of it.
   */
  handleEscape(): boolean {
    if (this.capturing === null) return false;
    this.stopCapture();
    this.paint();
    return true;
  }

  dispose(): void {
    this.stopCapture();
    this.screen.remove();
  }

  // -- painting --------------------------------------------------------------

  private paint(): void {
    const nav = document.createElement('div');
    nav.className = 'op-tabs';
    for (const tab of TABS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'op-tab';
      b.classList.toggle('op-tab--on', tab === this.tab);
      b.textContent = tab;
      b.addEventListener('click', () => {
        this.stopCapture();
        this.tab = tab;
        this.paint();
      });
      nav.appendChild(b);
    }

    const body = document.createElement('div');
    body.className = 'op-settings';
    if (this.tab === 'CONTROLS') this.paintControls(body);
    else if (this.tab === 'BINDINGS') this.paintBindings(body);
    else if (this.tab === 'AUDIO') this.paintAudio(body);
    else this.paintVideo(body);

    const back = this.button('Back', () => this.deps.onBack());
    back.classList.add('op-btn--quiet');
    const actions = document.createElement('div');
    actions.className = 'op-actions';
    actions.appendChild(back);

    this.screen.replaceChildren(title('SETTINGS'), nav, body, actions);
  }

  private paintControls(host: HTMLElement): void {
    const s = this.deps.read();
    host.appendChild(
      this.slider('Mouse sensitivity', s.sensitivity, 0.1, 5, 0.05, (v) =>
        this.deps.onChange({ sensitivity: v }),
      ),
    );
    host.appendChild(
      this.slider(
        'ADS sensitivity multiplier',
        s.adsSensitivity,
        0.1,
        2,
        0.05,
        (v) => this.deps.onChange({ adsSensitivity: v }),
        'Applied in proportion to how far the sights are up, so it arrives with the picture.',
      ),
    );
    host.appendChild(
      this.slider(
        'Field of view',
        s.fov,
        60,
        120,
        1,
        (v) => this.deps.onChange({ fov: v }),
        undefined,
        (v) => `${v.toFixed(0)}°`,
      ),
    );
    host.appendChild(this.toggle('Invert vertical look', s.invertY, (v) => this.deps.onChange({ invertY: v })));
  }

  private paintBindings(host: HTMLElement): void {
    const groups = new Map<ActionDef['group'], ActionDef[]>();
    for (const a of ACTIONS) {
      const list = groups.get(a.group);
      if (list === undefined) groups.set(a.group, [a]);
      else list.push(a);
    }

    const bindings = this.deps.read().bindings;
    for (const [group, actions] of groups) {
      const heading = document.createElement('span');
      heading.className = 'op-label op-settings__group';
      heading.textContent = group;
      host.appendChild(heading);

      for (const action of actions) {
        host.appendChild(this.bindingRow(action, bindings));
      }
    }

    const note = document.createElement('p');
    note.className = 'op-screen__sub';
    note.textContent =
      this.notice !== ''
        ? this.notice
        : this.capturing !== null
          ? 'Press any key or mouse button. Escape cancels.'
          : 'Click a binding to change it. A key taken from another action is removed from it.';
    host.appendChild(note);

    const reset = this.button('Reset all bindings', () => {
      this.deps.onResetBindings();
      this.notice = 'Bindings restored to defaults.';
      this.paint();
    });
    reset.classList.add('op-btn--quiet');
    host.appendChild(reset);
  }

  private bindingRow(action: ActionDef, bindings: BindingMap): HTMLElement {
    const row = document.createElement('div');
    row.className = 'op-setting op-setting--binding';

    const label = document.createElement('span');
    label.className = 'op-setting__label';
    label.textContent = action.label;
    row.appendChild(label);

    const keys = document.createElement('div');
    keys.className = 'op-binds';
    const list = bindings[action.id] ?? [];
    // Two slots always, so an action with one binding still offers somewhere to add a second.
    for (let slot = 0; slot < 2; slot++) {
      const current = list[slot];
      const armed = this.capturing?.action === action.id && this.capturing.slot === slot;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'op-bind';
      b.classList.toggle('op-bind--armed', armed);
      b.classList.toggle('op-bind--empty', current === undefined);
      b.textContent = armed ? 'PRESS…' : current === undefined ? '—' : inputLabel(current);
      b.addEventListener('click', () => this.startCapture(action.id, slot));
      keys.appendChild(b);
    }
    row.appendChild(keys);
    return row;
  }

  private paintAudio(host: HTMLElement): void {
    const s = this.deps.read();
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    host.appendChild(
      this.slider('Master', s.masterVolume, 0, 1, 0.01, (v) => this.deps.onChange({ masterVolume: v }), undefined, pct),
    );
    host.appendChild(
      this.slider(
        'Effects',
        s.sfxVolume,
        0,
        1,
        0.01,
        (v) => this.deps.onChange({ sfxVolume: v }),
        'Gunfire, footsteps, impacts and equipment. Ducks under announcer stings.',
        pct,
      ),
    );
    host.appendChild(
      this.slider('Music', s.musicVolume, 0, 1, 0.01, (v) => this.deps.onChange({ musicVolume: v }), undefined, pct),
    );
    host.appendChild(
      this.slider(
        'Interface',
        s.uiVolume,
        0,
        1,
        0.01,
        (v) => this.deps.onChange({ uiVolume: v }),
        'Hitmarkers, the announcer and menu sounds. Routed around the world filter, so it stays clear when you are hurt.',
        pct,
      ),
    );
  }

  private paintVideo(host: HTMLElement): void {
    const s = this.deps.read();
    host.appendChild(
      this.slider(
        'Render scale',
        s.renderScale,
        0.5,
        1,
        0.05,
        (v) => this.deps.onChange({ renderScale: v }),
        'The first thing to lower on integrated graphics. Resizes the backing buffer, not the page.',
        (v) => `${Math.round(v * 100)}%`,
      ),
    );
    host.appendChild(
      this.picker(
        'Shadow quality',
        SHADOW_QUALITIES,
        s.shadowQuality,
        (v) => this.deps.onChange({ shadowQuality: v }),
        (v) => SHADOW_LABELS[v],
      ),
    );
    host.appendChild(
      this.picker(
        'Colourblind mode',
        COLORBLIND_MODES,
        s.colorblind,
        (v) => this.deps.onChange({ colorblind: v }),
        (v) => COLORBLIND_LABELS[v],
        'Changes the real team, hitmarker, minimap and objective colours — not a filter over the picture.',
      ),
    );
    host.appendChild(this.toggle('FPS counter', s.showFps, (v) => this.deps.onChange({ showFps: v })));
    host.appendChild(
      this.toggle('Motion blur', s.motionBlur, (v) => this.deps.onChange({ motionBlur: v }), 'A short trail on fast camera movement. Off by default; some players find it nauseating.'),
    );
  }

  // -- capture ---------------------------------------------------------------

  private startCapture(action: ActionId, slot: number): void {
    this.stopCapture();
    this.capturing = { action, slot };
    this.notice = '';
    window.addEventListener('keydown', this.onCaptureKey, true);
    window.addEventListener('mousedown', this.onCaptureMouse, true);
    window.addEventListener('wheel', this.onCaptureWheel, { capture: true, passive: false });
    this.paint();
  }

  private stopCapture(): void {
    if (this.capturing === null) return;
    this.capturing = null;
    window.removeEventListener('keydown', this.onCaptureKey, true);
    window.removeEventListener('mousedown', this.onCaptureMouse, true);
    window.removeEventListener('wheel', this.onCaptureWheel, true);
  }

  /**
   * Every capture handler ends the dispatch.
   *
   * `stopPropagation` in the capture phase at `window` stops the event reaching anything
   * else at all, which is the point: pressing `W` to bind it must not also walk the player
   * forward, and clicking to bind a mouse button must not fire the weapon.
   */
  private readonly onCaptureKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') {
      this.stopCapture();
      this.paint();
      return;
    }
    this.commit(e.code);
  };

  private readonly onCaptureMouse = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.commit(mouseInput(e.button));
  };

  private readonly onCaptureWheel = (e: WheelEvent): void => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.commit(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
  };

  /**
   * Write the captured input into the binding table.
   *
   * The rebind happens on a *copy* of the map, which is then handed to `onChange` like any
   * other setting — so a binding change persists, migrates and applies through exactly the
   * same path a volume slider does, and there is no second mechanism to keep in step.
   */
  private commit(input: string): void {
    const target = this.capturing;
    if (target === null) return;
    this.stopCapture();

    const next = cloneBindings(this.deps.read().bindings);
    let stolenFrom: ActionId | null = null;
    for (const action of ACTIONS) {
      if (action.id === target.action) continue;
      const list = next[action.id];
      if (list === undefined) continue;
      const at = list.indexOf(input);
      if (at < 0) continue;
      list.splice(at, 1);
      stolenFrom = action.id;
    }

    const list = next[target.action] ?? [];
    const dup = list.indexOf(input);
    if (dup >= 0 && dup !== target.slot) list.splice(dup, 1);
    list[Math.min(target.slot, list.length)] = input;
    next[target.action] = list;

    this.deps.onChange({ bindings: next });
    this.notice =
      stolenFrom === null
        ? ''
        : `${inputLabel(input)} was taken off "${labelOf(stolenFrom)}", which is now unbound on that key.`;
    this.paint();
  }

  // -- primitives ------------------------------------------------------------

  private slider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onInput: (v: number) => void,
    help?: string,
    format: (v: number) => string = (v) => v.toFixed(2),
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'op-setting';

    const name = document.createElement('span');
    name.className = 'op-setting__label';
    name.textContent = label;

    const readout = document.createElement('span');
    readout.className = 'op-setting__value op-num';
    readout.textContent = format(value);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'op-setting__range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      readout.textContent = format(v);
      onInput(v);
    });

    row.append(name, input, readout);
    if (help !== undefined) row.appendChild(helpText(help));
    return row;
  }

  private toggle(label: string, value: boolean, onChange: (v: boolean) => void, help?: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'op-setting';

    const name = document.createElement('span');
    name.className = 'op-setting__label';
    name.textContent = label;

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-toggle';
    b.classList.toggle('op-toggle--on', value);
    b.textContent = value ? 'ON' : 'OFF';
    b.setAttribute('aria-pressed', value ? 'true' : 'false');
    b.addEventListener('click', () => {
      const next = !b.classList.contains('op-toggle--on');
      b.classList.toggle('op-toggle--on', next);
      b.textContent = next ? 'ON' : 'OFF';
      b.setAttribute('aria-pressed', next ? 'true' : 'false');
      onChange(next);
    });

    row.append(name, b);
    if (help !== undefined) row.appendChild(helpText(help));
    return row;
  }

  private picker<T extends string>(
    label: string,
    options: readonly T[],
    value: T,
    onChange: (v: T) => void,
    format: (v: T) => string,
    help?: string,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'op-setting op-setting--stack';

    const name = document.createElement('span');
    name.className = 'op-setting__label';
    name.textContent = label;
    row.appendChild(name);

    const list = document.createElement('div');
    list.className = 'op-choices';
    for (const option of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'op-choice';
      b.classList.toggle('op-choice--on', option === value);
      b.textContent = format(option);
      b.setAttribute('aria-pressed', option === value ? 'true' : 'false');
      b.addEventListener('click', () => {
        onChange(option);
        this.paint();
      });
      list.appendChild(b);
    }
    row.appendChild(list);
    if (help !== undefined) row.appendChild(helpText(help));
    return row;
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

function cloneBindings(source: BindingMap): BindingMap {
  const out: BindingMap = {};
  for (const action of ACTIONS) out[action.id] = [...(source[action.id] ?? [])];
  return out;
}

function labelOf(id: ActionId): string {
  return ACTIONS.find((a) => a.id === id)?.label ?? id;
}

function helpText(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'op-setting__help';
  p.textContent = text;
  return p;
}

function title(text: string): HTMLElement {
  const h = document.createElement('h1');
  h.className = 'op-screen__title';
  h.textContent = text;
  return h;
}

/** Re-exported so the controls card on the main menu can name keys the player chose. */
export { inputLabel, isPointerInput };
