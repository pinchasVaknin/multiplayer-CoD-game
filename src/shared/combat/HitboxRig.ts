import { simCos, simSin } from '../core/SimMath';
import { isLowStance, LOCOMOTION_IDLE_SPEED, LOCOMOTION_RUN_SPEED, type StanceId } from '../player/Stance';
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
 * Layouts are shared (every humanoid points at the same few `RigLayout`s); only the
 * transform and the choice of layout are per-entity. Nothing here allocates: hits are
 * written into a caller-owned record.
 *
 * ## One layout per drawn pose (M13 C2)
 *
 * M3 compressed the standing layout uniformly by the capsule height — 0.61 crouched, 0.31
 * sliding. The skinned bodies that arrived with M12 ignore that number and play a clip, and
 * C1 measured where the clip actually puts the head: the crouch idle is a **kneel** with the
 * crown at 1.11 m (the squashed rig said 1.08 — fine), the crouch walk holds it at 1.26 m
 * (+0.18 m over the rig) and the crouch run, which is what a slide draws while it is fast,
 * at 1.38 m against a slide rig 0.54 m tall. A round aimed at a sliding body's head passed
 * over everything it could hit.
 *
 * So the low stances now have layouts of their own, built from the measured joints of the
 * clip they are drawn with (`scripts/measure-crouch.mjs --pose`), and `rigLayoutFor` picks
 * one by the same rule the animation selector uses to pick the clip. The standing layout is
 * untouched: every hit-rate number in the plan was taken against it.
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
  /**
   * Where a bot aims at this body: the centre of the chest box, so aiming and hitting agree.
   * 1.26 m standing, and lower in every low layout.
   */
  readonly aimY: number;
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

/**
 * A joint of the drawn body in the actor's frame: x to the right, y up, z with the body
 * facing **−z**, so a negative z is in front of the feet. The numbers below are the mean
 * over the clip for Echo, from `scripts/measure-crouch.mjs --pose`; the other skins agree
 * within a few centimetres (Apex is 6 cm taller everywhere, from its own `modelScale`).
 */
type Joint = readonly [x: number, y: number, z: number];

/** Half-extents added to a segment's bounding box on each axis: the limb's radius. */
type Pad = readonly [x: number, y: number, z: number];

/**
 * The radius of each body part, chosen so that a segment box around the *standing* joints
 * reproduces the standing box it replaces: head `Head→HeadTop_End` is 0.23 m tall and 0.09 m
 * deep in bind, and padded by (0.11, 0.01, 0.07) it is the 0.22 × 0.25 × 0.23 head box above;
 * chest `Spine1→Neck` is 0.30 m, padded to the 0.40 m chest box; abdomen `Hips→Spine1` is
 * 0.23 m, padded to the 0.28 m abdomen box. The limbs split into two segments each (the
 * standing layout uses one box per limb), padded to the standing limb's width and depth.
 */
const PAD = {
  head: [0.11, 0.01, 0.07] as Pad,
  neck: [0.065, 0.02, 0.055] as Pad,
  chest: [0.23, 0.05, 0.12] as Pad,
  abdomen: [0.2, 0.025, 0.12] as Pad,
  arm: [0.07, 0.04, 0.08] as Pad,
  leg: [0.09, 0.05, 0.1] as Pad,
} as const;

/**
 * An axis-aligned box around the segment `a → b`, padded by the part's radius.
 *
 * Yaw is the only rotation the rig supports (see `HitboxRig`), so a pitched torso or a
 * folded leg becomes the bounding box of its segment rather than a tilted slab. That
 * over-covers the corners of a diagonal segment, which is the price the rig's own comment
 * accepts; splitting each limb in two keeps the price small.
 */
function segmentBox(
  name: string,
  zone: HitZone,
  a: Joint,
  b: Joint,
  pad: Pad,
  upper?: boolean,
): HitboxDef {
  const box: HitboxDef = {
    name,
    zone,
    ox: round((a[0] + b[0]) * 0.5),
    oy: round((a[1] + b[1]) * 0.5),
    oz: round((a[2] + b[2]) * 0.5),
    sx: round(Math.abs(a[0] - b[0]) + pad[0] * 2),
    sy: round(Math.abs(a[1] - b[1]) + pad[1] * 2),
    sz: round(Math.abs(a[2] - b[2]) + pad[2] * 2),
  };
  return upper === true ? { ...box, upper: true } : box;
}

/** Three decimals: the joints are measured to centimetres, and a hash must not depend on a rounding mode. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The joints one low layout is built from. Left and right are the body's own. */
interface PoseJoints {
  readonly headTop: Joint;
  readonly head: Joint;
  readonly neck: Joint;
  readonly spine1: Joint;
  readonly hips: Joint;
  readonly leftArm: Joint;
  readonly leftForeArm: Joint;
  readonly leftHand: Joint;
  readonly rightArm: Joint;
  readonly rightForeArm: Joint;
  readonly rightHand: Joint;
  readonly leftUpLeg: Joint;
  readonly leftLeg: Joint;
  readonly leftFoot: Joint;
  readonly rightUpLeg: Joint;
  readonly rightLeg: Joint;
  readonly rightFoot: Joint;
}

function poseLayout(id: string, j: PoseJoints): RigLayout {
  return buildLayout(id, [
    segmentBox('head', 'head', j.head, j.headTop, PAD.head),
    segmentBox('neck', 'head', j.neck, j.head, PAD.neck),
    segmentBox('chest', 'torso', j.spine1, j.neck, PAD.chest, true),
    segmentBox('abdomen', 'torso', j.hips, j.spine1, PAD.abdomen),
    segmentBox('upperArmL', 'arm', j.leftArm, j.leftForeArm, PAD.arm),
    segmentBox('foreArmL', 'arm', j.leftForeArm, j.leftHand, PAD.arm),
    segmentBox('upperArmR', 'arm', j.rightArm, j.rightForeArm, PAD.arm),
    segmentBox('foreArmR', 'arm', j.rightForeArm, j.rightHand, PAD.arm),
    segmentBox('thighL', 'leg', j.leftUpLeg, j.leftLeg, PAD.leg),
    segmentBox('shinL', 'leg', j.leftLeg, j.leftFoot, PAD.leg),
    segmentBox('thighR', 'leg', j.rightUpLeg, j.rightLeg, PAD.leg),
    segmentBox('shinR', 'leg', j.rightLeg, j.rightFoot, PAD.leg),
  ]);
}

/**
 * `Crouch_Idle_Aiming`: a kneel. Right knee on the floor, left foot forward, torso upright
 * over hips at 0.41 m, head leaning 0.2 m forward with the crown at 1.11 m.
 */
export const HUMANOID_CROUCH_RIG: RigLayout = poseLayout('humanoid-crouch', {
  headTop: [0.15, 1.11, -0.27],
  head: [0.06, 0.93, -0.12],
  neck: [0.03, 0.9, -0.07],
  spine1: [-0.03, 0.63, 0.03],
  hips: [0, 0.41, -0.01],
  leftArm: [-0.16, 0.86, -0.12],
  leftForeArm: [-0.13, 0.66, -0.27],
  leftHand: [0.05, 0.75, -0.42],
  rightArm: [0.18, 0.85, 0.05],
  rightForeArm: [0.31, 0.64, 0.07],
  rightHand: [0.21, 0.72, -0.14],
  leftUpLeg: [-0.1, 0.36, -0.1],
  leftLeg: [-0.08, 0.42, -0.49],
  leftFoot: [-0.14, 0.11, -0.32],
  rightUpLeg: [0.1, 0.34, 0.07],
  rightLeg: [0.29, -0.01, 0.08],
  rightFoot: [0.16, 0.18, 0.36],
});

/**
 * `Crouch_Walk_Aiming`: hips at 0.65 m, torso pitched forward, crown at 1.26 m and half a
 * metre in front of the feet. Also what a slide draws once it has slowed below the run
 * threshold.
 */
export const HUMANOID_CROUCH_WALK_RIG: RigLayout = poseLayout('humanoid-crouch-walk', {
  headTop: [0.2, 1.26, -0.47],
  head: [0.13, 1.09, -0.3],
  neck: [0.1, 1.07, -0.25],
  spine1: [0.01, 0.87, -0.05],
  hips: [0, 0.65, -0.01],
  leftArm: [-0.09, 1.03, -0.3],
  leftForeArm: [-0.08, 0.83, -0.43],
  leftHand: [0.09, 0.86, -0.59],
  rightArm: [0.25, 1.04, -0.11],
  rightForeArm: [0.32, 0.81, -0.08],
  rightHand: [0.26, 0.84, -0.31],
  leftUpLeg: [-0.12, 0.59, -0.05],
  leftLeg: [-0.07, 0.37, -0.32],
  leftFoot: [-0.09, 0.16, -0.14],
  rightUpLeg: [0.11, 0.59, 0.06],
  rightLeg: [0.19, 0.36, -0.2],
  rightFoot: [0.14, 0.15, -0.02],
});

/**
 * `Crouch_Run_Aiming`: a hunched run — hips at 0.82 m, nearly standing, the crown at 1.38 m
 * and 0.56 m in front of the feet. A crouching player never reaches the run speed; this is
 * the pose a **slide** is drawn with while it is fast, and the one the 0.54 m slide rig was
 * furthest from.
 */
export const HUMANOID_CROUCH_RUN_RIG: RigLayout = poseLayout('humanoid-crouch-run', {
  headTop: [0.12, 1.38, -0.56],
  head: [0.08, 1.22, -0.38],
  neck: [0.07, 1.2, -0.32],
  spine1: [0.03, 1.02, -0.08],
  hips: [0, 0.82, -0.01],
  leftArm: [-0.08, 1.14, -0.39],
  leftForeArm: [-0.05, 1.03, -0.6],
  leftHand: [0.08, 1.05, -0.81],
  rightArm: [0.26, 1.17, -0.25],
  rightForeArm: [0.34, 0.95, -0.3],
  rightHand: [0.21, 1.0, -0.5],
  leftUpLeg: [-0.13, 0.76, -0.03],
  leftLeg: [-0.11, 0.44, -0.23],
  leftFoot: [-0.09, 0.19, -0.01],
  rightUpLeg: [0.12, 0.76, 0.05],
  rightLeg: [0.14, 0.42, -0.09],
  rightFoot: [0.12, 0.17, 0.12],
});

/** Every layout a humanoid can wear, for anything that needs to enumerate them (debug, audits). */
export const HUMANOID_LAYOUTS: readonly RigLayout[] = [
  HUMANOID_RIG,
  HUMANOID_CROUCH_RIG,
  HUMANOID_CROUCH_WALK_RIG,
  HUMANOID_CROUCH_RUN_RIG,
];

/**
 * The layout a body wears in `stance` moving at `(vx, vz)`, chosen by the rule the animation
 * selector uses to choose the clip: standing stances wear the standing layout; a low stance
 * wears the kneel, the crouch walk above the idle dead zone, and the crouch run above the run
 * threshold — which only a slide reaches.
 *
 * Squared speeds, on purpose: `Math.hypot` is not something two runtimes have to agree on and
 * a threshold comparison does not need it.
 */
export function rigLayoutFor(stance: StanceId, vx: number, vz: number): RigLayout {
  if (!isLowStance(stance)) return HUMANOID_RIG;
  const speedSq = vx * vx + vz * vz;
  if (speedSq >= LOCOMOTION_RUN_SPEED * LOCOMOTION_RUN_SPEED) return HUMANOID_CROUCH_RUN_RIG;
  if (speedSq > LOCOMOTION_IDLE_SPEED * LOCOMOTION_IDLE_SPEED) return HUMANOID_CROUCH_WALK_RIG;
  return HUMANOID_CROUCH_RIG;
}

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
  // The chest if the layout marks one, else the first torso box (the sentry has no chest),
  // else the middle of the silhouette.
  const chest = boxes.find((b) => b.upper === true) ?? boxes.find((b) => b.zone === 'torso');
  return { id, boxes, height: top, aimY: chest?.oy ?? top * 0.5, boundY, boundRadius: radius };
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
  /**
   * The boxes this body wears right now. Set from the stance and speed on the tick the shot
   * resolves (`rigLayoutFor`), and rewound with the transform by lag compensation.
   *
   * M3 had a `heightScale` here instead — a uniform squash of the standing layout by the
   * capsule height, so that cover would cover a crouching body. It covered the crouch idle
   * and nothing else (C1's table); a layout per drawn pose replaced it in M13 C2.
   */
  layout: RigLayout;

  x = 0;
  y = 0;
  z = 0;
  yaw = 0;

  private cos = 1;
  private sin = 0;

  constructor(layout: RigLayout = HUMANOID_RIG) {
    this.layout = layout;
  }

  setLayout(layout: RigLayout): void {
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
    return this.y + this.layout.boundY;
  }

  /** Height of this rig's silhouette right now, metres: the top of its highest box. */
  get standingHeight(): number {
    return this.layout.height;
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

    const boxes = this.layout.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box === undefined) continue;
      const t = raySlab(
        lox - box.ox,
        ry - box.oy,
        loz - box.oz,
        ldx,
        dy,
        ldz,
        box.sx * 0.5,
        box.sy * 0.5,
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
    let w = 0;
    for (const box of boxes) {
      const hx = box.sx * 0.5;
      const hy = box.sy * 0.5;
      const hz = box.sz * 0.5;
      for (let corner = 0; corner < 8; corner++) {
        const lx = box.ox + ((corner & 1) === 0 ? -hx : hx);
        const ly = box.oy + ((corner & 2) === 0 ? -hy : hy);
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
