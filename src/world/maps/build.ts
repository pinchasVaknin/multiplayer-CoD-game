import type { Brush, MaterialKey, PropDef, PropShapeId } from './types';

/**
 * Authoring helpers for the map DSL.
 *
 * M1's grey-box room built its brushes with a local `add` closure and worked out its two
 * ramps by hand. Foundry has nine pitched surfaces and is rotationally symmetric, so both
 * jobs are worth doing once, properly, where a second map can use them.
 *
 * Two rules are encoded here rather than left to the author:
 *
 * **A ramp is defined by the two ends of its walking surface**, not by an angle and an
 * offset. `rampAlongX(out, m, x0, y0, x1, y1, ...)` produces a pitched box whose top face
 * passes exactly through both points, which is what stops a 2 cm lip at the bottom of a
 * ramp — a lip that is a movement bug, not a cosmetic one.
 *
 * **Rotational symmetry is applied, not retyped.** `rotateHalf` maps a placement through
 * 180 degrees about the origin: `(x, z) -> (-x, -z)`, `yaw -> yaw + pi`. Authoring one
 * outer lane and rotating it is the only way to be *certain* the two are equally fair,
 * and it halves what there is to get wrong. It is deliberately restricted to yaw-only
 * brushes: the collider basis composes as `Rz * Rx * Ry` (see `ColliderSet.writeBasis`),
 * so adding pi to `rotationY` is a world-space rotation for a yaw-only brush and is *not*
 * one for a pitched brush. Ramps are authored per side through the helpers above, which is
 * why `rotateHalf` throws rather than silently producing a ramp pointing into the floor.
 */

export interface BoxOptions {
  solid?: boolean;
  shadows?: boolean;
  uvScale?: number;
  rotationY?: number;
}

/** An axis-aligned (or yawed) box, given its centre and full extents. */
export function addBox(
  out: Brush[],
  material: MaterialKey,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  options?: BoxOptions,
): void {
  out.push({
    position: { x: cx, y: cy, z: cz },
    size: { x: sx, y: sy, z: sz },
    rotationY: options?.rotationY ?? 0,
    material,
    ...(options?.solid === undefined ? {} : { solid: options.solid }),
    ...(options?.shadows === undefined ? {} : { shadows: options.shadows }),
    ...(options?.uvScale === undefined ? {} : { uvScale: options.uvScale }),
  });
}

/** A box given the interval it spans on each axis. Easier to keep walls flush with. */
export function addSpan(
  out: Brush[],
  material: MaterialKey,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  options?: BoxOptions,
): void {
  addBox(
    out,
    material,
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    (z0 + z1) / 2,
    Math.abs(x1 - x0),
    Math.abs(y1 - y0),
    Math.abs(z1 - z0),
    options,
  );
}

/**
 * A ramp pitched along X. The top face passes exactly through `(x0, y0)` and `(x1, y1)`.
 *
 * Endpoints are ordered internally so the box's local +Y is always the up-facing side; a
 * box is symmetric, so swapping the ends describes the same solid but keeps the surface
 * normal the right way up.
 */
export function rampAlongX(
  out: Brush[],
  material: MaterialKey,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  zCenter: number,
  zSize: number,
  thickness: number,
): void {
  const [ax, ay, bx, by] = x0 <= x1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  // Surface normal, pointing up out of the slope.
  const nx = -dy / len;
  const ny = dx / len;
  out.push({
    position: {
      x: (ax + bx) / 2 - nx * (thickness / 2),
      y: (ay + by) / 2 - ny * (thickness / 2),
      z: zCenter,
    },
    size: { x: len, y: thickness, z: zSize },
    rotationY: 0,
    rotationZ: angle,
    material,
  });
}

/** A ramp pitched along Z. The top face passes exactly through `(z0, y0)` and `(z1, y1)`. */
export function rampAlongZ(
  out: Brush[],
  material: MaterialKey,
  z0: number,
  y0: number,
  z1: number,
  y1: number,
  xCenter: number,
  xSize: number,
  thickness: number,
): void {
  const [az, ay, bz, by] = z0 <= z1 ? [z0, y0, z1, y1] : [z1, y1, z0, y0];
  const dz = bz - az;
  const dy = by - ay;
  const len = Math.hypot(dz, dy);
  // With `rotationX = phi` the box's local +Z is `(0, -sin phi, cos phi)`, so descending
  // toward +Z is a positive angle. Same convention the grey-box pit ramp uses.
  const angle = Math.atan2(-dy, dz);
  const ny = Math.cos(angle);
  const nz = Math.sin(angle);
  out.push({
    position: {
      x: xCenter,
      y: (ay + by) / 2 - ny * (thickness / 2),
      z: (az + bz) / 2 - nz * (thickness / 2),
    },
    size: { x: xSize, y: thickness, z: len },
    rotationY: 0,
    rotationX: angle,
    material,
  });
}

/** A prop placement. */
export function addProp(
  out: PropDef[],
  shape: PropShapeId,
  x: number,
  z: number,
  rotationY = 0,
  y = 0,
): void {
  out.push({ shape, position: { x, y, z }, rotationY });
}

/**
 * The same brushes rotated 180 degrees about the origin.
 *
 * Throws on a pitched brush rather than producing one that is subtly wrong — see the file
 * comment. Pitched geometry is authored per side.
 */
export function rotateHalf(brushes: readonly Brush[]): Brush[] {
  return brushes.map((b) => {
    if (b.rotationX !== undefined || b.rotationZ !== undefined) {
      throw new Error('rotateHalf cannot mirror a pitched brush; author both sides explicitly.');
    }
    return {
      ...b,
      position: { x: -b.position.x, y: b.position.y, z: -b.position.z },
      rotationY: b.rotationY + Math.PI,
    };
  });
}

/** The same prop placements rotated 180 degrees about the origin. */
export function rotateHalfProps(props: readonly PropDef[]): PropDef[] {
  return props.map((p) => ({
    shape: p.shape,
    position: { x: -p.position.x, y: p.position.y, z: -p.position.z },
    rotationY: p.rotationY + Math.PI,
  }));
}
