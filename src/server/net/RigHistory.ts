import { HUMANOID_RIG, type HitboxRig, type RigLayout } from '../../shared/combat/HitboxRig';

/**
 * One second of a `HitboxRig`'s transforms (M10, S4.13).
 *
 * S4.13: *"Every entity keeps a ring buffer of its `HitboxRig` transforms for the last 1.0 s
 * (60 ticks). The M2 rig is already oriented boxes; store its history, do not invent a second
 * representation."*
 *
 * That last clause is the design. A rig is fully described by four numbers and a choice —
 * position, yaw and which of the shared `RigLayout`s it wears — because `HitboxRig` is a
 * layout plus a transform. So the history is four `Float32Array`s and one array of layout
 * references, and rewinding is writing them back, not reconstructing a body. Everything M2
 * verified about zones and multipliers keeps applying, because the boxes being tested are
 * the same boxes. (Until M13 C2 the fifth number was the stance compression; the layout
 * reference is the same slot, holding the pose the body was drawn in on that tick.)
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
  private readonly layout: RigLayout[] = new Array<RigLayout>(HISTORY_TICKS).fill(HUMANOID_RIG);
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
    this.layout[i] = rig.layout;
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
      this.layout[i] = rig.layout;
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
    rig.setLayout(this.layout[i] ?? HUMANOID_RIG);
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
  layout: RigLayout;
}

export function makeRigSnapshot(): RigSnapshot {
  return { x: 0, y: 0, z: 0, yaw: 0, layout: HUMANOID_RIG };
}

export function saveRig(rig: HitboxRig, out: RigSnapshot): void {
  out.x = rig.x;
  out.y = rig.y;
  out.z = rig.z;
  out.yaw = rig.yaw;
  out.layout = rig.layout;
}

export function restoreRig(src: RigSnapshot, rig: HitboxRig): void {
  rig.setLayout(src.layout);
  rig.setTransform(src.x, src.y, src.z, src.yaw);
}
