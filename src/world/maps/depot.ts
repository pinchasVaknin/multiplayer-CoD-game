import {
  addBox,
  addProp,
  addSpan,
  addWallAlongX,
  rampAlongZ,
  rotateHalf,
  rotateHalfProps,
} from './build';
import { deriveCoverPoints, emitCoverPoint } from './cover';
import type { Brush, CoverPoint, LaneDef, MapDef, ObjectiveDef, PropDef, SpawnZone } from './types';

/**
 * MP_DEPOT — the second M8 map (brief S6.2).
 *
 * A cargo yard at night. **Verticality is the identity**: a good deal of the useful ground
 * on this map is off the ground, and the difference between Depot and the other two is that
 * you spend a match looking up as often as along.
 *
 * ## Three heights, and the rule that generated them
 *
 * ```
 *   5.20   the gantry bridge across the middle of the yard
 *   5.14   the tops of the two-high container stacks
 *   2.60   container roofs — the level the map is actually fought on
 *   0.00   the yard
 * ```
 *
 * Every step between them is **at or under `mantleMaxHeight` (1.6 m)**, which is not a
 * stylistic choice — it is the only rule that makes a height reachable at all. A container
 * roof is 2.6 m and cannot be mantled from the yard, so every stack that is meant to be
 * climbable carries a foot: a `pallets` at 0.9 m and a `crateTall` at 1.5 m against its
 * long face, giving 0 -> 1.5 -> 2.6. On a two-high stack a second `crateTall` sits on the
 * lower roof for 2.6 -> 4.1 -> 5.14. The two gantry stairs are the nav-legal alternative
 * for anyone, bot or player, who would rather walk.
 *
 * The bridge is at 5.20 against a stack's 5.14. The 0.06 m difference is deliberate: it is
 * far inside `stepHeight` so it links in both directions, and making them *equal* would
 * have put two walking surfaces at an identical height touching in plan, which is the
 * coplanar case this map exists to avoid.
 *
 * ## What the bots needed
 *
 * The M3 bake linked two cells only where the height difference was step-up (0.35 m) or
 * ground-snap (0.4 m), so none of the above existed as far as the AI was concerned: a bot
 * could see a container roof, be shot from it, and have no edge in its graph that reached
 * it. M8 adds two link classes and this map is why — **climb links**, which the brain
 * crosses by pressing jump, and **drop links**, which it crosses by walking off. They
 * arrive together on purpose: climb links alone would let a bot mantle onto a container and
 * then stand on it for the rest of the match, which is a worse bug than the one they fix.
 * `MapDef.navClimb` turns both on and only this map asks for them.
 *
 * A column here can hold the yard, a container roof and the bridge over both, so Depot
 * bakes **three** nav layers where the other maps bake two.
 *
 * ## Lanes are corridors, and they are kept clear on purpose
 *
 * `LANE_X` is the whole discipline. Every stack, leg, stair and shed door is placed against
 * those three numbers, because the first version of this map was authored by eye and the
 * harness measured a **109% lane spread** — one lane 27 m and another 57 m, because two
 * containers and a gantry leg happened to sit in them. A lane on this map is a 3 m corridor
 * nothing solid is allowed into; everything else can go anywhere.
 *
 * ## Night, and the two bugs it surfaces
 *
 * Lit by six mast lights and one weak moon key, which is the hard case for shadows:
 *
 * - **Acne** comes from a low-intensity key at a grazing angle across a big flat yard. The
 *   fix is the `normalBias` this map overrides upward (0.055 against Foundry's 0.035) —
 *   constant bias alone would have to be enormous to cover a grazing angle and would
 *   detach every shadow from the object casting it.
 * - **Z-fighting** comes from stacked containers, which is the one thing here there are
 *   dozens of. Every stacked placement is sunk 0.06 m into the one below, so the two faces
 *   that would have been coplanar sit inside solid geometry where neither can win a depth
 *   test. The rule the prop catalogue has used since M4, applied to placements.
 *
 * Rotationally symmetric about the origin, except the two bomb sites and the four pitched
 * brushes (a pitched brush cannot be rotated by adding pi to its yaw — see `build.ts`).
 *
 * Convention: +X east, +Z south, Y up. Yard surface is y = 0.
 */

// ---- the numbers everything else is derived from --------------------------

const YARD_MIN_X = -30;
const YARD_MAX_X = 30;
const YARD_MIN_Z = -33;
const YARD_MAX_Z = 33;

/** Perimeter. 10 m, so the bridge at 5.2 cannot see over it. */
const SHELL_HEIGHT = 10;

/**
 * The three lane centre lines, and the half-width kept clear of solid geometry.
 *
 * 1.75 m against a 0.35 m capsule radius leaves 1.4 m of shoulder either side of a
 * perfectly centred run. See the file comment for what happens when this is not enforced.
 */
const LANE_X = 22;
const LANE_CLEAR = 1.75;

/** A shipping container, from `PROP_SHAPES.containerBlue`. */
const CONTAINER_H = 2.6;
/** How far a stacked container is sunk into the one below it. Anti-z-fighting. */
const STACK_SINK = 0.06;
/**
 * How far the upper box of a two-high stack is shifted along its own length.
 *
 * 2.8 m leaves a 2.8 x 2.5 ledge of exposed lower roof, which is the landing for the climb
 * up from the yard and the floor the second rung stands on. See `stackProps` for what
 * happened when this was zero.
 *
 * It was 2.5 first, and that was not enough: the second rung eats 1.1 m of the ledge and the
 * capsule needs 0.35 m of clearance from every edge, which left a strip one nav cell wide.
 * A landing one cell wide is a landing a bot arrives at by luck. At 2.8 the clear standing
 * area is about two cells by four.
 */
const STACK_OFFSET = 2.8;
/** Walking height of a single container roof. A two-high stack tops out at 5.14. */
const ROOF_1 = CONTAINER_H;

/**
 * Where the two ground rungs sit, measured from the container's centre line.
 *
 * A container is 2.5 m across (half 1.25), a `crateTall` is 1.1 (half 0.55) and a `pallets`
 * is 1.3 across (half 0.65). Both numbers are the sum of the two half-extents, so each rung
 * touches the thing before it — an 0.2 m gap put the crate and the container on opposite
 * sides of a nav cell boundary and the climb link came and went depending on where the grid
 * origin landed.
 */
const CRATE_STANDOFF = 1.25 + 0.55;
const PALLET_STANDOFF = CRATE_STANDOFF + 0.55 + 0.65;

/** The gantry bridge. See the file comment for why this is 5.2 and not 5.14. */
const DECK_TOP = 5.2;
const DECK_THICK = 0.32;
const DECK_HALF_W = 1.6;
/** How far the bridge reaches either side of the origin. */
const BRIDGE_HALF = 13;
/** Where the two stairs meet the bridge, and therefore where their landings are. */
const STAIR_X = 11;
const STAIR_FOOT_Z = 13;
const STAIR_THICK = 0.6;

/** The two sheds. Mirrored by `rotateHalf`, so this describes the west one. */
const SHED_X0 = -29;
const SHED_X1 = -14;
const SHED_HZ = 7;
const SHED_TOP = 6.0;
/** Loading dock inside the shed: the map's one raised surface you simply walk onto. */
const DOCK_H = 1.2;

export const DEPOT_LANES: readonly LaneDef[] = [
  {
    name: 'WEST',
    center: { x: -LANE_X, y: 0, z: 0 },
    a: { x: -LANE_X, y: 0.05, z: 27 },
    b: { x: -LANE_X, y: 0.05, z: -27 },
  },
  {
    name: 'CENTRE',
    center: { x: 0, y: 0, z: 0 },
    a: { x: 0, y: 0.05, z: 27 },
    b: { x: 0, y: 0.05, z: -27 },
  },
  {
    name: 'EAST',
    center: { x: LANE_X, y: 0, z: 0 },
    a: { x: LANE_X, y: 0.05, z: 27 },
    b: { x: LANE_X, y: 0.05, z: -27 },
  },
];

/**
 * The container stacks, listed once and consumed three times — by the placement pass, by
 * the climbing feet, and by the lane audit below. A stack that moves moves everywhere.
 *
 * `levels` is how many containers high. `climb` says whether this stack carries the foot
 * that makes its roof mantleable; a stack without one is cover and nothing else.
 *
 * Authored for the negative-Z half and rotated.
 */
interface StackDef {
  readonly x: number;
  readonly z: number;
  /** Radians. Zero runs the 6 m axis along X. */
  readonly yaw: number;
  readonly levels: 1 | 2;
  /**
   * Which of the container's two 2.5 m faces carries the climbing ladder, or 0 for none.
   *
   * A sign rather than a boolean because the first version derived the side from the yaw
   * alone and put two ladders inside the perimeter wall — the stack against the west fence
   * has only one face with three metres of yard in front of it, and it is not the one the
   * arithmetic chose.
   */
  readonly climb: -1 | 0 | 1;
  /**
   * Which way along its own length the upper box of a two-high stack is shifted, and
   * therefore which end of the lower roof is left exposed. Ignored on a one-high stack.
   *
   * Explicit for the same reason `climb` is: derived from the geometry it walked a
   * container into a lane, and the lane audit caught it. Both signs are authored and both
   * are checked.
   */
  readonly shift: -1 | 1;
}

const H = Math.PI / 2;

const STACKS: readonly StackDef[] = [
  // West side: a spine against the perimeter, and one across the mouth of the yard.
  { x: -27, z: -20, yaw: H, levels: 2, climb: 0, shift: -1 },
  { x: -16, z: -25, yaw: 0, levels: 2, climb: -1, shift: 1 },
  { x: -13, z: -29.5, yaw: 0, levels: 1, climb: 0, shift: -1 },
  // Centre: the two that matter, because one of them abuts the bridge.
  { x: -8, z: -12, yaw: H, levels: 2, climb: 1, shift: -1 },
  { x: -6, z: -2.85, yaw: 0, levels: 2, climb: -1, shift: -1 },
  { x: 6, z: -20, yaw: 0, levels: 1, climb: 0, shift: -1 },
  // East side.
  { x: 17, z: -10, yaw: 0, levels: 2, climb: 1, shift: -1 },
  { x: 13, z: -30, yaw: H, levels: 1, climb: 0, shift: -1 },
  { x: 26.5, z: -28, yaw: H, levels: 1, climb: 0, shift: -1 },
];

/** Where the exposed ledge of a two-high stack is, in its own frame. */
function exposedAlong(s: StackDef): number {
  return s.levels === 2 ? -s.shift * 2.0 : 1.6;
}

// ---- geometry -------------------------------------------------------------

/** Yard surface and the perimeter. */
function shell(): Brush[] {
  const out: Brush[] = [];

  addSpan(out, 'asphalt', YARD_MIN_X, YARD_MAX_X, -1, 0, YARD_MIN_Z, YARD_MAX_Z);

  // Sunk 0.2 m so no downward face sits on the yard plane.
  addSpan(out, 'concreteDark', YARD_MIN_X - 1, YARD_MAX_X + 1, -0.2, SHELL_HEIGHT, YARD_MIN_Z - 1, YARD_MIN_Z);
  addSpan(out, 'concreteDark', YARD_MIN_X - 1, YARD_MAX_X + 1, -0.2, SHELL_HEIGHT, YARD_MAX_Z, YARD_MAX_Z + 1);
  addSpan(out, 'concreteDark', YARD_MIN_X - 1, YARD_MIN_X, -0.2, SHELL_HEIGHT, YARD_MIN_Z, YARD_MAX_Z);
  addSpan(out, 'concreteDark', YARD_MAX_X, YARD_MAX_X + 1, -0.2, SHELL_HEIGHT, YARD_MIN_Z, YARD_MAX_Z);

  return out;
}

/**
 * The west shed, and its loading dock.
 *
 * A roofed volume rather than another stack, so the map has one place that is genuinely
 * interior — somewhere a UAV contact means "he is in the shed" rather than "he is over
 * there". The **west lane runs straight through it**, in one roller door and out the other,
 * which is what makes an interior a lane feature instead of a side room.
 *
 * The east face is open across its middle: eight metres of loading front onto the yard, so
 * the shed has a wide mouth and a narrow through-route rather than four identical doors.
 */
function shed(): Brush[] {
  const out: Brush[] = [];
  const y0 = -0.15;
  // The lane door is centred on the lane. The second one is offset so the two faces are
  // not a symmetrical pair of holes.
  const doors = [
    [-LANE_X - 2, -LANE_X + 2],
    [-18, -15.5],
  ] as const;

  addWallAlongX(out, 'paintedSteel', SHED_X0, SHED_X1, y0, SHED_TOP, -SHED_HZ, -SHED_HZ + 0.5, doors);
  addWallAlongX(out, 'paintedSteel', SHED_X0, SHED_X1, y0, SHED_TOP, SHED_HZ - 0.5, SHED_HZ, doors);
  addSpan(out, 'paintedSteel', SHED_X0, SHED_X0 + 0.5, y0, SHED_TOP, -SHED_HZ + 0.5, SHED_HZ - 0.5);
  // East face: two jambs with an 8 m loading front between them.
  addSpan(out, 'paintedSteel', SHED_X1 - 0.5, SHED_X1, y0, SHED_TOP, -SHED_HZ + 0.5, -4);
  addSpan(out, 'paintedSteel', SHED_X1 - 0.5, SHED_X1, y0, SHED_TOP, 4, SHED_HZ - 0.5);

  // Roof in two slabs with a 2 m light slot: an interior lit only by the hemisphere on a
  // night map is a black box you cannot fight in, and a slot costs nothing.
  addSpan(out, 'metal', SHED_X0 - 0.4, SHED_X1 + 0.4, SHED_TOP - 0.35, SHED_TOP, -SHED_HZ - 0.4, -1.0);
  addSpan(out, 'metal', SHED_X0 - 0.4, SHED_X1 + 0.4, SHED_TOP - 0.35, SHED_TOP, 1.0, SHED_HZ + 0.4);

  // Dock: a 1.2 m platform along the shed's blind wall, clear of the lane corridor.
  addSpan(out, 'concrete', SHED_X0 + 0.5, -24.5, y0, DOCK_H, -SHED_HZ + 0.5, -1);
  addSpan(out, 'hazard', SHED_X0 + 0.5, -24.5, DOCK_H, DOCK_H + 0.06, -1.3, -1, { solid: false, shadows: false });

  return out;
}

/**
 * The gantry: a bridge at 5.2 m straight across the middle of the yard, with a stair down
 * into each half.
 *
 * Level with a two-high stack by construction, so stepping from the bridge onto a stack top
 * is an ordinary navmesh link with no special case at all — which is what makes the *upper*
 * level a connected space rather than a set of islands.
 *
 * **Deliberately no railings**, exactly as Foundry's catwalk has none. Dropping off is a
 * route, and an open edge is one fewer 0.12 m ledge for the bake to call walkable.
 */
function gantry(): Brush[] {
  const out: Brush[] = [];
  const d0 = DECK_TOP - DECK_THICK;

  addSpan(out, 'grate', -BRIDGE_HALF, BRIDGE_HALF, d0, DECK_TOP, -DECK_HALF_W, DECK_HALF_W);

  // Legs. Placed at +/-STAIR_X so each stair lands on its own support, and nowhere near a
  // lane centre line — a leg in a lane was one of the two things that broke the timings.
  for (const lx of [-STAIR_X, STAIR_X]) {
    addBox(out, 'metal', lx, 0.9, 0, 0.5, 1.8, 0.5);
    addBox(out, 'metal', lx, 3.5, 0, 0.36, 3.4, 0.36, { solid: false, shadows: false });
  }

  return out;
}

/**
 * The four pitched brushes: two gantry stairs and two dock ramps, authored per side.
 *
 * Both land exactly on the surface they serve. A gap of even 0.2 m between two walking
 * surfaces is a hole to fall through, so each is defined by the two ends of its walking
 * surface rather than by an angle and an offset.
 */
function pitched(): Brush[] {
  const out: Brush[] = [];

  // Gantry stairs. 5.2 m over 11.4 m is 24.5 deg, inside the 46 deg limit.
  rampAlongZ(out, 'grate', -STAIR_FOOT_Z, 0, -DECK_HALF_W, DECK_TOP, -STAIR_X, DECK_HALF_W * 2, STAIR_THICK);
  rampAlongZ(out, 'grate', STAIR_FOOT_Z, 0, DECK_HALF_W, DECK_TOP, STAIR_X, DECK_HALF_W * 2, STAIR_THICK);

  // Dock ramps, inside each shed. 1.2 m over 3 m.
  rampAlongZ(out, 'concrete', 2, 0, -1, DOCK_H, -26.5, 3.4, 0.5);
  rampAlongZ(out, 'concrete', -2, 0, 1, DOCK_H, 26.5, 3.4, 0.5);

  return out;
}

/** Non-solid trim: painted bay markings and the bridge edge line. */
function trimHalf(): Brush[] {
  const out: Brush[] = [];
  const flat = { solid: false, shadows: false } as const;

  for (const z of [-26, -18, -10]) {
    addSpan(out, 'accent', -12, 12, 0.02, 0.06, z - 0.1, z + 0.1, flat);
  }
  addSpan(out, 'hazard', -LANE_X - 0.1, -LANE_X + 0.1, 0.03, 0.07, -28, -8, flat);
  addSpan(out, 'accent', -BRIDGE_HALF, BRIDGE_HALF, DECK_TOP + 0.01, DECK_TOP + 0.05, -DECK_HALF_W - 0.08, -DECK_HALF_W + 0.02, flat);
  return out;
}

// ---- props ----------------------------------------------------------------

/**
 * A point in a stack's local frame, in world space.
 *
 * `along` runs the container's 6 m axis, `across` its 2.5 m one. Same basis the prop mesher
 * uses for part offsets, so a number here means the same thing it would mean in
 * `PROP_SHAPES`.
 */
function local(s: StackDef, along: number, across: number): { x: number; z: number } {
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  return { x: s.x + along * c + across * sn, z: s.z - along * sn + across * c };
}

/**
 * Containers: the boxes that are cover.
 *
 * **The upper box of a two-high stack is shifted `STACK_OFFSET` along its own length.** That
 * is the single most load-bearing number on this map and it was found by measurement: with
 * the upper container squarely on the lower one the two share a footprint exactly, so the
 * lower roof is covered along its whole length, has no standing headroom anywhere, and never
 * becomes a navmesh node. The bake said so plainly — **every upper layer on the map came out
 * empty after the reachability prune**, nine bots spent a fifty-eight second match on the
 * ground, and the verticality this map exists for did not exist.
 *
 * Offsetting the upper box leaves a 2.5 m ledge at 2.6 m, which is the landing for the climb
 * from the yard and the floor the second rung stands on. It also stops a stack reading as one
 * five-metre monolith, which is a real improvement, but that is not why it is there.
 */
function stackProps(): PropDef[] {
  const out: PropDef[] = [];
  for (const s of STACKS) {
    out.push({ shape: 'containerBlue', position: { x: s.x, y: 0, z: s.z }, rotationY: s.yaw });
    if (s.levels === 2) {
      const p = local(s, s.shift * STACK_OFFSET, 0);
      out.push({
        shape: 'containerBlue',
        position: { x: p.x, y: CONTAINER_H - STACK_SINK, z: p.z },
        rotationY: s.yaw,
      });
    }
  }
  return out;
}

/**
 * The climbing ladders: the rungs that make a marked stack reachable.
 *
 * **Kept separate from `stackProps` because they are not cover and must not derive any.**
 * A `crateTall` pressed against a container has one useful face and three that point into
 * solid steel, and `deriveCoverPoints` cannot tell the difference — it emitted all four,
 * the navmesh correctly refused three, and the rejection count went to 67 of 270. A rung is
 * a rung; it goes in `props` so it renders and collides, and nowhere near the cover pass.
 *
 * The ladder is offset **1.6 m along the container's long axis** rather than centred on its
 * face, so the container's own cover point — which sits at the middle of that face — is
 * still standable. Two objects competing for one square metre is how you lose a cover point
 * to a feature that was meant to add one.
 */
function ladderProps(): PropDef[] {
  const out: PropDef[] = [];

  for (const s of STACKS) {
    if (s.climb === 0) continue;
    // Rungs sit toward the end of the stack whose roof is exposed, so the mantle off the
    // first rung lands on open deck rather than on the underside of the upper box.
    const along = exposedAlong(s);

    // Touching, not merely near. At a 0.2 m gap the crate and the container fell either
    // side of a 0.5 m nav cell boundary and the climb link was a coin toss.
    const rung1 = local(s, along, s.climb * CRATE_STANDOFF);
    out.push({ shape: 'crateTall', position: { x: rung1.x, y: 0, z: rung1.z }, rotationY: s.yaw });

    const foot = local(s, along, s.climb * PALLET_STANDOFF);
    out.push({ shape: 'pallets', position: { x: foot.x, y: 0, z: foot.z }, rotationY: s.yaw });

    if (s.levels === 2) {
      // The second rung stands on the exposed lower roof, against the upper box's end
      // face: 2.6 -> 4.1 -> 5.14, both steps inside the 1.6 m mantle window.
      const rung2 = local(s, -s.shift * (3.0 - STACK_OFFSET + 0.55), 0);
      out.push({ shape: 'crateTall', position: { x: rung2.x, y: ROOF_1, z: rung2.z }, rotationY: s.yaw });
    }
  }
  return out;
}

/** Everything that is not a container, for the negative-Z half. */
function propsHalf(): PropDef[] {
  const out: PropDef[] = [];

  addProp(out, 'forklift', -12.0, -24.0, 0.4);
  addProp(out, 'forklift', 9.5, -14.5, -1.1);
  addProp(out, 'pallets', -19.5, -17.0, 0.2);
  addProp(out, 'pallets', 11.5, -25.0, 0);
  addProp(out, 'pallets', -26.5, -4.5, 0.5);
  addProp(out, 'barrels', -27.0, -31.0, 0);
  addProp(out, 'barrels', 3.5, -8.0, 0.3);
  addProp(out, 'barrels', 18.5, -21.0, 0);
  addProp(out, 'crate', -4.5, -26.0, 0.3);
  addProp(out, 'crate', 27.5, -12.0, 0.1);
  addProp(out, 'crateTall', -17.0, -3.5, 0);
  addProp(out, 'spool', 8.0, -31.0, 0.2);
  addProp(out, 'girder', -10.5, -6.0, 0);

  return out;
}

const MAST_POSITIONS: readonly Readonly<{ x: number; z: number; yaw: number }>[] = [
  { x: -28, z: -24, yaw: -H },
  { x: 28, z: 24, yaw: H },
  { x: -9, z: -31, yaw: Math.PI },
  { x: 9, z: 31, yaw: 0 },
  { x: 4, z: -5, yaw: 0 },
  { x: -4, z: 5, yaw: Math.PI },
];

/**
 * The six mast lights, placed exactly where the map's `point` lights are.
 *
 * A pooled light with no visible source reads as a bug at night, so every light in the def
 * below hangs off one of these: the mast head is at 8.1 m and the light sits at 8.0 m.
 */
function masts(): PropDef[] {
  return MAST_POSITIONS.map((p) => ({
    shape: 'lightMast' as const,
    position: { x: p.x, y: 0, z: p.z },
    rotationY: p.yaw,
  }));
}

// ---- cover, spawns, objectives --------------------------------------------

/**
 * Cover, derived from the placements, plus the points that have no placement to derive
 * from.
 *
 * A two-high stack's upper box is a placement at y = 2.54, so `deriveCoverPoints` already
 * emits its faces at that height and `ai/Cover.ts` resolves them against the layered
 * navmesh — the roof level gets its cover for free, which is the payoff for stacking with
 * placements rather than with brushes. What has to be emitted by hand is the bridge, whose
 * only hard cover is its two legs, and the dock's blind wall.
 */
function coverPoints(placements: readonly PropDef[]): CoverPoint[] {
  const out = deriveCoverPoints(placements);

  for (const lx of [-STAIR_X, STAIR_X]) {
    for (const sign of [-1, 1]) {
      emitCoverPoint(out, lx, 0, 0, 0, sign, 0.25, 'low', DECK_TOP);
      emitCoverPoint(out, lx, 0, 0, 0, sign, 0.25, 'low');
    }
  }

  // The two docks: standing cover on a raised surface, which nothing else here offers.
  emitCoverPoint(out, -26.5, -4, 0, 1, 0, 0.4, 'low', DOCK_H);
  emitCoverPoint(out, 26.5, 4, 0, -1, 0, 0.4, 'low', DOCK_H);

  /**
   * Cover **on** the container roofs, which is the thing that gives a bot a reason to be up
   * there at all.
   *
   * `deriveCoverPoints` cannot produce these. It emits a point per offered face at the
   * placement's own height, so the upper box of a two-high stack contributes two points
   * hanging in mid-air 2.54 m above open yard — and `ai/Cover.ts`, asking for the walkable
   * surface nearest that height, resolves them harmlessly down to the ground. Correct, and
   * useless: it left Depot with four elevated slots on a map whose whole argument is
   * elevation.
   *
   * What is actually cover up there is the *end face of the upper box*, with the exposed
   * ledge in front of it. That is a real crouch-behind-a-container-end position 2.6 m up,
   * and it exists once per climbable stack, on both halves of the map.
   */
  for (const s of STACKS) {
    if (s.levels !== 2) continue;
    const ledge = local(s, -s.shift * 2.6, 0);
    // Facing back along the stack, i.e. through the upper box.
    const fx = Math.cos(s.yaw) * s.shift;
    const fz = -Math.sin(s.yaw) * s.shift;
    for (const sign of [1, -1]) {
      emitCoverPoint(out, sign * ledge.x, sign * ledge.z, 0, sign * fx, sign * fz, 0.1, 'low', ROOF_1);
    }
  }

  return out;
}

/**
 * Spawn zones (brief S6.9).
 *
 * Three at the mouth of each lane, two wide, two on the flip side past the centre line.
 * All at ground level: a spawn on the bridge would put a player five metres up with two
 * exits and every sight line on the map running through them, which is a spawn trap with
 * extra steps.
 */
function spawnHalf(): SpawnZone[] {
  const a: SpawnZone[] = [];
  const put = (x: number, z: number, radius: number): void => {
    a.push({ team: 'A', position: { x, y: 0.05, z }, facingYaw: 0, radius });
  };

  put(-LANE_X, 28, 3.0);
  put(0, 29, 3.0);
  put(LANE_X, 28, 3.0);
  put(-28, 19, 2.4);
  put(28, 19, 2.4);
  put(-11, 22, 2.0);
  put(11, 22, 2.0);
  // Flip side: past the centre line, inside the enemy-side shed.
  put(-27.5, 4, 2.0);
  put(27.5, -4, 2.0);

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
 * Flag B sits **under** the bridge rather than on it. A capture point on the upper level
 * would be a point only the team that already owns the gantry can contest, and the gantry
 * is the strongest position on the map; putting B underneath makes holding it useful for
 * *defending* the flag and useless for taking it. A and C are the two shed interiors,
 * which is the other thing this map has that the others do not.
 */
function objectives(): ObjectiveDef[] {
  return [
    { id: 'dom_a', kind: 'flag', label: 'A', position: { x: -LANE_X, y: 0, z: 0 }, radius: 4 },
    { id: 'dom_b', kind: 'flag', label: 'B', position: { x: 0, y: 0, z: 0 }, radius: 4.5 },
    { id: 'dom_c', kind: 'flag', label: 'C', position: { x: LANE_X, y: 0, z: 0 }, radius: 4 },
    { id: 'snd_a', kind: 'bombsite', label: 'A', position: { x: -16, y: 0, z: -20 }, radius: 3.5 },
    { id: 'snd_b', kind: 'bombsite', label: 'B', position: { x: 10, y: 0, z: -12 }, radius: 3.5 },
  ];
}

// ---- assembly -------------------------------------------------------------

const SHED_BRUSHES = shed();
const TRIM_BRUSHES = trimHalf();
const HALF_PROPS = propsHalf();
const HALF_STACKS = stackProps();
const HALF_LADDERS = ladderProps();

/** Everything cover is derived from. Ladders and masts are deliberately not in it. */
const COVER_PROPS: PropDef[] = [
  ...HALF_PROPS,
  ...rotateHalfProps(HALF_PROPS),
  ...HALF_STACKS,
  ...rotateHalfProps(HALF_STACKS),
];

const ALL_PROPS: PropDef[] = [
  ...COVER_PROPS,
  ...HALF_LADDERS,
  ...rotateHalfProps(HALF_LADDERS),
  ...masts(),
];

export const DEPOT_MAP: MapDef = {
  id: 'mp_depot',
  name: 'DEPOT',
  brushes: [
    ...shell(),
    ...SHED_BRUSHES,
    ...rotateHalf(SHED_BRUSHES),
    ...gantry(),
    ...pitched(),
    ...TRIM_BRUSHES,
    ...rotateHalf(TRIM_BRUSHES),
  ],
  props: ALL_PROPS,
  spawns: spawns(),
  lanes: DEPOT_LANES,

  /**
   * Night. One weak, cold, high key and six warm pools.
   *
   * The key is at 0.55 intensity and casts the only shadows: it exists so the yard has
   * *some* directional structure and so the stacks throw a silhouette, not so anything is
   * lit by it. Everything you can actually see by comes from the masts.
   *
   * **The shadow overrides are the point of this block.** A key this weak at this angle is
   * the acne case — the depth quantisation is unchanged but the lighting term is tiny, so
   * self-shadowing that is invisible at Foundry's 2.35 intensity becomes the brightest
   * thing in a dark frame. `normalBias` goes up rather than `bias`, because the artefact is
   * a grazing-angle one and a constant bias large enough to cover it detaches every shadow
   * from its object. `shadowRadius` comes down because a floodlit yard has hard shadows and
   * softening them is what makes a night map read as fog.
   */
  lights: [
    { kind: 'hemisphere', skyColor: 0x2c3646, groundColor: 0x14181f, intensity: 0.62 },
    {
      kind: 'directional',
      color: 0x9fb4d8,
      intensity: 0.55,
      direction: { x: -0.3, y: -0.88, z: -0.37 },
      castShadow: true,
      shadowExtent: 46,
      shadowRadius: 1.6,
      shadowBias: -0.0006,
      shadowNormalBias: 0.055,
    },
    ...MAST_POSITIONS.map(
      (p) =>
        ({
          kind: 'point',
          color: 0xffd39a,
          intensity: 90,
          position: { x: p.x, y: 8.0, z: p.z },
          distance: 30,
          decay: 2,
        }) as const,
    ),
  ],
  ambient: {
    skyColor: 0x2c3646,
    groundColor: 0x14181f,
    fogColor: 0x0d1016,
    fogNear: 38,
    fogFar: 120,
  },

  /** Cold haze rather than dust: it catches the mast pools and gives them a shape. */
  particulate: {
    count: 320,
    radius: 22,
    color: 0x9fb8d8,
    size: 0.045,
    opacity: 0.2,
    drift: { x: -0.2, y: 0.04, z: 0.35 },
  },

  coverPoints: coverPoints(COVER_PROPS),
  objectives: objectives(),
  navBounds: {
    min: { x: -32, y: -4, z: -35 },
    max: { x: 32, y: 14, z: 35 },
  },
  /** The yard, a container roof, and the bridge over both. See the file comment. */
  navLayers: 3,
  navClimb: true,

  /**
   * A steel yard: long, metallic, and with hard early reflections off the stacks.
   *
   * Nearly twice Foundry's tail and much brighter, because there is no roof to absorb
   * anything and everything the sound meets is a flat steel plate. Five early taps rather
   * than four — a container yard gives you slap after slap before the tail even starts.
   */
  reverb: {
    seconds: 3.1,
    decay: 1.5,
    brightness: 0.88,
    earlyTaps: [
      { delay: 0.016, gain: 0.58 },
      { delay: 0.028, gain: 0.44 },
      { delay: 0.045, gain: 0.33 },
      { delay: 0.072, gain: 0.22 },
      { delay: 0.108, gain: 0.14 },
    ],
  },
};

/**
 * The lane audit, run at module load.
 *
 * The 109% spread this map first measured was caused by two containers and a gantry leg
 * sitting inside lane corridors, and it was found by a harness that has to be started, on a
 * map that has to be loaded. This catches the same class of mistake at import time, which
 * is where an authoring error belongs — a stack nudged into a lane during tuning throws
 * with the offending id rather than quietly costing four seconds.
 *
 * Stacks only. Props are small, movable and mostly *meant* to be in the way; a 6 m
 * container is neither.
 */
function auditLanes(): void {
  const lanes = [-LANE_X, 0, LANE_X];
  const check = (label: string, cx: number, hx: number): void => {
    for (const lane of lanes) {
      // Both the authored box and its rotated twin, which is at -x.
      for (const x of [cx, -cx]) {
        if (Math.abs(x - lane) < hx + LANE_CLEAR) {
          throw new Error(
            `[Depot] ${label} intrudes on the lane at x=${lane}. ` +
              `Lanes are ${LANE_CLEAR * 2} m corridors; see the file comment.`,
          );
        }
      }
    }
  };

  for (const s of STACKS) {
    // Half-extent along world X: 3.0 for a container lying along X, 1.25 across it.
    const alongX = Math.abs(Math.cos(s.yaw)) > 0.5;
    const hx = alongX ? 3.0 : 1.25;
    check(`stack at (${s.x}, ${s.z})`, s.x, hx);
    if (s.levels === 2) {
      // The upper box is shifted along its own length, which moves it in world X only when
      // that length runs along X. Checked separately because the shift is exactly the kind
      // of change that quietly walks a container into a lane.
      const upper = local(s, s.shift * STACK_OFFSET, 0);
      check(`upper box of the stack at (${s.x}, ${s.z})`, upper.x, hx);
    }
    if (s.climb !== 0) {
      // The pallet is the outermost rung and the one most likely to reach a lane.
      const foot = local(s, exposedAlong(s), s.climb * PALLET_STANDOFF);
      check(`ladder foot of the stack at (${s.x}, ${s.z})`, foot.x, alongX ? 0.65 : 0.8);
    }
  }
}

auditLanes();
