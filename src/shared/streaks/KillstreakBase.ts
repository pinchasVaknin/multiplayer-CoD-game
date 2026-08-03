import type * as THREE from 'three';
import type { BotDirector } from '../ai/BotDirector';
import type { BotTeam, Combatant } from '../ai/Combatant';
import type { DamageSystem } from '../combat/DamageSystem';
import type { GameBus } from '../core/Events';
import type { Rng } from '../core/Rng';
import type { CameraRig } from '../../client/engine/CameraRig';
import type { Fx } from '../../client/engine/Fx';
import type { TierTable } from '../ai/DifficultyTiers';
import type { StreakAudio } from '../../client/streaks/StreakAudio';
import type { CollisionWorld } from '../world/CollisionWorld';
import type { MapDef } from '../world/maps/types';
import type { StreakConfig, StreakDef } from './StreakDefs';

/**
 * What a killstreak is (brief S6.1).
 *
 * The brief's phrasing is the whole design: *"streaks are entities in the world, not special
 * cases in the player controller."* Nothing in `player/` knows a streak exists. A streak is
 * constructed, lives for a while, ticks on the sim clock, and is disposed — and the four hooks
 * below are its entire contract.
 *
 * Two consequences worth stating, because they are what stop this becoming a pile of
 * special cases:
 *
 * **Streaks talk through the bus, not through the player.** A UAV does not reach into the HUD
 * to draw dots; it raises a flag `StreakSystem` publishes and the minimap reads. A sentry does
 * not call the player's weapon; it goes through `DamageSystem` like everything else, so its
 * kills feed the killfeed, the score and the challenge tracker with no new wiring.
 *
 * **A streak owns its own scene objects and takes them apart in `onExpire`.** The match's heap
 * harness runs three matches and logs the boundary; a streak that leaves a mesh in the scene is
 * exactly the shape of leak it exists to catch.
 *
 * `onTick` runs on the fixed 60 Hz sim tick and must never multiply by a frame delta (S4.1).
 * `onRender` is the one place a streak may use a real `dt`, and it is presentation only.
 */

/** Everything a streak is allowed to touch. Handed in; never reached for. */
export interface StreakContext {
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly world: CollisionWorld;
  readonly damage: DamageSystem;
  readonly bots: BotDirector;
  readonly audio: StreakAudio;
  readonly fx: Fx;
  readonly cameraRig: CameraRig;
  readonly mapDef: MapDef;
  readonly cfg: StreakConfig;
  readonly rng: Rng;
  /** The bot difficulty table. A sentry's aim tier is derived from it (S6.1). */
  readonly tiers: TierTable;
  /**
   * Draw an explosion. Supplied by `Match` from the M5 equipment Fx rather than imported, so
   * `streaks/` does not depend on `equipment/` for a puff of light.
   */
  readonly blast: (x: number, y: number, z: number, radius: number, bright: boolean) => void;
  /** Bots *and* the player, the same array `ai/` and the modes use. */
  readonly roster: readonly Combatant[];
  /**
   * Whether this entity may be targeted by a streak (M6's Cold-Blooded hook).
   *
   * A predicate rather than a set, for the same reason `BotDirector.silentFootsteps` is one:
   * the answer is a property of a loadout, and `streaks/` has no business knowing what a perk
   * is. `Match` answers.
   */
  readonly targetable: (entityId: number) => boolean;
  /** Whether this entity shows up on a UAV sweep (M6's Ghost hook). */
  readonly visibleToUav: (entityId: number) => boolean;
  /** Entity ids allocated to streak-owned world objects, so damage can address them. */
  readonly nextEntityId: () => number;
}

/** Live state, for the debug panel and the HUD. */
export type StreakPhase = 'ACTIVE' | 'EXPIRED';

export abstract class Killstreak {
  readonly def: StreakDef;
  /** Who called it in. Kills are credited here. */
  readonly ownerId: number;
  readonly ownerTeam: BotTeam;
  /** Unique per activation, so two sentries are distinguishable in the panel. */
  readonly instanceId: number;

  phase: StreakPhase = 'ACTIVE';
  /** Seconds this streak has been alive. Advanced on sim ticks only. */
  age = 0;

  protected readonly ctx: StreakContext;

  constructor(def: StreakDef, ownerId: number, ownerTeam: BotTeam, instanceId: number, ctx: StreakContext) {
    this.def = def;
    this.ownerId = ownerId;
    this.ownerTeam = ownerTeam;
    this.instanceId = instanceId;
    this.ctx = ctx;
  }

  /** Seconds left, or Infinity for a streak that ends on its own terms. */
  get secondsRemaining(): number {
    if (this.def.durationSeconds <= 0) return Infinity;
    return Math.max(0, this.def.durationSeconds - this.age);
  }

  /**
   * Called once when the streak is *earned*, before it is spendable.
   *
   * Separate from `onActivate` because earning and spending are different moments: the brief
   * says streaks are "earned by consecutive kills, spendable, lost on death", so a streak can
   * sit in the player's hand and be lost without ever being activated. The default does
   * nothing, which is right for every streak that has no announcement of its own.
   */
  onEarn(): void {
    /* Most streaks have nothing to say until they are spent. */
  }

  /** Called once when the streak goes live. Build meshes and register damageables here. */
  abstract onActivate(): void;

  /**
   * One sim tick. Return false to expire early — a sentry that has been shot down, a care
   * package that has been claimed.
   */
  abstract onTick(tick: number): boolean;

  /** Presentation only. `dt` is a real frame delta and nothing gameplay-facing may read it. */
  onRender(_dt: number, _alpha: number): void {
    /* Most streaks have no per-frame presentation beyond what Fx already draws. */
  }

  /** The exact mirror of `onActivate`. Called once, whether it expired or was destroyed. */
  abstract onExpire(): void;

  /** One line for the streak debug panel (S7). */
  abstract describe(): string;
}
