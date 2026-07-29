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
  GameStateChanged: 'game.stateChanged',
  SettingsChanged: 'settings.changed',
} as const;

export type SlideEndReason = 'expired' | 'jumpCancel' | 'crouchReleased' | 'tooSlow' | 'blocked';

/**
 * Payload map. Declared as a type alias rather than an interface so it satisfies the
 * `EventMap` index-signature constraint. Payload objects are reused and only valid
 * for the duration of the dispatch — copy anything you intend to keep.
 */
export type GameEvents = {
  [EV.PlayerSpawned]: { x: number; y: number; z: number; yaw: number };
  [EV.PlayerStanceChanged]: { from: StanceId; to: StanceId; tick: number };
  [EV.PlayerJumped]: { x: number; y: number; z: number; horizontalSpeed: number };
  /** `impactSpeed` is downward velocity magnitude at the moment of contact, m/s. */
  [EV.PlayerLanded]: { x: number; y: number; z: number; impactSpeed: number; stance: StanceId };
  [EV.PlayerFootstep]: { x: number; y: number; z: number; speed: number; heavy: boolean };
  [EV.PlayerSlideStarted]: { x: number; y: number; z: number; entrySpeed: number };
  [EV.PlayerSlideEnded]: { reason: SlideEndReason; exitSpeed: number; tick: number };
  [EV.PlayerMantleStarted]: { x: number; y: number; z: number; ledgeHeight: number };
  [EV.PlayerMantleEnded]: { x: number; y: number; z: number; endStance: StanceId };
  [EV.GameStateChanged]: { from: GameStateId; to: GameStateId };
  [EV.SettingsChanged]: { key: string };
};

export type GameBus = EventBus<GameEvents>;

export function createGameBus(): GameBus {
  return new EventBus<GameEvents>();
}
