import { Btn, type MutableInputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { clamp, DEG2RAD } from '../core/MathUtil';
import type { NavGrid } from '../world/Navmesh';
import type { Bot } from './Bot';
import { isFiringState, isLegalBotTransition, isTravellingState, type BotState } from './BotStates';
import type { CoverIndex } from './Cover';
import type { Perception } from './Perception';
import type { Pathfinder } from './Pathing';

/**
 * The bot's decision layer (brief S6.2).
 *
 * `decide` picks the state, four times a second. `steer` turns whatever state that is
 * into one `InputCommand`, sixty times a second. Nothing else in the project produces bot
 * movement, and the command it writes is the same immutable record the player's input
 * sampler produces — which is what makes S6.1's symmetry structural rather than a claim:
 * a bot is a command source, so `PlayerController` cannot tell the difference and neither
 * can the netcode boundary.
 *
 * The split is deliberate and it is what S6.6 asks for. Deciding *what* to do is the
 * expensive part (cover scoring, path requests, target selection) and it runs at 4 Hz;
 * carrying it out is cheap and runs every tick, so a bot never stutters between decisions.
 *
 * Two things here exist purely so bots do not look broken, and both earn their place:
 * **stuck detection**, because a path that ends up against geometry has to be abandoned
 * rather than leaned into, and **strafe validation** against the navmesh, because a bot
 * that strafes off the pit lip is a bot the player stops taking seriously.
 */

export interface BrainDeps {
  readonly nav: NavGrid;
  readonly pathfinder: Pathfinder;
  readonly cover: CoverIndex;
  readonly perception: Perception;
  /** Sampled walkable cells used as patrol destinations. */
  readonly patrolCells: Int32Array;
}

type GoalKind = 'NONE' | 'PATROL' | 'INVESTIGATE' | 'COVER' | 'FLANK' | 'PUSH';

/** Distance at which a waypoint counts as reached, metres. */
const WAYPOINT_RADIUS = 0.55;
const GOAL_RADIUS = 1.0;

/** Magazine at or below which a bot goes looking for a quiet moment to reload. */
const LOW_MAGAZINE = 8;

/** Stuck detector: less than this much progress over this long means replan. */
const STUCK_DISTANCE = 0.22;
const STUCK_WINDOW = 0.55;

/** Teammates closer than this get pushed apart, metres. */
const SEPARATION_RADIUS = 1.15;

/** How far ahead a strafe direction is validated against the navmesh, metres. */
const STRAFE_PROBE = 0.8;

export class BotBrain {
  state: BotState = 'IDLE';
  /** Seconds in the current state. */
  stateTime = 0;
  goal: GoalKind = 'NONE';
  goalX = 0;
  goalY = 0;
  goalZ = 0;
  goalCell = -1;
  coverSlot = -1;

  /** Diagnostics (S7). */
  stuckEvents = 0;
  pathFailures = 0;
  replans = 0;

  private readonly deps: BrainDeps;
  private strafeSide = 1;
  private strafeTimer = 0;
  private strafing = false;
  private peekTimer = 0;
  private peeking = false;
  private lookSweep = 0;
  private stuckTimer = 0;
  private stuckMarkX = 0;
  private stuckMarkZ = 0;
  private patrolCursor = 0;
  private wantsReloadPress = false;
  private pressedReload = false;

  constructor(deps: BrainDeps) {
    this.deps = deps;
  }

  reset(): void {
    this.state = 'IDLE';
    this.stateTime = 0;
    this.goal = 'NONE';
    this.goalCell = -1;
    this.coverSlot = -1;
    this.strafing = false;
    this.strafeTimer = 0;
    this.peeking = false;
    this.peekTimer = 0;
    this.lookSweep = 0;
    this.stuckTimer = 0;
    this.wantsReloadPress = false;
    this.pressedReload = false;
  }

  // -- state machine ---------------------------------------------------------

  /**
   * Choose the state and the goal that goes with it. Called at ~4 Hz, staggered.
   *
   * Ordered by urgency: dying, then reloading, then what the blackboard believes. Every
   * change goes through `transition`, which is the only writer of `state`.
   */
  decide(bot: Bot): void {
    const bb = bot.blackboard;
    const tier = bot.tier;

    if (!bot.health.alive) {
      this.transition(bot, 'DEAD');
      return;
    }

    const hasTarget = bb.hasKnownTarget;
    const seeing = bb.hasLos;
    const hurt = bot.healthFraction < tier.coverHealthFraction;
    const dry = bot.magazine <= 0;
    const low = bot.magazine <= LOW_MAGAZINE && bot.reserve > 0;

    // A reload in progress owns the bot until it finishes.
    if (bot.reloading) {
      this.transition(bot, 'RELOAD');
      return;
    }

    // Out of ammo, or low with a moment to spare: get behind something and reload.
    if ((dry || (low && !seeing)) && bot.reserve > 0) {
      if (seeing && this.trySeekCover(bot)) return;
      this.wantsReloadPress = true;
      this.transition(bot, 'RELOAD');
      return;
    }

    if (hasTarget) {
      if (hurt && this.trySeekCover(bot)) return;

      if (seeing) {
        const range = bb.lastKnownRange;
        // Too far to shoot usefully: close the distance rather than plink.
        if (range > tier.engageRange * 0.85 && bot.rng.chance(tier.pushAggression)) {
          if (this.tryPush(bot)) return;
        }
        if (bot.rng.chance(tier.flankChance) && this.tryFlank(bot)) return;
        this.setGoalNone();
        this.transition(bot, 'ENGAGE');
        return;
      }

      // Believed but not seen. Shoot at the last known position for a beat, then move.
      if (bb.sinceLos < 1.4 && bb.confidence > 0.35) {
        this.setGoalNone();
        this.transition(bot, 'SUPPRESS');
        return;
      }
      if (bot.rng.chance(tier.flankChance) && this.tryFlank(bot)) return;
      if (this.tryPush(bot)) return;
    }

    if (bb.investigateValid) {
      const dist = Math.hypot(bb.investigateX - bot.px, bb.investigateZ - bot.pz);
      if (dist > GOAL_RADIUS) {
        this.setGoal('INVESTIGATE', bb.investigateX, bb.investigateY, bb.investigateZ);
        this.transition(bot, 'INVESTIGATE');
        return;
      }
      // Arrived and found nothing. That is the point of hearing being imprecise.
      bb.investigateValid = false;
    }

    this.pickPatrolGoal(bot);
    this.transition(bot, 'PATROL');
  }

  /** Ask for a path when the goal has moved, the path has run out, or the bot is stuck. */
  requestPath(bot: Bot): void {
    if (!bot.health.alive) return;
    const nav = this.deps.nav;

    if (this.goal === 'NONE') {
      if (bot.path.count > 0) bot.path.clear();
      return;
    }

    const goalCell = nav.nearestCell(this.goalX, this.goalY, this.goalZ);
    if (goalCell < 0) {
      this.goal = 'NONE';
      this.pathFailures++;
      return;
    }
    this.goalCell = goalCell;

    const needsPath = bot.path.count === 0 || bot.path.goalIndex !== goalCell || bot.path.complete;
    if (!needsPath) return;

    const startCell = nav.nearestCell(bot.px, bot.py, bot.pz);
    if (startCell < 0) {
      this.pathFailures++;
      return;
    }
    this.replans++;
    this.deps.pathfinder.request(bot, startCell, goalCell);
  }

  /**
   * Turn the current state into one command. Every tick.
   *
   * `cmd` is the bot's own reusable record; the fields written here are exactly the ones
   * `Input.sample` writes for the player, and nothing else is touched.
   */
  steer(bot: Bot, cmd: MutableInputCommand, roster: readonly Bot[]): void {
    this.stateTime += DT;
    const tier = bot.tier;
    const bb = bot.blackboard;
    const combat = bot.combat;

    cmd.moveX = 0;
    cmd.moveZ = 0;
    cmd.buttons = 0;

    if (this.state === 'DEAD') {
      cmd.yaw = combat.aimYaw;
      cmd.pitch = combat.aimPitch;
      return;
    }

    this.updateStuck(bot);

    // ---- where to look ---------------------------------------------------
    let wishX = 0;
    let wishZ = 0;
    const travelling = isTravellingState(this.state);
    const hasPath = bot.path.active;
    if (hasPath) {
      // `followPath` leaves the wish direction in the module scratch, zeroed if it ran out.
      this.followPath(bot);
      wishX = pathWishX;
      wishZ = pathWishZ;
    }

    if (isFiringState(this.state) && bb.hasKnownTarget) {
      combat.updateAim(tier, bb, bot.px, bot.py + bot.eyeHeight, bot.pz, bot.rng);
    } else if (this.state === 'SEEK_COVER' && !hasPath && bb.hasKnownTarget) {
      combat.updateAim(tier, bb, bot.px, bot.py + bot.eyeHeight, bot.pz, bot.rng);
    } else if (travelling && (wishX !== 0 || wishZ !== 0)) {
      // Look where you are going, plus a slow sweep so a patrolling bot scans.
      this.lookSweep += DT;
      const sweep = this.state === 'PATROL' ? Math.sin(this.lookSweep * 0.7) * 26 * DEG2RAD : 0;
      combat.lookToward(tier, Math.atan2(-wishX, -wishZ) + sweep, 0);
    } else if (bb.investigateValid) {
      const dx = bb.investigateX - bot.px;
      const dz = bb.investigateZ - bot.pz;
      combat.lookToward(tier, Math.atan2(-dx, -dz), 0);
    } else {
      this.lookSweep += DT;
      combat.lookToward(tier, combat.aimYaw + Math.sin(this.lookSweep * 0.5) * 0.4 * DT, 0);
    }

    cmd.yaw = combat.aimYaw;
    cmd.pitch = combat.aimPitch;

    // ---- combat movement --------------------------------------------------
    if (this.state === 'ENGAGE' || this.state === 'SUPPRESS') {
      this.updateStrafe(bot, tier.strafeBias, tier.strafePeriod);
      if (this.strafing) {
        const yaw = combat.aimYaw;
        const rx = Math.cos(yaw) * this.strafeSide;
        const rz = -Math.sin(yaw) * this.strafeSide;
        if (this.canStep(bot, rx, rz)) {
          wishX += rx;
          wishZ += rz;
        } else {
          this.strafeSide = -this.strafeSide;
        }
      }
    }

    // ---- cover behaviour --------------------------------------------------
    let crouch = false;
    if (this.state === 'SEEK_COVER' && !hasPath && this.coverSlot >= 0) {
      const slot = this.deps.cover.slots[this.coverSlot];
      if (slot !== undefined) {
        this.updatePeek(tier.peekRate, tier.peekDuration);
        if (this.peeking) {
          const px = this.deps.cover.peekOffsetX(this.coverSlot, this.strafeSide);
          const pz = this.deps.cover.peekOffsetZ(this.coverSlot, this.strafeSide);
          if (this.canStep(bot, px, pz)) {
            wishX += px;
            wishZ += pz;
          } else {
            this.strafeSide = -this.strafeSide;
          }
        } else {
          // Settle back onto the cover point and drop behind it.
          const dx = slot.x - bot.px;
          const dz = slot.z - bot.pz;
          const len = Math.hypot(dx, dz);
          if (len > 0.28) {
            wishX += dx / len;
            wishZ += dz / len;
          }
          crouch = slot.height === 'low';
        }
      }
    }
    if (this.state === 'RELOAD' && !bb.hasLos) crouch = true;

    // ---- separation -------------------------------------------------------
    for (const other of roster) {
      if (other === bot || !other.health.alive) continue;
      const dx = bot.px - other.px;
      const dz = bot.pz - other.pz;
      const d = Math.hypot(dx, dz);
      if (d >= SEPARATION_RADIUS || d < 1e-3) continue;
      const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
      wishX += (dx / d) * push * 0.9;
      wishZ += (dz / d) * push * 0.9;
    }

    // ---- world direction into a command ----------------------------------
    const len = Math.hypot(wishX, wishZ);
    if (len > 1e-4) {
      const inv = 1 / Math.max(len, 1);
      const nx = wishX * inv;
      const nz = wishZ * inv;
      const yaw = cmd.yaw;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      // Inverse of PlayerController's wish basis, so `moveX/moveZ` mean what they mean
      // for a human holding the same direction.
      cmd.moveZ = nx * fx + nz * fz;
      cmd.moveX = nx * rx + nz * rz;
    }

    // ---- buttons ----------------------------------------------------------
    let buttons = 0;
    if (crouch) buttons |= Btn.Crouch;

    // Sprint only where a human would: running somewhere, facing that way, not shooting.
    const sprintWorthy =
      travelling &&
      !isFiringState(this.state) &&
      cmd.moveZ > 0.72 &&
      bot.grounded &&
      !crouch &&
      bot.path.remainingDistance(bot.px, bot.pz) > 3.5;
    if (sprintWorthy) buttons |= Btn.Sprint;

    const distance = bb.hasKnownTarget ? bb.lastKnownRange : Infinity;
    const shooting = isFiringState(this.state) || (this.state === 'SEEK_COVER' && this.peeking);
    combat.updateTrigger(
      tier,
      bb,
      bot.rng,
      bot.magazine,
      bot.canFire,
      distance,
      shooting && bb.hasKnownTarget && (bb.hasLos || this.state === 'SUPPRESS'),
    );
    if (combat.wantsFire) buttons |= Btn.Fire;
    if (combat.wantsAds && !sprintWorthy) buttons |= Btn.Ads;

    // The reload press is an edge, so it is held for exactly one tick.
    if (this.wantsReloadPress && !bot.reloading && !this.pressedReload) {
      buttons |= Btn.Reload;
      this.pressedReload = true;
    } else if (bot.reloading || !this.wantsReloadPress) {
      this.wantsReloadPress = false;
      this.pressedReload = false;
    }

    cmd.buttons = buttons;
  }

  // -- goal selection --------------------------------------------------------

  private trySeekCover(bot: Bot): boolean {
    const bb = bot.blackboard;
    if (!bb.hasKnownTarget) return false;
    const slot = this.deps.cover.select(
      bot.entityId,
      bot.px,
      bot.py,
      bot.pz,
      bb.lastKnownX,
      bb.lastKnownY,
      bb.lastKnownZ,
      20,
      this.deps.perception,
    );
    if (slot < 0) return false;
    const point = this.deps.cover.slots[slot];
    if (point === undefined) return false;
    this.deps.cover.claim(slot, bot.entityId);
    this.coverSlot = slot;
    this.setGoal('COVER', point.x, point.y, point.z);
    this.transition(bot, 'SEEK_COVER');
    return true;
  }

  private tryPush(bot: Bot): boolean {
    const bb = bot.blackboard;
    if (!bb.hasKnownTarget) return false;
    const nav = this.deps.nav;
    const cell = nav.nearestCell(bb.lastKnownX, bb.lastKnownFeetY, bb.lastKnownZ);
    if (cell < 0) return false;
    this.setGoal('PUSH', nav.centerX(nav.indexOfX(cell)), nav.heightAt(cell), nav.centerZ(nav.indexOfZ(cell)));
    this.transition(bot, 'PUSH');
    return true;
  }

  /**
   * A wide route to the target's side.
   *
   * Sampled rather than solved: four bearings around the target at flanking range, first
   * one the navmesh accepts wins. A flank that takes 2 ms to compute is not a flank.
   */
  private tryFlank(bot: Bot): boolean {
    const bb = bot.blackboard;
    if (!bb.hasKnownTarget) return false;
    const nav = this.deps.nav;
    const toBotX = bot.px - bb.lastKnownX;
    const toBotZ = bot.pz - bb.lastKnownZ;
    const base = Math.atan2(toBotZ, toBotX);
    const radius = clamp(bb.lastKnownRange * 0.7, 5, 13);
    const side = bot.rng.chance(0.5) ? 1 : -1;

    for (const sweep of [70, 100, 45, 130]) {
      const angle = base + side * sweep * DEG2RAD;
      const x = bb.lastKnownX + Math.cos(angle) * radius;
      const z = bb.lastKnownZ + Math.sin(angle) * radius;
      const cell = nav.cellAt(x, z);
      if (cell < 0) continue;
      this.setGoal('FLANK', nav.centerX(nav.indexOfX(cell)), nav.heightAt(cell), nav.centerZ(nav.indexOfZ(cell)));
      this.transition(bot, 'FLANK');
      return true;
    }
    return false;
  }

  private pickPatrolGoal(bot: Bot): void {
    if (this.goal === 'PATROL' && bot.path.active) return;
    const cells = this.deps.patrolCells;
    if (cells.length === 0) return;
    const nav = this.deps.nav;

    // Walk the sampled list from a per-bot offset and take the first point that is a
    // reasonable distance away, so patrols cross the map instead of shuffling in place.
    for (let attempt = 0; attempt < 8; attempt++) {
      this.patrolCursor = (this.patrolCursor + 1 + bot.rng.int(0, 7)) % cells.length;
      const cell = cells[this.patrolCursor] ?? -1;
      if (cell < 0) continue;
      const x = nav.centerX(nav.indexOfX(cell));
      const z = nav.centerZ(nav.indexOfZ(cell));
      if (Math.hypot(x - bot.px, z - bot.pz) < 7) continue;
      this.setGoal('PATROL', x, nav.heightAt(cell), z);
      return;
    }
  }

  private setGoal(kind: GoalKind, x: number, y: number, z: number): void {
    this.goal = kind;
    this.goalX = x;
    this.goalY = y;
    this.goalZ = z;
  }

  private setGoalNone(): void {
    this.goal = 'NONE';
    this.goalCell = -1;
  }

  private transition(bot: Bot, next: BotState): void {
    if (this.state === next) return;
    if (!isLegalBotTransition(this.state, next)) return;
    if (this.state === 'SEEK_COVER' && next !== 'SEEK_COVER') {
      this.deps.cover.release(bot.entityId);
      this.coverSlot = -1;
      this.peeking = false;
    }
    if (next === 'ENGAGE' && !isFiringState(this.state)) {
      bot.combat.onContact(bot.tier, bot.rng);
    }
    bot.noteStateChange(this.state, next);
    this.state = next;
    this.stateTime = 0;
  }

  // -- steering helpers ------------------------------------------------------

  /** Advance the path cursor and write the wish direction. False when the path is done. */
  private followPath(bot: Bot): boolean {
    const path = bot.path;
    while (path.cursor < path.count) {
      const wx = path.x[path.cursor] ?? bot.px;
      const wz = path.z[path.cursor] ?? bot.pz;
      const dx = wx - bot.px;
      const dz = wz - bot.pz;
      const dist = Math.hypot(dx, dz);
      const last = path.cursor === path.count - 1;
      if (dist <= (last ? GOAL_RADIUS : WAYPOINT_RADIUS)) {
        path.cursor++;
        continue;
      }
      pathWishX = dx / dist;
      pathWishZ = dz / dist;
      return true;
    }
    pathWishX = 0;
    pathWishZ = 0;
    return false;
  }

  private updateStrafe(bot: Bot, bias: number, period: number): void {
    this.strafeTimer -= DT;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = period * bot.rng.range(0.7, 1.3);
      this.strafing = bot.rng.chance(bias);
      if (bot.rng.chance(0.5)) this.strafeSide = -this.strafeSide;
    }
  }

  private updatePeek(rate: number, duration: number): void {
    this.peekTimer -= DT;
    if (this.peekTimer > 0) return;
    this.peeking = !this.peeking;
    this.peekTimer = this.peeking ? duration : 1 / Math.max(rate, 0.05);
  }

  /** Would a step of `STRAFE_PROBE` in this direction leave the navmesh? */
  private canStep(bot: Bot, dx: number, dz: number): boolean {
    const nav = this.deps.nav;
    const cell = nav.cellAt(bot.px + dx * STRAFE_PROBE, bot.pz + dz * STRAFE_PROBE);
    if (cell < 0) return false;
    // Refuse a step that is also a fall: the pit lip is walkable on both sides.
    return Math.abs(nav.heightAt(cell) - bot.py) < 0.5;
  }

  /**
   * Abandon a path the bot is not making progress along.
   *
   * This is the difference between acceptance criterion 4 passing and failing. A bot
   * wedged on a corner has a perfectly good path and a wish direction pointing into a
   * wall; nothing in the follower notices, because from its point of view the waypoint is
   * still over there. Only wall-clock progress can tell.
   */
  private updateStuck(bot: Bot): void {
    if (!bot.path.active) {
      this.stuckTimer = 0;
      this.stuckMarkX = bot.px;
      this.stuckMarkZ = bot.pz;
      return;
    }
    this.stuckTimer += DT;
    if (this.stuckTimer < STUCK_WINDOW) return;
    const moved = Math.hypot(bot.px - this.stuckMarkX, bot.pz - this.stuckMarkZ);
    this.stuckTimer = 0;
    this.stuckMarkX = bot.px;
    this.stuckMarkZ = bot.pz;
    if (moved >= STUCK_DISTANCE) return;

    this.stuckEvents++;
    // Drop the path and rotate the goal: asking for the same route again would wedge
    // against the same corner. A patrol picks somewhere else; a tactical goal is retried
    // from scratch next evaluation.
    bot.path.clear();
    if (this.goal === 'PATROL') this.pickPatrolGoal(bot);
    else this.setGoalNone();
  }

  onPathFailed(): void {
    this.pathFailures++;
    if (this.goal !== 'PATROL') this.setGoalNone();
  }
}

/** Module-level scratch: the wish direction from the path follower. Zero allocation. */
let pathWishX = 0;
let pathWishZ = 0;
