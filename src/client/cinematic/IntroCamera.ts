import * as THREE from 'three';
import {
  planIntro,
  RETURN_SECONDS,
  type IntroPlan,
  type IntroPose,
} from '../../shared/cinematic/IntroPlan';
import type { MovementConfig } from '../../shared/player/MovementConfig';
import type { MatchWorld } from '../MatchWorld';

/**
 * The match intro's camera (M15, Phase C): the plan, played over the round-one freeze.
 *
 * ## Asked, not pushed — the chopper's shape
 *
 * `Game` asks `cameraFor` once per render frame, before it asks the Chopper Gunner, and
 * renders through whatever answers: this while the intro runs, the takeover while a gunship
 * is up, the rig otherwise. There can be no chopper during a freeze, but the order is a fact
 * rather than an assumption. Nothing here is written back to the rig, so there is nothing
 * for `Game` to undo when the intro ends — the same reason the takeover works that way.
 *
 * ## The clock is the server's freeze
 *
 * The timeline runs on `flow.phaseSecondsTotal - flow.phaseSecondsRemaining`, not on a
 * local clock: a client that joins with four seconds of freeze left gets four seconds of
 * intro, and the cue that ends the freeze lands on everybody's own eyes at once. The plan is
 * built on the first eligible frame — `planIntro` over the match's own navmesh and
 * colliders, the shape `npm run intro` proves on every map — and plays exactly once per
 * match: a plan that has finished, or been skipped, is not rebuilt for the same round.
 *
 * ## Three blends the plan does not know about
 *
 * The plan starts wherever the approach's trim put it and ends on a hold; the rig is where
 * the player's eyes are. So the first `BLEND_IN` seconds ease the camera from the rig to the
 * plan (a fast push out of the eyes rather than a cut), the last `RETURN_SECONDS` ease it
 * back, and the lens goes with it — the player's own field of view to `FOV_DEG` and back —
 * because a 90° eye cut to a 60° lens is a jolt the timeline does not need.
 *
 * ## Skipping
 *
 * Any key or mouse button skips to the return blend, except the digits that pick a class:
 * the quick selector is the reason the freeze is ten seconds long, and a class pick must not
 * cost the player the overview. `Escape` is left alone too — it is the pause key.
 */

export interface IntroCameraDeps {
  readonly movement: MovementConfig;
}

/** The intro's lens, vertical degrees; what the overview is fitted to. */
export const FOV_DEG = 60;
const BLEND_IN_SECONDS = 0.35;
/** Keys that do not skip: the quick class selector's, and pause. */
const KEEP_KEYS = new Set(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Escape']);

function ease(u: number): number {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export class IntroCamera {
  private readonly deps: IntroCameraDeps;
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 500);
  private readonly pose: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private readonly endPose: IntroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };

  /** The plan for the world it was built in; null between matches. */
  private plan: IntroPlan | null = null;
  private plannedFor: MatchWorld | null = null;
  /** True once this match's intro has ended, by time or by a key. Cleared with the world. */
  private done = false;
  /** Set by a key; the timeline jumps to the return blend from where it was. */
  private skippedAt = -1;
  private listening = false;

  constructor(deps: IntroCameraDeps) {
    this.deps = deps;
  }

  /** Whether the intro is drawing this frame — the HUD and the viewmodel read it. */
  get active(): boolean {
    return this.plan !== null && !this.done;
  }

  /** The label the intro wants on screen — an objective's — or empty. */
  get label(): string {
    const plan = this.plan;
    if (plan === null || this.done) return '';
    return this.currentLabel;
  }

  private currentLabel = '';

  /**
   * The camera to render this frame, or null when the rig's is the one.
   *
   * `rig` is the rig's camera after its own update this frame: where the player's eyes are,
   * and the lens they look through — both ends of the blends.
   */
  cameraFor(world: MatchWorld, rig: THREE.PerspectiveCamera, aspect: number): THREE.PerspectiveCamera | null {
    const match = world.match;
    const flow = match.flow;

    if (this.plannedFor !== world) {
      // A new world: forget the old plan, and nothing is decided about this one yet.
      this.plan = null;
      this.plannedFor = world;
      this.done = false;
      this.skippedAt = -1;
    }
    if (this.done) return null;

    const eligible =
      flow.currentPhase === 'WARMUP' && flow.round <= 1 && !match.inWarmupArena && match.mode.id !== 'RANGE';
    if (!eligible) {
      // Not the round-one freeze: no intro this match, and no second chance at it.
      if (this.plan !== null) this.finish();
      else this.done = true;
      return null;
    }

    const total = flow.phaseSecondsTotal;
    const t = total - flow.phaseSecondsRemaining;
    if (this.plan === null) {
      const sim = world.player.sim;
      this.plan = planIntro({
        def: world.map.def,
        nav: match.bots.nav,
        collision: world.map.collision,
        movement: this.deps.movement,
        modeId: match.mode.id,
        spawn: { x: sim.x, y: sim.y, z: sim.z },
        fovDeg: FOV_DEG,
        freezeSeconds: total,
      });
      this.plan.poseAt(this.plan.seconds, this.endPose);
      this.listen();
    }
    const plan = this.plan;

    // The timeline: the plan, then the return; a skip jumps to the return from wherever it was.
    const skipped = this.skippedAt >= 0;
    const planEnd = skipped ? this.skippedAt : plan.seconds;
    const returnEnd = planEnd + RETURN_SECONDS;
    if (t >= returnEnd) {
      this.finish();
      return null;
    }

    // Where the plan is: at `t` while it plays, held where the skip caught it afterwards.
    const planT = Math.min(t, planEnd);
    plan.poseAt(planT, this.pose);
    this.currentLabel = labelAt(plan, planT);

    // The blends: rig → plan over the first `BLEND_IN_SECONDS`, plan → rig over the return.
    let w = 1;
    if (t < BLEND_IN_SECONDS) w = ease(t / BLEND_IN_SECONDS);
    if (t > planEnd) w = 1 - ease((t - planEnd) / RETURN_SECONDS);

    const rigYaw = rig.rotation.y;
    const rigPitch = rig.rotation.x;
    const x = rig.position.x + (this.pose.x - rig.position.x) * w;
    const y = rig.position.y + (this.pose.y - rig.position.y) * w;
    const z = rig.position.z + (this.pose.z - rig.position.z) * w;
    const yaw = rigYaw + angleDelta(rigYaw, this.pose.yaw) * w;
    const pitch = rigPitch + (this.pose.pitch - rigPitch) * w;
    const fov = rig.fov + (FOV_DEG - rig.fov) * w;

    const cam = this.camera;
    cam.position.set(x, y, z);
    cam.rotation.set(pitch, yaw, 0, 'YXZ');
    if (cam.aspect !== aspect || Math.abs(cam.fov - fov) > 1e-3) {
      cam.aspect = aspect;
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    return cam;
  }

  /** Called when the world goes away, so the next one plans afresh. */
  reset(): void {
    this.plan = null;
    this.plannedFor = null;
    this.done = false;
    this.skippedAt = -1;
    this.unlisten();
  }

  dispose(): void {
    this.reset();
  }

  // -- internals -------------------------------------------------------------

  private finish(): void {
    this.done = true;
    this.currentLabel = '';
    this.unlisten();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointerdown', this.onPointer, true);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointerdown', this.onPointer, true);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (KEEP_KEYS.has(e.code)) return;
    this.skip();
  };

  private readonly onPointer = (): void => {
    this.skip();
  };

  private skip(): void {
    const plan = this.plan;
    if (plan === null || this.done || this.skippedAt >= 0 || this.plannedFor === null) return;
    const flow = this.plannedFor.match.flow;
    const t = flow.phaseSecondsTotal - flow.phaseSecondsRemaining;
    // The return has already begun on its own; a skip changes nothing.
    if (t >= plan.seconds) return;
    this.skippedAt = t;
  }
}

/** The label of the segment `t` falls in. */
function labelAt(plan: IntroPlan, t: number): string {
  let cursor = t;
  for (const segment of plan.segments) {
    if (cursor <= segment.seconds) return segment.label;
    cursor -= segment.seconds;
  }
  return plan.segments[plan.segments.length - 1]?.label ?? '';
}
