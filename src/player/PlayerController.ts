import { EV, type GameBus, type SlideEndReason } from '../core/Events';
import { Btn, isDown, justPressed, type InputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { clamp01, damp, lerp, TAU } from '../core/MathUtil';
import type { CollisionWorld } from '../world/CollisionWorld';
import { beginMantle, detectMantle, makeMantleTarget, stepMantle } from './Mantle';
import {
  accelerate,
  applyFriction,
  capsuleFits,
  clampHorizontalSpeed,
  integrateMotion,
  jumpVelocity,
} from './Movement';
import type { MovementConfig } from './MovementConfig';
import { copySnapshot, makeSnapshot, PlayerSim, type PlayerSnapshot } from './PlayerState';
import { beginSlide, canStartSlide, endSlide, stepSlide } from './Slide';
import { capsuleHeightFor, eyeHeightFor, isLegalStanceTransition, type StanceId } from './Stance';

/**
 * Consumes exactly one InputCommand per tick and advances the player.
 *
 * Everything that decides *what* the player is doing lives here; Movement.ts, Slide.ts
 * and Mantle.ts own *how*. Edge detection is computed from the command bitfield, in the
 * sim, never in a DOM handler (brief S4.2).
 *
 * Allocation free: every event payload is a module-level singleton, and the brief's
 * "payloads are transient" contract is what makes that safe.
 */

const evSpawned = { entityId: 0, x: 0, y: 0, z: 0, yaw: 0 };
const evStance = { entityId: 0, from: 'STAND' as StanceId, to: 'STAND' as StanceId, tick: 0 };
const evJump = { entityId: 0, x: 0, y: 0, z: 0, horizontalSpeed: 0 };
const evLand = { entityId: 0, x: 0, y: 0, z: 0, impactSpeed: 0, stance: 'STAND' as StanceId, material: 0 };
const evStep = { entityId: 0, x: 0, y: 0, z: 0, speed: 0, heavy: false, quiet: false, material: 0 };
const evSlideStart = { entityId: 0, x: 0, y: 0, z: 0, entrySpeed: 0 };
const evSlideEnd = { entityId: 0, reason: 'expired' as SlideEndReason, exitSpeed: 0, tick: 0 };
const evMantleStart = { entityId: 0, x: 0, y: 0, z: 0, ledgeHeight: 0 };
const evMantleEnd = { entityId: 0, x: 0, y: 0, z: 0, endStance: 'STAND' as StanceId };

const mantleTarget = makeMantleTarget();

/** How quickly the eye height chases the stance target, per second. */
const EYE_DAMP_RATE = 16;

/**
 * Free-cam flight speeds, m/s (post-M8 QA tool).
 *
 * 10 m/s crosses Foundry in about eight seconds — quick enough to get somewhere, slow enough
 * to read a navmesh on the way. Sprint quadruples it for crossing Dunes; ADS quarters it for
 * easing up to a collider seam, which is the case the tool exists for.
 */
const NOCLIP_SPEED = 10;
const NOCLIP_BOOST = 4;
const NOCLIP_PRECISE = 0.25;

export class PlayerController {
  readonly sim = new PlayerSim();
  readonly prev: PlayerSnapshot = makeSnapshot();
  readonly curr: PlayerSnapshot = makeSnapshot();

  /** Effective horizontal speed cap this tick. Surfaced by the debug overlay. */
  currentSpeedCap = 0;

  /**
   * Multiplier on every ground speed cap (M6: the Lightweight perk).
   *
   * A field on the controller rather than a change to `MovementConfig`, because the config
   * is a single shared object that the tuning panel writes into and that every bot's
   * controller reads — scaling it for a perk would give the enemy team the perk too. One
   * multiplier per controller, defaulting to 1, leaves every M1 measurement describing the
   * same movement code.
   *
   * Airborne speed is deliberately not scaled: `airSpeedCap` latches whatever the player
   * left the ground with, so a faster run already carries into a faster jump, and scaling
   * the cap again on top would compound.
   */
  speedScale = 1;

  /**
   * Held down by something other than the crouch key (post-M8).
   *
   * Planting and defusing use it: S6.3 asks for a visible indicator that somebody is working
   * on the bomb, and the honest one is the operator kneeling over it — a posture other
   * players can read from across the site with no HUD element involved. Folded into
   * `crouchHeld` rather than written straight onto the stance, so every rule that already
   * governs crouching still applies: the capsule shrinks, the speed cap drops, the eye
   * height damps down, and standing back up is still refused under a low ceiling.
   *
   * It cannot start a slide, because a slide needs the crouch *press* edge and this never
   * produces one — which is right: an interaction is not a movement input.
   */
  forceCrouch = false;

  /**
   * Free-cam: fly through the world, ignoring gravity and geometry (post-M8 QA tool).
   *
   * Deliberately a mode of *this* class rather than a separate camera. The debug camera it
   * replaces would have needed its own view integration, its own interpolation snapshots and
   * its own relationship with the render pass — three things that already exist here and
   * would have had to be kept in step. Flying is a different way of turning a command into a
   * position, and turning a command into a position is what this class is.
   *
   * The consequence worth stating: everything downstream — the camera rig, the viewmodel, the
   * audio listener, the minimap — keeps working with no knowledge that it is happening,
   * because all of them read `sim`, and `sim` is still being written every tick.
   */
  noclip = false;

  private strafeInput = 0;
  private crouchHeldThisTick = false;

  /**
   * `entityId` stamps every event this controller emits. It defaults to the local player
   * because M1 and M2 only ever had one of these; from M3 each bot owns one too, and the
   * id is how a subscriber tells "the player landed" from "something landed over there".
   */
  constructor(
    private cfg: MovementConfig,
    private readonly world: CollisionWorld,
    private readonly bus: GameBus,
    readonly entityId: number = 0,
  ) {}

  setConfig(cfg: MovementConfig): void {
    this.cfg = cfg;
    this.world.configure(cfg.maxSlopeDeg, cfg.collisionSkin);
    this.sim.capsuleHeight = capsuleHeightFor(cfg, this.sim.stance);
  }

  spawn(x: number, y: number, z: number, yaw: number): void {
    const cfg = this.cfg;
    this.sim.reset(x, y, z, yaw, cfg.standHeight, cfg.standEye);
    this.sim.writeSnapshot(this.curr, 0);
    copySnapshot(this.curr, this.prev);
    evSpawned.entityId = this.entityId;
    evSpawned.x = x;
    evSpawned.y = y;
    evSpawned.z = z;
    evSpawned.yaw = yaw;
    this.bus.emit(EV.PlayerSpawned, evSpawned);
  }

  step(cmd: InputCommand): void {
    const cfg = this.cfg;
    const sim = this.sim;
    copySnapshot(this.curr, this.prev);

    sim.tick = cmd.tickIndex;
    sim.yaw = cmd.yaw;
    sim.pitch = cmd.pitch;
    this.strafeInput = cmd.moveX;

    if (this.noclip) {
      this.stepNoclip(cmd);
      return;
    }

    const buttons = cmd.buttons;
    const prevButtons = sim.prevButtons;
    const jumpPressed = justPressed(buttons, prevButtons, Btn.Jump);
    const crouchPressed = justPressed(buttons, prevButtons, Btn.Crouch);
    // `forceCrouch` joins the *held* test and deliberately not the pressed one: see the field.
    const crouchHeld = isDown(buttons, Btn.Crouch) || this.forceCrouch;
    const sprintHeld = isDown(buttons, Btn.Sprint);
    const sprintPressed = justPressed(buttons, prevButtons, Btn.Sprint);
    const adsHeld = isDown(buttons, Btn.Ads);
    // Pulling the trigger stops a sprint, which is what starts the sprint-to-fire timer
    // in the weapon. Holding shift into a gunfight must not be free (brief S6.6).
    const fireHeld = isDown(buttons, Btn.Fire);

    this.tickTimers(jumpPressed);

    if (sim.mantleActive) {
      const finished = stepMantle(sim, cfg);
      sim.capsuleHeight = capsuleHeightFor(cfg, sim.stance);
      if (finished) {
        evMantleEnd.entityId = this.entityId;
        evMantleEnd.x = sim.x;
        evMantleEnd.y = sim.y;
        evMantleEnd.z = sim.z;
        evMantleEnd.endStance = sim.stance;
        this.bus.emit(EV.PlayerMantleEnded, evMantleEnd);
      }
      this.finishTick(buttons);
      return;
    }

    // ---- wish direction, in world space ---------------------------------
    const fx = -Math.sin(sim.yaw);
    const fz = -Math.cos(sim.yaw);
    const rx = Math.cos(sim.yaw);
    const rz = -Math.sin(sim.yaw);
    let wishX = rx * cmd.moveX + fx * cmd.moveZ;
    let wishZ = rz * cmd.moveX + fz * cmd.moveZ;
    // Direction and magnitude are separated deliberately. Normalising by the *clamped*
    // magnitude leaves an over-length direction vector whenever a command arrives with
    // |move| > 1, and every downstream consumer (accelerate, friction, slide steering)
    // assumes unit length — the result is a speed cap quietly scaled by |move|.
    const wishLen = Math.hypot(wishX, wishZ);
    const wishMag = Math.min(1, wishLen);
    if (wishLen > 1e-4) {
      wishX /= wishLen;
      wishZ /= wishLen;
    } else {
      wishX = 0;
      wishZ = 0;
    }
    const movingForward = cmd.moveZ > 0.5;

    this.updateSprint(sprintHeld, sprintPressed, movingForward, crouchHeld, adsHeld || fireHeld);

    // ---- slide -----------------------------------------------------------
    this.crouchHeldThisTick = crouchHeld;
    if (sim.slideActive) {
      const reason = this.slideExitReason(crouchHeld, cfg);
      if (reason !== null) this.exitSlide(reason);
      else stepSlide(sim, cfg, wishX, wishZ);
    } else if (crouchPressed && sprintHeld && canStartSlide(sim, cfg)) {
      const entry = beginSlide(sim, cfg, wishX, wishZ);
      this.setStance('SLIDE');
      evSlideStart.entityId = this.entityId;
      evSlideStart.x = sim.x;
      evSlideStart.y = sim.y;
      evSlideStart.z = sim.z;
      evSlideStart.entrySpeed = entry;
      this.bus.emit(EV.PlayerSlideStarted, evSlideStart);
    }

    // ---- jump. This is also the slide jump-cancel route (S5.2). ----------
    if (sim.jumpBuffer > 0 && (sim.grounded || sim.coyote > 0)) this.performJump();

    // ---- crouch / stand --------------------------------------------------
    if (!sim.slideActive) this.updateCrouchStance(crouchHeld);

    // ---- velocity --------------------------------------------------------
    const wasGroundedForCap = sim.grounded;
    if (sim.slideActive) {
      // stepSlide already wrote the horizontal velocity.
      this.currentSpeedCap = sim.slideSpeed;
    } else {
      this.currentSpeedCap = this.speedCap(adsHeld);
      const wishSpeed = this.currentSpeedCap * wishMag;
      if (sim.grounded) applyFriction(sim, cfg, wishX, wishZ, wishSpeed);
      const speedBefore = sim.speed;
      const accel = sim.grounded ? cfg.groundAccel : cfg.groundAccel * cfg.airControl;
      accelerate(sim, wishX, wishZ, wishSpeed, accel);
      // Acceleration may never push past the cap; existing momentum above it is left
      // to friction. This is what bounds wall-hugging and mid-air strafing alike.
      const limit = Math.max(sim.grounded ? this.currentSpeedCap : sim.airSpeedCap, speedBefore);
      clampHorizontalSpeed(sim, limit);
    }

    sim.vy -= cfg.gravity * DT;
    if (sim.vy < -cfg.maxFallSpeed) sim.vy = -cfg.maxFallSpeed;

    // ---- collision -------------------------------------------------------
    integrateMotion(sim, cfg, this.world);

    if (wasGroundedForCap && !sim.grounded && !sim.jumpedThisTick) {
      sim.airSpeedCap = Math.max(sim.speed, cfg.sprintSpeed);
    }

    // ---- post-move stance ------------------------------------------------
    if (!sim.grounded && !sim.slideActive && sim.stance !== 'AIRBORNE') {
      this.setStance('AIRBORNE');
    } else if (sim.grounded && sim.stance === 'AIRBORNE') {
      const wantCrouch = crouchHeld || !this.fitsHere(cfg.standHeight);
      this.setStance(wantCrouch ? 'CROUCH' : 'STAND');
    }

    if (sim.justLanded) {
      evLand.entityId = this.entityId;
      evLand.x = sim.x;
      evLand.y = sim.y;
      evLand.z = sim.z;
      evLand.impactSpeed = sim.landImpact;
      evLand.stance = sim.stance;
      evLand.material = sim.groundMaterial;
      this.bus.emit(EV.PlayerLanded, evLand);
    }

    // ---- mantle detection -------------------------------------------------
    const autoVault = sim.grounded && sim.sprintActive && movingForward && sim.blockedHorizontally;
    if ((jumpPressed || autoVault) && detectMantle(sim, cfg, this.world, mantleTarget)) {
      // An auto-vault only clears low obstacles; anything taller waits for a jump press.
      const autoVaultTooTall =
        autoVault && !jumpPressed && mantleTarget.ledgeHeight > cfg.autoVaultMaxHeight;
      if (!autoVaultTooTall) {
        if (sim.slideActive) this.exitSlide('blocked');
        beginMantle(sim, mantleTarget);
        this.setStance('MANTLE');
        sim.capsuleHeight = capsuleHeightFor(cfg, 'MANTLE');
        sim.jumpBuffer = 0;
        evMantleStart.entityId = this.entityId;
        evMantleStart.x = sim.x;
        evMantleStart.y = sim.y;
        evMantleStart.z = sim.z;
        evMantleStart.ledgeHeight = mantleTarget.ledgeHeight;
        this.bus.emit(EV.PlayerMantleStarted, evMantleStart);
      }
    }

    this.finishTick(buttons);
  }

  // -- helpers -------------------------------------------------------------

  /**
   * One tick of free-cam flight (post-M8 QA tool).
   *
   * WASD flies along the *look* direction, including pitch, so the camera goes where it is
   * pointing — which is what makes inspecting a navmesh from above or a collider from
   * underneath a single movement rather than a puzzle. Jump rises and crouch sinks on the
   * world vertical regardless of pitch, because "straight up" is the one direction you cannot
   * express by looking.
   *
   * Velocity is written as well as position even though nothing integrates it here: the
   * speedometer, the debug overlay and the audio listener all read `sim.speed`, and a
   * free-cam that reported 0 m/s while crossing the map would make the overlay lie during
   * exactly the session it is there to support.
   *
   * No collision, no gravity, no stance machine and no footsteps — a spectator makes no
   * noise, which is half of what "observe natural bot AI behaviour up close" requires.
   */
  private stepNoclip(cmd: InputCommand): void {
    const sim = this.sim;
    const buttons = cmd.buttons;

    const speed =
      NOCLIP_SPEED *
      (isDown(buttons, Btn.Sprint) ? NOCLIP_BOOST : 1) *
      (isDown(buttons, Btn.Ads) ? NOCLIP_PRECISE : 1);

    const cp = Math.cos(sim.pitch);
    const fx = -Math.sin(sim.yaw) * cp;
    const fy = Math.sin(sim.pitch);
    const fz = -Math.cos(sim.yaw) * cp;
    const rx = Math.cos(sim.yaw);
    const rz = -Math.sin(sim.yaw);

    let vx = rx * cmd.moveX + fx * cmd.moveZ;
    let vy = fy * cmd.moveZ;
    let vz = rz * cmd.moveX + fz * cmd.moveZ;
    if (isDown(buttons, Btn.Jump)) vy += 1;
    if (isDown(buttons, Btn.Crouch)) vy -= 1;

    const len = Math.hypot(vx, vy, vz);
    if (len > 1e-4) {
      const scale = speed / len;
      vx *= scale;
      vy *= scale;
      vz *= scale;
    } else {
      vx = 0;
      vy = 0;
      vz = 0;
    }

    sim.x += vx * DT;
    sim.y += vy * DT;
    sim.z += vz * DT;
    sim.vx = vx;
    sim.vy = vy;
    sim.vz = vz;

    // A flying capsule is not standing on anything, and nothing may believe otherwise:
    // `grounded` false keeps the footstep, landing and slide paths inert for free.
    sim.grounded = false;
    sim.justLanded = false;
    sim.blockedHorizontally = false;
    sim.steppedUp = false;
    sim.eyeHeight = this.cfg.standEye;
    sim.prevButtons = buttons;
    sim.writeSnapshot(this.curr, this.strafeInput);
  }

  private tickTimers(jumpPressed: boolean): void {
    const sim = this.sim;
    const cfg = this.cfg;
    sim.mantleCooldown = Math.max(0, sim.mantleCooldown - DT);
    sim.slideCooldown = Math.max(0, sim.slideCooldown - DT);
    sim.tacSprintCooldown = Math.max(0, sim.tacSprintCooldown - DT);
    sim.tacLockout = Math.max(0, sim.tacLockout - DT);
    sim.jumpBuffer = Math.max(0, sim.jumpBuffer - DT);
    sim.coyote = sim.grounded ? cfg.coyoteTime : Math.max(0, sim.coyote - DT);
    sim.jumpedThisTick = false;
    if (jumpPressed) sim.jumpBuffer = cfg.jumpBufferTime;
  }

  /** `weaponBusy` is ADS or the trigger: either one ends a sprint. */
  private updateSprint(
    sprintHeld: boolean,
    sprintPressed: boolean,
    movingForward: boolean,
    crouchHeld: boolean,
    weaponBusy: boolean,
  ): void {
    const sim = this.sim;
    const cfg = this.cfg;

    // The hold timer must NOT care about crouch: pressing crouch is how a slide is
    // requested, and zeroing the timer on that same tick would make the S5.2 entry
    // gate ("sprint held >= 0.3 s") impossible to ever satisfy.
    const holdingSprint = sprintHeld && movingForward;
    if (holdingSprint && sim.grounded && !sim.slideActive) sim.sprintHeldTime += DT;
    else if (!holdingSprint) sim.sprintHeldTime = 0;
    sim.sprintActive = holdingSprint && !crouchHeld && !weaponBusy;

    if (sprintPressed && movingForward && !crouchHeld && !weaponBusy) {
      const elapsed = (sim.tick - sim.lastSprintPressTick) * DT;
      const eligible =
        elapsed <= cfg.tacSprintDoubleTapWindow &&
        sim.tacSprintCooldown <= 0 &&
        sim.tacLockout <= 0 &&
        !sim.slideActive;
      if (eligible) {
        sim.tacSprintActive = true;
        sim.tacSprintElapsed = 0;
      }
      sim.lastSprintPressTick = sim.tick;
    }

    if (!sim.tacSprintActive) return;
    if (!sim.sprintActive || sim.slideActive) {
      this.endTacSprint();
      return;
    }
    sim.tacSprintElapsed += DT;
    if (sim.tacSprintElapsed > cfg.tacSprintDuration + cfg.tacSprintDecay) this.endTacSprint();
  }

  private endTacSprint(): void {
    const sim = this.sim;
    if (!sim.tacSprintActive) return;
    sim.tacSprintActive = false;
    sim.tacSprintElapsed = 0;
    sim.tacSprintCooldown = this.cfg.tacSprintCooldown;
  }

  /** Horizontal speed cap for the current state, before the input magnitude scale. */
  private speedCap(adsHeld: boolean): number {
    const sim = this.sim;
    const cfg = this.cfg;
    if (!sim.grounded) return Math.max(sim.airSpeedCap, cfg.sprintSpeed);
    const scale = this.speedScale;
    if (sim.stance === 'CROUCH') return cfg.crouchSpeed * scale;
    if (adsHeld) return cfg.adsSpeed * scale;
    if (sim.tacSprintActive) {
      const held = cfg.tacSprintDuration;
      if (sim.tacSprintElapsed <= held) return cfg.tacSprintSpeed * scale;
      const t = clamp01((sim.tacSprintElapsed - held) / Math.max(cfg.tacSprintDecay, 1e-3));
      return lerp(cfg.tacSprintSpeed, cfg.sprintSpeed, t) * scale;
    }
    if (sim.sprintActive) return cfg.sprintSpeed * scale;
    return cfg.walkSpeed * scale;
  }

  private performJump(): void {
    const sim = this.sim;
    const cfg = this.cfg;
    if (sim.slideActive) this.exitSlide('jumpCancel');

    // Jumping out of a crouch is only allowed where the taller capsule fits, which is
    // what stops a jump from launching the player through a low ceiling.
    if (sim.stance === 'CROUCH' && !this.fitsHere(cfg.standHeight)) return;

    sim.vy = jumpVelocity(cfg);
    sim.grounded = false;
    sim.coyote = 0;
    sim.jumpBuffer = 0;
    sim.jumpedThisTick = true;
    sim.airSpeedCap = Math.max(sim.speed, cfg.sprintSpeed);
    this.setStance('AIRBORNE');

    evJump.entityId = this.entityId;
    evJump.x = sim.x;
    evJump.y = sim.y;
    evJump.z = sim.z;
    evJump.horizontalSpeed = sim.speed;
    this.bus.emit(EV.PlayerJumped, evJump);
  }

  private slideExitReason(crouchHeld: boolean, cfg: MovementConfig): SlideEndReason | null {
    const sim = this.sim;
    if (sim.slideElapsed >= cfg.slideDuration) return 'expired';
    if (!crouchHeld) return 'crouchReleased';
    if (sim.slideSpeed < cfg.slideMinSpeed) return 'tooSlow';
    if (sim.slideAirTime > 0.1) return 'blocked';
    return null;
  }

  /**
   * The single exit from a slide. Both LOCKED penalties are applied inside
   * `endSlide`, so no route out of a slide can skip the tac-sprint lockout.
   * Horizontal velocity is left untouched, which is what carries a jump-cancel.
   */
  private exitSlide(reason: SlideEndReason): void {
    const sim = this.sim;
    const exitSpeed = sim.speed;
    endSlide(sim, this.cfg);

    if (reason === 'jumpCancel') {
      this.setStance('AIRBORNE');
    } else if (this.crouchHeldThisTick || !this.fitsHere(this.cfg.standHeight)) {
      this.setStance('CROUCH');
    } else {
      this.setStance('STAND');
    }

    evSlideEnd.entityId = this.entityId;
    evSlideEnd.reason = reason;
    evSlideEnd.exitSpeed = exitSpeed;
    evSlideEnd.tick = sim.tick;
    this.bus.emit(EV.PlayerSlideEnded, evSlideEnd);
  }

  private updateCrouchStance(crouchHeld: boolean): void {
    const sim = this.sim;
    if (!sim.grounded || sim.stance === 'AIRBORNE' || sim.stance === 'MANTLE') return;
    if (crouchHeld) {
      if (sim.stance !== 'CROUCH') this.setStance('CROUCH');
      return;
    }
    // No standing up inside a vent (S5.3): blocked, not clipped.
    if (sim.stance === 'CROUCH' && this.fitsHere(this.cfg.standHeight)) this.setStance('STAND');
  }

  private fitsHere(height: number): boolean {
    return capsuleFits(this.world, this.cfg, this.sim.x, this.sim.y, this.sim.z, height);
  }

  private setStance(next: StanceId): void {
    const sim = this.sim;
    if (sim.stance === next) return;
    if (!isLegalStanceTransition(sim.stance, next)) {
      console.warn(`[PlayerController] illegal stance transition ${sim.stance} -> ${next}`);
      return;
    }
    evStance.entityId = this.entityId;
    evStance.from = sim.stance;
    evStance.to = next;
    evStance.tick = sim.tick;
    sim.stance = next;
    sim.capsuleHeight = capsuleHeightFor(this.cfg, next);
    this.bus.emit(EV.PlayerStanceChanged, evStance);
  }

  /** Eye smoothing, head bob and footstep cadence. Runs on every path out of step(). */
  private finishTick(buttons: number): void {
    const sim = this.sim;
    const cfg = this.cfg;

    const targetEye = eyeHeightFor(cfg, sim.stance);
    sim.eyeHeight = damp(sim.eyeHeight, targetEye, EYE_DAMP_RATE, DT);

    const speed = sim.speed;
    if (sim.grounded && speed > 0.4 && sim.stance !== 'MANTLE') {
      // Bob phase advances with distance travelled, not time, so cadence tracks speed.
      const stride = Math.max(cfg.footstepStride, 0.2);
      sim.bobPhase = (sim.bobPhase + (speed * DT * TAU) / stride) % TAU;
      sim.distanceSinceStep += speed * DT;
      const strideForStance = sim.stance === 'CROUCH' ? stride * 1.35 : stride;
      if (sim.distanceSinceStep >= strideForStance * 0.5) {
        sim.distanceSinceStep = 0;
        evStep.entityId = this.entityId;
        evStep.x = sim.x;
        evStep.y = sim.y;
        evStep.z = sim.z;
        evStep.speed = speed;
        evStep.heavy = sim.tacSprintActive || sim.sprintActive;
        evStep.quiet = sim.stance === 'CROUCH' || sim.stance === 'SLIDE';
        evStep.material = sim.groundMaterial;
        this.bus.emit(EV.PlayerFootstep, evStep);
      }
    } else if (!sim.grounded) {
      sim.distanceSinceStep = 0;
    }

    sim.prevButtons = buttons;
    sim.writeSnapshot(this.curr, this.strafeInput);
  }
}
