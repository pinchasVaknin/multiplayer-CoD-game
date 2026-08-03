import { Btn, type MutableInputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { clamp, DEG2RAD } from '../core/MathUtil';
import type { NavGrid } from '../world/Navmesh';
import type { Bot } from './Bot';
import { isFiringState, isLegalBotTransition, isTravellingState, type BotState } from './BotStates';
import type { CoverIndex } from './Cover';
import {
  OBJECTIVE_IGNORE_BELOW,
  type ObjectiveProvider,
  type ObjectiveTarget,
} from './ObjectiveIntent';
import type { Perception } from './Perception';
import type { Pathfinder } from './Pathing';
import { simCos, simSin } from '../core/SimMath';

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
  /**
   * What the mode wants this bot doing, or null in a mode with no objectives (M7).
   *
   * A getter rather than the provider itself: the director owns the reference and a mode is
   * built after the brain deps are, so reading it late is what keeps the two lifetimes apart.
   */
  readonly objectives: () => ObjectiveProvider | null;
  /** Objectives that belong to a streak rather than the mode — care packages (M7). */
  readonly streakObjectives: () => ObjectiveProvider | null;
  /** Match-wide multiplier on `pushAggression` (M7). One life makes bots cautious. */
  readonly pushScale: () => number;
}

type GoalKind = 'NONE' | 'PATROL' | 'INVESTIGATE' | 'COVER' | 'FLANK' | 'PUSH' | 'OBJECTIVE';

/** Distance at which a waypoint counts as reached, metres. */
const WAYPOINT_RADIUS = 0.55;
const GOAL_RADIUS = 1.0;

/**
 * Depot's climbing rules (M8).
 *
 * `CLIMB_ARRIVED_RISE` is how far above the feet a waypoint may still be and count as
 * reached — a hair over `stepHeight`, so an ordinary kerb does not read as a climb.
 * `CLIMB_PRESS_RANGE` is how close in plan the bot has to be before it presses jump:
 * `Mantle.detectMantle` probes forward by `capsuleRadius + mantleReach` (1.3 m), so
 * pressing from further out is pressing at nothing, and the bot would jump its way across
 * the map.
 */
const CLIMB_ARRIVED_RISE = 0.4;
const CLIMB_PRESS_RANGE = 1.5;
/**
 * Sim ticks between jump presses while a climb is pending.
 *
 * A mantle is triggered on a *press* edge, so holding jump climbs once and then does
 * nothing. Re-pressing on a cadence is what lets a bot that arrived at a bad angle try
 * again a fifth of a second later instead of standing against the crate forever.
 */
const CLIMB_PRESS_PERIOD = 12;

/**
 * Reload when the magazine is down to this fraction of its size, with reserve to spare.
 *
 * A *fraction*, not a count (M7). It was 8 rounds flat, which was invisible while every bot
 * carried the 30-round carbine and became a hard lock the moment `BotArsenal` started dealing
 * shotguns: a full 6-round magazine is already under 8, so the bot believed it was low from
 * the instant it spawned, asked for RELOAD on every decision, and — because `IDLE -> RELOAD`
 * was not a legal edge — never left IDLE at all. Nine bots stood still for a whole match.
 *
 * At 0.28 the carbine reloads at 8 rounds exactly as it did in M3, so no measurement moves.
 */
const LOW_MAGAZINE_FRACTION = 0.28;

/** Stuck detector: less than this much progress over this long means replan. */
const STUCK_DISTANCE = 0.22;
const STUCK_WINDOW = 0.55;

/** Teammates closer than this get pushed apart, metres. */
const SEPARATION_RADIUS = 1.15;

/** How far ahead a strafe direction is validated against the navmesh, metres. */
const STRAFE_PROBE = 0.8;

/**
 * Seconds a committed flank is allowed to run before the bot reconsiders (M4).
 *
 * `decide` runs at 4 Hz and re-derives everything, and `tryFlank` is gated on the tier's
 * `flankChance` — so a bot already flanking dropped the plan on the *next* decision unless the
 * dice came up again. At Regular's 0.15 that is a mean commitment of about a third of a second,
 * which is why no flank on Foundry ever arrived anywhere and, in particular, why no bot ever
 * finished walking up a ramp: measured, bots set ten deck-level flank goals in 216 simulated
 * seconds and reached none of them.
 *
 * A plan re-rolled eight times before it completes is not a plan. Ammo and being badly hurt
 * still interrupt; a wobble in the tactical picture no longer does.
 */
const FLANK_COMMIT_SECONDS = 5.0;

/**
 * How far above itself a bot looks for a flank route, metres (M4).
 *
 * On a map with a catwalk, "get around the side of them" and "get above them" are the same
 * manoeuvre, and a flank search that only ever samples the bot's own level can never find the
 * second one. Foundry's deck is 4 m up, so probing 4 m above finds it where it exists and
 * finds nothing where it does not.
 */
const HIGH_FLANK_PROBE = 4.0;
/** Chance a flank takes the high route when one exists. Not always: predictability is death. */
const HIGH_FLANK_CHANCE = 0.45;
/** A flank target has to be genuinely above the bot to count as the high route. */
const HIGH_FLANK_MIN_RISE = 1.5;

export class BotBrain {
  state: BotState = 'IDLE';
  /** Seconds in the current state. */
  stateTime = 0;
  goal: GoalKind = 'NONE';
  /** What the mode last told this bot to do, for the objective-intent debug panel (M7). */
  objectiveId = '';
  objectiveLabel = '';
  objectiveAction = '';
  goalX = 0;
  goalY = 0;
  goalZ = 0;
  goalCell = -1;
  coverSlot = -1;

  /** Diagnostics (S7). */
  stuckEvents = 0;
  pathFailures = 0;
  replans = 0;
  /** M8: mantles this bot has completed, for the Depot verticality read-out. */
  climbsCompleted = 0;

  /** Sim ticks spent at the foot of a climb waypoint. Zero when not climbing (M8). */
  private climbTicks = 0;
  private climbStartY = 0;

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
    this.climbTicks = 0;
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
    const lowThreshold = Math.max(1, Math.floor(bot.weapons.definition.magSize * LOW_MAGAZINE_FRACTION));
    const low = bot.magazine <= lowThreshold && bot.reserve > 0;

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

    // A flank already under way is a commitment, not a suggestion. Ammo and a bad wound above
    // still take priority; the tactical picture merely changing no longer does.
    if (
      this.state === 'FLANK' &&
      bot.path.active &&
      this.stateTime < FLANK_COMMIT_SECONDS &&
      !hurt
    ) {
      return;
    }

    /**
     * The mode's job (M7), asked **before** the target block rather than after it.
     *
     * After it was wrong and the symptom was precise: `hasTarget && !seeing` falls into
     * SUPPRESS and returns, so a defender that had merely *heard* somebody never reached the
     * objective check and never went for the bomb — five S&D rounds in a row ended in a
     * detonation with zero defuses attempted. Contact is passed in, and the priority gate
     * inside decides: a defuse at 0.95 outranks the firefight, a "go stand on the flag we
     * already hold" at 0.35 does not.
     */
    if (this.tryObjective(bot, hasTarget)) return;

    if (hasTarget) {
      if (hurt && this.trySeekCover(bot)) return;

      if (seeing) {
        const range = bb.lastKnownRange;
        const profile = bot.weaponProfile;
        // Where the bot wants to be standing is a property of the weapon, not of the tier
        // (M7). A shotgun or an SMG closes hard; a sniper or an LMG holds the distance it
        // already has and gives ground when a target gets inside its comfortable range.
        const push = tier.pushAggression * profile.pushScale * this.deps.pushScale();
        if (range > profile.preferredRange && bot.rng.chance(push)) {
          if (this.tryPush(bot)) return;
        }
        if (range < profile.minComfortRange && this.tryFallBack(bot, profile.preferredRange)) return;
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

    /**
     * A mantle is pending when the waypoint is above the feet and within arm's reach (M8).
     *
     * `NavBake` only ever emits a climb link where the destination provably fits a standing
     * capsule, so what is left for the brain is the two things the bake cannot know: whether
     * the bot has actually arrived at the foot of the ledge, and whether it is *facing* it —
     * `Mantle.detectMantle` probes along `sim.yaw`, so a bot looking sideways at a container
     * will never find it.
     */
    const climbing = hasPath && pathWishUp > CLIMB_ARRIVED_RISE && pathWishDist <= CLIMB_PRESS_RANGE;
    if (climbing) {
      if (this.climbTicks === 0) this.climbStartY = bot.py;
      this.climbTicks++;
    } else {
      // Count the climb where it lands, not where it was attempted: `climbsCompleted` is
      // the number the Depot verticality read-out reports, so it has to mean a bot that
      // actually got up there rather than one that pressed jump at a wall.
      if (this.climbTicks > 0 && bot.py - this.climbStartY > CLIMB_ARRIVED_RISE) this.climbsCompleted++;
      this.climbTicks = 0;
    }

    if (climbing) {
      // Square up on the ledge. This takes the aim for the half-second the climb costs,
      // which is the trade: a bot cannot mantle and hold an angle at the same time, and
      // neither can a player.
      combat.lookToward(tier, Math.atan2(-pathWishX, -pathWishZ), 0);
    } else if (isFiringState(this.state) && bb.hasKnownTarget) {
      combat.updateAim(tier, bb, bot.px, bot.py + bot.eyeHeight, bot.pz, bot.rng);
    } else if (this.state === 'SEEK_COVER' && !hasPath && bb.hasKnownTarget) {
      combat.updateAim(tier, bb, bot.px, bot.py + bot.eyeHeight, bot.pz, bot.rng);
    } else if (travelling && (wishX !== 0 || wishZ !== 0)) {
      // Look where you are going, plus a slow sweep so a patrolling bot scans.
      this.lookSweep += DT;
      const sweep = this.state === 'PATROL' ? simSin(this.lookSweep * 0.7) * 26 * DEG2RAD : 0;
      combat.lookToward(tier, Math.atan2(-wishX, -wishZ) + sweep, 0);
    } else if (bb.investigateValid) {
      const dx = bb.investigateX - bot.px;
      const dz = bb.investigateZ - bot.pz;
      combat.lookToward(tier, Math.atan2(-dx, -dz), 0);
    } else {
      this.lookSweep += DT;
      combat.lookToward(tier, combat.aimYaw + simSin(this.lookSweep * 0.5) * 0.4 * DT, 0);
    }

    cmd.yaw = combat.aimYaw;
    cmd.pitch = combat.aimPitch;

    // ---- combat movement --------------------------------------------------
    if (this.state === 'ENGAGE' || this.state === 'SUPPRESS') {
      this.updateStrafe(bot, tier.strafeBias, tier.strafePeriod);
      if (this.strafing) {
        const yaw = combat.aimYaw;
        const rx = simCos(yaw) * this.strafeSide;
        const rz = -simSin(yaw) * this.strafeSide;
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
      const fx = -simSin(yaw);
      const fz = -simCos(yaw);
      const rx = simCos(yaw);
      const rz = -simSin(yaw);
      // Inverse of PlayerController's wish basis, so `moveX/moveZ` mean what they mean
      // for a human holding the same direction.
      cmd.moveZ = nx * fx + nz * fz;
      cmd.moveX = nx * rx + nz * rz;
    }

    // ---- buttons ----------------------------------------------------------
    let buttons = 0;
    if (crouch) buttons |= Btn.Crouch;

    /**
     * The mantle press (M8).
     *
     * Pressed on a cadence rather than held, because `PlayerController` triggers a mantle on
     * the jump *press* edge — a held button climbs once and then does nothing at all, which
     * is precisely how a bot ends up jogging into a container for the rest of the match. The
     * bot keeps walking into the ledge between presses, so each attempt starts from a
     * slightly different approach and a bad angle corrects itself.
     */
    if (climbing && bot.grounded && this.climbTicks % CLIMB_PRESS_PERIOD === 1) {
      buttons |= Btn.Jump;
    }

    // Sprint only where a human would: running somewhere, facing that way, not shooting.
    // Never while climbing: an auto-vault fires on a sprint into a ledge and would take a
    // 0.8 m step the moment the bot wanted the 1.4 m one above it.
    const sprintWorthy =
      travelling &&
      !climbing &&
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
      bot.weaponProfile,
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
  /**
   * Give ground: path to a cell roughly opposite the target, out at the weapon's preferred
   * range (M7).
   *
   * The mirror of `tryPush`, and the reason a sniper caught in a doorway does something
   * other than lose. Bearings are swept the way the flank does, so a bot backed against a
   * wall with nowhere to retreat falls through and fights where it stands rather than
   * freezing against a failed path request.
   */
  /**
   * Take the job the mode is offering, if it is worth taking (M7).
   *
   * The whole of "bots play the objective" is this method plus the priorities the mode
   * assigns. Three rules:
   *
   *  - A bot **in contact** only breaks off for a priority at or above
   *    `OBJECTIVE_IGNORE_BELOW`. That is what stops a defender abandoning a gunfight to stand
   *    on a flag it is already next to, and what lets a ticking bomb pull people off one.
   *  - A bot **already inside** the target's radius reports arrival every decision, which is
   *    how a plant or a defuse advances, and holds position rather than re-pathing on the spot.
   *  - Otherwise it paths there and the existing travel machinery does the rest. `OBJECTIVE`
   *    is a real state so the debug panel can say which flag each bot is walking to.
   */
  private tryObjective(bot: Bot, inContact: boolean): boolean {
    // Two providers: the mode's, and whatever streaks have put on the ground. Highest
    // priority wins, so a care package can outrank a flag the bot was idly holding.
    const modeProvider = this.deps.objectives();
    const streakProvider = this.deps.streakObjectives();
    const fromMode = modeProvider?.assign(bot) ?? null;
    const fromStreak = streakProvider?.assign(bot) ?? null;
    let provider = modeProvider;
    let target: ObjectiveTarget | null = fromMode;
    if (fromStreak !== null && (fromMode === null || fromStreak.priority > fromMode.priority)) {
      provider = streakProvider;
      target = fromStreak;
    }
    if (provider === null || target === null) {
      this.objectiveId = '';
      this.objectiveLabel = '';
      this.objectiveAction = '';
      return false;
    }

    this.objectiveId = target.id;
    this.objectiveLabel = target.label;
    this.objectiveAction = target.action;

    if (inContact && target.priority < OBJECTIVE_IGNORE_BELOW) return false;

    const dx = target.x - bot.px;
    const dz = target.z - bot.pz;
    if (dx * dx + dz * dz <= target.radius * target.radius && Math.abs(target.y - bot.py) < 3) {
      // Standing on it. Tell the mode, and stop asking the pathfinder for a route to here.
      provider.onArrived(bot, target);
      this.setGoalNone();
      this.transition(bot, 'OBJECTIVE');
      return true;
    }

    const nav = this.deps.nav;
    const cell = nav.nearestCell(target.x, target.y, target.z);
    if (cell < 0) return false;
    this.setGoal('OBJECTIVE', nav.centerX(nav.indexOfX(cell)), nav.heightAt(cell), nav.centerZ(nav.indexOfZ(cell)));
    this.transition(bot, 'OBJECTIVE');
    return true;
  }

  private tryFallBack(bot: Bot, preferredRange: number): boolean {
    const bb = bot.blackboard;
    if (!bb.hasKnownTarget) return false;
    const nav = this.deps.nav;
    const awayX = bot.px - bb.lastKnownX;
    const awayZ = bot.pz - bb.lastKnownZ;
    const base = Math.atan2(awayZ, awayX);
    // Enough ground to be worth the walk, but not so much that the bot leaves the fight.
    const radius = clamp(preferredRange - bb.lastKnownRange, 4, 14);

    for (const sweep of [0, 30, -30, 60, -60]) {
      const angle = base + sweep * DEG2RAD;
      const x = bot.px + simCos(angle) * radius;
      const z = bot.pz + simSin(angle) * radius;
      const cell = nav.cellAtY(x, bot.py, z);
      if (cell < 0) continue;
      this.setGoal('PUSH', nav.centerX(nav.indexOfX(cell)), nav.heightAt(cell), nav.centerZ(nav.indexOfZ(cell)));
      this.transition(bot, 'PUSH');
      return true;
    }
    return false;
  }

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
      const x = bb.lastKnownX + simCos(angle) * radius;
      const z = bb.lastKnownZ + simSin(angle) * radius;
      /**
       * The flank is around the target — and, on a map with a deck, sometimes *above* it.
       *
       * `cellAtY` at the bot's own height is the level route; probing `HIGH_FLANK_PROBE`
       * above finds the catwalk where there is one. Taking it less than half the time keeps
       * the manoeuvre from becoming a tell, and a bot that finds no deck simply flanks on the
       * flat as it always did.
       */
      const level = nav.cellAtY(x, bot.py, z);
      const above = nav.cellAtY(x, bot.py + HIGH_FLANK_PROBE, z);
      const highRoute =
        above >= 0 &&
        above !== level &&
        nav.heightAt(above) > bot.py + HIGH_FLANK_MIN_RISE &&
        bot.rng.chance(HIGH_FLANK_CHANCE);
      const cell = highRoute ? above : level;
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
    pathWishUp = 0;
    while (path.cursor < path.count) {
      const wx = path.x[path.cursor] ?? bot.px;
      const wz = path.z[path.cursor] ?? bot.pz;
      const dx = wx - bot.px;
      const dz = wz - bot.pz;
      const dist = Math.hypot(dx, dz);
      const last = path.cursor === path.count - 1;
      // A waypoint above the bot's feet is only *reached* when the bot is actually up
      // there. Without the height test the plan-distance check retires a mantle waypoint
      // the moment the bot walks into the wall below it, and the bot then trots off
      // toward the next one having never climbed anything.
      const rise = (path.y[path.cursor] ?? bot.py) - bot.py;
      const arrived = dist <= (last ? GOAL_RADIUS : WAYPOINT_RADIUS) && rise <= CLIMB_ARRIVED_RISE;
      if (arrived) {
        path.cursor++;
        continue;
      }
      pathWishX = dx / dist;
      pathWishZ = dz / dist;
      pathWishUp = rise;
      pathWishDist = dist;
      return true;
    }
    pathWishX = 0;
    pathWishZ = 0;
    pathWishDist = Infinity;
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
    const cell = nav.cellAtY(bot.px + dx * STRAFE_PROBE, bot.py, bot.pz + dz * STRAFE_PROBE);
    if (cell < 0) return false;
    // Refuse a step that is also a fall: the pit lip and a catwalk edge are both walkable
    // on one side and four metres of air on the other.
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
/** How far above the bot's feet the current waypoint sits, metres (M8). */
let pathWishUp = 0;
/** Plan distance to the current waypoint, metres (M8). */
let pathWishDist = Infinity;
