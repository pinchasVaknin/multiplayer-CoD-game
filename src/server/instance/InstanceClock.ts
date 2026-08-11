import { DT } from '../../shared/core/Loop';

/**
 * One instance's view of the master clock (M11, §4.19).
 *
 * There is exactly one drift-corrected loop in this process (§4.19: *"One loop, not N"*), so
 * an instance does not own a timer. What it owns is two things the master cannot know for it:
 * how many ticks *it* has been stepped, and which of those ticks it serialises a snapshot on.
 *
 * ## Why the two tick numbers are both needed
 *
 * The **absolute** tick is the master's, and it is what every cross-instance and cross-runtime
 * index is stamped with: `Rewind`'s rig history, command validation's skew window, the vote
 * cycle's phase boundaries, the named migration tick. A client's clock is synced to it.
 *
 * The **local** tick counts steps this instance has taken. A `LiveMatch` created at absolute
 * tick 41,000 has taken zero steps, and anything that means *"how far into this match are
 * we"* — mode clocks, round timers, the match's own seeding — has to read the local one. M10
 * could not tell them apart because its single match was created at tick 0 and stepped every
 * tick after, so the two were equal forever. They are permanently unequal here.
 *
 * ## Snapshot phase
 *
 * §4.19: *"Stagger snapshot phase by instance, so instances do not all serialise and send on
 * the same tick."* Two instances both sending on every third tick with no offset put their
 * entire serialisation cost on the same 16 ms of event loop and leave the other two idle. The
 * offset spreads that, and it is derived from the instance id so it is stable for the life of
 * the instance rather than drifting with it.
 */
export class InstanceClock {
  /** Ticks stepped by this instance. Zero until the first `step`. */
  private local = -1;

  /** The master tick of the most recent step. */
  private absolute = 0;

  readonly snapshotEveryTicks: number;
  readonly phaseOffset: number;

  constructor(
    readonly startTick: number,
    snapshotHz: number,
    instanceIndex: number,
  ) {
    // 60 / 20 = every third tick. Integer by construction so the send cadence is even rather
    // than beating against the tick rate.
    this.snapshotEveryTicks = Math.max(1, Math.round(60 / snapshotHz));
    this.absolute = startTick;
    /**
     * Spread across the send interval, not across the whole second.
     *
     * With a 3-tick interval and two instances the offsets are 0 and 1, which is a full tick
     * of separation and the most the interval allows. Taking the index modulo the interval
     * rather than the instance count means adding a third instance degrades gracefully to a
     * collision rather than producing an offset larger than the period, which would alias back
     * to zero and silently undo the staggering.
     */
    this.phaseOffset = instanceIndex % this.snapshotEveryTicks;
  }

  /** Advance to a master tick. Called once per instance per master tick, by the loop. */
  advance(absoluteTick: number): void {
    this.absolute = absoluteTick;
    this.local++;
  }

  /** The master's tick. What `Rewind`, command validation and the client clock all use. */
  get absoluteTick(): number {
    return this.absolute;
  }

  /** Steps this instance has taken. What "how far into this match" means. */
  get localTick(): number {
    return this.local;
  }

  /** Simulated seconds this instance has been running. Ticks over 60, never wall clock. */
  get localSeconds(): number {
    return Math.max(0, this.local) * DT;
  }

  /**
   * Whether this instance serialises on the tick it was just advanced to.
   *
   * Phase-shifted per instance, per §4.19. Note that the shift is applied to the *absolute*
   * tick: two instances created at different times would otherwise share a phase whenever
   * their creation ticks happened to be congruent, which is one time in three.
   */
  shouldSnapshot(): boolean {
    return (this.absolute + this.phaseOffset) % this.snapshotEveryTicks === 0;
  }
}
