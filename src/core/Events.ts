import type { HitZone } from '../combat/HitboxRig';
import type { GameStateId } from '../GameStates';
import type { StanceId } from '../player/Stance';
import { EventBus } from './EventBus';

/**
 * The game's event vocabulary.
 *
 * `EV` exists so call sites read `bus.emit(EV.PlayerLanded, ...)` rather than a bare
 * string literal; the map below is what makes the payload type-checked.
 *
 * This map grows one milestone at a time. M1 declares only what M1 emits — a
 * declared-but-never-emitted event is a lie about what the game does.
 */

export const EV = {
  PlayerSpawned: 'player.spawned',
  PlayerStanceChanged: 'player.stanceChanged',
  PlayerJumped: 'player.jumped',
  PlayerLanded: 'player.landed',
  PlayerFootstep: 'player.footstep',
  PlayerSlideStarted: 'player.slideStarted',
  PlayerSlideEnded: 'player.slideEnded',
  PlayerMantleStarted: 'player.mantleStarted',
  PlayerMantleEnded: 'player.mantleEnded',
  PlayerHealthChanged: 'player.healthChanged',

  WeaponFired: 'weapon.fired',
  WeaponDryFired: 'weapon.dryFired',
  WeaponReloadStarted: 'weapon.reloadStarted',
  WeaponReloadStep: 'weapon.reloadStep',
  WeaponReloadFinished: 'weapon.reloadFinished',
  WeaponAdsChanged: 'weapon.adsChanged',
  WeaponAmmoChanged: 'weapon.ammoChanged',

  BulletImpact: 'bullet.impact',
  DamageDealt: 'damage.dealt',
  EntityKilled: 'entity.killed',

  GameStateChanged: 'game.stateChanged',
  SettingsChanged: 'settings.changed',
} as const;

export type SlideEndReason = 'expired' | 'jumpCancel' | 'crouchReleased' | 'tooSlow' | 'blocked';

/**
 * The keyframed reload sequence (S6.6). Each step is both an animation segment and an
 * audio cue, so the animation cannot drift out of sync with what you hear.
 */
export type ReloadStep = 'down' | 'magOut' | 'magIn' | 'raise' | 'charge';

/**
 * Payload map. Declared as a type alias rather than an interface so it satisfies the
 * `EventMap` index-signature constraint. Payload objects are reused and only valid
 * for the duration of the dispatch — copy anything you intend to keep.
 */
export type GameEvents = {
  [EV.PlayerSpawned]: { x: number; y: number; z: number; yaw: number };
  [EV.PlayerStanceChanged]: { from: StanceId; to: StanceId; tick: number };
  [EV.PlayerJumped]: { x: number; y: number; z: number; horizontalSpeed: number };
  /**
   * `impactSpeed` is downward velocity magnitude at the moment of contact, m/s.
   * `material` is the surface underfoot, so M2's audio can colour the sound by it.
   */
  [EV.PlayerLanded]: {
    x: number;
    y: number;
    z: number;
    impactSpeed: number;
    stance: StanceId;
    material: number;
  };
  [EV.PlayerFootstep]: {
    x: number;
    y: number;
    z: number;
    speed: number;
    heavy: boolean;
    material: number;
  };
  [EV.PlayerSlideStarted]: { x: number; y: number; z: number; entrySpeed: number };
  [EV.PlayerSlideEnded]: { reason: SlideEndReason; exitSpeed: number; tick: number };
  [EV.PlayerMantleStarted]: { x: number; y: number; z: number; ledgeHeight: number };
  [EV.PlayerMantleEnded]: { x: number; y: number; z: number; endStance: StanceId };
  [EV.PlayerHealthChanged]: { current: number; max: number; delta: number; regenerating: boolean };

  /**
   * One round left the barrel, and has already landed — every weapon is hitscan (S4.4).
   *
   * Emitted *after* the trace resolves so the payload can carry the end point, which is
   * what a tracer needs. `damage.dealt` and `bullet.impact` therefore arrive just before
   * this on the same tick; they are all rendered in the same frame, so the ordering is
   * not observable, and the alternative is a second event carrying one vector.
   *
   * `x,y,z` is the muzzle and `dx,dy,dz` is the direction *after* recoil and spread.
   * `shotIndex` is the index into the recoil pattern, which is what the debug plot reads.
   */
  [EV.WeaponFired]: {
    weaponId: string;
    x: number;
    y: number;
    z: number;
    dx: number;
    dy: number;
    dz: number;
    endX: number;
    endY: number;
    endZ: number;
    distance: number;
    shotIndex: number;
    spreadDeg: number;
    tracer: boolean;
    hitTarget: boolean;
    ammoInMag: number;
  };
  [EV.WeaponDryFired]: { weaponId: string };
  [EV.WeaponReloadStarted]: { weaponId: string; empty: boolean; duration: number };
  [EV.WeaponReloadStep]: { weaponId: string; step: ReloadStep };
  [EV.WeaponReloadFinished]: { weaponId: string; mag: number; reserve: number };
  [EV.WeaponAdsChanged]: { weaponId: string; aiming: boolean };
  [EV.WeaponAmmoChanged]: { weaponId: string; mag: number; reserve: number };

  /** A round terminated on world geometry, or punched through it. */
  [EV.BulletImpact]: {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    material: number;
    penetrated: boolean;
  };
  [EV.DamageDealt]: {
    sourceId: number;
    targetId: number;
    weaponId: string;
    zone: HitZone;
    amount: number;
    x: number;
    y: number;
    z: number;
    distance: number;
    /** Damage lost to falloff, HP. */
    falloffLoss: number;
    /** Damage lost to wall penetration, HP. */
    penetrationLoss: number;
    lethal: boolean;
  };
  [EV.EntityKilled]: { targetId: number; sourceId: number; weaponId: string; zone: HitZone };

  [EV.GameStateChanged]: { from: GameStateId; to: GameStateId };
  [EV.SettingsChanged]: { key: string };
};

export type GameBus = EventBus<GameEvents>;

export function createGameBus(): GameBus {
  return new EventBus<GameEvents>();
}
