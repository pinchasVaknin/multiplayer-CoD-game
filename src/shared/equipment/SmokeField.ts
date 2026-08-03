import type { SightOccluder } from '../ai/Perception';
import { DT } from '../core/Loop';
import { clamp01 } from '../core/MathUtil';
import type { EquipmentConfig } from './EquipmentConfig';

/**
 * Smoke that actually blocks line of sight (brief S6.3).
 *
 * The brief is explicit that this must not be a visual effect only: it has to feed the M3
 * perception raycast **as a density-based occluder**. So `blocksSight` does not ask "does
 * this segment touch a sphere" — it integrates the length of segment that lies *inside*
 * each live cloud, weights it by that cloud's current density, and compares the total
 * against a threshold.
 *
 * That distinction is what makes the mechanic behave: clipping the very edge of a cloud
 * does not hide you, standing in the middle does, and two half-grown clouds in a row add
 * up to one that works. A sphere test gives you a hard on/off edge you can strafe across.
 *
 * Density is not uniform inside a cloud either. It falls off toward the rim, so the
 * segment integration uses the chord's *midpoint* radius as a weight — cheap, and it means
 * a glancing chord through the outer shell contributes far less than a diameter.
 */

export interface SmokeVolume {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Full radius once bloomed, metres. */
  radius: number;
  /** Seconds of life remaining. */
  remaining: number;
  /** Total authored life, for the bloom and fade curves. */
  total: number;
  /** Seconds the cloud takes to reach full size. */
  bloom: number;
  age: number;
}

/** Below this, a cloud is a wisp and neither blocks nor draws. */
const MIN_DENSITY = 0.05;

export class SmokeField implements SightOccluder {
  readonly volumes: SmokeVolume[] = [];

  /** Diagnostics: segments this field rejected since the last reset (S7). */
  blockedQueries = 0;
  totalQueries = 0;

  constructor(
    capacity: number,
    private readonly cfg: EquipmentConfig,
  ) {
    for (let i = 0; i < capacity; i++) {
      this.volumes.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        radius: 0,
        remaining: 0,
        total: 1,
        bloom: 1,
        age: 0,
      });
    }
  }

  get liveCount(): number {
    let n = 0;
    for (const v of this.volumes) if (v.active) n++;
    return n;
  }

  spawn(x: number, y: number, z: number, radius: number, seconds: number, bloom: number): SmokeVolume | null {
    for (const v of this.volumes) {
      if (v.active) continue;
      v.active = true;
      v.x = x;
      v.y = y;
      v.z = z;
      v.radius = radius;
      v.remaining = seconds;
      v.total = seconds;
      v.bloom = Math.max(bloom, 1e-3);
      v.age = 0;
      return v;
    }
    return null;
  }

  clear(): void {
    for (const v of this.volumes) v.active = false;
  }

  resetStats(): void {
    this.blockedQueries = 0;
    this.totalQueries = 0;
  }

  /** One sim tick. Clouds bloom, hold, then thin out. */
  step(): void {
    for (const v of this.volumes) {
      if (!v.active) continue;
      v.age += DT;
      v.remaining -= DT;
      if (v.remaining <= 0) v.active = false;
    }
  }

  /**
   * 0..1 density right now. Grows over `bloom`, holds, and thins over the last quarter of
   * its life — a cloud that vanished at full opacity would make the "smoke cleared" moment
   * arrive a second before the picture agreed.
   */
  density(v: SmokeVolume): number {
    const grow = clamp01(v.age / v.bloom);
    const fadeStart = v.total * 0.25;
    const fade = v.remaining >= fadeStart ? 1 : clamp01(v.remaining / Math.max(fadeStart, 1e-3));
    return grow * fade;
  }

  /** Current drawn radius, which grows with the bloom. */
  currentRadius(v: SmokeVolume): number {
    return v.radius * (0.35 + 0.65 * clamp01(v.age / v.bloom));
  }

  /**
   * Optical depth accumulated along a segment, in arbitrary units.
   *
   * Exposed separately from `blocksSight` so the debug visualisation can colour a ray by
   * *how* obscured it is rather than by a boolean, and so the acceptance measurement can
   * report a number instead of a yes/no.
   */
  opticalDepth(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return 0;
    const inv = 1 / len;
    const ux = dx * inv;
    const uy = dy * inv;
    const uz = dz * inv;

    let depth = 0;
    for (const v of this.volumes) {
      if (!v.active) continue;
      const d = this.density(v);
      if (d < MIN_DENSITY) continue;
      const r = this.currentRadius(v);

      // Segment vs sphere: solve for the chord, clamped to the segment's own ends.
      const mx = ax - v.x;
      const my = ay - v.y;
      const mz = az - v.z;
      const b = mx * ux + my * uy + mz * uz;
      const c = mx * mx + my * my + mz * mz - r * r;
      const disc = b * b - c;
      if (disc <= 0) continue;
      const root = Math.sqrt(disc);
      let t0 = -b - root;
      let t1 = -b + root;
      if (t1 <= 0 || t0 >= len) continue;
      if (t0 < 0) t0 = 0;
      if (t1 > len) t1 = len;
      const chord = t1 - t0;
      if (chord <= 0) continue;

      // Weight by how central the chord is. A grazing chord passes through the thin rim.
      const mid = (t0 + t1) * 0.5;
      const cx = ax + ux * mid - v.x;
      const cy = ay + uy * mid - v.y;
      const cz = az + uz * mid - v.z;
      const offset = Math.hypot(cx, cy, cz) / r;
      const shell = Math.max(0, 1 - offset * offset);

      depth += chord * d * shell * this.cfg.smokeDepthScale;
    }
    return depth;
  }

  /** The `SightOccluder` contract the M3 perception raycast consumes. */
  blocksSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    this.totalQueries++;
    // Fast out for the overwhelmingly common case: no smoke on the map at all.
    let any = false;
    for (const v of this.volumes) {
      if (v.active) {
        any = true;
        break;
      }
    }
    if (!any) return false;

    const blocked = this.opticalDepth(ax, ay, az, bx, by, bz) >= this.cfg.smokeBlockDepth;
    if (blocked) this.blockedQueries++;
    return blocked;
  }
}
