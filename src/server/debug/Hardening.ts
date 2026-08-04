import { WebSocket } from 'ws';
import { logger } from '../../shared/core/Log';
import { MAGIC, MsgC, PROTOCOL_VERSION } from '../../shared/net/Protocol';
import { ByteWriter } from '../../shared/net/Wire';

const log = logger('hardening');

/**
 * Adversarial probes against a running server (M10, S8.12).
 *
 * S8.12: *"send malformed and oversized messages and a message flood. The server drops the
 * connection and stays up. Report what you sent and what happened."*
 *
 * The pass condition is deliberately narrow and absolute: **the process is still serving
 * afterwards.** Not "it logged an error", not "it handled it gracefully" — S4.16 makes a
 * crash a denial-of-service vector, so the only question that matters is whether a normal
 * client can still connect once every probe has been fired at it.
 *
 * Each probe is a separate connection, because a probe that works closes the connection it
 * was sent on, and reusing it would test nothing after the first.
 */

export interface ProbeResult {
  readonly name: string;
  /** What the probe sent, in words. Goes into the report. */
  readonly sent: string;
  /** True if the server closed the connection, which is the desired response. */
  readonly closed: boolean;
  /** Close code, or -1 if the socket was never closed by the peer. */
  readonly code: number;
  readonly ms: number;
}

export interface HardeningReport {
  readonly probes: readonly ProbeResult[];
  /** The whole point: a normal client can still connect afterwards. */
  readonly serverAlive: boolean;
  readonly allClosed: boolean;
}

export async function probeHardening(url: string): Promise<HardeningReport> {
  const probes: ProbeResult[] = [];

  probes.push(await probe(url, 'garbage-bytes', '256 random bytes with no valid magic', (ws) => {
    const junk = new Uint8Array(256);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
    ws.send(junk);
  }));

  probes.push(await probe(url, 'empty-frame', 'a zero-length binary frame', (ws) => {
    ws.send(new Uint8Array(0));
  }));

  probes.push(await probe(url, 'magic-only', 'a valid magic with no message id', (ws) => {
    const w = new ByteWriter(16);
    w.u32(MAGIC);
    ws.send(w.bytes());
  }));

  probes.push(await probe(url, 'unknown-msg-id', 'valid magic, message id 200', (ws) => {
    const w = new ByteWriter(16);
    w.u32(MAGIC);
    w.u8v(200);
    ws.send(w.bytes());
  }));

  probes.push(
    await probe(url, 'truncated-commands', 'a Commands header claiming 16 commands with no body', (ws) => {
      const w = new ByteWriter(32);
      w.u32(MAGIC);
      w.u8v(MsgC.Commands);
      w.u16(0);
      w.u8v(16);
      ws.send(w.bytes());
    }),
  );

  probes.push(
    await probe(url, 'bad-version', `a Hello claiming protocol ${PROTOCOL_VERSION + 99}`, (ws) => {
      const w = new ByteWriter(64);
      w.u32(MAGIC);
      w.u8v(MsgC.Hello);
      w.u16(PROTOCOL_VERSION + 99);
      w.str('IMPOSTOR');
      ws.send(w.bytes());
    }),
  );

  probes.push(
    await probe(url, 'oversize-frame', '64 KB frame against a 1 KB cap', (ws) => {
      ws.send(new Uint8Array(64 * 1024));
    }),
  );

  probes.push(
    await probe(
      url,
      'commands-before-hello',
      'a valid Commands batch with no handshake',
      (ws) => {
        const w = new ByteWriter(64);
        w.u32(MAGIC);
        w.u8v(MsgC.Commands);
        w.u16(0);
        w.u8v(1);
        w.u32(1);
        w.i32(0);
        w.i8(0);
        w.i8(0);
        w.u16(0);
        w.i16(0);
        w.u32(0);
        ws.send(w.bytes());
      },
    ),
  );

  probes.push(
    await probe(
      url,
      'message-flood',
      '3000 valid pings as fast as the socket accepts them',
      (ws) => {
        const w = new ByteWriter(64);
        for (let i = 0; i < 3000; i++) {
          w.reset();
          w.u32(MAGIC);
          w.u8v(MsgC.Ping);
          w.u32(i);
          w.f64(0);
          ws.send(w.bytes());
        }
      },
      4000,
    ),
  );

  probes.push(
    await probe(url, 'name-overflow', 'a Hello with a 4 KB display name', (ws) => {
      // The string writer caps at 255 bytes, so this is built by hand to actually oversend.
      const name = 'A'.repeat(4096);
      const bytes = new Uint8Array(6 + 1 + name.length);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, MAGIC, true);
      view.setUint8(4, MsgC.Hello);
      view.setUint16(5, PROTOCOL_VERSION, true);
      view.setUint8(7, 255);
      for (let i = 0; i < name.length && 8 + i < bytes.length; i++) bytes[8 + i] = 0x41;
      ws.send(bytes);
    }),
  );

  // The only question that matters.
  const serverAlive = await canStillConnect(url);
  const allClosed = probes.every((p) => p.closed);

  for (const p of probes) {
    log.info(`${p.name}: sent ${p.sent} — ${p.closed ? `closed (${p.code})` : 'left open'} in ${p.ms}ms`);
  }
  log.info(serverAlive ? 'server still accepting connections.' : 'SERVER IS DOWN.');

  return { probes, serverAlive, allClosed };
}

function probe(
  url: string,
  name: string,
  sent: string,
  fire: (ws: WebSocket) => void,
  waitMs = 1500,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (closed: boolean, code: number): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Already gone.
      }
      resolve({ name, sent, closed, code, ms: Date.now() - started });
    };

    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';

    ws.on('open', () => {
      try {
        fire(ws);
      } catch (err) {
        // A send that throws locally is still a valid outcome for the probe: the frame was
        // refused before it left, which is the library enforcing the same cap the server does.
        log.info(`${name}: local send refused — ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    ws.on('close', (code: number) => finish(true, code));
    // An error here usually *is* the server hanging up mid-frame, which is a pass.
    ws.on('error', () => finish(true, -2));

    setTimeout(() => finish(false, -1), waitMs);
  });
}

/** Open a plain connection and see whether it is accepted. The pass condition. */
function canStillConnect(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Already gone.
      }
      resolve(ok);
    };
    const ws = new WebSocket(url);
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
    setTimeout(() => done(false), 3000);
  });
}
