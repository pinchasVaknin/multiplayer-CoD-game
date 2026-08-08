import { logger } from '../../shared/core/Log';
import { NET_PERFECT, describeConditions, parseConditions, type NetConditions } from '../../shared/net/NetSim';
import { resolveServerUrl } from './BrowserLink';
import type { HandshakeOptions } from './Handshake';

const log = logger('join');

/**
 * Join-by-URL (M10, S6).
 *
 * S6 scopes this milestone to *"Join by URL"* with no lobby — S9 puts the lobby in M11 — so
 * the whole join flow is a query string:
 *
 * ```
 *   ?server=example.com:8080        connect to that host
 *   ?server=1                       connect to this page's own origin at /ws
 *   ?name=ALICE                     display name on the scoreboard
 *   ?net=100                        layer +100 ms on the real link (S7)
 *   ?net=bad                        the 100ms +/-30ms, 2% loss preset
 *   ?net=250,40,5                   latency, jitter, loss, explicitly
 *   ?rewinddebug=1                  ask the server for the rewind panel feed
 * ```
 *
 * The address is **never hardcoded** (S4.9). `?server` wins, then the build-time
 * `VITE_SERVER_URL`, then the page's own origin — which is what makes the documented
 * deployment, where a reverse proxy serves the client and the socket from one hostname,
 * need no configuration at all.
 *
 * Absent `?server`, the game boots into single-player exactly as it did at M9. That default
 * is deliberate and is HARD RULE 8 made operational: nothing about this milestone changes
 * what happens when you open the page.
 */

/** Injected at build time by Vite. Absent in a plain `npm run dev`. */
declare const __SERVER_URL__: string | undefined;

export function parseJoinOptions(search: string): HandshakeOptions | null {
  const params = new URLSearchParams(search);

  const serverParam = params.get('server');
  const buildDefault = typeof __SERVER_URL__ === 'string' ? __SERVER_URL__ : '';

  // No `?server` and no build-time address: single-player, as before.
  if (serverParam === null && buildDefault === '') return null;

  // `?server=1` and `?server` with no value both mean "this origin".
  const explicit =
    serverParam === null ? buildDefault : serverParam === '1' || serverParam === '' ? '' : serverParam;

  const url = resolveServerUrl(explicit === '' ? null : explicit);

  const conditions = parseNetFlag(params.get('net'));

  const options: HandshakeOptions = {
    url,
    displayName: sanitiseName(params.get('name')),
    conditions,
    wantRewindDebug: params.get('rewinddebug') === '1',
  };

  log.info(
    `joining ${url} as ${options.displayName}` +
      (conditions === NET_PERFECT ? '' : ` with simulated conditions: ${describeConditions(conditions)}`),
  );
  return options;
}

/**
 * `?net=` — the S7 condition simulator, settable by URL flag as S7 requires.
 *
 * An unrecognised value is refused loudly and falls back to a perfect link, rather than being
 * silently ignored. A test that quietly ran at zero latency is worse than one that refused to
 * start, because its numbers look plausible.
 */
function parseNetFlag(raw: string | null): NetConditions {
  if (raw === null || raw.trim() === '') return NET_PERFECT;
  const parsed = parseConditions(raw);
  if (parsed === null) {
    log.error(`unrecognised ?net=${raw} — running with no simulated conditions.`);
    return NET_PERFECT;
  }
  return parsed;
}

/**
 * A display name safe to put on a scoreboard.
 *
 * Trimmed, capped and stripped of control characters here as well as on the server. The
 * server's copy is the one that matters — this is a client and the client is untrusted — but
 * sending something sane costs nothing and means the local player sees the name they typed
 * rather than the name the server had to cut down.
 */
function sanitiseName(raw: string | null): string {
  if (raw === null) return 'OPERATOR';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= 20) break;
  }
  const trimmed = out.trim();
  return trimmed === '' ? 'OPERATOR' : trimmed;
}
