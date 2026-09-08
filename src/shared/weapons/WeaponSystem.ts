import { makeDamageRequest, PLAYER_ENTITY_ID, type DamageRequest, type DamageSystem } from '../combat/DamageSystem';
import type { HitZone } from '../combat/HitboxRig';
import { shotsFrom } from '../combat/ShotAccounting';
import { EV, type GameBus } from '../core/Events';
import { Btn, isDown, justPressed, type InputCommand } from '../core/InputCommand';
import { clamp01, DEG2RAD, lerp, TAU } from '../core/MathUtil';
import { eventSeed, Rng } from '../core/Rng';
import type { PlayerSim } from '../player/PlayerState';
import type { CollisionWorld } from '../world/CollisionWorld';
import { Ballistics, makeShotTrace, type ShotTrace } from './Ballistics';
import { Inventory } from './Inventory';
import { aimWithOffset, makeAimSample, pelletOffset, Recoil, type AimSample, type SpreadContext } from './Recoil';
import { ScopeState } from './Scope';
import type { ViewmodelConfig } from './ViewmodelConfig';
import { makeWeaponInput, type Weapon, type WeaponInput } from './WeaponBase';
import { MAX_PELLETS, type WeaponDef } from './WeaponDefs';
import { simCos, simSin } from '../core/SimMath';

/**
 * The seam between "the player pressed a button" and "a round landed".
 *
 * Runs entirely on sim ticks. It reads one `InputCommand`, drives the weapon state
 * machine, resolves the shot through `Ballistics`, and emits events — it never touches
 * the renderer, the HUD or the audio graph. Everything visible or audible is wired up in
 * `Game` from the events this emits, which is what lets the headless harness fire a full
 * magazine and read the shot placements back with no browser in the loop.
 *
 * The one thing that leaves this class other than an event is the **view residual**: the
 * unrecovered part of each recoil kick, which has to reach the same place mouse movement
 * does. See `takeViewResidual`.
 *
 * M5 added three things and no new weapon classes: an `Inventory` of two slots with a swap
 * between them, a pellet loop for the shotgun, and a `ScopeState` for the snipers. All three
 * are driven from fields on the `WeaponDef`.
 */

export interface WeaponSnapshot {
  raise: number;
  adsFraction: number;
  visualPunch: number;
  visualLateral: number;
  aimPitch: number;
  aimYaw: number;
  reloadFraction: number;
  /** 0 = holstered / mid-swap, 1 = the active weapon is the one being drawn. */
  swapFraction: number;
}

function makeSnapshot(): WeaponSnapshot {
  return {
    raise: 1,
    adsFraction: 0,
    visualPunch: 0,
    visualLateral: 0,
    aimPitch: 0,
    aimYaw: 0,
    reloadFraction: 0,
    swapFraction: 1,
  };
}

/**
 * Where a shot's muzzle position comes from.
 *
 * `viewmodel` is the local player: the gun is drawn at its own FOV so its barrel has no
 * real world position, and the offset that *looks* right is taken from `ViewmodelConfig`.
 * `world` is everybody else: the muzzle is a fixed offset from the eye, because a bot's
 * rifle is actual geometry standing in the room and its tracer has to start at it.
 */
export type MuzzleStyle = 'viewmodel' | 'world';

/** Third-person muzzle offset from the eye, metres: forward, right, down. */
const WORLD_MUZZLE_FORWARD = 0.44;
const WORLD_MUZZLE_RIGHT = 0.16;
const WORLD_MUZZLE_DOWN = 0.16;

const evFired = {
  weaponId: '',
  sourceId: 0,
  x: 0,
  y: 0,
  z: 0,
  dx: 0,
  dy: 0,
  dz: -1,
  endX: 0,
  endY: 0,
  endZ: 0,
  distance: 0,
  shotIndex: 0,
  spreadDeg: 0,
  tracer: false,
  hitTarget: false,
  ammoInMag: 0,
  pellets: 1,
  pelletsHit: 0,
  minimapPing: true,
};

/** Per-pellet record for the S8.5 read-out. Fixed length, written in place. */
export interface PelletReport {
  count: number;
  hits: number;
  damage: number;
  readonly zones: HitZone[];
  readonly targets: number[];
}

export class WeaponSystem {
  readonly inventory: Inventory;
  readonly recoil = new Recoil();
  readonly scope = new ScopeState();
  readonly ballistics: Ballistics;
  readonly trace: ShotTrace = makeShotTrace();

  readonly prev: WeaponSnapshot = makeSnapshot();
  readonly curr: WeaponSnapshot = makeSnapshot();

  /** The last trigger pull broken down by pellet (S8.5). */
  readonly lastPellets: PelletReport = {
    count: 0,
    hits: 0,
    damage: 0,
    zones: new Array<HitZone>(MAX_PELLETS).fill('torso'),
    targets: new Array<number>(MAX_PELLETS).fill(-1),
  };

  /** Degrees of view change owed to the player's actual aim. Consumed once per tick. */
  private residualYaw = 0;
  private residualPitch = 0;

  /** Current cone half-angle in degrees, for the crosshair and the debug ring. */
  spreadDeg = 0;

  /**
   * The spread generator, reseeded per shot rather than run as a stream (M10, S4.14).
   *
   * See `eventSeed`. Every draw inside one `fireOne` comes from a state derived only from
   * `(salt, tickIndex, sourceId, shotIndex)`, so a replayed tick reproduces the shot exactly
   * and the server reaches the same answer without replaying anything.
   */
  private readonly rng = new Rng(0x51e5_0b0a);

  /**
   * Per-instance salt folded into every shot seed.
   *
   * This is what `reseed()` now sets. Before M10 it re-keyed a running stream, which is how
   * each bot got its own spread pattern; the same call still gives each bot its own pattern,
   * because the salt is one of the four inputs to the seed. What changed is that the pattern
   * no longer depends on *how many shots have already been fired*.
   */
  private shotSalt = 0x51e5_0b0a;
  private readonly input: WeaponInput = makeWeaponInput();
  private readonly idleInput: WeaponInput = makeWeaponInput();
  private readonly aim: AimSample = makeAimSample();
  private readonly pelletAim: AimSample = makeAimSample();
  private readonly pelletOff = { ax: 0, ay: 0 };
  private readonly spreadCtx: SpreadContext = {
    moveFraction: 0,
    adsFraction: 0,
    crouched: false,
    airborne: false,
  };
  private readonly request: DamageRequest;
  private prevButtons = 0;
  private tracerCounter = 0;

  /**
   * `sourceId` and `muzzleStyle` are M3's additions and they are the only two things that
   * differ between the player's weapon and a bot's. Everything else — recoil, spread,
   * sprint-to-fire, reloads, falloff, penetration — is shared, which is the point: a bot
   * that fired by calling `Ballistics` directly would be a bot that ignores every balance
   * number in the def.
   *
   * `secondary` is null for a bot. Nothing in `ai/` swaps weapons, and giving a bot a
   * holstered pistol it will never draw is a second magazine to keep in sync for nothing.
   */
  constructor(
    def: WeaponDef,
    secondary: WeaponDef | null,
    world: CollisionWorld,
    damage: DamageSystem,
    private readonly bus: GameBus,
    private readonly viewmodelConfig: ViewmodelConfig,
    private readonly walkSpeed: number,
    readonly sourceId: number = PLAYER_ENTITY_ID,
    private readonly muzzleStyle: MuzzleStyle = 'viewmodel',
  ) {
    this.inventory = new Inventory(def, secondary, bus, sourceId);
    this.ballistics = new Ballistics(world, damage, bus);
    this.request = makeDamageRequest(def);
    this.request.sourceId = sourceId;
    this.idleInput.lowering = true;
  }

  /** The weapon actually in the player's hands. */
  get weapon(): Weapon {
    return this.inventory.active;
  }

  get definition(): WeaponDef {
    return this.inventory.active.definition;
  }

  /** Live retune from the debug panel. Applies to the active slot. */
  setDefinition(def: WeaponDef): void {
    this.inventory.retuneSlot(this.inventory.activeSlotIndex, def);
  }

  /** Put a different weapon in a slot: 0 primary, 1 secondary. */
  equip(slotIndex: number, def: WeaponDef): void {
    this.inventory.setSlot(slotIndex, def);
    this.recoil.reset();
    this.scope.reset();
  }

  /** Whether an enemy can currently see this shooter's scope glint (S6.1). */
  get glinting(): boolean {
    return ScopeState.glinting(this.definition, this.inventory.active.adsFraction);
  }

  /** Whether a laser dot is currently painted for enemies to see (S6.2). */
  get laserVisible(): boolean {
    const def = this.definition;
    return def.laserVisible && this.inventory.active.adsFraction > 0.4;
  }

  /**
   * Set this weapon's spread salt (S6.2, S4.14).
   *
   * Callers use it to give a shooter its own pattern — each bot passes its own seed, and the
   * arsenal harnesses pass a fixed one so a recorded group is reproducible. Since M10 it sets
   * the salt rather than re-keying a stream; see `shotSalt`.
   */
  reseed(seed: number): void {
    this.shotSalt = seed >>> 0;
  }

  /**
   * Read the spread stream's state into `out` (M9, S6.6).
   *
   * The cross-runtime hash folds this in alongside the pose. Two runtimes whose player is in
   * the same place but whose spread stream has advanced by a different number of draws *have*
   * diverged — the next shot will prove it — and a hash that only covered position would call
   * that agreement and let it through to M10 as an unexplainable reconciliation error.
   *
   * `out` is caller-owned and reused; nothing is allocated.
   */
  rngState(out: Int32Array): void {
    this.rng.saveState(out);
  }

  /**
   * Take the sights down now, without waiting for a tick (post-M8 playtest).
   *
   * Called when the player is killed. Both snapshots are rewritten, not just the current one:
   * the render pass interpolates between them, so leaving `prev` at full ADS would blend the
   * camera back out of the scope over a frame instead of cutting, and on a sniper that reads
   * as the zoom sticking rather than as a transition.
   */
  clearAim(): void {
    for (const weapon of this.inventory.all) weapon.clearAds();
    this.scope.reset();
    this.writeSnapshot(this.curr);
    this.writeSnapshot(this.prev);
  }

  reset(): void {
    this.inventory.reset();
    this.recoil.reset();
    this.scope.reset();
    this.residualYaw = 0;
    this.residualPitch = 0;
    this.prevButtons = 0;
    this.tracerCounter = 0;
    this.lastPellets.count = 0;
    this.lastPellets.hits = 0;
    this.lastPellets.damage = 0;
    this.writeSnapshot(this.curr);
    this.writeSnapshot(this.prev);
  }

  /**
   * The view residual, in radians, for the caller to fold into the player's absolute
   * view angles. Returns zero once consumed.
   *
   * This is the one output that is not an event, and it has to be: recoil that recovers
   * *exactly* to the origin has no weight, so part of every kick becomes permanent aim
   * change — and permanent aim change is the same quantity mouse movement produces, so
   * it belongs in the same place (S6.2).
   */
  takeViewResidual(out: { yaw: number; pitch: number }): boolean {
    if (this.residualYaw === 0 && this.residualPitch === 0) return false;
    out.yaw = this.residualYaw * DEG2RAD;
    out.pitch = this.residualPitch * DEG2RAD;
    this.residualYaw = 0;
    this.residualPitch = 0;
    return true;
  }

  /** One simulation tick. */
  /**
   * Set true while something else owns the player's hands (a grenade cook or throw).
   *
   * Written by `Match` from `ThrowController.busy` before `step` runs, so there is one
   * answer to "is the weapon available" and the viewmodel reads the same flag.
   */
  fireBlocked = false;

  /**
   * Set true while the player is not with this weapon at all (post-M8).
   *
   * `fireBlocked` says "the hands are busy" — the weapon is still in them, it simply cannot
   * be fired this instant. This says something stronger: the player is flying a Chopper
   * Gunner, so the trigger, the sights and the reload key all belong to something else and
   * none of them should reach the rifle standing on the ground.
   *
   * It is a separate flag rather than a wider `fireBlocked` because the two have different
   * answers for ADS. A grenade cook leaves the sights available; a camera takeover must
   * not, or the ADS button silently aims a weapon a kilometre away and the scope overlay
   * takes the crosshair off the gunship's screen.
   */
  suspended = false;

  step(cmd: InputCommand, sim: PlayerSim): void {
    copySnapshot(this.curr, this.prev);

    const buttons = cmd.buttons;
    const prevButtons = this.prevButtons;
    this.prevButtons = buttons;

    // The swap machine runs first so the weapon that steps below is the right one.
    if (justPressed(buttons, prevButtons, Btn.SwapWeapon)) this.inventory.requestToggle();
    if (justPressed(buttons, prevButtons, Btn.Slot1)) this.inventory.requestSwap(0);
    if (justPressed(buttons, prevButtons, Btn.Slot2)) this.inventory.requestSwap(1);
    const swapLower = this.inventory.step();

    const wi = this.input;
    // `fireBlocked` is set by whatever currently owns the hands — right now that is only
    // the grenade throw. Applied to the *input* rather than to the weapon, so a blocked
    // trigger behaves exactly like a trigger nobody pulled: no dry-fire click, no auto
    // reload, and releasing during the block does not queue a shot for when it lifts.
    const blocked = this.fireBlocked || this.suspended;
    wi.fireHeld = !blocked && isDown(buttons, Btn.Fire);
    wi.firePressed = !blocked && justPressed(buttons, prevButtons, Btn.Fire);
    // `suspended` takes the sights too, which `fireBlocked` deliberately does not. See the
    // field comment: this is the difference between busy hands and an absent player.
    wi.adsHeld = !this.suspended && isDown(buttons, Btn.Ads);
    wi.reloadPressed = !this.suspended && justPressed(buttons, prevButtons, Btn.Reload);
    // Anything that puts the weapon out of the fight lowers it. A slide no longer does:
    // M4 playtesting called firing mid-slide missing, and it is — the cost is now a spread
    // penalty in `SpreadContext` rather than a weapon you cannot use.
    wi.lowering = sim.sprintActive || sim.tacSprintActive || sim.mantleActive || swapLower || this.suspended;

    const weapon = this.inventory.active;
    const def = weapon.definition;

    weapon.step(wi);
    this.inventory.stepIdle(weapon, this.idleInput);
    this.recoil.step(def);
    // Hold-breath is Shift (S6.1), which is the sprint bit — see HOLD_BREATH_BIT.
    this.scope.step(def, weapon.adsFraction, isDown(buttons, Btn.Sprint));

    // Releasing the trigger restarts the pattern; so does finishing a reload. Both are
    // "the player let go", and both are what make the pattern learnable rather than a
    // running total across a whole match.
    if (!wi.fireHeld || weapon.reloadFinishedThisTick) this.recoil.resetPattern();

    this.spreadCtx.moveFraction = clamp01(sim.speed / Math.max(this.walkSpeed, 0.1));
    this.spreadCtx.adsFraction = weapon.adsFraction;
    this.spreadCtx.crouched = sim.stance === 'CROUCH';
    this.spreadCtx.airborne = !sim.grounded || sim.slideActive;
    this.spreadDeg = this.recoil.spreadDegrees(def, this.spreadCtx);

    while (weapon.pendingShots > 0) {
      if (!weapon.consumeShot()) break;
      this.fireOne(cmd, sim, def);
    }

    this.writeSnapshot(this.curr);
  }

  /** Interpolated visual state for the render pass. */
  sample(alpha: number, out: WeaponSnapshot): void {
    const a = this.prev;
    const b = this.curr;
    out.raise = lerp(a.raise, b.raise, alpha);
    out.adsFraction = lerp(a.adsFraction, b.adsFraction, alpha);
    out.visualPunch = lerp(a.visualPunch, b.visualPunch, alpha);
    out.visualLateral = lerp(a.visualLateral, b.visualLateral, alpha);
    out.aimPitch = lerp(a.aimPitch, b.aimPitch, alpha);
    out.aimYaw = lerp(a.aimYaw, b.aimYaw, alpha);
    out.reloadFraction = lerp(a.reloadFraction, b.reloadFraction, alpha);
    out.swapFraction = lerp(a.swapFraction, b.swapFraction, alpha);
  }

  // -- internals -------------------------------------------------------------

  private fireOne(cmd: InputCommand, sim: PlayerSim, def: WeaponDef): void {
    const recoil = this.recoil;
    const ads = this.inventory.active.adsFraction;

    /**
     * Per-event seeding (S4.14). Everything random about this shot is decided from here.
     *
     * `recoil.shotIndex` is read before `recoil.onShot` advances it below, so it is stable
     * for the whole of this call — which is what lets the aim sample, the pellet rotation
     * and every pellet's jitter come out of one seed and still be reproducible individually.
     *
     * The authored recoil *pattern* is untouched: it was already deterministic in `shotIndex`
     * (M2) and S4.14 says so explicitly. This governs only the random component on top.
     */
    const shotIndex = recoil.shotIndex;
    this.rng.reseed(eventSeed(this.shotSalt, cmd.tickIndex, this.sourceId, shotIndex));

    // The shot uses the aim as it stands *before* this shot's kick: the first round out
    // of a rested weapon is dead on the crosshair, which is the contract every shooter
    // makes with the player. Scope sway is part of where you are aiming, so it is in here
    // and not a camera-only effect.
    const yaw = cmd.yaw + (recoil.aimYaw + this.scope.swayYaw) * DEG2RAD;
    const pitch = cmd.pitch + (recoil.aimPitch + this.scope.swayPitch) * DEG2RAD;
    recoil.sampleAim(yaw, pitch, this.spreadDeg, this.rng, this.aim);

    // Rounds leave the eye, not the barrel: a shot that originated at the viewmodel's
    // muzzle would clip walls the player can plainly see past.
    const eyeX = sim.x;
    const eyeY = sim.y + sim.eyeHeight;
    const eyeZ = sim.z;

    this.request.weapon = def;
    // The same clamp everything that counts shots applies — `combat/ShotAccounting` is the
    // other reader of this number and has to agree with the loop that produced it (round 5, B5).
    const pellets = shotsFrom(def);
    const report = this.lastPellets;
    report.count = pellets;
    report.hits = 0;
    report.damage = 0;

    // Pellet 0 is the aim sample itself; the rest are laid out around it. The whole
    // pattern is rotated per pull so two shots are never identical.
    const rotation = this.rng.float() * TAU;
    let anyHit = false;
    for (let i = 0; i < pellets; i++) {
      let dx = this.aim.dx;
      let dy = this.aim.dy;
      let dz = this.aim.dz;
      if (i > 0) {
        pelletOffset(i, pellets, def.pelletSpread, rotation, this.rng.range(0.86, 1.08), this.pelletOff);
        aimWithOffset(
          yaw,
          pitch,
          this.aim.ax + this.pelletOff.ax,
          this.aim.ay + this.pelletOff.ay,
          this.pelletAim,
        );
        dx = this.pelletAim.dx;
        dy = this.pelletAim.dy;
        dz = this.pelletAim.dz;
      }

      this.ballistics.fire(eyeX, eyeY, eyeZ, dx, dy, dz, def, this.request, this.trace);

      if (this.trace.hitTarget) {
        anyHit = true;
        report.hits++;
        report.damage += this.trace.damage;
        report.zones[i] = this.trace.zone;
        report.targets[i] = this.trace.targetId;
      } else {
        report.zones[i] = 'torso';
        report.targets[i] = -1;
      }

      // The event carries the *first* pellet's terminus, which is the one the tracer and
      // the impact report belong to. Every pellet already emitted its own `bullet.impact`
      // from inside `Ballistics`, so the decals and debris are per pellet either way.
      if (i === 0) {
        evFired.endX = this.trace.endX;
        evFired.endY = this.trace.endY;
        evFired.endZ = this.trace.endZ;
        evFired.distance = this.trace.distance;
        evFired.dx = dx;
        evFired.dy = dy;
        evFired.dz = dz;
      }
    }

    recoil.onShot(def, ads);
    this.residualYaw += recoil.residualYaw;
    this.residualPitch += recoil.residualPitch;
    recoil.residualYaw = 0;
    recoil.residualPitch = 0;

    // Roughly one round in three draws a tracer (S6.5), counted rather than diced so the
    // spacing is even instead of clumping.
    this.tracerCounter++;
    const every = def.tracerFraction <= 0 ? 0 : Math.max(1, Math.round(1 / def.tracerFraction));
    const tracer = every > 0 && this.tracerCounter % every === 0;

    const muzzle = this.muzzleWorld(cmd, sim);
    evFired.weaponId = def.id;
    evFired.sourceId = this.sourceId;
    evFired.x = muzzle.x;
    evFired.y = muzzle.y;
    evFired.z = muzzle.z;
    evFired.shotIndex = shotIndex;
    evFired.spreadDeg = this.spreadDeg;
    evFired.tracer = tracer;
    evFired.hitTarget = anyHit;
    evFired.ammoInMag = this.inventory.active.mag;
    evFired.pellets = pellets;
    evFired.pelletsHit = report.hits;
    evFired.minimapPing = def.minimapPing;
    this.bus.emit(EV.WeaponFired, evFired);
  }

  /**
   * Where the muzzle is in world space, for the tracer and the environment flash.
   *
   * The viewmodel is drawn at its own FOV, so its barrel has no exact world position;
   * this is the offset from the eye that *looks* like where the gun is, and it collapses
   * toward the centre line as the weapon comes up to aim.
   */
  private muzzleWorld(cmd: InputCommand, sim: PlayerSim): { x: number; y: number; z: number } {
    const cfg = this.viewmodelConfig;
    const ads = clamp01(this.inventory.active.adsFraction);
    const yaw = cmd.yaw;
    const pitch = cmd.pitch;
    const cp = simCos(pitch);
    const sp = simSin(pitch);
    const sy = simSin(yaw);
    const cy = simCos(yaw);

    const fx = -sy * cp;
    const fy = sp;
    const fz = -cy * cp;
    const rx = cy;
    const rz = -sy;
    const ux = sy * sp;
    const uy = cp;
    const uz = cy * sp;

    const world = this.muzzleStyle === 'world';
    const right = world ? WORLD_MUZZLE_RIGHT : cfg.muzzleRight * (1 - ads);
    const up = world ? -WORLD_MUZZLE_DOWN : lerp(cfg.muzzleUp, -0.02, ads);
    const forward = world ? WORLD_MUZZLE_FORWARD : cfg.muzzleForward;

    muzzleOut.x = sim.x + fx * forward + rx * right + ux * up;
    muzzleOut.y = sim.y + sim.eyeHeight + fy * forward + uy * up;
    muzzleOut.z = sim.z + fz * forward + rz * right + uz * up;
    return muzzleOut;
  }

  private writeSnapshot(out: WeaponSnapshot): void {
    const weapon = this.inventory.active;
    out.raise = weapon.raise;
    out.adsFraction = weapon.adsFraction;
    out.visualPunch = this.recoil.visualPunch;
    out.visualLateral = this.recoil.visualLateral;
    // Scope sway rides in the same channel as recoil so the camera, the shot and the debug
    // read-out cannot disagree about where the player is aiming.
    out.aimPitch = this.recoil.aimPitch + this.scope.swayPitch;
    out.aimYaw = this.recoil.aimYaw + this.scope.swayYaw;
    out.reloadFraction = weapon.reloadFraction;
    out.swapFraction = this.inventory.swapping ? 0 : 1;
  }
}

const muzzleOut = { x: 0, y: 0, z: 0 };

function copySnapshot(src: WeaponSnapshot, dst: WeaponSnapshot): void {
  dst.raise = src.raise;
  dst.adsFraction = src.adsFraction;
  dst.visualPunch = src.visualPunch;
  dst.visualLateral = src.visualLateral;
  dst.aimPitch = src.aimPitch;
  dst.aimYaw = src.aimYaw;
  dst.reloadFraction = src.reloadFraction;
  dst.swapFraction = src.swapFraction;
}
