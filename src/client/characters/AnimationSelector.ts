import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';
import {
  isLowStance as isLowStanceId,
  LOCOMOTION_IDLE_SPEED,
  LOCOMOTION_RUN_SPEED,
} from '../../shared/player/Stance';
import type { CharacterAnimationId } from './CharacterCatalog';

/**
 * The walk and run thresholds are the simulation's (`shared/player/Stance`), because the
 * hitbox rig picks a crouching body's layout by the same speeds (`rigLayoutFor`, M13 C2):
 * the clip and the boxes must change pose together. A dead zone stops interpolation noise
 * from making a standing actor moonwalk; the run threshold sits above the walk cap so speed
 * from rendered pose deltas cannot flicker on the boundary. An authoritative sprint flag
 * still chooses run immediately.
 */
export const IDLE_SPEED = LOCOMOTION_IDLE_SPEED;
export const RUN_SPEED = LOCOMOTION_RUN_SPEED;

export function isLowStance(input: Pick<ActorAnimationInput, 'stance'>): boolean {
  return isLowStanceId(input.stance);
}

/**
 * Pure policy: semantic game state in, semantic clip id out.
 *
 * Files, Three.js actions, and cross-fades intentionally do not appear here. Missing authored
 * states (reload/fire/slide/mantle) use the closest safe locomotion pose rather than inventing
 * a new branch in the renderer.
 */
export function selectLocomotion(
  input: ActorAnimationInput,
  planarSpeed: number,
  armed: boolean,
): CharacterAnimationId {
  const low = isLowStance(input);

  if (low) {
    if (planarSpeed >= RUN_SPEED) return 'crouchRunAiming';
    if (planarSpeed > IDLE_SPEED) return 'crouchWalkAiming';
    return 'crouchIdleAiming';
  }

  // The current asset pack has no hip-ready loops. Its "Relaxed" standing/walking clips do
  // not hold a firearm, so an armed actor must use the reviewed weapon-ready clips even when
  // gameplay has not set ADS/firing. This is a source-asset adapter, not gameplay policy.
  if (planarSpeed <= IDLE_SPEED) return armed ? 'idleWeaponReady' : 'idleRelaxed';
  if (input.sprinting || planarSpeed >= RUN_SPEED) return 'runRelaxed';
  return armed ? 'walkWeaponReady' : 'walkRelaxed';
}

export function selectDeath(input: Pick<ActorAnimationInput, 'stance'>): CharacterAnimationId {
  return isLowStance(input) ? 'deathCrouch' : 'deathStand';
}
