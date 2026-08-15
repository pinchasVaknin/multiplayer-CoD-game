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

/**
 * Whether a server address is configured at all (M11, §6.1).
 *
 * §4.9 forbids hardcoding one, so "configured" means `?server=` on the URL or `VITE_SERVER_URL`
 * baked in at build time. When neither is present the Play Multiplayer button is disabled with
 * a reason rather than failing on click — §6.2's rule that a known-broken feature with a cause
 * attached beats an inert button.
 */
export function isServerConfigured(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.get('server') !== null) return true;
  return typeof __SERVER_URL__ === 'string' && __SERVER_URL__ !== '';
}

/**
 * The join options for the Play Multiplayer button (M11, §6.1).
 *
 * Differs from `parseJoinOptions` in exactly one way: the display name comes from the player's
 * profile rather than from the URL, because by M11 there is a field for it on the menu and a
 * persisted default behind that. Everything else — the address resolution order, the condition
 * simulator flag, the rewind debug flag — is shared, so a `?net=bad` run through the button
 * behaves the same as one through the URL.
 */
export function multiplayerJoinOptions(search: string, displayName: string): HandshakeOptions | null {
  const base = parseJoinOptions(search);
  if (base === null) return null;
  return { ...base, displayName: sanitiseName(displayName) };
}

export function parseJoinOptions(search: string): HandshakeOptions | null {
  const params = new URLSearchParams(search);

  const serverParam = params.get('server');
  const buildDefault = typeof __SERVER_URL__ === 'string' ? __SERVER_URL__ : '';

  // No `?server` and no build-time address: single-player, as before.
  if (serverParam === null && buildDefault === '') return null;

  /**
   * `1`, an empty value and `/ws` all mean **this page's own origin**.
   *
   * The runtime half (`?server=1`) has meant that since M10. The build-time half did not: a
   * `VITE_SERVER_URL` of `1` went to `resolveServerUrl` as if it were a hostname, and the
   * client would have tried to open `wss://1/ws`. Nobody hit it because the documented
   * deployment baked a full `wss://host/ws` in — but it is the value a *managed* host wants,
   * where the page and the socket are the same service and the hostname is not known until
   * the first deploy has already happened.
   *
   * One predicate for both halves, so the two cannot mean different things by the same string.
   */
  const raw = serverParam === null ? buildDefault : serverParam;
  const url = resolveServerUrl(meansThisOrigin(raw) ? null : raw);

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

/** See `parseJoinOptions`. The one place the "same origin" spellings are listed. */
function meansThisOrigin(raw: string): boolean {
  const v = raw.trim();
  return v === '' || v === '1' || v === '/ws';
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
