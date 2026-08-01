/**
 * The input seam (brief S4.2).
 *
 * Gameplay never reads the DOM or a live key map. Input is sampled into immutable
 * commands; `PlayerController.step(cmd)` consumes exactly one per tick. Edge
 * detection is computed inside the sim from the bitfield, never in a DOM handler.
 *
 * This is what makes `INetworkTransport` real rather than decorative.
 */
export interface InputCommand {
  readonly seq: number; // monotonic
  readonly tickIndex: number;
  readonly moveX: number; // -1..1, already normalised for diagonals
  readonly moveZ: number; // -1..1
  readonly yaw: number; // radians, absolute
  readonly pitch: number; // radians, absolute, clamped +/- 89 deg
  readonly buttons: number; // bitfield
  readonly sampledAtMs: number; // performance.now() at sample time
}

/** Button bits. Only bits that are actually bound and consumed exist. */
export const Btn = {
  Jump: 1 << 0,
  Crouch: 1 << 1,
  Sprint: 1 << 2,
  /** Right mouse. Drives both the movement speed cap and the weapon's ADS state. */
  Ads: 1 << 3,
  /** Left mouse. Held, not edge-triggered: the weapon decides what auto fire means. */
  Fire: 1 << 4,
  Reload: 1 << 5,
  /**
   * Tab, held. The scoreboard is presentation rather than gameplay, but it rides the same
   * bitfield as everything else so there is still exactly one input path (S4.2) — the
   * alternative is a DOM listener in the UI layer that the harness cannot drive.
   */
  Scoreboard: 1 << 6,

  // -- M5 ------------------------------------------------------------------
  /** Q, or the mouse wheel. Toggles primary/secondary (S6.4). */
  SwapWeapon: 1 << 7,
  /** G, held to cook and released to throw: frag, semtex, claymore (S6.3). */
  Lethal: 1 << 8,
  /** F. Flashbang or smoke, depending on the loadout (S6.3). */
  Tactical: 1 << 9,
  /**
   * Slot 1 and slot 2 as absolute selections rather than a toggle.
   *
   * Kept separate from `SwapWeapon` because "press 2 twice" must not put the rifle back —
   * a toggle and a selection are different inputs even when they usually agree.
   */
  Slot1: 1 << 10,
  Slot2: 1 << 11,

  // -- M6 ------------------------------------------------------------------
  /** X. Activates the loadout's field upgrade once its charge is full (S6.3). */
  FieldUpgrade: 1 << 12,

  // -- M7 ------------------------------------------------------------------
  /**
   * 3, 4 and 5. Spend the first, second or third earned killstreak (S6.1).
   *
   * Absolute selections rather than a single "use next" key, for the same reason `Slot1` and
   * `Slot2` are not a toggle: a player holding a UAV and a Chopper Gunner is making a choice,
   * and a key that cycles would make it a guess.
   */
  Streak1: 1 << 13,
  Streak2: 1 << 14,
  Streak3: 1 << 15,
} as const;

/**
 * Hold-breath (S6.1) rides `Btn.Sprint`, which is what the brief asks for: Shift.
 *
 * It is not a new bit because the two can never be live at once — a scoped sniper is not
 * sprinting, and `PlayerController` already refuses to sprint while aimed.
 */
export const HOLD_BREATH_BIT = Btn.Sprint;

export type ButtonBit = (typeof Btn)[keyof typeof Btn];

export function isDown(buttons: number, bit: ButtonBit): boolean {
  return (buttons & bit) !== 0;
}

export function justPressed(buttons: number, prevButtons: number, bit: ButtonBit): boolean {
  return (buttons & bit) !== 0 && (prevButtons & bit) === 0;
}

export function justReleased(buttons: number, prevButtons: number, bit: ButtonBit): boolean {
  return (buttons & bit) === 0 && (prevButtons & bit) !== 0;
}

/** Writable view of a command. Only the sampler and the transport touch this. */
export interface MutableInputCommand {
  seq: number;
  tickIndex: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  buttons: number;
  sampledAtMs: number;
}

export function copyCommand(src: InputCommand, dst: MutableInputCommand): void {
  dst.seq = src.seq;
  dst.tickIndex = src.tickIndex;
  dst.moveX = src.moveX;
  dst.moveZ = src.moveZ;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.buttons = src.buttons;
  dst.sampledAtMs = src.sampledAtMs;
}

function makeCommand(): MutableInputCommand {
  return { seq: 0, tickIndex: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, sampledAtMs: 0 };
}

/**
 * Fixed ring of command records.
 *
 * Commands are conceptually immutable, but allocating one per tick would violate
 * the zero-allocation sim rule (S4.7). Instead a ring of backing records is reused;
 * consumers only ever see the readonly `InputCommand` view. A slot stays valid for
 * `capacity` ticks, which at 60 Hz is over two seconds — far longer than any
 * consumer holds one.
 */
export class CommandRing {
  private readonly buf: MutableInputCommand[] = [];
  private head = 0;

  constructor(readonly capacity: number) {
    if (capacity < 2) throw new Error('CommandRing capacity must be >= 2');
    for (let i = 0; i < capacity; i++) this.buf.push(makeCommand());
  }

  /** Claim the next slot for writing. */
  next(): MutableInputCommand {
    const slot = this.buf[this.head];
    if (slot === undefined) throw new Error('CommandRing corrupted');
    this.head = (this.head + 1) % this.capacity;
    return slot;
  }
}

/** The zero command: what the sim consumes when no input is available. */
export const NULL_COMMAND: InputCommand = Object.freeze({
  seq: -1,
  tickIndex: -1,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  sampledAtMs: 0,
});
