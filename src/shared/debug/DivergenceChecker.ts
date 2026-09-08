import { logger } from '../core/Log';
import type { MatchFlow } from '../modes/MatchFlow';
import { phaseAt, type SnapshotHeader } from '../net/Messages';

const log = logger('divergence');

/**
 * Does this client's mode state agree with the server's? (M11, S7, S8.21)
 *
 * S7: *"State-divergence checker: hash authoritative mode state on the instance and on each
 * client, logging any mismatch with the tick it appeared on."* S8.21 makes it a gate — *"any
 * mismatch is this milestone's blocking bug — report it, do not explain it away."*
 *
 * ## What this used to claim, and why it was wrong (playtest round 5, B7)
 *
 * It used to compare the score two ways and call them independent:
 *
 * - **From replicated events.** Kills arrive as `damage.dealt`, go through the same
 *   `ScoreSystem` a local match uses, and the mode derives a team score from the rows.
 * - **From the snapshot header.** The server's own `mode.teamScore`, stated outright.
 *
 * The first of those does not exist. `MatchFlow` sets a replicated client up with
 * `authoritative: false`, and its kill handler says so outright — *"The mode must not run here
 * ... the server has already scored this kill and replicated the total"*. So `mode.teamScore`
 * on a dedicated server is not an independent tally. For Team Deathmatch, Domination, Kill
 * Confirmed and Search & Destroy it is a **structural constant zero**: all four read a team
 * total that only `GameMode.addTeamScore` writes, and the mode never runs. The comparison was
 * therefore zero against the server's score, and it fired — correctly, by its own rules — in
 * every networked match of those four modes as soon as a score survived four snapshots. That
 * is B7, verbatim, off the deployed build:
 *
 *     DIVERGENCE on tick 67010: scoreA — client says 0, server says 69.
 *
 * Free-for-All was the exception, and it is why this looked plausible for a milestone: its
 * `teamScore` is the highest kill count among its own rows, which the replicated path *does*
 * maintain. Even there it was only ever right for a client present since the first kill — one
 * that joined or rejoined mid-match starts its tally at zero and never catches up.
 *
 * **A client on a dedicated server cannot audit the server's arithmetic.** It holds strictly
 * less than the server held when it computed the number, and no amount of comparing gets that
 * back. Pretending otherwise produced an error line per snapshot for a whole milestone.
 *
 * ## So what it checks now, and which half can fail
 *
 * **The state hash, and this is the one with teeth.** The instance hashes its authoritative
 * mode state and sends it last, after every channel describing that tick; the client hashes
 * what it ended up holding, and the two are compared. That catches the whole class of fault
 * living between those two points — a channel that stopped, a field truncated by an encoder
 * change on one side, a list capped differently, a frame applied to the wrong mode after a
 * migration. `ModeStateHash` has the full list and, more importantly, what it does not catch.
 *
 * **The flow against the header, and this half is a guard rather than an audit.** Phase,
 * round, the clock and the score are all *assigned* to the client's inert `MatchFlow` from the
 * header by `NetSession`, so they agree by construction, and they are named here as such. They
 * are still compared because it costs four comparisons and because "something wrote to the
 * flow behind the header's back" is a fault this project has actually had: round 2's phase
 * leak was exactly that — a client sitting in `MATCH_END` with a stale banner while the server
 * had moved on. What it is not, and what the previous version of this comment claimed it was,
 * is a second opinion about the score.
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
 * - The hash, the scores, the phase and the round are **discrete**, and a mismatch on them is
 *   confirmed across several consecutive samples before it is reported. A single disagreeing
 *   sample is an in-flight update, not a divergence; the same disagreement surviving four
 *   snapshots is.
 *
 * Without the confirm step this reports a mismatch on essentially every kill, which is the
 * flaky-probe failure standing lesson 6 warns about — a check that cries wolf teaches its
 * reader to ignore it, and then it is worse than not existing.
 *
 * ## Shared, so the browser and the harness run the same checker (M11 Gate B)
 *
 * It moved out of `client/debug` for S8.21, which asks for zero mismatches *across a full match
 * in each of the five modes* — five matches nobody is going to sit through by hand. Nothing in
 * here was ever client-only: it reads a snapshot header and a `MatchFlow`, both shared. Two
 * copies of a comparator is two comparators that can disagree about what agreement means.
 *
 * That argument had a hole in it until round 5, and the hole is why B7 survived a milestone of
 * green harness runs: this class had exactly **one** caller, `MatchWorld`, in the browser.
 * `HeadlessClient` never used it — it compares state hashes directly, with a streak counter of
 * its own — so the comparator the gate exercised and the comparator the player ran were not the
 * same code. The browser runs the hash check too now, through `checkHash` below.
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

  /** Header samples taken. The denominator for "zero mismatches across a full match". */
  samples = 0;

  /** Hash samples taken. Zero means this client is not running the hash check at all. */
  hashSamples = 0;

  private readonly pending = new Map<string, { count: number; client: number | string; server: number | string }>();

  /**
   * Compare one snapshot header against the client's own flow.
   *
   * Called once per applied snapshot, not per frame: comparing more often than the state can
   * change is samples that cannot fail, and a denominator inflated by them makes a mismatch
   * rate look better than it is.
   */
  check(header: SnapshotHeader, flow: MatchFlow): void {
    this.samples++;

    /*
     * All four are header-fed, and saying so is the point (round 5, B7).
     *
     * `NetSession` assigns every one of these to the client's inert `MatchFlow` from the same
     * header this is handed, so they agree by construction. They are a guard against a second
     * writer, not a second opinion: what fails here is something having written to the flow
     * behind the header's back. The comparison that can find the server wrong is `checkHash`.
     *
     * `flow.teamScore` rather than `mode.teamScore`, and that swap is the whole of B7 — see
     * the class comment above.
     */
    this.compare(header.serverTick, 'scoreA', flow.teamScore('A'), header.scoreA);
    this.compare(header.serverTick, 'scoreB', flow.teamScore('B'), header.scoreB);
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

  /**
   * The state hash the instance sent for this tick, against the client's own (S7, S8.21).
   *
   * The half of this class that can find the server and the client genuinely disagreeing, and
   * until round 5 the browser did not run it at all: `HeadlessClient` had a copy of it and
   * `MatchWorld` had nothing, so the gate and the player were exercising different code. Same
   * confirm discipline as everything else here, and it depends on the same ordering guarantee —
   * the instance sends this **last** in its tick, after every channel describing that tick, so
   * one disagreement is a frame in flight and four in a row is a divergence.
   *
   * Counted in `hashSamples` rather than `samples`: the two arrive on different channels, and a
   * denominator that mixes them cannot answer either question.
   */
  checkHash(tick: number, client: number, server: number): void {
    this.hashSamples++;
    this.compare(tick, 'modeStateHash', client, server);
  }

  /** The one-line verdict the panel shows and the report quotes. */
  summary(): string {
    if (this.samples === 0 && this.hashSamples === 0) return 'no samples';
    const taken = `${this.samples} header, ${this.hashSamples} hash`;
    if (this.records.length === 0) return `${taken}, 0 mismatches`;
    const first = this.records[0];
    return `${this.records.length} mismatch(es) in ${taken} — first: ${first?.field} @ ${first?.tick}`;
  }

  reset(): void {
    this.records.length = 0;
    this.pending.clear();
    this.samples = 0;
    this.hashSamples = 0;
  }
}
