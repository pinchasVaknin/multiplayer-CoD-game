import type { CoverPoint, PropDef, PropShapeId } from './types';

/**
 * Deriving `coverPoints` from prop placements (brief S6.5).
 *
 * M3 built this inside `greybox.ts` and PLAN.md told M4 to copy the pattern rather than
 * hand-listing positions that rot the first time a crate moves. Copying it would have been
 * two divergent copies, so it lives here instead and both maps call it — the profile table
 * is a property of the *shape*, not of the map that places it.
 *
 * Each shape declares how deep it is and which of its local faces are worth standing
 * behind, and the generator emits a standing spot on each of those faces, facing back
 * through the object. A 1 m cube is cover from every side; a barrier is 2 m wide and 0.4 m
 * deep, so only its broad faces are; a container is a wall and only its long faces are.
 *
 * Whether a generated point is actually standable is not decided here — the navmesh bake
 * answers that, and `ai/Cover.ts` discards any point the grid says is unreachable and
 * counts it in `navStats.coverRejected`. A non-zero count on a new map is a data bug worth
 * looking at.
 */

export interface CoverProfile {
  /** Half-depth along each offered face direction, metres. */
  readonly halfDepth: number;
  readonly height: CoverPoint['height'];
  /** Local face normals to place cover behind. */
  readonly faces: readonly Readonly<{ x: number; z: number }>[];
}

export const FOUR_SIDES = [
  { x: 0, z: -1 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 1, z: 0 },
] as const;

export const BROAD_FACES = [
  { x: 0, z: -1 },
  { x: 0, z: 1 },
] as const;

/**
 * Profiles for the whole prop catalogue.
 *
 * `crate`, `crateTall`, `pillar` and `barrier` are M3's numbers unchanged, so the grey-box
 * room derives exactly the cover it derived before. `lightBox` is wall trim four metres up
 * and is deliberately absent.
 */
export const COVER_PROFILES: Partial<Record<PropShapeId, CoverProfile>> = {
  crate: { halfDepth: 0.5, height: 'low', faces: FOUR_SIDES },
  crateTall: { halfDepth: 0.55, height: 'high', faces: FOUR_SIDES },
  pillar: { halfDepth: 0.35, height: 'high', faces: FOUR_SIDES },
  barrier: { halfDepth: 0.2, height: 'low', faces: BROAD_FACES },

  // M4. A container's short ends are a 2.5 m face at the end of a 6 m wall and nobody
  // fights from there, so it offers its broad sides only.
  container: { halfDepth: 1.25, height: 'high', faces: BROAD_FACES },
  machine: { halfDepth: 0.7, height: 'high', faces: FOUR_SIDES },
  /**
   * 0.75, not the 0.55 M4 shipped. **This was a real bug, found by the M8 rejection count.**
   *
   * The shape is a *pair* of drums at x = +/-0.42, each 0.62 wide, so its half-extent across
   * that axis is 0.73 m and not 0.31. At 0.55 the derived point sat 1.17 m from the centre,
   * which leaves 0.44 m of clearance against a 0.35 m capsule radius — and the navmesh, which
   * asks the collision world rather than the profile table, correctly refused it. Dunes threw
   * four such points and Foundry had been quietly throwing two since M4.
   */
  barrels: { halfDepth: 0.75, height: 'low', faces: FOUR_SIDES },
  girder: { halfDepth: 0.21, height: 'high', faces: FOUR_SIDES },
  ladle: { halfDepth: 1.3, height: 'high', faces: FOUR_SIDES },
  spool: { halfDepth: 0.65, height: 'low', faces: FOUR_SIDES },

  // M8. `palm` is deliberately absent: its trunk is 0.42 m against a 0.7 m capsule, so
  // "behind a palm" is not a place a body fits, and offering it as cover would have bots
  // standing in the open believing they were hidden. `lightMast` is absent for the same
  // reason. Concealment and cover are different things and only one of them is in here.
  containerBlue: { halfDepth: 1.25, height: 'high', faces: BROAD_FACES },
  stall: { halfDepth: 0.45, height: 'low', faces: BROAD_FACES },
  well: { halfDepth: 1.3, height: 'low', faces: FOUR_SIDES },
  sandbags: { halfDepth: 0.4, height: 'low', faces: BROAD_FACES },
  // 0.8 is the half-extent of the *long* axis (1.6 m), so all four faces clear the box.
  // Deriving four faces from one depth means the depth has to be the larger of the two.
  pallets: { halfDepth: 0.8, height: 'low', faces: FOUR_SIDES },
  forklift: { halfDepth: 1.2, height: 'high', faces: BROAD_FACES },
};

/** How far clear of the object's face a bot stands. Capsule radius plus breathing room. */
export const COVER_STANDOFF = 0.62;

/**
 * One cover point beside an object, facing back through it.
 *
 * Exported because a map's brush-built cover — an angled barricade, a catwalk railing — has
 * no prop placement to derive from and has to be emitted by hand. `y` is the height the
 * point sits at, which matters from M4: Foundry authors railing cover four metres above
 * floor cover in the same place in plan, and `ai/Cover.ts` resolves the two by height.
 */
export function emitCoverPoint(
  out: CoverPoint[],
  cx: number,
  cz: number,
  yaw: number,
  faceX: number,
  faceZ: number,
  depth: number,
  height: CoverPoint['height'],
  y = 0,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Local face normal into world space, same yaw convention the prop mesher uses.
  const wx = faceX * c + faceZ * s;
  const wz = -faceX * s + faceZ * c;
  const reach = depth + COVER_STANDOFF;
  out.push({
    position: { x: cx + wx * reach, y, z: cz + wz * reach },
    // The cover protects from the far side of the object, which is back through it.
    facingYaw: Math.atan2(-wx, -wz),
    height,
  });
}

/** Cover derived from every placement whose shape has a profile. */
export function deriveCoverPoints(placements: readonly PropDef[]): CoverPoint[] {
  const out: CoverPoint[] = [];
  for (const p of placements) {
    const profile = COVER_PROFILES[p.shape];
    if (profile === undefined) continue;
    for (const face of profile.faces) {
      emitCoverPoint(
        out,
        p.position.x,
        p.position.z,
        p.rotationY,
        face.x,
        face.z,
        profile.halfDepth,
        profile.height,
        p.position.y,
      );
    }
  }
  return out;
}
