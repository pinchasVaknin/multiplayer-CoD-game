/**
 * Seeded deterministic RNG (xorshift128).
 *
 * `Math.random()` is banned in gameplay code: recoil patterns, bot decisions, spread
 * and map decoration all need to be reproducible for debugging and for the eventual
 * server-authoritative path.
 */
export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number) {
    this.reseed(seed);
  }

  /** Re-key the generator. Any 32-bit integer works, including 0. */
  reseed(seed: number): void {
    // splitmix32 expansion so that low-entropy seeds (0, 1, 2...) still produce
    // well-separated states.
    let x = seed >>> 0;
    const nextState = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = nextState();
    this.s1 = nextState();
    this.s2 = nextState();
    this.s3 = nextState();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Raw 32-bit unsigned integer. */
  nextUint32(): number {
    let t = this.s3;
    const s = this.s0;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.s0 = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.s0;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Uniform in [-1, 1). */
  spread(): number {
    return this.float() * 2 - 1;
  }

  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number {
    const span = maxExclusive - minInclusive;
    if (span <= 0) return minInclusive;
    return minInclusive + Math.floor(this.float() * span);
  }

  /** Fair coin weighted by `p` (probability of true). */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** Snapshot the internal state so a sequence can be replayed. */
  saveState(out: Int32Array): void {
    out[0] = this.s0 | 0;
    out[1] = this.s1 | 0;
    out[2] = this.s2 | 0;
    out[3] = this.s3 | 0;
  }

  loadState(src: Int32Array): void {
    this.s0 = (src[0] ?? 1) >>> 0;
    this.s1 = (src[1] ?? 0) >>> 0;
    this.s2 = (src[2] ?? 0) >>> 0;
    this.s3 = (src[3] ?? 0) >>> 0;
  }
}

/**
 * A seed derived from the identity of an event rather than from a stream (M10, S4.14).
 *
 * ## Why a free-running stream is not enough
 *
 * S4.14 is precise about the failure: *"Reconciliation replays commands. Any randomness
 * consumed during a replayed tick must produce the same value it produced the first time, or
 * the replay diverges."*
 *
 * A shared `Rng` advances once per draw. The client fires on tick 400, drawing three floats.
 * A correction arrives for tick 396 and the client replays 397-400 — and on the replay the
 * stream is four draws further along than it was, so the shot on tick 400 goes somewhere
 * else. The player sees their own bullets move when a packet was late. Worse, it is
 * *self-perpetuating*: the divergence guarantees the next correction, which guarantees the
 * next replay.
 *
 * Seeding from `(tickIndex, entityId, shotIndex)` removes history from the answer entirely.
 * The same shot fired on the same tick by the same entity draws the same numbers on the
 * hundredth replay as on the first, and — the part that matters for authority — the server
 * computes the identical values without having seen any of the client's earlier draws.
 *
 * This is the same mechanism `deathVariantFor` already uses for the fall animation; M9
 * applied it in that one place and left the gameplay streams for here.
 *
 * Mixing is the splitmix32 finaliser over the multiplied inputs, so consecutive ticks and
 * adjacent entity ids land far apart rather than producing neighbouring seeds.
 */
export function eventSeed(salt: number, tickIndex: number, entityId: number, index: number): number {
  let z = salt >>> 0;
  z = (z + Math.imul(tickIndex | 0, 0x9e3779b9)) >>> 0;
  z = (z ^ Math.imul(entityId | 0, 0x85ebca6b)) >>> 0;
  z = (z + Math.imul(index | 0, 0xc2b2ae35)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}
