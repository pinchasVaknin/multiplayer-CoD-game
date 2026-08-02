import * as THREE from 'three';
import type { BotDirector } from './ai/BotDirector';
import { PLAYER_ENTITY_ID } from './combat/DamageSystem';
import type { HitZone } from './combat/HitboxRig';
import { EV, type GameBus } from './core/Events';
import type { Input } from './core/Input';
import { angleDelta } from './core/MathUtil';
import { MIX } from './engine/AudioMix';
import type { CameraRig } from './engine/CameraRig';
import type { Fx } from './engine/Fx';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import type { CameraConfig } from './player/CameraConfig';
import type { Health } from './player/Health';
import type { PlayerController } from './player/PlayerController';
import type { LatencyProbe } from './debug/LatencyProbe';
import type { Hud } from './ui/Hud';
import type { WeaponAudio } from './weapons/WeaponAudio';
import type { WeaponSystem } from './weapons/WeaponSystem';

/**
 * Everything that *presents* a shot, in one place.
 *
 * `Match.ts` is the composition root and was doing this too, until it passed 700 lines and
 * broke S3's size guidance. The seam is a real one rather than a filing convenience: nothing
 * here is gameplay. The round has already landed and the damage has already been applied; this
 * turns the events that fact produced into a flash, a bang, a hitmarker, a chevron and a
 * number on screen.
 *
 * Which is why it is all subscriptions:
 *
 *   weapon.fired  --> muzzle flash, tracer, gunshot, camera shake, latency probe
 *   bullet.impact --> debris, decal, impact report
 *   damage.dealt  --> hitmarker, flesh impact, damage number, hurt vignette, hit direction
 *   entity.killed --> the sound of a body arriving, and the player's own death
 *
 * Nothing downstream of the sim is required for the sim to run, which is what lets the headless
 * harnesses fire a full magazine and play whole matches with no renderer, no audio context and
 * no DOM: none of this is constructed in those runs.
 */

export interface FeedbackDeps {
  readonly bus: GameBus;
  readonly cameraRig: CameraRig;
  /** For the landing dip; the rig takes its numbers from the live config. */
  readonly cameraConfig: CameraConfig;
  readonly audio: ProceduralAudio;
  readonly input: Input;
  readonly player: PlayerController;
  readonly playerHealth: Health;
  readonly weapons: WeaponSystem;
  readonly weaponAudio: WeaponAudio;
  readonly fx: Fx;
  readonly hud: Hud;
  readonly bots: BotDirector;
  readonly latency: LatencyProbe;
  /** Called when the local player dies, so `Match` can start its respawn timer. */
  readonly onPlayerKilled: () => void;
  /** Where the audio listener is this frame, for sounds with no located source. */
  readonly listener: () => Readonly<{ x: number; y: number; z: number }>;
}

interface PendingNumber {
  x: number;
  y: number;
  z: number;
  amount: number;
  zone: HitZone;
}

const NUMBER_QUEUE = 8;

/** Reusable position record for "where did that sound come from". Zero allocation. */
const sourceAt = { x: 0, y: 0, z: 0 };

export class MatchFeedback {
  /** Set on the tick a local shot resolves; consumed by the latency probe on render. */
  private shotSinceRender = false;

  private readonly deps: FeedbackDeps;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly numberQueue: PendingNumber[] = [];
  private readonly projectScratch = new THREE.Vector3();
  private numberCount = 0;

  constructor(deps: FeedbackDeps) {
    this.deps = deps;
    for (let i = 0; i < NUMBER_QUEUE; i++) {
      this.numberQueue.push({ x: 0, y: 0, z: 0, amount: 0, zone: 'torso' });
    }
    this.subscribe();
  }

  /**
   * Render pass. Damage numbers need the camera to project, and the camera only exists here.
   */
  render(camera: THREE.PerspectiveCamera): void {
    this.flushDamageNumbers(camera);
    if (!this.shotSinceRender) return;
    this.shotSinceRender = false;
    this.deps.latency.notePresented(performance.now());
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  // -- wiring ----------------------------------------------------------------

  private subscribe(): void {
    const { bus, cameraRig, input, fx, hud, weaponAudio, weapons, bots, latency } = this.deps;

    this.unsubscribe.push(
      bus.on(EV.WeaponFired, (p) => {
        const def = weapons.definition;
        // The muzzle *light* belongs to whoever fired, wherever they are standing; the flash
        // mesh hangs off the local player's own viewmodel and belongs only to them (M3 bug).
        const local = p.sourceId === PLAYER_ENTITY_ID;
        fx.fireMuzzleFlash(p.x, p.y, p.z, def.muzzleFlashScale, local);
        if (p.tracer) fx.spawnTracer(p.x, p.y, p.z, p.endX, p.endY, p.endZ);
        // M8 mix: your own rifle sits below everyone else's so an enemy at thirty metres
        // has somewhere to be heard. See `engine/AudioMix.ts` for the arithmetic.
        weaponAudio.playGunshot(p.x, p.y, p.z, def.voice, local ? MIX.ownWeapon : MIX.otherWeapon);
        // Everything below is about the local player's own hands and must not fire for a bot:
        // a bot shooting across the room shaking your camera is the classic tell.
        if (!local) return;
        cameraRig.shake.add(def.shakePerShot);
        latency.armFromPress(input.takeFirePress());
        this.shotSinceRender = true;
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.BulletImpact, (p) => {
        fx.spawnImpact(p.x, p.y, p.z, p.nx, p.ny, p.nz, p.material, p.penetrated);
        weaponAudio.playImpact(p.x, p.y, p.z, p.material, p.penetrated);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.DamageDealt, (p) => {
        if (p.targetId === PLAYER_ENTITY_ID) {
          this.onPlayerHurt(p.sourceId, p.amount);
          return;
        }
        // A round landing on a body is a sound in the room no matter who fired it (S6.8).
        weaponAudio.playFleshImpact(p.x, p.y, p.z, p.zone === 'head');
        if (p.sourceId !== PLAYER_ENTITY_ID) return;

        // Timestamped here, at the moment the damage was applied, so the hitmarker latency
        // reported in the overlay is hit-to-visual and not visual-to-visual.
        hud.showHitmarker(p.lethal, performance.now());
        weaponAudio.playHitmarker(p.lethal);
        // Debris comes back along the shot, so the puff faces the shooter.
        const sim = this.deps.player.sim;
        const bx = sim.x - p.x;
        const by = sim.y + sim.eyeHeight - p.y;
        const bz = sim.z - p.z;
        const inv = 1 / Math.max(1e-4, Math.hypot(bx, by, bz));
        fx.spawnHitPuff(p.x, p.y, p.z, bx * inv, by * inv, bz * inv);
        this.queueDamageNumber(p.x, p.y, p.z, p.amount, p.zone);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.EntityKilled, (p) => {
        if (p.targetId === PLAYER_ENTITY_ID) {
          this.deps.onPlayerKilled();
          return;
        }
        const victim = bots.get(p.targetId);
        if (victim === undefined) return;
        // Slightly off the floor: the sound is the body arriving, not the feet.
        weaponAudio.playDeath(victim.px, victim.py + 0.4, victim.pz);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.WeaponDryFired, (p) => {
        const at = this.sourcePosition(p.sourceId);
        weaponAudio.playDryFire(at.x, at.y, at.z);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.WeaponReloadStep, (p) => {
        const at = this.sourcePosition(p.sourceId);
        weaponAudio.playReloadStep(at.x, at.y, at.z, p.step);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.WeaponAdsChanged, (p) => {
        const at = this.sourcePosition(p.sourceId);
        weaponAudio.playAdsRustle(at.x, at.y, at.z, p.aiming);
      }),
    );

    /**
     * Feet, from M1, and from M3 for everybody rather than only the player.
     *
     * Both play positionally for every combatant — that is how you hear one drop in behind you.
     * The *camera dip* is the one part that is not shared: only the local player's own landing
     * moves the local player's view, which was an M3 bug when `player.landed` grew an entity id
     * and this handler did not read it.
     */
    this.unsubscribe.push(
      bus.on(EV.PlayerLanded, (p) => {
        const own = p.entityId === PLAYER_ENTITY_ID;
        if (own) cameraRig.applyLanding(this.deps.cameraConfig, p.impactSpeed);
        this.deps.audio.playLanding(
          p.x,
          p.y,
          p.z,
          p.impactSpeed,
          p.material,
          own ? MIX.ownFootstep : MIX.otherFootstep,
        );
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.PlayerFootstep, (p) => {
        // M8 mix: your own steps are constant, carry no information, and are the best mask
        // in the game for the one sound you most need to hear (`engine/AudioMix.ts`).
        const own = p.entityId === PLAYER_ENTITY_ID;
        this.deps.audio.playFootstep(
          p.x,
          p.y,
          p.z,
          p.speed,
          p.heavy,
          p.material,
          own ? MIX.ownFootstep : MIX.otherFootstep,
        );
      }),
    );
  }

  /**
   * The player took a round. The vignette says how hard, the chevron says from where — and the
   * chevron is the important one, because being shot from off-screen with no indication of the
   * direction is the single most frustrating way to die.
   */
  private onPlayerHurt(sourceId: number, amount: number): void {
    const max = this.deps.playerHealth.max;
    this.deps.hud.showHurt(amount, max);
    // A jolt proportional to the round, capped well below the landing shake: being shot has to
    // register in the body without taking the aim away from the player.
    const severity = Math.min(1, amount / Math.max(max * 0.3, 1));
    this.deps.cameraRig.shake.add(0.08 + severity * 0.16);

    const shooter = this.deps.bots.get(sourceId);
    if (shooter === undefined) return;
    const sim = this.deps.player.sim;
    const worldYaw = Math.atan2(-(shooter.px - sim.x), -(shooter.pz - sim.z));
    // Screen-relative: 0 is straight ahead, positive to the right. The view yaw grows
    // anticlockwise, so the bearing is the negated delta.
    this.deps.hud.showHitDirection(-angleDelta(sim.yaw, worldYaw));
  }

  /**
   * Where an entity's weapon sounds should come from. The player's own mechanical noises sit at
   * their eye; a bot's sit at the bot, which is what makes hearing one reload behind a crate a
   * usable piece of information rather than a confusing one.
   */
  private sourcePosition(sourceId: number): Readonly<{ x: number; y: number; z: number }> {
    if (sourceId === PLAYER_ENTITY_ID) {
      const sim = this.deps.player.sim;
      sourceAt.x = sim.x;
      sourceAt.y = sim.y + sim.eyeHeight;
      sourceAt.z = sim.z;
      return sourceAt;
    }
    const bot = this.deps.bots.get(sourceId);
    if (bot !== undefined) {
      sourceAt.x = bot.px;
      sourceAt.y = bot.py + bot.eyeHeight;
      sourceAt.z = bot.pz;
      return sourceAt;
    }
    // Unregistered source (a range dummy). Put it at the listener so it stays audible rather
    // than being panned to the origin of the world.
    return this.deps.listener();
  }

  private queueDamageNumber(x: number, y: number, z: number, amount: number, zone: HitZone): void {
    if (this.numberCount >= NUMBER_QUEUE) return;
    const slot = this.numberQueue[this.numberCount];
    if (slot === undefined) return;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.amount = amount;
    slot.zone = zone;
    this.numberCount++;
  }

  private flushDamageNumbers(camera: THREE.PerspectiveCamera): void {
    if (this.numberCount === 0) return;
    if (this.deps.hud.damageNumbersEnabled) {
      const halfW = window.innerWidth * 0.5;
      const halfH = window.innerHeight * 0.5;
      for (let i = 0; i < this.numberCount; i++) {
        const n = this.numberQueue[i];
        if (n === undefined) continue;
        this.projectScratch.set(n.x, n.y, n.z).project(camera);
        if (this.projectScratch.z > 1) continue;
        this.deps.hud.showDamageNumber(
          halfW + this.projectScratch.x * halfW,
          halfH - this.projectScratch.y * halfH,
          n.amount,
          n.zone,
        );
      }
    }
    this.numberCount = 0;
  }
}
