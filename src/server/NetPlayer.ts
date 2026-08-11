import type { BotTeam, Combatant } from '../shared/ai/Combatant';
import {
  DEATH_VARIANTS,
  deathVariantFor,
  makeBotVisualState,
  type BotVisualState,
} from '../shared/ai/BotVisualState';
import type { DamageSystem } from '../shared/combat/DamageSystem';
import { HitboxRig, HUMANOID_RIG } from '../shared/combat/HitboxRig';
import type { GameBus } from '../shared/core/Events';
import type { InputCommand } from '../shared/core/InputCommand';
import { DT } from '../shared/core/Loop';
import type { PerkState } from '../shared/perks/PerkState';
import { Health, type HealthConfig } from '../shared/player/Health';
import type { MovementConfig } from '../shared/player/MovementConfig';
import { PlayerController } from '../shared/player/PlayerController';
import { savePlayerSim, type PlayerSimState, makePlayerSimState } from '../shared/player/PlayerState';
import type { ViewmodelConfig } from '../shared/weapons/ViewmodelConfig';
import type { WeaponDef } from '../shared/weapons/WeaponDefs';
import { WeaponSystem } from '../shared/weapons/WeaponSystem';
import type { CollisionWorld } from '../shared/world/CollisionWorld';
import { InputBuffer } from './net/InputBuffer';

/**
 * A connected human, on the server (M10, S4.15).
 *
 * ## It is a `Bot` with a socket where the brain would be
 *
 * That is not a figure of speech, it is the architecture. S4.15: *"A bot is a server-side
 * entity whose `BotBrain` produces `InputCommand`s fed into the exact same pipeline a remote
 * human's commands enter. This is the symmetry M3 deliberately built."* Compare this class to
 * `shared/ai/Bot.ts` and the only structural difference is where the command comes from —
 * `BotBrain.steer` there, `InputBuffer.take` here. Everything downstream is identical:
 * `PlayerController.step`, then `WeaponSystem.step`, then the rig follows the capsule.
 *
 * The consequence is the thing worth stating: a human gets recoil, spread, sprint-to-fire,
 * reload timing, slide rules and mantle detection **for free and identically**, because it is
 * not a separate implementation. That is also why S8.7 can demand identical TTK in
 * single-player and networked — there is only one weapon system, and it is this one.
 *
 * ## It is a `Combatant`
 *
 * So bots perceive it, spawn safety scores against it, and `DamageSystem` resolves rounds
 * into it, with no code in `ai/` knowing that a human is not a bot.
 */

export interface NetPlayerDeps {
  readonly world: CollisionWorld;
  readonly bus: GameBus;
  readonly damage: DamageSystem;
  readonly movement: MovementConfig;
  readonly healthConfig: HealthConfig;
  readonly viewmodelConfig: ViewmodelConfig;
  readonly weaponDef: WeaponDef;
  readonly secondaryDef: WeaponDef;
  /** The resolved perks this player is carrying. `NO_PERKS` for anything without a loadout. */
  readonly perks: PerkState;
}

export class NetPlayer implements Combatant {
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly health: Health;
  readonly controller: PlayerController;
  readonly weapons: WeaponSystem;
  readonly input = new InputBuffer();

  /** The M3 animation seam, replicated verbatim so a human animates like a bot (S6.5). */
  readonly visual: BotVisualState = makeBotVisualState();

  /** Authoritative sim state as of the last tick, for the owner block in a snapshot. */
  readonly simState: PlayerSimState = makePlayerSimState();

  kills = 0;
  deaths = 0;
  shotsFired = 0;
  shotsHit = 0;

  /** Seconds until this player may respawn. Zero when alive or free to return. */
  respawnTimer = 0;

  /**
   * Cleared while the match has not started or the player is between lives.
   *
   * Same mechanism as `PlayerCombatant.active` and `Spectator.participating`: an entity that
   * is not participating is invisible to perception and to spawn scoring, but still exists,
   * still has a rig, and still ticks.
   */
  active = false;

  private readonly deps: NetPlayerDeps;
  private alive_ = false;
  private readonly residual = { yaw: 0, pitch: 0 };

  /** The last command actually simulated. The ack the client reconciles against. */
  private lastCommandSeq = -1;
  private lastCommandTick = -1;

  /**
   * Buttons from the last simulated command.
   *
   * Replicated as the `Firing` flag. "Is this player firing" is a fact about their *trigger*,
   * not about their weapon: a weapon between rounds in a burst, or dry, is still being fired,
   * and a remote player holding a trigger on an empty magazine should read as trying to
   * shoot. The weapon's own state cannot express that and the command can.
   */
  lastButtons = 0;
  /** The whole of the last command consumed, or null before the first. See `advance`. */
  lastCommand: InputCommand | null = null;

  constructor(
    readonly entityId: number,
    readonly displayName: string,
    public team: BotTeam,
    deps: NetPlayerDeps,
  ) {
    this.deps = deps;
    this.health = new Health(deps.healthConfig);
    this.controller = new PlayerController(deps.movement, deps.world, deps.bus, entityId);
    this.weapons = new WeaponSystem(
      deps.weaponDef,
      deps.secondaryDef,
      deps.world,
      deps.damage,
      deps.bus,
      deps.viewmodelConfig,
      deps.movement.walkSpeed,
      entityId,
      // A remote player's muzzle is a world position, not a viewmodel offset: nobody is
      // looking down this player's sights except them, and they compute their own.
      'world',
    );
    // Per-entity salt so two players firing the same weapon on the same tick do not draw
    // identical spread. Since M10 this is a salt, not a stream position — see `WeaponSystem`.
    this.weapons.reseed(0x5bf0_3d17 ^ (entityId * 0x9e37_79b9));

    /**
     * Lightweight, on the authoritative side.
     *
     * The same assignment `MatchMeta.applyPerkHooks` makes on the client, and it has to be the
     * same or `PlayerController.step` stops being a pure function of (state, command) across the
     * two runtimes — which is the property reconciliation depends on. A perk the server has not
     * been told about is not a perk; it is a permanent misprediction.
     */
    this.controller.speedScale = deps.perks.moveSpeedMult;
    this.perks_ = deps.perks;
  }

  /**
   * The live perk state.
   *
   * A field rather than a read-through to `deps`, because a class can now change mid-session
   * (§6.6) and `deps` is the class this player *joined* with. Everything that asks about perks
   * — bot perception's Dead Silence check, the streak system's discount — must see the current
   * answer, not the founding one.
   */
  private perks_: PerkState;

  /** The perks this player is carrying. Read by bot perception and the streak system. */
  get perks(): PerkState {
    return this.perks_;
  }

  /**
   * Swap this player's class, in one place, at one moment (M11, §6.6, Tier 1 #20).
   *
   * Called **only** from `ServerMatch.spawnPlayer`, and that is the whole safety argument.
   * Handover #20 rule 3: *"Applying a class change live to a standing networked world
   * reintroduced the same divergence by another door. Deferring to next spawn is CoD behaviour
   * anyway."*
   *
   * The divergence it avoids is precise. `controller.speedScale` is an input to
   * `PlayerController.step`, which reconciliation requires to be a pure function of (state,
   * command) **across both runtimes**. Change it on the server on tick N and on the client on
   * tick N+3 and every tick in between is a misprediction — the same arithmetic as the original
   * bug, just bounded. A spawn is the one moment both sides already agree is a discontinuity:
   * the client adopts the authoritative pose and discards its prediction ring there anyway.
   */
  applyLoadout(primary: WeaponDef, secondary: WeaponDef, perks: PerkState): void {
    this.weapons.equip(0, primary);
    this.weapons.equip(1, secondary);
    this.perks_ = perks;
    this.controller.speedScale = perks.moveSpeedMult;
  }

  // -- Combatant -------------------------------------------------------------

  get px(): number {
    return this.controller.sim.x;
  }
  get py(): number {
    return this.controller.sim.y;
  }
  get pz(): number {
    return this.controller.sim.z;
  }
  get yaw(): number {
    return this.controller.sim.yaw;
  }
  get vx(): number {
    return this.controller.sim.vx;
  }
  get vz(): number {
    return this.controller.sim.vz;
  }
  get eyeHeight(): number {
    return this.controller.sim.eyeHeight;
  }
  get aimHeight(): number {
    return 1.26 * this.rig.heightScale;
  }
  get quiet(): boolean {
    const stance = this.controller.sim.stance;
    return stance === 'CROUCH' || stance === 'SLIDE';
  }
  get participating(): boolean {
    return this.active && this.health.alive;
  }
  get glinting(): boolean {
    return this.weapons.glinting;
  }

  get alive(): boolean {
    return this.alive_;
  }

  get ackSeq(): number {
    return this.lastCommandSeq;
  }

  get ackTick(): number {
    return this.lastCommandTick;
  }

  // -- lifecycle -------------------------------------------------------------

  spawn(x: number, y: number, z: number, yaw: number): void {
    this.alive_ = true;
    this.active = true;
    this.health.reset();
    this.controller.spawn(x, y, z, yaw);
    this.weapons.reset();
    this.respawnTimer = 0;
    this.visual.spawnSerial++;
    this.rig.heightScale = 1;
    this.rig.setTransform(x, y, z, yaw);
    savePlayerSim(this.controller.sim, this.simState);
  }

  /** Killed. `dx/dz` is the direction the round was travelling, for the fall (S6.8). */
  onKilled(dx: number, dz: number, respawnSeconds: number): void {
    if (!this.alive_) return;
    this.alive_ = false;
    this.deaths++;
    this.respawnTimer = respawnSeconds;
    const v = this.visual;
    v.deathSerial++;
    v.deathDirX = dx;
    v.deathDirZ = dz;
    v.deathVariant = deathVariantFor(this.entityId, v.deathSerial, DEATH_VARIANTS);
    // The sights come down immediately, exactly as they do for a local player on death.
    this.weapons.clearAim();
  }

  /** A non-fatal hit. Only the flinch serial matters here; there is no blackboard. */
  onHurt(dx: number, dz: number): void {
    const v = this.visual;
    v.flinchSerial++;
    v.flinchDirX = dx;
    v.flinchDirZ = dz;
  }

  // -- per-tick --------------------------------------------------------------

  /**
   * One authoritative tick.
   *
   * `frozen` is the pre-match countdown, and is applied the same way `Bot.advance` applies
   * it: the command still arrives and the view angles still take effect, but the movement
   * axes and action bits are stripped. A frozen player can still look around, which is what
   * makes the countdown read as a starting gun rather than a freeze frame.
   */
  step(tick: number, frozen: boolean): void {
    this.health.step();

    if (!this.alive_) {
      if (this.respawnTimer > 0) this.respawnTimer = Math.max(0, this.respawnTimer - DT);
      // The rig is left where it fell. `Rewind.record` still samples it every tick, so a
      // round fired 150 ms ago at a player who has since died still resolves against where
      // they were when the trigger was pulled.
      return;
    }

    const cmd = this.input.take(tick);

    /**
     * The ack is the seq **actually simulated this tick** — not the newest one received.
     *
     * This distinction was a real bug and it is worth recording, because the symptom pointed
     * nowhere near the cause. A client runs ahead by `RTT/2 + jitter` (S4.11), so by the time
     * the server simulates tick N it has already *received and buffered* the commands for
     * ticks N+1 to N+4. Acking `input.lastSeq` therefore told the client "I have processed
     * seq S+4" while the accompanying state was the result of seq S.
     *
     * The client then compared its prediction after S+4 against the server's state after S,
     * found them a few centimetres apart, and corrected — every single snapshot. Measured at
     * zero added latency: **135 mispredictions in 200 comparisons**, p50 5.3 cm, which is
     * almost exactly four ticks of walking. S8.4 requires that number to be zero, and it is
     * the criterion precisely because a permanently wrong ack is invisible in every other way
     * — the game plays, the player moves, and prediction is silently doing nothing.
     *
     * A repeated command keeps its original seq, which is correct: the newest command the
     * server has genuinely processed has not changed.
     */
    if (cmd.seq >= 0) this.lastCommandSeq = cmd.seq;
    this.lastCommandTick = tick;

    if (frozen) {
      // A copy rather than a mutation: `InputBuffer.take` can hand back the record it keeps
      // for gap-filling, and zeroing that would make the repeat permanent.
      frozenCmd.seq = cmd.seq;
      frozenCmd.tickIndex = cmd.tickIndex;
      frozenCmd.moveX = 0;
      frozenCmd.moveZ = 0;
      frozenCmd.yaw = cmd.yaw;
      frozenCmd.pitch = cmd.pitch;
      frozenCmd.buttons = 0;
      frozenCmd.sampledAtMs = 0;
      this.advance(frozenCmd);
      return;
    }

    this.advance(cmd);
  }

  private advance(cmd: InputCommand): void {
    this.lastButtons = cmd.buttons;
    /**
     * Kept whole for the Chopper Gunner (M11 Gate B).
     *
     * `lastButtons` is enough for everything that only asks "was the trigger down"; a gunner
     * flies with the aim angles too. Held by reference rather than copied because the streak
     * system reads it inside the same tick it was written, before `InputBuffer` can hand the
     * record to anybody else.
     */
    this.lastCommand = cmd;
    this.controller.step(cmd);
    const sim = this.controller.sim;
    this.weapons.step(cmd, sim);

    // The unrecovered half of a recoil kick is a real aim change. On a client it goes into
    // the mouse look; here it is folded into the authoritative yaw and pitch so the server's
    // idea of where this player is pointing matches what their own prediction produced.
    if (this.weapons.takeViewResidual(this.residual)) {
      sim.yaw += this.residual.yaw;
      sim.pitch += this.residual.pitch;
    }

    this.rig.heightScale = sim.capsuleHeight / Math.max(this.deps.movement.standHeight, 1e-3);
    this.rig.setTransform(sim.x, sim.y, sim.z, sim.yaw);
    savePlayerSim(sim, this.simState);
  }
}

/** Scratch for the frozen-countdown command. One per process; never escapes a tick. */
const frozenCmd = {
  seq: 0,
  tickIndex: 0,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  sampledAtMs: 0,
};
