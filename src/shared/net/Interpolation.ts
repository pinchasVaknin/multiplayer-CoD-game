import { shortestAngle } from '../core/MathUtil';
import type { StanceId } from '../player/Stance';
import { copyEntitySnapshot, makeEntitySnapshot, type EntitySnapshot } from './Snapshot';

/**
 * Remote entities, rendered in the past (M10, S4.12).
 *
 * ## The rule
 *
 * S4.12: *"Remote entities are interpolated, never predicted. Render them ~100 ms in the past
 * out of a buffer, so jitter and a dropped packet are invisible. Local player predicted,
 * remotes interpolated — **two different code paths, and conflating them is the classic
 * bug**."*
 *
 * This file is one of those two paths and it shares no code with `Prediction.ts` on purpose.
 * The reasoning behind the split is worth keeping in view, because "just predict everyone"
 * is a tempting simplification:
 *
 * - The local player's **inputs are known**, so their future can be computed exactly. A
 *   remote player's inputs are not known and never will be, so predicting them means guessing
 *   — and a wrong guess about somebody else is a body that visibly jumps when corrected.
 * - Being ~100 ms behind costs a remote player nothing, because lag compensation (S4.13)
 *   rewinds to exactly this view time when resolving a shot. Being 100 ms behind on *yourself*
 *   would be unplayable.
 *
 * ## Extrapolation, briefly and then never
 *
 * S4.12: *"Extrapolate for at most ~250 ms when the buffer starves, then freeze. Never
 * extrapolate forever."* A starved buffer means snapshots stopped arriving. For the first
 * quarter second, continuing along the last known velocity is a better guess than stopping —
 * people mostly keep moving. Past that it is a fabrication, and a body sliding smoothly
 * through a wall because the server stopped talking is worse than a body standing still.
 */

/** How far in the past remote entities are rendered, ms (S4.12). */
export const DEFAULT_INTERPOLATION_DELAY_MS = 100;

/** Longest extrapolation past the newest sample before the entity freezes, ms (S4.12). */
export const MAX_EXTRAPOLATION_MS = 250;

/** Samples retained per entity. At 20 Hz this is 1.6 s of history. */
const SAMPLES = 32;

interface Sample {
  /** Server time this state is for, ms. */
  serverMs: number;
  readonly state: EntitySnapshot;
  used: boolean;
}

/** The pose an entity should be drawn at, this frame. */
export interface InterpolatedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  heightScale: number;
  stance: StanceId;
  /** True when this pose is extrapolated rather than interpolated. */
  extrapolated: boolean;
  /** True when the buffer has starved past the extrapolation cap and the body is frozen. */
  frozen: boolean;
}

export function makeInterpolatedPose(): InterpolatedPose {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    heightScale: 1,
    stance: 'STAND',
    extrapolated: false,
    frozen: false,
  };
}

/**
 * One remote entity's sample history.
 *
 * The newest state is also kept unsmoothed, because not everything about an entity should be
 * interpolated: health, weapon, flags and the visual serials are discrete facts that take
 * effect when they arrive. Blending a weapon index between two values would produce a
 * different gun; blending a death serial would produce nothing at all.
 */
export class EntityInterpolator {
  /** The newest state received, applied as-is for everything discrete. */
  readonly latest: EntitySnapshot = makeEntitySnapshot();

  /** Server time of the newest sample. */
  latestMs = 0;

  private readonly samples: Sample[] = [];
  private head = 0;
  private count = 0;

  constructor() {
    for (let i = 0; i < SAMPLES; i++) {
      this.samples.push({ serverMs: 0, state: makeEntitySnapshot(), used: false });
    }
  }

  /** Add a state observed at `serverMs`. */
  push(state: EntitySnapshot, serverMs: number): void {
    const slot = this.samples[this.head];
    if (slot === undefined) return;
    this.head = (this.head + 1) % SAMPLES;
    if (this.count < SAMPLES) this.count++;
    slot.serverMs = serverMs;
    copyEntitySnapshot(state, slot.state);
    slot.used = true;

    if (serverMs >= this.latestMs) {
      this.latestMs = serverMs;
      copyEntitySnapshot(state, this.latest);
    }
  }

  /**
   * Where this entity should be drawn at render time `renderMs` (server clock).
   *
   * The caller passes `serverNow - interpolationDelay`. Finds the two samples bracketing that
   * time and blends between them; extrapolates from the newest pair if the buffer has run
   * dry; freezes past the cap.
   */
  sample(renderMs: number, out: InterpolatedPose): void {
    out.extrapolated = false;
    out.frozen = false;

    const newest = this.newest();
    if (newest === null) return;

    // Discrete fields always come from the newest sample, never blended.
    out.heightScale = newest.state.heightScale;
    out.stance = newest.state.stance;

    if (renderMs >= newest.serverMs) {
      this.extrapolate(newest, renderMs, out);
      return;
    }

    const oldest = this.oldest();
    if (oldest !== null && renderMs <= oldest.serverMs) {
      // Behind everything held: the buffer is over-full, which happens right after a join.
      // Draw the oldest rather than inventing a pose before it.
      write(oldest.state, out);
      return;
    }

    // Find the bracketing pair.
    let before: Sample | null = null;
    let after: Sample | null = null;
    for (const s of this.samples) {
      if (!s.used) continue;
      if (s.serverMs <= renderMs && (before === null || s.serverMs > before.serverMs)) before = s;
      if (s.serverMs > renderMs && (after === null || s.serverMs < after.serverMs)) after = s;
    }

    if (before === null || after === null) {
      write(newest.state, out);
      return;
    }

    const span = after.serverMs - before.serverMs;
    const t = span <= 0 ? 0 : (renderMs - before.serverMs) / span;
    const a = before.state;
    const b = after.state;

    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    // Angles the short way round, or a player turning through north spins the long way.
    out.yaw = a.yaw + shortestAngle(a.yaw, b.yaw) * t;
    out.pitch = a.pitch + (b.pitch - a.pitch) * t;
    out.heightScale = a.heightScale + (b.heightScale - a.heightScale) * t;
    // Stance is discrete: it changes at the sample that carries it, never halfway between.
    out.stance = b.stance;
  }

  /**
   * Throw the history away and restart from the newest state, stamped at `serverMs`.
   *
   * **A respawn is a teleport, and a teleport is the one thing an interpolator must not
   * smooth.** The samples either side of it describe two places the same entity genuinely was,
   * so the bracketing blend does exactly what it is built to do and drags the body from where
   * it fell to where it came back — across the map, in a straight line, at whatever speed the
   * interpolation delay implies. It also gives the spawn away.
   *
   * `reset()` alone is not enough: `sample` returns early with an empty buffer and leaves the
   * pose untouched, so the body would sit at the corpse for a snapshot and then jump. Pushing
   * the post-spawn state back in at the render time means the very next sample is that state,
   * which is a clean cut rather than a slide or a stall.
   *
   * `latest` deliberately survives `reset`, which is what makes this two lines.
   */
  snapTo(serverMs: number): void {
    const latest = this.latest;
    this.reset();
    this.push(latest, serverMs);
  }

  /** Drop everything. Used when an entity is removed and its id later reused. */
  reset(): void {
    for (const s of this.samples) s.used = false;
    this.count = 0;
    this.head = 0;
    this.latestMs = 0;
  }

  get sampleCount(): number {
    return this.count;
  }

  // -- internals --------------------------------------------------------------

  /**
   * Continue past the newest sample along the last observed velocity, then stop.
   *
   * The velocity comes from the two newest samples rather than from the replicated `vx/vz`,
   * because what needs continuing is the *observed* motion between the two poses being drawn
   * — using the entity's own velocity field would disagree with the interpolation it is
   * continuing from and produce a kink at the handover.
   */
  private extrapolate(newest: Sample, renderMs: number, out: InterpolatedPose): void {
    const aheadMs = renderMs - newest.serverMs;

    if (aheadMs > MAX_EXTRAPOLATION_MS) {
      // Past the cap. Freeze. A body standing still is a body somebody can reason about; a
      // body gliding through a wall is not.
      write(newest.state, out);
      out.frozen = true;
      return;
    }

    const previous = this.secondNewest(newest);
    if (previous === null) {
      write(newest.state, out);
      return;
    }

    const span = newest.serverMs - previous.serverMs;
    if (span <= 0) {
      write(newest.state, out);
      return;
    }

    const scale = aheadMs / span;
    const a = previous.state;
    const b = newest.state;
    out.x = b.x + (b.x - a.x) * scale;
    out.y = b.y + (b.y - a.y) * scale;
    out.z = b.z + (b.z - a.z) * scale;
    out.yaw = b.yaw + shortestAngle(a.yaw, b.yaw) * scale;
    out.pitch = b.pitch;
    out.extrapolated = true;
  }

  private newest(): Sample | null {
    let best: Sample | null = null;
    for (const s of this.samples) {
      if (!s.used) continue;
      if (best === null || s.serverMs > best.serverMs) best = s;
    }
    return best;
  }

  private secondNewest(exclude: Sample): Sample | null {
    let best: Sample | null = null;
    for (const s of this.samples) {
      if (!s.used || s === exclude) continue;
      if (best === null || s.serverMs > best.serverMs) best = s;
    }
    return best;
  }

  private oldest(): Sample | null {
    let best: Sample | null = null;
    for (const s of this.samples) {
      if (!s.used) continue;
      if (best === null || s.serverMs < best.serverMs) best = s;
    }
    return best;
  }
}

function write(state: EntitySnapshot, out: InterpolatedPose): void {
  out.x = state.x;
  out.y = state.y;
  out.z = state.z;
  out.yaw = state.yaw;
  out.pitch = state.pitch;
  out.heightScale = state.heightScale;
  out.stance = state.stance;
}
