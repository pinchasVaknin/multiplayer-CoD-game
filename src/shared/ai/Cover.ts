import type { NavGrid } from '../world/Navmesh';
import type { CoverPoint } from '../world/maps/types';
import type { Perception } from './Perception';

/**
 * Cover points, validated and scored (brief S6.5).
 *
 * The map authors candidate positions; this decides which of them are real. Two filters
 * run once at load and never again: the navmesh must say a bot can stand there, and the
 * point must be inside the world at all. Everything left goes in the index.
 *
 * The scoring pass is where the actual definition of cover lives, and it is not "near an
 * object": **a cover point is cover only if the threat cannot see the body that would be
 * standing in it.** That is one raycast per candidate, from the threat's eye to the pose
 * the bot would adopt — crouched for low cover, standing for high — and a candidate whose
 * line is clear is discarded no matter how close to a crate it is. It is the only test
 * that cannot be fooled by geometry the map author did not think about.
 *
 * Occupancy is tracked so two bots do not pile into the same 0.6 m spot, which is the
 * single most obvious tell that cover selection is per-bot and blind.
 */

export interface CoverSlot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians. The direction the cover protects from. */
  readonly facingYaw: number;
  readonly height: CoverPoint['height'];
  /** Navmesh cell, so pathing can be asked for it directly. */
  readonly cellIndex: number;
  /** Entity id of the bot that has claimed this slot, or -1. */
  occupantId: number;
}

/** Torso height a bot presents while using low cover (crouched) and high cover. */
const CROUCH_TORSO = 0.77;
const STAND_TORSO = 1.26;

/** Candidates scored per evaluation. Bounds the raycast spike on one tick. */
const MAX_SCORED = 16;

/**
 * Vertical reach, metres. A cover point further above or below the bot than this is on
 * another level and is not "two metres away" however close it looks from overhead — the
 * grey-box pit floor and the alcove shelf are both within a metre of open floor in plan.
 */
const MAX_HEIGHT_DELTA = 1.6;

const candidateIndex = new Int32Array(MAX_SCORED);
const candidateDist = new Float64Array(MAX_SCORED);

export class CoverIndex {
  readonly slots: CoverSlot[] = [];
  /** Authored points the navmesh rejected. Reported at load so bad data is visible. */
  readonly rejected: number;

  constructor(points: readonly CoverPoint[], nav: NavGrid) {
    let rejected = 0;
    for (const p of points) {
      // By height, not just in plan: Foundry's catwalk railings are cover four metres
      // above cover that is also authored on the floor below them, and a lookup that only
      // knows where a point is in plan would silently move one onto the other.
      const cell = nav.cellAtY(p.position.x, p.position.y, p.position.z);
      if (cell < 0) {
        rejected++;
        continue;
      }
      this.slots.push({
        x: nav.centerX(nav.indexOfX(cell)),
        y: nav.heightAt(cell),
        z: nav.centerZ(nav.indexOfZ(cell)),
        facingYaw: p.facingYaw,
        height: p.height,
        cellIndex: cell,
        occupantId: -1,
      });
    }
    this.rejected = rejected;
  }

  get count(): number {
    return this.slots.length;
  }

  get occupiedCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.occupantId >= 0) n++;
    return n;
  }

  /** Drop every claim held by one bot. Called on death, respawn and state change. */
  release(occupantId: number): void {
    for (const slot of this.slots) {
      if (slot.occupantId === occupantId) slot.occupantId = -1;
    }
  }

  claim(slotIndex: number, occupantId: number): void {
    const slot = this.slots[slotIndex];
    if (slot === undefined) return;
    this.release(occupantId);
    slot.occupantId = occupantId;
  }

  releaseAll(): void {
    for (const slot of this.slots) slot.occupantId = -1;
  }

  /**
   * Best cover slot for a bot at `(x, y, z)` hiding from a threat at `(tx, ty, tz)`, or
   * -1 when nothing within `maxRange` actually breaks the line.
   *
   * Nearest candidates are scored first and the rest are not scored at all — a bot does
   * not need the globally optimal piece of cover, it needs a good one this tick.
   */
  select(
    botId: number,
    x: number,
    y: number,
    z: number,
    tx: number,
    ty: number,
    tz: number,
    maxRange: number,
    perception: Perception,
  ): number {
    const nearest = this.gatherNearest(botId, x, y, z, maxRange);
    if (nearest === 0) return -1;

    let best = -1;
    let bestScore = -Infinity;

    for (let k = 0; k < nearest; k++) {
      const index = candidateIndex[k] ?? -1;
      const slot = this.slots[index];
      if (slot === undefined) continue;

      const toThreatX = tx - slot.x;
      const toThreatZ = tz - slot.z;
      const threatDist = Math.hypot(toThreatX, toThreatZ);
      if (threatDist < 1.5) continue;

      // The cover has to be oriented against the threat, not merely near it.
      const fx = -Math.sin(slot.facingYaw);
      const fz = -Math.cos(slot.facingYaw);
      const facing = (toThreatX * fx + toThreatZ * fz) / threatDist;
      if (facing < 0.15) continue;

      // The test that matters: standing here, can the threat see me?
      const torso = slot.height === 'low' ? CROUCH_TORSO : STAND_TORSO;
      if (perception.clearLine(tx, ty, tz, slot.x, slot.y + torso, slot.z)) continue;

      // Close to me, still facing the fight, and not so far from the threat that taking
      // it means leaving the engagement entirely.
      const myDist = candidateDist[k] ?? 0;
      const score =
        30 - myDist * 1.6 + facing * 8 - Math.abs(threatDist - 12) * 0.35 + (slot.height === 'high' ? 2 : 0);
      if (score <= bestScore) continue;
      bestScore = score;
      best = index;
    }

    return best;
  }

  /** Nearest free slots within range, unsorted beyond "these are the closest few". */
  private gatherNearest(botId: number, x: number, y: number, z: number, maxRange: number): number {
    let count = 0;
    let worst = Infinity;
    let worstAt = -1;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot === undefined) continue;
      if (slot.occupantId >= 0 && slot.occupantId !== botId) continue;
      if (Math.abs(slot.y - y) > MAX_HEIGHT_DELTA) continue;
      const dist = Math.hypot(slot.x - x, slot.z - z);
      if (dist > maxRange) continue;

      if (count < MAX_SCORED) {
        candidateIndex[count] = i;
        candidateDist[count] = dist;
        count++;
        if (count === MAX_SCORED) {
          worst = -Infinity;
          worstAt = -1;
          for (let k = 0; k < count; k++) {
            const d = candidateDist[k] ?? 0;
            if (d > worst) {
              worst = d;
              worstAt = k;
            }
          }
        }
        continue;
      }

      if (dist >= worst || worstAt < 0) continue;
      candidateIndex[worstAt] = i;
      candidateDist[worstAt] = dist;
      // Re-find the worst slot; the array is 16 long so this is cheaper than a heap.
      worst = -Infinity;
      worstAt = -1;
      for (let k = 0; k < count; k++) {
        const d = candidateDist[k] ?? 0;
        if (d > worst) {
          worst = d;
          worstAt = k;
        }
      }
    }
    return count;
  }

  /**
   * A position beside `slot` from which the threat *can* be seen — the peek.
   *
   * Cover you cannot shoot from is a corner to hide in, and a bot that only hides is not
   * worth fighting. The peek offset is lateral, along the cover's own face, so leaning out
   * puts the bot at the edge of the object rather than in front of it.
   */
  peekOffsetX(slotIndex: number, side: number): number {
    const slot = this.slots[slotIndex];
    if (slot === undefined) return 0;
    return Math.cos(slot.facingYaw) * side;
  }

  peekOffsetZ(slotIndex: number, side: number): number {
    const slot = this.slots[slotIndex];
    if (slot === undefined) return 0;
    return -Math.sin(slot.facingYaw) * side;
  }
}
