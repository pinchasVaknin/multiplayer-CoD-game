import { Path, Pathfinder, type PathClient } from '../ai/Pathing';
import { simCos, simSin } from '../core/SimMath';
import type { GameModeId } from '../modes/GameMode';
import type { MovementConfig } from '../player/MovementConfig';
import { makeMoveOutput, type CollisionWorld } from '../world/CollisionWorld';
import type { NavGrid } from '../world/NavGrid';
import type { MapDef, ObjectiveDef, Vec3Lit } from '../world/maps/types';

/**
 * The match intro's camera path (M15, Phase C): a plan, not a player.
 *
 * ## What it hides, and what it is
 *
 * The brief called this a hidden loading screen. In this project there is nothing to hide —
 * the connected path builds the next map during the previous match's summary (§6.5), the
 * solo path before `MATCH` — but there *is* the round-one freeze: `MATCH_START_SECONDS` in
 * which the player stands at spawn unable to move, ten seconds so there is time to read the
 * quick class selector. The intro is client-only presentation over a built world during a
 * freeze the server already runs. Nothing goes on the wire.
 *
 * ## Three phases in one budget
 *
 * Of the freeze's ten seconds, the last 1.0 is the player's own view — a player looking
 * through a cinematic camera when the round goes live has been ambushed by their own UI —
 * and the 0.5 before that is the blend back to it. The plan's segments fill what is left:
 *
 *  1. **The approach** — spawn to the map's centre on the bots' own route (`Pathfinder` over
 *     the match's `NavGrid`, a second instance so the bots' queue is untouched), a Catmull-Rom
 *     spline through the waypoints at eye height, yaw following the tangent, pitch held a
 *     few degrees down. A distance/time profile eased at both ends with a ceiling: a route
 *     longer than the ceiling allows is **trimmed from the spawn end**, not sped up, because
 *     the approach reads as a person moving or it does not read.
 *  2. **The overview** — a pull-back from the centre along a 45° ray whose azimuth points
 *     toward the player's spawn, so their own side lands at the bottom of the frame; to the
 *     distance at which the map's half-diagonal fits the lens, clamped by the first collider
 *     the ray meets (a roof, a wall) — computed, never tuned per map.
 *  3. **The objectives** — Domination's flags in label order, Search & Destroy's two sites:
 *     a snap down to each, a hold with its label, a whip to the next along a nav route with
 *     the speed profile inverted (fast in the middle, eased into the hold). A route the grid
 *     cannot find falls back to an arc above the map, never through it. Team Deathmatch,
 *     Free-for-All and Kill Confirmed hold the overview instead.
 *
 * ## Pure, so it can be proved
 *
 * Loose numbers, `shared/` maths, no `three`, no clock: the same function runs in the client
 * on the freeze's first frame and in `npm run intro` on the server build, where every map ×
 * mode is planned, sampled every 25 cm and tested against the map's own `CollisionWorld`.
 * The plan reports what it trimmed and what it could not route, so the harness prints a
 * number rather than a shrug.
 */

export interface IntroPose {
  x: number;
  y: number;
  z: number;
  /** three's yaw: 0 faces -Z, +X is -π/2. */
  yaw: number;
  pitch: number;
}

export type IntroSegmentKind = 'approach' | 'pullback' | 'hold' | 'snap' | 'whip';

export interface IntroSegment {
  readonly kind: IntroSegmentKind;
  readonly seconds: number;
  /** An objective's label while the camera is on it, else empty. */
  readonly label: string;
  /** Metres the segment travels, for the harness's report. */
  readonly metres: number;
  /** The pose at `u` in [0, 1]. */
  at(u: number, out: IntroPose): void;
}

export interface IntroPlan {
  readonly segments: readonly IntroSegment[];
  /** The segments' total. The client blends back to the rig for `RETURN_SECONDS` after it. */
  readonly seconds: number;
  readonly approachMetres: number;
  /** Metres cut from the spawn end so the approach fits its budget. */
  readonly trimmedMetres: number;
  /** Objective ids visited, in order. */
  readonly objectives: readonly string[];
  /** Whips that fell back to the arc because the grid had no route. */
  readonly arcs: readonly string[];
  readonly overviewDistance: number;
  /** What the pull-in, the whips and their holds cost, against `OBJECTIVES_MAX_SECONDS`. */
  readonly objectiveSeconds: number;
  /** Tabulated points pushed off a collider by `relax` — grazes the route hugs at the bots' clearance. */
  readonly nudged: number;
  /** The raised waypoints each travelling segment was built on, in segment order; empty for the rest. */
  readonly waypoints: readonly (readonly Vec3Lit[])[];
  poseAt(t: number, out: IntroPose): void;
}

export interface IntroInput {
  readonly def: MapDef;
  readonly nav: NavGrid;
  readonly collision: CollisionWorld;
  readonly movement: MovementConfig;
  readonly modeId: GameModeId;
  /** Where the player stands: the spawn the freeze holds them at. */
  readonly spawn: Vec3Lit;
  /** The intro camera's vertical field of view, degrees — what the overview is fitted to. */
  readonly fovDeg: number;
  /** The freeze's length; the plan fits in it less the return and the player's own second. */
  readonly freezeSeconds: number;
}

/** The blend from the last pose back to the rig's eye. */
export const RETURN_SECONDS = 0.5;
/** The player's own view before the freeze lifts. Not negotiable — see the file comment. */
export const OWN_VIEW_SECONDS = 1.0;
export const APPROACH_MAX_SECONDS = 3.5;
export const PULLBACK_SECONDS = 1.5;
export const OBJECTIVES_MAX_SECONDS = 3.5;
/** Metres per second at the approach's fastest; a sprint is 6.9. */
export const APPROACH_PEAK_SPEED = 9;
/** Metres per second at a whip's fastest. */
export const WHIP_PEAK_SPEED = 40;
/** The player's eye above the ground it stands on (`PlayerSnapshot.eyeHeight`). */
export const EYE_HEIGHT = 1.65;
/**
 * The sphere the camera keeps clear, and the one the harness tests: the bots' capsule is
 * 0.35 wide, but at eye height it has narrowed to 0.287 — the eye sits in the capsule's top
 * cap — and the route is pulled to that clearance at every corner, so a larger sphere would
 * flag the route the bots walk. The lens's near plane is 0.12; this is twice it.
 */
export const EYE_RADIUS = 0.25;
const APPROACH_PITCH = (-6 * Math.PI) / 180;
/** A minimum for the approach: shorter than this reads as a cut, not a move. */
const APPROACH_MIN_SECONDS = 1.2;
/** The pull back in from the overview to the centre; the pull-back reversed. */
const SNAP_SECONDS = 0.5;
const OBJECTIVE_HOLD_SECONDS = 0.3;
/** A whip's longest; two objectives and the pull-in then fit `OBJECTIVES_MAX_SECONDS`. */
const WHIP_MAX_SECONDS = 1.0;
/** The camera's stand-off from an objective: back along the arrival, and up. */
const OBJECTIVE_BACK = 4;
const OBJECTIVE_UP = 3;
/** How far the overview ray keeps from the collider that stops it. */
const OVERVIEW_CLEARANCE = 1.5;
const YAW_LAG_SECONDS = 0.3;
/** The overview's sphere march. */
const MARCH_STEP = 0.25;
/** Where the overview may look from: azimuths either side of the spawn's, elevations under 45°. */
const OVERVIEW_AZIMUTHS = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2, (2 * Math.PI) / 3, (-2 * Math.PI) / 3, (5 * Math.PI) / 6, (-5 * Math.PI) / 6, Math.PI];
const OVERVIEW_ELEVATIONS = [Math.PI / 4, Math.PI / 5, Math.PI / 6];

/** A smoothstep ease: position, and (for the profile) its peak speed is 1.5× the average. */
function ease(u: number): number {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

/** three's yaw for a horizontal direction. */
function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

function lookAt(from: IntroPose, tx: number, ty: number, tz: number): void {
  const dx = tx - from.x;
  const dy = ty - from.y;
  const dz = tz - from.z;
  from.yaw = yawOf(dx, dz);
  from.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

/** The shortest signed difference from `a` to `b`, radians. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// -- a polyline with an arc-length table ---------------------------------------

/**
 * The route as a curve, tabulated by distance.
 *
 * **A polyline with small fillets, not a Catmull-Rom.** The first version was a Catmull-Rom
 * through the waypoints, and `npm run intro` put its first bad sample 0.95 m from the nearest
 * waypoint, inside a crate: a Catmull-Rom overshoots a corner by a good fraction of the spans
 * either side, and the bots' string-pulled route hugs every corner at the capsule's radius,
 * so an overshoot of any size is an overshoot into the thing the route was pulled around.
 * Each corner is rounded with a quadratic fillet of at most `FILLET` metres instead — a cut
 * of `FILLET × 0.29` at a right angle, three and a half centimetres, inside the four the
 * route keeps clear of `EYE_RADIUS` at head height — and the heading, not the position, is
 * what the eye smooths (`yawAt`, and the lag in the approach).
 *
 * The table is what makes a speed profile honest: `at(s)` is a position `s` metres along
 * the curve, so a profile in metres per second moves the camera at that speed rather than at
 * whatever a parameter step happens to cover between two close waypoints and two far ones.
 */
const FILLET = 0.12;
/** The most a point may be pushed off a collider before it is a route problem, not a graze. */
const MAX_NUDGE = 0.3;
const SPAN_STEP = 0.125;
const RELAX_ROUNDS = 4;

class Spline {
  readonly length: number;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly cum: Float64Array;

  constructor(points: readonly Vec3Lit[]) {
    const n = points.length;
    if (n === 0) throw new Error('a spline needs a point');
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const push = (x: number, y: number, z: number): void => {
      xs.push(x);
      ys.push(y);
      zs.push(z);
    };
    push(points[0]!.x, points[0]!.y, points[0]!.z);
    // A straight span is subdivided every `SPAN_STEP` metres, so `relax` has a point to push
    // where a graze falls mid-span rather than only at the corners.
    const subdivideTo = (tx: number, ty: number, tz: number): void => {
      const fx = xs[xs.length - 1]!;
      const fy = ys[ys.length - 1]!;
      const fz = zs[zs.length - 1]!;
      const len = Math.hypot(tx - fx, ty - fy, tz - fz);
      const steps = Math.max(1, Math.ceil(len / SPAN_STEP));
      for (let j = 1; j < steps; j++) {
        const t = j / steps;
        push(fx + (tx - fx) * t, fy + (ty - fy) * t, fz + (tz - fz) * t);
      }
    };
    for (let i = 1; i < n - 1; i++) {
      const a = points[i - 1]!;
      const p = points[i]!;
      const b = points[i + 1]!;
      const inLen = Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
      const outLen = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z);
      const r = Math.min(FILLET, inLen / 2, outLen / 2);
      if (r < 1e-4 || inLen < 1e-6 || outLen < 1e-6) {
        subdivideTo(p.x, p.y, p.z);
        push(p.x, p.y, p.z);
        continue;
      }
      // Straight to the fillet's start, a quadratic through the corner to its end.
      const sx = p.x - ((p.x - a.x) / inLen) * r;
      const sy = p.y - ((p.y - a.y) / inLen) * r;
      const sz = p.z - ((p.z - a.z) / inLen) * r;
      const ex = p.x + ((b.x - p.x) / outLen) * r;
      const ey = p.y + ((b.y - p.y) / outLen) * r;
      const ez = p.z + ((b.z - p.z) / outLen) * r;
      subdivideTo(sx, sy, sz);
      push(sx, sy, sz);
      for (let j = 1; j < 6; j++) {
        const t = j / 6;
        const u = 1 - t;
        push(u * u * sx + 2 * u * t * p.x + t * t * ex, u * u * sy + 2 * u * t * p.y + t * t * ey, u * u * sz + 2 * u * t * p.z + t * t * ez);
      }
      push(ex, ey, ez);
    }
    if (n > 1) {
      subdivideTo(points[n - 1]!.x, points[n - 1]!.y, points[n - 1]!.z);
      push(points[n - 1]!.x, points[n - 1]!.y, points[n - 1]!.z);
    }

    const count = xs.length;
    this.px = Float64Array.from(xs);
    this.py = Float64Array.from(ys);
    this.pz = Float64Array.from(zs);
    this.cum = new Float64Array(count);
    let total = 0;
    for (let k = 1; k < count; k++) {
      total += Math.hypot(xs[k]! - xs[k - 1]!, ys[k]! - ys[k - 1]!, zs[k]! - zs[k - 1]!);
      this.cum[k] = total;
    }
    this.length = total;
  }

  /**
   * Push every tabulated point out of whatever the eye's sphere touches — a few centimetres
   * off a crate's corner or a wall the route hugs at exactly the bots' clearance — and retake
   * the table's lengths. `resolveAt` is the movement system's own de-penetration, so the
   * camera is pushed the way a body would be: along the contact normal, by the depth. Points
   * moved by more than `MAX_NUDGE` are left where they were, because a push that large means
   * the route is wrong, not close, and the harness should say so rather than have it hidden.
   */
  relax(collision: CollisionWorld, radius: number): number {
    const out = makeMoveOutput();
    let nudged = 0;
    const count = this.px.length;
    // A few rounds: a point pushed off one face of a convex corner can land in the next
    // point's sphere, and the span between two pushed points can still cut the corner.
    for (let round = 0; round < RELAX_ROUNDS; round++) {
      let movedThisRound = 0;
      for (let k = 0; k < count; k++) {
        const x = this.px[k]!;
        const y = this.py[k]!;
        const z = this.pz[k]!;
        if (!collision.overlapCapsule(x, y - radius, z, radius, radius * 2)) continue;
        collision.resolveAt(x, y - radius, z, radius, radius * 2, out);
        const moved = Math.hypot(out.x - x, out.y + radius - y, out.z - z);
        if (moved > MAX_NUDGE || moved < 1e-6) continue;
        this.px[k] = out.x;
        this.py[k] = out.y + radius;
        this.pz[k] = out.z;
        movedThisRound++;
      }
      nudged += movedThisRound;
      if (movedThisRound === 0) break;
    }
    if (nudged > 0) {
      let total = 0;
      for (let k = 1; k < count; k++) {
        total += Math.hypot(this.px[k]! - this.px[k - 1]!, this.py[k]! - this.py[k - 1]!, this.pz[k]! - this.pz[k - 1]!);
        this.cum[k] = total;
      }
      (this as { length: number }).length = total;
    }
    return nudged;
  }

  /** Position `s` metres along, clamped to the ends. */
  at(s: number, out: IntroPose): void {
    const cum = this.cum;
    const n = cum.length;
    if (n === 1 || s <= 0) {
      out.x = this.px[0]!;
      out.y = this.py[0]!;
      out.z = this.pz[0]!;
      return;
    }
    if (s >= this.length) {
      out.x = this.px[n - 1]!;
      out.y = this.py[n - 1]!;
      out.z = this.pz[n - 1]!;
      return;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const span = cum[hi]! - cum[lo]!;
    const f = span > 0 ? (s - cum[lo]!) / span : 0;
    out.x = this.px[lo]! + (this.px[hi]! - this.px[lo]!) * f;
    out.y = this.py[lo]! + (this.py[hi]! - this.py[lo]!) * f;
    out.z = this.pz[lo]! + (this.pz[hi]! - this.pz[lo]!) * f;
  }

  /** The horizontal heading `s` metres along, as three's yaw. */
  yawAt(s: number): number {
    const a: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    const b: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    const h = Math.min(0.5, Math.max(0.05, this.length * 0.02));
    this.at(Math.max(0, s - h), a);
    this.at(Math.min(this.length, s + h), b);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (Math.hypot(dx, dz) < 1e-6) return 0;
    return yawOf(dx, dz);
  }
}

// -- routes off the navmesh ---------------------------------------------------

class OneShotClient implements PathClient {
  readonly pathClientId = -2;
  readonly path = new Path();
  done = false;
  found = false;
  onPathReady(found: boolean): void {
    this.done = true;
    this.found = found;
  }
}

/**
 * The waypoints from `a` to `b` on the grid, at ground height, or null if there is no route.
 *
 * Solved synchronously with a generous budget on a `Pathfinder` of the plan's own, the shape
 * `ModePanel.measureLanes` uses: the grid is ~27 k nodes and a crossing is a few thousand
 * expansions. The start and the goal are the nearest walkable cells, so an objective that is
 * authored a hand's breadth inside a wall still routes. The list starts at `a` itself, not at
 * its cell's centre: for the approach `a` is where the player stands, and a camera in the
 * player's own eyes is clear by construction where a cell centre half a metre away may not be.
 */
function route(nav: NavGrid, finder: Pathfinder, a: Vec3Lit, b: Vec3Lit): Vec3Lit[] | null {
  const start = nav.nearestCell(a.x, a.y, a.z, 12);
  const goal = nav.nearestCell(b.x, b.y, b.z, 12);
  if (start < 0 || goal < 0) return null;
  const client = new OneShotClient();
  finder.request(client, start, goal);
  for (let i = 0; i < 64 && !client.done; i++) finder.step(4096);
  if (!client.found) return null;
  // `a` itself, then its cell's centre — a hand's breadth away and linked to the path — so
  // the first span is that hand's breadth rather than a straight cut to a string-pulled
  // waypoint several cells on, which `npm run intro` found going through the crate a spawn
  // stood behind.
  const points: Vec3Lit[] = [
    { x: a.x, y: a.y, z: a.z },
    { x: nav.centerX(nav.indexOfX(start)), y: nav.heightAt(start), z: nav.centerZ(nav.indexOfZ(start)) },
  ];
  for (let i = 0; i < client.path.count; i++) {
    points.push({ x: client.path.x[i]!, y: client.path.y[i]!, z: client.path.z[i]! });
  }
  return points;
}

/**
 * How far a sphere can travel from `from` along a direction before it meets a collider —
 * marched at `MARCH_STEP`, with the same sphere the harness tests, because a line ray can
 * pass the edge of a deck that a 30 cm eye cannot. Capped at `maxDist`.
 */
function clearDistance(
  collision: CollisionWorld,
  from: IntroPose,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  radius: number,
): number {
  for (let s = MARCH_STEP; s <= maxDist; s += MARCH_STEP) {
    const x = from.x + dx * s;
    const y = from.y + dy * s;
    const z = from.z + dz * s;
    if (collision.overlapCapsule(x, y - radius, z, radius, radius * 2)) return Math.max(0, s - MARCH_STEP);
  }
  return maxDist;
}

/**
 * The route at eye height — and hopped, where the route climbs or drops.
 *
 * A bot's route mantles: two consecutive waypoints a ledge apart are joined by a straight
 * line the capsule is allowed through because the mantle animation carries it. A camera on
 * that line goes through the ledge's edge at head height (`npm run intro`'s Foundry box 31).
 * So where the rise exceeds `step`, the camera goes *up first* — over the lower waypoint,
 * to the higher one's eye height, which is clear because the bot stands there — and then
 * across at the higher height, over the ledge; a drop is the mirror, across first and then
 * down over the lower waypoint.
 */
function raised(points: readonly Vec3Lit[], by: number, step = 0.5): Vec3Lit[] {
  const out: Vec3Lit[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      const rise = p.y + by - prev.y;
      if (rise > step) out.push({ x: prev.x, y: p.y + by, z: prev.z });
      else if (rise < -step) out.push({ x: p.x, y: prev.y, z: p.z });
    }
    out.push({ x: p.x, y: p.y + by, z: p.z });
  }
  return out;
}

/**
 * Where the camera holds on an objective: back along the arrival and up, looking at it —
 * the first of a few stand-offs that the eye's sphere finds clear, nearer and lower each
 * time, because a flag under a catwalk has no clear point four metres back and three up.
 */
function standOff(collision: CollisionWorld, o: Vec3Lit, from: IntroPose): IntroPose {
  let bx = from.x - o.x;
  let bz = from.z - o.z;
  const blen = Math.hypot(bx, bz);
  if (blen < 1e-3) {
    bx = 0;
    bz = 1;
  } else {
    bx /= blen;
    bz /= blen;
  }
  const tries: readonly (readonly [number, number])[] = [
    [OBJECTIVE_BACK, OBJECTIVE_UP],
    [3, 2.2],
    [2.5, EYE_HEIGHT],
    [1.5, EYE_HEIGHT],
    [0, EYE_HEIGHT],
  ];
  const stand: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  for (const [back, up] of tries) {
    stand.x = o.x + bx * back;
    stand.y = o.y + up;
    stand.z = o.z + bz * back;
    if (!collision.overlapCapsule(stand.x, stand.y - EYE_RADIUS, stand.z, EYE_RADIUS, EYE_RADIUS * 2)) break;
  }
  lookAt(stand, o.x, o.y + 0.5, o.z);
  if (Math.hypot(stand.x - o.x, stand.z - o.z) < 1e-3) {
    // Standing on the objective itself: look along the arrival rather than at the feet.
    stand.yaw = yawOf(-bx, -bz);
    stand.pitch = APPROACH_PITCH;
  }
  return stand;
}

/** Drop waypoints from the front until the polyline is at most `maxMetres` long. */
function trimFront(points: Vec3Lit[], maxMetres: number): { points: Vec3Lit[]; trimmed: number } {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y, points[i]!.z - points[i - 1]!.z);
  }
  let trimmed = 0;
  const out = points.slice();
  while (out.length > 2 && total - trimmed > maxMetres) {
    const a = out[0]!;
    const b = out[1]!;
    const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (total - trimmed - step < maxMetres * 0.85) {
      // Cut the first span part-way instead of dropping it whole: the route should end up
      // *at* the limit, not well under it.
      const over = total - trimmed - maxMetres;
      const f = Math.min(1, over / Math.max(step, 1e-6));
      out[0] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
      trimmed += over;
      break;
    }
    out.shift();
    trimmed += step;
  }
  return { points: out, trimmed };
}

// -- the plan -------------------------------------------------------------------

export function planIntro(input: IntroInput): IntroPlan {
  const { def, nav, collision, movement, modeId, spawn, fovDeg, freezeSeconds } = input;
  const finder = new Pathfinder(nav, movement.stepHeight, movement.groundSnapDist);
  const segments: IntroSegment[] = [];
  const waypoints: Vec3Lit[][] = [];
  const budget = Math.max(0, freezeSeconds - RETURN_SECONDS - OWN_VIEW_SECONDS);

  // The centre: the nav bounds' middle, on the nearest walkable cell.
  const b = def.navBounds;
  const centreGuess: Vec3Lit = { x: (b.min.x + b.max.x) / 2, y: spawn.y, z: (b.min.z + b.max.z) / 2 };
  const centreCell = nav.nearestCell(centreGuess.x, centreGuess.y, centreGuess.z, 24);
  const centre: Vec3Lit =
    centreCell >= 0
      ? { x: nav.centerX(nav.indexOfX(centreCell)), y: nav.heightAt(centreCell), z: nav.centerZ(nav.indexOfZ(centreCell)) }
      : centreGuess;

  // ---- 1. the approach --------------------------------------------------------------
  /**
   * Where the player actually stands: the spawn, de-penetrated with the player's own capsule
   * the way the movement system does it on the first tick. `npm run intro` found two spawn
   * zones authored against a crate — Foundry B (−27, 2) and Depot B (−28, −19), the eye half
   * a metre inside it — and a camera that starts where the *sim* puts the body is right on
   * every map, including those two until their zones are moved.
   */
  const stood = makeMoveOutput();
  collision.resolveAt(spawn.x, spawn.y, spawn.z, movement.capsuleRadius, movement.standHeight, stood);
  const start: Vec3Lit = { x: stood.x, y: stood.y, z: stood.z };
  const approachRoute = route(nav, finder, start, centre) ?? [
    { x: start.x, y: start.y, z: start.z },
    { x: centre.x, y: centre.y, z: centre.z },
  ];
  // Average speed is two thirds of the peak under a smoothstep profile.
  const approachMaxMetres = APPROACH_MAX_SECONDS * (APPROACH_PEAK_SPEED / 1.5);
  const trimmedRoute = trimFront(approachRoute, approachMaxMetres);
  const approachPoints = raised(trimmedRoute.points, EYE_HEIGHT);
  const approach = new Spline(approachPoints);
  let nudged = approach.relax(collision, EYE_RADIUS);
  const approachSeconds = Math.min(
    APPROACH_MAX_SECONDS,
    Math.max(APPROACH_MIN_SECONDS, approach.length / (APPROACH_PEAK_SPEED / 1.5)),
  );
  const approachEnd: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  approach.at(approach.length, approachEnd);
  approachEnd.yaw = approach.yawAt(approach.length);
  approachEnd.pitch = APPROACH_PITCH;
  waypoints.push(approachPoints);
  segments.push({
    kind: 'approach',
    seconds: approachSeconds,
    label: '',
    metres: approach.length,
    at(u, out) {
      const s = approach.length * ease(u);
      approach.at(s, out);
      // The heading lags the position by a fraction of a second, so a turn is seen coming.
      const lagS = approach.length * ease(Math.max(0, u - YAW_LAG_SECONDS / approachSeconds));
      out.yaw = approach.yawAt(lagS);
      out.pitch = APPROACH_PITCH;
    },
  });

  // ---- 2. the overview ----------------------------------------------------------------
  // Azimuth toward the spawn, so the player's own side is at the bottom of the frame.
  let ax = spawn.x - centre.x;
  let az = spawn.z - centre.z;
  const alen = Math.hypot(ax, az);
  if (alen < 1e-3) {
    ax = -simSin(approachEnd.yaw);
    az = -simCos(approachEnd.yaw);
    // Back along the approach: the direction it came from.
    ax = -ax;
    az = -az;
  } else {
    ax /= alen;
    az /= alen;
  }
  const halfDiagonal = Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
  const halfFov = ((fovDeg / 2) * Math.PI) / 180;
  const tanHalf = simSin(halfFov) / simCos(halfFov);
  const wanted = (halfDiagonal / Math.max(tanHalf, 1e-3)) * 1.05;
  /**
   * The ray the overview pulls back along: the spawn's azimuth at 45° when it is clear, else
   * the clearest of a fan of candidates — the same elevation around the compass first, then
   * lower — because a hall with a bridge over its centre (Foundry) has no 45° ray toward the
   * spawn that does not meet the deck within three metres. Marched with the eye's own sphere,
   * not a line ray: the first version's line passed the edge of that deck by a centimetre
   * and the eye did not.
   */
  const spawnAzimuth = Math.atan2(az, ax);
  let rx = 0;
  let ry = 0;
  let rz = 0;
  let distance = 0;
  for (const elevation of OVERVIEW_ELEVATIONS) {
    for (const turn of OVERVIEW_AZIMUTHS) {
      const azimuth = spawnAzimuth + turn;
      const cx = simCos(azimuth) * simCos(elevation);
      const cy = simSin(elevation);
      const cz = simSin(azimuth) * simCos(elevation);
      const clear = clearDistance(collision, approachEnd, cx, cy, cz, wanted + OVERVIEW_CLEARANCE, EYE_RADIUS);
      const usable = Math.max(0, Math.min(wanted, clear - OVERVIEW_CLEARANCE));
      if (usable > distance) {
        distance = usable;
        rx = cx;
        ry = cy;
        rz = cz;
      }
      // The spawn's own ray at the highest elevation wins outright when it reaches most of the
      // way: the player's side at the bottom of the frame is worth more than a few metres.
      if (turn === 0 && usable >= wanted * 0.8) break;
    }
    if (distance >= wanted * 0.8) break;
  }
  const overview: IntroPose = {
    x: approachEnd.x + rx * distance,
    y: approachEnd.y + ry * distance,
    z: approachEnd.z + rz * distance,
    yaw: 0,
    pitch: 0,
  };
  // The look target: a little past the centre along the approach's heading, so the pull-back
  // starts on the view the approach ended with rather than at the camera's own feet.
  const fx = -simSin(approachEnd.yaw);
  const fz = -simCos(approachEnd.yaw);
  const target: Vec3Lit = { x: centre.x + fx * 8, y: centre.y, z: centre.z + fz * 8 };
  lookAt(overview, target.x, target.y, target.z);
  const pullbackFrom: IntroPose = { ...approachEnd };
  lookAt(pullbackFrom, target.x, target.y, target.z);
  const pullbackYawDelta = angleDelta(approachEnd.yaw, pullbackFrom.yaw);
  waypoints.push([]);
  segments.push({
    kind: 'pullback',
    seconds: PULLBACK_SECONDS,
    label: '',
    metres: distance,
    at(u, out) {
      const e = ease(u);
      out.x = approachEnd.x + (overview.x - approachEnd.x) * e;
      out.y = approachEnd.y + (overview.y - approachEnd.y) * e;
      out.z = approachEnd.z + (overview.z - approachEnd.z) * e;
      lookAt(out, target.x, target.y, target.z);
      // Ease the heading in from the approach's rather than snapping to the target's.
      if (u < 0.25) out.yaw = approachEnd.yaw + pullbackYawDelta * ease(u / 0.25);
      if (u < 0.25) out.pitch = APPROACH_PITCH + (out.pitch - APPROACH_PITCH) * ease(u / 0.25);
    },
  });

  // ---- 3. the objectives, or the hold ----------------------------------------------------
  /**
   * From the overview, the camera **pulls back in** to the centre — the pull-back reversed,
   * which is clear because the pull-back was — and then whips from objective to objective
   * along the nav routes at eye height. The first version snapped straight from the overview
   * down onto the first objective and `npm run intro` put it through a catwalk on Foundry:
   * a straight line from sixty metres up to three metres over a flag crosses whatever is
   * over the flag, and the whole point of the route is that a route does not.
   */
  const objectives = objectivesFor(def, modeId);
  const visited: string[] = [];
  const arcs: string[] = [];
  let used = approachSeconds + PULLBACK_SECONDS;
  let objectiveSecondsUsed = 0;
  if (objectives.length > 0) {
    const centreEye: IntroPose = { ...approachEnd };
    const pullIn: IntroSegment = {
      kind: 'snap',
      seconds: SNAP_SECONDS,
      label: '',
      metres: distance,
      at(u, out) {
        const e = ease(u);
        out.x = overview.x + (approachEnd.x - overview.x) * e;
        out.y = overview.y + (approachEnd.y - overview.y) * e;
        out.z = overview.z + (approachEnd.z - overview.z) * e;
        lookAt(out, target.x, target.y, target.z);
        // Level out over the last quarter, onto the approach's own pitch and heading.
        if (u > 0.75) {
          const f = ease((u - 0.75) / 0.25);
          out.yaw = out.yaw + angleDelta(out.yaw, approachEnd.yaw) * f;
          out.pitch = out.pitch + (APPROACH_PITCH - out.pitch) * f;
        }
      },
    };
    if (used + pullIn.seconds <= budget) {
      segments.push(pullIn);
      waypoints.push([]);
      used += pullIn.seconds;
      let objectiveSeconds = pullIn.seconds;
      let previous: IntroPose = centreEye;
      let previousGround: Vec3Lit = centre;
      for (const objective of objectives) {
        const o = objective.position;
        const stand = standOff(collision, o, previous);
        const found = route(nav, finder, previousGround, o);
        let points: Vec3Lit[];
        if (found !== null && found.length >= 2) {
          // The route begins over the previous objective; the camera is at its stand-off,
          // a few metres back and up. Dive to the objective first, then follow the route —
          // a straight cut from the stand-off to the route's second waypoint went through
          // the corner of the building the route turns around.
          points = raised(found, EYE_HEIGHT);
          points.unshift({ x: previous.x, y: previous.y, z: previous.z });
        } else {
          arcs.push(objective.id);
          const apexY = Math.max(previous.y, stand.y) + 8;
          points = [
            { x: previous.x, y: previous.y, z: previous.z },
            { x: (previous.x + stand.x) / 2, y: apexY, z: (previous.z + stand.z) / 2 },
          ];
        }
        points.push({ x: stand.x, y: stand.y, z: stand.z });
        const spline = new Spline(points);
        nudged += spline.relax(collision, EYE_RADIUS);
        const seconds = Math.min(WHIP_MAX_SECONDS, Math.max(0.5, spline.length / (WHIP_PEAK_SPEED / 1.5)));
        const fromYaw = previous.yaw;
        const fromPitch = previous.pitch;
        const travel: IntroSegment = {
          kind: 'whip',
          seconds,
          label: objective.label,
          metres: spline.length,
          at(u, out) {
            const sAlong = spline.length * ease(u);
            spline.at(sAlong, out);
            // The heading: from the last hold's into the route's over the first 15 %, along
            // the route through the middle, onto the objective's over the last 30 %.
            const along = spline.yawAt(sAlong);
            const enter = u < 0.15 ? ease(u / 0.15) : 1;
            const leave = u > 0.7 ? ease((u - 0.7) / 0.3) : 0;
            const yawAlong = fromYaw + angleDelta(fromYaw, along) * enter;
            out.yaw = yawAlong + angleDelta(yawAlong, stand.yaw) * leave;
            const pitchAlong = fromPitch + (APPROACH_PITCH - fromPitch) * enter;
            out.pitch = pitchAlong + (stand.pitch - pitchAlong) * leave;
          },
        };
        const hold: IntroSegment = {
          kind: 'hold',
          seconds: OBJECTIVE_HOLD_SECONDS,
          label: objective.label,
          metres: 0,
          at(_u, out) {
            out.x = stand.x;
            out.y = stand.y;
            out.z = stand.z;
            out.yaw = stand.yaw;
            out.pitch = stand.pitch;
          },
        };
        const cost = travel.seconds + hold.seconds;
        // The phase has a budget; an objective that would overrun it is left out and the
        // earlier ones kept. Two sites always fit; three flags on a wide map may not.
        if (objectiveSeconds + cost > OBJECTIVES_MAX_SECONDS || used + cost > budget) break;
        objectiveSeconds += cost;
        used += cost;
        segments.push(travel, hold);
        waypoints.push(points, []);
        visited.push(objective.id);
        previous = stand;
        previousGround = o;
      }
      objectiveSecondsUsed = objectiveSeconds;
    }
  }
  if (used < budget) {
    // Whatever is left is a hold on the last pose: the overview for the deathmatch modes,
    // the last objective for the others. A hold under 0.2 s is not worth a segment.
    const last = segments[segments.length - 1]!;
    const remainder = budget - used;
    if (remainder >= 0.2) {
      const pose: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
      last.at(1, pose);
      waypoints.push([]);
      segments.push({
        kind: 'hold',
        seconds: remainder,
        label: last.label,
        metres: 0,
        at(_u, out) {
          out.x = pose.x;
          out.y = pose.y;
          out.z = pose.z;
          out.yaw = pose.yaw;
          out.pitch = pose.pitch;
        },
      });
      used += remainder;
    }
  }

  const total = segments.reduce((sum, s) => sum + s.seconds, 0);
  return {
    segments,
    seconds: total,
    approachMetres: approach.length,
    trimmedMetres: trimmedRoute.trimmed,
    objectives: visited,
    arcs,
    overviewDistance: distance,
    objectiveSeconds: objectiveSecondsUsed,
    nudged,
    waypoints,
    poseAt(t, out) {
      let cursor = t;
      for (const segment of segments) {
        if (cursor <= segment.seconds || segment === segments[segments.length - 1]) {
          segment.at(segment.seconds > 0 ? Math.min(1, Math.max(0, cursor / segment.seconds)) : 1, out);
          return;
        }
        cursor -= segment.seconds;
      }
    },
  };
}

/** The objectives a mode's intro visits, in order; empty for the deathmatch modes. */
export function objectivesFor(def: MapDef, modeId: GameModeId): ObjectiveDef[] {
  const kind = modeId === 'DOM' ? 'flag' : modeId === 'SND' ? 'bombsite' : null;
  if (kind === null) return [];
  return def.objectives
    .filter((o) => o.kind === kind)
    .slice()
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

// -- the harness's half ------------------------------------------------------------

export interface IntroSample extends IntroPose {
  readonly t: number;
  readonly segment: IntroSegmentKind;
}

/**
 * The whole path, sampled at most `stepMetres` apart (and at least every 1/64 of a segment,
 * so a hold is still visited). What `npm run intro` tests against the colliders.
 */
export function sampleIntro(plan: IntroPlan, stepMetres: number): IntroSample[] {
  const out: IntroSample[] = [];
  const pose: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  let t0 = 0;
  for (const segment of plan.segments) {
    const steps = Math.max(64, Math.ceil((segment.metres * 1.5) / Math.max(stepMetres, 0.01)));
    for (let i = 0; i <= steps; i++) {
      segment.at(i / steps, pose);
      out.push({ ...pose, t: t0 + (segment.seconds * i) / steps, segment: segment.kind });
    }
    t0 += segment.seconds;
  }
  return out;
}

/** Samples whose camera point sits inside a collider: a sphere of `radius` at the eye. */
export function collidingSamples(plan: IntroPlan, collision: CollisionWorld, stepMetres: number, radius: number): IntroSample[] {
  const bad: IntroSample[] = [];
  for (const s of sampleIntro(plan, stepMetres)) {
    // `overlapCapsule` takes the feet; a capsule of height 2r on feet y - r is a sphere at y.
    if (collision.overlapCapsule(s.x, s.y - radius, s.z, radius, radius * 2)) bad.push(s);
  }
  return bad;
}
