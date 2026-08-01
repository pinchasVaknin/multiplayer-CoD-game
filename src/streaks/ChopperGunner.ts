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
 * ## Thermal is a render pass
 *
 * `Renderer.setThermal(true)` swaps in an override material for the world and draws combatants
 * hot in a second pass. That is a pass, not a colour filter over the normal image — the brief
 * distinguishes them and the difference is visible: a filter tints the muzzle flashes and the
 * sky along with everything else, where a pass decides what is hot on a per-object basis and
 * gets bodies that glow through a dim room.
 */
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
  }

  override onActivate(): void {
    const cfg = this.ctx.cfg;
    // Start on the owner's side of the map so the first thing they see is their own half.
    this.orbitAngle = this.ownerTeam === 'A' ? Math.PI * 0.5 : Math.PI * 1.5;
    this.updateOrbit();
    this.yaw = Math.atan2(-(0 - this.x), -(0 - this.z));
    this.pitch = -0.5;
    void cfg;
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

    const firing = isDown(cmd.buttons, Btn.Fire);
    const cfg = this.ctx.cfg;
    // Heat-up: the barrels wind toward full rate while held and unwind when released, so the
    // first half-second of a burst is deliberately slower than the rest.
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
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
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
  }

  override describe(): string {
    const hitRate = this.shotsFired > 0 ? ((this.shotsHit / this.shotsFired) * 100).toFixed(1) : '—';
    return `CHOPPER ${this.secondsRemaining.toFixed(1)}s · spin ${(this.spin * 100).toFixed(0)}% · ${this.shotsHit}/${this.shotsFired} (${hitRate}%)`;
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
