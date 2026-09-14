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
 * Pure policy: semantic game state in, semantic slot id out.
 *
 * Files, Three.js actions, and cross-fades intentionally do not appear here — a slot is a
 * pose, and how many clips stand behind it is the catalogue's business (M13 Phase D). Missing
 * authored states (fire/slide/mantle) use the closest safe locomotion pose rather than
 * inventing a new branch in the renderer.
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

/**
 * The one-shot that overrides locomotion while the actor is doing something, or null when it
 * is not (M13 Phase D). Today that is the reload — *"a remote player mid-reload must look
 * mid-reload"* (S6.5) — in the pose the body is in: kneeling and still, standing and still,
 * or walking. A reload while running, sliding or crouch-walking has no clip and is not drawn;
 * the body keeps its locomotion loop, as it did before the slot existed. `throw` and `melee`
 * wait for their snapshot bits (v13).
 */
export function selectAction(input: ActorAnimationInput, planarSpeed: number): CharacterAnimationId | null {
  if (!input.reloading) return null;
  if (isLowStance(input)) return planarSpeed <= IDLE_SPEED ? 'reloadCrouch' : null;
  if (planarSpeed <= IDLE_SPEED) return 'reloadStand';
  if (!input.sprinting && planarSpeed < RUN_SPEED) return 'reloadWalk';
  return null;
}
