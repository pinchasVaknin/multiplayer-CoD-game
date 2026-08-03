import { simCos, simSin } from '../core/SimMath';
/**
 * Oriented-box hitbox rig (brief S6.3).
 *
 * Built here, in M2, against static dummies where the multipliers can be verified
 * against printed damage numbers. M3's bots attach the same rig unchanged — retrofitting
 * it later would touch the whole damage path.
 *
 * A rig is real geometry: head, torso, two arms, two legs. Not one capsule. Ray tests
 * run against the entity's own box set and never touch the scene graph.
 *
 * Layout is shared (every humanoid points at the same `RigLayout`); only the transform
 * is per-entity. Nothing here allocates: hits are written into a caller-owned record.
 */

export type HitZone = 'head' | 'torso' | 'arm' | 'leg';

export const HIT_ZONES: readonly HitZone[] = ['head', 'torso', 'arm', 'leg'];

export interface HitboxDef {
  readonly name: string;
  readonly zone: HitZone;
  /** Centre in entity-local space; the entity origin sits at its feet. */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Full extents. */
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /**
   * Upper half of the torso — the chest, as opposed to the abdomen (M5).
   *
   * S6.1 asks the snipers to one-shot "upper torso and head", and the torso zone alone
   * cannot express that. This is a flag on the box rather than a fifth `HitZone` on
   * purpose: every zone multiplier M2 verified is still applied to the same set of boxes,
   * and a weapon that does not set `upperTorsoMult` behaves exactly as it did in M2.
   */
  readonly upper?: boolean;
}

export interface RigLayout {
  readonly id: string;
  readonly boxes: readonly HitboxDef[];
  readonly height: number;
  /** Bounding sphere centre height, for the cheap reject. */
  readonly boundY: number;
  readonly boundRadius: number;
}

export interface RigHit {
  t: number;
  zone: HitZone;
  boxIndex: number;
  /** True when the box hit is flagged `upper` — the chest, not the abdomen. */
  upper: boolean;
  /** World-space surface normal at the hit. */
  nx: number;
  ny: number;
  nz: number;
}

export function makeRigHit(): RigHit {
  return { t: 0, zone: 'torso', boxIndex: -1, upper: false, nx: 0, ny: 0, nz: 0 };
}

/**
 * A 1.8 m humanoid, proportioned so the zones read the way a player expects: a head
 * you have to aim for, a torso that is the honest target, and limbs on the silhouette
 * edges where a sloppy spray lands.
 */
export const HUMANOID_RIG: RigLayout = buildLayout('humanoid', [
  { name: 'head', zone: 'head', ox: 0, oy: 1.645, oz: 0, sx: 0.22, sy: 0.25, sz: 0.23 },
  { name: 'neck', zone: 'head', ox: 0, oy: 1.5, oz: 0, sx: 0.13, sy: 0.1, sz: 0.13 },
  { name: 'chest', zone: 'torso', ox: 0, oy: 1.26, oz: 0, sx: 0.46, sy: 0.4, sz: 0.27, upper: true },
  { name: 'abdomen', zone: 'torso', ox: 0, oy: 0.94, oz: 0, sx: 0.4, sy: 0.28, sz: 0.24 },
  { name: 'armL', zone: 'arm', ox: -0.31, oy: 1.16, oz: 0, sx: 0.14, sy: 0.62, sz: 0.16 },
  { name: 'armR', zone: 'arm', ox: 0.31, oy: 1.16, oz: 0, sx: 0.14, sy: 0.62, sz: 0.16 },
  { name: 'legL', zone: 'leg', ox: -0.11, oy: 0.42, oz: 0, sx: 0.18, sy: 0.84, sz: 0.2 },
  { name: 'legR', zone: 'leg', ox: 0.11, oy: 0.42, oz: 0, sx: 0.18, sy: 0.84, sz: 0.2 },
]);

export function buildLayout(id: string, boxes: readonly HitboxDef[]): RigLayout {
  let top = 0;
  for (const b of boxes) top = Math.max(top, b.oy + b.sy * 0.5);
  const boundY = top * 0.5;
  let radius = 0;
  for (const b of boxes) {
    const dy = b.oy - boundY;
    const corner = Math.hypot(b.sx, b.sy, b.sz) * 0.5;
    radius = Math.max(radius, Math.hypot(b.ox, dy, b.oz) + corner);
  }
  return { id, boxes, height: top, boundY, boundRadius: radius };
}

const EPS = 1e-6;

/**
 * A rig instance: a layout plus a yaw-oriented transform.
 *
 * Only yaw is supported, deliberately. A bot that pitches or rolls its hitboxes is a
 * bot whose hitboxes have stopped matching what the player sees, and every shooter that
 * has tried it has regretted it.
 */
export class HitboxRig {
  readonly layout: RigLayout;

  x = 0;
  y = 0;
  z = 0;
  yaw = 0;

  /**
   * Vertical scale, 1 = standing.
   *
   * Added in M3. Without it a crouching character's hitboxes stay at standing height,
   * and a bot with a clear line over a 1 m barrier hits the chest of someone who is
   * plainly ducked behind it — cover that does not cover. Boxes scale in offset and in
   * height, so zones, widths and every multiplier verified in M2 are untouched; only how
   * far off the ground each box sits changes.
   */
  heightScale = 1;

  private cos = 1;
  private sin = 0;

  constructor(layout: RigLayout = HUMANOID_RIG) {
    this.layout = layout;
  }

  setTransform(x: number, y: number, z: number, yaw: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    if (yaw !== this.yaw) {
      this.yaw = yaw;
      this.cos = simCos(yaw);
      this.sin = simSin(yaw);
    }
  }

  /** World-space centre of the bounding sphere. */
  get boundCenterY(): number {
    return this.y + this.layout.boundY * this.heightScale;
  }

  /** Height of this rig's silhouette right now, metres. */
  get standingHeight(): number {
    return this.layout.height * this.heightScale;
  }

  /**
   * Ray versus this rig. `dx,dy,dz` must be normalised. Returns true and writes the
   * nearest hit inside `maxT`.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
    out: RigHit,
  ): boolean {
    // Cheap reject against the bounding sphere before touching any box.
    const cx = this.x;
    const cy = this.boundCenterY;
    const cz = this.z;
    const mx = ox - cx;
    const my = oy - cy;
    const mz = oz - cz;
    const b = mx * dx + my * dy + mz * dz;
    const r = this.layout.boundRadius;
    const c = mx * mx + my * my + mz * mz - r * r;
    // Outside the sphere and pointing away: nothing to do.
    if (c > 0 && b > 0) return false;
    if (b * b - c < 0) return false;
    const near = -b - Math.sqrt(b * b - c);
    if (near > maxT) return false;

    // World -> rig-local. Yaw only, so this is a 2x2 rotation plus a translation.
    const cs = this.cos;
    const sn = this.sin;
    const rx = ox - cx;
    const ry = oy - this.y;
    const rz = oz - cz;
    const lox = rx * cs - rz * sn;
    const loz = rx * sn + rz * cs;
    const ldx = dx * cs - dz * sn;
    const ldz = dx * sn + dz * cs;

    let bestT = maxT;
    let bestIndex = -1;
    let bestAxis = 0;
    let bestSign = 0;

    const scale = this.heightScale;
    const boxes = this.layout.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box === undefined) continue;
      const t = raySlab(
        lox - box.ox,
        ry - box.oy * scale,
        loz - box.oz,
        ldx,
        dy,
        ldz,
        box.sx * 0.5,
        box.sy * 0.5 * scale,
        box.sz * 0.5,
        bestT,
      );
      if (t < 0) continue;
      bestT = t;
      bestIndex = i;
      bestAxis = slabAxis;
      bestSign = slabSign;
    }

    if (bestIndex < 0) return false;
    const hitBox = boxes[bestIndex];
    if (hitBox === undefined) return false;

    out.t = bestT;
    out.zone = hitBox.zone;
    out.boxIndex = bestIndex;
    out.upper = hitBox.upper === true;

    // Local -> world for the normal (inverse yaw rotation).
    const nlx = bestAxis === 0 ? bestSign : 0;
    const nly = bestAxis === 1 ? bestSign : 0;
    const nlz = bestAxis === 2 ? bestSign : 0;
    out.nx = nlx * cs + nlz * sn;
    out.ny = nly;
    out.nz = -nlx * sn + nlz * cs;
    return true;
  }

  /**
   * Write this rig's boxes into world space, 8 corners each, for the debug
   * visualiser. `out` receives 24 floats per box.
   */
  writeWorldCorners(out: Float32Array): number {
    const boxes = this.layout.boxes;
    const cs = this.cos;
    const sn = this.sin;
    const scale = this.heightScale;
    let w = 0;
    for (const box of boxes) {
      const hx = box.sx * 0.5;
      const hy = box.sy * 0.5 * scale;
      const hz = box.sz * 0.5;
      for (let corner = 0; corner < 8; corner++) {
        const lx = box.ox + ((corner & 1) === 0 ? -hx : hx);
        const ly = box.oy * scale + ((corner & 2) === 0 ? -hy : hy);
        const lz = box.oz + ((corner & 4) === 0 ? -hz : hz);
        if (w + 3 > out.length) return w;
        out[w++] = this.x + lx * cs + lz * sn;
        out[w++] = this.y + ly;
        out[w++] = this.z - lx * sn + lz * cs;
      }
    }
    return w;
  }
}

/**
 * Slab test against an axis-aligned box centred on the origin.
 *
 * Returns the entry distance, or -1 for a miss / a hit past `maxT`. The hit axis and
 * face sign land in the two module-level scratch values below rather than in an out
 * parameter: this runs once per box per shot and must not allocate.
 */
let slabAxis = 0;
let slabSign = 0;

function raySlab(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  hx: number,
  hy: number,
  hz: number,
  maxT: number,
): number {
  let tmin = 0;
  let tmax = maxT;
  let axis = 0;
  let sign = 0;

  if (Math.abs(dx) < EPS) {
    if (ox < -hx || ox > hx) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (-hx - ox) * inv;
    let t2 = (hx - ox) * inv;
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
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  if (Math.abs(dy) < EPS) {
    if (oy < -hy || oy > hy) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (-hy - oy) * inv;
    let t2 = (hy - oy) * inv;
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
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  if (Math.abs(dz) < EPS) {
    if (oz < -hz || oz > hz) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (-hz - oz) * inv;
    let t2 = (hz - oz) * inv;
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
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  slabAxis = axis;
  // The ray started inside the box; report a face pointing back at the shooter.
  slabSign = sign === 0 ? 1 : sign;
  return tmin;
}
