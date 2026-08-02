import {
  addProp,
  addSpan,
  addWallAlongX,
  addWallAlongZ,
  rampAlongZ,
  rotateHalf,
  rotateHalfProps,
  type Gap,
} from './build';
import { deriveCoverPoints, emitCoverPoint } from './cover';
import type { Brush, CoverPoint, LaneDef, MapDef, ObjectiveDef, PropDef, SpawnZone } from './types';

/**
 * MP_DUNES — the first M8 map (brief S6.1).
 *
 * A desert village at midday. **The sight lines are the identity.** Two outer streets run
 * the full 72 m length of the map with nothing but knee-high cover and palm trunks in
 * them; the middle is a block of fourteen buildings cut by 4 m alleys. Standing in a
 * street on Dunes you can see the enemy spawn. That is the point, and it is what makes
 * the alleys worth taking.
 *
 * ## The shape
 *
 * ```
 *                       z = -38  (TEAM B home)
 *   +------------------------------------------------+
 *   |   north yard                                   |
 *   |  W   [room] [pass] [room]    E                 |  x = -32 .. +32
 *   |  E   ---- cross street ----  A                 |  z = -38 .. +38
 *   |  S   [PERCH][pass] [blk ]    S                 |
 *   |  T   ---- cross street ----  T                 |
 *   |      [blk ]  PLAZA  [blk ]                     |  buildings 3.3 m, roofs 3.4 m
 *   |  l   ---- cross street ----  l                 |  perimeter wall 11 m
 *   |  a   [blk ] [pass] [PERCH]   a                 |
 *   |  n   ---- cross street ----  n                 |
 *   |  e   [room] [pass] [room]    e                 |
 *   |   south yard                                   |
 *   +------------------------------------------------+
 *                       z = +38  (TEAM A home)
 * ```
 *
 * ## Why the alleys are a real route and not a token one
 *
 * Three things, all measurable rather than asserted:
 *
 * 1. **They are the same length.** The two 4 m alleys at x = ±7.5 and the two streets at
 *    x = ±26 all run the full length of the map, so all three lanes reach the centre in
 *    within a few percent of each other (`DUNES_LANES`, measured by the debug harness).
 *    An alley that costs you five seconds is a trap, not an option.
 * 2. **The centre column is a covered passage, not a building.** Rows one and two at x = 0
 *    are two walls and a roof with a 3.6 m corridor between them, so the shortest route on
 *    the map is also the one with no sight line into it.
 * 3. **Village walls are `plaster`, at 0.74 penetration density.** An alley is concealment
 *    from a street, not immunity to it — a rifle puts rounds through a village wall with
 *    damage left, which is exactly what stops the middle being strictly safer than the
 *    outside.
 *
 * ## The two perches
 *
 * One building per half has an accessible roof, reached by an external stair out of the
 * outer street, and its roof **overhangs the street by 3.3 m**. That overhang is doing two
 * jobs: it gives the stair somewhere to land without a gap between two walking surfaces,
 * and it is the one place on the map where a column holds two walkable surfaces — which is
 * why Dunes needs the layered navmesh at all.
 *
 * Rotationally symmetric: everything but the two stairs and the two bomb sites is authored
 * for one half and put through `rotateHalf`. The stairs are pitched brushes and are spelled
 * out per side; see `build.ts`.
 *
 * Convention: +X east, +Z south, Y up. Floor top is y = 0.
 */

// ---- the numbers everything else is derived from --------------------------

const FLOOR_MIN_X = -32;
const FLOOR_MAX_X = 32;
const FLOOR_MIN_Z = -38;
const FLOOR_MAX_Z = 38;

/** Perimeter wall. 11 m: a metre and a half clear above the highest reachable roof. */
const SHELL_HEIGHT = 11;

/** Building massing. Half extents, so a block is 11 x 8 m in plan. */
const BLOCK_HX = 5.5;
const BLOCK_HZ = 4.0;
const WALL_THICK = 0.5;

/** Where the three building columns sit. The outer two make the streets. */
const COL_X = 15;
/** Row centres in the authored (negative Z) half. */
const ROW_NEAR = -26;
const ROW_MID = -13;
/** The plaza flanks straddle the origin and are authored once. */
const FLANK_HZ = 5.0;

const BUILD_TOP = 3.3;
/** Roof slab, sunk into the walls so no two visible faces are ever coplanar. */
const ROOF_LO = 3.05;
const ROOF_TOP = 3.4;
/** Eaves, and the overhang on the two perch buildings. */
const EAVE = 0.3;
const PERCH_OVERHANG = 3.3;

/** Doorways and passage mouths. 1.6 m against a 0.7 m capsule: tight, never a snag. */
const DOOR = 1.6;
/** Half-width of the covered passage through the centre column. */
const PASSAGE_HX = 1.8;

/** Street centre lines, and therefore where the long sight lines live. */
const STREET_X = 26;
/** Alley centre lines, between the building columns. */
const ALLEY_X = 7.5;

export const DUNES_LANES: readonly LaneDef[] = [
  {
    name: 'WEST',
    center: { x: -STREET_X, y: 0, z: 0 },
    a: { x: -STREET_X, y: 0.05, z: 33 },
    b: { x: -STREET_X, y: 0.05, z: -33 },
  },
  {
    name: 'CENTRE',
    center: { x: 0, y: 0, z: 0 },
    a: { x: 0, y: 0.05, z: 33 },
    b: { x: 0, y: 0.05, z: -33 },
  },
  {
    name: 'EAST',
    center: { x: STREET_X, y: 0, z: 0 },
    a: { x: STREET_X, y: 0.05, z: 33 },
    b: { x: STREET_X, y: 0.05, z: -33 },
  },
];

// ---- geometry -------------------------------------------------------------

/** Ground and the perimeter. Already symmetric about the origin, so it is authored once. */
function shell(): Brush[] {
  const out: Brush[] = [];

  // Ground in three slabs that abut rather than overlap: two coplanar top faces is the
  // classic z-fighting bug, two that share an edge are not.
  addSpan(out, 'sand', FLOOR_MIN_X, -20.5, -1, 0, FLOOR_MIN_Z, FLOOR_MAX_Z);
  addSpan(out, 'sand', -20.5, 20.5, -1, 0, FLOOR_MIN_Z, FLOOR_MAX_Z);
  addSpan(out, 'sand', 20.5, FLOOR_MAX_X, -1, 0, FLOOR_MIN_Z, FLOOR_MAX_Z);

  // Perimeter. Sunk 0.2 m so no downward face sits on the ground plane.
  addSpan(out, 'plaster', FLOOR_MIN_X - 1, FLOOR_MAX_X + 1, -0.2, SHELL_HEIGHT, FLOOR_MIN_Z - 1, FLOOR_MIN_Z);
  addSpan(out, 'plaster', FLOOR_MIN_X - 1, FLOOR_MAX_X + 1, -0.2, SHELL_HEIGHT, FLOOR_MAX_Z, FLOOR_MAX_Z + 1);
  addSpan(out, 'plaster', FLOOR_MIN_X - 1, FLOOR_MIN_X, -0.2, SHELL_HEIGHT, FLOOR_MIN_Z, FLOOR_MAX_Z);
  addSpan(out, 'plaster', FLOOR_MAX_X, FLOOR_MAX_X + 1, -0.2, SHELL_HEIGHT, FLOOR_MIN_Z, FLOOR_MAX_Z);

  // A clay coping course along the top of the perimeter, so the skyline is not a flat
  // band of one colour. Non-solid: it is 11 m up and nothing can reach it.
  const cap = { solid: false, shadows: false } as const;
  addSpan(out, 'clayTile', FLOOR_MIN_X - 1.2, FLOOR_MAX_X + 1.2, SHELL_HEIGHT, SHELL_HEIGHT + 0.4, FLOOR_MIN_Z - 1.2, FLOOR_MIN_Z + 0.2, cap);
  addSpan(out, 'clayTile', FLOOR_MIN_X - 1.2, FLOOR_MAX_X + 1.2, SHELL_HEIGHT, SHELL_HEIGHT + 0.4, FLOOR_MAX_Z - 0.2, FLOOR_MAX_Z + 1.2, cap);
  addSpan(out, 'clayTile', FLOOR_MIN_X - 1.2, FLOOR_MIN_X + 0.2, SHELL_HEIGHT, SHELL_HEIGHT + 0.4, FLOOR_MIN_Z, FLOOR_MAX_Z, cap);
  addSpan(out, 'clayTile', FLOOR_MAX_X - 0.2, FLOOR_MAX_X + 1.2, SHELL_HEIGHT, SHELL_HEIGHT + 0.4, FLOOR_MIN_Z, FLOOR_MAX_Z, cap);

  return out;
}

/** A roof slab over a building footprint, with eaves. `west` extends it into the street. */
function roof(out: Brush[], x0: number, x1: number, z0: number, z1: number, west = 0): void {
  addSpan(out, 'clayTile', x0 - EAVE - west, x1 + EAVE, ROOF_LO, ROOF_TOP, z0 - EAVE, z1 + EAVE);
}

/**
 * A solid block of massing: four walls and a filled interior, capped.
 *
 * Used where the building's job is to *be* the alley wall rather than to be a place. It is
 * one brush plus its roof rather than four walls plus a floor, which keeps the collider
 * count honest — the interior is not reachable, so describing it would be describing
 * nothing.
 */
function solidBlock(out: Brush[], cx: number, cz: number, hz = BLOCK_HZ): void {
  const x0 = cx - BLOCK_HX;
  const x1 = cx + BLOCK_HX;
  const z0 = cz - hz;
  const z1 = cz + hz;
  addSpan(out, 'plaster', x0, x1, -0.15, BUILD_TOP, z0, z1);
  roof(out, x0, x1, z0, z1);
}

/**
 * A one-room house: four walls, two doorways, and a roof with a hole in it.
 *
 * The hole is not decoration. A sealed room under a directional light is lit by the
 * hemisphere alone, which on a bright map means a black box you cannot fight in; a 3 m gap
 * in the roof puts a hard-edged shaft of sun on the floor and makes the interior legible.
 * It also gives the room a second read from the perch above it.
 */
function room(out: Brush[], cx: number, cz: number, doorsNS: readonly Gap[], doorsWE: readonly Gap[]): void {
  const x0 = cx - BLOCK_HX;
  const x1 = cx + BLOCK_HX;
  const z0 = cz - BLOCK_HZ;
  const z1 = cz + BLOCK_HZ;
  const y0 = -0.15;

  addWallAlongX(out, 'plaster', x0, x1, y0, BUILD_TOP, z0, z0 + WALL_THICK, doorsNS);
  addWallAlongX(out, 'plaster', x0, x1, y0, BUILD_TOP, z1 - WALL_THICK, z1, doorsNS);
  addWallAlongZ(out, 'plaster', x0, x0 + WALL_THICK, y0, BUILD_TOP, z0 + WALL_THICK, z1 - WALL_THICK, doorsWE);
  addWallAlongZ(out, 'plaster', x1 - WALL_THICK, x1, y0, BUILD_TOP, z0 + WALL_THICK, z1 - WALL_THICK, doorsWE);

  // Roof in two slabs with a 3 m gap between them, plus a lintel over each doorway so the
  // openings read as openings from the street rather than as missing wall.
  addSpan(out, 'clayTile', x0 - EAVE, x1 + EAVE, ROOF_LO, ROOF_TOP, z0 - EAVE, cz - 1.5);
  addSpan(out, 'clayTile', x0 - EAVE, x1 + EAVE, ROOF_LO, ROOF_TOP, cz + 1.5, z1 + EAVE);
  const trim = { solid: false, shadows: false } as const;
  for (const [a, b] of doorsNS) {
    addSpan(out, 'wood', a, b, 2.15, 2.35, z0 - 0.06, z0 + WALL_THICK + 0.06, trim);
    addSpan(out, 'wood', a, b, 2.15, 2.35, z1 - WALL_THICK - 0.06, z1 + 0.06, trim);
  }
}

/**
 * The centre column: two walls and a roof with a 3.6 m corridor between them.
 *
 * This is the shortest route from spawn to spawn and it has no sight line into it from
 * either street — which is the whole argument for taking it.
 */
function passage(out: Brush[], cz: number): void {
  const z0 = cz - BLOCK_HZ;
  const z1 = cz + BLOCK_HZ;
  addSpan(out, 'plaster', -BLOCK_HX, -PASSAGE_HX, -0.15, BUILD_TOP, z0, z1);
  addSpan(out, 'plaster', PASSAGE_HX, BLOCK_HX, -0.15, BUILD_TOP, z0, z1);
  // The roof spans the corridor. 3.05 m of headroom, so nothing about it is a low ceiling.
  addSpan(out, 'clayTile', -BLOCK_HX - EAVE, BLOCK_HX + EAVE, ROOF_LO, ROOF_TOP, z0 - EAVE, z1 + EAVE);
  // Beams across the corridor mouth, at the same height as the room lintels.
  const trim = { solid: false, shadows: false } as const;
  addSpan(out, 'wood', -PASSAGE_HX, PASSAGE_HX, 2.6, 2.85, z0 - 0.1, z0 + 0.3, trim);
  addSpan(out, 'wood', -PASSAGE_HX, PASSAGE_HX, 2.6, 2.85, z1 - 0.3, z1 + 0.1, trim);
}

/**
 * The buildings of one half, plus the plaza flanks (which straddle the origin and are
 * therefore authored here once and *not* rotated — see the assembly at the bottom).
 */
function villageHalf(): Brush[] {
  const out: Brush[] = [];

  // ---- near row: two houses and a passage --------------------------------
  room(out, -COL_X, ROW_NEAR, [[-COL_X - DOOR / 2, -COL_X + DOOR / 2]], [[ROW_NEAR - DOOR / 2, ROW_NEAR + DOOR / 2]]);
  room(out, COL_X, ROW_NEAR, [[COL_X - DOOR / 2, COL_X + DOOR / 2]], [[ROW_NEAR - DOOR / 2, ROW_NEAR + DOOR / 2]]);
  passage(out, ROW_NEAR);

  // ---- mid row: the perch, a passage and a block --------------------------
  //
  // The perch's roof reaches PERCH_OVERHANG into the street so the stair has somewhere to
  // land. A gap of even 0.2 m between two walking surfaces is a hole to fall through.
  const px0 = -COL_X - BLOCK_HX;
  const px1 = -COL_X + BLOCK_HX;
  const pz0 = ROW_MID - BLOCK_HZ;
  const pz1 = ROW_MID + BLOCK_HZ;
  addSpan(out, 'plaster', px0, px1, -0.15, BUILD_TOP, pz0, pz1);
  roof(out, px0, px1, pz0, pz1, PERCH_OVERHANG);
  // A parapet on the street edge of the perch: chest-high cover on the one position that
  // can see the whole lane, so holding it is a choice rather than a free kill.
  addSpan(out, 'plaster', px0 - EAVE - PERCH_OVERHANG, px0 - EAVE - PERCH_OVERHANG + 0.4, ROOF_TOP - 0.1, ROOF_TOP + 1.0, pz0 - EAVE, pz1 + EAVE);
  addSpan(out, 'plaster', px0 - EAVE - PERCH_OVERHANG, px1 + EAVE, ROOF_TOP - 0.1, ROOF_TOP + 0.45, pz0 - EAVE, pz0 - EAVE + 0.4);

  passage(out, ROW_MID);
  solidBlock(out, COL_X, ROW_MID);

  return out;
}

/** The two plaza flanks. Symmetric about the origin, so they are never rotated. */
function plazaFlanks(): Brush[] {
  const out: Brush[] = [];
  solidBlock(out, -COL_X, 0, FLANK_HZ);
  solidBlock(out, COL_X, 0, FLANK_HZ);
  return out;
}

/**
 * The two stairs up to the perches, authored per side.
 *
 * A pitched brush cannot be rotated by adding pi to its yaw (see `build.ts`), so
 * `rotateHalf` throws on one rather than producing a ramp pointing into the ground. Both
 * are spelled out, and both land exactly on `ROOF_TOP`.
 *
 * **They climb alongside the overhang, not underneath it.** The first version ran up the
 * street directly under the balcony, which put a 3.05 m ceiling over a ramp that had to
 * reach 3.4 m — so the top third of it had no standing headroom, the bake refused those
 * cells, and the perch was unreachable. Found by the cover-rejection count, which threw
 * away the parapet points because nothing could stand on the roof to use them.
 *
 * Climbing from the south instead means the stair is clear of the roof's z-span for its
 * whole run and arrives exactly at its southern edge. It abuts the plaza flank building on
 * its inboard side, so there is no 0.4 m slot between the two for a sprint to catch in.
 */
function stairs(): Brush[] {
  const out: Brush[] = [];
  // Inboard face flush with the building line; 3 m wide, running out into the street.
  const xw = -COL_X - BLOCK_HX + 0.5 - 3.0 / 2;
  // Top edge on the roof's southern eave, bottom out in the open street.
  const top = ROW_MID + BLOCK_HZ + EAVE;
  rampAlongZ(out, 'plaster', top + 6.7, 0, top, ROOF_TOP, xw, 3.0, 0.7);
  rampAlongZ(out, 'plaster', -top - 6.7, 0, -top, ROOF_TOP, -xw, 3.0, 0.7);
  return out;
}

/** Non-solid trim: kerb lines and the hazard border at each passage mouth. */
function trimHalf(): Brush[] {
  const out: Brush[] = [];
  const flat = { solid: false, shadows: false } as const;

  // Kerbs down both streets, raised 3 cm. They are what tell you which way the lane runs
  // when you are looking down 72 m of sand.
  addSpan(out, 'clayTile', -20.62, -20.42, 0.02, 0.08, FLOOR_MIN_Z + 2, FLOOR_MAX_Z - 2, flat);
  addSpan(out, 'accent', -STREET_X - 0.1, -STREET_X + 0.1, 0.03, 0.07, -20, 20, flat);

  // Threshold strips in the alley mouths, so an alley entrance is legible at a sprint.
  for (const z of [ROW_NEAR - BLOCK_HZ - 1.2, ROW_MID + BLOCK_HZ + 1.2]) {
    addSpan(out, 'clayTile', -ALLEY_X - 2, -ALLEY_X + 2, 0.02, 0.06, z - 0.15, z + 0.15, flat);
    addSpan(out, 'clayTile', ALLEY_X - 2, ALLEY_X + 2, 0.02, 0.06, z - 0.15, z + 0.15, flat);
  }
  return out;
}

// ---- props ----------------------------------------------------------------

/**
 * One half of the map's clutter.
 *
 * The street list is the interesting one and it is deliberately thin: **nothing in a street
 * is taller than 1.2 m except palm trunks**, which are 0.42 m wide against a 0.7 m capsule
 * and therefore concealment rather than cover. A street that filled up with containers
 * would stop being a sight line, and the sight line is what this map is.
 */
function propsHalf(): PropDef[] {
  const out: PropDef[] = [];
  const H = Math.PI / 2;

  // ---- west street: knee-high cover and palms, staggered ------------------
  addProp(out, 'sandbags', -28.5, -30.0, 0.1);
  addProp(out, 'sandbags', -23.0, -21.0, H);
  addProp(out, 'sandbags', -29.5, -8.0, 0.05);
  addProp(out, 'palm', -24.5, -34.0);
  addProp(out, 'palm', -30.0, -18.0);
  addProp(out, 'palm', -25.5, -2.5);
  addProp(out, 'stall', -29.0, -25.0, H);
  addProp(out, 'crate', -22.5, -33.5, 0.4);
  // 1.2 m off the perimeter rather than against it: at -30.5 the outboard cover point
  // landed 0.13 m from the wall face and the navmesh threw it away.
  addProp(out, 'barrels', -29.3, -13.0, 0.2);

  // ---- north yard --------------------------------------------------------
  addProp(out, 'sandbags', -12.0, -34.0, 0);
  addProp(out, 'sandbags', 4.0, -33.0, 0.15);
  addProp(out, 'stall', -4.5, -35.0, 0);
  addProp(out, 'stall', 13.0, -34.0, Math.PI);
  addProp(out, 'crate', 8.5, -35.5, 0.3);
  addProp(out, 'palm', 20.0, -35.0);
  addProp(out, 'palm', -19.5, -32.5);
  addProp(out, 'barrels', 0.0, -32.5, 0);

  // ---- alleys and cross streets ------------------------------------------
  addProp(out, 'crate', -ALLEY_X - 0.9, -19.5, 0.25);
  addProp(out, 'barrels', ALLEY_X + 0.8, -19.5, 0);
  addProp(out, 'sandbags', -ALLEY_X, -7.0, 0);
  addProp(out, 'crate', ALLEY_X, -7.2, 0.5);
  addProp(out, 'stall', 0, -7.4, 0);

  // ---- inside the two houses of this half --------------------------------
  //
  // A room is 10.5 x 7 m inside its walls and a derived cover point reaches 1.1-1.4 m out
  // from the object it belongs to, so anything within about 1.8 m of an interior wall
  // throws away half its cover. All three of these were moved inboard after the rejection
  // count said so.
  addProp(out, 'crate', -COL_X - 3.2, ROW_NEAR - 1.4, 0.2);
  addProp(out, 'barrels', -COL_X + 2.6, ROW_NEAR + 1.4, 0);
  addProp(out, 'crate', COL_X + 2.8, ROW_NEAR + 1.6, 0.6);

  return out;
}

/** The plaza. Authored once because it straddles the origin. */
function plazaProps(): PropDef[] {
  const out: PropDef[] = [];
  addProp(out, 'well', -3.5, 2.5);
  addProp(out, 'well', 3.5, -2.5);
  addProp(out, 'stall', -6.5, -3.0, Math.PI / 2);
  addProp(out, 'stall', 6.5, 3.0, -Math.PI / 2);
  addProp(out, 'sandbags', 5.0, -6.5, 0.2);
  addProp(out, 'sandbags', -5.0, 6.5, 0.2 + Math.PI);
  addProp(out, 'palm', -8.4, 0);
  addProp(out, 'palm', 8.4, 0);
  // Clear of the two plaza stalls: at +/-6.0 these drums stood exactly where the stall's
  // own cover point wanted to be, and the pair cost each other a slot.
  addProp(out, 'barrels', 0, 4.6, 0);
  addProp(out, 'barrels', 0, -4.6, 0);
  return out;
}

// ---- cover, spawns, objectives --------------------------------------------

/**
 * Cover, derived from the placements rather than listed.
 *
 * The hand-emitted points are the ones with no placement to derive from: the parapet on
 * each perch roof, which is a brush, and the four passage mouths, where the useful cover
 * is the corner of a wall rather than an object beside it.
 */
function coverPoints(placements: readonly PropDef[]): CoverPoint[] {
  const out = deriveCoverPoints(placements);

  // Perch parapets, at roof height. `ai/Cover.ts` resolves these against the layered
  // navmesh by height, the same way Foundry's catwalk girders are resolved.
  for (const sign of [-1, 1]) {
    const x = sign * (-COL_X - BLOCK_HX - EAVE - PERCH_OVERHANG + 1.0);
    const z = sign * ROW_MID;
    emitCoverPoint(out, x, z - 2.2 * sign, 0, sign, 0, 0.3, 'low', ROOF_TOP);
    emitCoverPoint(out, x, z + 2.2 * sign, 0, sign, 0, 0.3, 'low', ROOF_TOP);
  }

  // Passage mouths: the wall corner you lean out of, both columns, both halves.
  for (const cz of [ROW_NEAR, ROW_MID, -ROW_NEAR, -ROW_MID]) {
    for (const side of [-1, 1]) {
      emitCoverPoint(out, side * (PASSAGE_HX + 1.4), cz - BLOCK_HZ, 0, 0, -1, 0.3, 'high');
      emitCoverPoint(out, side * (PASSAGE_HX + 1.4), cz + BLOCK_HZ, 0, 0, 1, 0.3, 'high');
    }
  }
  return out;
}

/**
 * Spawn zones (brief S6.1, S6.9).
 *
 * Three at the mouth of each lane so a player appears facing the route they are about to
 * run, three more spread up the map, and **two past the centre line** — the flip-side set
 * that gives `ai/SpawnSelector` somewhere behind a pushing enemy to put you. On a map this
 * long that matters more than it does on Foundry: without it, a team pushed back to the
 * south yard has 38 m of open street between them and anything.
 */
function spawnHalf(): SpawnZone[] {
  const a: SpawnZone[] = [];
  const put = (x: number, z: number, radius: number): void => {
    a.push({ team: 'A', position: { x, y: 0.05, z }, facingYaw: 0, radius });
  };

  put(-STREET_X, 33.5, 3.0);
  put(0, 34.5, 3.0);
  put(STREET_X, 33.5, 3.0);
  put(-30, 24, 2.4);
  put(30, 24, 2.4);
  put(-ALLEY_X, 25, 1.5);
  put(ALLEY_X, 25, 1.5);
  // Flip side: past the centre line, for when team A has been pushed off the map.
  put(-30, -6, 2.4);
  put(30, -6, 2.4);

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
 * Objectives.
 *
 * The flags are rotationally symmetric: A and C sit in the two streets, one in each half,
 * which puts Domination's whole argument in the map's most dangerous space. B is the
 * plaza. The **bomb sites are deliberately not symmetric** — Search & Destroy is the one
 * mode where the two teams do different jobs, so both sites are in one half.
 */
function objectives(): ObjectiveDef[] {
  return [
    { id: 'dom_a', kind: 'flag', label: 'A', position: { x: -25, y: 0, z: 13 }, radius: 4 },
    { id: 'dom_b', kind: 'flag', label: 'B', position: { x: 0, y: 0, z: 0 }, radius: 4.5 },
    { id: 'dom_c', kind: 'flag', label: 'C', position: { x: 25, y: 0, z: -13 }, radius: 4 },
    { id: 'snd_a', kind: 'bombsite', label: 'A', position: { x: -14, y: 0, z: -19.5 }, radius: 3.5 },
    { id: 'snd_b', kind: 'bombsite', label: 'B', position: { x: 14, y: 0, z: -7 }, radius: 3.5 },
  ];
}

// ---- assembly -------------------------------------------------------------

const HALF_BRUSHES = villageHalf();
const TRIM_BRUSHES = trimHalf();
const HALF_PROPS = propsHalf();
const ALL_PROPS: PropDef[] = [...HALF_PROPS, ...rotateHalfProps(HALF_PROPS), ...plazaProps()];

export const DUNES_MAP: MapDef = {
  id: 'mp_dunes',
  name: 'DUNES',
  brushes: [
    ...shell(),
    ...HALF_BRUSHES,
    ...rotateHalf(HALF_BRUSHES),
    ...plazaFlanks(),
    ...stairs(),
    ...TRIM_BRUSHES,
    ...rotateHalf(TRIM_BRUSHES),
  ],
  props: ALL_PROPS,
  spawns: spawns(),
  lanes: DUNES_LANES,

  /**
   * Midday in a dry place.
   *
   * The sun is nearly overhead (y = -0.94) and strong, which is what produces the hard,
   * short, near-vertical shadows the brief asks for — a low sun would have thrown 20 m
   * shadows down every street and turned a bright map into a striped one. The shadow
   * radius is dropped to 1.1 for the same reason: Foundry's 2.5 is a soft industrial
   * skylight, and softening a desert shadow is the one thing that would make this map
   * read as the wrong place.
   *
   * The hemisphere is doing the heavy lifting for anything facing away from the sun. Its
   * ground colour is sand, so bounce light off the street is warm — which is most of the
   * fill on a map where the ground is the biggest surface.
   */
  lights: [
    { kind: 'hemisphere', skyColor: 0xd6e2f2, groundColor: 0xb08c58, intensity: 1.5 },
    {
      kind: 'directional',
      color: 0xfff1d4,
      intensity: 3.1,
      direction: { x: 0.2, y: -0.94, z: 0.27 },
      castShadow: true,
      // Must clear the half-diagonal of navBounds or the far corner falls out of the map.
      shadowExtent: 54,
      shadowRadius: 1.1,
    },
  ],
  ambient: {
    skyColor: 0xd6e2f2,
    groundColor: 0xb08c58,
    // Dust haze rather than gloom: the far end of a 72 m street should be hazy, not dark.
    fogColor: 0xc9ae83,
    fogNear: 72,
    fogFar: 210,
  },

  /**
   * Airborne dust, lit warm and drifting.
   *
   * Not decoration: on a map with 72 m sight lines the only cue for distance is atmosphere,
   * and motes at a few metres moving against a static street at fifty is what makes the
   * street read as fifty metres long rather than as a flat backdrop.
   */
  particulate: {
    count: 460,
    radius: 26,
    color: 0xffe6bc,
    size: 0.055,
    opacity: 0.34,
    drift: { x: 0.55, y: -0.06, z: 0.22 },
  },

  coverPoints: coverPoints(ALL_PROPS),
  objectives: objectives(),
  navBounds: {
    min: { x: -34, y: -4, z: -40 },
    max: { x: 34, y: 14, z: 40 },
  },

  /**
   * Open air between hard flat walls: bright, short, and almost no early structure.
   *
   * The tail is under a second because there is no roof over most of the map — the
   * reflections that would make a long tail have nothing to bounce between. Two early taps
   * rather than Foundry's four, both quiet, because a street gives you the wall opposite
   * and then nothing.
   */
  reverb: {
    seconds: 0.85,
    decay: 3.4,
    brightness: 0.9,
    earlyTaps: [
      { delay: 0.013, gain: 0.24 },
      { delay: 0.031, gain: 0.13 },
    ],
  },
};
