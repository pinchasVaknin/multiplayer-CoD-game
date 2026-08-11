import { logger } from '../../shared/core/Log';
import type { MatchFlow } from '../../shared/modes/MatchFlow';
import { phaseAt, type SnapshotHeader } from '../../shared/net/Messages';

const log = logger('divergence');

/**
 * Does this client's mode state agree with the server's? (M11, §7, §8.21)
 *
 * §7: *"State-divergence checker: hash authoritative mode state on the instance and on each
 * client, logging any mismatch with the tick it appeared on."* §8.21 makes it a gate — *"any
 * mismatch is this milestone's blocking bug — report it, do not explain it away."*
 *
 * ## It compares two *independent* paths, which is the only version of this worth building
 *
 * The obvious implementation compares the client's `MatchFlow` against the snapshot header —
 * and it is worthless, because `MatchFlow` is *assigned from* that header by
 * `NetSession.applyReplicated`. It would agree by construction and could never fail, which is
 * exactly the false green standing lesson 4 warns about: *"always stub the mechanism and watch
 * the probe go red before believing it green."*
 *
 * So the comparison is between the two ways this client knows the score:
 *
 * - **From replicated events.** Kills arrive as `damage.dealt` with a lethal flag, go through
 *   the same `ScoreSystem` a local match uses, and the mode derives a team score from the rows.
 *   Nothing about that path reads the header.
 * - **From the snapshot header.** The server's own `mode.teamScore`, stated outright.
 *
 * They are computed by different code from different inputs and must land on the same number.
 * A dropped kill event, one counted twice, a tag credited to the wrong side in Kill Confirmed,
 * a Domination tick the client applied and the server did not — every one of those separates
 * these two figures and nothing else in the client would notice.
 *
 * The round and phase are also checked, and those *are* header-fed. They are included because
 * they cost nothing and because a future change that gives the client its own opinion about
 * either would find this already watching. They are marked as such below.
 *
 * ## Latency is not divergence
 *
 * Handover standing lesson 3: *"A client's copy is one snapshot stale, always. Any comparator
 * checking live server state against client state must tolerate latency on continuously-varying
 * values and confirm-before-reporting on discrete ones. Exact equality is a broken test, not a
 * found bug."*
 *
 * That shapes both halves of this:
 *
 * - `timeLeft` is **continuously varying** and is compared with a tolerance, because the client
 *   is always some fraction of a second behind and always will be.
 * - Scores, phase and round are **discrete**, and a mismatch on them is confirmed across
 *   several consecutive samples before it is reported. A single disagreeing sample is an
 *   in-flight update, not a divergence; the same disagreement surviving four snapshots is.
 *
 * Without the confirm step this reports a mismatch on essentially every kill, which is the
 * flaky-probe failure standing lesson 6 warns about — a check that cries wolf teaches its
 * reader to ignore it, and then it is worse than not existing.
 */

export interface DivergenceRecord {
  readonly tick: number;
  readonly field: string;
  readonly client: number | string;
  readonly server: number | string;
}

/** Consecutive disagreeing samples before a discrete mismatch is believed. See the header. */
const CONFIRM_SAMPLES = 4;

/** Seconds of clock skew tolerated. One snapshot interval at 20 Hz plus a jitter buffer. */
const CLOCK_TOLERANCE_S = 1.5;

export class DivergenceChecker {
  /** Every confirmed mismatch, in order. Empty is the passing result. */
  readonly records: DivergenceRecord[] = [];

  /** Samples taken. The denominator for "zero mismatches across a full match". */
  samples = 0;

  private readonly pending = new Map<string, { count: number; client: number | string; server: number | string }>();

  /**
   * Compare one snapshot header against the client's own flow.
   *
   * Called once per applied snapshot, not per frame: comparing more often than the state can
   * change is samples that cannot fail, and a denominator inflated by them makes a mismatch
   * rate look better than it is.
   */
  check(header: SnapshotHeader, flow: MatchFlow, scoreA: number, scoreB: number): void {
    this.samples++;

    // The two independent paths. See the class comment — this is the pair that can fail.
    this.compare(header.serverTick, 'scoreA', scoreA, header.scoreA);
    this.compare(header.serverTick, 'scoreB', scoreB, header.scoreB);

    // Header-fed today, so these agree by construction. Watched anyway: they cost one
    // comparison each, and the day something gives the client its own opinion about the round
    // number is the day this starts earning its place.
    this.compare(header.serverTick, 'phase', flow.currentPhase, phaseAt(header.phase));
    this.compare(header.serverTick, 'round', flow.round, header.round);

    // Continuously varying: tolerated rather than confirmed. A client that is a snapshot
    // behind is correct, not divergent.
    const drift = Math.abs(flow.secondsRemaining - header.timeLeft);
    if (drift > CLOCK_TOLERANCE_S) {
      this.compare(header.serverTick, 'timeLeft', Math.round(flow.secondsRemaining), header.timeLeft);
    } else {
      this.pending.delete('timeLeft');
    }
  }

  private compare(tick: number, field: string, client: number | string, server: number | string): void {
    if (client === server) {
      // Agreement clears the streak. A mismatch has to be *consecutive* to be believed —
      // otherwise an in-flight score update counts toward a divergence that never existed.
      this.pending.delete(field);
      return;
    }

    const seen = this.pending.get(field);
    const count = (seen?.count ?? 0) + 1;
    this.pending.set(field, { count, client, server });
    if (count < CONFIRM_SAMPLES) return;

    this.pending.delete(field);
    const record: DivergenceRecord = { tick, field, client, server };
    this.records.push(record);
    log.error(
      `DIVERGENCE on tick ${tick}: ${field} — client says ${client}, server says ${server}. ` +
        `Confirmed across ${CONFIRM_SAMPLES} consecutive snapshots.`,
    );
  }

  /** The one-line verdict the panel shows and the report quotes. */
  summary(): string {
    if (this.samples === 0) return 'no samples';
    if (this.records.length === 0) return `${this.samples} samples, 0 mismatches`;
    const first = this.records[0];
    return `${this.records.length} mismatch(es) in ${this.samples} — first: ${first?.field} @ ${first?.tick}`;
  }

  reset(): void {
    this.records.length = 0;
    this.pending.clear();
    this.samples = 0;
  }
}
