import { navBakeOptionsFor } from '../shared/ai/BotDirector';
import { installClock } from '../shared/core/Clock';
import { nodeClock } from './NodeClock';
import {
  APPROACH_MAX_SECONDS,
  collidingSamples,
  EYE_RADIUS,
  OBJECTIVES_MAX_SECONDS,
  OWN_VIEW_SECONDS,
  planIntro,
  PULLBACK_SECONDS,
  RETURN_SECONDS,
  type IntroPlan,
} from '../shared/cinematic/IntroPlan';
import { MAPS, modesForMap } from '../shared/modes/ModeRegistry';
import { DEFAULT_MOVEMENT_CONFIG } from '../shared/player/MovementConfig';
import { capsuleBoxPenetration, makeContact } from '../shared/world/Geometry';
import { loadMapCollision } from '../shared/world/MapLoader';
import { bakeNavmesh } from '../shared/world/NavBake';

/**
 * The match intro, planned and tested for every map × mode (M15, Gate C).
 *
 * `planIntro` is pure `shared/` geometry, so it runs here on the server build with no browser:
 * each map's collision and navmesh are baked the way `MapBakery` bakes them at boot, every
 * mode the map can run is planned from each of the map's spawn zones, the whole camera path
 * is sampled every 25 cm, and two things are asserted —
 *
 *   1. **No sample is inside a collider.** A 30 cm sphere at the eye against the map's own
 *      `CollisionWorld`, the test movement uses. A camera that clips a wall on the way to the
 *      centre is the one thing the brief's "like a normal human path" forbids.
 *   2. **The plan fits the freeze.** Its segments total no more than the ten seconds less the
 *      return blend and the player's own second, and each phase is inside its own budget.
 *
 * It prints the route lengths, what the approach trimmed, the overview's distance (and what
 * clamped it), the objectives visited and any whip that fell back to the arc — so the
 * numbers a fix is written against are in the log rather than in somebody's head. Exits 1
 * on any violation, which is what makes it an instrument and not a report.
 *
 *   npm run intro
 *   node dist-server/intro.js --debug   (names the collider the first bad sample is in)
 */

const FREEZE_SECONDS = 10;
const FOV_DEG = 60;
const SAMPLE_STEP = 0.25;

interface Row {
  readonly map: string;
  readonly mode: string;
  readonly spawn: string;
  readonly plan: IntroPlan;
  readonly hits: number;
  readonly firstHit: string;
  readonly overBudget: string[];
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function main(): void {
  // The navmesh bake reads the clock for its own timing; nothing here simulates.
  installClock(nodeClock);
  const movement = DEFAULT_MOVEMENT_CONFIG;
  const rows: Row[] = [];
  let planned = 0;

  for (const map of MAPS) {
    const collision = loadMapCollision(map.def);
    const nav = bakeNavmesh(collision.collision, map.def.navBounds, navBakeOptionsFor(map.def, movement));
    const modes = modesForMap(map.id).filter((m) => m.populatesRoster);
    for (const mode of modes) {
      for (const spawn of map.def.spawns) {
        planned++;
        const plan = planIntro({
          def: map.def,
          nav,
          collision: collision.collision,
          movement,
          modeId: mode.id,
          spawn: spawn.position,
          fovDeg: FOV_DEG,
          freezeSeconds: FREEZE_SECONDS,
        });
        const bad = collidingSamples(plan, collision.collision, SAMPLE_STEP, EYE_RADIUS);
        const first = bad[0];
        if (first !== undefined && process.argv.includes('--debug')) {
          const set = collision.collision.colliders;
          const near: string[] = [];
          const contact = makeContact();
          for (let i = 0; i < set.count; i++) {
            if (!capsuleBoxPenetration(set, i, first.x, first.y, first.z, first.x, first.y, first.z, EYE_RADIUS, contact)) continue;
            const cx = set.center[i * 3]!, cy = set.center[i * 3 + 1]!, cz = set.center[i * 3 + 2]!;
            const hx = set.half[i * 3]!, hy = set.half[i * 3 + 1]!, hz = set.half[i * 3 + 2]!;
            near.push(`box ${i} centre (${fmt(cx)}, ${fmt(cy)}, ${fmt(cz)}) half (${fmt(hx)}, ${fmt(hy)}, ${fmt(hz)}) depth ${fmt(contact.depth, 3)} n (${fmt(contact.nx)}, ${fmt(contact.ny)}, ${fmt(contact.nz)})`);
          }
          const segIndex = plan.segments.findIndex((s) => s.kind === first.segment);
          const pts = plan.waypoints[segIndex] ?? [];
          let nearest = Infinity;
          for (const p of pts) nearest = Math.min(nearest, Math.hypot(p.x - first.x, p.y - first.y, p.z - first.z));
          console.log(`  debug ${map.name} ${mode.id} ${spawn.team}: first bad sample ${first.segment} at (${fmt(first.x)}, ${fmt(first.y)}, ${fmt(first.z)}); nearest waypoint ${fmt(nearest, 2)} m; ${near.join(' | ')}`);
        }
        const overBudget: string[] = [];
        const budget = FREEZE_SECONDS - RETURN_SECONDS - OWN_VIEW_SECONDS;
        if (plan.seconds > budget + 1e-6) overBudget.push(`total ${fmt(plan.seconds, 2)} s > ${fmt(budget, 2)} s`);
        const approach = plan.segments.find((s) => s.kind === 'approach');
        if (approach !== undefined && approach.seconds > APPROACH_MAX_SECONDS + 1e-6) {
          overBudget.push(`approach ${fmt(approach.seconds, 2)} s > ${APPROACH_MAX_SECONDS} s`);
        }
        const pullback = plan.segments.find((s) => s.kind === 'pullback');
        if (pullback !== undefined && Math.abs(pullback.seconds - PULLBACK_SECONDS) > 1e-6) {
          overBudget.push(`pullback ${fmt(pullback.seconds, 2)} s`);
        }
        if (plan.objectiveSeconds > OBJECTIVES_MAX_SECONDS + 1e-6) {
          overBudget.push(`objectives ${fmt(plan.objectiveSeconds, 2)} s > ${OBJECTIVES_MAX_SECONDS} s`);
        }
        rows.push({
          map: map.name,
          mode: mode.id,
          spawn: `${spawn.team}@(${fmt(spawn.position.x, 0)}, ${fmt(spawn.position.z, 0)})`,
          plan,
          hits: bad.length,
          firstHit:
            first === undefined
              ? ''
              : `${first.segment} t=${fmt(first.t, 2)}s at (${fmt(first.x)}, ${fmt(first.y)}, ${fmt(first.z)})`,
          overBudget,
        });
      }
    }
  }

  console.log(`== the match intro, ${planned} plans (${MAPS.length} maps, roster modes, every spawn) ==\n`);
  let failures = 0;
  for (const row of rows) {
    const p = row.plan;
    const parts = p.segments.map((s) => `${s.kind}${s.label !== '' ? `[${s.label}]` : ''} ${fmt(s.seconds, 2)}s/${fmt(s.metres, 0)}m`);
    const verdict = row.hits === 0 && row.overBudget.length === 0 ? 'ok' : 'FAIL';
    if (verdict === 'FAIL') failures++;
    console.log(
      `${verdict.padEnd(4)} ${row.map.padEnd(8)} ${row.mode.padEnd(4)} ${row.spawn.padEnd(16)} ` +
        `${fmt(p.seconds, 2)}s  approach ${fmt(p.approachMetres, 0)}m` +
        (p.trimmedMetres > 0 ? ` (trimmed ${fmt(p.trimmedMetres, 0)}m)` : '') +
        `  overview ${fmt(p.overviewDistance, 0)}m` +
        (p.objectives.length > 0 ? `  objectives ${p.objectives.join('→')}` : '') +
        (p.nudged > 0 ? `  nudged ${p.nudged}` : '') +
        (p.arcs.length > 0 ? `  arcs ${p.arcs.join(',')}` : ''),
    );
    console.log(`     ${parts.join(' · ')}`);
    if (row.hits > 0) console.log(`     ${row.hits} sample(s) inside a collider; first: ${row.firstHit}`);
    for (const line of row.overBudget) console.log(`     over budget: ${line}`);
  }

  console.log('');
  if (failures > 0) {
    console.log(`INTRO CHECK FAILED — ${failures} of ${rows.length} plans clip a collider or overrun a budget.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `INTRO CHECK PASSED — ${rows.length} plans, no sample inside a collider at ${SAMPLE_STEP} m / r ${EYE_RADIUS} m, ` +
      `every plan within ${FREEZE_SECONDS - RETURN_SECONDS - OWN_VIEW_SECONDS} s.`,
  );
}

main();
