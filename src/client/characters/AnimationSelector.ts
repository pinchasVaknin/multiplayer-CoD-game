import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';
import type { CharacterAnimationId } from './CharacterCatalog';

/** A dead zone stops interpolation noise from making a standing actor moonwalk. */
export const IDLE_SPEED = 0.12;
/**
 * Above this, a non-sprinting standing actor uses the authored run loop. It intentionally sits
 * above the 4.6 m/s walk cap: speed comes from rendered pose deltas and must not flicker exactly
 * on the walk/run boundary. An authoritative sprint flag still chooses run immediately.
 */
export const RUN_SPEED = 5.4;

export function isLowStance(input: Pick<ActorAnimationInput, 'stance'>): boolean {
  return input.stance === 'CROUCH' || input.stance === 'SLIDE' || input.stance === 'MANTLE';
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
