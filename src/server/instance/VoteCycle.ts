import { DT } from '../../shared/core/Loop';
import { logger } from '../../shared/core/Log';
import { Rng } from '../../shared/core/Rng';
import {
  MAP_BALLOT,
  MODE_BALLOT,
  VOTE_CYCLE_CONFIG,
  VotePhase,
  votePhaseName,
  type VoteCycleConfig,
  type VotePhaseId,
} from '../../shared/net/Skirmish';
import { metric } from '../log';

const log = logger('vote');

/**
 * The 60 s cycle, and the server owns every part of it (M11, §4.20, §6.4).
 *
 * ```
 *   0-40s   free warmup play, a countdown visible but unobtrusive
 *  40-50s   mode vote — five modes, live tally
 *     50s   winning mode resolved and announced
 *  50-60s   map vote — three maps, opening below the announced mode
 *     60s   winning map resolved; allocation begins
 * ```
 *
 * ## Everything here is a tick, not a timestamp
 *
 * §4.20: *"The client renders a countdown derived from the synced server clock and **never**
 * runs its own timer. Two clients must never see different numbers."* So a phase boundary is
 * an absolute tick, the broadcast carries that tick, and the client subtracts. Nothing on
 * either side counts milliseconds toward a deadline, which is what makes a client connecting
 * at second 47 see three seconds of mode voting rather than a fresh ten (§8.5) — it does not
 * *start* anything, it reads a number that was already true.
 *
 * ## The tally is computed only here
 *
 * §4.20: *"The tally is computed **only** on the server; the client displays a broadcast tally
 * and never counts votes itself."* `votes` below is the only tally in the codebase. A client
 * that sent a hundred votes moves one entry in one map, because the map is keyed by player id
 * — which is why one-vote-per-player is a property of the data structure rather than a check
 * somebody has to remember to write.
 */

export type VoteResolution = {
  readonly modeId: string;
  readonly mapId: string;
};

export interface VoteCycleDeps {
  /** Humans currently in the arena. Zero cancels the cycle (§4.20). */
  readonly humanCount: () => number;
  /** The map vote has resolved; go and allocate. Called exactly once per cycle. */
  readonly onResolved: (resolution: VoteResolution) => void;
  /** Seed for the tie-break RNG. Logged with every random pick so it is reconstructible. */
  readonly seed: number;
  readonly config?: VoteCycleConfig;
  /**
   * The cycle gave up before it could hand anything to the allocator.
   *
   * Unreachable today — both ballots are validated against the registry at module load — and
   * wired anyway, because the alternative is a cycle that silently returns to free play and a
   * player with no idea why the map they voted for never opened. §4.17's rule that every player
   * is left *with a message* applies to every abort, not only to the allocator's.
   */
  readonly onAborted?: (reason: string) => void;
}

export class VoteCycle {
  private readonly config: VoteCycleConfig;
  private readonly deps: VoteCycleDeps;

  private phase_: VotePhaseId = VotePhase.IDLE;
  private phaseEndsTick = 0;

  /** playerId -> option index, for the phase currently open. Cleared between phases. */
  private readonly votes = new Map<number, number>();

  private decidedMode = -1;
  private decidedMap = -1;

  /**
   * The tie-break stream (§4.20).
   *
   * Seeded once and advanced per pick rather than reseeded per pick, so the sequence of
   * outcomes across a session is reproducible from one number. Every draw logs the seed, the
   * draw index and the resulting choice — §4.20: *"so a disputed outcome can be reconstructed
   * rather than argued about."*
   */
  private readonly rng: Rng;
  private draws = 0;

  /** Cycles completed since boot. Also the vote panel's "which cycle am I watching". */
  private cycleIndex = 0;

  constructor(deps: VoteCycleDeps) {
    this.deps = deps;
    this.config = deps.config ?? VOTE_CYCLE_CONFIG;
    this.rng = new Rng(deps.seed);
  }

  get phase(): VotePhaseId {
    return this.phase_;
  }

  get endsTick(): number {
    return this.phaseEndsTick;
  }

  get decided(): { mode: number; map: number } {
    return { mode: this.decidedMode, map: this.decidedMap };
  }

  get cycle(): number {
    return this.cycleIndex;
  }

  /** The live tally for the open phase, as counts per ballot index. */
  tally(): number[] {
    const size = this.phase_ === VotePhase.MAP_VOTE ? MAP_BALLOT.length : MODE_BALLOT.length;
    const counts = new Array<number>(size).fill(0);
    for (const option of this.votes.values()) {
      const current = counts[option];
      if (current !== undefined) counts[option] = current + 1;
    }
    return counts;
  }

  voteOf(playerId: number): number {
    return this.votes.get(playerId) ?? -1;
  }

  /**
   * Record a vote, or refuse it.
   *
   * Refusals are silent to the client beyond the tally not moving, and deliberately: a vote
   * arriving one tick after the window closed is ordinary on a real link and is not worth a
   * message, let alone a disconnect. What it must never do is *count*.
   *
   * Returns whether it was accepted, so the caller can log a rejection for §8.6 — *"a vote
   * sent outside its window is rejected"* has to be demonstrable, and an unlogged silent drop
   * is not.
   */
  castVote(playerId: number, phase: number, option: number): boolean {
    if (phase !== this.phase_) return false;
    if (this.phase_ !== VotePhase.MODE_VOTE && this.phase_ !== VotePhase.MAP_VOTE) return false;
    const ballotSize = this.phase_ === VotePhase.MODE_VOTE ? MODE_BALLOT.length : MAP_BALLOT.length;
    if (!Number.isInteger(option) || option < 0 || option >= ballotSize) return false;
    // Changeable inside the window (§4.20), which `set` gives for free.
    this.votes.set(playerId, option);
    return true;
  }

  /** Forget a player's vote when they leave, so a departed client cannot swing a tally. */
  forget(playerId: number): void {
    this.votes.delete(playerId);
  }

  /**
   * Advance the cycle. Called once per master tick from the arena's step.
   *
   * Structured as "has the deadline passed" rather than "count down a timer", because the
   * deadline is the thing clients are shown and a counter would be a second source of truth
   * for the same instant.
   */
  step(absoluteTick: number): void {
    const humans = this.deps.humanCount();

    if (this.phase_ === VotePhase.IDLE) {
      // The arena is never idle *and* occupied: the first human to arrive starts a cycle.
      if (humans > 0) this.beginPlay(absoluteTick);
      return;
    }

    /**
     * Everybody left (§4.20).
     *
     * *"If every human leaves during a vote phase, the cycle cancels and the arena returns to
     * idle warmup. It does not allocate a match for zero humans."* Checked in every phase and
     * not only during the ballot, because a cycle that reached allocation with nobody in it
     * would build a full match, spawn ten bots and migrate no one — an instance that exists
     * for nobody, holding the one live-match slot against the next player who connects.
     */
    if (humans === 0) {
      log.info(`cycle ${this.cycleIndex} cancelled in ${votePhaseName(this.phase_)}: no humans left.`);
      this.toIdle();
      return;
    }

    if (absoluteTick < this.phaseEndsTick) return;

    switch (this.phase_) {
      case VotePhase.PLAY:
        this.openModeVote(absoluteTick);
        return;
      case VotePhase.MODE_VOTE:
        this.closeModeVote(absoluteTick);
        return;
      case VotePhase.MAP_VOTE:
        this.closeMapVote();
        return;
      case VotePhase.ALLOCATING:
        // Held here by the flow until allocation resolves one way or the other. `resume` and
        // `abandon` are the two ways out; there is no deadline, because the allocator's
        // latency is not this class's to guess at.
        return;
      default:
        return;
    }
  }

  /** Allocation finished (either way). Start the next cycle's free play. */
  resume(absoluteTick: number): void {
    this.beginPlay(absoluteTick);
  }

  /** The arena emptied, or the flow gave up. Back to idle without allocating. */
  toIdle(): void {
    this.phase_ = VotePhase.IDLE;
    this.phaseEndsTick = 0;
    this.votes.clear();
    this.decidedMode = -1;
    this.decidedMap = -1;
  }

  private beginPlay(absoluteTick: number): void {
    this.cycleIndex++;
    this.phase_ = VotePhase.PLAY;
    this.phaseEndsTick = absoluteTick + secondsToTicks(this.config.playSeconds);
    this.votes.clear();
    this.decidedMode = -1;
    this.decidedMap = -1;
    log.info(
      `cycle ${this.cycleIndex}: free play for ${this.config.playSeconds}s ` +
        `(ends on tick ${this.phaseEndsTick}).`,
    );
  }

  private openModeVote(absoluteTick: number): void {
    this.phase_ = VotePhase.MODE_VOTE;
    this.phaseEndsTick = absoluteTick + secondsToTicks(this.config.modeVoteSeconds);
    this.votes.clear();
    log.info(`cycle ${this.cycleIndex}: mode vote open for ${this.config.modeVoteSeconds}s.`);
  }

  private closeModeVote(absoluteTick: number): void {
    this.decidedMode = this.resolve(this.tally(), 'mode');
    /**
     * The mode result stays on screen through the map vote (§6.4).
     *
     * *"Players choose a map knowing the mode, which is the entire reason for sequencing them
     * rather than showing both at once."* `decidedMode` is deliberately not cleared by
     * `openMapVote` — only the per-player votes are.
     */
    this.phase_ = VotePhase.MAP_VOTE;
    this.phaseEndsTick = absoluteTick + secondsToTicks(this.config.mapVoteSeconds);
    this.votes.clear();
    log.info(
      `cycle ${this.cycleIndex}: mode is ${MODE_BALLOT[this.decidedMode] ?? '?'}; ` +
        `map vote open for ${this.config.mapVoteSeconds}s.`,
    );
  }

  private closeMapVote(): void {
    this.decidedMap = this.resolve(this.tally(), 'map');
    this.phase_ = VotePhase.ALLOCATING;

    const modeId = MODE_BALLOT[this.decidedMode];
    const mapId = MAP_BALLOT[this.decidedMap];
    if (modeId === undefined || mapId === undefined) {
      // Unreachable: `resolve` always returns an index inside the ballot it was given, and
      // both ballots are validated against the registry at module load. Handled rather than
      // asserted because the consequence of being wrong is an allocation with `undefined` as
      // a map id, forty seconds into a cycle, in front of everybody.
      log.error(
        `cycle ${this.cycleIndex}: resolved to mode ${this.decidedMode} / map ${this.decidedMap}, ` +
          'which are not both on the ballot. Returning to free play.',
      );
      this.deps.onAborted?.('The vote could not be resolved — staying in the arena.');
      this.toIdle();
      return;
    }

    log.info(`cycle ${this.cycleIndex}: ${modeId} on ${mapId} — allocating.`);
    this.deps.onResolved({ modeId, mapId });
  }

  /**
   * Pick a winner: highest count, ties broken randomly, an empty ballot broken randomly.
   *
   * §4.20: *"**Tie**: random among the tied options. **No votes at all**: random among all
   * options."* Both go through the same draw, because "everybody tied on zero" is what an
   * empty ballot *is* — writing them as two cases would be two chances to get the seeding
   * wrong and one of them would be exercised far less often.
   *
   * Every random pick logs the seed, the draw index, the candidate set and the result, so a
   * disputed outcome is reconstructible: re-seed an `Rng` with the logged seed, advance it by
   * the logged draw index, and the same option comes out.
   */
  private resolve(counts: readonly number[], what: string): number {
    let best = -1;
    for (const count of counts) if (count > best) best = count;

    const tied: number[] = [];
    for (let i = 0; i < counts.length; i++) if (counts[i] === best) tied.push(i);

    const first = tied[0];
    if (first === undefined) return 0;
    if (tied.length === 1) {
      log.info(`${what} vote: option ${first} won outright with ${best}.`);
      return first;
    }

    const drawIndex = this.draws++;
    const pick = tied[this.rng.int(0, tied.length)] ?? first;
    const reason = best === 0 ? 'no votes cast' : `${tied.length}-way tie on ${best}`;
    log.info(
      `${what} vote: ${reason} — broke randomly to option ${pick}. ` +
        `seed=${this.deps.seed} draw=${drawIndex} candidates=[${tied.join(',')}]`,
    );
    // Structured as well as logged: §7 asks the vote panel to surface the seed and the pick,
    // and a panel that scraped a log line would break the first time the wording changed.
    metric('vote', 'randomPick', {
      cycle: this.cycleIndex,
      what,
      seed: this.deps.seed,
      draw: drawIndex,
      candidates: tied,
      pick,
      reason,
    });
    return pick;
  }
}

function secondsToTicks(seconds: number): number {
  return Math.round(seconds / DT);
}
