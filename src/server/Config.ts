import { NET_PERFECT, parseConditions, type NetConditions } from '../shared/net/NetSim';

/**
 * Server configuration, from the environment (M10, S4.9 and S6.6).
 *
 * S4.9: *"The server address is **configuration**, injected at build or runtime. Never
 * hardcoded."* S6.6 extends that to the port and the tick rate. So every operational number
 * lives here, is read once at boot, and is echoed into the log so a misconfigured deploy is
 * visible in the first three lines rather than after an afternoon of wondering why nobody
 * can connect.
 *
 * Defaults are chosen so `npm run serve` works on a developer machine with no environment at
 * all, and so nothing in the defaults is unsafe if it reaches production unchanged.
 */

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly mapId: string;
  readonly modeId: string;
  readonly bots: number;
  readonly seed: number;
  /**
   * Snapshots per second (S4.12: 20-30, decoupled from the 60 Hz sim).
   *
   * Default 20. At 20 Hz a snapshot interval is 50 ms, so the 100 ms interpolation delay
   * S4.12 asks for is exactly two intervals of buffer — the minimum that survives one
   * dropped snapshot without the buffer starving. 30 Hz is also legal and gives three
   * intervals at two-thirds more bandwidth; it is a knob rather than a rewrite.
   */
  readonly snapshotHz: number;
  /** How far in the past clients render remote entities, ms (S4.12). */
  readonly interpolationDelayMs: number;
  readonly tlsCertPath: string | undefined;
  readonly tlsKeyPath: string | undefined;
  /** Server-side condition simulation, applied to every outbound link (S7). */
  readonly conditions: NetConditions;
  /** Emit one metrics record every this many seconds. Zero disables it. */
  readonly metricsSeconds: number;
  /**
   * Turn lag compensation off (S8.6).
   *
   * Exists so the value of rewind can be **measured** rather than asserted. S4.13 justifies
   * the whole system with an estimate — half a metre of miss at 60 ms RTT — and the honest
   * way to report on that is to run the identical hit test with this set and compare. It is
   * a diagnostic switch, not a gameplay option, and the server logs loudly when it is on.
   */
  readonly rewindDisabled: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const conditionSpec = env['NET_SIM'] ?? '';
  const parsed = conditionSpec === '' ? NET_PERFECT : parseConditions(conditionSpec);

  return {
    // Binds every interface by default. The process is expected to sit behind a reverse
    // proxy or a tunnel (S6.6), and binding loopback-only by default would make the
    // documented deployment silently not work.
    host: env['HOST'] ?? '0.0.0.0',
    port: intOr(env['PORT'], 8080, 1, 65535),
    mapId: env['MAP'] ?? 'mp_foundry',
    // S6 scopes this milestone to TDM on Foundry. It is configuration rather than a
    // constant because the *server* has no reason to hardcode it and M11 adds the rest.
    modeId: env['MODE'] ?? 'TDM',
    bots: intOr(env['BOTS'], 8, 0, 16),
    seed: intOr(env['SEED'], 1, 0, 0x7fff_ffff),
    snapshotHz: intOr(env['SNAPSHOT_HZ'], 20, 10, 60),
    interpolationDelayMs: intOr(env['INTERP_MS'], 100, 0, 500),
    tlsCertPath: blankToUndefined(env['TLS_CERT']),
    tlsKeyPath: blankToUndefined(env['TLS_KEY']),
    conditions: parsed ?? NET_PERFECT,
    metricsSeconds: intOr(env['METRICS_SECONDS'], 30, 0, 3600),
    rewindDisabled: (env['REWIND_DISABLED'] ?? '') === '1',
  };
}

/** One line describing the whole configuration, for the boot log. */
export function describeConfig(cfg: ServerConfig): string {
  const tls = cfg.tlsCertPath !== undefined ? 'wss (direct TLS)' : 'ws (terminate TLS upstream)';
  return (
    `${cfg.host}:${cfg.port} ${tls}, ${cfg.modeId} on ${cfg.mapId}, ` +
    `${cfg.bots} bots, seed ${cfg.seed}, ${cfg.snapshotHz} Hz snapshots, ` +
    `${cfg.interpolationDelayMs}ms interpolation`
  );
}

function intOr(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  // Clamped rather than rejected: a deploy with `PORT=99999` should come up on a usable
  // port and say so, not refuse to start at three in the morning.
  return i < min ? min : i > max ? max : i;
}

function blankToUndefined(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}
