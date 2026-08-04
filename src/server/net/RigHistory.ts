import type { HitboxRig } from '../../shared/combat/HitboxRig';

/**
 * One second of a `HitboxRig`'s transforms (M10, S4.13).
 *
 * S4.13: *"Every entity keeps a ring buffer of its `HitboxRig` transforms for the last 1.0 s
 * (60 ticks). The M2 rig is already oriented boxes; store its history, do not invent a second
 * representation."*
 *
 * That last clause is the design. A rig is fully described by five numbers — position, yaw
 * and the stance compression — because `HitboxRig` is a shared `RigLayout` plus a transform.
 * So the history is five `Float32Array`s and rewinding is writing five numbers back, not
 * reconstructing a body. Everything M2 verified about zones and multipliers keeps applying,
 * because the boxes being tested are the same boxes.
 *
 * ## Why the tick is stored alongside
 *
 * The ring index is `tick % 60`, so a slot is unambiguous only if the tick that wrote it is
 * recorded. Without it, a rewind of exactly 60 ticks would silently read the *current* pose
 * and report a clean lag compensation that did nothing. Storing the tick turns that into a
 * detectable miss, which is what the 200 ms cap then makes unreachable anyway — belt and
 * braces, and the braces are two bytes.
 */

/** Ticks retained. 60 at 60 Hz is the 1.0 s S4.13 asks for. */
export const HISTORY_TICKS = 60;

export class RigHistory {
  private readonly x = new Float32Array(HISTORY_TICKS);
  private readonly y = new Float32Array(HISTORY_TICKS);
  private readonly z = new Float32Array(HISTORY_TICKS);
  private readonly yaw = new Float32Array(HISTORY_TICKS);
  private readonly scale = new Float32Array(HISTORY_TICKS);
  private readonly tick = new Int32Array(HISTORY_TICKS).fill(-1);

  /** Most recent tick written, or -1. */
  private newest = -1;

  /** Record the rig's current transform for `tick`. Called once per tick per entity. */
  push(rig: HitboxRig, tick: number): void {
    const i = index(tick);
    this.x[i] = rig.x;
    this.y[i] = rig.y;
    this.z[i] = rig.z;
    this.yaw[i] = rig.yaw;
    this.scale[i] = rig.heightScale;
    this.tick[i] = tick;
    if (tick > this.newest) this.newest = tick;
  }

  /**
   * Write the current transform into every slot.
   *
   * Called on spawn. Without it the buffer holds either nothing or the previous life's
   * positions, and a shot rewound into that window resolves against a body that is not there
   * — which at best misses and at worst hits a corpse's last position across the map.
   */
  fill(rig: HitboxRig, tick: number): void {
    for (let i = 0; i < HISTORY_TICKS; i++) {
      this.x[i] = rig.x;
      this.y[i] = rig.y;
      this.z[i] = rig.z;
      this.yaw[i] = rig.yaw;
      this.scale[i] = rig.heightScale;
      this.tick[i] = tick;
    }
    this.newest = tick;
  }

  /** True if this history holds the given tick. */
  has(tick: number): boolean {
    return this.tick[index(tick)] === tick;
  }

  /**
   * Move `rig` to where it was on `tick`. Returns false if that tick is not held, in which
   * case the rig is left exactly as it was — the caller then resolves against the present,
   * which is the correct degradation: no lag compensation is strictly better than
   * compensation to a pose that was never real.
   */
  applyAt(rig: HitboxRig, tick: number): boolean {
    const i = index(tick);
    if (this.tick[i] !== tick) return false;
    rig.heightScale = this.scale[i] ?? 1;
    rig.setTransform(this.x[i] ?? 0, this.y[i] ?? 0, this.z[i] ?? 0, this.yaw[i] ?? 0);
    return true;
  }
}

function index(tick: number): number {
  return ((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
}

/** A rig transform held aside while a rewind is in effect. */
export interface RigSnapshot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

export function makeRigSnapshot(): RigSnapshot {
  return { x: 0, y: 0, z: 0, yaw: 0, scale: 1 };
}

export function saveRig(rig: HitboxRig, out: RigSnapshot): void {
  out.x = rig.x;
  out.y = rig.y;
  out.z = rig.z;
  out.yaw = rig.yaw;
  out.scale = rig.heightScale;
}

export function restoreRig(src: RigSnapshot, rig: HitboxRig): void {
  rig.heightScale = src.scale;
  rig.setTransform(src.x, src.y, src.z, src.yaw);
}
