import { simCos, simSin, simTan } from '../core/SimMath';

/**
 * World point to screen point, as one pure function (playtest round 4, P9 follow-up).
 *
 * ## Why this exists, and what it replaces
 *
 * There were **three** bearing calculations in the client and no two of them were the same
 * expression. `MatchFeedback` computed one for the directional hit indicator;
 * `HudTactical.updateThreat` computed a second for the live-grenade warning; and P9 extracted
 * that second one verbatim into `BearingIndicator` and gave it a **second consumer** — the bomb
 * arrow — under a comment claiming it used "the same convention `Hud.showHitDirection` uses".
 *
 * It did not. The two differ by exactly **twice the player's yaw**:
 *
 *     hit indicator     wrap(playerYaw - atan2(-(tx - px), -(tz - pz)))
 *     threat / bomb          atan2( (tx - px), -(tz - pz))  - playerYaw
 *
 * `atan2(-a, b)` is `-atan2(a, b)`, so the first is `playerYaw + A` and the second is
 * `A - playerYaw`. They agree only where `playerYaw` is 0, which is where anybody testing a
 * fresh spawn happens to be standing. `aimWithOffset` settles which is right — this project's
 * forward is `(-sin(yaw), -cos(yaw))` — and it is the hit indicator's. So the grenade arrow has
 * pointed to the wrong place for as long as it has existed, and P9 doubled the number of
 * surfaces built on it while believing it was removing a duplicate.
 *
 * The lesson is P9's own, turned around: *one component* is not the same thing as *one
 * calculation*. P9 unified the two arrows into one class and left the arithmetic inside it
 * unexamined, because both arrows are pixels and no probe in this project renders. Hence this
 * file: the arithmetic is in `shared/`, it takes matrices rather than a yaw, and `readability`
 * measures it.
 *
 * ## The matrices
 *
 * Column-major sixteen-element arrays, which is `THREE.Matrix4.elements` order, so a caller
 * hands over `camera.matrixWorldInverse.elements` and `camera.projectionMatrix.elements` with
 * no conversion. Taking them as `ArrayLike<number>` is what keeps `three` out of `shared/`
 * (`check-boundaries` forbids it) while still describing exactly what the renderer will do.
 *
 * ## Conventions, stated because getting one backwards is the whole bug above
 *
 * - View space is the camera's: **+X right, +Y up, and the camera looks down -Z**. A point in
 *   front of the camera therefore has a *negative* `viewZ`.
 * - `bearingRad` is the ring angle for an indicator drawn around the crosshair: **0 is straight
 *   ahead, positive is to the right**, growing clockwise, which is what a CSS `rotate()` on a
 *   chevron sitting at twelve o'clock does.
 * - Pixels are top-left origin, which is what the DOM uses.
 */

/** A column-major 4x4, in `THREE.Matrix4.elements` order. */
export type Mat4 = ArrayLike<number>;

export interface ScreenPoint {
  /** Normalised device coordinates, -1..1, +Y up. Meaningless when `behind`. */
  ndcX: number;
  ndcY: number;
  /** Viewport pixels, top-left origin. Meaningless when `behind`. */
  x: number;
  y: number;
  /**
   * The point is at or behind the camera plane.
   *
   * The flag exists because the projection divides by `w`, and for a point behind the camera
   * `w` is negative — so the ndc that comes out is a *mirrored* position that looks perfectly
   * plausible and is wrong by 180 degrees. An off-screen indicator that trusts it points at
   * the reflection of the thing it is tracking. `bearingRad` stays correct either way, because
   * it is taken from view space before the divide.
   */
  behind: boolean;
  /** Inside the viewport and in front of the camera. */
  onScreen: boolean;
  /**
   * Ring angle to the target: 0 ahead, positive to the right, in radians.
   *
   * Taken from the view-space direction rather than from the projected point, which is what
   * makes it defined for a target behind the camera and monotonic all the way round.
   */
  bearingRad: number;
  /** Metres in front of the camera. Negative when behind. */
  depth: number;
}

/** `out = M * (x, y, z, 1)`, column-major. Returns w separately because the divide is guarded. */
function transform(
  m: Mat4,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number; w: number },
): void {
  out.x = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out.y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out.z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  out.w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
}

const viewScratch = { x: 0, y: 0, z: 0, w: 0 };
const clipScratch = { x: 0, y: 0, z: 0, w: 0 };

/**
 * Project a world point through a camera.
 *
 * `view` is the camera's world-matrix **inverse** and `proj` its projection matrix. Both are
 * read, neither is written, and nothing is allocated — this runs once per indicator per frame
 * and S4.7 allows no allocation in the render pass.
 */
export function projectToScreen(
  view: Mat4,
  proj: Mat4,
  worldX: number,
  worldY: number,
  worldZ: number,
  viewportWidth: number,
  viewportHeight: number,
  out: ScreenPoint,
): ScreenPoint {
  transform(view, worldX, worldY, worldZ, viewScratch);

  // The camera looks down -Z, so "in front" is negative and depth is the negation.
  const depth = -viewScratch.z;
  out.depth = depth;
  out.behind = depth <= 0;

  /**
   * The bearing, from view space and before any divide.
   *
   * `atan2(right, forward)` with forward = `-viewZ`: straight ahead gives `atan2(0, +)` = 0,
   * and a target to the camera's right has a positive `viewX` and so a positive angle. It stays
   * correct and continuous through the sides and behind, where the projected position does not
   * exist at all, which is the property an off-screen indicator is entirely made of.
   */
  out.bearingRad = Math.atan2(viewScratch.x, depth);

  transform(proj, viewScratch.x, viewScratch.y, viewScratch.z, clipScratch);
  const w = clipScratch.w;
  if (w === 0) {
    out.ndcX = 0;
    out.ndcY = 0;
    out.x = viewportWidth * 0.5;
    out.y = viewportHeight * 0.5;
    out.onScreen = false;
    return out;
  }

  out.ndcX = clipScratch.x / w;
  out.ndcY = clipScratch.y / w;
  out.x = (out.ndcX * 0.5 + 0.5) * viewportWidth;
  // NDC +Y is up and pixel +Y is down.
  out.y = (1 - (out.ndcY * 0.5 + 0.5)) * viewportHeight;
  out.onScreen = !out.behind && out.ndcX >= -1 && out.ndcX <= 1 && out.ndcY >= -1 && out.ndcY <= 1;
  return out;
}

export function makeScreenPoint(): ScreenPoint {
  return { ndcX: 0, ndcY: 0, x: 0, y: 0, behind: false, onScreen: false, bearingRad: 0, depth: 0 };
}

/**
 * The view matrix for a yaw/pitch camera at a point, column-major, written into `out`.
 *
 * Not a convenience: it is the thing that makes the whole file testable without `three`. A
 * probe can build the exact matrix the renderer would and check the projection against it,
 * which is what `readability` does. The rotation order is `YXZ` — the order `CameraRig` sets on
 * its camera — and the result is the *inverse* of the camera's world matrix, which for a pure
 * rotation and translation is the transpose of the rotation with the translation folded in.
 */
export function viewMatrixFrom(
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  out: number[],
): number[] {
  const cy = simCos(yaw);
  const sy = simSin(yaw);
  const cp = simCos(pitch);
  const sp = simSin(pitch);

  // Camera basis in world space, YXZ: right, up, backward (the camera looks down its own -Z).
  const rx = cy;
  const ry = 0;
  const rz = -sy;
  const ux = sy * sp;
  const uy = cp;
  const uz = cy * sp;
  const bx = sy * cp;
  const by = -sp;
  const bz = cy * cp;

  // The inverse of [R|t] is [R^T | -R^T t]: rows of the world basis become columns here.
  out[0] = rx;
  out[1] = ux;
  out[2] = bx;
  out[3] = 0;
  out[4] = ry;
  out[5] = uy;
  out[6] = by;
  out[7] = 0;
  out[8] = rz;
  out[9] = uz;
  out[10] = bz;
  out[11] = 0;
  out[12] = -(rx * x + ry * y + rz * z);
  out[13] = -(ux * x + uy * y + uz * z);
  out[14] = -(bx * x + by * y + bz * z);
  out[15] = 1;
  return out;
}

/**
 * A standard perspective projection, column-major, written into `out`.
 *
 * Same reason as above: so a probe can measure the projection rather than assert it. Matches
 * `THREE.PerspectiveCamera.projectionMatrix` for the same four parameters.
 */
export function perspectiveMatrixFrom(
  fovDeg: number,
  aspect: number,
  near: number,
  far: number,
  out: number[],
): number[] {
  const f = 1 / simTan((fovDeg * Math.PI) / 360);
  for (let i = 0; i < 16; i++) out[i] = 0;
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}
