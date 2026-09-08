#!/usr/bin/env node
/**
 * Facts the server owns, and the local copies the client must stop reading (round 5, B7).
 *
 * This milestone's recurring failure, in P0's words: *"a fact that moved to the server breaks
 * every reader of the local copy, silently."* Silently is the operative word — the local copy
 * still compiles, still has the right type, and still returns a number. It returns **zero**,
 * and zero is a plausible score, so nothing anywhere says a word.
 *
 * B7 is that failure with the volume turned up. The team score moved onto the snapshot header
 * at M10; `MatchFlow.teamScore()` is the accessor that knows it and prefers the replicated
 * value; `GameMode.teamScore()` is the local copy, and `MatchFlow`'s replicated path
 * deliberately never scores, so on a dedicated server it is a structural constant zero. Three
 * client call sites still read it. Two of them quietly printed `0 – 0` for a whole match and
 * nobody reported it. The third was the divergence checker, which compared its own zero against
 * the server's score and logged an `error` line per confirmed sample — which is how this became
 * the one item in the round the game reported about itself.
 *
 * ## Why a grep and not a type
 *
 * Both accessors are `(team: ScoreTeam) => number`. No type distinguishes "the server's answer"
 * from "the copy nobody writes any more", and inventing a branded type for one field would be a
 * lot of machinery around one call. A grep is the same instrument `check-cheats` uses for the
 * same reason: the rule is about *which of two indistinguishable things you reached for*, and
 * the cheapest honest enforcement is to name the wrong one.
 *
 * Add a row when the next fact migrates. That is the point of the table: the next migration
 * gets a check for free, and the one after that does not have to remember this happened.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NEWLINE = '\n';
const BACKSLASH = '\\';

/**
 * One migrated fact each.
 *
 * `pattern` is matched against source with comments and string bodies blanked, so prose about
 * the old accessor — of which there is a lot, and rightly — is not a violation.
 */
const MIGRATED = [
  {
    fact: 'the team score',
    // `mode.teamScore(...)` in any shape: `this.match.mode.teamScore`, a local `mode`, ...
    pattern: /\bmode\s*\.\s*teamScore\s*\(/g,
    under: 'src/client',
    instead: 'flow.teamScore(...)',
    because:
      'GameMode.teamScore is the local copy and MatchFlow never writes it on a replicated ' +
      'client, so it is zero on a dedicated server. MatchFlow.teamScore prefers the value off ' +
      'the snapshot header and falls back to the mode in single-player.',
  },
];

/**
 * Comments and string bodies blanked, code kept.
 *
 * Two details were wrong on the first attempt, and this check's own red control is what found
 * them — which is the argument for having watched it go red before trusting it green:
 *
 *  - **Newlines survive.** Blanking a block comment to nothing shifts every line after it, and
 *    a violation reported at the wrong line is a violation nobody can find.
 *  - **A template literal is not a string.** A `${ ... }` hole is code inside a quote, and
 *    blanking the whole literal hid two of the three real call sites.
 */
function strip(source) {
  const n = source.length;
  const out = [];
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) out.push(source[k] === NEWLINE ? NEWLINE : ' ');
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      const from = i;
      while (i < n && source[i] !== NEWLINE) i++;
      blank(from, i);
      continue;
    }

    if (c === '/' && next === '*') {
      const from = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      blank(from, i);
      continue;
    }

    if (c === '"' || c === "'") {
      const from = i;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === BACKSLASH) i++;
        i++;
      }
      i = Math.min(i + 1, n);
      blank(from, i);
      continue;
    }

    if (c === '`') {
      out.push(' ');
      i++;
      let depth = 0;
      while (i < n) {
        const ch = source[i];
        if (depth === 0) {
          if (ch === BACKSLASH) {
            out.push(' ', ' ');
            i += 2;
            continue;
          }
          if (ch === '`') {
            out.push(' ');
            i++;
            break;
          }
          if (ch === '$' && source[i + 1] === '{') {
            out.push(' ', ' ');
            i += 2;
            depth = 1;
            continue;
          }
          out.push(ch === NEWLINE ? NEWLINE : ' ');
          i++;
          continue;
        }
        // Inside a hole: copied through, with braces tracked so a nested literal closes.
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            out.push(' ');
            i++;
            continue;
          }
        }
        out.push(ch);
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join('');
}

function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (entry.endsWith('.ts')) yield full;
  }
}

/** Line number of an index, so a violation points at a line rather than at an offset. */
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === NEWLINE) line++;
  }
  return line;
}

const problems = [];
let scanned = 0;

for (const rule of MIGRATED) {
  for (const file of sources(path.join(ROOT, rule.under))) {
    scanned++;
    const code = strip(readFileSync(file, 'utf8'));
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(code)) !== null) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      problems.push(
        `${rel}:${lineAt(code, match.index)} reads the local copy of ${rule.fact}. ` +
          `Use ${rule.instead}.\n    ${rule.because}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('authority audit FAILED:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    `${problems.length} reader(s) of a fact the server owns. See scripts/check-authority.mjs.`,
  );
  process.exit(1);
}

console.log(
  `authority audit ok — ${MIGRATED.length} migrated fact(s), ${scanned} client file(s) scanned, ` +
    'no reader of a local copy.',
);
