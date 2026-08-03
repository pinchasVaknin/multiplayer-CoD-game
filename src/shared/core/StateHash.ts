/**
 * A hash of simulation state, identical in every runtime that runs the simulation (M9, S6.6).
 *
 * ## Why the bits, and not a rounded value
 *
 * The obvious implementation quantises — round positions to a millimetre, then hash. That
 * would hide exactly the bug this tool exists to find. A divergence starts in the last bits
 * of a float and takes hundreds of ticks to grow past a millimetre; by the time a quantised
 * hash noticed, the first divergent tick would be long past and the report would point at the
 * wrong code.
 *
 * So this hashes the **raw IEEE 754 bytes**. Two runtimes agree or they do not, on the tick
 * they first disagree.
 *
 * That is a fair test rather than an impossible one: both targets are V8, arithmetic on
 * doubles is exactly specified by IEEE 754, and V8's `Math.sin`/`cos`/`exp`/`pow` have used
 * a deterministic fdlibm port since V8 5.x rather than the platform libm. A difference here
 * is a difference in the *program*, which is the question being asked.
 *
 * FNV-1a, 32-bit: no dependencies, no allocation per update, and a single `Math.imul` per
 * byte. It is not cryptographic and does not need to be — it is detecting drift, not
 * resisting an adversary.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Module-level scratch, reused across every update.
 *
 * S4.7 bans allocation in the per-tick path, and this runs in it. One `DataView` over one
 * eight-byte buffer serves the whole process.
 */
const scratch = new ArrayBuffer(8);
const scratchView = new DataView(scratch);

export class StateHasher {
  private h = FNV_OFFSET;

  reset(): void {
    this.h = FNV_OFFSET;
  }

  /**
   * Fold in a double, by its bytes.
   *
   * Little-endian explicitly, so the hash does not depend on the host's byte order — which
   * would make the tool report a divergence between two correct runs on different machines.
   */
  float(v: number): void {
    scratchView.setFloat64(0, v, true);
    let h = this.h;
    for (let i = 0; i < 8; i++) {
      h ^= scratchView.getUint8(i);
      h = Math.imul(h, FNV_PRIME);
    }
    this.h = h >>> 0;
  }

  /** Fold in a 32-bit integer. Cheaper than `float` and exact for tick indices and counters. */
  int(v: number): void {
    let h = this.h;
    const n = v | 0;
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (i * 8)) & 0xff;
      h = Math.imul(h, FNV_PRIME);
    }
    this.h = h >>> 0;
  }

  bool(v: boolean): void {
    this.int(v ? 1 : 0);
  }

  /** Fold in a short ASCII string — a stance name, a weapon id. */
  str(v: string): void {
    let h = this.h;
    for (let i = 0; i < v.length; i++) {
      h ^= v.charCodeAt(i) & 0xff;
      h = Math.imul(h, FNV_PRIME);
    }
    this.h = h >>> 0;
  }

  /** The hash so far, as eight lowercase hex digits. Stable across runtimes. */
  get hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }

  get value(): number {
    return this.h >>> 0;
  }
}
