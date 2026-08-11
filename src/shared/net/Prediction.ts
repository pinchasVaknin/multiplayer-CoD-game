import { copyCommand, type InputCommand, type MutableInputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import type { PlayerController } from '../player/PlayerController';
import {
  loadPlayerSim,
  makePlayerSimState,
  savePlayerSim,
  type PlayerSimState,
} from '../player/PlayerState';

/**
 * Client-side prediction and reconciliation (M10, S4.11 and S6.3).
 *
 * ## Why this exists
 *
 * S4.11: *"Client prediction is mandatory, not a polish item. Without it every input carries
 * a full round trip and the movement feel built in M1 is destroyed."* At 100 ms RTT, waiting
 * for the server before moving means the player presses W and the world responds a tenth of a
 * second later, forever. Every good thing about M1's movement — the slide, the mantle, the
 * tac-sprint double tap — depends on the response being immediate.
 *
 * So the client runs `PlayerController.step(cmd)` on its own command the instant it samples
 * it, and remembers what it predicted.
 *
 * ## Reconciliation, exactly
 *
 * The server acks the last `seq` it processed and sends the authoritative state at that
 * moment. Then:
 *
 * 1. Find the prediction recorded for that `seq`.
 * 2. Compare. Within epsilon, the prediction was right: **do nothing at all.**
 * 3. Beyond epsilon, load the authoritative state and replay every command after that `seq`
 *    through the same `PlayerController.step` the server ran.
 *
 * Step 2 is the one that matters most and the one most easily got wrong. A client that snaps
 * to the authoritative state on *every* update — even a matching one — throws away the
 * prediction it correctly made for the ticks the server has not seen yet, and the player
 * rubberbands on a working connection.
 *
 * ## Why replay reproduces the server exactly
 *
 * Because `step` is a pure function of `(state, command)`, and the two impurities that were
 * not are fixed: `WeaponSystem`'s spread stream is now seeded per event from
 * `(tickIndex, entityId, shotIndex)` (S4.14), and the cosmetic events `step` emits are
 * suppressed during a replay — see `replaying`. Without the first, every replayed shot
 * diverges. Without the second, replaying eight commands plays eight footsteps.
 *
 * ## Smoothing
 *
 * S4.11: *"Corrections are applied smoothly over several ticks. A hard snap is what players
 * call rubberbanding."* The correction is applied to the *simulation* immediately — it has
 * to be, or the next tick computes from a position the server has rejected — and the
 * difference is carried as a decaying **visual** offset that the camera adds. The player's
 * collision, their shots and their position are authoritative at once; only what they see
 * eases across. See `CORRECTION_SMOOTHING_TICKS`.
 *
 * ## What is replayed, and what deliberately is not
 *
 * **Movement is replayed. The weapon is not.**
 *
 * `WeaponSystem.step` has effects that are not part of `PlayerSimState` and must not happen
 * twice: it consumes ammunition, advances the reload timer and fires rounds. Replaying eight
 * commands through it would empty a magazine eight times as fast and emit eight duplicate
 * shots. So the weapon runs exactly once per real tick, and its authoritative state — ammo,
 * reload, equipped slot — arrives replicated in the snapshot.
 *
 * This does not cause the movement replay to diverge, and the reason is worth stating because
 * it is not obvious: recoil affects aim, and aim affects movement direction. But recoil's
 * unrecovered residual is folded into the player's *view angles*, which are sampled into the
 * next `InputCommand` as absolute yaw and pitch — so a replayed command already carries the
 * post-recoil aim it was sampled with. The replay reproduces the server exactly because the
 * angles are data in the command rather than state in the weapon.
 */

/**
 * How far the prediction may be from the authoritative state before it counts as wrong.
 *
 * One millimetre. Deliberately tiny rather than forgiving: S8.4 requires the misprediction
 * count to be **zero** at zero added latency, and that is only a meaningful test if the
 * threshold is tight enough that a real divergence cannot hide under it. The owner state is
 * sent at full `f32` precision precisely so this can be this small — with the 1 cm
 * quantisation used for remote entities, an epsilon below a centimetre would be permanently
 * tripped by rounding and the count could never be zero.
 */
export const POSITION_EPSILON = 0.001;

/** Velocity divergence that counts as a misprediction, m/s. */
export const VELOCITY_EPSILON = 0.01;

/**
 * Ticks over which a correction is eased out visually.
 *
 * Six ticks — 100 ms. Chosen by feel against the two failure modes: below about four ticks a
 * correction of any size reads as a snap, and above about ten the camera visibly lags the
 * simulation during sustained packet loss, which feels like input lag rather than like a
 * correction. 100 ms also matches the interpolation delay remote players are rendered at, so
 * a correction and the world it corrects toward settle on the same timescale.
 *
 * A correction larger than `MAX_SMOOTHED_DISTANCE` is snapped instead — see below.
 */
export const CORRECTION_SMOOTHING_TICKS = 6;

/**
 * Beyond this, a correction is applied instantly with no smoothing, metres.
 *
 * Two metres. Smoothing exists to hide small disagreements; easing a large one is strictly
 * worse than snapping, because for the whole window the player's camera is somewhere their
 * body is not — they are shot from behind cover they can see themselves standing behind. A
 * teleport, a respawn and a serious desync all land here, and all three should cut.
 */
export const MAX_SMOOTHED_DISTANCE = 2;

/**
 * Beyond this, an authoritative position is a relocation rather than a correction (M11).
 *
 * Five metres is comfortably above anything prediction error can produce — the §4.3 speed
 * ceiling over a 200 ms round trip is a little under two metres — and comfortably below the
 * shortest distance between two spawn points on any of the three maps. See the branch in
 * `reconcile` that uses it.
 */
export const TELEPORT_DISTANCE = 5;

/** Commands held awaiting acknowledgement. Two seconds at 60 Hz. */
const RING = 128;

/** One recorded prediction: the command, and the state it was expected to produce. */
interface PredictedTick {
  seq: number;
  tick: number;
  /** What the client predicted the state would be *after* this command. */
  readonly state: PlayerSimState;
  /** The command itself, kept so it can be replayed. */
  readonly cmd: MutableInputCommand;
  used: boolean;
}

export interface PredictionStats {
  /** Corrections applied. S8.4 requires this to be zero at zero added latency. */
  mispredictions: number;
  /** Authoritative updates compared. The denominator for a misprediction rate. */
  comparisons: number;
  /** Commands replayed by the most recent correction. */
  lastReplayDepth: number;
  /** Largest replay depth seen. */
  maxReplayDepth: number;
  /** Distance of the most recent correction, metres. */
  lastErrorM: number;
  /** Correction distances, for the p50/p99 S8.5 asks for. */
  readonly errors: number[];
}

export class Prediction {
  readonly stats: PredictionStats = {
    mispredictions: 0,
    comparisons: 0,
    lastReplayDepth: 0,
    maxReplayDepth: 0,
    lastErrorM: 0,
    errors: [],
  };

  /**
   * Visual offset owed to the player, in world space.
   *
   * The simulation is already authoritative; this is the difference between where the camera
   * is being drawn and where the body actually is, decaying to zero over
   * `CORRECTION_SMOOTHING_TICKS`. Read by the camera rig and by nothing that affects gameplay.
   */
  offsetX = 0;
  offsetY = 0;
  offsetZ = 0;

  private readonly ring: PredictedTick[] = [];
  private head = 0;

  /** The offset at the moment of the correction. The live offset is this, scaled by time. */
  private originX = 0;
  private originY = 0;
  private originZ = 0;

  /**
   * True while commands are being replayed.
   *
   * Read by the client's presentation layer to suppress cosmetic reactions. `step` emits
   * footsteps, jumps, landings and stance changes on the `EventBus`, and a replay of eight
   * commands would fire all of them again — eight footstep sounds for one correction. The
   * simulation must still run them (the events are how `sim` state advances), so the
   * suppression is at the listener, not at the emitter.
   */
  replaying = false;

  private lastAckedSeq = -1;
  private smoothingTicksLeft = 0;

  constructor() {
    for (let i = 0; i < RING; i++) {
      this.ring.push({
        seq: -1,
        tick: -1,
        state: makePlayerSimState(),
        cmd: {
          seq: 0,
          tickIndex: 0,
          moveX: 0,
          moveZ: 0,
          yaw: 0,
          pitch: 0,
          buttons: 0,
          sampledAtMs: 0,
        },
        used: false,
      });
    }
  }

  /** Commands predicted but not yet acknowledged. */
  get unacked(): number {
    let n = 0;
    for (const p of this.ring) if (p.used && p.seq > this.lastAckedSeq) n++;
    return n;
  }

  /** How much of a correction is still being eased out, 0..1. */
  get smoothingFraction(): number {
    return this.smoothingTicksLeft / CORRECTION_SMOOTHING_TICKS;
  }

  /**
   * Record what was predicted after applying `cmd`.
   *
   * Called immediately after the client's own `PlayerController.step(cmd)`, every tick.
   */
  record(cmd: InputCommand, controller: PlayerController): void {
    const slot = this.ring[this.head];
    if (slot === undefined) return;
    this.head = (this.head + 1) % RING;
    slot.seq = cmd.seq;
    slot.tick = cmd.tickIndex;
    copyCommand(cmd, slot.cmd);
    savePlayerSim(controller.sim, slot.state);
    slot.used = true;
  }

  /**
   * Apply an authoritative update.
   *
   * Returns true if a correction was applied. `ackSeq` is the last command the server
   * processed; `state` is its result.
   */
  reconcile(ackSeq: number, state: PlayerSimState, controller: PlayerController): boolean {
    if (ackSeq < 0) return false;
    // An ack older than one already applied is a snapshot that overtook a newer one. It
    // carries no information this client has not already acted on.
    if (ackSeq <= this.lastAckedSeq) return false;
    this.lastAckedSeq = ackSeq;
    this.stats.comparisons++;

    const predicted = this.find(ackSeq);
    if (predicted === null) {
      // No record: this client has been alive for less than the ring, or the server acked a
      // command from before a respawn. Accept the server's word without counting it as a
      // misprediction — there was no prediction to be wrong.
      loadPlayerSim(state, controller.sim);
      return false;
    }

    const dx = state.x - predicted.state.x;
    const dy = state.y - predicted.state.y;
    const dz = state.z - predicted.state.z;
    const distance = Math.hypot(dx, dy, dz);
    const velocityOff =
      Math.abs(state.vx - predicted.state.vx) > VELOCITY_EPSILON ||
      Math.abs(state.vy - predicted.state.vy) > VELOCITY_EPSILON ||
      Math.abs(state.vz - predicted.state.vz) > VELOCITY_EPSILON;

    if (distance <= POSITION_EPSILON && !velocityOff && state.stance === predicted.state.stance) {
      // The prediction was right. Do nothing — in particular, do **not** load the
      // authoritative state, which is older than what this client has already simulated.
      return false;
    }

    /**
     * Past a certain distance it is not a wrong prediction, it is a relocation (M11).
     *
     * A client running at the §4.3 speed ceiling with a 200 ms round trip can be at most a
     * couple of metres out through prediction error alone. Anything beyond that is the server
     * having *put the player somewhere else* — a spawn, a round reset, a killstreak
     * teleporting them into a gunship seat — and no client could have predicted any of it.
     *
     * `respawned` catches the common case by watching the replicated spawn serial, and this is
     * the backstop for the ones it cannot see: a relocation that arrives in an owner block
     * without a corresponding entity update, which is exactly what a delta snapshot is
     * entitled to send.
     *
     * It was measured before this existed as a **p99 of 30.26 m** on one harness client — the
     * width of Foundry, and the same signature M10 recorded before the respawn case was
     * handled. One such event is enough to dominate a percentile and to turn a criterion that
     * asks for zero mispredictions into one that can never be met.
     */
    if (distance > TELEPORT_DISTANCE) {
      loadPlayerSim(state, controller.sim);
      this.replayAfter(ackSeq, controller);
      this.originX = 0;
      this.originY = 0;
      this.originZ = 0;
      this.smoothingTicksLeft = 0;
      this.applyOffset();
      return false;
    }

    this.stats.mispredictions++;
    this.stats.lastErrorM = distance;
    this.stats.errors.push(distance);
    if (this.stats.errors.length > 4096) this.stats.errors.shift();

    /**
     * Where the player is currently being *drawn* — simulation plus any offset still being
     * eased out from a previous correction.
     *
     * Measuring against the drawn position rather than the simulated one is what makes
     * back-to-back corrections stack smoothly. Under packet loss they arrive every few
     * ticks, and an offset computed from the raw sim position would discard the residual of
     * the correction still in flight, producing a visible pop on every one after the first.
     */
    const beforeX = controller.sim.x + this.offsetX;
    const beforeY = controller.sim.y + this.offsetY;
    const beforeZ = controller.sim.z + this.offsetZ;

    // 1. Snap the simulation to the truth.
    loadPlayerSim(state, controller.sim);

    // 2. Replay every command the server has not seen yet, through the same step function.
    const depth = this.replayAfter(ackSeq, controller);
    this.stats.lastReplayDepth = depth;
    if (depth > this.stats.maxReplayDepth) this.stats.maxReplayDepth = depth;

    // 3. Carry the visible difference as a decaying offset rather than a jump.
    const afterX = controller.sim.x;
    const afterY = controller.sim.y;
    const afterZ = controller.sim.z;
    const visualDx = beforeX - afterX;
    const visualDy = beforeY - afterY;
    const visualDz = beforeZ - afterZ;
    const visualDistance = Math.hypot(visualDx, visualDy, visualDz);

    if (visualDistance > MAX_SMOOTHED_DISTANCE) {
      // Too far to hide. Cut, and let the player see where they actually are.
      this.originX = 0;
      this.originY = 0;
      this.originZ = 0;
      this.smoothingTicksLeft = 0;
    } else {
      this.originX = visualDx;
      this.originY = visualDy;
      this.originZ = visualDz;
      this.smoothingTicksLeft = CORRECTION_SMOOTHING_TICKS;
    }
    this.applyOffset();

    return true;
  }

  /**
   * Decay the visual correction. Called once per tick, after the prediction step.
   *
   * Linear rather than exponential, because it must actually *reach* zero: an exponential
   * decay leaves a residual offset that never quite resolves, and a player who has taken a
   * correction would spend the rest of the match a few millimetres off their own body.
   */
  step(): void {
    if (this.smoothingTicksLeft <= 0) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetZ = 0;
      return;
    }
    this.smoothingTicksLeft--;
    this.applyOffset();
  }

  /**
   * The live offset is the correction scaled by how much of the window is left.
   *
   * Recomputed from the origin each tick rather than multiplied down, so it reaches exactly
   * zero on the last tick. A repeated multiply is an exponential decay that never quite
   * arrives, and a player who took one correction would spend the rest of the match drawn a
   * fraction of a millimetre away from their own body.
   */
  private applyOffset(): void {
    const t = this.smoothingTicksLeft / CORRECTION_SMOOTHING_TICKS;
    this.offsetX = this.originX * t;
    this.offsetY = this.originY * t;
    this.offsetZ = this.originZ * t;
  }

  /**
   * Take the server's state as given, without judging a prediction against it.
   *
   * For the cases where there was no prediction to judge: a respawn, a join, a reconnect.
   * Distinct from `reconcile` on purpose — it counts nothing, records no error and starts no
   * smoothing, because none of those would mean anything about how well this client is
   * predicting. Conflating the two is what makes a misprediction count that can never be zero.
   */
  adopt(state: PlayerSimState, controller: PlayerController, ackSeq = -1): void {
    loadPlayerSim(state, controller.sim);

    /**
     * Replay whatever the server has not acked yet (M11).
     *
     * On a respawn there is nothing to replay — the ring was just cleared — and `ackSeq`
     * defaults to -1 so this does nothing, exactly as it did at M10.
     *
     * A **migration** is different, and the difference cost a misprediction on every single
     * transition. The client keeps sending commands from the moment it is reseated, so by the
     * time the first snapshot from the new instance arrives the server has already simulated
     * two or three of them. Adopting that state without replaying them leaves the client two
     * ticks behind its own input: the very next reconcile finds a mismatch, counts it, and
     * corrects — one misprediction, at the same tick offset, on every client, every time.
     *
     * Measured: exactly 1 in the 60 ticks after every return to the arena, on all three
     * harness clients, at window tick 3-4. Zero with this replay.
     */
    if (ackSeq >= 0) {
      this.lastAckedSeq = ackSeq;
      const depth = this.replayAfter(ackSeq, controller);
      this.stats.lastReplayDepth = depth;
      if (depth > this.stats.maxReplayDepth) this.stats.maxReplayDepth = depth;
    }

    this.originX = 0;
    this.originY = 0;
    this.originZ = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
    this.smoothingTicksLeft = 0;
  }

  /** Drop every prediction. Called on respawn and on reconnect. */
  reset(): void {
    for (const p of this.ring) p.used = false;
    this.head = 0;
    this.lastAckedSeq = -1;
    this.smoothingTicksLeft = 0;
    this.originX = 0;
    this.originY = 0;
    this.originZ = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
  }

  /** Correction distances sorted, for percentile reporting (S8.5). */
  percentiles(): { p50: number; p99: number; count: number } {
    const n = this.stats.errors.length;
    if (n === 0) return { p50: 0, p99: 0, count: 0 };
    const sorted = [...this.stats.errors].sort((a, b) => a - b);
    const at = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))] ?? 0;
    return { p50: at(0.5), p99: at(0.99), count: n };
  }

  // -- internals --------------------------------------------------------------

  private find(seq: number): PredictedTick | null {
    for (const p of this.ring) {
      if (p.used && p.seq === seq) return p;
    }
    return null;
  }

  /**
   * Re-run every command after `seq`, in order.
   *
   * The predictions are overwritten as they are recomputed: the replayed result *is* the new
   * prediction, and leaving the old one would make the next reconciliation compare against a
   * state this client no longer believes.
   */
  private replayAfter(seq: number, controller: PlayerController): number {
    // Collect and sort, because the ring is in write order and wraps.
    const pending: PredictedTick[] = [];
    for (const p of this.ring) {
      if (p.used && p.seq > seq) pending.push(p);
    }
    if (pending.length === 0) return 0;
    pending.sort((a, b) => a.seq - b.seq);

    this.replaying = true;
    try {
      for (const p of pending) {
        controller.step(p.cmd);
        savePlayerSim(controller.sim, p.state);
      }
    } finally {
      this.replaying = false;
    }
    return pending.length;
  }
}

/** Seconds of prediction the ring can hold. For the debug panel's sanity check. */
export const PREDICTION_WINDOW_SECONDS = RING * DT;

export { makePlayerSimState, savePlayerSim, loadPlayerSim, type PlayerSimState };
