import { ALL_WEAPONS } from '../shared/weapons/WeaponDefs';
import type { WeaponDef } from '../shared/weapons/WeaponDefs';
import { CROSSHAIR_MIN_GAP, crosshairGapPx, crosshairOpacity } from '../shared/ui/Crosshair';
import { relationClass, relationTo, teamLabel, teamsInViewOrder } from '../shared/ui/TeamColour';
import type { ScoreTeam } from '../shared/combat/ScoreSystem';
import { FOUNDRY_MAP } from '../shared/world/maps/foundry';
import { DEPOT_MAP } from '../shared/world/maps/depot';
import { DUNES_MAP } from '../shared/world/maps/dunes';
import { GREYBOX_MAP } from '../shared/world/maps/greybox';
import type { MapDef } from '../shared/world/maps/types';
import { allMaterialBaseColors, materialBaseColor } from '../shared/world/maps/albedo';
import {
  DECAL_HOLE_FRACTION,
  DECAL_RIM_FRACTION,
  DECAL_RIM_MAX_M,
  DECAL_RIM_MIN_M,
  surfaceOf,
} from '../shared/world/maps/materials';
import { MATERIAL_KEYS } from '../shared/world/maps/types';
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
  /*
   * The warmup arena is in this table as of round 5 (F6), and its absence was the point.
   *
   * Every earlier reading here was of a map somebody chooses. The arena is the one nobody
   * chooses and everybody sees, first, before they have decided anything about the game — which
   * makes it the most-viewed surface in the build and the last one anybody measured. Its floor
   * is the *same material* as Foundry's, so whatever the two read at, the difference is the
   * lights and nothing else.
   */
  { def: GREYBOX_MAP, ground: 'floor' },
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

// -- F6: the room everybody lands in ---------------------------------------

/**
 * The warmup arena against the map it should be no darker than (playtest round 5, F6).
 *
 * F6 reported the arena as *"nearly black"* and it measured at **51/255, flat** — on the same
 * `floor` material Foundry uses, so the whole difference was the lights.
 *
 * The threshold is a **comparison against another shipped map**, not a number somebody liked:
 * the arena is the room nobody chooses and everybody sees first, before they have decided
 * anything about the game, so it has no business being darker than the average of the indoor
 * map people already read fine. Depot is deliberately a night map and is not the reference;
 * Foundry is.
 *
 * The arena is also *uniform* — its `pool:gap` is 1.00x — which is why its mean is compared
 * against Foundry's rather than its min against Foundry's min. Foundry earns its 96 from two
 * point lights over a small area; a lobby with no bright spot to make up for a dark one should
 * clear the average.
 */
function arenaBrightness(): number {
  const arena = GROUNDS.find((g) => g.def.id === GREYBOX_MAP.id);
  const reference = GROUNDS.find((g) => g.def.id === FOUNDRY_MAP.id);
  if (arena === undefined || reference === undefined) {
    console.error('\nARENA BRIGHTNESS: the arena or its reference map is not in GROUNDS.');
    return 1;
  }
  const lit = readFloor(arena.def, materialBaseColor(arena.ground)).mean;
  const bar = readFloor(reference.def, materialBaseColor(reference.ground)).mean;
  console.log('\n== F6: the arena against its reference ==\n');
  console.log(
    '  %s %s vs %s %s  %s',
    pad(arena.def.name, 8),
    padStart(lit.toFixed(1), 6),
    pad(reference.def.name, 8),
    padStart(bar.toFixed(1), 6),
    lit >= bar ? 'ok' : 'THE ROOM EVERYBODY LANDS IN IS DARKER THAN THE MAP THEY CHOOSE',
  );
  return lit >= bar ? 0 : 1;
}

// -- F5: the crosshair against the ground it is drawn over -------------------

/**
 * WCAG 2.1's minimum contrast for a non-text user-interface component.
 *
 * A citable standard rather than a number tuned until the observation stopped, which is what P0
 * bans. A crosshair is exactly what 1.4.11 is about — a small graphical element whose whole job
 * is to be distinguishable from what is behind it.
 */
const MIN_CONTRAST = 3;

/** One sRGB channel, 0-255, linearised the way WCAG defines it. */
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** `fg` at `alpha` composited over a grey `bg`, both 0-255. */
function composite(
  fg: readonly [number, number, number],
  alpha: number,
  bg: number,
): [number, number, number] {
  return [
    fg[0] * alpha + bg * (1 - alpha),
    fg[1] * alpha + bg * (1 - alpha),
    fg[2] * alpha + bg * (1 - alpha),
  ];
}

function contrast(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/** `--hud-cross-color` and the ring alpha in `--hud-cross-shadow`, from `styles/hud.css`. */
const CROSS_RGB: readonly [number, number, number] = [232, 234, 238];
const CROSS_ALPHA = 0.9;
const RING_ALPHA = 0.85;
const BLACK: readonly [number, number, number] = [0, 0, 0];

/**
 * How the crosshair reads on each map's ground (playtest round 5, F5).
 *
 * The report was *"on Dunes at noon it nearly disappears"*, and this is that sentence as a
 * number. Two columns, and the pair is the argument:
 *
 * - **bare** is the mark against the ground with no help from the shadow at all. A 2px *blurred*
 *   shadow spreads its darkness over four pixels of a two-pixel mark, so almost nothing of it
 *   reaches the pixel next to the line — bare is the worst case the old shadow degrades toward,
 *   and it is a bracket rather than a model. Modelling a CSS blur precisely would be a guess
 *   dressed up as a measurement.
 * - **ringed** is the mark against a hard 1px ring, where the adjacent pixel *is* the ring by
 *   definition and there is nothing left to model.
 *
 * The assertion is on `ringed`, because that is what ships. `bare` is printed beside it so the
 * reason for the change stays visible: it is below the floor on exactly one ground, and it is
 * the one that was reported.
 */
function crosshairContrastTable(): number {
  console.log('\n== F5: the crosshair against each map ground ==\n');
  console.log('map          ground      bare     ringed  verdict');

  let failures = 0;
  const bare: number[] = [];
  const ringed: number[] = [];

  for (const { def, ground } of GROUNDS) {
    const bg = readFloor(def, materialBaseColor(ground)).mean;
    const mark = composite(CROSS_RGB, CROSS_ALPHA, bg);
    const ring = composite(BLACK, RING_ALPHA, bg);
    const b = contrast(mark, [bg, bg, bg]);
    const r = contrast(mark, ring);
    bare.push(b);
    ringed.push(r);
    const ok = r >= MIN_CONTRAST;
    if (!ok) failures++;
    console.log(
      '  %s %s %s %s %s',
      pad(def.name, 10),
      padStart(bg.toFixed(1), 6),
      padStart(b.toFixed(2) + ':1', 9),
      padStart(r.toFixed(2) + ':1', 9),
      ok ? 'ok' : 'UNDER ' + String(MIN_CONTRAST) + ':1',
    );
  }

  /*
   * The property the fix is actually for, and it is not "the number went up".
   *
   * A ringed mark's contrast barely moves between a map at 21/255 and one at 185/255, because
   * the ring is what the eye compares the mark against and the ring is opaque. The spread
   * collapsing is what makes the crosshair stop being a per-map problem at all.
   */
  const spread = (xs: readonly number[]): number => Math.max(...xs) / Math.min(...xs);
  console.log(
    '\n  map-to-map spread: bare %sx, ringed %sx (1.00x is ground-independent)',
    spread(bare).toFixed(2),
    spread(ringed).toFixed(2),
  );
  return failures;
}

// -- F3: how big a bullet decal actually is ---------------------------------

/**
 * `DecalField.place`'s per-hole jitter, restated.
 *
 * A second copy, and the honest kind: this file cannot import a client module, and a probe that
 * assumed no jitter would report a range narrower than the one that ships. Keep it in step with
 * `rng.range(0.85, 1.2)` in `client/engine/Decals.ts`.
 */
const DECAL_JITTER_MIN = 0.85;
const DECAL_JITTER_MAX = 1.2;

/**
 * Every material's decal, in centimetres of visible mark (playtest round 5, F3).
 *
 * The report said *"soft black blobs 30-40cm across"* and it was reading the **rim**: the quad
 * is `decalRadius * 2 * jitter` across and the texture's pale ring reaches `DECAL_RIM_FRACTION`
 * of it, so the mark on sand ran to 25 cm. The number worth holding to a range is therefore the
 * rim diameter at the jitter's extremes and not `decalRadius`, and this does the conversion
 * rather than leaving it to be done in somebody's head at review time.
 */
function decalSizeTable(): number {
  console.log('\n== F3: bullet decals, as centimetres on the wall ==\n');
  console.log('material         radius      hole cm       rim cm  verdict');

  let failures = 0;
  for (const key of MATERIAL_KEYS) {
    const surface = surfaceOf(key);
    const smallest = surface.decalRadius * 2 * DECAL_JITTER_MIN;
    const largest = surface.decalRadius * 2 * DECAL_JITTER_MAX;
    const rimMin = smallest * DECAL_RIM_FRACTION;
    const rimMax = largest * DECAL_RIM_FRACTION;
    const ok = rimMin >= DECAL_RIM_MIN_M && rimMax <= DECAL_RIM_MAX_M;
    if (!ok) failures++;
    const hole =
      (smallest * DECAL_HOLE_FRACTION * 100).toFixed(1) +
      '-' +
      (largest * DECAL_HOLE_FRACTION * 100).toFixed(1);
    const rim = (rimMin * 100).toFixed(1) + '-' + (rimMax * 100).toFixed(1);
    console.log(
      '  %s %s %s %s %s',
      pad(key, 14),
      padStart(surface.decalRadius.toFixed(3), 6),
      padStart(hole, 12),
      padStart(rim, 12),
      ok ? 'ok' : 'OUTSIDE',
    );
  }
  console.log(
    '\n  target rim diameter: %s-%s cm, from materials.ts',
    (DECAL_RIM_MIN_M * 100).toFixed(0),
    (DECAL_RIM_MAX_M * 100).toFixed(0),
  );
  return failures;
}

// -- main -------------------------------------------------------------------

console.log('OPERATOR readability probe — playtest round 4, P9 (B2, B12, F9)');

const crosshair = crosshairTable();
scopedWeapons();
const colourViolations = teamColourTable();
const projectionFailures = projectionTable();
albedoTable();
lightingTable();
const arenaFailures = arenaBrightness();
const crosshairContrastFailures = crosshairContrastTable();
const decalFailures = decalSizeTable();

console.log('\n== summary ==');
console.log('  crosshair gaps at the floor: %d of %d hip-fire states', crosshair.atFloor, crosshair.examined);
console.log('  team-colour violations:      %d', colourViolations);
console.log('  projection checks failed:    %d', projectionFailures);
console.log('  arena brightness failures:   %d', arenaFailures);
console.log('  crosshair contrast failures: %d', crosshairContrastFailures);
console.log('  decals outside the range:    %d', decalFailures);

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
/**
 * Both of round 5's P9 halves exit non-zero, and unlike the lighting table above they are
 * entitled to.
 *
 * The note on the exit code says a reading with no agreed threshold must not fail a build, and
 * that still holds — what changed is that these two have thresholds somebody can point at.
 * `MIN_CONTRAST` is WCAG 2.1's figure for a non-text UI component, and the decal range is a
 * stated target written down beside the values it governs. An edit that leaves either has to
 * argue with a number rather than with a taste.
 */
if (arenaFailures > 0) {
  console.error(
    '\nARENA BRIGHTNESS FAILED: the warmup arena reads darker than the map it is measured ' +
      'against. It is the first thing every player sees; see greybox.ts lights.',
  );
  process.exit(1);
}
if (crosshairContrastFailures > 0) {
  console.error(
    '\nCROSSHAIR CONTRAST FAILED: %d of %d grounds under %d:1 for the ringed mark.',
    crosshairContrastFailures,
    GROUNDS.length,
    MIN_CONTRAST,
  );
  process.exit(1);
}
if (decalFailures > 0) {
  console.error('\nDECAL SIZE FAILED: %d material(s) outside the stated rim range.', decalFailures);
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
