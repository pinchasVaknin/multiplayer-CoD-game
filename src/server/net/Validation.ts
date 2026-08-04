import type { MutableInputCommand } from '../../shared/core/InputCommand';
import { MAX_TICK_SKEW } from '../../shared/net/Protocol';

/**
 * Boundary validation on everything a client sends (M10, S4.16).
 *
 * S4.16 sets the scope precisely, and both halves matter:
 *
 * > *"Validate at the boundary: clamp `moveX`/`moveZ` magnitude, reject impossible yaw
 * > deltas, rate-limit fire against the weapon's RPM, reject commands too far from the
 * > current tick."*
 *
 * > *"Do not build heuristic anti-cheat — no speed-hack detectors, no aim analysis.
 * > Authority plus boundary validation is the whole defence at this scale."*
 *
 * The line between the two is what this file is built on: everything here rejects input that
 * is **structurally impossible**, never input that is merely suspicious. A command with
 * `moveX = 1e9` is not a player, and clamping it costs nothing. A player who lands a lot of
 * headshots is a player who lands a lot of headshots.
 *
 * ## On rate-limiting fire
 *
 * S4.16 names it, and it is worth stating why the implementation is not where a reader would
 * look for it. Rate of fire is enforced by the **server's own `WeaponSystem`**: it steps the
 * authoritative weapon, which produces `pendingShots` from the def's RPM and refuses to
 * produce more. A client that sets the fire bit on every tick of every command gets exactly
 * the weapon's rate of fire, because the server is the thing deciding. That is authority, and
 * it is strictly stronger than a boundary check could be — a check here could only compare
 * against the same number the simulation already enforces.
 *
 * What genuinely needs bounding at the boundary is **how many commands arrive**, since that
 * is bandwidth and CPU rather than gameplay, and that is `rateLimit` below.
 */

/**
 * ## On "reject impossible yaw deltas"
 *
 * S4.16 asks for this by name and it turns out **not to be expressible** for this input
 * model, which is worth recording rather than pretending otherwise.
 *
 * `InputCommand.yaw` is an *absolute* angle (S4.2), and angles wrap. The shortest angular
 * distance between any two absolute yaws is at most pi by construction — so after the
 * wrap-aware comparison every possible pair of consecutive commands is within half a turn,
 * and no threshold at or below pi can ever reject anything. A threshold *below* pi would be
 * an aim-speed limit, which is precisely the heuristic anti-cheat the same section forbids
 * two bullets later: a 180-degree flick in one tick is a thing real players do.
 *
 * The check was implemented, measured to be unreachable, and removed. What remains is a
 * range check that rejects values which are not angles at all (non-finite, or outside
 * +/-2pi), which is the part that was ever doing work. Flagged in the milestone report as an
 * under-specified item in the brief.
 *
 * ## Why a command or a frame was refused
 *
 * Reported per reason by the server metrics (S7).
 */
export const Reject = {
  None: 0,
  /** `tickIndex` outside the window a live client could plausibly be simulating. */
  TickSkew: 1,
  /** A non-finite number anywhere in the struct. */
  NotFinite: 2,
  /** Move axes longer than unit, or angles outside their legal range. */
  OutOfRange: 3,
  /** Retired: see the note above. Kept so the reason numbering stays stable on the wire. */
  YawRate: 4,
  /** Too many messages per second on this connection. */
  RateLimit: 5,
  /** Frame larger than the protocol allows. */
  Oversize: 6,
  /** Failed to decode: bad magic, unknown id, truncated body. */
  Malformed: 7,
  /** A message that is not legal in the connection's current state. */
  OutOfOrder: 8,
} as const;

export type RejectReason = (typeof Reject)[keyof typeof Reject];

export const REJECT_NAMES: Readonly<Record<number, string>> = {
  [Reject.None]: 'none',
  [Reject.TickSkew]: 'tick-skew',
  [Reject.NotFinite]: 'not-finite',
  [Reject.OutOfRange]: 'out-of-range',
  [Reject.YawRate]: 'yaw-rate',
  [Reject.RateLimit]: 'rate-limit',
  [Reject.Oversize]: 'oversize',
  [Reject.Malformed]: 'malformed',
  [Reject.OutOfOrder]: 'out-of-order',
};

/** Pitch is clamped to +/-89 deg at the sampler (S4.2); anything past this is not a client. */
const PITCH_LIMIT = (89.5 * Math.PI) / 180;

/**
 * Validate and clamp one decoded command **in place**.
 *
 * Clamping rather than rejecting where a clamp is meaningful: a slightly over-length move
 * vector is what a buggy or unusual client produces, and normalising it costs one square root
 * and keeps the player playing. Rejecting is reserved for values that cannot be interpreted
 * at all.
 */
export function validateCommand(cmd: MutableInputCommand, currentTick: number): RejectReason {
  if (
    !Number.isFinite(cmd.moveX) ||
    !Number.isFinite(cmd.moveZ) ||
    !Number.isFinite(cmd.yaw) ||
    !Number.isFinite(cmd.pitch) ||
    !Number.isFinite(cmd.tickIndex) ||
    !Number.isFinite(cmd.seq)
  ) {
    return Reject.NotFinite;
  }

  if (cmd.tickIndex < currentTick - MAX_TICK_SKEW || cmd.tickIndex > currentTick + MAX_TICK_SKEW) {
    return Reject.TickSkew;
  }

  if (cmd.pitch < -PITCH_LIMIT || cmd.pitch > PITCH_LIMIT) return Reject.OutOfRange;
  if (cmd.yaw < -Math.PI * 2 || cmd.yaw > Math.PI * 2) return Reject.OutOfRange;

  // Over-length move vectors are the one case worth saving rather than refusing: normalise
  // to unit and carry on. `PlayerController` assumes |move| <= 1 and scales its speed cap by
  // the magnitude, so an unclamped 5.0 here would be a five-times speed cap.
  const len = Math.hypot(cmd.moveX, cmd.moveZ);
  if (len > 1) {
    const inv = 1 / len;
    cmd.moveX *= inv;
    cmd.moveZ *= inv;
  }

  // Buttons is a bitfield; bits above the highest defined one drive nothing, and masking
  // costs less than validating. `Btn.Melee` is 1 << 17, so 18 bits are live.
  cmd.buttons = cmd.buttons & 0x0003_ffff;
  cmd.seq = cmd.seq >>> 0;
  cmd.tickIndex = cmd.tickIndex | 0;

  return Reject.None;
}

/**
 * A sliding-window message rate limit.
 *
 * Counts within one-second buckets rather than keeping timestamps: a flooding client is
 * exactly the case where an array of arrival times would be the attack. Two buckets are kept
 * so the limit is not resettable by timing a burst across a boundary.
 */
export class RateLimiter {
  private currentSecond = -1;
  private current = 0;
  private previous = 0;

  constructor(private readonly perSecond: number) {}

  /** True if this message is within the limit. Counts it either way. */
  allow(nowMs: number): boolean {
    const second = Math.floor(nowMs / 1000);
    if (second !== this.currentSecond) {
      // A gap of more than one second means the previous bucket is stale, not adjacent.
      this.previous = second === this.currentSecond + 1 ? this.current : 0;
      this.current = 0;
      this.currentSecond = second;
    }
    this.current++;
    // Weight the previous bucket by how much of it is still inside the trailing second.
    const fraction = 1 - ((nowMs % 1000) / 1000);
    const windowed = this.current + this.previous * fraction;
    return windowed <= this.perSecond;
  }

  reset(): void {
    this.currentSecond = -1;
    this.current = 0;
    this.previous = 0;
  }
}

/** Running tally of rejections by reason, for the server metrics (S7). */
export class RejectCounters {
  private readonly counts = new Int32Array(16);

  note(reason: RejectReason): void {
    if (reason > 0 && reason < this.counts.length) this.counts[reason] = (this.counts[reason] ?? 0) + 1;
  }

  get total(): number {
    let n = 0;
    for (let i = 1; i < this.counts.length; i++) n += this.counts[i] ?? 0;
    return n;
  }

  /** Non-zero reasons only, keyed by name. Empty when nothing has been refused. */
  report(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 1; i < this.counts.length; i++) {
      const n = this.counts[i] ?? 0;
      if (n > 0) out[REJECT_NAMES[i] ?? String(i)] = n;
    }
    return out;
  }

  reset(): void {
    this.counts.fill(0);
  }
}
