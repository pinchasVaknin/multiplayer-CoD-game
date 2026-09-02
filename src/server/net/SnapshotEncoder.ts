import {
  copyEntitySnapshot,
  makeEntitySnapshot,
  type EntitySnapshot,
} from '../../shared/net/Snapshot';
import type { PlayerSimState } from '../../shared/player/PlayerState';
import { MAX_SERVER_FRAME_BYTES } from '../../shared/net/Protocol';
import {
  writeSnapshotEntities,
  writeSnapshotHeader,
  writeSnapshotOwner,
  type SnapshotHeader,
} from '../../shared/net/Messages';
import { ByteWriter } from '../../shared/net/Wire';
import { BASELINE_HISTORY } from './Session';

/**
 * Builds one client's snapshot, delta-compressed against what that client last acked
 * (M10, S4.12).
 *
 * ## Why the baseline is per client and not per server tick
 *
 * S4.12 says deltas are *"against the last snapshot the client acked"*, and the acks are
 * per client because the links are. Two players on a 20 ms and a 180 ms connection are
 * acknowledging snapshots four frames apart at any given moment; a single shared baseline
 * would be wrong for at least one of them, and "wrong baseline" in a delta scheme does not
 * mean slightly stale — it means every unsent field decodes to a value from a different
 * moment, and the player appears somewhere they have never been.
 *
 * So each encoder keeps its own ring of the last 32 snapshots it sent. An ack names one of
 * them; if it is still in the ring, it is the baseline, and if it is not — a client that has
 * gone quiet for half a second — the next snapshot is sent in full. A full snapshot is
 * perhaps 400 bytes and costs nothing occasionally; a *wrong* delta costs correctness.
 */

interface Frame {
  id: number;
  /** Entity id -> the state that was sent for it in this frame. */
  readonly entities: Map<number, EntitySnapshot>;
}

export interface EncodeStats {
  /** Bytes in the last snapshot written. */
  lastBytes: number;
  /** Snapshots written since process start. */
  count: number;
  /** Sum of bytes, for the mean. */
  totalBytes: number;
  /** Snapshots sent in full because no usable baseline was available. */
  fullSnapshots: number;
}

export class SnapshotEncoder {
  readonly stats: EncodeStats = { lastBytes: 0, count: 0, totalBytes: 0, fullSnapshots: 0 };

  private readonly frames: Frame[] = [];
  private readonly writer = new ByteWriter(MAX_SERVER_FRAME_BYTES);
  private readonly pool: EntitySnapshot[] = [];
  private nextId = 1;

  /** Entities this client was told about that are no longer present. */
  private readonly removed: number[] = [];

  /** Ids present in the frame currently being built, to detect removals. */
  private readonly present = new Set<number>();

  constructor() {
    for (let i = 0; i < BASELINE_HISTORY; i++) {
      this.frames.push({ id: 0, entities: new Map() });
    }
  }

  get meanBytes(): number {
    return this.stats.count === 0 ? 0 : this.stats.totalBytes / this.stats.count;
  }

  /**
   * Encode a snapshot for this client.
   *
   * `ackedId` is the newest snapshot the client has confirmed. Zero, or an id that has aged
   * out of the ring, produces a full snapshot.
   *
   * The returned view is valid until the next call — it is the encoder's own buffer, and the
   * link copies it on the way out.
   */
  encode(
    header: SnapshotHeader,
    ackedId: number,
    owner: PlayerSimState | null,
    entities: readonly EntitySnapshot[],
    count: number,
    /** This seat's cheat entitlements (playtest round 4, F14). See `writeSnapshotOwner`. */
    cheatMask: number,
  ): Uint8Array {
    const id = this.nextId;
    // Ids wrap at 16 bits and zero is reserved to mean "no baseline", so it is skipped.
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;

    const baselineFrame = ackedId === 0 ? null : this.findFrame(ackedId);
    if (baselineFrame === null) this.stats.fullSnapshots++;

    header.snapshotId = id;
    header.baselineId = baselineFrame === null ? 0 : baselineFrame.id;

    // Anything the baseline knew about that is not here any more is a removal. Sending it
    // explicitly is what stops a disconnected player leaving a ghost body standing on the
    // map — S8.11 tests exactly this, and "the client eventually times it out" is not an
    // answer when the client has no way to distinguish gone from merely unchanged.
    this.removed.length = 0;
    this.present.clear();
    for (let i = 0; i < count; i++) {
      const e = entities[i];
      if (e !== undefined) this.present.add(e.entityId);
    }
    if (baselineFrame !== null) {
      for (const id2 of baselineFrame.entities.keys()) {
        if (!this.present.has(id2)) this.removed.push(id2);
      }
    }

    const w = this.writer;
    writeSnapshotHeader(w, header);
    writeSnapshotOwner(w, owner, cheatMask);
    writeSnapshotEntities(
      w,
      entities,
      count,
      (entityId) => baselineFrame?.entities.get(entityId) ?? null,
      this.removed,
      this.removed.length,
    );

    // An overflowed frame is a prefix of the intended one and would decode as garbage. It
    // cannot happen at ten entities with this buffer, but "cannot happen" is exactly the
    // class of thing that eventually does, and a dropped snapshot is recoverable where a
    // corrupt one is not.
    if (w.overflowed) {
      this.stats.lastBytes = 0;
      return EMPTY;
    }

    this.store(id, entities, count);

    const bytes = w.bytes();
    this.stats.lastBytes = bytes.length;
    this.stats.totalBytes += bytes.length;
    this.stats.count++;
    return bytes;
  }

  private findFrame(id: number): Frame | null {
    for (const f of this.frames) if (f.id === id) return f;
    return null;
  }

  /** Record what was sent, so a later ack naming this id can be used as a baseline. */
  private store(id: number, entities: readonly EntitySnapshot[], count: number): void {
    // Oldest slot: the ring is small and scanning it is cheaper than tracking a head that
    // has to stay correct across the wrap.
    let slot = this.frames[0];
    if (slot === undefined) return;
    for (const f of this.frames) if (f.id < slot.id) slot = f;

    for (const rec of slot.entities.values()) this.pool.push(rec);
    slot.entities.clear();
    slot.id = id;

    for (let i = 0; i < count; i++) {
      const e = entities[i];
      if (e === undefined) continue;
      const rec = this.pool.pop() ?? makeEntitySnapshot();
      copyEntitySnapshot(e, rec);
      slot.entities.set(e.entityId, rec);
    }
  }
}

const EMPTY = new Uint8Array(0);
