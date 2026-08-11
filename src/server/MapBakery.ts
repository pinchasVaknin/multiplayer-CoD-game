import { navBakeOptionsFor } from '../shared/ai/BotDirector';
import { nowMs } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import { MAPS, type MapEntry } from '../shared/modes/ModeRegistry';
import { DEFAULT_MOVEMENT_CONFIG, type MovementConfig } from '../shared/player/MovementConfig';
import { loadMapCollision, shareMapCollision, type LoadedCollision } from '../shared/world/MapLoader';
import { bakeNavmesh, type NavGrid } from '../shared/world/Navmesh';
import { metric } from './log';

const log = logger('bakery');

/**
 * Every map, baked once, before the first connection is accepted (M11, S4.19).
 *
 * S4.19: *"All three maps are baked once, at server boot, before the first connection is
 * accepted. `MapDef`, the static spatial hash and the navmesh are immutable, cached at process
 * level, and shared read-only across instances. Baking on demand would put bake time straight
 * into the transition the players are supposed to experience as seamless."*
 *
 * That last sentence is the whole design. §6.5 removes the loading screen by starting the
 * client's mesh build while the player is still shooting in warmup — and the server's own
 * half of a map transition has to be *nothing* for that to work. A lazy bake would be a stall
 * measured in hundreds of milliseconds landing in the middle of §6.7, on the server, where no
 * amount of client-side chunking can hide it.
 *
 * ## What is shared and what is not
 *
 * Shared, because it is immutable once built: the `ColliderSet`, the `SpatialHash` over it,
 * and the `NavGrid`. These are the two flood fills and they are the entire cost.
 *
 * Not shared, and rebuilt per instance from the shared halves: the `CollisionWorld` (it owns
 * query scratch), and every AI structure that carries reservations or an RNG stream —
 * `Pathfinder`, `CoverIndex`, `SpawnSelector`. S4.19: *"A single shared mutable object between
 * two matches is a correctness failure that will present as an unreproducible desync."*
 *
 * ## Four maps, not three
 *
 * The brief says three, and three is right for the *ballot*. The warmup arena is the M1
 * greybox room (§6.3) and it is a map like any other, so it is baked here too — a permanent
 * instance that baked its own world at boot outside this cache would be the one map whose
 * cost is invisible to the boot report.
 */

export interface BakedMap {
  readonly entry: MapEntry;
  /** Collider set + spatial hash. Immutable; `instanceView()` wraps it per instance. */
  readonly collision: LoadedCollision;
  /** The navmesh. Every array on it is filled during the bake and read-only after. */
  readonly nav: NavGrid;
  readonly collisionMs: number;
  readonly navMs: number;
  /** Bytes of typed-array storage held by this map's hash and navmesh. */
  readonly bytes: number;
}

export interface BootBakeReport {
  readonly maps: readonly {
    readonly mapId: string;
    readonly name: string;
    readonly collisionMs: number;
    readonly navMs: number;
    readonly totalMs: number;
    readonly bytes: number;
  }[];
  readonly totalMs: number;
  /** Typed-array bytes across every baked map. The number S4.19 asks to be reported. */
  readonly totalBytes: number;
  /** `process.memoryUsage().heapUsed` delta across the whole bake, bytes. */
  readonly heapDeltaBytes: number;
  readonly rssAfterBytes: number;
}

export class MapBakery {
  private readonly byId = new Map<string, BakedMap>();
  private report: BootBakeReport | null = null;

  /**
   * Bake every map in the registry. Call once, before the listener opens.
   *
   * Synchronous and deliberately so: there is nothing to overlap it with at boot, and a
   * process that accepted a connection while its maps were half-built would have to answer
   * "which maps are ready" on every allocation path forever.
   */
  bakeAll(movement: MovementConfig = DEFAULT_MOVEMENT_CONFIG): BootBakeReport {
    const heapBefore = heapUsedBytes();
    const t0 = nowMs();
    const rows: BootBakeReport['maps'][number][] = [];

    for (const entry of MAPS) {
      const c0 = nowMs();
      const collision = loadMapCollision(entry.def);
      const collisionMs = nowMs() - c0;

      const n0 = nowMs();
      const nav = bakeNavmesh(collision.collision, entry.def.navBounds, navBakeOptionsFor(entry.def, movement));
      const navMs = nowMs() - n0;

      const bytes = collisionBytes(collision) + navBytes(nav);
      this.byId.set(entry.id, { entry, collision, nav, collisionMs, navMs, bytes });

      rows.push({
        mapId: entry.id,
        name: entry.name,
        collisionMs: round(collisionMs),
        navMs: round(navMs),
        totalMs: round(collisionMs + navMs),
        bytes,
      });
      log.info(
        `${entry.name}: collision ${collisionMs.toFixed(1)}ms, navmesh ${navMs.toFixed(1)}ms, ` +
          `${(bytes / 1024 / 1024).toFixed(2)} MiB resident.`,
      );
    }

    const totalMs = nowMs() - t0;
    const report: BootBakeReport = {
      maps: rows,
      totalMs: round(totalMs),
      totalBytes: rows.reduce((sum, r) => sum + r.bytes, 0),
      heapDeltaBytes: Math.max(0, heapUsedBytes() - heapBefore),
      rssAfterBytes: rssBytes(),
    };
    this.report = report;

    log.info(
      `baked ${rows.length} maps in ${totalMs.toFixed(1)}ms — ` +
        `${(report.totalBytes / 1024 / 1024).toFixed(2)} MiB of geometry and navmesh, ` +
        `heap +${(report.heapDeltaBytes / 1024 / 1024).toFixed(2)} MiB, ` +
        `RSS ${(report.rssAfterBytes / 1024 / 1024).toFixed(0)} MiB.`,
    );
    metric('bakery', 'boot', { ...report });
    return report;
  }

  /** The boot report, or null if `bakeAll` has not run. */
  bootReport(): BootBakeReport | null {
    return this.report;
  }

  /**
   * The shared bake for a map.
   *
   * Throws on an unknown id, and should: every id reaching here has already been through
   * `findMap`, so a miss is a bug in the caller rather than bad input from a client.
   */
  get(mapId: string): BakedMap {
    const baked = this.byId.get(mapId);
    if (baked === undefined) {
      throw new Error(`map "${mapId}" was not baked at boot — MapBakery.bakeAll ran before it existed?`);
    }
    return baked;
  }

  /**
   * A per-instance view: shared geometry, private scratch.
   *
   * The one call an instance makes to get a world. Nothing else should reach for
   * `shareMapCollision` directly, so there is exactly one place that decides what is shared.
   */
  instanceView(mapId: string): { readonly collision: LoadedCollision; readonly nav: NavGrid } {
    const baked = this.get(mapId);
    return { collision: shareMapCollision(baked.collision), nav: baked.nav };
  }
}

/**
 * Typed-array bytes held by a collision bake.
 *
 * Counted rather than estimated, because S4.19 asks for the number that decides whether the
 * target host can hold all three maps and *"if that memory does not fit the target host, say
 * so and report the number"*. An estimate would not be worth reporting.
 */
function collisionBytes(loaded: LoadedCollision): number {
  let total = 0;
  for (const value of Object.values(loaded.collision.colliders)) {
    if (ArrayBuffer.isView(value)) total += value.byteLength;
  }
  for (const value of Object.values(loaded.collision.hash)) {
    if (ArrayBuffer.isView(value)) total += value.byteLength;
  }
  return total;
}

function navBytes(nav: NavGrid): number {
  let total = 0;
  for (const value of Object.values(nav)) {
    if (ArrayBuffer.isView(value)) total += value.byteLength;
  }
  return total;
}

function heapUsedBytes(): number {
  return process.memoryUsage().heapUsed;
}

function rssBytes(): number {
  return process.memoryUsage().rss;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
