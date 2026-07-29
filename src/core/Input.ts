import { clamp, DEG2RAD, wrapAngle } from './MathUtil';
import { Btn, CommandRing, type InputCommand } from './InputCommand';

/**
 * The only place in the project that touches keyboard, mouse or pointer lock.
 *
 * View angles are integrated here, at render rate, straight out of the mousemove
 * handler — raw deltas, no smoothing, no acceleration (brief S5.4). Everything else
 * is latched into a bitfield and stamped into a command once per sim tick.
 */

const PITCH_LIMIT = 89 * DEG2RAD;

/** Radians of yaw per mouse count at sensitivity 1.0. Matches a ~0.022 CoD feel. */
const RAD_PER_COUNT = 0.0022;

/**
 * Chrome occasionally delivers one enormous movementX/Y on the first event after
 * pointer lock is (re)acquired. Both guards below exist so re-clicking never snaps
 * the camera (acceptance criterion 1).
 */
const MAX_DELTA_PER_EVENT = 400;
const SETTLE_EVENTS_AFTER_LOCK = 1;

interface KeyBinding {
  readonly code: string;
  readonly bit: number;
}

const BUTTON_BINDINGS: readonly KeyBinding[] = [
  { code: 'Space', bit: Btn.Jump },
  { code: 'ControlLeft', bit: Btn.Crouch },
  { code: 'KeyC', bit: Btn.Crouch },
  { code: 'ShiftLeft', bit: Btn.Sprint },
];

const PREVENT_DEFAULT_CODES = new Set(['Space', 'F1', 'F2', 'F3', 'Tab', 'ArrowUp', 'ArrowDown']);

export interface InputOptions {
  readonly canvas: HTMLCanvasElement;
  readonly sensitivity: number;
  readonly invertY: boolean;
}

export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly ring = new CommandRing(128);

  private readonly held = new Set<string>();
  private buttons = 0;
  private mouseButtons = 0;

  private yawRad = 0;
  private pitchRad = 0;

  private sensitivity: number;
  private invertY: boolean;

  private seq = 0;
  private locked = false;
  private settleCounter = 0;

  private lockListeners: Array<(locked: boolean) => void> = [];

  /** Set true while a DOM control (a tuning slider, a menu button) has focus. */
  private domFocusGuard = false;

  constructor(opts: InputOptions) {
    this.canvas = opts.canvas;
    this.sensitivity = opts.sensitivity;
    this.invertY = opts.invertY;
    this.attach();
  }

  // -- lifecycle ----------------------------------------------------------

  private attach(): void {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
    document.addEventListener('focusin', this.onFocusIn);
    document.addEventListener('focusout', this.onFocusOut);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    document.removeEventListener('focusin', this.onFocusIn);
    document.removeEventListener('focusout', this.onFocusOut);
    this.lockListeners = [];
  }

  // -- pointer lock -------------------------------------------------------

  requestPointerLock(): void {
    if (this.locked) return;
    const result: unknown = this.canvas.requestPointerLock();
    // Chrome 113+ returns a promise; older builds return undefined.
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.warn('[Input] pointer lock request rejected:', err);
      });
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  onLockChange(fn: (locked: boolean) => void): void {
    this.lockListeners.push(fn);
  }

  // -- settings -----------------------------------------------------------

  setSensitivity(value: number): void {
    this.sensitivity = value;
  }

  setInvertY(value: boolean): void {
    this.invertY = value;
  }

  // -- view ---------------------------------------------------------------

  get yaw(): number {
    return this.yawRad;
  }

  get pitch(): number {
    return this.pitchRad;
  }

  /** Used on spawn so the player faces the map's spawn direction. */
  setView(yaw: number, pitch: number): void {
    this.yawRad = wrapAngle(yaw);
    this.pitchRad = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  // -- sampling -----------------------------------------------------------

  /**
   * Produce the command for `tickIndex`. Called exactly once per sim tick.
   * Zero allocation: the returned object is a reused ring slot.
   */
  sample(tickIndex: number, nowMs: number): InputCommand {
    let x = 0;
    let z = 0;
    if (this.held.has('KeyA')) x -= 1;
    if (this.held.has('KeyD')) x += 1;
    if (this.held.has('KeyW')) z += 1;
    if (this.held.has('KeyS')) z -= 1;

    // Normalise diagonals here, once, so no downstream code has to remember to.
    if (x !== 0 && z !== 0) {
      const inv = Math.SQRT1_2;
      x *= inv;
      z *= inv;
    }

    const cmd = this.ring.next();
    cmd.seq = this.seq++;
    cmd.tickIndex = tickIndex;
    cmd.moveX = x;
    cmd.moveZ = z;
    cmd.yaw = this.yawRad;
    cmd.pitch = this.pitchRad;
    cmd.buttons = this.buttons | this.mouseButtons;
    cmd.sampledAtMs = nowMs;
    return cmd;
  }

  /**
   * A command with no input, stamped with the current view angles.
   *
   * The sim must keep ticking outside a match — gravity, timers and interpolation all
   * depend on it — but keys pressed while a menu is up must not drive the player.
   */
  sampleNeutral(tickIndex: number, nowMs: number): InputCommand {
    const cmd = this.ring.next();
    cmd.seq = this.seq++;
    cmd.tickIndex = tickIndex;
    cmd.moveX = 0;
    cmd.moveZ = 0;
    cmd.yaw = this.yawRad;
    cmd.pitch = this.pitchRad;
    cmd.buttons = 0;
    cmd.sampledAtMs = nowMs;
    return cmd;
  }

  /** Drop every held key. Called on blur and on state changes. */
  clearHeld(): void {
    this.held.clear();
    this.buttons = 0;
    this.mouseButtons = 0;
  }

  // -- handlers -----------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
    if (this.domFocusGuard) return;
    if (e.repeat) return;
    this.held.add(e.code);
    this.buttons |= bitsFor(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    // A bit stays set while any other binding for it is still held (Ctrl vs C).
    this.buttons = this.recomputeKeyButtons();
  };

  private readonly onBlur = (): void => {
    this.clearHeld();
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    if (this.settleCounter > 0) {
      this.settleCounter--;
      return;
    }
    const dx = clamp(e.movementX, -MAX_DELTA_PER_EVENT, MAX_DELTA_PER_EVENT);
    const dy = clamp(e.movementY, -MAX_DELTA_PER_EVENT, MAX_DELTA_PER_EVENT);
    const scale = RAD_PER_COUNT * this.sensitivity;
    this.yawRad = wrapAngle(this.yawRad - dx * scale);
    const pitchDelta = (this.invertY ? dy : -dy) * scale;
    this.pitchRad = clamp(this.pitchRad + pitchDelta, -PITCH_LIMIT, PITCH_LIMIT);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (this.domFocusGuard) return;
    if (e.button === 2) this.mouseButtons |= Btn.Ads;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.mouseButtons &= ~Btn.Ads;
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    const nowLocked = document.pointerLockElement === this.canvas;
    if (nowLocked === this.locked) return;
    this.locked = nowLocked;
    if (nowLocked) {
      // Swallow the first delta so re-acquiring lock never snaps the view.
      this.settleCounter = SETTLE_EVENTS_AFTER_LOCK;
    } else {
      this.clearHeld();
    }
    document.body.classList.toggle('op-locked', nowLocked);
    for (const fn of this.lockListeners) fn(nowLocked);
  };

  private readonly onPointerLockError = (): void => {
    console.warn('[Input] pointer lock error; the browser refused the request.');
  };

  private readonly onFocusIn = (e: FocusEvent): void => {
    this.domFocusGuard = isFormControl(e.target);
    if (this.domFocusGuard) this.clearHeld();
  };

  private readonly onFocusOut = (): void => {
    this.domFocusGuard = false;
  };

  private recomputeKeyButtons(): number {
    let bits = 0;
    for (const binding of BUTTON_BINDINGS) {
      if (this.held.has(binding.code)) bits |= binding.bit;
    }
    return bits;
  }
}

function bitsFor(code: string): number {
  let bits = 0;
  for (const binding of BUTTON_BINDINGS) {
    if (binding.code === code) bits |= binding.bit;
  }
  return bits;
}

function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
