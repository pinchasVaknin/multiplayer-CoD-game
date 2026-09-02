import { NET_PERFECT, parseConditions, type NetConditions } from '../shared/net/NetSim';
import { VOTE_CYCLE_CONFIG, type VoteCycleConfig } from '../shared/net/Skirmish';

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
   * The map rotation (M10, playtest round 2).
   *
   * A dedicated server that stops when its match ends is not a dedicated server — it is a
   * one-shot that happens to listen on a port. Before this existed, `GameServer` never so
   * much as *asked* whether the match was over: the flow reached `MATCH_END`, the header
   * carried `SFlag.MatchOver` forever, and every connected client sat on the final banner
   * until somebody restarted the process.
   *
   * `MAP_ROTATION=mp_foundry,mp_depot`. Defaults to whatever `MAP` is, which makes the
   * default behaviour "restart the same map" rather than "rotate to a map the operator did
   * not ask for".
   */
  readonly mapRotation: readonly string[];
  /** `MODE_ROTATION`, walked in step with the map rotation. Defaults to `MODE`. */
  readonly modeRotation: readonly string[];
  /**
   * Seconds the final scoreboard is held before the next match starts.
   *
   * Long enough to read the result and for a client to show its summary screen; short enough
   * that an empty server is not idle for a minute at a time. Zero restarts immediately, which
   * is what the soak runs want.
   */
  readonly matchEndHoldSeconds: number;
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
  /**
   * Directory of built client files to serve over the same port (`STATIC_DIR`).
   *
   * Defaults to `dist`, which is where `vite build` puts the client — so a managed host that
   * runs `npm run build && npm start` gets the page and the socket on one origin with no
   * configuration at all. See `WsServerOptions.staticDir` for why that matters.
   *
   * Set it to an empty string to serve nothing, which is the right answer behind a reverse
   * proxy that is already serving the client itself.
   */
  readonly staticDir: string;
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

  // -- M11: the skirmish flow -------------------------------------------------

  /**
   * Bots in the permanent warmup arena (§6.3: 2-3).
   *
   * Three by default. Two is the brief's floor and leaves a lone player duelling a pair; four
   * starts to crowd the greybox room, which is a weapon range rather than an arena.
   */
  readonly warmupBots: number;
  /**
   * How long `READY_WAIT` waits on a client's background build before starting without it
   * (§4.18, §6.5), ms.
   *
   * §4.18: *"A server that waits indefinitely on one slow client is a server that is stuck."*
   *
   * **Twenty seconds, and it is paired with the client's per-frame build budget.** The two are
   * one decision: the client spends `MapBuildQueue`'s budget per frame, which delivers roughly
   * 300 ms of build per second at 60 FPS and 150 ms/s at 30, so a two-second map build lands in
   * 7-13 s of wall time. A timeout below that fires on healthy machines and sends every
   * transition down the §4.18 loading-screen path — which is exactly what the first value, 8 s,
   * did.
   *
   * It is still a bound, which is what §4.18 actually requires: a client that has genuinely
   * stalled costs itself a loading screen after twenty seconds rather than costing everybody
   * the match.
   */
  readonly readyTimeoutMs: number;
  /** Seconds the end-of-match summary is held before everybody returns (§6.9: 12-15 s). */
  readonly summaryHoldSeconds: number;
  /**
   * Wrap the allocator in `FaultyMatchAllocator` (§4.17, §8.14).
   *
   * Diagnostic only, and the server says so loudly at boot. With it off, the shipping
   * allocator runs with nothing in front of it.
   */
  readonly faultInjection: boolean;
  /**
   * Vote phase durations (§4.20), overridable for the harness.
   *
   * ## Shortening these is a documented hazard, not a free speed-up
   *
   * Handover Tier 2 §C, on a bug found by a browser and missed by a harness: *"A harness that
   * shortens a timer to go faster can shorten past the bug it exists to find. Run at least one
   * pass at real timings."* The M11 case is exactly that shape — a 6 s countdown reached a
   * match inside a 10 s session timeout every time, and the 30 s lobby that broke it never
   * ran.
   *
   * So they are configurable, because a 100-cycle leak run at 60 s a cycle is 100 minutes and
   * the thing it measures has nothing to do with the clock — and every run that uses a short
   * cycle **says so in its report**, and at least one pass is always run at the shipped values.
   */
  readonly voteCycle: VoteCycleConfig;
  /**
   * Shorten every live match's round, seconds. Zero uses each mode's authored length.
   *
   * Harness only, and it shortens **both** match clocks together — see
   * `ModeDeps.roundSecondsOverride` for why there are two and what happens when only one moves.
   */
  readonly matchRoundSeconds: number;

  // -- playtest round 4: cheat codes (F14) ------------------------------------

  /**
   * Honour the cheat codes that change the simulation (`CHEATS_ENABLED`, F14).
   *
   * **Off by default, and that default is the feature.** `SPEC[]1` to `SPEC[]4` and `MO951357`
   * ask for invulnerability, invisibility, noclip and thirty unearned kills — every one of them
   * a thing a client must never be able to grant itself, which is why the code is a *request*
   * and this flag is the answer. With it off the server refuses every one and says so; the
   * client is told, because a cheat that is silent when refused is a bug that gets reported
   * twice.
   *
   * It does not gate `DEBUG666`. That code decides a client surface and nothing about the
   * simulation, so it is authored by the client for itself — see `CHEAT_LOCAL` in
   * `shared/cheats/Cheats.ts`. Gating it here would make the debug overlay unreachable against
   * a deployed server, which is precisely where PLAN.md's "needs a browser" lists send somebody
   * to read the NetPanel.
   *
   * Logged loudly at boot when it is on, in the same shape as `faultInjection`: an operator who
   * left it set should find out in the first three lines rather than from a scoreboard.
   */
  readonly cheatsEnabled: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const conditionSpec = env['NET_SIM'] ?? '';
  const parsed = conditionSpec === '' ? NET_PERFECT : parseConditions(conditionSpec);

  const mapId = env['MAP'] ?? 'mp_foundry';
  const modeId = env['MODE'] ?? 'TDM';

  return {
    mapRotation: listOr(env['MAP_ROTATION'], [mapId]),
    modeRotation: listOr(env['MODE_ROTATION'], [modeId]),
    matchEndHoldSeconds: intOr(env['MATCH_END_HOLD_SECONDS'], 12, 0, 300),
    // Binds every interface by default. The process is expected to sit behind a reverse
    // proxy or a tunnel (S6.6), and binding loopback-only by default would make the
    // documented deployment silently not work.
    host: env['HOST'] ?? '0.0.0.0',
    port: intOr(env['PORT'], 8080, 1, 65535),
    mapId,
    // S6 scopes this milestone to TDM on Foundry. It is configuration rather than a
    // constant because the *server* has no reason to hardcode it and M11 adds the rest.
    modeId,
    bots: intOr(env['BOTS'], 8, 0, 16),
    seed: intOr(env['SEED'], 1, 0, 0x7fff_ffff),
    snapshotHz: intOr(env['SNAPSHOT_HZ'], 20, 10, 60),
    interpolationDelayMs: intOr(env['INTERP_MS'], 100, 0, 500),
    tlsCertPath: blankToUndefined(env['TLS_CERT']),
    tlsKeyPath: blankToUndefined(env['TLS_KEY']),
    // `??` rather than `||`: an explicitly empty STATIC_DIR means "serve nothing", and that
    // is a different instruction from "not set".
    staticDir: env['STATIC_DIR'] ?? 'dist',
    conditions: parsed ?? NET_PERFECT,
    metricsSeconds: intOr(env['METRICS_SECONDS'], 30, 0, 3600),
    rewindDisabled: (env['REWIND_DISABLED'] ?? '') === '1',
    warmupBots: intOr(env['WARMUP_BOTS'], 3, 0, 8),
    readyTimeoutMs: intOr(env['READY_TIMEOUT_MS'], 20_000, 500, 120_000),
    summaryHoldSeconds: intOr(env['SUMMARY_HOLD_SECONDS'], 14, 1, 60),
    faultInjection: (env['FAULT_INJECTION'] ?? '') === '1',
    voteCycle: {
      playSeconds: intOr(env['PLAY_SECONDS'], VOTE_CYCLE_CONFIG.playSeconds, 1, 600),
      modeVoteSeconds: intOr(env['MODE_VOTE_SECONDS'], VOTE_CYCLE_CONFIG.modeVoteSeconds, 1, 120),
      mapVoteSeconds: intOr(env['MAP_VOTE_SECONDS'], VOTE_CYCLE_CONFIG.mapVoteSeconds, 1, 120),
    },
    matchRoundSeconds: intOr(env['MATCH_ROUND_SECONDS'], 0, 0, 3600),
    cheatsEnabled: (env['CHEATS_ENABLED'] ?? '') === '1',
  };
}

/** Whether any timing knob has been turned down. Reported by every harness run. */
export function usesShortenedTimings(cfg: ServerConfig): boolean {
  return (
    cfg.voteCycle.playSeconds !== VOTE_CYCLE_CONFIG.playSeconds ||
    cfg.voteCycle.modeVoteSeconds !== VOTE_CYCLE_CONFIG.modeVoteSeconds ||
    cfg.voteCycle.mapVoteSeconds !== VOTE_CYCLE_CONFIG.mapVoteSeconds ||
    cfg.matchRoundSeconds > 0
  );
}

/** One line describing the whole configuration, for the boot log. */
export function describeConfig(cfg: ServerConfig): string {
  const tls = cfg.tlsCertPath !== undefined ? 'wss (direct TLS)' : 'ws (terminate TLS upstream)';
  const rotation =
    cfg.mapRotation.length > 1 || cfg.modeRotation.length > 1
      ? `, rotation ${cfg.modeRotation.join('/')} on ${cfg.mapRotation.join('/')}`
      : '';
  return (
    `${cfg.host}:${cfg.port} ${tls}, skirmish flow, ` +
    `arena with ${cfg.warmupBots} bots, seed ${cfg.seed}, ${cfg.snapshotHz} Hz snapshots, ` +
    `${cfg.interpolationDelayMs}ms interpolation, ` +
    `${cfg.readyTimeoutMs}ms ready timeout, ${cfg.summaryHoldSeconds}s summary hold` +
    (cfg.faultInjection ? ', FAULT INJECTION ON' : '') +
    // Same shape and the same reason as fault injection: a diagnostic left on in production is
    // something an operator has to be able to see without reading the environment back.
    (cfg.cheatsEnabled ? ', CHEAT CODES ENABLED' : '') +
    // The batch harnesses still drive a single match from `MAP`/`MODE`, so the rotation is
    // still described when it is set — it just no longer governs the dedicated server.
    (rotation === '' ? '' : ` (harness rotation${rotation})`)
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

/**
 * A comma-separated list, or the fallback.
 *
 * Entries are **not** validated against the registry here. `findMap` throws on an unknown id,
 * and it should: a rotation naming a map that does not exist is a deploy that will break at
 * the first rotation, and the honest place to find that out is boot. See `GameServer`, which
 * resolves the whole rotation once at construction for exactly that reason.
 */
function listOr(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return parts.length === 0 ? fallback : parts;
}
