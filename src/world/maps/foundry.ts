import {
  addProp,
  addSpan,
  rampAlongX,
  rampAlongZ,
  rotateHalf,
  rotateHalfProps,
} from './build';
import { deriveCoverPoints, emitCoverPoint } from './cover';
import type { Brush, CoverPoint, MapDef, ObjectiveDef, PropDef, SpawnZone, Vec3Lit } from './types';

/**
 * MP_FOUNDRY — the M4 map (brief S6.1).
 *
 * Industrial, classic three-lane. Two outer lanes down the long sides, a tight centre hall
 * in the middle, and a catwalk deck four metres up that crosses the hall and comes down in
 * both outer lanes — so the middle is fought over on two levels and neither one owns the
 * other.
 *
 * ## The shape
 *
 * ```
 *              z = -25  (TEAM B home)
 *   +--------------------------------------+
 *   |        north yard                    |
 *   |  W  +--------------------+   E       |   x = -29 .. +29
 *   |  E  |   FOUNDRY HALL     |   A       |   z = -25 .. +25
 *   |  S  |  22 x 22, walls 3m |   S       |
 *   |  T  |  open top, ring    |   T       |   catwalk deck top y = 4.0
 *   |     |  deck at y = 4     |           |   hall walls y = 0 .. 3
 *   |  l  +--------------------+   l       |   perimeter walls 9 m
 *   |  a       south yard      a           |
 *   +--------------------------------------+
 *              z = +25  (TEAM A home)
 * ```
 *
 * ## Fairness is applied, not asserted
 *
 * The map is **rotationally symmetric**: everything but the two Search & Destroy bomb sites
 * is authored for one half and put through `rotateHalf`, which maps `(x, z) -> (-x, -z)`.
 * A mirror would have made the two teams' lanes handed — one team's cover on their left is
 * the other team's on their right — and rotation gives both sides literally the same map.
 * The four pitched surfaces are authored per side because a pitched brush cannot be rotated
 * by adding pi to its yaw (see `build.ts`).
 *
 * That is also what makes the lane timings land: the three lanes are ~21 m from a home spawn
 * to the point in that lane where the two teams meet, and both teams walk the same 21 m.
 * `FOUNDRY_LANES` names those endpoints so the debug harness can path them and report
 * seconds rather than the author claiming a number.
 *
 * ## The catwalk
 *
 * A 3 m wide ring around the inside of the hall at y = 4.0, a bridge straight across the
 * middle of it, and two ramps down into the outer lanes — plus two internal stairs, so the
 * deck has four ways on and is contested rather than camped. **Deliberately no railings.**
 * Dropping off a catwalk into the hall or into a lane is a route, and an open edge is also
 * one fewer 0.12 m ledge for the navmesh to call walkable. Cover up there comes from the
 * structural girders that pass through the deck.
 *
 * The deck is the reason `NAV_LAYERS` is 2: a column inside the hall holds the floor *and*
 * the deck above it, and a single-layer grid could only ever describe one of them.
 *
 * Convention: +X east, +Z south, Y up. Floor top is y = 0.
 */

// ---- the numbers everything else is derived from --------------------------

const FLOOR_MIN_X = -29;
const FLOOR_MAX_X = 29;
const FLOOR_MIN_Z = -25;
const FLOOR_MAX_Z = 25;

/** Perimeter shell. 9 m: high enough that the catwalk cannot see over it. */
const SHELL_HEIGHT = 9;

/** Hall footprint. Interior faces at +/-HALL_IN, exterior at +/-HALL_OUT. */
const HALL_IN = 11.0;
const HALL_OUT = 11.7;
const HALL_WALL_TOP = 3.0;

/** Catwalk. Walking surface at DECK_TOP; the deck itself is DECK_THICK below it. */
const DECK_TOP = 4.0;
const DECK_THICK = 0.3;
const DECK_WIDTH = 3.0;
/** Ring outer edge. Slightly proud of the hall wall, so it reads as hung off it. */
const RING_OUT = 11.9;
const RING_IN = RING_OUT - DECK_WIDTH;

/** Ramp geometry. 4 m over 9 m is 23.96 deg, comfortably inside the 46 deg limit. */
const RAMP_RUN = 9;
const RAMP_THICK = 0.6;

/** Roof over the north and south catwalk runs. 2.4 m of headroom on the deck. */
const ROOF_BOTTOM = DECK_TOP + 2.4;
const ROOF_TOP = ROOF_BOTTOM + 0.4;

/**
 * The three structural girders that pass through the catwalk, and therefore are cover on two
 * levels. Listed once because the prop placement and the deck-level cover emission both need
 * them and must not drift apart.
 *
 * The offsets are load-bearing and were found by measurement, not taste. Centring a 0.42 m
 * column on a 3 m deck leaves 1.29 m either side, which is passable — but the *same* column
 * on the hall floor below sat 0.39 m from the wall face, which is narrower than the 0.7 m
 * capsule, and the sprint sweep pinned the player against it on four separate runs. Pushed
 * inboard, both problems go: the deck keeps a 2.4 m clear lane on its outer side and the hall
 * wall keeps 1.5 m of clear floor along it.
 */
const DECK_GIRDERS: readonly Readonly<{ x: number; z: number; along: 'x' | 'z' }>[] = [
  // Under the west run of the ring; inboard of the deck's centre line.
  { x: -9.3, z: -5.0, along: 'z' },
  // Under the north run; likewise.
  { x: -5.0, z: -9.3, along: 'x' },
  // On the bridge across the middle, offset off its centre line.
  { x: -4.0, z: 1.0, along: 'x' },
];

/** Where the two teams meet in each lane, and the home spawn that feeds it. */
export interface LaneDef {
  readonly name: string;
  readonly center: Vec3Lit;
  readonly a: Vec3Lit;
  readonly b: Vec3Lit;
}

export const FOUNDRY_LANES: readonly LaneDef[] = [
  {
    name: 'WEST',
    center: { x: -22, y: 0, z: 0 },
    a: { x: -22, y: 0.05, z: 21 },
    b: { x: -22, y: 0.05, z: -21 },
  },
  {
    name: 'CENTRE',
    center: { x: 0, y: 0, z: 0 },
    a: { x: 0, y: 0.05, z: 21.5 },
    b: { x: 0, y: 0.05, z: -21.5 },
  },
  {
    name: 'EAST',
    center: { x: 22, y: 0, z: 0 },
    a: { x: 22, y: 0.05, z: 21 },
    b: { x: 22, y: 0.05, z: -21 },
  },
];

// ---- geometry -------------------------------------------------------------

/**
 * Shell, floor and the hall. Not rotated: it is already symmetric about the origin, and
 * describing it twice would only invite the two halves to disagree.
 */
function shell(): Brush[] {
  const out: Brush[] = [];

  // Floor, in five slabs that abut without overlapping. Two slabs whose top faces overlap
  // is the classic z-fighting bug; two that share an edge are not.
  addSpan(out, 'concreteDark', -HALL_OUT, HALL_OUT, -1, 0, -HALL_OUT, HALL_OUT);
  addSpan(out, 'floor', FLOOR_MIN_X, -HALL_OUT, -1, 0, FLOOR_MIN_Z, FLOOR_MAX_Z);
  addSpan(out, 'floor', HALL_OUT, FLOOR_MAX_X, -1, 0, FLOOR_MIN_Z, FLOOR_MAX_Z);
  addSpan(out, 'floor', -HALL_OUT, HALL_OUT, -1, 0, FLOOR_MIN_Z, -HALL_OUT);
  addSpan(out, 'floor', -HALL_OUT, HALL_OUT, -1, 0, HALL_OUT, FLOOR_MAX_Z);

  // Perimeter shell. Sunk 0.2 m so no downward face sits on the floor plane.
  addSpan(out, 'brick', FLOOR_MIN_X - 1, FLOOR_MAX_X + 1, -0.2, SHELL_HEIGHT, FLOOR_MIN_Z - 1, FLOOR_MIN_Z);
  addSpan(out, 'brick', FLOOR_MIN_X - 1, FLOOR_MAX_X + 1, -0.2, SHELL_HEIGHT, FLOOR_MAX_Z, FLOOR_MAX_Z + 1);
  addSpan(out, 'brick', FLOOR_MIN_X - 1, FLOOR_MIN_X, -0.2, SHELL_HEIGHT, FLOOR_MIN_Z, FLOOR_MAX_Z);
  addSpan(out, 'brick', FLOOR_MAX_X, FLOOR_MAX_X + 1, -0.2, SHELL_HEIGHT, FLOOR_MIN_Z, FLOOR_MAX_Z);

  return out;
}

/**
 * The hall's north and west walls, with their doorways. The other two come from
 * `rotateHalf`, which is what guarantees the four walls are one design rather than four.
 *
 * The north and south walls run the full width including the corners; the east and west
 * walls run only between them. That is not arbitrary — it means the only coplanar faces at
 * a corner are a pair facing in opposite directions, which back-face culling resolves, and
 * there is no overlap of two same-facing quads anywhere.
 */
function hallHalf(): Brush[] {
  const out: Brush[] = [];
  const y0 = -0.1;
  const y1 = HALL_WALL_TOP;

  // North wall: a 5 m main gate on the centre line and a 2.5 m side door offset east.
  addSpan(out, 'brick', -HALL_OUT, -2.5, y0, y1, -HALL_OUT, -HALL_IN);
  addSpan(out, 'brick', 2.5, 7.5, y0, y1, -HALL_OUT, -HALL_IN);
  addSpan(out, 'brick', 10.0, HALL_OUT, y0, y1, -HALL_OUT, -HALL_IN);

  // West wall, same pattern turned a quarter turn.
  addSpan(out, 'brick', -HALL_OUT, -HALL_IN, y0, y1, -HALL_IN, -2.5);
  addSpan(out, 'brick', -HALL_OUT, -HALL_IN, y0, y1, 2.5, 7.5);
  addSpan(out, 'brick', -HALL_OUT, -HALL_IN, y0, y1, 10.0, HALL_IN);

  // Interior partition, so the hall is rooms rather than a box. Below the deck.
  addSpan(out, 'concrete', -7.0, -2.0, y0, y1, -8.3, -7.7);

  return out;
}

/**
 * The catwalk deck: a ring, a bridge across the middle, two ramps into the outer lanes and
 * two internal stairs. Symmetric about the origin where it can be; the four pitched pieces
 * are spelled out per side.
 */
function catwalk(): Brush[] {
  const out: Brush[] = [];
  const d0 = DECK_TOP - DECK_THICK;

  // Ring. North and south runs go corner to corner; east and west fill between them.
  addSpan(out, 'grate', -RING_OUT, RING_OUT, d0, DECK_TOP, -RING_OUT, -RING_IN);
  addSpan(out, 'grate', -RING_OUT, RING_OUT, d0, DECK_TOP, RING_IN, RING_OUT);
  addSpan(out, 'grate', -RING_OUT, -RING_IN, d0, DECK_TOP, -RING_IN, RING_IN);
  addSpan(out, 'grate', RING_IN, RING_OUT, d0, DECK_TOP, -RING_IN, RING_IN);

  // The bridge straight across the middle of the hall.
  addSpan(out, 'grate', -RING_IN, RING_IN, d0, DECK_TOP, -DECK_WIDTH / 2, DECK_WIDTH / 2);

  // Roof over the two long runs. Above head height on the deck, so it shades the walkway
  // rather than boxing it in, and it gives the hall a silhouette from the lanes.
  addSpan(out, 'rust', -RING_OUT, RING_OUT, ROOF_BOTTOM, ROOF_TOP, -RING_OUT, -RING_IN);
  addSpan(out, 'rust', -RING_OUT, RING_OUT, ROOF_BOTTOM, ROOF_TOP, RING_IN, RING_OUT);

  // Outer ramps, one per lane, placed a third of the way down opposite sides so each team
  // has one near and one far. Their top edges land exactly on the ring.
  const rampFoot = RING_OUT + RAMP_RUN;
  rampAlongX(out, 'grate', -rampFoot, 0, -RING_OUT, DECK_TOP, 7.9, DECK_WIDTH, RAMP_THICK);
  rampAlongX(out, 'grate', rampFoot, 0, RING_OUT, DECK_TOP, -7.9, DECK_WIDTH, RAMP_THICK);

  // Internal stairs, hugging the east and west runs of the ring. Their top edges land on
  // the ring's inner edge exactly, the same way the outer ramps land on its outer edge — a
  // gap of even 0.2 m between two walking surfaces is a hole to fall through.
  rampAlongZ(out, 'grate', RAMP_RUN - RING_IN, 0, -RING_IN, DECK_TOP, 7.4, DECK_WIDTH, RAMP_THICK);
  rampAlongZ(out, 'grate', RING_IN - RAMP_RUN, 0, RING_IN, DECK_TOP, -7.4, DECK_WIDTH, RAMP_THICK);

  return out;
}

/** Non-solid trim: hazard borders and floor markings. Raised 3 cm, never coplanar. */
function trimHalf(): Brush[] {
  const out: Brush[] = [];
  const flat = { solid: false, shadows: false };

  // Hazard border inside each hall doorway, so a gate reads as a gate at a glance.
  addSpan(out, 'hazard', -2.5, 2.5, 0.02, 0.06, -HALL_IN - 0.15, -HALL_IN + 0.15, flat);
  addSpan(out, 'hazard', 7.5, 10.0, 0.02, 0.06, -HALL_IN - 0.15, -HALL_IN + 0.15, flat);
  addSpan(out, 'hazard', -HALL_IN - 0.15, -HALL_IN + 0.15, 0.02, 0.06, -2.5, 2.5, flat);
  addSpan(out, 'hazard', -HALL_IN - 0.15, -HALL_IN + 0.15, 0.02, 0.06, 7.5, 10.0, flat);

  // Accent stripe along the lane, the one piece of colour out in the open.
  addSpan(out, 'accent', -22.1, -21.9, 0.03, 0.07, -20, 20, flat);

  // Deck edge marker: a thin accent lip on the ring's inner edge, so the drop into the hall
  // is legible from above. Raised clear of the deck rather than sitting on it.
  addSpan(out, 'accent', -RING_IN - 0.08, -RING_IN + 0.02, DECK_TOP + 0.01, DECK_TOP + 0.05, -RING_IN, RING_IN, flat);
  addSpan(out, 'accent', -RING_OUT, RING_OUT, DECK_TOP + 0.01, DECK_TOP + 0.05, -RING_IN - 0.08, -RING_IN + 0.02, flat);

  return out;
}

// ---- props ----------------------------------------------------------------

/**
 * One outer lane and one yard, deliberately arranged: a container spine near the outer wall
 * that makes a back alley, a staggered line of mid-lane cover so no sight line down the
 * lane is clean, and girders for height and for shadows to fall across.
 *
 * The other lane and yard are this list rotated. Nothing is placed twice.
 */
function propsHalf(): PropDef[] {
  const out: PropDef[] = [];
  const H = Math.PI / 2;

  // ---- west lane: outer spine ----
  addProp(out, 'container', -25.0, -17.0, H);
  addProp(out, 'container', -25.0, 4.0, H);
  addProp(out, 'crateTall', -27.0, -22.0, 0.3);
  addProp(out, 'spool', -26.5, -8.0, 0.4);
  addProp(out, 'machine', -24.0, 20.0, -0.5);

  // ---- west lane: mid-lane, staggered ----
  addProp(out, 'container', -17.5, -6.0, 0);
  addProp(out, 'barrels', -14.5, -12.0, 0.2);
  addProp(out, 'spool', -19.0, 1.0, 0);
  addProp(out, 'machine', -15.0, -20.0, 0.3);
  addProp(out, 'barrels', -21.0, 12.5, 0);
  addProp(out, 'crate', -13.5, 21.0, 0);
  addProp(out, 'girder', -22.0, -11.0, 0);
  addProp(out, 'girder', -22.0, 17.0, 0);

  // ---- north yard ----
  //
  // Three of these were moved after the clearance audit: a prop whose footprint stops within
  // a capsule diameter of a wall or another prop makes a gap that looks like a route and is
  // not one, and the sprint sweep pins the player in it. See `verify/tdm.js`.
  addProp(out, 'container', -4.0, -21.5, 0);
  addProp(out, 'container', 7.0, -18.0, H);
  addProp(out, 'barrier', -9.5, -15.5, 0);
  addProp(out, 'barrier', 2.0, -14.5, 0.25);
  addProp(out, 'machine', 9.5, -14.2, -0.3);
  addProp(out, 'barrels', -2.0, -16.5, 0);
  addProp(out, 'spool', 5.0, -23.0, 0);
  addProp(out, 'crate', -9.1, -22.0, 0.4);
  addProp(out, 'girder', -9.0, -19.0, 0);

  // ---- hall interior ----
  addProp(out, 'ladle', -3.2, -4.6, 0.2);
  addProp(out, 'machine', 3.6, -6.2, H);
  addProp(out, 'barrels', -7.5, -2.0, 0);
  addProp(out, 'crate', 4.4, -8.7, 0.5);

  // Girders that pass *through* the catwalk, which is where the deck's cover comes from now
  // that it has no railings. Positions come from `DECK_GIRDERS`; see the note there.
  for (const g of DECK_GIRDERS) addProp(out, 'girder', g.x, g.z, 0);

  return out;
}

/** Wall-mounted accent strips. Non-solid; they exist so the palette has an anchor. */
function lightStrips(): PropDef[] {
  const out: PropDef[] = [];
  for (const x of [-22, -11, 0, 11, 22]) {
    out.push({ shape: 'lightBox', position: { x, y: 5.4, z: FLOOR_MIN_Z + 0.1 }, rotationY: 0 });
    out.push({ shape: 'lightBox', position: { x, y: 5.4, z: FLOOR_MAX_Z - 0.1 }, rotationY: Math.PI });
  }
  for (const z of [-18, -6, 6, 18]) {
    out.push({ shape: 'lightBox', position: { x: FLOOR_MIN_X + 0.1, y: 5.4, z }, rotationY: Math.PI / 2 });
    out.push({ shape: 'lightBox', position: { x: FLOOR_MAX_X - 0.1, y: 5.4, z }, rotationY: -Math.PI / 2 });
  }
  return out;
}

// ---- cover, spawns, objectives --------------------------------------------

/**
 * Cover, derived from the placements rather than listed.
 *
 * The only hand-emitted points are the catwalk-level faces of the three girders that pass
 * through the deck: the derivation places one point per face at the placement's own height,
 * and a girder is cover on two levels. They are emitted at `DECK_TOP` and `ai/Cover.ts`
 * resolves them against the layered navmesh by height.
 */
function coverPoints(placements: readonly PropDef[]): CoverPoint[] {
  const out = deriveCoverPoints(placements);

  // Deck-level faces of the girders that pass through the catwalk, on both halves of the map.
  // A girder's own placement already emitted its ground-level faces at y = 0.
  for (const g of DECK_GIRDERS) {
    for (const sign of [-1, 1]) {
      const fx = g.along === 'x' ? sign : 0;
      const fz = g.along === 'z' ? sign : 0;
      emitCoverPoint(out, g.x, g.z, 0, fx, fz, 0.21, 'high', DECK_TOP);
      emitCoverPoint(out, -g.x, -g.z, 0, -fx, -fz, 0.21, 'high', DECK_TOP);
    }
  }

  // The hall's two interior partitions are brushes, not props.
  emitCoverPoint(out, -4.5, -8.0, 0, 0, -1, 0.3, 'high');
  emitCoverPoint(out, -4.5, -8.0, 0, 0, 1, 0.3, 'high');
  emitCoverPoint(out, 4.5, 8.0, 0, 0, -1, 0.3, 'high');
  emitCoverPoint(out, 4.5, 8.0, 0, 0, 1, 0.3, 'high');

  return out;
}

/**
 * Spawn zones (brief S6.1, S6.9).
 *
 * Three home zones per team across the width, so a player spawns at the mouth of the lane
 * they are about to run, plus five more spread up the map — including two past the centre
 * line, which is the flip-side set. TDM spawn traps happen when a pushed team has nowhere
 * behind the pushers to appear; `ai/SpawnSelector` maximises distance from living enemies
 * and rejects anything inside a cone with line of sight, so what it needs from a map is
 * candidates on *both* sides of the fight rather than a cleverer rule.
 */
function spawnHalf(): SpawnZone[] {
  const a: SpawnZone[] = [];
  const facingNorth = 0;
  const put = (x: number, z: number, radius: number): void => {
    a.push({ team: 'A', position: { x, y: 0.05, z }, facingYaw: facingNorth, radius });
  };

  put(-22, 21, 3.0);
  put(0, 21.5, 3.0);
  put(22, 21, 3.0);
  put(-26.5, 14, 2.5);
  put(26.5, 14, 2.5);
  put(0, 16, 2.5);
  // Flip side: past the centre line, for when team A has been pushed off the map.
  put(-26.5, -2, 2.5);
  put(26.5, -2, 2.5);

  return a;
}

function spawns(): SpawnZone[] {
  const a = spawnHalf();
  const b: SpawnZone[] = a.map((z) => ({
    team: 'B',
    position: { x: -z.position.x, y: z.position.y, z: -z.position.z },
    facingYaw: z.facingYaw + Math.PI,
    radius: z.radius,
  }));
  return [...a, ...b];
}

/**
 * Objectives, authored now for modes that arrive in M7 (brief S6.1).
 *
 * Three Domination flags — A and C deep in each half's outer lane, B in the middle of the
 * hall under the bridge — and two Search & Destroy bomb sites. The flags are rotationally
 * symmetric like everything else. **The bomb sites deliberately are not:** S&D is the one
 * mode where the two teams do different jobs, so both sites sit in one half and the
 * asymmetry is the design.
 *
 * Placing them now rather than in M7 is the whole point: they are where the lanes are worth
 * fighting over, and moving them later would mean re-timing the lanes.
 */
function objectives(): ObjectiveDef[] {
  return [
    { id: 'dom_a', kind: 'flag', label: 'A', position: { x: -19, y: 0, z: 15 }, radius: 4 },
    { id: 'dom_b', kind: 'flag', label: 'B', position: { x: 0, y: 0, z: 0 }, radius: 4 },
    { id: 'dom_c', kind: 'flag', label: 'C', position: { x: 19, y: 0, z: -15 }, radius: 4 },
    { id: 'snd_a', kind: 'bombsite', label: 'A', position: { x: -18, y: 0, z: -14 }, radius: 3.5 },
    { id: 'snd_b', kind: 'bombsite', label: 'B', position: { x: 14, y: 0, z: -19 }, radius: 3.5 },
  ];
}

// ---- assembly -------------------------------------------------------------

const HALF_BRUSHES = hallHalf();
const TRIM_BRUSHES = trimHalf();
const HALF_PROPS = propsHalf();
const ALL_PROPS: PropDef[] = [...HALF_PROPS, ...rotateHalfProps(HALF_PROPS)];

export const FOUNDRY_MAP: MapDef = {
  id: 'mp_foundry',
  name: 'FOUNDRY',
  brushes: [
    ...shell(),
    ...HALF_BRUSHES,
    ...rotateHalf(HALF_BRUSHES),
    ...catwalk(),
    ...TRIM_BRUSHES,
    ...rotateHalf(TRIM_BRUSHES),
  ],
  props: [...ALL_PROPS, ...lightStrips()],
  spawns: spawns(),
  /**
   * Lighting, brightened in M5 from the M4 playtest note that Foundry was too dark.
   *
   * The problem was not the key light — it was the *fill*. A hemisphere at 0.78 with a
   * near-black ground colour means anything facing away from the sun is lit by almost
   * nothing, and on a map whose interesting spaces are all indoors that is most of it. The
   * hemisphere is now 1.35 with a ground colour lifted out of the mud, so a wall in shadow
   * still reads as a surface; the key came up a little to keep the contrast ratio, and the
   * two ladles came up because a hall competing with brighter fill needs to.
   *
   * The fog also mattered more than it looked: `fogNear` at 38 m on a 62 m map was greying
   * out the far half of every lane. Pushed back to 55.
   */
  lights: [
    { kind: 'hemisphere', skyColor: 0x9db4d0, groundColor: 0x4a4038, intensity: 1.35 },
    {
      kind: 'directional',
      color: 0xffe3c2,
      intensity: 2.35,
      direction: { x: 0.38, y: -0.82, z: 0.42 },
      castShadow: true,
      // The ortho frustum is fitted to navBounds' centre, so this has to clear its half
      // diagonal or the far corner of the map falls out of the shadow map.
      shadowExtent: 42,
    },
    // The two ladles, lighting the hall from inside. No shadows: they exist to say the
    // centre of the map is a different place, not to double the shadow cost.
    { kind: 'point', color: 0xffa860, intensity: 26, position: { x: -3.2, y: 2.6, z: -4.6 }, distance: 18, decay: 2 },
    { kind: 'point', color: 0xffa860, intensity: 26, position: { x: 3.2, y: 2.6, z: 4.6 }, distance: 18, decay: 2 },
  ],
  ambient: {
    skyColor: 0x9db4d0,
    groundColor: 0x4a4038,
    fogColor: 0x272b33,
    fogNear: 55,
    fogFar: 150,
  },

  coverPoints: coverPoints(ALL_PROPS),
  objectives: objectives(),
  navBounds: {
    min: { x: -31, y: -4, z: -27 },
    max: { x: 31, y: 12, z: 27 },
  },
  /**
   * A working steel shed: bright, long-ish, with three discrete slaps off the shell before
   * the tail settles. Generated into the one convolver at load (S6.6).
   */
  reverb: {
    seconds: 1.9,
    decay: 2.1,
    brightness: 0.72,
    earlyTaps: [
      { delay: 0.021, gain: 0.5 },
      { delay: 0.037, gain: 0.36 },
      { delay: 0.061, gain: 0.24 },
      { delay: 0.094, gain: 0.15 },
    ],
  },
};
