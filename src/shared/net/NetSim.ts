import { nowMs } from '../core/Clock';
import { Rng } from '../core/Rng';

/**
 * Artificial network conditions, applied to a byte stream (M10, S7).
 *
 * S7 puts this first for a reason, and HARD RULE 9 says why: *"A 1 ms local connection hides
 * every bug these milestones exist to prevent."* Prediction, reconciliation, interpolation
 * and lag compensation are all mechanisms for surviving a link that is late, jittery and
 * lossy. On a loopback none of them do anything, so none of them can be shown to work — and
 * worse, a bug in any of them is invisible until it reaches a real player.
 *
 * ## Where it sits
 *
 * Between the protocol and the socket, on **both** sides, per connection. Frames go in, and
 * come out later, sometimes in a different order, sometimes not at all. Nothing above it
 * knows it exists, which is the point: the code being tested is the code that ships.
 *
 * It **layers on top of the real link** rather than replacing it (S7: *"It must be able to
 * layer on top of the real RTT to the deployed server, so you can test a 200 ms player
 * without finding one."*). A 40 ms real RTT with a `+100ms` preset is a 140 ms player.
 *
 * ## The unit is added round-trip time
 *
 * `latencyMs` is what the preset names — `+100ms` means the round trip grows by 100 ms — so
 * each one-way hop is delayed by **half** of it. Getting this backwards is an easy way to
 * report numbers that are quietly double what they claim, so it is stated here and applied
 * in exactly one place.
 *
 * ## Reordering is mostly emergent
 *
 * With jitter on, two frames sent 5 ms apart can draw delays 20 ms apart, and the second
 * arrives first. That is how reordering happens on a real network and it falls out of the
 * jitter model for free. `reorderPct` exists on top of it to force the case deterministically
 * when a test needs it rather than waiting for jitter to produce it.
 */

export interface NetConditions {
  /** Added round-trip time in ms. Split evenly across the two hops. */
  readonly latencyMs: number;
  /** Plus or minus this much on each hop's delay, uniform. */
  readonly jitterMs: number;
  /** Percentage of frames dropped outright, 0..100. */
  readonly lossPct: number;
  /** Percentage of frames given an extra shuffle of delay, 0..100. */
  readonly reorderPct: number;
}

export const NET_PERFECT: NetConditions = {
  latencyMs: 0,
  jitterMs: 0,
  lossPct: 0,
  reorderPct: 0,
};

/**
 * The presets S7 requires by name, plus the perfect link.
 *
 * `bad` is S7's *"100ms +/-30ms jitter, 2% loss"* — the condition the acceptance criteria
 * measure misprediction distance and a full match under.
 */
export const NET_PRESETS: Readonly<Record<string, NetConditions>> = {
  off: NET_PERFECT,
  '50': { latencyMs: 50, jitterMs: 0, lossPct: 0, reorderPct: 0 },
  '100': { latencyMs: 100, jitterMs: 0, lossPct: 0, reorderPct: 0 },
  '150': { latencyMs: 150, jitterMs: 0, lossPct: 0, reorderPct: 0 },
  bad: { latencyMs: 100, jitterMs: 30, lossPct: 2, reorderPct: 0 },
};

export function presetNames(): string[] {
  return Object.keys(NET_PRESETS);
}

/** Look a preset up by name, or null. Used by the URL flag and the live toggle. */
export function findPreset(name: string): NetConditions | null {
  return NET_PRESETS[name.trim().toLowerCase()] ?? null;
}

interface Pending {
  /** Monotonic ms at which this frame becomes deliverable. */
  dueMs: number;
  /** Payload. Owned by this record and reused; `length` says how much of it is live. */
  bytes: Uint8Array;
  length: number;
  /** Send order, so equal due times deliver deterministically rather than by sort luck. */
  serial: number;
  active: boolean;
}

/** Frames in flight in one direction before the simulator starts dropping them. */
const MAX_IN_FLIGHT = 256;

/** Backing buffer per pending frame. Sized for the largest frame the protocol allows. */
const FRAME_CAPACITY = 8192;

export class NetSim {
  /**
   * Live conditions. Assignable so the debug panel can change them mid-match without
   * tearing the connection down — S7 asks for "toggleable live", and a toggle that
   * reconnects would reset every measurement it exists to take.
   */
  conditions: NetConditions;

  /** Frames dropped by the loss model since the last `resetStats()`. */
  dropped = 0;
  /** Frames delivered. */
  delivered = 0;
  /** Frames dropped because the in-flight pool was full. A real problem, not a simulated one. */
  overflowed = 0;

  private readonly pool: Pending[] = [];
  private readonly rng: Rng;
  private serial = 0;

  /**
   * Seeded, not `Math.random` (M1's ban, and it is not incidental here): a loss pattern that
   * differs between two runs makes two measurements incomparable, and the whole purpose of
   * this class is producing comparable measurements.
   */
  constructor(conditions: NetConditions = NET_PERFECT, seed = 0x6e_7517) {
    this.conditions = conditions;
    this.rng = new Rng(seed);
    for (let i = 0; i < MAX_IN_FLIGHT; i++) {
      this.pool.push({
        dueMs: 0,
        bytes: new Uint8Array(FRAME_CAPACITY),
        length: 0,
        serial: 0,
        active: false,
      });
    }
  }

  /** True when this simulator is a no-op and the caller may skip it entirely. */
  get idle(): boolean {
    const c = this.conditions;
    return c.latencyMs <= 0 && c.jitterMs <= 0 && c.lossPct <= 0 && c.reorderPct <= 0;
  }

  /** Frames currently held. */
  get inFlight(): number {
    let n = 0;
    for (const p of this.pool) if (p.active) n++;
    return n;
  }

  resetStats(): void {
    this.dropped = 0;
    this.delivered = 0;
    this.overflowed = 0;
  }

  /** Drop everything in flight. Called when a connection closes. */
  clear(): void {
    for (const p of this.pool) p.active = false;
  }

  /**
   * Offer a frame. Returns false if the loss model ate it.
   *
   * The bytes are **copied**: callers hand in a view over a reused encode buffer, which will
   * have been overwritten long before the delivery time comes round.
   */
  send(bytes: Uint8Array): boolean {
    const c = this.conditions;

    if (c.lossPct > 0 && this.rng.float() * 100 < c.lossPct) {
      this.dropped++;
      return false;
    }

    if (bytes.length > FRAME_CAPACITY) {
      // Larger than anything the protocol produces. Dropping is right and saying so is
      // better than silently truncating into a frame that decodes as nonsense.
      this.overflowed++;
      return false;
    }

    const slot = this.free();
    if (slot === null) {
      this.overflowed++;
      return false;
    }

    // One hop is half the round trip.
    let delay = c.latencyMs * 0.5;
    if (c.jitterMs > 0) delay += this.rng.spread() * c.jitterMs;
    if (c.reorderPct > 0 && this.rng.float() * 100 < c.reorderPct) {
      // Force this frame behind the next one or two.
      delay += this.rng.range(5, 40);
    }
    if (delay < 0) delay = 0;

    slot.bytes.set(bytes, 0);
    slot.length = bytes.length;
    slot.dueMs = nowMs() + delay;
    slot.serial = this.serial++;
    slot.active = true;
    return true;
  }

  /**
   * Deliver every frame whose time has come, oldest due first.
   *
   * Called once per frame on the client and once per tick on the server. The handler is
   * given a view valid only for the duration of the call — decode it, do not retain it.
   *
   * The scan is linear over a 256-slot pool. At 30 snapshots and 60 commands a second there
   * are single-digit frames in flight even at 150 ms, so a heap would be more code for no
   * measurable gain.
   */
  pump(deliver: (bytes: Uint8Array) => void): void {
    const now = nowMs();
    for (;;) {
      let best: Pending | null = null;
      for (const p of this.pool) {
        if (!p.active || p.dueMs > now) continue;
        if (best === null || p.dueMs < best.dueMs || (p.dueMs === best.dueMs && p.serial < best.serial)) {
          best = p;
        }
      }
      if (best === null) return;
      best.active = false;
      this.delivered++;
      deliver(best.bytes.subarray(0, best.length));
    }
  }

  private free(): Pending | null {
    for (const p of this.pool) if (!p.active) return p;
    return null;
  }
}

/**
 * Parse a conditions string from a URL flag or a console call.
 *
 * Accepts a preset name (`bad`, `100`) or an explicit `latency,jitter,loss` triple so a
 * condition the presets do not cover can still be reached without a rebuild. Returns null on
 * anything it does not understand, and the caller reports that rather than silently running
 * at zero — a test that quietly ran on a perfect link is worse than one that refused to start.
 */
export function parseConditions(spec: string): NetConditions | null {
  const s = spec.trim().toLowerCase();
  if (s === '' || s === '0' || s === 'off' || s === 'none') return NET_PERFECT;

  const preset = findPreset(s);
  if (preset !== null) return preset;

  const parts = s.split(',');
  const latency = Number(parts[0]);
  if (!Number.isFinite(latency) || latency < 0) return null;
  const jitter = parts.length > 1 ? Number(parts[1]) : 0;
  const loss = parts.length > 2 ? Number(parts[2]) : 0;
  if (!Number.isFinite(jitter) || jitter < 0) return null;
  if (!Number.isFinite(loss) || loss < 0 || loss > 100) return null;
  return { latencyMs: latency, jitterMs: jitter, lossPct: loss, reorderPct: 0 };
}

export function describeConditions(c: NetConditions): string {
  if (c.latencyMs <= 0 && c.jitterMs <= 0 && c.lossPct <= 0) return 'none';
  const bits = [`+${c.latencyMs.toFixed(0)}ms`];
  if (c.jitterMs > 0) bits.push(`+/-${c.jitterMs.toFixed(0)}ms jitter`);
  if (c.lossPct > 0) bits.push(`${c.lossPct.toFixed(1)}% loss`);
  if (c.reorderPct > 0) bits.push(`${c.reorderPct.toFixed(1)}% reorder`);
  return bits.join(', ');
}
