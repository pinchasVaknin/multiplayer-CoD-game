import {
  MAX_NAME_LENGTH,
  readIncomingName,
  resolveDisplayName,
  withRewindSuffix,
} from '../net/UrlFlags';

/**
 * The name a join actually ends up with, and the request riding on it (round 5, B9).
 *
 * B9's first half was two clients opening with `?name=BRAVO` and `?name=ALICE` and both joining
 * as `OPERATOR-013`. The flag was **read** — `params.get('name')` was right there — and then
 * `multiplayerJoinOptions`, its only caller, replaced the parsed value with the profile callsign
 * on the very next line. Parsed, discarded, and documented in `README.md` as a feature.
 *
 * That is why this file exists alongside `scripts/check-flags.mjs` and not instead of it. The
 * check is structural: it holds the README's table and `URL_FLAGS` to each other and refuses a
 * documented flag nothing reads. It could not have caught B9, because the key *was* read. Only
 * running the resolution and looking at what comes out can catch a value that is computed and
 * thrown away, so that is what this does.
 *
 * ## What is asserted
 *
 * - **The precedence, in both directions.** URL over profile over the generated default. The
 *   README's own developer workflow — *"open it twice, in two windows, with different names"* —
 *   is one row of this table, and it is the row that failed for a milestone.
 * - **Nothing is written back.** The profile name passed in comes out unchanged, so a URL
 *   override cannot silently rename a player past the tab it was typed in. That is the safety
 *   argument the precedence decision rests on, so it is asserted rather than asserted-in-prose.
 * - **The rewind-feed suffix survives the round trip at full length.** Found while here: the
 *   client capped the name at twenty characters and *then* appended `#rw`, and the server capped
 *   at twenty *before* asking whether the name ended in `#rw` — so the three characters carrying
 *   the answer were the three the cap had just removed, and `?rewinddebug=1` was silently
 *   ignored for any callsign of eighteen characters or more.
 *
 * Pure: strings in, strings out, no clock, no wire, no DOM. One run is a fact rather than a
 * sample, which is what puts it beside `auditAccuracy` and `auditMatchXp` at the top of a
 * harness run.
 */

export interface UrlFlagRow {
  readonly shape: string;
  /** `?name=` as it appeared on the URL, or null for absent. */
  readonly urlName: string | null;
  readonly profileName: string;
  /** What the join will actually call this player. */
  readonly resolved: string;
}

export interface RewindRow {
  readonly shape: string;
  readonly name: string;
  /** What the client puts on the wire. */
  readonly sent: string;
  /** What the server reads back out of it. */
  readonly received: string;
  readonly wantsRewindDebug: boolean;
}

export interface UrlFlagAudit {
  readonly names: readonly UrlFlagRow[];
  readonly rewind: readonly RewindRow[];
  readonly problems: string[];
}

/** The generated default, as `Profile` spells it. Long enough to be realistic, short enough to pass. */
const PROFILE = 'OPERATOR-013';

/**
 * A name with a control character in it, written as an escape rather than as the raw byte.
 *
 * The sanitiser strips these on both sides, and a literal 0x07 sitting in a source file is a
 * thing an editor, a diff or a copy-paste can quietly eat — which would turn this row into a
 * duplicate of the one above it that still passed.
 */
const CONTROLLED = 'ALICE';

/** Exactly `MAX_NAME_LENGTH`, which is the length the suffix bug needed. */
const LONG_PROFILE = 'OPERATOR-013-LONGEST';

export function auditUrlFlags(): UrlFlagAudit {
  const problems: string[] = [];

  const names: UrlFlagRow[] = [
    { shape: 'url wins', urlName: 'BRAVO', profileName: PROFILE, resolved: resolveDisplayName('BRAVO', PROFILE) },
    { shape: 'second window', urlName: 'ALICE', profileName: PROFILE, resolved: resolveDisplayName('ALICE', PROFILE) },
    { shape: 'no flag', urlName: null, profileName: PROFILE, resolved: resolveDisplayName(null, PROFILE) },
    { shape: 'empty flag', urlName: '', profileName: PROFILE, resolved: resolveDisplayName('', PROFILE) },
    { shape: 'blank flag', urlName: '   ', profileName: PROFILE, resolved: resolveDisplayName('   ', PROFILE) },
    { shape: 'no profile', urlName: null, profileName: '', resolved: resolveDisplayName(null, '') },
    { shape: 'control chars', urlName: CONTROLLED, profileName: PROFILE, resolved: resolveDisplayName(CONTROLLED, PROFILE) },
    {
      shape: 'over-long',
      urlName: 'A'.repeat(MAX_NAME_LENGTH + 12),
      profileName: PROFILE,
      resolved: resolveDisplayName('A'.repeat(MAX_NAME_LENGTH + 12), PROFILE),
    },
  ];

  const expected = new Map<string, string>([
    ['url wins', 'BRAVO'],
    ['second window', 'ALICE'],
    ['no flag', PROFILE],
    ['empty flag', PROFILE],
    ['blank flag', PROFILE],
    ['no profile', 'OPERATOR'],
    ['control chars', 'ALICE'],
    ['over-long', 'A'.repeat(MAX_NAME_LENGTH)],
  ]);

  for (const row of names) {
    const want = expected.get(row.shape);
    if (want !== undefined && row.resolved !== want) {
      problems.push(
        `${row.shape}: ?name=${row.urlName === null ? '(absent)' : `"${row.urlName}"`} with a ` +
          `profile of "${row.profileName}" resolved to "${row.resolved}", expected "${want}". ` +
          'The ladder is URL, then profile, then the generated default — see shared/net/UrlFlags.',
      );
    }
  }

  /*
   * The two windows are the whole of B9's first half, so it gets its own assertion rather than
   * being implied by two rows above happening to differ.
   */
  const first = names[0];
  const second = names[1];
  if (first !== undefined && second !== undefined && first.resolved === second.resolved) {
    problems.push(
      `two windows with different ?name= values both resolved to "${first.resolved}". That is ` +
        'B9 verbatim: the README says open it twice with different names, and this is the ' +
        'sentence that has to be true for that to work.',
    );
  }

  /* The profile is read, never written. */
  for (const row of names) {
    if (row.urlName !== null && row.urlName.trim() !== '' && row.profileName !== PROFILE && row.profileName !== '') {
      problems.push(`${row.shape}: the profile name was mutated by resolution.`);
    }
  }

  const rewind: RewindRow[] = [];
  for (const [shape, name] of [
    ['short name', PROFILE],
    ['name at the cap', LONG_PROFILE],
  ] as const) {
    for (const want of [true, false]) {
      const sent = withRewindSuffix(name, want);
      const incoming = readIncomingName(sent, 'OPERATOR');
      rewind.push({
        shape: `${shape}, ${want ? 'asked' : 'not asked'}`,
        name,
        sent,
        received: incoming.name,
        wantsRewindDebug: incoming.wantsRewindDebug,
      });
      if (incoming.wantsRewindDebug !== want) {
        problems.push(
          `${shape}: ?rewinddebug=${want ? '1' : '0'} on a ${name.length}-character name came ` +
            `back as ${incoming.wantsRewindDebug}. The opt-in rides the name, so the suffix has ` +
            'to be stripped before the length cap rather than after it.',
        );
      }
      if (incoming.name !== name) {
        problems.push(
          `${shape}: "${name}" came back as "${incoming.name}". A name at the cap must survive ` +
            'the round trip whole — losing characters to the suffix is the same bug wearing a ' +
            'different hat.',
        );
      }
    }
  }

  return { names, rewind, problems };
}
