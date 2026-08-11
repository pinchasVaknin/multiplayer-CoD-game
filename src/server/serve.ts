import { installClock } from '../shared/core/Clock';
import { logger } from '../shared/core/Log';
import { describeConditions } from '../shared/net/NetSim';
import { PROTOCOL_VERSION } from '../shared/net/Protocol';
import { loadConfig } from './Config';
import { Server } from './Server';
import { installServerLogging, metric } from './log';
import { nodeClock } from './NodeClock';

/**
 * The dedicated server's entry point (M10, S4.9 and S6.6).
 *
 * Separate from `main.ts`, which is the M9 headless *harness* — that one runs matches as fast
 * as it can and exits with a result. This one listens, and does not stop. They share every
 * line of simulation and nothing else, and conflating them would mean a flag deciding whether
 * the process is a long-lived service or a batch job.
 *
 * ```bash
 *   PORT=8080 npm run serve
 * ```
 *
 * Everything else comes from the environment (`Config.ts`), because S4.9 requires the address
 * to be injected rather than hardcoded and there is no reason for the port, the map or the
 * tick rate to be different in that respect.
 */

async function main(): Promise<number> {
  const cfg = loadConfig(process.env);

  // Before anything simulates. `nowMs()` throws rather than falling back, deliberately.
  installClock(nodeClock);
  installServerLogging(process.stdout.isTTY === true ? 'text' : 'json', 'info');

  const log = logger('server');
  log.info(`OPERATOR dedicated server — node ${process.version}, protocol v${PROTOCOL_VERSION}.`);
  if (!isIdle(cfg.conditions)) {
    log.warn(`NET_SIM active on every outbound link: ${describeConditions(cfg.conditions)}`);
  }

  metric('server', 'boot', {
    node: process.version,
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    host: cfg.host,
    port: cfg.port,
    warmupBots: cfg.warmupBots,
    seed: cfg.seed,
    snapshotHz: cfg.snapshotHz,
    interpMs: cfg.interpolationDelayMs,
    readyTimeoutMs: cfg.readyTimeoutMs,
    summaryHoldSeconds: cfg.summaryHoldSeconds,
    faultInjection: cfg.faultInjection,
    tls: cfg.tlsCertPath !== undefined,
    netSim: describeConditions(cfg.conditions),
  });

  /**
   * Construction bakes every map (§4.19), so this line is where the boot bake time is spent —
   * before the listener opens and therefore before any client can be affected by it.
   */
  const server = new Server(cfg);

  try {
    await server.start();
  } catch (err) {
    log.error(`failed to listen on ${cfg.host}:${cfg.port} — ${errText(err)}`);
    return 1;
  }

  /**
   * Graceful shutdown.
   *
   * A process manager sends `SIGTERM` on restart and deploy (S6.6). Closing the sessions
   * first means every connected client gets a `Bye` with a reason and can say so, rather than
   * a socket that simply stops — which a client cannot distinguish from a network failure and
   * would sit in a reconnect loop over.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} — shutting down.`);
    void server.stop().then(() => process.exit(0));
    // If a socket refuses to close, do not hang a deploy on it.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  /**
   * The last line of defence (S4.16: *"malformed input must never crash the server"*).
   *
   * Every decode path is already total, and this is the belt to that braces: an unexpected
   * throw anywhere is logged with its stack **to our log** and the process keeps running.
   * Nothing here ever reaches a client. Node's default for an unhandled rejection is to
   * terminate, and on an internet-facing process that is a denial-of-service vector.
   */
  process.on('uncaughtException', (err) => {
    log.error(`uncaught: ${err.stack ?? err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });

  // Resolves only on shutdown; the loop keeps the process alive.
  return new Promise<number>(() => {
    /* never resolves — the server runs until a signal stops it */
  });
}

function isIdle(c: { latencyMs: number; jitterMs: number; lossPct: number }): boolean {
  return c.latencyMs <= 0 && c.jitterMs <= 0 && c.lossPct <= 0;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`fatal: ${errText(err)}\n`);
    process.exit(1);
  },
);
