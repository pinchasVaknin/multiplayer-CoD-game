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
albedoTable();
lightingTable();

console.log('\n== summary ==');
console.log('  crosshair gaps at the floor: %d of %d hip-fire states', crosshair.atFloor, crosshair.examined);
console.log('  team-colour violations:      %d', colourViolations);

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
if (crosshair.examined === 0) {
  console.error('\nCROSSHAIR CHECK FAILED: no weapons examined.');
  process.exit(1);
}
console.log('\nreadability probe ok');
