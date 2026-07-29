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
} as const;

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
