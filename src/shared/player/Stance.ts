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

export function legalStanceTargets(from: StanceId): readonly StanceId[] {
  return LEGAL[from];
}

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

/** Horizontal speed cap for a stance, before sprint/ADS modifiers. */
export function baseSpeedFor(cfg: MovementConfig, stance: StanceId): number {
  switch (stance) {
    case 'STAND':
      return cfg.walkSpeed;
    case 'CROUCH':
      return cfg.crouchSpeed;
    case 'SLIDE':
      return cfg.slideStartSpeed;
    case 'AIRBORNE':
      return cfg.sprintSpeed;
    case 'MANTLE':
      return 0;
  }
}
