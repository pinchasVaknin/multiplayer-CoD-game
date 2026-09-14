import type { MovementConfig } from './MovementConfig';

/**
 * Stance machine vocabulary (brief S5.3).
 *
 * Stance is the single authority for capsule height, eye height and the movement
 * speed cap. Nothing else may set those independently.
 */
export type StanceId = 'STAND' | 'CROUCH' | 'SLIDE' | 'AIRBORNE' | 'MANTLE';

export const STANCES: readonly StanceId[] = ['STAND', 'CROUCH', 'SLIDE', 'AIRBORNE', 'MANTLE'];

/**
 * Every legal edge, in one place.
 *
 *  STAND    -> CROUCH (crouch pressed), SLIDE (sprint+crouch), AIRBORNE (jump/step off), MANTLE
 *  CROUCH   -> STAND (clearance permitting), SLIDE, AIRBORNE, MANTLE
 *  SLIDE    -> CROUCH (natural end / crouch held), STAND (clearance permitting),
 *              AIRBORNE (jump-cancel), MANTLE (slide into a ledge)
 *  AIRBORNE -> STAND, CROUCH (landing), MANTLE
 *  MANTLE   -> STAND, CROUCH (whichever fits at the top), AIRBORNE (top is a drop)
 */
const LEGAL: Readonly<Record<StanceId, readonly StanceId[]>> = {
  STAND: ['CROUCH', 'SLIDE', 'AIRBORNE', 'MANTLE'],
  CROUCH: ['STAND', 'SLIDE', 'AIRBORNE', 'MANTLE'],
  SLIDE: ['CROUCH', 'STAND', 'AIRBORNE', 'MANTLE'],
  AIRBORNE: ['STAND', 'CROUCH', 'MANTLE'],
  MANTLE: ['STAND', 'CROUCH', 'AIRBORNE'],
};

export function isLegalStanceTransition(from: StanceId, to: StanceId): boolean {
  return from === to || LEGAL[from].includes(to);
}

/**
 * The stances a body is drawn low in. A slide and a mantle have no authored clips of their
 * own and are drawn with the crouch loops (`AnimationSelector`), and since M13 C2 the hitbox
 * rig follows the same rule (`rigLayoutFor`): one predicate, so the boxes and the body cannot
 * disagree about which pose a stance is.
 */
export function isLowStance(stance: StanceId): boolean {
  return stance === 'CROUCH' || stance === 'SLIDE' || stance === 'MANTLE';
}

/**
 * How fast a body reads as walking, metres per second. A dead zone, so interpolation noise
 * cannot make a standing actor moonwalk — and, since M13 C2, the speed at which a crouching
 * rig switches from the kneeling layout to the walking one. Shared for that reason: the
 * renderer and the simulation pick the same pose at the same speed.
 */
export const LOCOMOTION_IDLE_SPEED = 0.12;

/**
 * Above this a body is drawn with a run loop. Deliberately above the 4.6 m/s walk cap: the
 * renderer's speed comes from pose deltas and must not flicker on the walk/run boundary. A
 * crouching body only reaches it in a slide, which is why the slide's rig is the crouch-run
 * layout while the slide is fast and the crouch-walk layout once it has bled off.
 */
export const LOCOMOTION_RUN_SPEED = 5.4;

/** Collision capsule height for a stance, metres. */
export function capsuleHeightFor(cfg: MovementConfig, stance: StanceId): number {
  switch (stance) {
    case 'STAND':
      return cfg.standHeight;
    case 'CROUCH':
      return cfg.crouchHeight;
    case 'SLIDE':
      return cfg.slideHeight;
    case 'AIRBORNE':
      return cfg.standHeight;
    case 'MANTLE':
      return cfg.crouchHeight;
  }
}

/** Camera eye height for a stance, metres above the feet. */
export function eyeHeightFor(cfg: MovementConfig, stance: StanceId): number {
  switch (stance) {
    case 'STAND':
      return cfg.standEye;
    case 'CROUCH':
      return cfg.crouchEye;
    case 'SLIDE':
      return cfg.slideEye;
    case 'AIRBORNE':
      return cfg.standEye;
    case 'MANTLE':
      return cfg.crouchEye;
  }
}

