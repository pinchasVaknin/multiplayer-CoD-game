import { deriveCoverPoints, emitCoverPoint } from './cover';
import type { Brush, CoverPoint, MapDef, PropDef, SpawnZone } from './types';

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

/** Mirrors `combat/TargetRange.FIRING_LINE.x`. The range measures from here. */
const FIRING_LINE_X = -20;

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

  /**
   * The accuracy wall is gone (round 2 playtest).
   *
   * M7 put a 7.2 x 4.2 m metal face at a round 25 m for one job: empty a magazine into it and
   * look at the group. The job is real. The face was in the wrong room.
   *
   * It stood at `x = 5` spanning `z = -15.6 .. -8.4`, which is *across the measurement lane*.
   * From the firing line at (-20, -14) — the one place the range is laid out to be used from
   * — it blocked the penetration bay at 42 m, the 40 m dummy, and every bullseye behind it,
   * which is verbatim the report: "a giant, irrelevant wall blocking the line of sight". It
   * also crossed the `z = -9.6` bay divider, so two solid brushes intersected, and its
   * underside sat exactly on `y = 0` against a floor whose top face is exactly `y = 0` —
   * both of which this file's own header forbids, and both of which are z-fighting.
   *
   * It is removed rather than relocated, and the reason is arithmetic rather than taste: a
   * 7.2 m face has 3.6 m of half-width, and at 25 m in a room this size there is no lateral
   * offset that does not shadow the penetration bay, the 40 m dummy or the bullseyes. A
   * target that big does not fit in this range alongside everything else that is already in
   * it. The bullseyes below do the same job with scoring rings on them, which is strictly
   * more information than a blank plate gives.
   */

  /**
   * Bullseye plates at 10, 16 and 22 m (M7 playtest; re-laid out post-M8 and again in round 2).
   *
   * Three concentric rings each, drawn as flat plates proud of a backing board. Rings rather
   * than a solid disc because a group is read by *where it sits in the scoring rings*, which
   * is the whole reason a bullseye looks like a bullseye — a plain square tells you the shots
   * landed but not how well.
   *
   * ## What M7 got wrong, and what post-M8 got wrong fixing it
   *
   * **M7: they were in a line.** All three sat at `z = -16.4`, so the 10 m board stood
   * squarely in front of the other two and the far ones were unusable.
   *
   * **M7: no decals landed on them.** The rings were `solid: false`, so a round passed
   * straight through every one and stopped on the backing board, where the decal was placed
   * behind the ring that was supposed to be showing it. The rings are solid now.
   *
   * **M7: their faces were coplanar.** 2 cm plates spaced 2 cm apart touch exactly, which is
   * the textbook depth fight. `RING_GAP` puts an air gap between every pair.
   *
   * **Post-M8 fanned them into the north wall.** The fix for the first item chose laterals
   * of -4.6 and -3.6, which put the boards' centres at `z = -18.6` and `-17.6`. The north
   * wall's interior face is at `z = -18` and a board is 2 m wide, so the 10 m board was
   * entirely inside the wall and the 16 m board was half inside it — reported as "targets
   * spawning completely inside the left wall", and the visible half of each was a plate
   * interpenetrating a wall, which is also where a good deal of the remaining jitter was
   * coming from. Fanning is correct; fanning without a bound is not.
   *
   * ## The bound, in round 2
   *
   * There are four separate claims on the lateral space at these ranges and the boards get
   * what is left:
   *
   *  - the **north wall** at `z = -18`, so a board's near edge stops at `z = -17.4`;
   *  - the corridor from the firing line to the two **penetration dummies** at 42.5 m;
   *  - the corridor to the **40 m dummy**;
   *  - and each other's **shadow cone** — a board of half-width `w` at range `r` hides a band
   *    of half-width `w · R/r` centred on `lateral · R/r` at every range `R` beyond it.
   *
   * Three 2 m boards do not fit in what remains, which is why the post-M8 pass ended up in
   * the wall: the free band on the north side is about 2 m wide and three boards fanned
   * across it shadow each other. So the boards are **1.4 m** rather than 2 m, and the rings
   * scale with them. That is the trade, stated plainly: a smaller face, in exchange for three
   * boards that are all simultaneously visible, all in open air, and none of which is
   * standing in front of anything else in the room.
   */
  const BULLSEYE_RANGES = [10, 16, 22] as const;
  /** Metres off the firing line's own `z`, per range. See the bound above. */
  const BULLSEYE_LATERALS = [-2.7, -2.0, -0.85] as const;
  /** Board face, metres. Narrowed from 2.0 in round 2 so three of them fan without shadowing. */
  const BOARD_WIDTH = 1.4;
  const BOARD_HEIGHT = 1.6;
  const BOARD_Y = 1.5;
  /** Plate thickness and the air gap between consecutive plates, metres. */
  const RING_THICK = 0.02;
  const RING_GAP = 0.01;
  /** Ring faces, outermost first. Sized to sit inside `BOARD_WIDTH` with a margin. */
  const RING_SIZES = [1.14, 0.74, 0.38, 0.12] as const;
  const RING_MATERIALS = ['concrete', 'hazard', 'concrete', 'accent'] as const;
  for (let i = 0; i < BULLSEYE_RANGES.length; i++) {
    const range = BULLSEYE_RANGES[i] ?? 10;
    const lateral = BULLSEYE_LATERALS[i] ?? 0;
    // Solved so the straight-line distance is the stated range, exactly as `TargetRange`
    // solves its measured dummies. A board marked 22 m that is really 22.3 m makes the
    // number on it a lie.
    const bx = FIRING_LINE_X + Math.sqrt(Math.max(0, range * range - lateral * lateral));
    const bz = -14 + lateral;
    // Backing board.
    add('concreteDark', bx, BOARD_Y, bz, 0.3, BOARD_HEIGHT, BOARD_WIDTH);
    // Rings, outermost first. Each sits one thickness plus a gap in front of the last, so
    // consecutive plates never share a face and a decal on one is never buried in the next.
    const pitch = RING_THICK + RING_GAP;
    const face = 0.15 + RING_GAP;
    for (let r = 0; r < RING_SIZES.length; r++) {
      const size = RING_SIZES[r] ?? 0.1;
      const material = RING_MATERIALS[r] ?? 'concrete';
      add(material, bx - face - pitch * r, BOARD_Y, bz, RING_THICK, size, size, { shadows: false });
    }
  }

  /**
   * Bay dividers.
   *
   * Waist-high so the three areas read as separate places without turning the room into a
   * maze or blocking a stray round from reaching the wall behind it. The range is one room
   * with three jobs, and the jobs should not be able to interfere with each other's targets.
   *
   * Two round-2 changes, both measured against the real collision world:
   *
   * **Sunk 10 cm below the floor.** Their undersides were at exactly `y = 0` against a floor
   * whose top face is at exactly `y = 0` — the coplanar case this file's header rules out and
   * every other floor-sitting brush here already respects.
   *
   * **1.2 m -> 0.9 m.** At 1.2 m they were not dividing the bays, they were hiding them: a
   * sightline from the firing line's eye height to a drill-bay target crosses `z = -9.6` at
   * about 45% of the way there, so a 1.2 m divider cut everything below the target's chest.
   * Every mover in the drill bay was a torso. 0.9 m still reads unmistakably as a boundary
   * and every target in the room is now whole from the firing line.
   */
  add('concreteDark', FIRING_LINE_X + 13, 0.4, -9.6, 30, 1.0, 0.4);
  add('concreteDark', FIRING_LINE_X + 13, 0.4, -1.2, 30, 1.0, 0.4);

  /**
   * Lane markers: a stripe on the floor every five metres out to thirty.
   *
   * Non-solid and raised 1 cm, the same treatment M1 gave the firing line. Reading a group at
   * "about twenty metres" is not a measurement; the stripes are what make the range's numbers
   * mean something.
   */
  for (let range = 5; range <= 30; range += 5) {
    add('accent', FIRING_LINE_X + range, 0.01, -14, 0.12, 0.02, 9, { solid: false, shadows: false });
  }

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
  //
  // The two side strips stop short of the ends rather than running the full 6.4 m (round 2).
  // At full length all four strips shared the same 0.01-0.05 m slab and crossed at the pit's
  // four corners, so each corner was a quarter of a square metre of *exactly* coincident top
  // face — the one flicker case no depth precision can help with, on the floor, at the one
  // piece of geometry in this room the player is meant to walk carefully around.
  add('hazard', 9, 0.03, 1.9, 6.4, 0.04, 0.25, { solid: false, shadows: false });
  add('hazard', 9, 0.03, 8.1, 6.4, 0.04, 0.25, { solid: false, shadows: false });
  add('hazard', 6.1, 0.03, 5, 0.25, 0.04, 5.8, { solid: false, shadows: false });
  add('hazard', 11.9, 0.03, 5, 0.25, 0.04, 5.8, { solid: false, shadows: false });

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
  // Was (-13, -6), which is inside the drill bay and squarely between the firing line and
  // both the pop-up and the 8 m faller — a 1.5 m box hiding the two targets the bay exists
  // for. Moved to the open floor west of the ramp (round 2).
  put('crateTall', -15.5, 10, 0.5);

  // 1.0 m barriers: vault height, and cover for M3's bots.
  //
  // Two of the four moved south in round 2. (8, -8) stood in the sightline from the firing
  // line to the 40 m dummy and (-3, -9.5) in the one to the 24 m strafe target, so both were
  // cutting a target off at the knee from the only place the range is used from. They are
  // still four barriers and still bot cover; they are simply no longer in the lane.
  put('barrier', 8, -2.6, 0);
  put('barrier', 11, -8.6, 0.35);
  put('barrier', -6.5, 1.2, Math.PI / 2);
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
 * Cover (brief S6.5).
 *
 * M3 derived cover from the prop placements above rather than hand-listing sixty positions
 * that would rot the first time a crate moved, and kept the profile table in this file.
 * M4 moved the table and the generator to `maps/cover.ts` because a profile is a property
 * of the *shape*, not of the map placing it, and Foundry needed the same code. The numbers
 * are M3's unchanged, so this room derives exactly the cover it derived before.
 */
function coverPoints(placements: readonly PropDef[]): CoverPoint[] {
  const out = deriveCoverPoints(placements);

  // The two angled barricades and the penetration-bay panels are brushes rather than
  // props, so they are listed by hand — but they are the only four that are.
  emitCoverPoint(out, -4, 12, Math.PI / 6, 0, -1, 0.2, 'high');
  emitCoverPoint(out, -4, 12, Math.PI / 6, 0, 1, 0.2, 'high');
  emitCoverPoint(out, 4, 15, -Math.PI / 5, 0, -1, 0.2, 'high');
  emitCoverPoint(out, 4, 15, -Math.PI / 5, 0, 1, 0.2, 'high');
  emitCoverPoint(out, 17.5, -13.9, Math.PI / 2, 0, -1, 0.03, 'high');
  emitCoverPoint(out, 17.5, -13.9, Math.PI / 2, 0, 1, 0.03, 'high');
  emitCoverPoint(out, 17.5, -11.0, Math.PI / 2, 0, -1, 0.3, 'high');
  emitCoverPoint(out, 17.5, -11.0, Math.PI / 2, 0, 1, 0.3, 'high');

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
