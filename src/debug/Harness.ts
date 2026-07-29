import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/Events';
import { Btn, type InputCommand, type MutableInputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import type { MovementConfig } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { ColliderSet } from '../world/ColliderSet';
import { CollisionWorld } from '../world/CollisionWorld';

/**
 * Headless test harness (brief S3 `debug/Harness`).
 *
 * Drives synthetic InputCommands through a real PlayerController against a real
 * CollisionWorld, with no renderer and no wall clock. That is exactly what makes it
 * useful for the acceptance criteria: the movement bound in S5.2 is a property of the
 * simulation, so it should be provable by running the simulation adversarially rather
 * than by a human trying to break it by hand.
 *
 * Everything here runs on the same fixed DT the game uses. Available in the browser
 * console as `__operator.harness`.
 */

export interface RunResult {
  ticks: number;
  seconds: number;
  /** Horizontal path length, metres. */
  distance: number;
  /** distance / seconds. */
  averageSpeed: number;
  /** Highest instantaneous horizontal speed seen on any tick. */
  peakSpeed: number;
  /** Highest average speed over any one-second window. This is the S5.2 bound. */
  peakSustainedSpeed: number;
  finalStance: string;
}

/** A policy decides the command for a tick, given the controller's current state. */
export type Policy = (tick: number, player: PlayerController, cmd: MutableInputCommand) => void;

const TEST_FLOOR_HALF = 4000;

export class Harness {
  /** A featureless plane, so a run can continue for as long as the test needs. */
  readonly flatWorld: CollisionWorld;
  private readonly bus = new EventBus<GameEvents>();
  private readonly cmd: MutableInputCommand = {
    seq: 0,
    tickIndex: 0,
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    sampledAtMs: 0,
  };

  constructor(private readonly cfg: MovementConfig) {
    const set = new ColliderSet(1);
    set.add(
      { x: 0, y: -1, z: 0 },
      { x: TEST_FLOOR_HALF * 2, y: 2, z: TEST_FLOOR_HALF * 2 },
      0,
      0,
      0,
      'floor',
    );
    this.flatWorld = new CollisionWorld(
      set,
      { min: { x: -TEST_FLOOR_HALF, y: -8, z: -TEST_FLOOR_HALF }, max: { x: TEST_FLOOR_HALF, y: 24, z: TEST_FLOOR_HALF } },
      64,
    );
    this.flatWorld.configure(cfg.maxSlopeDeg, cfg.collisionSkin);
  }

  /** Run `seconds` of simulation under `policy`. Uses a fresh player each time. */
  run(seconds: number, policy: Policy, world: CollisionWorld = this.flatWorld): RunResult {
    const player = new PlayerController({ ...this.cfg }, world, this.bus);
    player.spawn(0, 0.2, 0, 0);

    const ticks = Math.max(1, Math.round(seconds / DT));
    const windowTicks = Math.round(1 / DT);
    const arc = new Float64Array(ticks + 1);

    let distance = 0;
    let peakSpeed = 0;
    let lastX = player.sim.x;
    let lastZ = player.sim.z;

    for (let t = 0; t < ticks; t++) {
      this.cmd.seq = t;
      this.cmd.tickIndex = t;
      this.cmd.moveX = 0;
      this.cmd.moveZ = 0;
      this.cmd.yaw = 0;
      this.cmd.pitch = 0;
      this.cmd.buttons = 0;
      this.cmd.sampledAtMs = t * DT * 1000;
      policy(t, player, this.cmd);
      player.step(this.cmd as InputCommand);

      distance += Math.hypot(player.sim.x - lastX, player.sim.z - lastZ);
      lastX = player.sim.x;
      lastZ = player.sim.z;
      arc[t + 1] = distance;
      if (player.sim.speed > peakSpeed) peakSpeed = player.sim.speed;
    }

    let peakSustained = 0;
    for (let t = windowTicks; t <= ticks; t++) {
      const windowDistance = (arc[t] ?? 0) - (arc[t - windowTicks] ?? 0);
      const speed = windowDistance / (windowTicks * DT);
      if (speed > peakSustained) peakSustained = speed;
    }

    return {
      ticks,
      seconds: ticks * DT,
      distance,
      averageSpeed: distance / (ticks * DT),
      peakSpeed,
      peakSustainedSpeed: peakSustained,
      finalStance: player.sim.stance,
    };
  }

  // -- canned policies -----------------------------------------------------

  /** Hold W. */
  static walkForward: Policy = (_t, _p, cmd) => {
    cmd.moveZ = 1;
  };

  /** Hold W + sprint. */
  static sprintForward: Policy = (_t, _p, cmd) => {
    cmd.moveZ = 1;
    cmd.buttons = Btn.Sprint;
  };

  /** Hold W + crouch. */
  static crouchForward: Policy = (_t, _p, cmd) => {
    cmd.moveZ = 1;
    cmd.buttons = Btn.Crouch;
  };

  /**
   * Hold W and keep tactical sprint alive: release and double-tap the sprint key
   * whenever the cooldown allows, which is the fastest a player could legally sustain.
   */
  static tacSprintForward: Policy = (_t, p, cmd) => {
    cmd.moveZ = 1;
    const sim = p.sim;
    if (sim.tacSprintActive) {
      cmd.buttons = Btn.Sprint;
      return;
    }
    if (sim.tacSprintCooldown > 0 || sim.tacLockout > 0) {
      cmd.buttons = Btn.Sprint;
      return;
    }
    // Alternate pressed/released every tick to produce double-taps inside the window.
    cmd.buttons = sim.tick % 2 === 0 ? Btn.Sprint : 0;
  };

  /**
   * The adversary from S5.2: chain slide -> jump-cancel -> sprint -> slide, taking
   * every opportunity the rules allow, and see how fast it can actually go.
   */
  static chainSlideCancel: Policy = (_t, p, cmd) => {
    const sim = p.sim;
    cmd.moveZ = 1;

    if (sim.slideActive) {
      // Cancel as late as the rules allow while still keeping most of the speed.
      const cancel = sim.slideElapsed > 0.12;
      cmd.buttons = Btn.Crouch | (cancel ? Btn.Jump : 0);
      return;
    }

    let buttons = Btn.Sprint;
    // Try to promote to tactical sprint whenever it is legal.
    if (!sim.tacSprintActive && sim.tacSprintCooldown <= 0 && sim.tacLockout <= 0) {
      if (sim.tick % 2 === 1) buttons = 0;
    }
    // Start a slide the instant the entry gate opens.
    if (sim.grounded && sim.slideCooldown <= 0 && sim.sprintHeldTime >= 0.3 && sim.speed > 4) {
      buttons |= Btn.Crouch;
    }
    cmd.buttons = buttons;
  };

  // -- named measurements --------------------------------------------------

  /** Steady-state speed for each locomotion mode, measured over 6 s. */
  measureSpeeds(): Record<string, number> {
    return {
      walk: this.run(6, Harness.walkForward).peakSustainedSpeed,
      sprint: this.run(6, Harness.sprintForward).peakSustainedSpeed,
      crouch: this.run(6, Harness.crouchForward).peakSustainedSpeed,
      tacSprint: this.run(6, Harness.tacSprintForward).peakSpeed,
    };
  }

  /** Acceptance criterion 6: sustained speed must not exceed tacSprintSpeed. */
  measureMaxSustained(seconds = 60): RunResult {
    return this.run(seconds, Harness.chainSlideCancel);
  }

  /**
   * Acceptance criterion 6: the LOCKED slide numbers, read back out of a live run.
   * Returns what the simulation actually did, not what the config says it should.
   */
  verifySlideRules(): SlideRuleReport {
    const player = new PlayerController({ ...this.cfg }, this.flatWorld, this.bus);
    player.spawn(0, 0.2, 0, 0);
    const sim = player.sim;

    let slideStartTick = -1;
    let slideEndTick = -1;
    let lockoutAtEnd = 0;
    let cooldownAtEnd = 0;
    let sprintHeldAtSlideStart = 0;
    let earliestSecondSlideTick = -1;
    let tacBlockedUntilTick = -1;

    const ticks = Math.round(6 / DT);
    for (let t = 0; t < ticks; t++) {
      this.cmd.seq = t;
      this.cmd.tickIndex = t;
      this.cmd.moveX = 0;
      this.cmd.moveZ = 1;
      this.cmd.yaw = 0;
      this.cmd.pitch = 0;
      this.cmd.sampledAtMs = t * DT * 1000;

      let buttons = Btn.Sprint;
      // Slide as soon as legal, then keep asking for another one forever.
      if (sim.grounded && !sim.slideActive && sim.slideCooldown <= 0 && sim.sprintHeldTime >= 0.3) {
        buttons |= Btn.Crouch;
      } else if (sim.slideActive) {
        buttons |= Btn.Crouch;
      }
      this.cmd.buttons = buttons;

      const wasSliding = sim.slideActive;
      const sprintHeldBefore = sim.sprintHeldTime;
      player.step(this.cmd as InputCommand);

      if (!wasSliding && sim.slideActive) {
        if (slideStartTick < 0) {
          slideStartTick = t;
          sprintHeldAtSlideStart = sprintHeldBefore;
        } else if (earliestSecondSlideTick < 0) {
          earliestSecondSlideTick = t;
        }
      }
      if (wasSliding && !sim.slideActive && slideEndTick < 0) {
        slideEndTick = t;
        lockoutAtEnd = sim.tacLockout;
        cooldownAtEnd = sim.slideCooldown;
      }
      if (slideEndTick >= 0 && tacBlockedUntilTick < 0 && sim.tacLockout <= 0) {
        tacBlockedUntilTick = t;
      }
    }

    return {
      slideDurationS: slideEndTick >= 0 && slideStartTick >= 0 ? (slideEndTick - slideStartTick) * DT : -1,
      sprintHeldBeforeSlideS: sprintHeldAtSlideStart,
      tacLockoutOnExitS: lockoutAtEnd,
      slideCooldownOnExitS: cooldownAtEnd,
      measuredTacLockoutS: tacBlockedUntilTick >= 0 && slideEndTick >= 0 ? (tacBlockedUntilTick - slideEndTick) * DT : -1,
      measuredSlideToSlideS:
        earliestSecondSlideTick >= 0 && slideEndTick >= 0 ? (earliestSecondSlideTick - slideEndTick) * DT : -1,
    };
  }

  /** Everything the acceptance criteria ask for, in one call. */
  report(): HarnessReport {
    const speeds = this.measureSpeeds();
    const sustained = this.measureMaxSustained(60);
    const slide = this.verifySlideRules();
    return {
      speeds,
      chainSlide: sustained,
      slideRules: slide,
      boundedAt: this.cfg.tacSprintSpeed,
      boundRespected: sustained.peakSustainedSpeed <= this.cfg.tacSprintSpeed + 1e-3,
    };
  }
}

export interface SlideRuleReport {
  slideDurationS: number;
  sprintHeldBeforeSlideS: number;
  tacLockoutOnExitS: number;
  slideCooldownOnExitS: number;
  measuredTacLockoutS: number;
  measuredSlideToSlideS: number;
}

export interface HarnessReport {
  speeds: Record<string, number>;
  chainSlide: RunResult;
  slideRules: SlideRuleReport;
  boundedAt: number;
  boundRespected: boolean;
}
