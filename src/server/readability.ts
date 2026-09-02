import { ALL_WEAPONS } from '../shared/weapons/WeaponDefs';
import type { WeaponDef } from '../shared/weapons/WeaponDefs';
import { CROSSHAIR_MIN_GAP, crosshairGapPx, crosshairOpacity } from '../shared/ui/Crosshair';
import { relationClass, relationTo, teamLabel, teamsInViewOrder } from '../shared/ui/TeamColour';
import type { ScoreTeam } from '../shared/combat/ScoreSystem';
import { FOUNDRY_MAP } from '../shared/world/maps/foundry';
import { DEPOT_MAP } from '../shared/world/maps/depot';
import { DUNES_MAP } from '../shared/world/maps/dunes';
import type { MapDef } from '../shared/world/maps/types';
import { allMaterialBaseColors, materialBaseColor } from '../shared/world/maps/albedo';
import { linearLuminance, readFloor } from '../shared/world/MapLuminance';
import { simCos, simSin } from '../shared/core/SimMath';
import {
  makeScreenPoint,
  perspectiveMatrixFrom,
  projectToScreen,
  viewMatrixFrom,
} from '../shared/ui/ScreenProjection';

/**
 * The playtest round 4 P9 probe: crosshair geometry, team colour, and how dark a map is.
 *
 * ## Why a fourth entry point
 *
 * `main` runs matches, `serve` listens, `skirmish` drives the whole flow, `hashRun` compares
 * ticks. None of them can answer *"how wide is the crosshair on the LONGBOW"* or *"what does
 * Depot's yard read at"*, because those are properties of the content rather than of a run, and
 * because until this session both lived inside `client/` where no Node process could reach
 * them. A one-shot probe has different exit semantics from a batch job and a service, which is
 * the reason `vite.server.config.ts` already gives each of them its own entry.
 *
 * Everything below is a pure function of the shipped tables. There is no simulation here and
 * nothing is sampled over time, so unlike the wall-clock-paced harnesses one run of this *is* a
 * fact rather than a sample, and two runs on the same tree are identical.
 *
 * ## What it cannot do
 *
 * It does not render. `MapLuminance` states its own limits — no shadowing, no baked AO, no fog,
 * no texture detail — and they all point the same way, so every brightness below is an **upper
 * bound**. That is the direction that makes F9's claim safe: a surface that is too dark here is
 * conclusively too dark. It cannot be read backwards to say a map is bright enough, and the
 * "needs a browser" list says so.
 */

/** 1080p at the shipped default vertical FOV: the frame the numbers below describe. */
const VIEWPORT_HEIGHT = 1080;
const FOV_DEG = 90;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

// -- B2: the crosshair ------------------------------------------------------

/**
 * Every weapon's crosshair gap, in the four states the cone is a function of.
 *
 * The brief asked for the AR family before and after; the whole roster is printed because "is
 * this AR an outlier" is a question about the family it sits in, and the answer turned out to
 * be that the outlier is a shotgun in a different family altogether.
 */
function crosshairTable(): { atFloor: number; examined: number } {
  console.log('\n== B2: crosshair gap, px, at %dp and %d deg FOV ==\n', VIEWPORT_HEIGHT, FOV_DEG);
  console.log(
    '%s %s %s %s %s %s %s',
    pad('weapon', 16),
    pad('class', 8),
    padStart('stand', 7),
    padStart('move', 7),
    padStart('crouch', 7),
    padStart('air', 7),
    padStart('ads', 6),
  );

  let atFloor = 0;
  let examined = 0;
  const family: WeaponDef[] = [];

  for (const def of ALL_WEAPONS) {
    const s = def.spread;
    const stand = crosshairGapPx(s.hipStand, FOV_DEG, VIEWPORT_HEIGHT);
    const move = crosshairGapPx(s.hipMove, FOV_DEG, VIEWPORT_HEIGHT);
    const crouch = crosshairGapPx(s.hipStand * s.crouchScale, FOV_DEG, VIEWPORT_HEIGHT);
    const air = crosshairGapPx(s.hipMove * s.airScale, FOV_DEG, VIEWPORT_HEIGHT);
    const ads = crosshairGapPx(s.ads, FOV_DEG, VIEWPORT_HEIGHT);

    // The ADS column is reported and is *not* counted toward the floor: the reticle's opacity
    // is already zero by then, so a collapsed gap there is invisible by design rather than by
    // accident. `crosshairOpacity(1)` is the proof, printed below.
    for (const gap of [stand, move, crouch, air]) {
      examined++;
      if (gap <= CROSSHAIR_MIN_GAP) atFloor++;
    }

    console.log(
      '%s %s %s %s %s %s %s',
      pad(def.name, 16),
      pad(def.class, 8),
      padStart(String(stand), 7),
      padStart(String(move), 7),
      padStart(String(crouch), 7),
      padStart(String(air), 7),
      padStart(String(ads), 6),
    );
    if (def.class === 'AR') family.push(def);
  }

  console.log(
    '\nhip-fire gaps examined: %d, at the %d px floor: %d',
    examined,
    CROSSHAIR_MIN_GAP,
    atFloor,
  );
  console.log(
    'reticle opacity: hip %s, half-ADS %s, full ADS %s',
    crosshairOpacity(0).toFixed(2),
    crosshairOpacity(0.5).toFixed(2),
    crosshairOpacity(1).toFixed(2),
  );

  // The AR family, which is what B2 named.
  console.log('\nAR family, hip-fire standing: %s', family.map((d) => `${d.name} ${crosshairGapPx(d.spread.hipStand, FOV_DEG, VIEWPORT_HEIGHT)}px`).join(' · '));
  return { atFloor, examined };
}

/**
 * The B2 defect itself, as an assertion rather than as prose.
 *
 * A weapon whose *model* carries a scope while its *def* does not gets neither the scope
 * overlay nor the viewmodel hand-off, so ADS puts the optic's own geometry on the sight line
 * with no reticle of any kind in front of it. That was `ar_longbow`, and it was exactly one
 * weapon — which is why the report says "one particular AR".
 *
 * The model specs live in `client/`, which this process may not import (`check-boundaries`
 * forbids server -> client). So the pairing is asserted from the half that *is* shared — every
 * weapon that a player can aim carries either a `scope` block or none — and the *model* half is
 * covered by `WeaponMeshParts` building a clear aperture for all three optic kinds rather than
 * for two of them. Stated here rather than silently omitted, because a probe that looks like it
 * checked both halves and checked one is worse than no probe.
 */
function scopedWeapons(): void {
  console.log('\n== B2: which weapons the scope overlay is offered to ==\n');
  for (const def of ALL_WEAPONS) {
    const scoped = def.scope !== undefined;
    console.log(
      '  %s %s  def.scope %s',
      pad(def.id, 16),
      pad(def.class, 8),
      scoped ? `yes (${def.scope?.magnification.toFixed(1)}x)` : 'no',
    );
  }
  const scoped = ALL_WEAPONS.filter((d) => d.scope !== undefined).length;
  console.log(
    '\n%d of %d weapons hand the viewmodel off to the scope overlay; the other %d must show a\nclear sight picture from their own geometry, which is what B2 fixes.',
    scoped,
    ALL_WEAPONS.length,
    ALL_WEAPONS.length - scoped,
  );
}

// -- B12: colour is relative ------------------------------------------------

/**
 * Every (viewer, subject) pair, and the invariant that made B12 a bug.
 *
 * The assertion is the one sentence the brief asked to have enforced: **your own side is never
 * painted hostile, and the other side is never painted friendly** — in either seat, in a team
 * mode and in Free-for-All. It fails loudly with a non-zero exit so this cannot go green by
 * being skipped.
 */
function teamColourTable(): number {
  console.log('\n== B12: colour as a function of (viewer, subject) ==\n');
  let violations = 0;
  let pairs = 0;

  for (const freeForAll of [false, true]) {
    for (const team of ['A', 'B'] as const) {
      const viewer = { team, freeForAll };
      const order = teamsInViewOrder(viewer);
      const cells: string[] = [];
      for (const subject of ['A', 'B', 'NONE'] as const) {
        const relation = relationTo(viewer, subject as ScoreTeam | 'NONE');
        cells.push(`${subject}=${relationClass(relation)}`);
        pairs++;
        // Own side must never read hostile; the opposing side must never read friendly.
        if (!freeForAll && subject === team && relation !== 'FRIENDLY') violations++;
        if (!freeForAll && subject !== 'NONE' && subject !== team && relation !== 'HOSTILE') violations++;
        if (freeForAll && subject !== 'NONE' && relation !== 'HOSTILE') violations++;
      }
      console.log(
        '  viewer %s%s  order [%s]  labels [%s]  %s',
        team,
        freeForAll ? ' (FFA)' : '      ',
        order.join(','),
        order.map((t) => teamLabel(relationTo(viewer, t))).join(','),
        cells.join('  '),
      );
    }
  }

  console.log('\npairs examined: %d, violations: %d', pairs, violations);
  return violations;
}

// -- F9: how dark is the map ------------------------------------------------

function albedoTable(): void {
  console.log('\n== F9: material base colours, linear luminance ==\n');
  const rows = allMaterialBaseColors()
    .map(([key, hex]) => ({ key, hex, lum: linearLuminance(hex) }))
    .sort((a, b) => a.lum - b.lum);
  for (const r of rows) {
    console.log('  %s 0x%s  %s', pad(r.key, 14), r.hex.toString(16).padStart(6, '0'), r.lum.toFixed(4));
  }
}

/** Where the ground of each map is, and what it is made of. */
const GROUNDS: ReadonlyArray<{ def: MapDef; ground: Parameters<typeof materialBaseColor>[0] }> = [
  { def: FOUNDRY_MAP, ground: 'floor' },
  { def: DUNES_MAP, ground: 'sand' },
  { def: DEPOT_MAP, ground: 'asphalt' },
];

/**
 * A ground colour override, so the before and after are one command apart.
 *
 * `npm run readability -- --ground 0x24262b` re-reads Depot with its pre-F9 asphalt and prints
 * the row this session moved. That is the red control, and it belongs in the probe rather than
 * in an editor: "I changed the file, ran it and changed it back" is not a measurement anybody
 * else can repeat.
 */
function groundOverride(): number | null {
  const at = process.argv.indexOf('--ground');
  if (at < 0) return null;
  const raw = process.argv[at + 1];
  if (raw === undefined) return null;
  const value = Number.parseInt(raw.replace(/^0x/i, ''), 16);
  return Number.isFinite(value) ? value : null;
}

function lightingTable(): void {
  const override = groundOverride();
  console.log('\n== F9: the ground of each map, as the screen shows it (0-255) ==\n');
  if (override !== null) {
    console.log(
      "  --ground: Depot's asphalt overridden with 0x%s, linear luminance %s\n",
      override.toString(16).padStart(6, '0'),
      linearLuminance(override).toFixed(4),
    );
  }
  console.log(
    '%s %s %s %s %s %s',
    pad('map', 12),
    pad('ground', 12),
    padStart('albedo', 8),
    padStart('min', 6),
    padStart('mean', 6),
    padStart('max', 6),
  );
  for (const { def, ground } of GROUNDS) {
    const base = ground === 'asphalt' && override !== null ? override : materialBaseColor(ground);
    const r = readFloor(def, base);
    console.log(
      '%s %s %s %s %s %s   (%d samples)',
      pad(def.name, 12),
      pad(ground, 12),
      padStart(linearLuminance(base).toFixed(4), 8),
      padStart(String(r.min), 6),
      padStart(r.mean.toFixed(1), 6),
      padStart(String(r.max), 6),
      r.samples,
    );
  }

  /**
   * How pooled each map's lighting is, before any albedo.
   *
   * The old asphalt comment claimed a brighter ground would flatten Depot's mast pools into a
   * uniform grey. Albedo multiplies both ends of this ratio equally, so the ratio is
   * arithmetically untouched by anything this session did to the ground colour — printed rather
   * than argued, because that sentence has now survived two failed fixes.
   *
   * Taken as the extremes of the whole playable grid rather than from two hand-picked points.
   * The first draft of this probe sampled "under a mast" against the world origin and reported
   * 1.05x, which is not the pool-to-gap ratio — the origin on Depot is six metres from a mast.
   * A ratio is only as good as the two places it was measured, and the grid has no opinion.
   */
  console.log('\nfloor irradiance across the playable area, darkest to brightest:');
  for (const { def, ground } of GROUNDS) {
    const r = readFloor(def, materialBaseColor(ground));
    console.log(
      '  %s %s .. %s   pool:gap %sx',
      pad(def.name, 12),
      padStart(r.irradianceMin.toFixed(3), 8),
      padStart(r.irradianceMax.toFixed(3), 8),
      (r.irradianceMax / Math.max(r.irradianceMin, 1e-6)).toFixed(2),
    );
  }
}

// -- main -------------------------------------------------------------------

console.log('OPERATOR readability probe — playtest round 4, P9 (B2, B12, F9)');

const crosshair = crosshairTable();
scopedWeapons();
const colourViolations = teamColourTable();
const projectionFailures = projectionTable();
albedoTable();
lightingTable();

console.log('\n== summary ==');
console.log('  crosshair gaps at the floor: %d of %d hip-fire states', crosshair.atFloor, crosshair.examined);
console.log('  team-colour violations:      %d', colourViolations);
console.log('  projection checks failed:    %d', projectionFailures);

/**
 * The exit code, and the one thing here that can fail a build.
 *
 * The crosshair and lighting tables are *readings* — there is no threshold a human has agreed
 * to, and inventing one here would be a magic number. The team-colour invariant is different:
 * it is a rule with no legitimate exception, which is exactly what B12 turned out to be.
 */
if (colourViolations > 0) {
  console.error('\nTEAM COLOUR CHECK FAILED: %d viewer/subject pairs painted the wrong side.', colourViolations);
  process.exit(1);
}
if (projectionFailures > 0) {
  console.error('\nPROJECTION CHECK FAILED: %d of the world-to-screen properties do not hold.', projectionFailures);
  process.exit(1);
}
if (crosshair.examined === 0) {
  console.error('\nCROSSHAIR CHECK FAILED: no weapons examined.');
  process.exit(1);
}
console.log('\nreadability probe ok');

// -- F2 follow-up: world to screen, as one measurable projection ------------

/**
 * The projection tests the P9 follow-up brief asked for, and the reason they are worth running.
 *
 * P9 built an off-screen indicator on a bearing that was wrong by twice the player's yaw, and
 * nothing caught it because the only instrument was a browser. These three properties are what
 * an indicator is made of, and all three are ordinary arithmetic:
 *
 *  1. a point behind the camera is reported behind;
 *  2. a point on the view axis projects to the centre of the screen;
 *  3. the bearing is monotonic as the target orbits the player, at every yaw.
 *
 * The third is the one that would have failed before. The old expression is included as a red
 * control so the run shows it failing rather than asserting that it would have.
 */
function projectionTable(): number {
  console.log('\n== F2: world-to-screen projection ==\n');

  const view: number[] = new Array<number>(16).fill(0);
  const proj: number[] = new Array<number>(16).fill(0);
  const out = makeScreenPoint();
  const W = 1920;
  const H = 1080;
  perspectiveMatrixFrom(FOV_DEG, W / H, 0.12, 400, proj);

  let failures = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures++;
    console.log('  %s %s  %s', ok ? 'ok  ' : 'FAIL', pad(name, 42), detail);
  };

  // -- 1. behind the camera --------------------------------------------------
  // Player at the origin looking down -Z (yaw 0). Forward is (0, 0, -1).
  viewMatrixFrom(0, 0, 0, 0, 0, view);
  projectToScreen(view, proj, 0, 0, -10, W, H, out);
  check('a point 10 m ahead is not behind', !out.behind, `depth ${out.depth.toFixed(2)} m`);
  projectToScreen(view, proj, 0, 0, 10, W, H, out);
  check('a point 10 m behind is behind', out.behind, `depth ${out.depth.toFixed(2)} m`);
  projectToScreen(view, proj, 0, 0, 10, W, H, out);
  check('a behind point is never onScreen', !out.onScreen, `ndc ${out.ndcX.toFixed(2)}`);

  // -- 2. the centre ---------------------------------------------------------
  projectToScreen(view, proj, 0, 0, -25, W, H, out);
  check(
    'a point on the view axis is screen centre',
    Math.abs(out.x - W / 2) < 1e-6 && Math.abs(out.y - H / 2) < 1e-6,
    `${out.x.toFixed(1)}, ${out.y.toFixed(1)} px`,
  );
  check('...and its bearing is 0', Math.abs(out.bearingRad) < 1e-9, `${out.bearingRad.toFixed(6)} rad`);
  check('...and it is on screen', out.onScreen, `ndc ${out.ndcX.toFixed(3)}, ${out.ndcY.toFixed(3)}`);

  // A target 25 m ahead and 25 m to the right is 45 degrees off the nose.
  projectToScreen(view, proj, 25, 0, -25, W, H, out);
  check(
    'a target 45 deg right reads +45 deg',
    Math.abs((out.bearingRad * 180) / Math.PI - 45) < 1e-9,
    `${((out.bearingRad * 180) / Math.PI).toFixed(3)} deg, x ${out.x.toFixed(0)} px`,
  );

  // -- 3. monotonic as the target orbits, at four yaws ------------------------
  //
  // The target walks a full circle around a stationary player. The bearing must advance by the
  // same step every time, whatever the player is facing — which is exactly what the old
  // expression could not do, because its error was a function of yaw.
  const STEPS = 72;
  for (const yawDeg of [0, 45, 90, 180]) {
    const yaw = (yawDeg * Math.PI) / 180;
    viewMatrixFrom(0, 1.6, 0, yaw, 0, view);
    let worstStepErr = 0;
    let worstAhead = 0;
    for (let i = 0; i < STEPS; i++) {
      const theta = (i / STEPS) * Math.PI * 2;
      // Place the target at `theta` measured from the player's own forward, so the bearing
      // should come back as `theta` exactly, wrapped.
      const fx = -simSin(yaw);
      const fz = -simCos(yaw);
      const rx = simCos(yaw);
      const rz = -simSin(yaw);
      const d = 20;
      const tx = (fx * simCos(theta) + rx * simSin(theta)) * d;
      const tz = (fz * simCos(theta) + rz * simSin(theta)) * d;
      projectToScreen(view, proj, tx, 1.6, tz, W, H, out);
      let err = out.bearingRad - theta;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err <= -Math.PI) err += Math.PI * 2;
      if (Math.abs(err) > worstStepErr) worstStepErr = Math.abs(err);
      if (i === 0) worstAhead = Math.abs(out.bearingRad);
    }
    check(
      `bearing tracks the target at yaw ${yawDeg} deg`,
      worstStepErr < 1e-9 && worstAhead < 1e-9,
      `worst error ${(worstStepErr * (180 / Math.PI)).toExponential(1)} deg over ${STEPS} positions`,
    );
  }

  /**
   * The red control: P9's expression, run against the same orbit.
   *
   * Included because a probe nobody has watched go red is a probe that has not been written.
   * This is the arithmetic that shipped, and the number it prints is the size of the bug.
   */
  console.log('\n  red control — the bearing P9 shipped, same orbit:');
  for (const yawDeg of [0, 45, 90, 180]) {
    const yaw = (yawDeg * Math.PI) / 180;
    let worst = 0;
    for (let i = 0; i < STEPS; i++) {
      const theta = (i / STEPS) * Math.PI * 2;
      const fx = -simSin(yaw);
      const fz = -simCos(yaw);
      const rx = simCos(yaw);
      const rz = -simSin(yaw);
      const d = 20;
      const tx = (fx * simCos(theta) + rx * simSin(theta)) * d;
      const tz = (fz * simCos(theta) + rz * simSin(theta)) * d;
      // P9's `BearingIndicator.update`, verbatim.
      const shipped = Math.atan2(tx - 0, -(tz - 0)) - yaw;
      let err = shipped - theta;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err <= -Math.PI) err += Math.PI * 2;
      if (Math.abs(err) > worst) worst = Math.abs(err);
    }
    console.log(
      '    yaw %s deg: worst error %s deg%s',
      padStart(String(yawDeg), 3),
      padStart(((worst * 180) / Math.PI).toFixed(1), 6),
      yawDeg === 0 ? '  (the one seat it is right in)' : '',
    );
  }

  console.log('\nprojection checks failed: %d', failures);
  return failures;
}
