import * as THREE from 'three';
import { makeDamageRequest, type DamageRequest } from '../combat/DamageSystem';
import { Btn, isDown, type InputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { clamp, DEG2RAD } from '../core/MathUtil';
import { Ballistics, makeShotTrace, type ShotTrace } from '../weapons/Ballistics';
import { Killstreak, type StreakContext } from './KillstreakBase';
import type { StreakDef } from './StreakDefs';
import { chopperWeapon } from './StreakWeapons';

/**
 * Chopper Gunner (brief S6.1): full camera takeover, thermal view, tracking minigun.
 *
 * ## Where the crashes live
 *
 * The brief says so outright, and it is right: *"Chopper Gunner's camera takeover returns
 * control cleanly, including if the player is killed or the match ends mid-streak."* A takeover
 * is a second place that owns the camera and the input, and every bug in one is the same bug —
 * something ended the streak without putting the camera back.
 *
 * So there is exactly **one** exit path. `onExpire` restores everything, it is idempotent, and
 * `StreakSystem` guarantees it runs: on the timer, on the owner's death, on `MatchEnded`, and on
 * `dispose`. Nothing else may put the camera back, because two things that can restore state are
 * two things that can disagree about whether it has been restored.
 *
 * The player's body is deliberately **left in the world**. It is not hidden, not made
 * invulnerable and not unregistered from `DamageSystem` — the brief asks for exactly that ("out
 * of play but not invulnerable to a lucky mortar"). What it stops doing is *acting*: the
 * takeover swallows the movement half of the command, so the body stands still and can be shot.
 *
 * ## The optic is a render pass
 *
 * `Renderer.renderGunship` swaps in an override material for the world and draws the bodies in
 * two further passes — the gunner's own side dark, everybody else hot. That is a pass, not a
 * colour filter over the normal image — the brief distinguishes them and the difference is
 * visible: a filter tints the muzzle flashes and the sky along with everything else, where a
 * pass decides what each object *is* and gets a legible grey map with orange contacts on it
 * even at night, which is the post-M8 requirement Depot forced.
 */
/**
 * The optic, in degrees of vertical FOV (post-M8).
 *
 * 55 is what M7 shipped and is the wide setting. 22 is a little over a 2.5x magnification,
 * which is enough to pick a single operator out of a container yard from the orbit radius
 * and not so much that the orbital drift makes the picture unusable.
 */
const FOV_WIDE = 55;
const FOV_ZOOMED = 22;
/** How fast the zoom travels, per second. Brisk enough to use mid-burst. */
const ZOOM_RATE = 7;

export class ChopperGunner extends Killstreak {
  /** Where the gun is. Orbits the map centre. */
  x = 0;
  y = 0;
  z = 0;

  /** 0..1 barrel spin. Drives the fire rate, the audio and the shake. */
  spin = 0;
  shotsFired = 0;
  shotsHit = 0;
  kills = 0;

  /** Aim, owned here while the takeover is running. */
  yaw = 0;
  pitch = -0.35;

  /**
   * 0..1 optical zoom, driven by the ADS button (post-M8 playtest).
   *
   * The report was that ADS in the gunship "hides the crosshair completely instead of
   * zooming". Both halves had the same cause: the takeover left the player's *rifle*
   * consuming the same command, so the ADS button was aiming a weapon a kilometre below and
   * the scope overlay dutifully hid the reticle for it. `WeaponSystem.suspended` stops that
   * (see `Match.simulate`), which fixes the crosshair; this is the other half — the button
   * now does the thing the player expected it to do.
   *
   * Eased over `ZOOM_RATE` rather than snapped, because a gunship optic that cut instantly
   * between two focal lengths reads as a glitch, and because the player is tracking a moving
   * target while they press it.
   */
  zoom = 0;

  /**
   * Rounds left in the belt, and the feed timer (round 2 playtest).
   *
   * Live state rather than a derived number because the HUD, the audio and the fire gate all
   * ask the same two questions — *can it shoot* and *how far through the feed is it* — and a
   * belt reconstructed from a shot count in three places is three places that can disagree
   * about when the gun is empty.
   *
   * `reloadTimer` counts *down*, and `reloading` is simply "is it above zero". The spin is
   * bled off while it runs, so a reload is felt as the barrels dropping and picking up again
   * rather than as a number changing in the corner: the first half-second after a feed is at
   * a third of the rate, exactly as the first burst of the streak is.
   */
  mag: number;
  reloadTimer = 0;

  private orbitAngle = 0;
  private fireTimer = 0;
  private restored = false;
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.5, 400);
  private readonly ballistics: Ballistics;
  private readonly request: DamageRequest;
  private readonly trace: ShotTrace = makeShotTrace();

  constructor(
    def: StreakDef,
    ownerId: number,
    ownerTeam: 'A' | 'B',
    instanceId: number,
    ctx: StreakContext,
  ) {
    super(def, ownerId, ownerTeam, instanceId, ctx);
    this.ballistics = new Ballistics(ctx.world, ctx.damage, ctx.bus);
    this.request = makeDamageRequest(chopperWeapon(ctx.cfg.chopperDamage));
    this.request.sourceId = ownerId;
    this.mag = ctx.cfg.chopperMagSize;
  }

  /** Belt size, so the HUD can draw "27 / 50" without knowing where the config lives. */
  get magSize(): number {
    return this.ctx.cfg.chopperMagSize;
  }

  /** True while the belt is being fed. The gun cannot fire and the barrels wind down. */
  get reloading(): boolean {
    return this.reloadTimer > 0;
  }

  /** 0..1 through the feed, for the HUD's progress bar. 0 when not reloading. */
  get reloadFraction(): number {
    const total = Math.max(0.05, this.ctx.cfg.chopperReloadSeconds);
    return this.reloadTimer > 0 ? clamp(1 - this.reloadTimer / total, 0, 1) : 0;
  }

  override onActivate(): void {
    const cfg = this.ctx.cfg;
    // Start on the owner's side of the map so the first thing they see is their own half.
    this.orbitAngle = this.ownerTeam === 'A' ? Math.PI * 0.5 : Math.PI * 1.5;
    this.updateOrbit();
    this.yaw = Math.atan2(-(0 - this.x), -(0 - this.z));
    this.pitch = -0.5;
    // A streak always begins on a full belt: the first thing the gunner does is shoot.
    this.mag = cfg.chopperMagSize;
    this.reloadTimer = 0;
  }

  /**
   * One sim tick.
   *
   * `cmd` is fed in by `StreakSystem` rather than read from anywhere: the takeover consumes the
   * *same* immutable command the player controller would have, which is what keeps the netcode
   * seam honest (S4.2) — a remote player flying a chopper would send exactly this.
   */
  step(cmd: InputCommand): void {
    // Look is absolute in the command, so the takeover simply adopts it. Pitch is clamped to a
    // downward cone: a gunship gun cannot point at the sky.
    this.yaw = cmd.yaw;
    this.pitch = clamp(cmd.pitch, -80 * DEG2RAD, -6 * DEG2RAD);

    const cfg = this.ctx.cfg;
    // The optic. Held, not toggled, matching every other ADS in the game.
    const zoomTarget = isDown(cmd.buttons, Btn.Ads) ? 1 : 0;
    this.zoom = clamp(this.zoom + (zoomTarget - this.zoom) * ZOOM_RATE * DT, 0, 1);

    // The belt (round 2). A feed is a hard gate on the trigger, not a modifier on it: the
    // button is read the same way, and the gun simply is not able to answer it.
    if (this.reloadTimer > 0) {
      this.reloadTimer -= DT;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        this.mag = cfg.chopperMagSize;
      }
    }
    const firing = isDown(cmd.buttons, Btn.Fire) && this.reloadTimer <= 0 && this.mag > 0;

    // Heat-up: the barrels wind toward full rate while held and unwind when released, so the
    // first half-second of a burst is deliberately slower than the rest. A feed unwinds them
    // too, which is what makes the reload something the gunner hears and feels rather than
    // reads — and it means the round after a feed costs the same spin-up the first one did.
    const rate = 1 / Math.max(0.05, cfg.chopperSpinUpSeconds);
    this.spin = clamp(this.spin + (firing ? rate : -rate * 1.6) * DT, 0, 1);

    if (this.spin > 0.02) this.ctx.audio.chopperSpin(this.spin);
    if (firing && this.spin > 0.2) this.stepFiring();
  }

  override onTick(_tick: number): boolean {
    this.age += DT;
    this.updateOrbit();
    // Shake scales with the spin, so a held burst is felt.
    if (this.spin > 0.05) this.ctx.cameraRig.shake.add(0.02 + this.spin * 0.05);
    return this.age < this.def.durationSeconds;
  }

  /**
   * The camera the renderer should use this frame, or null once restored.
   *
   * Returning the camera rather than writing into the rig keeps the takeover from having to
   * undo anything: `Game` simply asks who owns the view.
   */
  activeCamera(aspect: number): THREE.PerspectiveCamera | null {
    if (this.restored) return null;
    // Post-M8: the FOV is part of the projection, so the zoom has to be applied where the
    // aspect is. Both are compared before `updateProjectionMatrix`, which is not free and
    // must not run on a frame where nothing about the lens changed.
    const fov = FOV_WIDE + (FOV_ZOOMED - FOV_WIDE) * this.zoom;
    if (this.camera.aspect !== aspect || Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.aspect = aspect;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(this.x, this.y, this.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    return this.camera;
  }

  /**
   * The single exit. Idempotent, and the only thing that may end a takeover.
   *
   * Called by `StreakSystem` on the timer, on the owner's death, on `MatchEnded` and on
   * `dispose` — four situations, one path, which is the point.
   */
  override onExpire(): void {
    if (this.restored) return;
    this.restored = true;
    this.spin = 0;
    this.zoom = 0;
    this.reloadTimer = 0;
  }

  override describe(): string {
    const hitRate = this.shotsFired > 0 ? ((this.shotsHit / this.shotsFired) * 100).toFixed(1) : '—';
    const belt = this.reloading ? 'FEED' : `${this.mag}/${this.magSize}`;
    return `CHOPPER ${this.secondsRemaining.toFixed(1)}s · spin ${(this.spin * 100).toFixed(0)}% · ${belt} · ${this.shotsHit}/${this.shotsFired} (${hitRate}%)`;
  }

  get isRestored(): boolean {
    return this.restored;
  }

  // -- internals --------------------------------------------------------------

  private updateOrbit(): void {
    const cfg = this.ctx.cfg;
    this.orbitAngle += cfg.chopperOrbitSpeed * DT;
    this.x = Math.cos(this.orbitAngle) * cfg.chopperOrbitRadius;
    this.z = Math.sin(this.orbitAngle) * cfg.chopperOrbitRadius;
    this.y = cfg.chopperHeight;
  }

  private stepFiring(): void {
    const cfg = this.ctx.cfg;
    // Rate ramps with the spin: a cold gun is roughly a third of full rate.
    const rpm = cfg.chopperRpm * (0.35 + 0.65 * this.spin);
    const interval = 60 / Math.max(1, rpm);
    this.fireTimer -= DT;
    if (this.fireTimer > 0) return;
    this.fireTimer = interval;

    // Spend the round first, and start the feed on the one that empties the belt rather than
    // on the next trigger pull: an empty gun that waits to be asked is an empty gun that
    // silently eats a click.
    this.mag--;
    if (this.mag <= 0) {
      this.mag = 0;
      this.reloadTimer = cfg.chopperReloadSeconds;
    }

    const cp = Math.cos(this.pitch);
    const dx = -Math.sin(this.yaw) * cp;
    const dy = Math.sin(this.pitch);
    const dz = -Math.cos(this.yaw) * cp;

    this.shotsFired++;
    this.ctx.audio.chopperShot();

    const def = chopperWeapon(cfg.chopperDamage);
    this.request.weapon = def;
    this.ballistics.fire(this.x, this.y, this.z, dx, dy, dz, def, this.request, this.trace);
    this.ctx.fx.spawnTracer(this.x, this.y, this.z, this.trace.endX, this.trace.endY, this.trace.endZ);
    if (this.trace.hitTarget) this.shotsHit++;
    if (this.trace.lethal) this.kills++;
    // A round that hit the ground kicks dust, so the player can read where they are shooting.
    if (this.trace.hitWorld) {
      this.ctx.blast(this.trace.endX, this.trace.endY, this.trace.endZ, 1.1, false);
    }
  }
}
