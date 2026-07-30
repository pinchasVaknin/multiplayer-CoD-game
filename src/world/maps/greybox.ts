import type { Brush, CoverPoint, MapDef, PropDef, PropShapeId, SpawnZone } from './types';

/**
 * MP_TESTBED - the M1 grey-box room (brief S5.6).
 *
 * Authored in the v1 map format, not hand-placed in scene code. Every feature here
 * exists to exercise one part of the movement system:
 *
 *   long straight (z = -14)   speed measurement; markers every 5 m over 40 m
 *   0.3 m step                silent step-up, no vault
 *   0.7 m crates              low mantle / auto-vault
 *   1.5 m ledge               full mantle at the top of the detection range
 *   ramp (18 deg)             slope walking and ground snap
 *   narrow corridor (1.1 m)   capsule radius and wall sliding
 *   low overhang (1.25 m)     stand-up blocking
 *   pit (3 m) + 27 deg ramp   falling, landing dip, slope climbing
 *   east alcove               mantling into a low ceiling: must end crouched
 *   angled barricades         oriented-box collision (rotationY)
 *
 * M3 added the two AI fields the schema has always carried: `coverPoints`, derived from
 * the prop placements rather than hand-listed, and ten more `spawns` so the S6.9 spawn
 * safety rule has enough candidates to satisfy in a room this size.
 *
 * M2 added a firing line at the west end of the measurement lane and a penetration bay at
 * the east end: 0.05 m of steel a round gets through, and 0.6 m of concrete it does not,
 * with a target standing behind each. The dummies themselves are placed by
 * `combat/TargetRange.ts`, fanned out laterally so they do not shadow one another.
 *
 * Convention: +X east, +Z south, Y up. Floor top is y = 0. Brushes that sit on the
 * floor are sunk slightly so no downward face is ever coplanar with the floor.
 */

const FLOOR_TOP = 0;
const WALL_HEIGHT = 6;

// Ramp geometry is derived rather than eyeballed so the ends land exactly on the
// surfaces they connect; a 2 cm lip at the bottom of a ramp is a movement bug.
const MAIN_RAMP_RISE = 1.5;
const MAIN_RAMP_RUN = 4.5;
const MAIN_RAMP_ANGLE = Math.atan2(MAIN_RAMP_RISE, MAIN_RAMP_RUN);
const MAIN_RAMP_LEN = Math.hypot(MAIN_RAMP_RISE, MAIN_RAMP_RUN);
const MAIN_RAMP_THICK = 0.5;

const PIT_DEPTH = 3;
const PIT_RAMP_RUN = 6;
const PIT_RAMP_ANGLE = Math.atan2(PIT_DEPTH, PIT_RAMP_RUN);
const PIT_RAMP_LEN = Math.hypot(PIT_DEPTH, PIT_RAMP_RUN);
const PIT_RAMP_THICK = 0.6;

function brushes(): Brush[] {
  const out: Brush[] = [];

  const add = (
    material: Brush['material'],
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    extra?: Partial<Brush>,
  ): void => {
    out.push({
      position: { x: cx, y: cy, z: cz },
      size: { x: sx, y: sy, z: sz },
      rotationY: 0,
      material,
      ...extra,
    });
  };

  // ---- floor, split around the pit hole at x[6,12] z[2,8] ----------------
  add('floor', 0, -0.5, -8, 48, 1, 20);
  add('floor', -9, -0.5, 5, 30, 1, 6);
  add('floor', 18, -0.5, 5, 12, 1, 6);
  add('floor', 0, -0.5, 13, 48, 1, 10);

  // ---- perimeter walls, interior faces at x = +/-24, z = +/-18 ----------
  add('concrete', 0, WALL_HEIGHT / 2 - 0.1, -18.5, 49, WALL_HEIGHT + 0.2, 1);
  add('concrete', 0, WALL_HEIGHT / 2 - 0.1, 18.5, 49, WALL_HEIGHT + 0.2, 1);
  add('concrete', -24.5, WALL_HEIGHT / 2 - 0.1, 0, 1, WALL_HEIGHT + 0.2, 38);
  add('concrete', 24.5, WALL_HEIGHT / 2 - 0.1, 0, 1, WALL_HEIGHT + 0.2, 38);

  // ---- long straight: distance markers, 5 m apart, 40 m end to end -------
  // Non-solid: they must not perturb a speed measurement.
  for (let i = 0; i <= 8; i++) {
    const x = -20 + i * 5;
    const major = i % 2 === 0;
    add('hazard', x, 0.03, -14, major ? 0.3 : 0.18, 0.04, major ? 6 : 3.2, { solid: false, shadows: false });
  }

  // ---- 0.3 m step -------------------------------------------------------
  add('concrete', 0, 0.1, -3, 8, 0.4, 6);
  // Its lip, in the accent material, so the height reads at a glance.
  add('accent', 0, 0.28, -6.02, 8, 0.05, 0.06, { solid: false, shadows: false });

  // ---- 1.5 m ledge + the ramp that climbs it ----------------------------
  add('concreteDark', -9.75, 0.65, 6, 7.5, 1.7, 6);
  {
    // Top surface runs from (x=-18, y=0) to (x=-13.5, y=1.5).
    const midX = -18 + MAIN_RAMP_RUN / 2;
    const midY = MAIN_RAMP_RISE / 2;
    const nx = -Math.sin(MAIN_RAMP_ANGLE);
    const ny = Math.cos(MAIN_RAMP_ANGLE);
    out.push({
      position: {
        x: midX - nx * (MAIN_RAMP_THICK / 2),
        y: midY - ny * (MAIN_RAMP_THICK / 2),
        z: 6,
      },
      size: { x: MAIN_RAMP_LEN, y: MAIN_RAMP_THICK, z: 3.5 },
      rotationY: 0,
      rotationZ: MAIN_RAMP_ANGLE,
      material: 'metal',
    });
  }
  // Ledge lip in the accent colour, and a guard rail on the far side.
  add('accent', -9.75, 1.48, 3.02, 7.5, 0.06, 0.06, { solid: false, shadows: false });
  add('metal', -9.75, 1.95, 8.85, 7.5, 0.9, 0.3);

  // ---- narrow corridor, 1.1 m clear, with a low overhang ----------------
  add('concreteDark', -21.0, 1.4, 4, 1.0, 3, 12);
  add('concreteDark', -18.9, 1.4, 4, 1.0, 3, 12);
  // Underside at 1.25 m: crouch (1.10) fits, stand (1.80) does not.
  add('metal', -19.95, 1.65, 4, 2.1, 0.8, 4);
  add('hazard', -19.95, 1.27, 2.0, 2.1, 0.05, 0.12, { solid: false, shadows: false });
  add('hazard', -19.95, 1.27, 6.0, 2.1, 0.05, 0.12, { solid: false, shadows: false });

  // ---- pit: 6 x 6 hole, 3 m deep, with a 27 deg ramp out ----------------
  add('concreteDark', 9, -PIT_DEPTH - 0.5, 5, 6, 1, 6); // pit floor, top at -3
  add('concreteDark', 5.75, -2, 5, 0.5, 2, 7); // lining, y -3..-1
  add('concreteDark', 12.25, -2, 5, 0.5, 2, 7);
  add('concreteDark', 9, -2, 1.75, 6, 2, 0.5);
  add('concreteDark', 9, -2, 8.25, 6, 2, 0.5);
  {
    // Top surface runs from (z=8, y=-3) up to (z=2, y=0).
    const midZ = 5;
    const midY = -PIT_DEPTH / 2;
    const ny = Math.cos(PIT_RAMP_ANGLE);
    const nz = Math.sin(PIT_RAMP_ANGLE);
    out.push({
      position: {
        x: 10.3,
        y: midY - ny * (PIT_RAMP_THICK / 2),
        z: midZ - nz * (PIT_RAMP_THICK / 2),
      },
      size: { x: 3.0, y: PIT_RAMP_THICK, z: PIT_RAMP_LEN },
      rotationY: 0,
      rotationX: PIT_RAMP_ANGLE,
      material: 'metal',
    });
  }
  // Hazard trim around the lip so the pit reads as a hazard, not a texture seam.
  add('hazard', 9, 0.03, 1.9, 6.4, 0.04, 0.25, { solid: false, shadows: false });
  add('hazard', 9, 0.03, 8.1, 6.4, 0.04, 0.25, { solid: false, shadows: false });
  add('hazard', 6.1, 0.03, 5, 0.25, 0.04, 6.4, { solid: false, shadows: false });
  add('hazard', 11.9, 0.03, 5, 0.25, 0.04, 6.4, { solid: false, shadows: false });

  // ---- east alcove: 1.2 m shelf under a 2.45 m roof ---------------------
  // Mantling up leaves 1.25 m of headroom, so the vault must finish crouched.
  add('concreteDark', 21.5, 0.5, 8, 5, 1.4, 7);
  add('metal', 21.5, 2.75, 8, 5, 0.6, 7);
  add('accent', 19.02, 1.18, 8, 0.06, 0.05, 7, { solid: false, shadows: false });

  // ---- M2 penetration bay (S6.4 / acceptance 4) -------------------------
  // Two panels at the far end of the measurement lane, sized so one weapon answers both
  // halves of the criterion: 0.05 m of steel costs 0.095 of the AR's 0.28 penetration
  // budget and lets it through with a reported loss; 0.6 m of concrete costs 0.6 and
  // stops it outright. A dummy stands behind each.
  add('metal', 17.5, 1.3, -13.9, 0.05, 2.6, 2.6);
  add('concrete', 17.5, 1.3, -11.0, 0.6, 2.6, 2.6);
  // Frames, so the two panels read as different at a glance from the firing line.
  add('hazard', 17.5, 2.68, -13.9, 0.16, 0.12, 2.72, { solid: false, shadows: false });
  add('accent', 17.5, 2.68, -11.0, 0.72, 0.12, 2.72, { solid: false, shadows: false });

  // Firing line: a thin accent bar sitting above the 20 m distance marker, not
  // coplanar with it, because two quads on the same plane is a z-fighting bug.
  add('accent', -20, 0.055, -14, 0.1, 0.04, 7, { solid: false, shadows: false });

  // ---- angled barricades: oriented-box collision ------------------------
  out.push({
    position: { x: -4, y: 0.55, z: 12 },
    size: { x: 5, y: 1.5, z: 0.4 },
    rotationY: Math.PI / 6,
    material: 'concreteDark',
  });
  out.push({
    position: { x: 4, y: 0.55, z: 15 },
    size: { x: 6, y: 1.5, z: 0.4 },
    rotationY: -Math.PI / 5,
    material: 'concreteDark',
  });

  return out;
}

function props(): PropDef[] {
  const out: PropDef[] = [];
  const put = (shape: PropDef['shape'], x: number, z: number, rotationY = 0): void => {
    out.push({ shape, position: { x, y: FLOOR_TOP, z }, rotationY });
  };

  // 0.7 m crates: the low mantle / auto-vault test bed.
  put('crate', 2, 10.5);
  put('crate', 3.3, 11.7, 0.4);
  put('crate', -6.5, 12.5, -0.25);
  put('crate', 15.5, -4, 0.6);
  put('crate', 16.9, -4.9, 0.15);

  // 1.5 m crates: full mantle.
  put('crateTall', 0, 14.5, 0.2);
  put('crateTall', 17.5, 13, -0.3);
  put('crateTall', -13, -6, 0.5);

  // 1.0 m barriers: vault height, and cover for M3's bots.
  put('barrier', 8, -8, 0);
  put('barrier', 11, -8.6, 0.35);
  put('barrier', -3, -9.5, Math.PI / 2);
  put('barrier', 20, 0, Math.PI / 2);

  // Pillars: tall oriented obstacles, and something for shadows to fall across.
  put('pillar', -12, -8);
  put('pillar', 0, -8);
  put('pillar', 12, -8);
  put('pillar', -4, 4, Math.PI / 4);
  put('pillar', 16, 16);
  put('pillar', -16, 16, Math.PI / 4);

  return out;
}

/**
 * Cover profiles, keyed by prop shape (brief S6.5).
 *
 * `coverPoints` has been in the map schema since M1 and unused until now. Rather than
 * hand-listing sixty positions that would silently rot the first time a crate moved,
 * cover is *derived* from the placements above: each shape declares how deep it is and
 * which of its local faces are worth standing behind, and the generator emits a standing
 * spot on each of those faces facing back through the object.
 *
 * `offsets` are the local face directions. A 1 m cube is cover from every side; a
 * barrier is 2 m wide and 0.4 m deep, so only its broad faces are.
 *
 * Whether a generated point is actually standable is not decided here — the navmesh
 * bake answers that, and `ai/Cover.ts` discards any point the grid says is unreachable.
 */
interface CoverProfile {
  /** Half-depth along each offered face direction, metres. */
  readonly halfDepth: number;
  readonly height: CoverPoint['height'];
  /** Local face normals to place cover behind. */
  readonly faces: readonly Readonly<{ x: number; z: number }>[];
}

const FOUR_SIDES = [
  { x: 0, z: -1 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 1, z: 0 },
] as const;

const BROAD_FACES = [
  { x: 0, z: -1 },
  { x: 0, z: 1 },
] as const;

const COVER_PROFILES: Partial<Record<PropShapeId, CoverProfile>> = {
  crate: { halfDepth: 0.5, height: 'low', faces: FOUR_SIDES },
  crateTall: { halfDepth: 0.55, height: 'high', faces: FOUR_SIDES },
  pillar: { halfDepth: 0.35, height: 'high', faces: FOUR_SIDES },
  barrier: { halfDepth: 0.2, height: 'low', faces: BROAD_FACES },
};

/** How far clear of the object's face a bot stands. Capsule radius plus breathing room. */
const COVER_STANDOFF = 0.62;

function coverPoints(placements: readonly PropDef[]): CoverPoint[] {
  const out: CoverPoint[] = [];

  const emit = (
    cx: number,
    cz: number,
    yaw: number,
    faceX: number,
    faceZ: number,
    depth: number,
    height: CoverPoint['height'],
  ): void => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // Local face normal into world space, same yaw convention the prop mesher uses.
    const wx = faceX * c + faceZ * s;
    const wz = -faceX * s + faceZ * c;
    const reach = depth + COVER_STANDOFF;
    out.push({
      position: { x: cx + wx * reach, y: 0, z: cz + wz * reach },
      // The cover protects from the far side of the object, which is back through it.
      facingYaw: Math.atan2(-wx, -wz),
      height,
    });
  };

  for (const p of placements) {
    const profile = COVER_PROFILES[p.shape];
    if (profile === undefined) continue;
    for (const face of profile.faces) {
      emit(p.position.x, p.position.z, p.rotationY, face.x, face.z, profile.halfDepth, profile.height);
    }
  }

  // The two angled barricades and the penetration-bay panels are brushes rather than
  // props, so they are listed by hand — but they are the only four that are.
  emit(-4, 12, Math.PI / 6, 0, -1, 0.2, 'high');
  emit(-4, 12, Math.PI / 6, 0, 1, 0.2, 'high');
  emit(4, 15, -Math.PI / 5, 0, -1, 0.2, 'high');
  emit(4, 15, -Math.PI / 5, 0, 1, 0.2, 'high');
  emit(17.5, -13.9, Math.PI / 2, 0, -1, 0.03, 'high');
  emit(17.5, -13.9, Math.PI / 2, 0, 1, 0.03, 'high');
  emit(17.5, -11.0, Math.PI / 2, 0, -1, 0.3, 'high');
  emit(17.5, -11.0, Math.PI / 2, 0, 1, 0.3, 'high');

  return out;
}

/**
 * Spawn zones.
 *
 * The first three are M1's and must stay first: `spawns[0]` is the firing line the M2
 * range is laid out against. The rest are M3's, because ten bots respawning under the
 * S6.9 rule ("never within 15 m of a living enemy, never inside their view cone") need
 * somewhere to go — three zones in a 48 x 36 room cannot satisfy it. Every position
 * below is open floor: no zone sits inside the corridor blocks, the alcove shelf, the
 * pit, or a prop footprint.
 */
function spawns(): SpawnZone[] {
  return [
    { team: 'A', position: { x: -20, y: 0.05, z: -14 }, facingYaw: -Math.PI / 2, radius: 1.5 },
    { team: 'B', position: { x: 20, y: 0.05, z: -14 }, facingYaw: Math.PI / 2, radius: 1.5 },
    { team: 'FFA', position: { x: -20, y: 0.05, z: 14 }, facingYaw: -Math.PI / 2, radius: 2 },

    { team: 'A', position: { x: -22, y: 0.05, z: -10 }, facingYaw: -Math.PI / 2, radius: 2 },
    { team: 'A', position: { x: -22.5, y: 0.05, z: 12 }, facingYaw: -Math.PI / 2, radius: 2 },
    { team: 'A', position: { x: -14, y: 0.05, z: 16 }, facingYaw: Math.PI, radius: 2.2 },
    { team: 'A', position: { x: -8, y: 0.05, z: -16 }, facingYaw: 0, radius: 2.2 },
    { team: 'A', position: { x: -10.5, y: 0.05, z: 1.5 }, facingYaw: -Math.PI / 2, radius: 2 },

    { team: 'B', position: { x: 22, y: 0.05, z: -3 }, facingYaw: Math.PI / 2, radius: 2 },
    { team: 'B', position: { x: 21, y: 0.05, z: 14 }, facingYaw: Math.PI / 2, radius: 2 },
    { team: 'B', position: { x: 14, y: 0.05, z: 16 }, facingYaw: Math.PI, radius: 2.2 },
    { team: 'B', position: { x: 8, y: 0.05, z: -16 }, facingYaw: 0, radius: 2.2 },
    { team: 'B', position: { x: 13, y: 0.05, z: 1.5 }, facingYaw: Math.PI / 2, radius: 2 },
  ];
}

/** Wall-mounted accent strips. Non-solid; they exist so the palette has an anchor. */
function lightStrips(): PropDef[] {
  const out: PropDef[] = [];
  for (const x of [-16, -8, 0, 8, 16]) {
    out.push({ shape: 'lightBox', position: { x, y: 4.2, z: -17.9 }, rotationY: 0 });
    out.push({ shape: 'lightBox', position: { x, y: 4.2, z: 17.9 }, rotationY: Math.PI });
  }
  for (const z of [-10, 0, 10]) {
    out.push({ shape: 'lightBox', position: { x: -23.9, y: 4.2, z }, rotationY: Math.PI / 2 });
    out.push({ shape: 'lightBox', position: { x: 23.9, y: 4.2, z }, rotationY: -Math.PI / 2 });
  }
  return out;
}

const COVER_PROPS = props();

export const GREYBOX_MAP: MapDef = {
  id: 'mp_testbed',
  name: 'TESTBED',
  brushes: brushes(),
  props: [...COVER_PROPS, ...lightStrips()],
  spawns: spawns(),
  lights: [
    { kind: 'hemisphere', skyColor: 0x8fa6c4, groundColor: 0x24272d, intensity: 0.85 },
    {
      kind: 'directional',
      color: 0xffe9cf,
      intensity: 2.1,
      direction: { x: 0.42, y: -0.8, z: 0.43 },
      castShadow: true,
      shadowExtent: 34,
    },
  ],
  ambient: {
    skyColor: 0x8fa6c4,
    groundColor: 0x24272d,
    fogColor: 0x1b2028,
    fogNear: 34,
    fogFar: 96,
  },

  coverPoints: coverPoints(COVER_PROPS),
  objectives: [],
  navBounds: {
    min: { x: -26, y: -6, z: -20 },
    max: { x: 26, y: 10, z: 20 },
  },
};

/** Endpoints of the measurement lane, used by the debug harness. */
export const SPEED_LANE = {
  z: -14,
  startX: -20,
  endX: 20,
  get length(): number {
    return this.endX - this.startX;
  },
} as const;
