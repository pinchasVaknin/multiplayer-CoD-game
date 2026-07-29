import type { ColliderSet } from './ColliderSet';

/**
 * Primitive tests against a single oriented box from a ColliderSet.
 *
 * Both routines work by rigid-transforming the query into the box's local space,
 * where the box is an axis-aligned box centred on the origin. A rigid transform
 * preserves capsules and rays exactly, so this costs one dot product per axis and
 * buys arbitrary box orientation for free — which is what lets a ramp be a pitched
 * brush rather than a special case.
 *
 * Nothing here allocates. Results are written into caller-owned records.
 */

const EPS = 1e-6;

export interface Contact {
  /** Penetration depth along `n`, metres. Positive when touching. */
  depth: number;
  /** Unit contact normal in world space, pointing out of the box toward the capsule. */
  nx: number;
  ny: number;
  nz: number;
  /** Contact point on the box surface, world space. */
  px: number;
  py: number;
  pz: number;
  /** Collider index. */
  index: number;
}

export function makeContact(): Contact {
  return { depth: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, index: -1 };
}

export interface RayHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  index: number;
}

export function makeRayHit(): RayHit {
  return { t: 0, nx: 0, ny: 0, nz: 0, index: -1 };
}

/**
 * Capsule (segment A..B, radius r) versus oriented box.
 *
 * The segment endpoints are the centres of the capsule's end spheres, so a capsule of
 * total height `h` standing on `feetY` has A at feetY + r and B at feetY + h - r.
 *
 * Returns true and fills `out` when the shapes overlap.
 */
export function capsuleBoxPenetration(
  set: ColliderSet,
  i: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  out: Contact,
): boolean {
  const cx = set.centerX(i);
  const cy = set.centerY(i);
  const cz = set.centerZ(i);
  const hx = set.halfX(i);
  const hy = set.halfY(i);
  const hz = set.halfZ(i);

  // World -> local.
  let lax: number;
  let lay: number;
  let laz: number;
  let lbx: number;
  let lby: number;
  let lbz: number;

  const aligned = set.isAxisAligned(i);
  const b0 = set.basisAt(i, 0);
  const b1 = set.basisAt(i, 1);
  const b2 = set.basisAt(i, 2);
  const b3 = set.basisAt(i, 3);
  const b4 = set.basisAt(i, 4);
  const b5 = set.basisAt(i, 5);
  const b6 = set.basisAt(i, 6);
  const b7 = set.basisAt(i, 7);
  const b8 = set.basisAt(i, 8);

  const dax = ax - cx;
  const day = ay - cy;
  const daz = az - cz;
  const dbx = bx - cx;
  const dby = by - cy;
  const dbz = bz - cz;

  if (aligned) {
    lax = dax;
    lay = day;
    laz = daz;
    lbx = dbx;
    lby = dby;
    lbz = dbz;
  } else {
    lax = dax * b0 + day * b1 + daz * b2;
    lay = dax * b3 + day * b4 + daz * b5;
    laz = dax * b6 + day * b7 + daz * b8;
    lbx = dbx * b0 + dby * b1 + dbz * b2;
    lby = dbx * b3 + dby * b4 + dbz * b5;
    lbz = dbx * b6 + dby * b7 + dbz * b8;
  }

  // Cheap reject: does the segment's local AABB, grown by r, miss the box?
  if (Math.min(lax, lbx) - radius > hx || Math.max(lax, lbx) + radius < -hx) return false;
  if (Math.min(lay, lby) - radius > hy || Math.max(lay, lby) + radius < -hy) return false;
  if (Math.min(laz, lbz) - radius > hz || Math.max(laz, lbz) + radius < -hz) return false;

  const sx = lbx - lax;
  const sy = lby - lay;
  const sz = lbz - laz;
  const segLenSq = sx * sx + sy * sy + sz * sz;

  // Closest point between the segment and the box, by alternating projection.
  // Seed with the point nearest the box centre (the local origin), then clamp/reproject.
  // Three rounds is well past convergence for a capsule-sized query.
  let t = segLenSq > EPS ? clamp01((-lax * sx - lay * sy - laz * sz) / segLenSq) : 0;
  let pxL = 0;
  let pyL = 0;
  let pzL = 0;
  let qx = 0;
  let qy = 0;
  let qz = 0;

  for (let iter = 0; iter < 3; iter++) {
    pxL = lax + sx * t;
    pyL = lay + sy * t;
    pzL = laz + sz * t;
    qx = clamp(pxL, -hx, hx);
    qy = clamp(pyL, -hy, hy);
    qz = clamp(pzL, -hz, hz);
    if (segLenSq <= EPS) break;
    t = clamp01(((qx - lax) * sx + (qy - lay) * sy + (qz - laz) * sz) / segLenSq);
  }
  pxL = lax + sx * t;
  pyL = lay + sy * t;
  pzL = laz + sz * t;
  qx = clamp(pxL, -hx, hx);
  qy = clamp(pyL, -hy, hy);
  qz = clamp(pzL, -hz, hz);

  const vx = pxL - qx;
  const vy = pyL - qy;
  const vz = pzL - qz;
  const distSq = vx * vx + vy * vy + vz * vz;

  let nlx: number;
  let nly: number;
  let nlz: number;
  let depth: number;

  if (distSq > EPS) {
    if (distSq >= radius * radius) return false;
    const dist = Math.sqrt(distSq);
    const inv = 1 / dist;
    nlx = vx * inv;
    nly = vy * inv;
    nlz = vz * inv;
    depth = radius - dist;
  } else {
    // Capsule axis is inside the box. Escape along the shallowest face.
    const ox = hx - Math.abs(pxL);
    const oy = hy - Math.abs(pyL);
    const oz = hz - Math.abs(pzL);
    if (ox <= oy && ox <= oz) {
      nlx = pxL >= 0 ? 1 : -1;
      nly = 0;
      nlz = 0;
      depth = radius + ox;
      qx = nlx * hx;
    } else if (oy <= oz) {
      nlx = 0;
      nly = pyL >= 0 ? 1 : -1;
      nlz = 0;
      depth = radius + oy;
      qy = nly * hy;
    } else {
      nlx = 0;
      nly = 0;
      nlz = pzL >= 0 ? 1 : -1;
      depth = radius + oz;
      qz = nlz * hz;
    }
  }

  // Local -> world.
  if (aligned) {
    out.nx = nlx;
    out.ny = nly;
    out.nz = nlz;
    out.px = qx + cx;
    out.py = qy + cy;
    out.pz = qz + cz;
  } else {
    out.nx = nlx * b0 + nly * b3 + nlz * b6;
    out.ny = nlx * b1 + nly * b4 + nlz * b7;
    out.nz = nlx * b2 + nly * b5 + nlz * b8;
    out.px = cx + qx * b0 + qy * b3 + qz * b6;
    out.py = cy + qx * b1 + qy * b4 + qz * b7;
    out.pz = cz + qx * b2 + qy * b5 + qz * b8;
  }
  out.depth = depth;
  out.index = i;
  return true;
}

/**
 * Ray versus oriented box, slab test in local space.
 * `out.t` is distance along the (unit) direction. Returns false past `maxT`.
 */
export function rayBox(
  set: ColliderSet,
  i: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: RayHit,
): boolean {
  const cx = set.centerX(i);
  const cy = set.centerY(i);
  const cz = set.centerZ(i);
  const aligned = set.isAxisAligned(i);

  const b0 = set.basisAt(i, 0);
  const b1 = set.basisAt(i, 1);
  const b2 = set.basisAt(i, 2);
  const b3 = set.basisAt(i, 3);
  const b4 = set.basisAt(i, 4);
  const b5 = set.basisAt(i, 5);
  const b6 = set.basisAt(i, 6);
  const b7 = set.basisAt(i, 7);
  const b8 = set.basisAt(i, 8);

  const rx = ox - cx;
  const ry = oy - cy;
  const rz = oz - cz;

  let lox: number;
  let loy: number;
  let loz: number;
  let ldx: number;
  let ldy: number;
  let ldz: number;
  if (aligned) {
    lox = rx;
    loy = ry;
    loz = rz;
    ldx = dx;
    ldy = dy;
    ldz = dz;
  } else {
    lox = rx * b0 + ry * b1 + rz * b2;
    loy = rx * b3 + ry * b4 + rz * b5;
    loz = rx * b6 + ry * b7 + rz * b8;
    ldx = dx * b0 + dy * b1 + dz * b2;
    ldy = dx * b3 + dy * b4 + dz * b5;
    ldz = dx * b6 + dy * b7 + dz * b8;
  }

  let tmin = 0;
  let tmax = maxT;
  let axis = 0;
  let axisSign = 0;

  // X slab
  {
    const h = set.halfX(i);
    if (Math.abs(ldx) < EPS) {
      if (lox < -h || lox > h) return false;
    } else {
      const inv = 1 / ldx;
      let t1 = (-h - lox) * inv;
      let t2 = (h - lox) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = 0;
        axisSign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }
  // Y slab
  {
    const h = set.halfY(i);
    if (Math.abs(ldy) < EPS) {
      if (loy < -h || loy > h) return false;
    } else {
      const inv = 1 / ldy;
      let t1 = (-h - loy) * inv;
      let t2 = (h - loy) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = 1;
        axisSign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }
  // Z slab
  {
    const h = set.halfZ(i);
    if (Math.abs(ldz) < EPS) {
      if (loz < -h || loz > h) return false;
    } else {
      const inv = 1 / ldz;
      let t1 = (-h - loz) * inv;
      let t2 = (h - loz) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = 2;
        axisSign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }

  out.t = tmin;
  out.index = i;

  if (axisSign === 0) {
    // Origin was already inside the box: report a normal facing the ray source.
    out.nx = -dx;
    out.ny = -dy;
    out.nz = -dz;
    return true;
  }

  const nlx = axis === 0 ? axisSign : 0;
  const nly = axis === 1 ? axisSign : 0;
  const nlz = axis === 2 ? axisSign : 0;
  if (aligned) {
    out.nx = nlx;
    out.ny = nly;
    out.nz = nlz;
  } else {
    out.nx = nlx * b0 + nly * b3 + nlz * b6;
    out.ny = nlx * b1 + nly * b4 + nlz * b7;
    out.nz = nlx * b2 + nly * b5 + nlz * b8;
  }
  return true;
}

/**
 * Distance at which a ray *leaves* an oriented box, or -1 if it never enters.
 *
 * This is the far slab intersection rather than the near one, and it is what wall
 * penetration is measured with: `exit - entry` is exactly how much material the round
 * has to push through (brief S6.4). Doing it as a second slab test against the same box
 * is both cheaper and more robust than re-casting from inside the geometry, where a
 * ray origin sitting a hair on the wrong side of a face flips the answer.
 */
export function rayBoxExit(
  set: ColliderSet,
  i: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const cx = set.centerX(i);
  const cy = set.centerY(i);
  const cz = set.centerZ(i);
  const aligned = set.isAxisAligned(i);

  const rx = ox - cx;
  const ry = oy - cy;
  const rz = oz - cz;

  let lox: number;
  let loy: number;
  let loz: number;
  let ldx: number;
  let ldy: number;
  let ldz: number;
  if (aligned) {
    lox = rx;
    loy = ry;
    loz = rz;
    ldx = dx;
    ldy = dy;
    ldz = dz;
  } else {
    const b0 = set.basisAt(i, 0);
    const b1 = set.basisAt(i, 1);
    const b2 = set.basisAt(i, 2);
    const b3 = set.basisAt(i, 3);
    const b4 = set.basisAt(i, 4);
    const b5 = set.basisAt(i, 5);
    const b6 = set.basisAt(i, 6);
    const b7 = set.basisAt(i, 7);
    const b8 = set.basisAt(i, 8);
    lox = rx * b0 + ry * b1 + rz * b2;
    loy = rx * b3 + ry * b4 + rz * b5;
    loz = rx * b6 + ry * b7 + rz * b8;
    ldx = dx * b0 + dy * b1 + dz * b2;
    ldy = dx * b3 + dy * b4 + dz * b5;
    ldz = dx * b6 + dy * b7 + dz * b8;
  }

  // Unrolled per axis rather than looped over a scratch array: this runs once per
  // penetrated surface per shot and must not allocate.
  exitMin = -Infinity;
  exitMax = Infinity;
  if (!exitSlab(lox, ldx, set.halfX(i))) return -1;
  if (!exitSlab(loy, ldy, set.halfY(i))) return -1;
  if (!exitSlab(loz, ldz, set.halfZ(i))) return -1;
  return exitMax;
}

let exitMin = 0;
let exitMax = 0;

function exitSlab(o: number, d: number, h: number): boolean {
  if (Math.abs(d) < EPS) return o >= -h && o <= h;
  const inv = 1 / d;
  let t1 = (-h - o) * inv;
  let t2 = (h - o) * inv;
  if (t1 > t2) {
    const tmp = t1;
    t1 = t2;
    t2 = tmp;
  }
  if (t1 > exitMin) exitMin = t1;
  if (t2 < exitMax) exitMax = t2;
  return exitMin <= exitMax;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
