/**
 * Every query-string flag this client understands, declared once (playtest round 5, B9).
 *
 * ## Why this file exists
 *
 * B9 reported two documented flags not doing what `README.md` said. One of them —
 * `?name=ALICE` — was worse than not working: `parseJoinOptions` read it and its only caller
 * overwrote the result on the next line, so the parse was **dead code that the documentation
 * described as a feature**. The other — `?server=1` — worked exactly as written and had never
 * promised what the prose around the table implied.
 *
 * Neither is a parsing bug. The defect is that the flag table was a piece of prose in a
 * README with nothing checking it against the parser, so a flag could be documented into
 * existence and stay that way for a milestone. `URL_FLAGS` is the declaration both sides are
 * held to: `scripts/check-flags.mjs` fails when the README's table and this list disagree in
 * either direction, and when any file under `src/client/` reads a query key that appears in
 * neither this list nor `UNDOCUMENTED_URL_KEYS`.
 *
 * ## Why it is in `shared/`
 *
 * The flags are parsed on the client, but two of the rules they encode are shared with the
 * server and were duplicated there: the name sanitiser existed character-for-character twice
 * (`JoinOptions` and `net/Session`), and the `#rw` suffix string existed three times. A rule
 * with two spellings is two rules, which is the finding this milestone keeps making. Nothing
 * here touches `URLSearchParams` or the DOM — the caller does the parsing and passes strings
 * in — so it compiles under `shared/`'s no-DOM library.
 */

export interface UrlFlag {
  /** The query-string key. Several rows may share one: `?server` has two, `?net` has three. */
  readonly key: string;
  /** The flag as the README's first column spells it. Compared literally by the check. */
  readonly syntax: string;
  /** The README's second column, likewise. */
  readonly effect: string;
}

/**
 * The documented flags, in the README's order.
 *
 * `syntax` and `effect` are the table cells verbatim, because a check that compared something
 * looser would pass on a table that had drifted into saying the wrong thing — which is exactly
 * what B9 was.
 */
export const URL_FLAGS: readonly UrlFlag[] = [
  {
    key: 'server',
    syntax: '`?server=host:port`',
    /**
     * "Use", not "connect to", and the wording is the B9 fix.
     *
     * The reporter opened the deployed build with `?server=1` and expected to arrive in a
     * match; the game stayed in the menu until `PLAY MULTIPLAYER` was clicked. That is not a
     * regression and there has never been an auto-connect path — `isServerConfigured` only
     * enables the button, and `Game.playMultiplayer` is reached from the click and nowhere
     * else. The decision to keep it that way is deliberate: `VITE_SERVER_URL` is baked to `1`
     * on the deployed build, so an auto-connect would throw every visitor straight into a
     * socket and make Play Solo unreachable from the front door.
     */
    effect: 'Use that server when you press Play Multiplayer',
  },
  {
    key: 'server',
    syntax: '`?server=1`',
    effect: "Use this page's own origin at `/ws`",
  },
  {
    key: 'name',
    syntax: '`?name=ALICE`',
    /**
     * URL over profile, decided explicitly (B9).
     *
     * The same ladder `?server` already uses — an explicit per-session instruction beats a
     * stored default beats a generated one — because two flags in one parser resolving in
     * opposite directions is the disagreement this file exists to stop. Nothing is written
     * back to the profile: the override lasts as long as the tab and is visible in the
     * address bar, which is what makes it safe for a URL to carry.
     */
    effect: 'Name on the scoreboard, overriding the profile callsign for this tab only',
  },
  {
    key: 'net',
    syntax: '`?net=100`',
    effect: 'Add 100 ms round trip *on top of* the real link',
  },
  {
    key: 'net',
    syntax: '`?net=bad`',
    effect: 'The 100 ms ±30 ms jitter, 2% loss preset',
  },
  {
    key: 'net',
    syntax: '`?net=250,40,5`',
    effect: 'Latency, jitter, loss — explicitly',
  },
];

/**
 * Query keys the client reads that are deliberately **not** in the README's table.
 *
 * Each one needs a reason, because "undocumented" is a decision and not a gap. The check
 * treats this list exactly like `URL_FLAGS` for the purpose of "is this key declared", so a
 * new flag cannot be added to the client without somebody writing down which of the two it is.
 */
export const UNDOCUMENTED_URL_KEYS: ReadonlyMap<string, string> = new Map([
  /*
   * Out of the README's table as of round 5, and the reason is the third flag B9 turned up.
   *
   * The README said it *"asks the server for the per-shot rewind feed"*. There is no such feed:
   * no message on the wire carries one, `NetPanel` computes all three of its Rewind fields from
   * the client's own RTT, and `Session.wantsRewindDebug` — the flag the whole chain exists to
   * set — is **written and never read**, on the server or anywhere else. The plumbing is real
   * and the destination is not, so the honest place for the key is here rather than in a table
   * of things the game does.
   *
   * The scaffolding is kept rather than ripped out: `HandshakeOptions`, `NetClient` and
   * `HeadlessClient` all carry the request, and it is what the feed will be built on. Put the
   * row back in the README on the day something reads it.
   */
  ['rewinddebug', 'shared/net/NetClient — asks for a per-shot rewind feed that does not exist yet; see PLAN.md, round 5 B9'],
  ['harness', 'client/debug/BotHarness — the in-browser bot-match harness, a developer instrument'],
  ['bots', 'client/debug/BotHarness — roster size for that harness'],
  ['speed', 'client/debug/BotHarness — time scale for that harness'],
  ['tier', 'client/debug/BotHarness — bot difficulty for that harness'],
  ['map', 'client/debug/BotHarness — map for that harness'],
  ['mode', 'client/debug/BotHarness — mode for that harness'],
  ['matches', 'client/debug/BotHarness — match count for that harness'],
  ['show', 'client/probes/layout — which surface the headless layout probe mounts'],
]);

/** The documented keys, for the check and for anything that wants to know what is legal. */
export const URL_FLAG_KEYS: ReadonlySet<string> = new Set(URL_FLAGS.map((f) => f.key));

/**
 * The longest display name that reaches a scoreboard.
 *
 * Applied on both sides, from here, because it used to be applied by two identical loops in
 * two files — and one of them was applied at the wrong moment. See `withRewindSuffix`.
 */
export const MAX_NAME_LENGTH = 20;

/**
 * How a client asks for the rewind feed without the protocol growing a field for it.
 *
 * The string appeared three times — `Handshake`, `NetClient` and `net/Session` — which is two
 * more than a wire convention should. It is here so the two halves of the convention cannot
 * drift apart, and so the interaction below is stated once rather than discovered again.
 */
export const REWIND_DEBUG_SUFFIX = '#rw';

/**
 * A display name safe to put on a scoreboard.
 *
 * Trimmed, capped and stripped of control characters. The server's copy is the one that
 * matters — a client is untrusted — but sending something sane costs nothing and means the
 * player sees the name they typed rather than the name the server had to cut down.
 *
 * `fallback` is what an empty or absent name resolves to, which is the only thing the two old
 * copies of this function disagreed about: the client returned `'OPERATOR'` and the server
 * returned `''` and left the substitution to its caller.
 */
export function sanitiseName(raw: string | null | undefined, fallback: string): string {
  if (raw === null || raw === undefined) return fallback;
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= MAX_NAME_LENGTH) break;
  }
  const trimmed = out.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Which name a join uses, and the precedence is the point (playtest round 5, B9).
 *
 * **URL, then profile, then the generated default.** The same ladder `parseJoinOptions` already
 * documents for the address — *"`?server` wins, then the build-time `VITE_SERVER_URL`, then the
 * page's own origin"* — because the alternative is one parser resolving two flags in opposite
 * directions, which is how `?name=` came to be read, discarded and documented all at once.
 *
 * The README's own developer workflow is the use case that decides it: *"open it twice, in two
 * windows, with different names — that is a two-player match"* cannot work under any other
 * precedence, because both windows share one profile.
 */
export function resolveDisplayName(urlName: string | null, profileName: string): string {
  const fromProfile = sanitiseName(profileName, 'OPERATOR');
  return sanitiseName(urlName, fromProfile);
}

/**
 * The name as it goes on the wire, with the rewind-feed opt-in attached.
 *
 * Appended **after** the cap rather than before it, and that is a fix rather than a detail
 * (playtest round 5, found while on B9). The client capped the name at 20 and then appended
 * `#rw`, producing 23 characters; the server sanitised the incoming name — capping it at 20
 * again — and only then asked whether it ended in `#rw`. The three characters that answer the
 * question were the three the cap had just removed, so `?rewinddebug=1` was silently ignored
 * for any callsign of 18 characters or more. The wire's string field holds 255 bytes, so there
 * was never a reason for the suffix to be inside the budget.
 */
export function withRewindSuffix(name: string, wantRewindDebug: boolean): string {
  return wantRewindDebug ? `${name}${REWIND_DEBUG_SUFFIX}` : name;
}

/** One incoming name, split into the name and the request that was riding on it. */
export interface IncomingName {
  readonly name: string;
  readonly wantsRewindDebug: boolean;
}

/**
 * Undo `withRewindSuffix`, then sanitise — in that order, which is the half the server had
 * backwards. Stripping first means a full-length name keeps all twenty of its characters.
 */
export function readIncomingName(raw: string, fallback: string): IncomingName {
  const wantsRewindDebug = raw.endsWith(REWIND_DEBUG_SUFFIX);
  const bare = wantsRewindDebug ? raw.slice(0, -REWIND_DEBUG_SUFFIX.length) : raw;
  return { name: sanitiseName(bare, fallback), wantsRewindDebug };
}
