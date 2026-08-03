import { DT } from '../core/Loop';
import { TAU } from '../core/MathUtil';
import { Killstreak } from './KillstreakBase';

/**
 * UAV (brief S6.1): enemies pinged on the minimap for 30 s, **sweeping rather than continuous**.
 *
 * The sweep is the whole point and it is not decoration. A continuous read-out tells the player
 * where everybody is, forever, which removes the thing that makes a UAV interesting — you get a
 * *snapshot* every revolution and have to decide how stale it is. So the streak owns a rotating
 * bearing and a per-contact age, and the minimap draws a contact at the position it had when the
 * beam last crossed it, fading out over `uavContactFadeSeconds`.
 *
 * **Ghost is answered here.** `ctx.visibleToUav` is the M6 hook, and a contact that fails it is
 * simply never recorded — so the perk is invisible to this class, which does not know a perk
 * exists, and invisible to the minimap, which only ever sees recorded contacts.
 *
 * The contact array is allocated once at activation and reused; the sweep runs in the sim tick
 * and allocates nothing.
 */

export interface UavContact {
  entityId: number;
  x: number;
  z: number;
  /** Seconds since the beam crossed this contact. Drives the fade. */
  age: number;
  active: boolean;
}

export class Uav extends Killstreak {
  /** Bearing of the sweep line, radians. Read by the minimap to draw the beam. */
  sweepAngle = 0;

  /** Last known enemy positions. Written by the sweep, read by the HUD. */
  readonly contacts: UavContact[] = [];

  private previousAngle = 0;

  override onActivate(): void {
    for (const c of this.ctx.roster) {
      this.contacts.push({ entityId: c.entityId, x: 0, z: 0, age: Infinity, active: false });
    }
    this.ctx.present.uavSweep(0);
  }

  override onTick(_tick: number): boolean {
    this.age += DT;
    this.previousAngle = this.sweepAngle;
    this.sweepAngle = (this.sweepAngle + (TAU / this.ctx.cfg.uavSweepSeconds) * DT) % TAU;

    // A revolution wrapped: that is one audible sweep.
    if (this.sweepAngle < this.previousAngle) this.ctx.present.uavSweep(this.age);

    for (const contact of this.contacts) contact.age += DT;

    // Record anything the beam crossed this tick. The beam is a bearing from the map centre,
    // so "crossed" is the angular interval [previous, current] containing the contact.
    for (const c of this.ctx.roster) {
      if (c.team === this.ownerTeam || !c.participating) continue;
      // Ghost (M6). The contact is never recorded, so nothing downstream has to filter.
      if (!this.ctx.visibleToUav(c.entityId)) continue;
      const bearing = normalise(Math.atan2(c.pz, c.px));
      if (!crossed(this.previousAngle, this.sweepAngle, bearing)) continue;
      const slot = this.contactFor(c.entityId);
      if (slot === undefined) continue;
      slot.x = c.px;
      slot.z = c.pz;
      slot.age = 0;
      slot.active = true;
    }

    // Age contacts out so a dead enemy does not leave a permanent dot.
    for (const contact of this.contacts) {
      if (contact.age > this.ctx.cfg.uavContactFadeSeconds) contact.active = false;
    }

    return this.age < this.def.durationSeconds;
  }

  override onExpire(): void {
    for (const contact of this.contacts) contact.active = false;
    this.contacts.length = 0;
  }

  override describe(): string {
    let lit = 0;
    for (const c of this.contacts) if (c.active) lit++;
    return `UAV ${this.secondsRemaining.toFixed(1)}s · sweep ${((this.sweepAngle * 180) / Math.PI).toFixed(0)}° · ${lit} contacts`;
  }

  private contactFor(entityId: number): UavContact | undefined {
    for (const c of this.contacts) if (c.entityId === entityId) return c;
    return undefined;
  }
}

function normalise(angle: number): number {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

/** Whether `target` lies in the swept interval, handling the wrap at TAU. */
function crossed(from: number, to: number, target: number): boolean {
  if (from <= to) return target >= from && target <= to;
  return target >= from || target <= to;
}
