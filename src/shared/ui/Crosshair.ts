import { DEG2RAD } from '../core/MathUtil';
import { simTan } from '../core/SimMath';

/**
 * The crosshair's geometry, as arithmetic (playtest round 4, B2).
 *
 * The gap between the four lines is the spread cone projected onto the screen, so what the
 * crosshair shows is literally where the rounds can go rather than a decorative animation of
 * it. That projection used to live inside `Hud.updateCrosshair`, next to the `style.transform`
 * writes it feeds — which meant the only way to ask "how wide is the M4's crosshair at rest"
 * was to open a browser and look. B2 was a report about a crosshair, and answering it began
 * with three hours of not being able to check a number.
 *
 * So the arithmetic is here and the DOM writes stay in `Hud`. Same split, and same reason, as
 * `HudSurfaces`: `shared/` compiles without the DOM lib, so this process can run it and a
 * claim about the reticle stops being a browser claim.
 */

/** Crosshair line length in px; must match `--hud-cross-len` in `hud.css`. */
export const CROSSHAIR_LINE_LENGTH = 7;

/**
 * The legibility floor, in pixels, and it is a floor rather than a tuning constant.
 *
 * A crosshair whose gap has collapsed to nothing is a solid plus sign, and a solid plus sign
 * over a distant torso is a reticle the player is aiming *around* rather than with. Below this
 * the four lines and the centre dot merge at any sane DPI. It is deliberately not zero even
 * though zero is what the projection wants for a perfectly accurate weapon: an invisible
 * reticle is a readability defect, not a balance reward.
 *
 * Measured against the shipped roster by `npm run readability`: **0 of 48 hip-fire states reach
 * it.** The tightest cone in the game is the shotgun's 0.9 degrees standing, which projects to
 * 8 px at 1080p and 90 degrees of FOV, and 7 px crouched — so this is a guard rather than a
 * number the game is currently sitting on. What it protects against is a future weapon, or an
 * attachment stack, that takes a cone below about 0.25 degrees.
 *
 * Worth recording because B2 was reported as a closed crosshair on an AR and the projection was
 * the first suspect: `ar_longbow` has the **widest** gap of the four ARs, at 26 px standing
 * against the M4's 18. Whatever the player saw, it was not this.
 */
export const CROSSHAIR_MIN_GAP = 3;

/** Beyond this the cross has left the screen and there is nothing more to say. */
export const CROSSHAIR_MAX_GAP = 220;

/**
 * Half-width of the crosshair gap in CSS pixels.
 *
 * `fovDeg` is the camera's **vertical** field of view, which is what `CameraRig.fov` holds and
 * what `viewportHeight` is the extent of — so the projection is a ratio of tangents against
 * the half-height and needs no aspect term.
 */
export function crosshairGapPx(spreadDeg: number, fovDeg: number, viewportHeight: number): number {
  const halfHeight = viewportHeight * 0.5;
  /**
   * `simTan`, not `Math.tan`, because `check-boundaries` requires it of everything in
   * `shared/` — and here that rule is buying something it was not written for. The point of
   * moving this function was that the harness and the browser should agree about the reticle;
   * a transcendental that differs in the last place between two JS engines would make them
   * agree to within a rounding error instead of exactly. The result is rounded to a whole
   * pixel either way, so nothing on screen moves.
   */
  const tanHalfFov = simTan(fovDeg * 0.5 * DEG2RAD);
  const projected = tanHalfFov > 1e-4 ? (simTan(spreadDeg * DEG2RAD) / tanHalfFov) * halfHeight : 0;
  return Math.round(Math.min(CROSSHAIR_MAX_GAP, Math.max(CROSSHAIR_MIN_GAP, projected)));
}

/**
 * Whether the gap is at the floor rather than at what the cone asked for.
 *
 * The probe's assertion, and the only honest way to report the floor: a run that says "0 at the
 * floor" out of 0 weapons examined is a run that never looked, so the caller carries the
 * denominator. See `readability`.
 */
export function crosshairAtFloor(spreadDeg: number, fovDeg: number, viewportHeight: number): boolean {
  return crosshairGapPx(spreadDeg, fovDeg, viewportHeight) <= CROSSHAIR_MIN_GAP;
}

/**
 * Opacity of the reticle at a given ADS fraction.
 *
 * Hidden on ADS (S6.5): the sights are the aiming reference and an overlaid cross on top of
 * them is two aiming references disagreeing. The 1.35 makes it reach zero at an ADS fraction
 * of about 0.74, which is *before* `SCOPE_VIEWMODEL_HIDDEN` at 0.8 — so on a scoped weapon the
 * crosshair is already gone by the time the scope overlay takes over, and there is no frame in
 * which both are drawn.
 *
 * B2 is what happens when a weapon has neither: `ar_longbow` carried a scope in its **model**
 * and none in its **def**, so the crosshair faded out on schedule, the overlay never arrived
 * because `hasScope` is `def.scope !== undefined`, and the player was left aiming at the
 * capped end of an opaque tube. The fix is in `WeaponMeshParts`, not here — this function was
 * always right, and it is documented here so the next reader does not suspect it again.
 */
export function crosshairOpacity(adsFraction: number): number {
  const clamped = Math.max(0, Math.min(1, adsFraction * 1.35));
  return Math.round((1 - clamped) * 100) / 100;
}
