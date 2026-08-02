import * as THREE from 'three';
import type { BotDirector } from './ai/BotDirector';
import type { BotTeam, Combatant } from './ai/Combatant';
import type { TierTable } from './ai/DifficultyTiers';
import { PLAYER_ENTITY_ID } from './combat/DamageSystem';
import type { DamageSystem } from './combat/DamageSystem';
import { EV, type GameBus } from './core/Events';
import type { InputCommand } from './core/InputCommand';
import { DT } from './core/Loop';
import { clamp01 } from './core/MathUtil';
import { Rng } from './core/Rng';
import type { CameraRig } from './engine/CameraRig';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import { BotThrower } from './equipment/BotThrower';
import type { EquipmentConfig } from './equipment/EquipmentConfig';
import { EquipmentAudio } from './equipment/EquipmentAudio';
import { EquipmentFx } from './equipment/EquipmentFx';
import { EquipmentSystem, makeEquipmentInventory, type EquipmentInventory } from './equipment/EquipmentSystem';
import { ThrowController } from './equipment/ThrowController';
import type { PlayerSim } from './player/PlayerState';
import type { Hud } from './ui/Hud';
import type { CollisionWorld } from './world/CollisionWorld';

/**
 * Equipment, composed into a match.
 *
 * Split out of `Match.ts` for the same reason `MatchFeedback` was: `Match` is wiring, and
 * this is a whole subsystem's worth of it — the projectile world, the player's throw
 * input, the bots' throw policy, the visuals, the audio, and the six event subscriptions
 * that connect them. Putting it inline would push `Match` well past S3's size limit again.
 *
 * Everything crossing in or out is an event or one of the three `simulate` / `render` /
 * `dispose` calls below, so the headless harness can run equipment with no renderer and no
 * audio context.
 */

const PROJECTILE_MESH_POOL = 32;
const SMOKE_MESH_POOL = 8;

/** Seconds of white-out and low-pass on the local player, per unit of flash intensity. */
const PLAYER_FLASH_SECONDS = 3;

export interface MatchEquipmentDeps {
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly world: CollisionWorld;
  readonly damage: DamageSystem;
  readonly bots: BotDirector;
  readonly audio: ProceduralAudio;
  readonly cameraRig: CameraRig;
  readonly hud: Hud;
  readonly cfg: EquipmentConfig;
  readonly tiers: TierTable;
  readonly localTeam: BotTeam;
  readonly seed: number;
}

/** How long the concussion takes to clear. Short, per S6.4. */
const CONCUSSION_SECONDS = 1.6;
/** Below this proximity a blast is heard rather than felt, and does nothing to the mix. */
const CONCUSSION_MIN_FALLOFF = 0.35;
/** The ring is a hint at this range, not the wall of tone a flashbang produces. */
const CONCUSSION_RING_SCALE = 0.45;

export class MatchEquipment {
  readonly system: EquipmentSystem;
  readonly thrower: ThrowController;
  readonly botThrower: BotThrower;
  readonly fx: EquipmentFx;
  readonly audio: EquipmentAudio;

  /** The local player's two slots. Refilled on respawn (S6.3). */
  readonly inventory: EquipmentInventory = makeEquipmentInventory('frag', 'flashbang');

  /** 0..1 white-out on the local player. Drives the HUD and the audio low-pass. */
  flashIntensity = 0;

  /** Wall time inside the last `simulate`, ms. Reported in F1. */
  lastMs = 0;

  private readonly deps: MatchEquipmentDeps;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly rng: Rng;
  private readonly intent: MutableThrowIntent = {
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    sinceSeen: 999,
    hasTarget: false,
  };

  private flashRemaining = 0;
  private flashTotal = 1;
  /**
   * A nearby blast, decaying (M8, brief S6.4).
   *
   * S6.4 asks for "low-pass + tinnitus sine after nearby explosions", and until M8 only a
   * *flashbang* did either — a frag going off at your feet was loud and then instantly over.
   * This is the same pair of effects on a much shorter, much shallower curve: a concussion
   * is a moment of your ears folding, not the ten seconds of nothing a flash buys.
   */
  private concussion = 0;
  private beepTimer = 0;
  private elapsed = 0;
  /** Round-robin cursor so one bot is considered per tick rather than all ten. */
  private throwCursor = 0;

  constructor(deps: MatchEquipmentDeps) {
    this.deps = deps;
    this.rng = new Rng(deps.seed ^ 0x1b3d_77a1);

    this.system = new EquipmentSystem({
      bus: deps.bus,
      world: deps.world,
      damage: deps.damage,
      roster: deps.bots.roster,
      cfg: deps.cfg,
    });
    this.thrower = new ThrowController(this.system, deps.cfg);
    this.botThrower = new BotThrower(this.system, deps.world, deps.cfg);
    this.fx = new EquipmentFx(PROJECTILE_MESH_POOL, SMOKE_MESH_POOL);
    this.audio = new EquipmentAudio(deps.audio);
    deps.scene.add(this.fx.group);

    // The whole point of S6.3's smoke: it feeds the M3 perception raycast rather than
    // being drawn over it.
    deps.bots.perception.occluder = this.system.smoke;
    deps.bots.perception.blindSource = this.system.flash;

    this.unsubscribe.push(
      deps.bus.on(EV.EquipmentThrown, (p) => this.audio.playThrow(p.x, p.y, p.z)),
      deps.bus.on(EV.EquipmentBounced, (p) =>
        this.audio.playBounce(p.x, p.y, p.z, p.speed, p.material, p.stuck),
      ),
      deps.bus.on(EV.EquipmentArmed, (p) => this.audio.playArmed(p.x, p.y, p.z)),
      deps.bus.on(EV.SmokeSpawned, (p) => this.audio.playSmoke(p.x, p.y, p.z)),
      deps.bus.on(EV.EquipmentExploded, (p) => this.onExploded(p.x, p.y, p.z, p.radius, p.equipmentId)),
      deps.bus.on(EV.EquipmentFlashed, (p) => this.onFlashed(p.targetId, p.intensity)),
      deps.bus.on(EV.PlayerSpawned, (p) => this.onSpawned(p.entityId)),
    );
  }

  /** One sim tick. */
  simulate(cmd: InputCommand, sim: PlayerSim, playerAlive: boolean): void {
    const t0 = performance.now();
    this.elapsed += DT;

    this.thrower.step(cmd, sim, PLAYER_ENTITY_ID, this.inventory, this.deps.localTeam, playerAlive);
    this.system.simulate(sim.x, sim.y + sim.eyeHeight, sim.z, this.deps.localTeam);
    this.stepBotThrows();
    this.stepFlash();
    this.stepConcussion();
    this.stepThreatBeep();

    this.lastMs = performance.now() - t0;
  }

  render(alpha: number, dt: number, camera: THREE.Camera): void {
    this.fx.update(this.system.projectiles, this.system.smoke, alpha, dt, camera, this.elapsed);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.deps.bots.perception.occluder = null;
    this.deps.bots.perception.blindSource = null;
    this.system.clear();
    this.deps.scene.remove(this.fx.group);
    this.fx.dispose();
  }

  /** Wipe live equipment. Used on round boundaries and by the harness. */
  reset(): void {
    this.system.clear();
    this.thrower.reset();
    this.botThrower.reset();
    this.flashIntensity = 0;
    this.flashRemaining = 0;
    EquipmentSystem.refill(this.inventory);
  }

  // -- internals -------------------------------------------------------------

  /**
   * One bot considered per tick, round robin.
   *
   * The trajectory check runs the real integrator, so it is the most expensive thing in
   * `ai/` per call — but at one bot per tick with a 12-30 s cooldown each, a ten-bot match
   * spends a few dozen of them a minute. Spreading it is what keeps the S4.7 budget intact.
   */
  private stepBotThrows(): void {
    const bots = this.deps.bots.bots;
    if (bots.length === 0) return;
    this.throwCursor = (this.throwCursor + 1) % bots.length;
    const bot = bots[this.throwCursor];
    if (bot === undefined || !bot.participating) return;

    const bb = bot.blackboard;
    this.intent.hasTarget = bb.targetId >= 0;
    this.intent.targetX = bb.lastKnownX;
    this.intent.targetY = bb.lastKnownFeetY;
    this.intent.targetZ = bb.lastKnownZ;
    this.intent.sinceSeen = bb.sinceLos;

    this.botThrower.consider(
      bot,
      bot.tierName,
      this.deps.tiers[bot.tierName],
      this.intent,
      this.deps.bots.roster,
      this.rng,
      // One evaluation per bot every `bots.length` ticks.
      DT * bots.length,
    );
  }

  private stepFlash(): void {
    if (this.flashRemaining <= 0) {
      if (this.flashIntensity !== 0) {
        this.flashIntensity = 0;
        this.deps.hud.setFlash(0);
        this.deps.audio.setFlashMuffle(0);
      }
      return;
    }
    this.flashRemaining -= DT;
    // The same hold-then-fade curve `FlashField` uses for bots, so what the player sees
    // and what a bot suffers are the same effect rather than two tuned approximations.
    const elapsed = this.flashTotal - this.flashRemaining;
    const hold = this.flashTotal * this.deps.cfg.flashHoldFraction;
    const value =
      elapsed <= hold
        ? 1
        : clamp01((this.flashTotal - elapsed) / Math.max(this.flashTotal - hold, 1e-3));
    this.flashIntensity = value;
    this.deps.hud.setFlash(value);
    this.deps.audio.setFlashMuffle(value);
  }

  /**
   * Decay the concussion.
   *
   * Linear over `CONCUSSION_SECONDS` rather than exponential: an exponential tail leaves a
   * barely-audible muffle hanging around for seconds after the blast, which reads as the
   * audio being broken rather than as the player recovering.
   */
  private stepConcussion(): void {
    if (this.concussion <= 0) return;
    this.concussion = Math.max(0, this.concussion - DT / CONCUSSION_SECONDS);
    this.deps.audio.setConcussionMuffle(this.concussion);
  }

  private stepThreatBeep(): void {
    const threat = this.system.threat;
    if (!threat.active) {
      this.beepTimer = 0;
      this.deps.hud.setThreat(false, 0, 0, 0);
      return;
    }
    this.deps.hud.setThreat(true, threat.x, threat.y, threat.z);

    // Faster the closer it is: the indicator's job is to say "move", and a fixed rate says
    // "something is happening somewhere".
    const urgency = clamp01(1 - threat.distance / Math.max(this.deps.cfg.indicatorRadius, 1e-3));
    this.beepTimer -= DT;
    if (this.beepTimer > 0) return;
    this.beepTimer = this.deps.cfg.beepInterval * (1 - urgency * 0.6);
    this.audio.playThreatBeep(urgency);
  }

  private onExploded(x: number, y: number, z: number, radius: number, equipmentId: string): void {
    const flashy = equipmentId === 'flashbang';
    this.fx.spawnBlast(x, y, z, radius * 0.45, flashy);
    if (flashy) {
      this.audio.playFlashbang(x, y, z, this.flashIntensity);
    } else {
      this.audio.playExplosion(x, y, z, 1);
    }

    // Shake scaled by distance, so a blast across the yard is felt and one at your feet is
    // survived rather than merely observed.
    const cam = this.deps.cameraRig.camera.position;
    const distance = Math.hypot(cam.x - x, cam.y - y, cam.z - z);
    const falloff = clamp01(1 - distance / Math.max(radius * 2.5, 1e-3));
    if (falloff > 0) this.deps.cameraRig.shake.add(this.deps.cfg.blastShake * falloff * falloff);

    /**
     * The concussion (M8, S6.4).
     *
     * Only for a real blast — a flashbang has its own, deeper effect and stacking the two
     * would put the world behind two low-passes at once. Squared falloff, so it is a thing
     * that happens when a grenade lands *near you* rather than a thing that happens
     * whenever a grenade goes off; and it takes the maximum with whatever is already
     * decaying so a second blast cannot make the first one quieter.
     */
    if (!flashy && falloff > CONCUSSION_MIN_FALLOFF) {
      const strength = falloff * falloff;
      this.concussion = Math.max(this.concussion, strength);
      this.deps.audio.setConcussionMuffle(this.concussion);
      this.deps.audio.playRing(strength * CONCUSSION_RING_SCALE);
    }
  }

  private onFlashed(targetId: number, intensity: number): void {
    if (targetId !== PLAYER_ENTITY_ID) return;
    const seconds = PLAYER_FLASH_SECONDS * intensity;
    if (seconds <= this.flashRemaining) return;
    this.flashRemaining = seconds;
    this.flashTotal = seconds;
  }

  private onSpawned(entityId: number): void {
    if (entityId === PLAYER_ENTITY_ID) {
      EquipmentSystem.refill(this.inventory);
      this.thrower.reset();
      this.flashRemaining = 0;
      return;
    }
    this.botThrower.respawn(entityId);
  }

  /** Every combatant, for the debug panel's smoke visualisation. */
  get roster(): readonly Combatant[] {
    return this.deps.bots.roster;
  }
}

/** The writable side of `ThrowIntent`; one instance, rewritten in place each tick. */
interface MutableThrowIntent {
  targetX: number;
  targetY: number;
  targetZ: number;
  sinceSeen: number;
  hasTarget: boolean;
}
