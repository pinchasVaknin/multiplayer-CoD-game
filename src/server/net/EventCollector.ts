import { hitsFrom } from '../../shared/combat/ShotAccounting';
import { EV, type GameBus } from '../../shared/core/Events';
import {
  beginEvents,
  finishEvents,
  writeDamage,
  writeFired,
  writeFootstep,
  writeKilled,
  writePose,
  Ev,
  type DamageEvent,
  type FiredEvent,
  type FootstepEvent,
  type KilledEvent,
  type PoseEvent,
} from '../../shared/net/Messages';
import { MAX_SERVER_FRAME_BYTES } from '../../shared/net/Protocol';
import { weaponIndexOf } from '../../shared/net/Snapshot';
import { ByteWriter } from '../../shared/net/Wire';

/**
 * Turns the authoritative `EventBus` into the replicated event stream (M10, S4.15).
 *
 * S4.15 draws the line this class implements: *"Cosmetics are driven by replicated events,
 * not by replicated state. The server says `damage.dealt`; the client decides what that looks
 * and sounds like."*
 *
 * So the server sends **what happened**, and never what it looked like. A `Fired` goes out;
 * the muzzle flash, the tracer, the shell ejection, the camera shake and the impact decal do
 * not, because every one of them is a decision the client makes about how to draw an event it
 * has been told about. S3 puts the same thing another way — *"A networked event and a local
 * one must be indistinguishable to the client"* — and that is exactly what makes this work:
 * the client already has code that turns `weapon.fired` into a flash and a bang, and it does
 * not care whether the bus entry came from its own weapon or from a socket.
 *
 * ## Why bullet impacts are not on the wire
 *
 * They were the obvious candidate and they are deliberately absent. `Fired` carries the
 * round's terminus and the material it stopped in, which is everything the client needs to
 * draw the tracer, the spark and the decal itself. Replicating a separate impact per pellet
 * would put eight events on the wire for one shotgun blast to produce marks nobody is looking
 * at. The one approximation this accepts: a shotgun's spread is drawn from the first pellet's
 * terminus, so the pattern on a wall is synthesised rather than exact.
 */

/** One tick's worth of events, encoded once and sent to every client. */
export class EventCollector {
  private readonly writer = new ByteWriter(MAX_SERVER_FRAME_BYTES);
  private count = 0;
  private open = false;
  private overflowNoted = false;

  /** Events written this tick. Zero means there is nothing to send. */
  get pending(): number {
    return this.count;
  }

  /**
   * Subscribe to the authoritative bus.
   *
   * Returns the unsubscribe list, which the match owns: a collector that outlived its match
   * would keep a dead bus alive and, worse, keep writing events into a frame nobody sends.
   */
  subscribe(bus: GameBus): Array<() => void> {
    const off: Array<() => void> = [];

    off.push(
      bus.on(EV.WeaponFired, (p) => {
        fired.sourceId = p.sourceId;
        fired.weaponIndex = weaponIndexOf(p.weaponId);
        fired.x = p.x;
        fired.y = p.y;
        fired.z = p.z;
        fired.endX = p.endX;
        fired.endY = p.endY;
        fired.endZ = p.endZ;
        // The material the round stopped in is carried by the impact, not the shot, so it is
        // resolved from the last impact this tick — see `noteImpactMaterial`.
        fired.material = lastImpactMaterial;
        fired.tracer = p.tracer;
        // The count, not the bit (protocol v14, round 5 B5). A client's accuracy column is
        // built from this event and nothing else, so it has to carry what actually connected.
        fired.pelletsHit = hitsFrom(p);
        this.write(() => writeFired(this.writer, fired));
      }),
    );

    off.push(
      bus.on(EV.BulletImpact, (p) => {
        // Not replicated on its own. It is captured so the *next* `weapon.fired` in this
        // tick can carry the surface it hit, which is what the client needs for the spark
        // colour and the impact click. Ballistics emits the impact before the fired event.
        lastImpactMaterial = p.material;
      }),
    );

    off.push(
      bus.on(EV.DamageDealt, (p) => {
        damage.sourceId = p.sourceId;
        damage.targetId = p.targetId;
        damage.amount = p.amount;
        damage.zone = p.zone;
        damage.lethal = p.lethal;
        damage.x = p.x;
        damage.y = p.y;
        damage.z = p.z;
        this.write(() => writeDamage(this.writer, damage));
      }),
    );

    off.push(
      bus.on(EV.EntityKilled, (p) => {
        killed.targetId = p.targetId;
        killed.sourceId = p.sourceId;
        killed.weaponIndex = weaponIndexOf(p.weaponId);
        killed.zone = p.zone;
        this.write(() => writeKilled(this.writer, killed));
      }),
    );

    off.push(
      bus.on(EV.PlayerFootstep, (p) => {
        footstep.entityId = p.entityId;
        footstep.x = p.x;
        footstep.y = p.y;
        footstep.z = p.z;
        footstep.material = p.material;
        footstep.heavy = p.heavy;
        footstep.quiet = p.quiet;
        this.write(() => writeFootstep(this.writer, footstep));
      }),
    );

    off.push(
      bus.on(EV.PlayerJumped, (p) => {
        pose.entityId = p.entityId;
        pose.x = p.x;
        pose.y = p.y;
        pose.z = p.z;
        pose.speed = p.horizontalSpeed;
        pose.material = 0;
        this.write(() => writePose(this.writer, Ev.Jump, pose));
      }),
    );

    off.push(
      bus.on(EV.PlayerLanded, (p) => {
        pose.entityId = p.entityId;
        pose.x = p.x;
        pose.y = p.y;
        pose.z = p.z;
        pose.speed = p.impactSpeed;
        pose.material = p.material;
        this.write(() => writePose(this.writer, Ev.Land, pose));
      }),
    );

    return off;
  }

  /** Start a fresh frame. Called at the top of every tick. */
  begin(): void {
    beginEvents(this.writer);
    this.count = 0;
    this.open = true;
    this.overflowNoted = false;
  }

  /**
   * Seal the frame and return it, or null when nothing happened.
   *
   * Most ticks in a match are silent — nobody fires, nobody lands, nobody takes a step — and
   * returning null for those is what keeps the event channel near-free at idle rather than
   * costing a five-byte frame per client per tick forever.
   */
  finish(): Uint8Array | null {
    this.open = false;
    if (this.count === 0) return null;
    return finishEvents(this.writer, this.count);
  }

  private write(fn: () => void): void {
    if (!this.open) return;
    // 255 is the count field's ceiling. A tick that produced more than that is a tick with
    // something badly wrong in it, and truncating is better than a count that lies.
    if (this.count >= 255) return;
    fn();
    if (this.writer.overflowed) {
      // Stop adding. The frame is sealed at whatever fitted, and the count matches, so it
      // still decodes — it is simply short. Losing a footstep beats losing the frame.
      if (!this.overflowNoted) this.overflowNoted = true;
      this.open = false;
      return;
    }
    this.count++;
  }
}

/**
 * Material of the most recent bullet impact this tick.
 *
 * Module-level because `Ballistics` emits `bullet.impact` immediately before the
 * `weapon.fired` that owns it, and threading a field through two unrelated bus subscriptions
 * to carry one byte between them would be worse than saying so here.
 */
let lastImpactMaterial = 0;

const fired: FiredEvent = {
  sourceId: 0,
  weaponIndex: 0,
  x: 0,
  y: 0,
  z: 0,
  endX: 0,
  endY: 0,
  endZ: 0,
  material: 0,
  tracer: false,
  pelletsHit: 0,
};
const damage: DamageEvent = {
  sourceId: 0,
  targetId: 0,
  amount: 0,
  zone: 'torso',
  lethal: false,
  x: 0,
  y: 0,
  z: 0,
};
const killed: KilledEvent = { targetId: 0, sourceId: 0, weaponIndex: 0, zone: 'torso' };
const footstep: FootstepEvent = {
  entityId: 0,
  x: 0,
  y: 0,
  z: 0,
  material: 0,
  heavy: false,
  quiet: false,
};
const pose: PoseEvent = { entityId: 0, x: 0, y: 0, z: 0, speed: 0, material: 0 };
