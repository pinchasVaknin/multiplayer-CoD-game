import { clamp, DEG2RAD, wrapAngle } from '../../shared/core/MathUtil';
import { Btn, CommandRing, type InputCommand } from '../../shared/core/InputCommand';
import { Keybinds, LocalBtn, mouseInput, type BindingMap } from '../../shared/core/Keybinds';

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

/**
 * Always suppressed, even while a debug control has focus.
 *
 * F1 is still here even though M6 unbound it from the overlay: Chrome opens its own help
 * on F1, and a stray press mid-match sending the player to a support page would be worse
 * than the panel it used to open.
 */
const ALWAYS_PREVENT = new Set(['F1', 'F2', 'F3', 'Tab']);

/** Suppressed regardless of what is bound, so the page never scrolls under the game. */
const ALSO_PREVENT = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;

/**
 * How long the wheel counts as "held", in milliseconds.
 *
 * A wheel notch is an impulse and the bitfield is a level, so something has to give it a
 * duration. Two sim ticks is long enough that the sampler cannot miss it between frames and
 * short enough that one notch is one press — which is what makes `WheelUp` bindable to
 * weapon swap and behave like the tap it looks like.
 */
const WHEEL_HOLD_MS = 34;

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
  /** M8. Absent means the shipped defaults. */
  readonly bindings?: BindingMap;
}

export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly ring = new CommandRing(128);

  /** M8. The one place a physical input becomes a bit. See `core/Keybinds.ts`. */
  readonly keybinds: Keybinds;

  private readonly held = new Set<string>();
  private buttons = 0;
  private mouseButtons = 0;
  /** `performance.now()` until which a wheel notch still counts as held. */
  private wheelUntilMs = 0;
  private wheelBits = 0;

  private yawRad = 0;
  private pitchRad = 0;

  private sensitivity: number;
  /**
   * M8. Multiplier applied while aiming down sights (S6.3).
   *
   * Driven per frame from the weapon's ADS fraction rather than from the button, so the
   * sensitivity travels *with* the sights instead of snapping when the button goes down —
   * the same reason `CameraDrive.ads` became a fraction in M2.
   */
  private adsSensitivity = 1;
  private adsFraction = 0;
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

  /** Set while a match is live: a click re-acquires pointer lock. See `armPointerLock`. */
  private wantPointerLock = false;
  private lockRejectedWhileArmed = false;

  private lockListeners: Array<(locked: boolean) => void> = [];
  private escapeListeners: Array<() => void> = [];

  /** Set true while a DOM control (a tuning slider, a menu button) has focus. */
  private domFocusGuard = false;

  /**
   * Whether physical inputs currently resolve to game actions (post-M8 playtest).
   *
   * The bug that produced it: `swapWeapon` is bound to `WheelUp`, and `onWheel` calls
   * `preventDefault` for anything that resolves to a bit. On the settings screen that meant
   * the wheel scrolled the binding list *down* and refused to scroll it back up, which reads
   * exactly as the reported "scrolling gets stuck and I have to drag the scrollbar".
   *
   * The honest fix is not a special case for the wheel. A front-end screen owns the page, and
   * while one is up the game is not taking input at all — the sim already knows that
   * (`sampleNeutral`), so this is the same rule applied one layer earlier, at the DOM edge,
   * where `preventDefault` lives. `Game` sets it from the state machine: true in MATCH,
   * false everywhere else.
   *
   * Escape and the overlay's function keys deliberately still get through: they are how you
   * leave a screen, not things you do in one.
   */
  private bindingsActive = true;

  constructor(opts: InputOptions) {
    this.canvas = opts.canvas;
    this.sensitivity = opts.sensitivity;
    this.invertY = opts.invertY;
    this.keybinds = new Keybinds(opts.bindings);
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
    window.addEventListener('wheel', this.onWheel, { passive: false });
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
    window.removeEventListener('wheel', this.onWheel);
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
        // While armed the next click will try again, so a rejection is expected rather
        // than exceptional — say so once and then stop filling the console with it.
        if (this.wantPointerLock && this.lockRejectedWhileArmed) return;
        if (this.wantPointerLock) this.lockRejectedWhileArmed = true;
        console.warn('[Input] pointer lock request rejected:', err);
      });
    }
  }

  /**
   * Arm click-to-recapture (M5 hotfix).
   *
   * A bare `requestPointerLock` only succeeds from a user gesture, and Chrome additionally
   * refuses one for a short window after the user has left the lock with Escape. That makes
   * two ways to come back from the pause screen fail: resuming with Escape has no gesture at
   * all, and resuming with the button can land inside the cooldown.
   *
   * So while armed, a click anywhere re-acquires the lock — and that click is *consumed*
   * rather than passed on, for the same reason `MATCH` entry clears held buttons: the click
   * that gets you back into the game must not also pull the trigger.
   */
  armPointerLock(on: boolean): void {
    this.wantPointerLock = on;
    if (!on) {
      this.lockRejectedWhileArmed = false;
      return;
    }
    this.requestPointerLock();
  }

  get pointerLockArmed(): boolean {
    return this.wantPointerLock;
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

  /** M8. Multiplier on look sensitivity at full ADS (S6.3). 1 means no change. */
  setAdsSensitivity(value: number): void {
    this.adsSensitivity = Math.max(0.1, Math.min(2, value));
  }

  /**
   * How far into the sights the weapon is, 0..1. Written every frame from `Match.visual`.
   *
   * The scale is interpolated across the transition rather than switched at the button,
   * because the alternative is the crosshair changing speed a tenth of a second before the
   * sights arrive — which reads as input lag rather than as a sensitivity setting.
   */
  setAdsFraction(value: number): void {
    this.adsFraction = Math.max(0, Math.min(1, value));
  }

  /**
   * Turn the binding table on or off at the DOM edge. See `bindingsActive`.
   *
   * Clears held state on the way down, so a key still held when a screen opens cannot be
   * latched across the gap and arrive as a press when the match resumes.
   */
  setBindingsActive(on: boolean): void {
    if (on === this.bindingsActive) return;
    this.bindingsActive = on;
    if (!on) this.clearHeld();
  }

  get bindingsEnabled(): boolean {
    return this.bindingsActive;
  }

  /** M8. Swap the binding table live and re-arm the reserved-chord capture. */
  setBindings(bindings: BindingMap): void {
    this.keybinds.set(bindings);
    // Held keys were latched under the old table; their bits would be stale.
    this.clearHeld();
    this.tryKeyboardLock();
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
    // M8: the movement axes come out of the same bitfield everything else does, so a
    // rebound "forward" travels the identical path a default one does (see `Keybinds`).
    const bits = this.liveBits(nowMs);
    let x = 0;
    let z = 0;
    if ((bits & LocalBtn.Left) !== 0) x -= 1;
    if ((bits & LocalBtn.Right) !== 0) x += 1;
    if ((bits & LocalBtn.Forward) !== 0) z += 1;
    if ((bits & LocalBtn.Back) !== 0) z -= 1;

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
    // The local movement bits are masked off: they are the sampler's business and the sim
    // has no bit assignments up there.
    cmd.buttons = bits & WIRE_BITS;
    cmd.sampledAtMs = nowMs;
    return cmd;
  }

  /** Everything currently down, including a wheel notch that has not expired. */
  private liveBits(nowMs: number): number {
    const wheel = nowMs <= this.wheelUntilMs ? this.wheelBits : 0;
    return this.buttons | this.mouseButtons | wheel;
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
    this.wheelBits = 0;
    this.wheelUntilMs = 0;
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
    // While a debug slider has focus — or a front-end screen is up — the page belongs to the
    // DOM, so only the overlay's own function keys are taken; everything else behaves like an
    // ordinary web page, including Tab moving focus and the arrow keys scrolling a list.
    const guarded = (this.domFocusGuard || !this.bindingsActive) && !ALWAYS_PREVENT.has(e.code);
    if (!guarded && this.shouldPreventDefault(e.code)) e.preventDefault();
    if (guarded) return;
    if (e.repeat) return;
    this.held.add(e.code);
    this.buttons |= this.keybinds.bitsFor(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    // A bit stays set while any other binding for it is still held (Ctrl vs C).
    this.buttons = this.recomputeKeyButtons();
  };

  /**
   * Suppress the browser's own chord under anything the game binds.
   *
   * Ctrl+S, Ctrl+A, Ctrl+D, Ctrl+F and Ctrl+P all collide with crouch plus a movement key,
   * and which keys those are is now a player decision — so the set is asked of the binding
   * table rather than baked in. `Ctrl+W` and `Ctrl+T` remain the exception and cannot be
   * fixed this way: Chrome reserves them and ignores `preventDefault`. The only mechanism
   * that captures them is the Keyboard Lock API, which is why `lockKeyboard` exists and why
   * it needs fullscreen.
   */
  private shouldPreventDefault(code: string): boolean {
    if (ALWAYS_PREVENT.has(code)) return true;
    for (const arrow of ALSO_PREVENT) if (code === arrow) return true;
    return this.keybinds.bitsFor(code) !== 0;
  }

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
    // M8: the ADS multiplier is blended in by how far the sights are up, so the change
    // arrives with the picture rather than a tenth of a second before it.
    const adsScale = 1 + (this.adsSensitivity - 1) * this.adsFraction;
    const scale = RAD_PER_COUNT * this.sensitivity * adsScale;
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
    if (this.domFocusGuard || !this.bindingsActive) return;
    // Armed and unlocked: this click is the gesture that gets the cursor back, and it is
    // spent doing that. Passing it on as well would fire the weapon on the frame the player
    // clicked to resume.
    if (this.wantPointerLock && !this.locked) {
      this.lockRejectedWhileArmed = false;
      this.requestPointerLock();
      return;
    }
    const bits = this.keybinds.bitsFor(mouseInput(e.button));
    this.mouseButtons |= bits;
    // Stamped here, at the DOM edge, so the latency probe measures the whole path. Keyed
    // off the *bit* rather than off button 0, so a player who moved fire onto another
    // button still gets a latency reading.
    if ((bits & Btn.Fire) !== 0) this.firePressMs = performance.now();
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.mouseButtons &= ~this.keybinds.bitsFor(mouseInput(e.button));
  };

  /**
   * A wheel notch, latched for `WHEEL_HOLD_MS`.
   *
   * The bitfield is a level and a notch is an impulse, so the notch is given just enough
   * duration for the 60 Hz sampler to see it exactly once. Not prevented unless something
   * is actually bound to it, so the page still scrolls normally on a menu.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    // Returning *before* `preventDefault` is the point: on a menu the wheel has to reach the
    // page, or a scrollable panel can only be scrolled in whichever direction happens not to
    // be bound to anything.
    if (this.domFocusGuard || !this.bindingsActive || e.deltaY === 0) return;
    const bits = this.keybinds.bitsFor(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
    if (bits === 0) return;
    e.preventDefault();
    this.wheelBits = bits;
    this.wheelUntilMs = performance.now() + WHEEL_HOLD_MS;
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
    // The reserved chords worth taking are the ones the player has actually bound, plus
    // the two Chrome will not release any other way.
    const codes = new Set(this.keybinds.boundKeyCodes());
    codes.add('KeyW');
    codes.add('KeyT');
    codes.add('KeyN');
    api.lock([...codes]).catch((err: unknown) => {
      console.warn('[Input] keyboard lock refused; Ctrl+W will still reach the browser.', err);
    });
  }

  private recomputeKeyButtons(): number {
    let bits = 0;
    for (const code of this.held) bits |= this.keybinds.bitsFor(code);
    return bits;
  }
}

/**
 * Bits that cross the wire.
 *
 * The movement axes ride local bits above this mask (`core/Keybinds.ts`) so that binding
 * lookup is uniform, and they are masked off before the command is built — `InputCommand`
 * carries `moveX`/`moveZ` and has no bit assignments up there.
 */
const WIRE_BITS = 0x00ff_ffff;

function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
