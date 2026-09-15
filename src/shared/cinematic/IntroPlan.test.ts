import { describe, expect, it } from 'vitest';
import { navBakeOptionsFor } from '../ai/BotDirector';
import { installClock } from '../core/Clock';
import { DEFAULT_MOVEMENT_CONFIG } from '../player/MovementConfig';
import { bakeNavmesh } from '../world/NavBake';
import { loadMapCollision } from '../world/MapLoader';
import { FOUNDRY_MAP } from '../world/maps/foundry';
import {
  APPROACH_MAX_SECONDS,
  collidingSamples,
  EYE_RADIUS,
  OBJECTIVES_MAX_SECONDS,
  OWN_VIEW_SECONDS,
  planIntro,
  PULLBACK_SECONDS,
  RETURN_SECONDS,
  type IntroPose,
} from './IntroPlan';

/**
 * The match intro's plan (M15, Phase C), on one map: the arithmetic `npm run intro` holds
 * every map × mode × spawn to, pinned here on Foundry so a change to the planner's budgets
 * or its geometry is a red test before it is a red harness.
 */

let fakeNow = 0;
// The navmesh bake reads the clock for its own timing; installed before the describe body
// bakes, which vitest runs at collection time.
installClock({ nowMs: () => fakeNow++ });

function foundry() {
  const collision = loadMapCollision(FOUNDRY_MAP);
  const nav = bakeNavmesh(collision.collision, FOUNDRY_MAP.navBounds, navBakeOptionsFor(FOUNDRY_MAP, DEFAULT_MOVEMENT_CONFIG));
  return { collision: collision.collision, nav };
}

describe('planIntro on Foundry', () => {
  const { collision, nav } = foundry();
  const spawn = FOUNDRY_MAP.spawns[0]!.position;
  const common = { def: FOUNDRY_MAP, nav, collision, movement: DEFAULT_MOVEMENT_CONFIG, spawn, fovDeg: 60, freezeSeconds: 10 };

  it('fits the freeze less the return and the player\'s own second, phase by phase', () => {
    const plan = planIntro({ ...common, modeId: 'DOM' });
    const budget = 10 - RETURN_SECONDS - OWN_VIEW_SECONDS;
    expect(plan.seconds).toBeLessThanOrEqual(budget + 1e-9);
    expect(plan.seconds).toBeGreaterThan(budget - 0.25);
    const approach = plan.segments.find((s) => s.kind === 'approach')!;
    expect(approach.seconds).toBeLessThanOrEqual(APPROACH_MAX_SECONDS);
    expect(plan.segments.find((s) => s.kind === 'pullback')!.seconds).toBe(PULLBACK_SECONDS);
    expect(plan.objectiveSeconds).toBeLessThanOrEqual(OBJECTIVES_MAX_SECONDS);
    expect(plan.objectives).toEqual(['dom_a', 'dom_b']);
  });

  it('holds the overview for the deathmatch modes and visits both sites for Search & Destroy', () => {
    const tdm = planIntro({ ...common, modeId: 'TDM' });
    expect(tdm.objectives).toEqual([]);
    expect(tdm.segments.map((s) => s.kind)).toEqual(['approach', 'pullback', 'hold']);
    const snd = planIntro({ ...common, modeId: 'SND' });
    expect(snd.objectives).toEqual(['snd_a', 'snd_b']);
  });

  it('starts on the route out of the spawn, as far along as the trim took it, and keeps the eye clear', () => {
    const plan = planIntro({ ...common, modeId: 'SND' });
    const first: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    plan.poseAt(0, first);
    // A route longer than the approach's budget is trimmed from the spawn end, so the camera
    // starts up the route by the trimmed distance — never further, and at the spawn if untrimmed.
    expect(Math.hypot(first.x - spawn.x, first.z - spawn.z)).toBeLessThanOrEqual(plan.trimmedMetres + 0.5);
    expect(collidingSamples(plan, collision, 0.25, EYE_RADIUS)).toEqual([]);
  });

  it('poseAt is continuous across segment boundaries', () => {
    const plan = planIntro({ ...common, modeId: 'DOM' });
    const a: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    const b: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    let t = 0;
    for (const segment of plan.segments) {
      t += segment.seconds;
      plan.poseAt(t - 1e-4, a);
      plan.poseAt(t + 1e-4, b);
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.5);
    }
  });
});
