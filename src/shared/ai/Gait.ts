import { HUMANOID_RIG } from '../combat/HitboxRig';
import { simCos, simSin } from '../core/SimMath';

/**
 * The walk cycle, as arithmetic (playtest round 5, F4).
 *
 * ## Why this is in `shared/` when nothing here is simulated
 *
 * Same reason `MapLuminance`, `HudSurfaces` and `SkyProfile` are: `shared/` compiles without
 * the DOM and without `three`, so `npm run readability` can run this and settle the questions
 * about a gait that are answerable without a screen — is it periodic, is it symmetric, is the
 * foot on the ground when it should be, and **how far does the drawn leg get from the box a
 * shot is tested against.** It sits beside `BotVisualState.ts`, which is the same category:
 * cosmetic data that both halves of the partition have to agree about.
 *
 * Nothing in `shared/combat` or `shared/player` imports it, and nothing may. A gait that fed a
 * simulated value would be a cosmetic driving gameplay, which is the §4.15 line this whole
 * session sits inside.
 *
 * The trig goes through `simSin`/`simCos` because `check-boundaries` requires it of everything
 * in `shared/`, and the rule earns itself here for a reason that is not determinism: the
 * numbers below are printed into `PLAN.md` by a Node process and drawn by a browser, and a
 * table that disagreed with the screen in the last decimal would be a table nobody trusts.
 *
 * ## The phase is distance, not time
 *
 * F4's constraint is that the animation is a function of replicated state that already exists.
 * The strongest form of that is not to read velocity off the snapshot at all: the phase is
 * integrated from **the distance the body was drawn to move**, which the renderer already has
 * because it just computed it. There is no phase on the wire, none in a snapshot, and no
 * interface between the simulation and this — a remote player and a local bot walk the same
 * way because they covered the same ground, not because anything told them to.
 *
 * It also removes the failure a time-driven cycle has, and it is the one people notice: legs
 * that keep walking while the body is stopped against a wall.
 *
 * ## Two things it cannot do, stated once, here
 *
 * **There is no knee.** A leg is one rigid box on a hip pivot, so the sole's fore-and-aft
 * travel is capped at `2 * LEG_LENGTH * sin(MAX_SWING)` — under a metre — while the body
 * covers `STRIDE_METRES` in the same cycle. The difference is foot slide, it is geometric
 * rather than a tuning failure, and `npm run readability` prints it instead of hiding it.
 * Closing it needs a rigged model with a knee, which is R4-F4 and not this session.
 *
 * **The sole rises at the extremes of the stride**, by `LEG_LENGTH * (1 - cos swing)`, because
 * a rigid leg swept about a fixed hip sweeps an arc. Nothing compensates for it, and that is a
 * decision rather than an omission: the alternatives are to drop the leg away from the hip,
 * which opens a hole at the pelvis, or to dip the whole body, which moves the head and torso
 * boxes — the two a fight is decided by — away from where they are drawn. At this game's
 * `walkSpeed` of 4.6 m/s a body is running, and a runner's feet do leave the ground at the
 * extremes of the stride, so the artefact is in the direction of the truth.
 */

/** The boxes this poses. Read from the rig so the animation and the hitboxes cannot drift. */
const LEG_BOX = HUMANOID_RIG.boxes.find((box) => box.name === 'legL');
const ARM_BOX = HUMANOID_RIG.boxes.find((box) => box.name === 'armL');

if (LEG_BOX === undefined || ARM_BOX === undefined) {
  throw new Error('HUMANOID_RIG has no "legL"/"armL" box; there is nothing here to pose.');
}

/**
 * How far the arms are pitched forward at the shoulder, radians.
 *
 * Not part of the walk — the arms hold the weapon and do not swing — and it lives here anyway,
 * because **the number F4 requires to be stated is the divergence of both limbs from their
 * boxes**, and a measurement assembled from two files is one that can be taken against two
 * different versions. `BotMesh` bakes this into the body geometry; `armDivergence` below is
 * what the probe reports.
 *
 * A rigid arm box has no elbow, so there is no pose that puts the hands at the chest: the arm
 * either hangs at the side or points where it is turned to. 0.55 rad puts them forward and a
 * little down, which is the low ready a rifleman stands in.
 */
export const ARM_PITCH = 0.55;

/** Height of the hip pivot above the soles, metres: the top face of the leg box. */
export const LEG_PIVOT_Y = LEG_BOX.oy + LEG_BOX.sy * 0.5;

/** Pivot to sole, metres. */
export const LEG_LENGTH = LEG_BOX.sy;

/**
 * Ground covered per full cycle — two footfalls — in metres.
 *
 * Anchored to **cadence** rather than to stride, because cadence is what an eye reads and it
 * is nearly constant across running speeds at about three footfalls a second. At this game's
 * `walkSpeed` of 4.6 m/s three a second is 3.07 m per cycle; the same number gives 4.5 a
 * second at `sprintSpeed` 6.9, which is a sprinter's.
 *
 * Choosing it the other way round — the stride a knee-less leg can cover without sliding —
 * would put the cadence at eleven footfalls a second at a walk. That is not a run, it is a
 * blur. The slide is the price and `slideFraction` below is the receipt.
 */
export const STRIDE_METRES = 3.07;

/** Peak hip swing at full amplitude, radians. Past this the leg reads as doing the splits. */
export const MAX_SWING = 0.62;

/**
 * Speed at which the swing reaches full amplitude, m/s.
 *
 * Below it the amplitude scales down, which is what returns a stopping body to a standing pose
 * rather than freezing it mid-stride: the phase stops advancing when the body stops, so
 * without this the legs would simply stick wherever the last step left them.
 */
export const FULL_SWING_SPEED = 4.0;

/** How fast the drawn amplitude chases the measured one, per second. */
export const AMPLITUDE_RESPONSE = 9;

export interface LegPose {
  /** Hip rotation, radians. Positive carries the sole forward, along the body's -Z. */
  readonly swing: number;
}

export interface GaitPose {
  readonly left: LegPose;
  readonly right: LegPose;
}

/**
 * Advance the phase by the distance the body was drawn to move. Returns a phase in [0, 1).
 *
 * Wrapped with `floor` rather than a loop, so a body carried across the map by a respawn costs
 * the same as one that took a step.
 */
export function advanceGaitPhase(phase: number, distanceMetres: number): number {
  const next = phase + Math.abs(distanceMetres) / STRIDE_METRES;
  return next - Math.floor(next);
}

/** 0 at a standstill, 1 at `FULL_SWING_SPEED` and above. */
export function gaitAmplitude(speedMetresPerSecond: number): number {
  const t = speedMetresPerSecond / FULL_SWING_SPEED;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * The two legs at this phase.
 *
 * The right leg is the left one half a cycle on. Written as an offset in the phase rather than
 * as a negation, so that a later asymmetry — a limp, a knee, a wounded stagger — has somewhere
 * to go instead of the two legs being silently forced to stay mirror images.
 */
export function gaitAt(phase: number, amplitude: number): GaitPose {
  return { left: legAt(phase, amplitude), right: legAt(phase + 0.5, amplitude) };
}

function legAt(phase: number, amplitude: number): LegPose {
  return { swing: MAX_SWING * amplitude * simSin(2 * Math.PI * phase) };
}

/**
 * Where this leg's sole ends up, relative to where it stands at rest.
 *
 * The renderer does not need this — it rotates a node and the sole follows. The probe does:
 * "the sole is on the ground at mid-stride" and "the sole travels this far while the body
 * travels that far" are both statements about this point, and deriving it here means the probe
 * measures the shipped arithmetic rather than a restatement of it.
 */
export function solePosition(leg: LegPose): { forward: number; rise: number } {
  return {
    forward: LEG_LENGTH * simSin(leg.swing),
    rise: LEG_LENGTH * (1 - simCos(leg.swing)),
  };
}

/** Fore-and-aft travel of one sole across a whole cycle, metres. */
export function soleExcursion(amplitude = 1): number {
  return 2 * LEG_LENGTH * simSin(MAX_SWING * amplitude);
}

/**
 * The fraction of the body's travel the soles cannot account for.
 *
 * Zero would be a real walk. It is not zero and cannot be — see the header — so this exists to
 * be printed, not to be asserted against a threshold nobody has agreed to.
 */
export function slideFraction(amplitude = 1): number {
  return 1 - soleExcursion(amplitude) / STRIDE_METRES;
}

/**
 * How far the drawn leg gets from the box a shot is tested against, metres.
 *
 * **This is the number F4's constraint is about.** The brief: *"If the legs move and the
 * hitbox does not, that is correct and must be stated in `PLAN.md` so nobody later fixes it."*
 * Stating it as prose is weaker than stating it as a measurement, so this is the measurement,
 * and it is the worst case over the leg's whole length rather than at the sole alone — the
 * divergence grows linearly down the leg and the sole is simply where it is largest.
 *
 * The rig box stays vertical, so the furthest a point at distance `d` below the pivot gets
 * from its resting position is `d * sin(swing)` forward and `d * (1 - cos swing)` up. The box
 * is `sz` deep, so half of that is covered for free.
 */
export function legDivergence(swing: number): number {
  return limbDivergence(LEG_LENGTH, LEG_BOX?.sz ?? 0, swing);
}

/**
 * The same measurement for an arm, which does not move but is not where its box is either.
 *
 * The arms are posed once and never animated, so this is a single number rather than a
 * function of phase — but it is the same kind of claim and it belongs in the same table.
 */
export function armDivergence(): number {
  return limbDivergence(ARM_BOX?.sy ?? 0, ARM_BOX?.sz ?? 0, ARM_PITCH);
}

/**
 * How far the far end of a rigid limb of length `length` gets from an upright box `depth` deep.
 *
 * Worst case over the limb: the divergence grows linearly from zero at the pivot, so the end is
 * where it is largest. Half the box's depth is covered for free, because a box that is 20 cm
 * deep still contains a limb that has leaned 10 cm.
 */
function limbDivergence(length: number, depth: number, angle: number): number {
  const forward = length * simSin(Math.abs(angle));
  const rise = length * (1 - simCos(angle));
  return Math.max(0, Math.hypot(forward, rise) - depth * 0.5);
}
