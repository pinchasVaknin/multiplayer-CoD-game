import { Btn, type MutableInputCommand } from '../../shared/core/InputCommand';
import type { Loop } from '../engine/FrameLoop';
import type { MovementConfig } from '../../shared/player/MovementConfig';
import type { PlayerController } from '../../shared/player/PlayerController';
import type { CollisionWorld } from '../../shared/world/CollisionWorld';
import { makeRayHit } from '../../shared/world/Geometry';
import type { LoadedMap } from '../world/MapRender';

/**
 * "Sprint every wall on both maps" (brief S8, criterion 2) — as a harness rather than a
 * hand-authored list.
 *
 * ## Why this is generated and M4's was not
 *
 * M4 answered the same criterion for Foundry with thirty run lines typed out in
 * `public/verify/tdm.js`, each one an `x0,z0,x1,z1` sitting exactly `capsuleRadius + 0.01`
 * from the face it follows. That worked, and it does not scale: two more maps is another
 * seventy lines of arithmetic, and — the part that actually matters — **a hand-authored
 * list can only find snags on walls somebody remembered to list.** The container that got
 * moved during tuning is precisely the one nobody adds a run for.
 *
 * So the runs are derived from the collision world itself. Every solid collider that is
 * tall enough to block a player and long enough to run along contributes one pass per
 * vertical face, offset by the capsule radius, driven in both directions. A wall that
 * exists is a wall that gets swept, and a wall that moves moves its own run line with it.
 *
 * ## What counts as a snag
 *
 * **Failure to make progress, not merely being blocked.** M4 established this and it is the
 * whole reason its first run reported fourteen false findings: sliding along a wall is
 * *supposed* to be slower than open ground, and arriving at a concave corner is supposed to
 * stop you. A pass snags when it moves less than `PROGRESS_MIN_M` over `PROGRESS_WINDOW`
 * ticks while still having somewhere to go — which is a player pressed into geometry with
 * the stick held and nothing happening, i.e. the thing that actually feels bad.
 *
 * Two other failures are reported alongside it because they are worse and cheaper to check:
 * a tick where the capsule is **inside** geometry (asked of the same `overlapCapsule` the
 * navmesh bake uses), and a pass that ends more than a metre from where it was aimed.
 *
 * ## What it does not do
 *
 * It drives the real `PlayerController` one tick at a time with the loop stopped, so
 * nothing else moves the player and no bot shoots them half way along a wall. It is
 * therefore a *movement* test and not a gameplay one, which is the correct scope: the
 * question is whether the geometry catches, not whether the match is fair.
 */

/** Ignore colliders shorter than this: kerbs and trim are not walls. */
const MIN_WALL_HEIGHT = 0.9;
/** Ignore faces shorter than this: there is nothing to run along. */
const MIN_FACE_LENGTH = 1.6;
/** Faces longer than this are split, so one pass never runs the whole perimeter. */
const MAX_FACE_LENGTH = 26;
/** Ticks over which "no progress" is judged. */
const PROGRESS_WINDOW = 20;
/** Metres of progress that window must show. */
const PROGRESS_MIN_M = 0.15;
/**
 * How far off its own line a pass may drift before it stops being a wall hug.
 *
 * Each face is run in both directions and the movement is straight along the line, so a
 * pass that has wandered a metre away is no longer testing the wall it was aimed at and
 * anything it finds belongs to some other piece of geometry.
 */
const OFF_LINE_M = 1.1;
/** Metres from the intended end within which a pass counts as having arrived. */
const ARRIVE_M = 1.5;
/**
 * How far ahead to probe when a pass has stopped making progress.
 *
 * This is the discriminator between the two things "no progress" can mean. **Something
 * directly in front of you is a dead end, not a snag** — a wall run that meets a
 * perpendicular wall, a container parked against the perimeter, the inside of a corner.
 * Those are ordinary map geometry and the player simply walks around them. A snag is being
 * stopped with *open space ahead*: caught on a lip, wedged in a slot, held by an edge that
 * should have let go. Only the second is a bug, and without this probe the sweep reports
 * thirty of the first for every one of the second.
 */
const AHEAD_PROBE_M = 0.75;

export interface SnagFinding {
  /** Face midpoint, so a finding can be walked to. */
  x: number;
  y: number;
  z: number;
  /** Which collider and face, for the author. */
  collider: number;
  face: string;
  /** Ticks with no progress while still short of the end. */
  snagTicks: number;
  /** Ticks with the capsule inside geometry. Any value above zero is a hard bug. */
  intersectingTicks: number;
  /** Metres short of the intended end. */
  shortBy: number;
}

export interface SnagReport {
  map: string;
  /** Colliders that qualified as walls. */
  walls: number;
  /** Passes driven. Two per qualifying face. */
  passes: number;
  /** Simulated ticks spent driving. */
  ticks: number;
  /** Passes that reached their end within `ARRIVE_M`. */
  arrived: number;
  /** Passes abandoned because they drifted off their own line. Not a fault. */
  offLine: number;
  /**
   * Passes that stopped with geometry directly ahead. Not a fault either — see
   * `AHEAD_PROBE_M`. Reported so a sweep that found nothing cannot be a sweep that ran
   * nothing.
   */
  deadEnds: number;
  intersectingTicks: number;
  findings: SnagFinding[];
  wallSeconds: number;
}

interface Run {
  collider: number;
  face: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
}

/** Reused across every pass; the harness allocates nothing per tick. */
const cmd: MutableInputCommand = {
  seq: 0,
  tickIndex: 0,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  sampledAtMs: 0,
};

export interface SnagHarnessDeps {
  readonly map: LoadedMap;
  readonly player: PlayerController;
  readonly movement: MovementConfig;
  readonly loop: Loop;
}

export class SnagHarness {
  private readonly deps: SnagHarnessDeps;
  private last: SnagReport | null = null;

  constructor(deps: SnagHarnessDeps) {
    this.deps = deps;
  }

  get lastReport(): SnagReport | null {
    return this.last;
  }

  /**
   * Sweep the whole map. Returns the report and logs a summary.
   *
   * Synchronous and slow — a few hundred passes of a few hundred ticks each. It stops the
   * loop for the duration and restores it, so calling this mid-match costs a visible hitch
   * and nothing else.
   */
  run(): SnagReport {
    const { map, player, loop } = this.deps;
    const wasRunning = loop.isRunning;
    loop.stop();

    const runs = this.buildRuns();
    const report: SnagReport = {
      map: map.def.id,
      walls: countWalls(runs),
      passes: 0,
      ticks: 0,
      arrived: 0,
      offLine: 0,
      deadEnds: 0,
      intersectingTicks: 0,
      findings: [],
      wallSeconds: 0,
    };

    const started = performance.now();
    // Spawn state is restored at the end so a sweep run from a live match does not leave
    // the player standing in a wall somewhere.
    const restore = {
      x: player.sim.x,
      y: player.sim.y,
      z: player.sim.z,
      yaw: player.sim.yaw,
    };

    for (const run of runs) {
      this.onePass(run, false, report);
      this.onePass(run, true, report);
    }

    player.spawn(restore.x, restore.y, restore.z, restore.yaw);
    report.wallSeconds = (performance.now() - started) / 1000;
    this.last = report;
    if (wasRunning) loop.start();

    const hard = report.findings.filter((f) => f.intersectingTicks > 0).length;
    console.info(
      `[SnagHarness] ${report.map}: ${report.walls} walls, ${report.passes} passes, ` +
        `${report.arrived} arrived, ${report.deadEnds} dead ends, ` +
        `${report.findings.length} findings (${hard} with the capsule inside geometry), ` +
        `${report.intersectingTicks} intersecting ticks, ${report.wallSeconds.toFixed(1)} s.`,
    );
    if (report.findings.length > 0) console.table(report.findings);
    return report;
  }

  // -- run generation --------------------------------------------------------

  /**
   * One run per vertical face of every wall-like collider.
   *
   * **World-axis-aligned boxes only**, which is not the same thing as `isAxisAligned`: that
   * flag is false for any non-zero rotation, and a container yawed by exactly a quarter turn
   * has world-axis faces just as much as an unrotated one does. Asking the flag skipped every
   * rotated container and left Foundry with thirteen "walls" out of a hundred colliders. The
   * test used instead is whether the box fills its own world AABB — true for any multiple of
   * a quarter turn, false for a ramp or an angled barricade, which is exactly the line
   * wanted. Pitched geometry is covered by the lane timings instead: a ramp the player
   * cannot climb shows up there as an unreachable lane.
   *
   * A run is then dropped unless there is **ground under both of its ends**. Without that,
   * every perimeter wall contributes a pass along its *outside* face, over the void beyond
   * the map, which cannot make progress and reports as a snag — twenty-four of Foundry's
   * first twenty-four findings were exactly that.
   */
  private buildRuns(): Run[] {
    const collision = this.deps.map.collision;
    const colliders = collision.colliders;
    const inset = this.deps.movement.capsuleRadius + 0.01;
    const out: Run[] = [];
    const candidates: Run[] = [];

    for (let i = 0; i < colliders.count; i++) {
      const hy = colliders.halfY(i);
      const cy = colliders.centerY(i);
      const top = cy + hy;
      const bottom = cy - hy;
      // A wall you can see over is not a wall you can snag on, and a surface you stand on
      // is a floor. Both are excluded by asking for a face that rises out of the ground.
      if (top - Math.max(bottom, 0) < MIN_WALL_HEIGHT) continue;
      if (bottom > 1.6) continue;

      // Half extents of the world AABB. For a quarter-turned box these are the box's own
      // half extents with x and z swapped, which is what makes the faces still lines.
      const ex = (colliders.aabbAt(i, 3) - colliders.aabbAt(i, 0)) * 0.5;
      const ez = (colliders.aabbAt(i, 5) - colliders.aabbAt(i, 2)) * 0.5;
      const ey = (colliders.aabbAt(i, 4) - colliders.aabbAt(i, 1)) * 0.5;
      const boxVolume = colliders.halfX(i) * colliders.halfY(i) * colliders.halfZ(i);
      if (ex * ey * ez > boxVolume * 1.05) continue;

      const cx = colliders.centerX(i);
      const cz = colliders.centerZ(i);
      // Stand on the ground beside the wall, not on top of whatever it is sitting on.
      const y = Math.max(0.05, bottom + 0.05);

      if (ez * 2 >= MIN_FACE_LENGTH) {
        for (const s of [-1, 1]) {
          pushSplit(candidates, i, s < 0 ? 'x-' : 'x+', cx + s * (ex + inset), cz - ez, cx + s * (ex + inset), cz + ez, y);
        }
      }
      if (ex * 2 >= MIN_FACE_LENGTH) {
        for (const s of [-1, 1]) {
          pushSplit(candidates, i, s < 0 ? 'z-' : 'z+', cx - ex, cz + s * (ez + inset), cx + ex, cz + s * (ez + inset), y);
        }
      }
    }

    for (const run of candidates) {
      if (!groundUnder(collision, run.x0, run.y, run.z0)) continue;
      if (!groundUnder(collision, run.x1, run.y, run.z1)) continue;
      out.push(run);
    }
    return out;
  }

  // -- one pass --------------------------------------------------------------

  private onePass(run: Run, reversed: boolean, report: SnagReport): void {
    const { player, movement, map } = this.deps;
    const x0 = reversed ? run.x1 : run.x0;
    const z0 = reversed ? run.z1 : run.z0;
    const x1 = reversed ? run.x0 : run.x1;
    const z1 = reversed ? run.z0 : run.z1;

    const distance = Math.hypot(x1 - x0, z1 - z0);
    if (distance < MIN_FACE_LENGTH) return;
    const ux = (x1 - x0) / distance;
    const uz = (z1 - z0) / distance;
    const yaw = Math.atan2(-ux, -uz);

    // Refuse to start inside geometry. A start point buried in a neighbouring collider is
    // an authoring accident of the *generator*, not a snag, and reporting it as one is how
    // a sweep ends up with more noise than findings.
    if (map.collision.overlapCapsule(x0, run.y, z0, movement.capsuleRadius, movement.standHeight)) {
      return;
    }

    player.spawn(x0, run.y, z0, yaw);
    report.passes++;

    cmd.moveX = 0;
    cmd.moveZ = 1;
    cmd.yaw = yaw;
    cmd.pitch = 0;
    cmd.buttons = Btn.Sprint;

    const maxTicks = Math.ceil((distance / 2.5) * 60) + 40;
    const history = new Float64Array(maxTicks + 1);
    let snagTicks = 0;
    let intersecting = 0;
    let arrived = false;
    let offLine = false;
    let used = 0;

    for (let t = 0; t < maxTicks; t++) {
      cmd.seq++;
      cmd.tickIndex = t;
      player.step(cmd);
      used = t + 1;
      report.ticks++;

      const sim = player.sim;
      const dx = sim.x - x0;
      const dz = sim.z - z0;
      const along = dx * ux + dz * uz;
      const across = Math.abs(dx * -uz + dz * ux);
      history[t] = along;

      if (map.collision.overlapCapsule(sim.x, sim.y, sim.z, movement.capsuleRadius, movement.standHeight)) {
        intersecting++;
      }
      if (across > OFF_LINE_M) {
        offLine = true;
        break;
      }
      if (along >= distance - ARRIVE_M) {
        arrived = true;
        break;
      }
      if (t >= PROGRESS_WINDOW) {
        const then = history[t - PROGRESS_WINDOW] ?? 0;
        if (along - then < PROGRESS_MIN_M) snagTicks++;
      }
    }

    report.intersectingTicks += intersecting;
    if (arrived) report.arrived++;
    if (offLine) {
      report.offLine++;
      // A pass that left its own line found something, but not necessarily on this wall.
      // Reported only if it was also inside geometry, which is unambiguous.
      if (intersecting === 0) return;
    }

    const shortBy = Math.max(0, distance - (history[used - 1] ?? 0));
    if (snagTicks === 0 && intersecting === 0) return;

    // Stopped with a wall in front: a dead end, not a snag. Probed at chest height along
    // the run direction, from where the player actually ended up.
    if (intersecting === 0) {
      const sim = player.sim;
      const blocked = map.collision.raycast(
        sim.x,
        sim.y + 0.9,
        sim.z,
        ux,
        0,
        uz,
        this.deps.movement.capsuleRadius + AHEAD_PROBE_M,
        aheadHit,
      );
      if (blocked) {
        report.deadEnds++;
        return;
      }
    }

    report.findings.push({
      x: Number(((x0 + x1) / 2).toFixed(2)),
      y: Number(run.y.toFixed(2)),
      z: Number(((z0 + z1) / 2).toFixed(2)),
      collider: run.collider,
      face: `${run.face}${reversed ? ' (rev)' : ''}`,
      snagTicks,
      intersectingTicks: intersecting,
      shortBy: Number(shortBy.toFixed(2)),
    });
  }
}

/**
 * Is there floor within 2.5 m below this point?
 *
 * Uses the gameplay raycaster against the same 4 m hash the broadphase uses, which is the
 * only ground truth available — asking `navBounds` instead would have accepted every point
 * outside a perimeter wall, because the bounds are deliberately larger than the floor.
 */
function groundUnder(collision: CollisionWorld, x: number, y: number, z: number): boolean {
  return collision.raycast(x, y + 0.6, z, 0, -1, 0, 2.5, groundHit);
}

const groundHit = makeRayHit();
const aheadHit = makeRayHit();

/** Split a long face so one pass never runs the entire perimeter of a map. */
function pushSplit(
  out: Run[],
  collider: number,
  face: string,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
): void {
  const length = Math.hypot(x1 - x0, z1 - z0);
  if (length < MIN_FACE_LENGTH) return;
  const parts = Math.max(1, Math.ceil(length / MAX_FACE_LENGTH));
  for (let p = 0; p < parts; p++) {
    const a = p / parts;
    const b = (p + 1) / parts;
    out.push({
      collider,
      face: parts === 1 ? face : `${face}[${p + 1}/${parts}]`,
      x0: x0 + (x1 - x0) * a,
      z0: z0 + (z1 - z0) * a,
      x1: x0 + (x1 - x0) * b,
      z1: z0 + (z1 - z0) * b,
      y,
    });
  }
}

function countWalls(runs: readonly Run[]): number {
  const seen = new Set<number>();
  for (const r of runs) seen.add(r.collider);
  return seen.size;
}
