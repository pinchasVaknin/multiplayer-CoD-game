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
  { code: 'KeyR', bit: Btn.Reload },
  { code: 'Tab', bit: Btn.Scoreboard },
  { code: 'KeyQ', bit: Btn.SwapWeapon },
  { code: 'KeyG', bit: Btn.Lethal },
  { code: 'KeyF', bit: Btn.Tactical },
  { code: 'Digit1', bit: Btn.Slot1 },
  { code: 'Digit2', bit: Btn.Slot2 },
];

const MOVEMENT_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD'] as const;

/** Always suppressed, even while a debug control has focus. */
const ALWAYS_PREVENT = new Set(['F1', 'F2', 'F3', 'Tab']);

/**
 * Every code the game binds, suppressed so the browser's own chord does not fire
 * underneath it — Ctrl+S, Ctrl+A, Ctrl+D, Ctrl+F, Ctrl+P and friends all collide with
 * crouch-plus-a-movement-key.
 *
 * `Ctrl+W` and `Ctrl+T` are the exception and cannot be fixed this way: Chrome reserves
 * them and ignores `preventDefault`. The only mechanism that captures them is the
 * Keyboard Lock API, which is why `lockKeyboard` exists and why it needs fullscreen.
 */
const PREVENT_DEFAULT_CODES = new Set<string>([
  ...ALWAYS_PREVENT,
  ...MOVEMENT_CODES,
  ...BUTTON_BINDINGS.map((b) => b.code),
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

/** Narrow `navigator.keyboard` without an `any`; it is not in the DOM lib types. */
function keyboardLockApi(): KeyboardLockApi | null {
  const keyboard = (navigator as Navigator & { keyboard?: unknown }).keyboard;
  if (typeof keyboard !== 'object' || keyboard === null) return null;
  const lock = (keyboard as { lock?: unknown }).lock;
  const unlock = (keyboard as { unlock?: unknown }).unlock;
  if (typeof lock !== 'function' || typeof unlock !== 'function') return null;
  return keyboard as KeyboardLockApi;
}

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

  /**
   * `performance.now()` of the most recent left-mouse press that no consumer has taken
   * yet, or -1. Read by the input-latency probe (S7), which is the only thing allowed to
   * look at both sides of the input seam.
   */
  private firePressMs = -1;

  /** Set while a match is running; the lock is taken the moment fullscreen allows it. */
  private wantKeyboardLock = false;

  private lockListeners: Array<(locked: boolean) => void> = [];
  private escapeListeners: Array<() => void> = [];

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
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
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
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('focusin', this.onFocusIn);
    document.removeEventListener('focusout', this.onFocusOut);
    this.lockListeners = [];
    this.escapeListeners = [];
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

  /**
   * Ask the browser to route reserved chords to the page instead of to itself.
   *
   * This is the only way to stop `Ctrl+W` (crouch + forward) closing the tab —
   * `preventDefault` cannot touch it. Keyboard Lock is only grantable while the document
   * is fullscreen, and calling it outside fullscreen throws, so the request is deferred
   * until fullscreen actually happens: `wantKeyboardLock` arms it, and the
   * `fullscreenchange` handler takes it whenever the user presses F11. See PLAN.md.
   */
  lockKeyboard(): void {
    this.wantKeyboardLock = true;
    this.tryKeyboardLock();
  }

  unlockKeyboard(): void {
    this.wantKeyboardLock = false;
    keyboardLockApi()?.unlock();
  }

  /** True when reserved chords can actually be captured, i.e. the page is fullscreen. */
  get keyboardCaptureActive(): boolean {
    return document.fullscreenElement !== null && keyboardLockApi() !== null;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  onLockChange(fn: (locked: boolean) => void): void {
    this.lockListeners.push(fn);
  }

  /**
   * Escape was pressed (M5).
   *
   * Only fires when the browser did *not* consume the key to release pointer lock — that
   * case arrives through `onLockChange` instead. So one of the two always fires and never
   * both, which is what makes "Esc pauses, Esc resumes" a single rule.
   */
  onEscape(fn: () => void): void {
    this.escapeListeners.push(fn);
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

  /**
   * Add to the absolute view angles, in radians.
   *
   * The sim uses this for the residual half of a recoil kick — the part that does not
   * recover. It is deliberately the *same* channel mouse movement writes to, because it
   * is the same quantity: where the player is now aiming (brief S6.2).
   */
  addViewOffset(deltaYaw: number, deltaPitch: number): void {
    this.yawRad = wrapAngle(this.yawRad + deltaYaw);
    this.pitchRad = clamp(this.pitchRad + deltaPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Take the timestamp of an unconsumed left-mouse press, or -1.
   *
   * Instrumentation only: the latency probe needs the DOM event time, and `InputCommand`
   * is a locked interface (S4.2) that must not grow a field for a debug tool.
   */
  takeFirePress(): number {
    const at = this.firePressMs;
    this.firePressMs = -1;
    return at;
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

  /**
   * A dead player's command: neutral, except that Tab still gets through (M5).
   *
   * M4 shipped `sampleNeutral` for the dead player, which was right about movement and
   * wrong about the scoreboard — the death screen is exactly when you want to look at it.
   * `Btn.Scoreboard` is presentation and drives nothing in the sim, so passing it costs
   * nothing and closes the M4 playtest note.
   */
  sampleSpectating(tickIndex: number, nowMs: number): InputCommand {
    const cmd = this.ring.next();
    cmd.seq = this.seq++;
    cmd.tickIndex = tickIndex;
    cmd.moveX = 0;
    cmd.moveZ = 0;
    cmd.yaw = this.yawRad;
    cmd.pitch = this.pitchRad;
    cmd.buttons = (this.buttons | this.mouseButtons) & Btn.Scoreboard;
    cmd.sampledAtMs = nowMs;
    return cmd;
  }

  /** Drop every held key. Called on blur and on state changes. */
  clearHeld(): void {
    this.held.clear();
    this.buttons = 0;
    this.mouseButtons = 0;
    this.firePressMs = -1;
  }

  // -- handlers -----------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Escape is never bound to a game action and never prevented — the browser owns it —
    // but the state machine wants to know. Announced before the focus guard so it works
    // from a paused screen where a button has focus.
    if (e.code === 'Escape' && !e.repeat) {
      for (const fn of this.escapeListeners) fn();
      return;
    }
    // While a debug slider has focus the page belongs to the DOM, so only the overlay's
    // own function keys are taken; everything else behaves like an ordinary web page.
    const guarded = this.domFocusGuard && !ALWAYS_PREVENT.has(e.code);
    if (!guarded && PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
    if (guarded) return;
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

  /**
   * Mouse buttons are latched unconditionally; whether they *mean* anything is the state
   * machine's business, because outside a match the sim consumes `sampleNeutral` and
   * never sees them. Gating on pointer lock here instead would make the input path
   * untestable without a real cursor capture, and `MATCH` entry clears held buttons so
   * the click that started the match cannot also pull the trigger.
   */
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (this.domFocusGuard) return;
    if (e.button === 2) this.mouseButtons |= Btn.Ads;
    if (e.button === 0) {
      this.mouseButtons |= Btn.Fire;
      // Stamped here, at the DOM edge, so the latency probe measures the whole path.
      this.firePressMs = performance.now();
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.mouseButtons &= ~Btn.Ads;
    if (e.button === 0) this.mouseButtons &= ~Btn.Fire;
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

  private readonly onFullscreenChange = (): void => {
    this.tryKeyboardLock();
  };

  private readonly onFocusIn = (e: FocusEvent): void => {
    this.domFocusGuard = isFormControl(e.target);
    if (this.domFocusGuard) this.clearHeld();
  };

  private readonly onFocusOut = (): void => {
    this.domFocusGuard = false;
  };

  private tryKeyboardLock(): void {
    if (!this.wantKeyboardLock) return;
    // Outside fullscreen the request is guaranteed to fail, and failing loudly every time
    // a match starts would make the console noise a permanent feature.
    if (document.fullscreenElement === null) return;
    const api = keyboardLockApi();
    if (api === null) return;
    api.lock(['KeyW', 'KeyT', 'KeyN', 'KeyD', 'KeyR']).catch((err: unknown) => {
      console.warn('[Input] keyboard lock refused; Ctrl+W will still reach the browser.', err);
    });
  }

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
