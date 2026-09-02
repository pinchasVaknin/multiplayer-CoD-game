/**
 * Byte-level reader and writer for the wire protocol (M10, S4.12).
 *
 * S4.12 is blunt: *"Never JSON at rate."* A snapshot goes out 20-30 times a second to every
 * client, and the difference between a packed binary frame and a JSON object is roughly an
 * order of magnitude of bandwidth for identical information.
 *
 * ## Two rules this file exists to enforce
 *
 * **Nothing allocates in the hot path.** A writer owns one `ArrayBuffer` for its lifetime and
 * `reset()`s it per frame. `bytes()` returns a subarray *view*, not a copy — the caller hands
 * it straight to the socket, which copies it itself.
 *
 * **A reader never throws past the end.** Every decode path in this codebase runs on bytes an
 * untrusted client sent (S4.16: *"malformed input must never crash the server"*), so a read
 * past the end sets `overran` and returns zero rather than raising. Callers check `overran`
 * once at the end of a message instead of guarding thirty individual reads, and a truncated
 * frame becomes a dropped connection rather than a stack trace.
 *
 * Little-endian throughout, because every platform this runs on is.
 */

/** Grow-once cap. A frame larger than this is a bug on our side, not a big update. */
const MAX_FRAME_BYTES = 64 * 1024;

export class ByteWriter {
  private readonly buf: ArrayBuffer;
  private readonly view: DataView;
  private readonly u8: Uint8Array;
  private at = 0;
  private overflowed_ = false;

  constructor(capacity = 8192) {
    this.buf = new ArrayBuffer(Math.min(capacity, MAX_FRAME_BYTES));
    this.view = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
  }

  /** Bytes written so far. */
  get length(): number {
    return this.at;
  }

  /**
   * True if any write ran past the buffer.
   *
   * The writer keeps accepting calls after this — silently dropping them — so a caller can
   * finish its loop and check once. A frame that overflowed must never be sent: it is a
   * prefix of the intended message and would decode as garbage.
   */
  get overflowed(): boolean {
    return this.overflowed_;
  }

  reset(): void {
    this.at = 0;
    this.overflowed_ = false;
  }

  /** A view over what has been written. Valid until the next `reset()`. */
  bytes(): Uint8Array {
    return this.u8.subarray(0, this.at);
  }

  private room(n: number): boolean {
    if (this.at + n > this.u8.length) {
      this.overflowed_ = true;
      return false;
    }
    return true;
  }

  u8v(v: number): void {
    if (!this.room(1)) return;
    this.view.setUint8(this.at, v & 0xff);
    this.at += 1;
  }

  i8(v: number): void {
    if (!this.room(1)) return;
    this.view.setInt8(this.at, clampInt(v, -128, 127));
    this.at += 1;
  }

  u16(v: number): void {
    if (!this.room(2)) return;
    this.view.setUint16(this.at, v & 0xffff, true);
    this.at += 2;
  }

  i16(v: number): void {
    if (!this.room(2)) return;
    this.view.setInt16(this.at, clampInt(v, -32768, 32767), true);
    this.at += 2;
  }

  u32(v: number): void {
    if (!this.room(4)) return;
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
  }

  i32(v: number): void {
    if (!this.room(4)) return;
    this.view.setInt32(this.at, v | 0, true);
    this.at += 4;
  }

  f32(v: number): void {
    if (!this.room(4)) return;
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }

  f64(v: number): void {
    if (!this.room(8)) return;
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }

  /** Length-prefixed UTF-8, max 255 bytes. Names and close reasons only, never at rate. */
  str(s: string): void {
    const bytes = encodeUtf8(s);
    const n = Math.min(bytes.length, 255);
    this.u8v(n);
    if (!this.room(n)) return;
    this.u8.set(bytes.subarray(0, n), this.at);
    this.at += n;
  }

  raw(src: Uint8Array): void {
    if (!this.room(src.length)) return;
    this.u8.set(src, this.at);
    this.at += src.length;
  }
}

export class ByteReader {
  private view: DataView;
  private u8: Uint8Array;
  private at = 0;
  private overran_ = false;

  constructor(bytes: Uint8Array) {
    this.u8 = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Point this reader at a different frame. Lets a decoder be reused without allocating. */
  reuse(bytes: Uint8Array): void {
    this.u8 = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
    this.overran_ = false;
  }

  /**
   * True once any read ran past the end of the frame.
   *
   * This is the single check that turns "the client sent us thirty bytes of a hundred-byte
   * message" into a clean disconnect instead of an exception in the tick loop.
   */
  get overran(): boolean {
    return this.overran_;
  }

  get remaining(): number {
    return this.u8.length - this.at;
  }

  get offset(): number {
    return this.at;
  }

  private room(n: number): boolean {
    if (this.at + n > this.u8.length) {
      this.overran_ = true;
      return false;
    }
    return true;
  }

  u8v(): number {
    if (!this.room(1)) return 0;
    const v = this.view.getUint8(this.at);
    this.at += 1;
    return v;
  }

  /**
   * The next byte without consuming it.
   *
   * Exists for one case and it is worth naming: an entity delta begins with its id, and the
   * decoder has to know *which* entity it is in order to decode into that entity's own
   * baseline. Peeking is the alternative to either splitting every record's header out of
   * its body or decoding into a scratch and copying afterwards.
   */
  peekU8(): number {
    if (this.at + 1 > this.u8.length) {
      this.overran_ = true;
      return 0;
    }
    return this.view.getUint8(this.at);
  }

  i8(): number {
    if (!this.room(1)) return 0;
    const v = this.view.getInt8(this.at);
    this.at += 1;
    return v;
  }

  u16(): number {
    if (!this.room(2)) return 0;
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }

  i16(): number {
    if (!this.room(2)) return 0;
    const v = this.view.getInt16(this.at, true);
    this.at += 2;
    return v;
  }

  u32(): number {
    if (!this.room(4)) return 0;
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }

  i32(): number {
    if (!this.room(4)) return 0;
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }

  f32(): number {
    if (!this.room(4)) return 0;
    const v = this.view.getFloat32(this.at, true);
    this.at += 4;
    return v;
  }

  f64(): number {
    if (!this.room(8)) return 0;
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }

  str(): string {
    const n = this.u8v();
    if (!this.room(n)) return '';
    const s = decodeUtf8(this.u8.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }

  /**
   * `n` raw bytes, **copied** (M11 playtest round 4, F8).
   *
   * The copy is the whole reason this is not a `subarray`. Every reader in this project is
   * reused across frames — `ByteReader.reuse` points it at the link's next buffer, and both
   * links reuse their receive buffers — so a view handed out here would be a window onto bytes
   * that belong to a later message by the time anybody reads it. Opposite to `ByteWriter.raw`,
   * whose argument the caller already owns.
   *
   * Length-checked like every other read, so a truncated frame sets `overran` and returns an
   * empty array rather than throwing (S4.16).
   */
  raw(n: number): Uint8Array {
    if (!this.room(n)) return new Uint8Array(0);
    const out = this.u8.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v);
  if (!Number.isFinite(r)) return 0;
  if (r < lo) return lo;
  if (r > hi) return hi;
  return r;
}

/**
 * UTF-8 by hand rather than `TextEncoder`.
 *
 * `TextEncoder` exists in both runtimes, but it is a browser-shaped global and the boundary
 * check scans `shared/` for exactly that class of identifier. Names here are short and
 * infrequent — a handful per match, never at snapshot rate — so a small hand-rolled encoder
 * costs nothing measurable and keeps the partition rule mechanical rather than exception-based.
 */
function encodeUtf8(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3);
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    // Combine a surrogate pair into the single code point it represents.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) {
      out[w++] = code;
    } else if (code < 0x800) {
      out[w++] = 0xc0 | (code >> 6);
      out[w++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[w++] = 0xe0 | (code >> 12);
      out[w++] = 0x80 | ((code >> 6) & 0x3f);
      out[w++] = 0x80 | (code & 0x3f);
    } else {
      out[w++] = 0xf0 | (code >> 18);
      out[w++] = 0x80 | ((code >> 12) & 0x3f);
      out[w++] = 0x80 | ((code >> 6) & 0x3f);
      out[w++] = 0x80 | (code & 0x3f);
    }
  }
  return out.subarray(0, w);
}

/**
 * The inverse, and deliberately lenient: a malformed sequence becomes U+FFFD rather than an
 * error. This decodes attacker-controlled bytes (a display name from a `Hello`), and the
 * correct response to bad UTF-8 there is a mangled name, not a dropped process.
 */
function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++] ?? 0;
    let code: number;
    if (b0 < 0x80) {
      code = b0;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = ((b0 & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else if ((b0 & 0xf0) === 0xe0) {
      code = ((b0 & 0x0f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else if ((b0 & 0xf8) === 0xf0) {
      code =
        ((b0 & 0x07) << 18) |
        (((bytes[i++] ?? 0) & 0x3f) << 12) |
        (((bytes[i++] ?? 0) & 0x3f) << 6) |
        ((bytes[i++] ?? 0) & 0x3f);
    } else {
      code = 0xfffd;
    }
    if (code > 0x10ffff) code = 0xfffd;
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}
