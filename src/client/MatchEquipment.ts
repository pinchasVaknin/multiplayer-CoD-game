import * as THREE from 'three';
import type { BotDirector } from '../shared/ai/BotDirector';
import type { BotTeam, Combatant } from '../shared/ai/Combatant';
import type { TierTable } from '../shared/ai/DifficultyTiers';
import type { DamageSystem } from '../shared/combat/DamageSystem';
import { EV, type GameBus } from '../shared/core/Events';
import type { InputCommand } from '../shared/core/InputCommand';
import { DT } from '../shared/core/Loop';
import { clamp01 } from '../shared/core/MathUtil';
import { Rng } from '../shared/core/Rng';
import type { CameraRig } from './engine/CameraRig';
import type { ProceduralAudio } from './engine/ProceduralAudio';
import { BotThrower, type MutableThrowIntent } from '../shared/equipment/BotThrower';
import { ALL_EQUIPMENT } from '../shared/equipment/EquipmentDefs';
import { PEFlag, type ProjectileState, type SmokeState } from '../shared/net/Skirmish';
import type { Projectile } from '../shared/equipment/Projectile';

/**
 * How fast a replicated grenade closes on the position replication last reported, per second.
 *
 * Sized against the snapshot interval rather than picked: at 20 Hz a frame arrives every 50 ms,
 * and this closes about 78% of the gap in that time — fast enough that the drawn grenade is
 * never visibly behind, slow enough that each new sample is a nudge rather than a jump.
 */
const REPLICATED_EASE_RATE = 30;
import type { EquipmentConfig } from '../shared/equipment/EquipmentConfig';
import { EquipmentAudio } from './equipment/EquipmentAudio';
import { EquipmentFx } from './equipment/EquipmentFx';
import { EquipmentSystem, makeEquipmentInventory, type EquipmentInventory } from '../shared/equipment/EquipmentSystem';
import { ThrowController } from '../shared/equipment/ThrowController';
import type { PlayerSim } from '../shared/player/PlayerState';
import type { Hud } from './ui/Hud';
import type { CollisionWorld } from '../shared/world/CollisionWorld';

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
  /**
   * Which entity this client's own hand belongs to (M11 Gate B playtest).
   *
   * `PLAYER_ENTITY_ID` was used as a literal in three places here and every one of them was
   * wrong the moment a server assigned a seat: the grenade left the hand stamped as entity 0
   * (so the server's authoritative copy of *your own* grenade did not match it and was adopted
   * as somebody else's — the double-render §8.24 excludes by owner), a flashbang addressed to
   * you was ignored, and the per-life refill never ran.
   */
  readonly localId: number;
  readonly seed: number;
  /** False on a networked client: predict and draw, resolve nothing. See `EquipmentDeps`. */
  readonly authoritative?: boolean;
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
  /** Serials seen in the current replicated frame. Reused; nothing here allocates per frame. */
  private readonly seenSerials = new Set<number>();
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
      /**
       * A networked client predicts its own grenade and resolves nothing (M11 Gate B, §4.15).
       *
       * See `EquipmentDeps.authoritative`. Without this the client's own blast applied damage
       * to its own player — `BotDirector` puts the local player on the roster — while the
       * server was applying the authoritative copy of the same damage.
       */
      authoritative: deps.authoritative !== false,
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

    this.thrower.step(cmd, sim, this.deps.localId, this.inventory, this.deps.localTeam, playerAlive);
    this.system.simulate(sim.x, sim.y + sim.eyeHeight, sim.z, this.deps.localTeam);
    this.stepBotThrows();
    this.stepFlash();
    this.stepConcussion();
    this.stepThreatBeep();

    this.lastMs = performance.now() - t0;
  }

  /**
   * Adopt the server's grenades into the pool the renderer already walks (§8.24).
   *
   * The same move the objectives, the tags and the bomb make: replicate **into** the objects
   * that already draw, rather than teaching the renderer a second source. `EquipmentFx` is
   * untouched by this whole feature.
   *
   * The local player's own are skipped — they are predicted, already in this pool, and already
   * on screen. Drawing the authoritative copy beside them is the double-render.
   */
  applyReplicated(
    projectiles: readonly ProjectileState[],
    smoke: readonly SmokeState[],
    localId: number,
  ): void {
    const pool = this.system.projectiles;

    this.seenSerials.clear();
    for (const state of projectiles) {
      if (state.ownerId === localId) continue;
      this.seenSerials.add(state.serial);

      let slot = this.findReplicated(state.serial);
      if (slot === null) {
        slot = this.adoptSlot(state);
        if (slot === null) continue;
      }
      // The target, not the drawn position: `easeReplicated` closes the gap over the frames
      // until the next snapshot, so a grenade crosses the room rather than stepping across it
      // twenty times a second.
      slot.tx = state.x;
      slot.ty = state.y;
      slot.tz = state.z;
      slot.yaw = state.yaw;
      slot.resting = (state.flags & PEFlag.Resting) !== 0;
      slot.phase = (state.flags & PEFlag.Armed) !== 0 ? 'ARMED' : 'LIVE';
    }

    // Anything replicated that stopped being sent has detonated or expired. The bang itself
    // arrives as `EV.EquipmentExploded`, so this only has to stop drawing the body.
    for (const p of pool.items) {
      if (!p.active || !p.replicated) continue;
      if (!this.seenSerials.has(p.serial)) pool.release(p);
    }

    this.applyReplicatedSmoke(smoke);
  }

  /**
   * Ease every replicated grenade toward where the server last said it was.
   *
   * §8.24 asks for reconciliation *"without visible teleporting"*, and this is the half of that
   * which applies to grenades the client never predicted. Snapping to each 20 Hz sample would
   * make a thrown object move in visible steps — the one place stepping is obvious, because a
   * grenade is small, fast and the eye is following it.
   *
   * Exponential rather than a fixed lerp: the rate is chosen to close most of the gap within one
   * snapshot interval, so a grenade that has just been adopted catches up quickly and one that
   * is being updated steadily sits a few centimetres behind the truth — which is exactly the
   * trade §4.12 makes for remote bodies.
   */
  private easeReplicated(dt: number): void {
    const k = 1 - Math.exp(-REPLICATED_EASE_RATE * dt);
    for (const p of this.system.projectiles.items) {
      if (!p.active || !p.replicated) continue;
      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
      p.z += (p.tz - p.z) * k;
    }
  }

  private findReplicated(serial: number): Projectile | null {
    for (const p of this.system.projectiles.items) {
      if (p.active && p.replicated && p.serial === serial) return p;
    }
    return null;
  }

  /**
   * Take a pool slot for a replicated grenade.
   *
   * Spawned with zero velocity and then marked `replicated`, which stops `EquipmentSystem`
   * integrating it — the velocity is never used and is deliberately not on the wire, because
   * the server is sending the answer rather than the inputs to it.
   */
  private adoptSlot(state: ProjectileState): Projectile | null {
    const def = ALL_EQUIPMENT[state.kind];
    if (def === undefined) return null;
    const p = this.system.projectiles.spawn(
      def, state.ownerId, 'NONE', state.x, state.y, state.z, 0, 0, 0, def.fuseSeconds,
    );
    if (p === null) return null;
    p.serial = state.serial;
    p.replicated = true;
    p.tx = state.x;
    p.ty = state.y;
    p.tz = state.z;
    return p;
  }

  /**
   * The server's smoke, written into the field the renderer draws (§6.8).
   *
   * Replicated rather than left to the client's own field because **smoke occludes bot line of
   * sight on the server**, so where the cloud is decides who can see whom. A client drawing one
   * a metre from where the server is testing against would be showing cover that does not exist.
   *
   * Rebuilt wholesale each frame rather than reconciled by id: a cloud has no identity on the
   * wire, there are at most eight, and they neither move nor need to be told apart.
   */
  private applyReplicatedSmoke(smoke: readonly SmokeState[]): void {
    const field = this.system.smoke;
    field.clear();
    for (const s of smoke) {
      if (s.remainingDs <= 0) continue;
      field.spawn(s.x, s.y, s.z, s.radius, s.remainingDs / 10, 1);
    }
  }

  render(alpha: number, dt: number, camera: THREE.Camera): void {
    this.easeReplicated(dt);
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
    if (targetId !== this.deps.localId) return;
    const seconds = PLAYER_FLASH_SECONDS * intensity;
    if (seconds <= this.flashRemaining) return;
    this.flashRemaining = seconds;
    this.flashTotal = seconds;
  }

  private onSpawned(entityId: number): void {
    if (entityId === this.deps.localId) {
      this.refillForLife();
      return;
    }
    this.botThrower.respawn(entityId);
  }

  /**
   * A fresh life's grenades (S6.3: equipment is per life).
   *
   * Split out of `onSpawned` because a **networked** respawn emits no `player.spawned` at all:
   * `ClientMatch.respawnNetworked` deliberately does not call `PlayerController.spawn` — the
   * server chose the position and prediction has already adopted it — so the event this used to
   * hang off never fires. The counts stayed at whatever the previous life ended on, which is
   * the reported "grenades do not refill after respawn", and it is the same authority-migration
   * hole as the entity id above: the fact moved to the server and the local reader kept
   * listening for a local event.
   *
   * Deliberately **not** `reset()`: that also clears live projectiles and smoke out of the
   * world, and one player coming back to life must not delete a cloud somebody else is using.
   */
  refillForLife(): void {
    EquipmentSystem.refill(this.inventory);
    this.thrower.reset();
    this.flashRemaining = 0;
  }

  /** Every combatant, for the debug panel's smoke visualisation. */
  get roster(): readonly Combatant[] {
    return this.deps.bots.roster;
  }
}

/** The writable side of `ThrowIntent`; one instance, rewritten in place each tick. */
