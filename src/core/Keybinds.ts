import { Btn } from './InputCommand';

/**
 * The bindable actions and the table that maps physical inputs onto them (brief S6.3).
 *
 * ## The rule this file exists to enforce
 *
 * S6.3: *"Rebinding must work with the `InputCommand` bitfield rather than bypassing it."*
 * The obvious way to build rebinding is a map from key code to a callback, and it is wrong
 * for exactly the reason the input seam exists (S4.2): a callback is a DOM handler doing
 * gameplay, so a rebound key would take a different path through the engine from a default
 * one, and the netcode boundary would stop being real for anybody who touched the settings.
 *
 * So a binding resolves to **a bit**, and nothing else. `Input` asks this table which bits a
 * physical input contributes, ors them into the same `buttons` word it has always built, and
 * the sim sees a command it cannot distinguish from a default-bound one. Every consumer
 * downstream — edge detection, the harness, `LocalBotTransport` — is untouched by the fact
 * that rebinding exists at all.
 *
 * ## Movement is bits too, and it did not used to be
 *
 * M1 read WASD directly out of a held-key set inside `Input.sample` and turned it into
 * `moveX`/`moveZ`. That is fine until the keys are rebindable, at which point the axis code
 * has to know about the binding table anyway. The four directions are therefore actions like
 * any other, carrying **local** bits that live above the wire bits and are consumed by the
 * sampler rather than by the sim. They never reach `InputCommand.buttons`; they exist so
 * "forward" is looked up the same way "jump" is.
 *
 * ## Physical inputs
 *
 * A binding is a string. Keyboard bindings are `KeyboardEvent.code` verbatim (`KeyW`,
 * `ShiftLeft`, `Digit3`). Mouse bindings are `Mouse0`..`Mouse4`, and the wheel is
 * `WheelUp` / `WheelDown`. One namespace, so a binding is one string in the save and the
 * rebinding UI has one kind of thing to capture — S6.3 asks for mouse buttons explicitly,
 * and a separate mouse table would have meant two code paths and two migrations.
 *
 * **`MouseN` is `MouseEvent.button`, verbatim, and that numbering is not the obvious one.**
 * The DOM orders them 0 = left, **1 = middle, 2 = right**. M8 shipped ADS on `Mouse1` and
 * labelled it "Right mouse", which meant the default bind was really *middle* mouse and
 * right-clicking did nothing — reported as "ADS does not work until I rebind it to the key
 * it already shows". Both halves of that are fixed here: the default is `Mouse2` and
 * `inputLabel` names the buttons the way the DOM numbers them. The lookup table is keyed on
 * whatever `mouseInput(e.button)` produces, so the DOM's numbering is the only one in the
 * project and there is no second convention for the two to disagree about.
 */

/** Bits above the wire bitfield, consumed by the sampler and never sent. */
export const LocalBtn = {
  Forward: 1 << 24,
  Back: 1 << 25,
  Left: 1 << 26,
  Right: 1 << 27,
} as const;

export type ActionId =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'fire'
  | 'ads'
  | 'reload'
  | 'swapWeapon'
  | 'slot1'
  | 'slot2'
  | 'melee'
  | 'lethal'
  | 'tactical'
  | 'fieldUpgrade'
  | 'streak1'
  | 'streak2'
  | 'streak3'
  | 'use'
  | 'scoreboard';

export interface ActionDef {
  readonly id: ActionId;
  /** Shown in the settings list and on the controls card. */
  readonly label: string;
  /** Grouping for the settings screen. */
  readonly group: 'Movement' | 'Combat' | 'Equipment' | 'Interface';
  /** The bit this action contributes. Wire bits from `Btn`, local bits from `LocalBtn`. */
  readonly bit: number;
  /** Default physical inputs. Two, where M1-M7 shipped an alternative.  */
  readonly defaults: readonly string[];
}

/**
 * Every bindable action, in the order the settings screen shows them.
 *
 * The defaults are what M1-M7 hard-coded in `Input.ts`, including the doubled ones
 * (`ControlLeft`/`KeyC` for crouch) — a milestone that adds rebinding must not silently
 * change anybody's controls on the way past. Two have moved since, and both were bugs
 * rather than preferences:
 *
 *  - **ADS is `Mouse2`**, not `Mouse1`. See the note on DOM button numbering above.
 *  - **Use is `KeyT` first**, replacing `KeyP` (post-M8 playtest). `P` is nowhere near the
 *    movement keys, so planting a bomb meant taking a hand off the rifle; `T` is a reach
 *    from `WASD`. `E` stays as the second binding because it is what everybody presses.
 */
export const ACTIONS: readonly ActionDef[] = [
  { id: 'moveForward', label: 'Move forward', group: 'Movement', bit: LocalBtn.Forward, defaults: ['KeyW'] },
  { id: 'moveBack', label: 'Move back', group: 'Movement', bit: LocalBtn.Back, defaults: ['KeyS'] },
  { id: 'moveLeft', label: 'Move left', group: 'Movement', bit: LocalBtn.Left, defaults: ['KeyA'] },
  { id: 'moveRight', label: 'Move right', group: 'Movement', bit: LocalBtn.Right, defaults: ['KeyD'] },
  { id: 'jump', label: 'Jump / mantle', group: 'Movement', bit: Btn.Jump, defaults: ['Space'] },
  { id: 'crouch', label: 'Crouch / slide', group: 'Movement', bit: Btn.Crouch, defaults: ['ControlLeft', 'KeyC'] },
  { id: 'sprint', label: 'Sprint', group: 'Movement', bit: Btn.Sprint, defaults: ['ShiftLeft'] },

  { id: 'fire', label: 'Fire', group: 'Combat', bit: Btn.Fire, defaults: ['Mouse0'] },
  { id: 'ads', label: 'Aim down sights', group: 'Combat', bit: Btn.Ads, defaults: ['Mouse2'] },
  { id: 'reload', label: 'Reload', group: 'Combat', bit: Btn.Reload, defaults: ['KeyR'] },
  { id: 'swapWeapon', label: 'Swap weapon', group: 'Combat', bit: Btn.SwapWeapon, defaults: ['KeyQ', 'WheelUp'] },
  { id: 'slot1', label: 'Primary', group: 'Combat', bit: Btn.Slot1, defaults: ['Digit1'] },
  { id: 'slot2', label: 'Secondary', group: 'Combat', bit: Btn.Slot2, defaults: ['Digit2'] },

  { id: 'lethal', label: 'Lethal', group: 'Equipment', bit: Btn.Lethal, defaults: ['KeyG'] },
  { id: 'tactical', label: 'Tactical', group: 'Equipment', bit: Btn.Tactical, defaults: ['KeyF'] },
  { id: 'fieldUpgrade', label: 'Field upgrade', group: 'Equipment', bit: Btn.FieldUpgrade, defaults: ['KeyX'] },
  { id: 'streak1', label: 'Killstreak 1', group: 'Equipment', bit: Btn.Streak1, defaults: ['Digit3'] },
  { id: 'streak2', label: 'Killstreak 2', group: 'Equipment', bit: Btn.Streak2, defaults: ['Digit4'] },
  { id: 'streak3', label: 'Killstreak 3', group: 'Equipment', bit: Btn.Streak3, defaults: ['Digit5'] },

  { id: 'melee', label: 'Melee', group: 'Combat', bit: Btn.Melee, defaults: ['KeyV'] },

  { id: 'use', label: 'Use / plant / defuse', group: 'Interface', bit: Btn.Use, defaults: ['KeyT', 'KeyE'] },
  { id: 'scoreboard', label: 'Scoreboard', group: 'Interface', bit: Btn.Scoreboard, defaults: ['Tab'] },
];

const ACTION_BY_ID = new Map<ActionId, ActionDef>(ACTIONS.map((a) => [a.id, a]));

export function actionDef(id: ActionId): ActionDef {
  const found = ACTION_BY_ID.get(id);
  if (found === undefined) throw new Error(`Unknown action "${id}"`);
  return found;
}

export function isActionId(value: string): value is ActionId {
  return ACTION_BY_ID.has(value as ActionId);
}

/** How a binding is stored: action id to the physical inputs bound to it. */
export type BindingMap = Partial<Record<ActionId, string[]>>;

export function defaultBindings(): BindingMap {
  const out: BindingMap = {};
  for (const a of ACTIONS) out[a.id] = [...a.defaults];
  return out;
}

/**
 * The compiled form: physical input to the bits it contributes.
 *
 * Built once whenever the bindings change and read on every DOM event, which is the whole
 * point — a keydown handler does one `Map.get` and an or, exactly as it did when the table
 * was a hard-coded array.
 */
export class Keybinds {
  private readonly byInput = new Map<string, number>();
  private bindings: BindingMap = defaultBindings();

  constructor(bindings?: BindingMap) {
    this.set(bindings ?? defaultBindings());
  }

  /** Replace the whole table and recompile. */
  set(bindings: BindingMap): void {
    this.bindings = normaliseBindings(bindings);
    this.byInput.clear();
    for (const action of ACTIONS) {
      for (const input of this.bindings[action.id] ?? []) {
        this.byInput.set(input, (this.byInput.get(input) ?? 0) | action.bit);
      }
    }
  }

  /** A copy, safe to hand to the save. */
  snapshot(): BindingMap {
    const out: BindingMap = {};
    for (const action of ACTIONS) out[action.id] = [...(this.bindings[action.id] ?? [])];
    return out;
  }

  /** Bits this physical input contributes, or 0. Allocation-free; called per DOM event. */
  bitsFor(input: string): number {
    return this.byInput.get(input) ?? 0;
  }

  /** What is currently bound to an action. */
  inputsFor(id: ActionId): readonly string[] {
    return this.bindings[id] ?? [];
  }

  /**
   * Bind `input` to `slot` of `action`, taking it from whatever held it before.
   *
   * Stealing rather than refusing is deliberate: a player rebinding sprint to `KeyE`
   * expects sprint to be on E afterwards, not an error message about "use". The previous
   * owner is returned so the settings screen can say what it took, which is the part a
   * player actually needs to know.
   */
  rebind(id: ActionId, slot: number, input: string): { stolenFrom: ActionId | null } {
    const next = this.snapshot();
    let stolenFrom: ActionId | null = null;

    for (const action of ACTIONS) {
      if (action.id === id) continue;
      const list = next[action.id];
      if (list === undefined) continue;
      const at = list.indexOf(input);
      if (at < 0) continue;
      list.splice(at, 1);
      stolenFrom = action.id;
    }

    const target = next[id] ?? [];
    // Rebinding a slot to something already on the *same* action collapses the duplicate
    // rather than leaving the action bound twice to one key.
    const dup = target.indexOf(input);
    if (dup >= 0 && dup !== slot) target.splice(dup, 1);
    const index = Math.min(slot, target.length);
    target[index] = input;
    next[id] = target;

    this.set(next);
    return { stolenFrom };
  }

  /** Drop one binding. An action with no bindings is legal and simply cannot be triggered. */
  clear(id: ActionId, slot: number): void {
    const next = this.snapshot();
    const list = next[id];
    if (list === undefined || slot >= list.length) return;
    list.splice(slot, 1);
    this.set(next);
  }

  resetToDefaults(): void {
    this.set(defaultBindings());
  }

  /** Every keyboard code currently bound, for `preventDefault`. */
  boundKeyCodes(): string[] {
    const out: string[] = [];
    for (const input of this.byInput.keys()) if (!isPointerInput(input)) out.push(input);
    return out;
  }
}

/** Mouse buttons and wheel share the code namespace; this is how they are told apart. */
export function isPointerInput(input: string): boolean {
  return input.startsWith('Mouse') || input === 'WheelUp' || input === 'WheelDown';
}

export function mouseInput(button: number): string {
  return `Mouse${button}`;
}

/** Human-readable, for the settings list and the controls card. */
export function inputLabel(input: string): string {
  if (input === 'WheelUp') return 'Wheel up';
  if (input === 'WheelDown') return 'Wheel down';
  if (input.startsWith('Mouse')) {
    // `MouseEvent.button` numbering, which is what `mouseInput` produces: 0 left, 1 middle,
    // 2 right. M8 had 1 and 2 the other way round, so the settings screen advertised a
    // binding the browser never delivers.
    const n = Number(input.slice(5));
    if (n === 0) return 'Left mouse';
    if (n === 1) return 'Middle mouse';
    if (n === 2) return 'Right mouse';
    return `Mouse ${n + 1}`;
  }
  if (input.startsWith('Key')) return input.slice(3);
  if (input.startsWith('Digit')) return input.slice(5);
  if (input.startsWith('Numpad')) return `Num ${input.slice(6)}`;
  if (input.startsWith('Arrow')) return `${input.slice(5)} arrow`;
  if (input === 'ControlLeft') return 'L Ctrl';
  if (input === 'ControlRight') return 'R Ctrl';
  if (input === 'ShiftLeft') return 'L Shift';
  if (input === 'ShiftRight') return 'R Shift';
  if (input === 'AltLeft') return 'L Alt';
  if (input === 'AltRight') return 'R Alt';
  return input;
}

/**
 * Repair a binding map read out of a save.
 *
 * Unknown action ids are dropped, non-string inputs are dropped, and **an action left with
 * nothing bound falls back to its defaults**. That last one matters: a save written by a
 * version that did not have killstreak keys would otherwise leave three actions unbound and
 * the player unable to call in anything, with no error anywhere to explain it.
 */
export function normaliseBindings(raw: unknown): BindingMap {
  const out = defaultBindings();
  if (typeof raw !== 'object' || raw === null) return out;
  const source = raw as Record<string, unknown>;

  for (const action of ACTIONS) {
    const list = source[action.id];
    if (!Array.isArray(list)) continue;
    const kept: string[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.length === 0) continue;
      if (!kept.includes(entry)) kept.push(entry);
    }
    // An empty list here means the player deliberately cleared it, which is legal — but a
    // *missing* list means the save predates the action, and that gets the default back.
    out[action.id] = kept;
  }
  return out;
}
