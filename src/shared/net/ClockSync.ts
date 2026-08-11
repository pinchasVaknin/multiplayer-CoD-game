import { nowMs } from '../core/Clock';
import { DT } from '../core/Loop';

/**
 * Which tick the client should be simulating (M10, S4.11).
 *
 * ## The rule this file exists to enforce
 *
 * S4.11: *"The server tick is the clock. Clients derive their tick number from a synced
 * server clock and **never** increment it locally."*
 *
 * The reason is S4.1's discard rule. A client that counted its own ticks would, on any frame
 * long enough to owe more than five steps, throw the backlog away — and its tick number would
 * fall permanently behind the server's, with nothing reporting it. Every command it sent from
 * then on would be stamped for a tick the server had already simulated. Deriving the number
 * from a clock instead means a stalled frame costs a hitch and nothing more: the tick number
 * catches up by itself because it was never being counted in the first place.
 *
 * ## Running ahead
 *
 * S4.11 again: *"Clients run ahead of the server by `RTT/2 + jitter buffer` so a command
 * sampled for tick N arrives before the server simulates tick N. Measure and adapt this
 * offset per client; do not hardcode it."*
 *
 * So the target tick is
 *
 * ```
 *   serverTickNow + ceil((RTT/2 + jitterMargin) / tickMs)
 * ```
 *
 * A command that arrives *early* is free — it waits in the input buffer. A command that
 * arrives *late* is not: the server repeats the previous one and the player's input is
 * silently a tick stale. So the lead is deliberately biased to be generous, and the margin is
 * derived from measured jitter rather than guessed.
 *
 * ## Why the offset is a minimum, not an average
 *
 * The clock offset estimate uses the sample with the **lowest RTT** in the recent window
 * rather than the mean. On a jittery link, a delayed packet inflates the apparent offset in
 * one direction only — delay is always positive — so averaging biases the estimate by roughly
 * half the mean delay and the bias grows with jitter. The fastest round trip observed is the
 * one least contaminated by queueing, which is the standard NTP insight and it matters here
 * for the same reason.
 */

/** Round-trip samples kept for the offset and jitter estimates. ~4 s at 4 Hz. */
const WINDOW = 16;

/**
 * Extra lead beyond `RTT/2`, as a multiple of measured jitter.
 *
 * Two standard deviations' worth, near enough. One is not enough — a third of commands would
 * arrive late — and three costs input latency for a case that is already covered by the
 * server repeating the last command.
 */
const JITTER_MARGIN_SCALE = 2;

/** Floor on the jitter buffer, ms. Even a perfect link needs a tick of slack. */
const MIN_MARGIN_MS = 1000 / 60;

/** Ceiling, so a pathological link cannot push the client absurdly far ahead. */
const MAX_MARGIN_MS = 150;

/**
 * Milliseconds of extra lead earned per late command the server reports.
 *
 * Roughly a third of a tick each. A single late command is noise and barely moves the buffer;
 * a run of them — which is what an actually-too-tight buffer produces — adds up to a tick or
 * two within a second and stops the bleeding.
 */
const STARVATION_GAIN_MS = 6;

/**
 * How fast the earned lead is given back, ms per snapshot.
 *
 * 0.15 ms at 20 Hz is 3 ms/s, so a tick of earned buffer takes about five seconds to hand
 * back. Deliberately far slower than it is earned: being slightly too far ahead costs a few
 * milliseconds of input latency nobody can feel, and being slightly too far behind costs a
 * visible correction. The asymmetry is the whole point.
 */
const STARVATION_DECAY_MS = 0.15;

export class ClockSync {
  /** Smoothed round-trip time, ms. */
  rttMs = 0;
  /** Mean absolute deviation of the RTT samples, ms. The jitter the margin is sized from. */
  jitterMs = 0;
  /** Estimated `serverMs - clientMs`. Add to a local reading to get server time. */
  offsetMs = 0;

  /**
   * Extra lead earned because the server reported late commands (S4.11).
   *
   * S4.11 requires the offset to be *measured and adapted per client*, and jitter alone is
   * not a sufficient measurement: it describes the *round trip*, while what actually matters
   * is whether commands arrive before the tick that needs them. Those differ whenever the
   * client's own frame pacing is the late party rather than the network — a stutter, a long
   * garbage collection, a background tab.
   *
   * Only the server can observe it, so it reports it (`SnapshotHeader.starvation`) and this
   * converts it into lead. Earned quickly and given back slowly, because the cost of being
   * slightly too far ahead is a few milliseconds of input latency, and the cost of being
   * slightly too far behind is a visible correction.
   */
  adaptiveMs = 0;

  /** True once at least one round trip has completed. */
  synced = false;

  private readonly rtts = new Float64Array(WINDOW);
  private readonly offsets = new Float64Array(WINDOW);

  /**
   * Whether `offsetMs` is still the handshake's provisional guess rather than a measurement.
   *
   * Cleared by the first real round-trip sample, which replaces the guess outright. See `seed`.
   */
  private seeded = false;
  private count = 0;
  private head = 0;

  /** Server tick reported in the most recent pong, and the server time it came with. */
  private lastServerTick = 0;
  private lastServerMs = 0;

  /**
   * Fold in one completed round trip.
   *
   * `sentAtMs` and `receivedAtMs` are local clock readings; `serverMs` and `serverTick` are
   * what the server reported. The offset estimate assumes the two hops are symmetric, which
   * is wrong in detail and right enough in practice — an asymmetric route biases the estimate
   * by half the difference, and nothing here needs better than that.
   */
  /**
   * A provisional offset from the handshake, **not** a round-trip sample (M11 playtest).
   *
   * The `Welcome` carries a server timestamp but no round trip: the client knows when the frame
   * arrived and nothing about how long it was in flight. Seeding the estimator with it as a
   * sample means claiming `rtt = 0`, and that claim is poisonous here in a way it would not be
   * in a mean-based estimator — `recompute` picks the offset belonging to the **lowest-RTT**
   * sample in the window, and a zero always wins. One fabricated sample therefore owned the
   * offset for the whole sixteen-sample window, about four seconds at 4 Hz.
   *
   * The consequence is exactly what the playtest reported. The seeded offset is half a real
   * round trip *too low*, so `targetTick` runs the client behind where it should be, its
   * commands arrive for ticks the server has already simulated, the input buffer starves and
   * repeats, and prediction and simulation pull apart on every tick — heavy rubberbanding at
   * spawn that eases as real samples finally displace it.
   *
   * So the seed sets the offset directly and stays out of the window. The first real ping
   * replaces it outright rather than easing toward it (see `recompute`), because a provisional
   * value is not evidence to be averaged with.
   */
  seed(serverMs: number, serverTick: number, receivedAtMs: number): void {
    this.lastServerTick = serverTick;
    this.lastServerMs = serverMs;
    // No RTT term: the honest reading of a one-way timestamp is that the offset is unknown by
    // up to half a round trip, and the first ping will say by how much.
    this.offsetMs = serverMs - receivedAtMs;
    this.seeded = true;
    this.synced = true;
  }

  sample(sentAtMs: number, receivedAtMs: number, serverMs: number, serverTick: number): void {
    const rtt = receivedAtMs - sentAtMs;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) return;

    // Server time at the midpoint of the round trip, minus local time at the same moment.
    const offset = serverMs + rtt * 0.5 - receivedAtMs;

    this.rtts[this.head] = rtt;
    this.offsets[this.head] = offset;
    this.head = (this.head + 1) % WINDOW;
    if (this.count < WINDOW) this.count++;

    this.lastServerTick = serverTick;
    this.lastServerMs = serverMs;
    this.recompute();
    this.synced = true;
  }

  /**
   * The tick the client should sample its next command for.
   *
   * Derived, never incremented. Two clients with different pings sitting side by side will
   * be simulating different tick numbers at the same instant, and that is correct: they are
   * each far enough ahead that their commands land on time.
   */
  targetTick(): number {
    if (!this.synced) return 0;
    const serverNow = nowMs() + this.offsetMs;
    const elapsedMs = serverNow - this.lastServerMs;
    const serverTickNow = this.lastServerTick + elapsedMs / (DT * 1000);
    return Math.ceil(serverTickNow + this.leadTicks());
  }

  /** How far ahead of the server this client is running, in ticks. */
  leadTicks(): number {
    return Math.ceil(this.leadMs() / (DT * 1000));
  }

  /** How far ahead of the server this client is running, in ms. */
  leadMs(): number {
    return this.rttMs * 0.5 + this.marginMs();
  }

  /** The jitter buffer: how much slack beyond RTT/2 the lead carries. */
  marginMs(): number {
    const m = this.jitterMs * JITTER_MARGIN_SCALE + this.adaptiveMs;
    if (m < MIN_MARGIN_MS) return MIN_MARGIN_MS;
    if (m > MAX_MARGIN_MS) return MAX_MARGIN_MS;
    return m;
  }

  /**
   * Fold in the server's report of how often this client's commands arrived too late.
   *
   * Called once per snapshot. Non-zero starvation widens the buffer; zero lets it narrow
   * again, so a client that hits one bad second does not carry the extra input latency for
   * the rest of the match.
   */
  noteStarvation(count: number): void {
    if (count > 0) {
      this.adaptiveMs += count * STARVATION_GAIN_MS;
      if (this.adaptiveMs > MAX_MARGIN_MS) this.adaptiveMs = MAX_MARGIN_MS;
      return;
    }
    this.adaptiveMs -= STARVATION_DECAY_MS;
    if (this.adaptiveMs < 0) this.adaptiveMs = 0;
  }

  /** The server's current tick, as best this client can tell. For the debug panel. */
  estimatedServerTick(): number {
    return Math.round(this.serverTickFractional());
  }

  /**
   * The server's current tick, unrounded.
   *
   * Interpolation needs the fraction. Rounding to a whole tick would quantise the render
   * timeline to 16.7 ms steps, which at 60 fps means remote players advance on some frames
   * and not others — a visible stutter that looks exactly like the packet loss this system
   * exists to hide.
   */
  serverTickFractional(): number {
    if (!this.synced) return 0;
    const serverNow = nowMs() + this.offsetMs;
    return this.lastServerTick + (serverNow - this.lastServerMs) / (DT * 1000);
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.synced = false;
    this.rttMs = 0;
    this.jitterMs = 0;
    this.offsetMs = 0;
    this.seeded = false;
    this.adaptiveMs = 0;
  }

  private recompute(): void {
    const n = this.count;
    if (n === 0) return;

    let best = Infinity;
    let bestOffset = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const rtt = this.rtts[i] ?? 0;
      sum += rtt;
      if (rtt < best) {
        best = rtt;
        bestOffset = this.offsets[i] ?? 0;
      }
    }
    const mean = sum / n;

    let deviation = 0;
    for (let i = 0; i < n; i++) deviation += Math.abs((this.rtts[i] ?? 0) - mean);
    deviation /= n;

    this.rttMs = mean;
    this.jitterMs = deviation;

    // The offset from the *fastest* round trip in the window. See the file header: delay is
    // one-sided, so the least-delayed sample is the least-biased one.
    //
    // Moved toward rather than snapped to, so a single unusually fast sample does not jerk
    // the whole client's tick number and produce a command gap the server has to fill.
    if (this.offsetMs === 0 || this.seeded) {
      // Nothing to ease away from: either this is the first sample, or the current value is the
      // handshake's provisional guess, which is not a measurement and must not be averaged with
      // one. See `seed`.
      this.seeded = false;
      this.offsetMs = bestOffset;
    } else {
      this.offsetMs += (bestOffset - this.offsetMs) * 0.25;
    }
  }
}
