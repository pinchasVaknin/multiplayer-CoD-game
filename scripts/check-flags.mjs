#!/usr/bin/env node
/**
 * The URL flag table in `README.md`, against the parser that has to honour it (round 5, B9).
 *
 * B9 reported two documented flags not doing what the README said. `?name=ALICE` was the worse
 * one: `parseJoinOptions` read it and its only caller overwrote the result on the next line, so
 * the flag was parsed, discarded, and documented as a feature — for a milestone, with two
 * clients joining as the same callsign and nothing anywhere saying a word. `?server=1` was not
 * broken at all; the prose around the table implied a connection the code has never made.
 *
 * Neither is a parsing bug. The defect is that a **public interface had three copies and no
 * check**: a table in the README, a table in `JoinOptions`'s header comment, and the parser. So
 * this holds them to each other:
 *
 *  1. The README's table and `URL_FLAGS` agree, row for row, cell for cell, in order.
 *  2. Every documented flag names a key the client actually reads. This is the brief's ask in
 *     one sentence — *the next flag cannot be documented into existence without existing.*
 *  3. Every key the client reads is declared, as documented or as deliberately not. A new
 *     `params.get('...')` fails the gate until somebody says which it is.
 *
 * ## What it cannot catch, stated so nobody trusts it too far
 *
 * A flag that is parsed and then ignored — which is exactly what `?name=` was — is invisible to
 * a grep: the key is read, the README describes it, and every rule above passes. That is why
 * `shared/debug/UrlFlagAudit` exists and runs the resolution for real. This half is structural
 * and that half is behavioural, and B9 needed both.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECLARATION = path.join(ROOT, 'src/shared/net/UrlFlags.ts');
const README = path.join(ROOT, 'README.md');
const CLIENT = path.join(ROOT, 'src/client');

/**
 * Read one quoted string starting at `i`, or null if there is not one there.
 *
 * Single and double quotes only. A template literal is refused rather than parsed, because the
 * declaration's whole job is to hold text a check can compare literally, and a `${...}` hole is
 * text this cannot know the value of — see `readDeclaration`.
 */
function readString(source, i) {
  const quote = source[i];
  if (quote !== "'" && quote !== '"') return null;
  let out = '';
  let k = i + 1;
  while (k < source.length && source[k] !== quote) {
    if (source[k] === '\\') {
      const next = source[k + 1];
      out += next === 'n' ? '\n' : next;
      k += 2;
      continue;
    }
    out += source[k];
    k++;
  }
  return { value: out, end: k + 1 };
}

/** Every `field: '...'` in `source`, in order, for the fields named. */
function readFields(source, fields) {
  const found = [];
  const pattern = new RegExp(`\\b(${fields.join('|')})\\s*:\\s*`, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const at = match.index + match[0].length;
    if (source[at] === '`') {
      return {
        error:
          `${path.relative(ROOT, DECLARATION)}: \`${match[1]}\` is a template literal. The ` +
          'declaration has to hold text this check can compare against the README character ' +
          'for character, so these are plain quoted strings.',
      };
    }
    const str = readString(source, at);
    if (str === null) continue;
    found.push({ field: match[1], value: str.value });
    pattern.lastIndex = str.end;
  }
  return { found };
}

/**
 * Slice out one exported array or map literal by brace matching, so neighbours cannot leak in.
 *
 * The opening bracket is looked for **after the `=`**, which is not fussiness: the first `[` on
 * `export const URL_FLAGS: readonly UrlFlag[] = [` belongs to the *type*, and matching it
 * returned the empty pair `[]` and therefore a table of zero rows. The check went red for the
 * right reason with the wrong evidence, which is the failure mode worth catching early.
 */
function block(source, marker, open, close) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const assign = source.indexOf('=', start);
  if (assign < 0) return null;
  const from = source.indexOf(open, assign);
  if (from < 0) return null;
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}

function readDeclaration() {
  const source = readFileSync(DECLARATION, 'utf8');

  const flagBlock = block(source, 'export const URL_FLAGS', '[', ']');
  if (flagBlock === null) throw new Error('URL_FLAGS not found in ' + DECLARATION);
  const flagFields = readFields(flagBlock, ['key', 'syntax', 'effect']);
  if (flagFields.error !== undefined) throw new Error(flagFields.error);

  // Fields arrive in source order; a row is one of each, and anything else is a malformed table.
  const rows = [];
  for (let i = 0; i + 2 < flagFields.found.length + 1; i += 3) {
    const [a, b, c] = flagFields.found.slice(i, i + 3);
    if (a?.field !== 'key' || b?.field !== 'syntax' || c?.field !== 'effect') break;
    rows.push({ key: a.value, syntax: b.value, effect: c.value });
  }

  const undocBlock = block(source, 'export const UNDOCUMENTED_URL_KEYS', '[', ']');
  if (undocBlock === null) throw new Error('UNDOCUMENTED_URL_KEYS not found in ' + DECLARATION);
  const undocumented = new Set();
  const entry = /\[\s*(['"])([^'"]+)\1\s*,/g;
  let m;
  while ((m = entry.exec(undocBlock)) !== null) undocumented.add(m[2]);

  return { rows, undocumented };
}

/** The README's flag table: the contiguous run of `| ... | ... |` rows after the header. */
function readReadmeTable() {
  const lines = readFileSync(README, 'utf8').split(/\r?\n/);
  const head = lines.findIndex((l) => /^\|\s*Flag\s*\|\s*Effect\s*\|/.test(l));
  if (head < 0) throw new Error('No "| Flag | Effect |" table found in README.md');
  const rows = [];
  for (let i = head + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 2) break;
    rows.push({ syntax: cells[0], effect: cells[1], line: i + 1 });
  }
  return rows;
}

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (name.endsWith('.ts')) yield full;
  }
}

/**
 * Every query key the client reads, with where it read it.
 *
 * Two shapes, because the first pass knew only one and quietly missed `?show` — read through an
 * inline `new URLSearchParams(window.location.search).get('show')` in the layout probe. The
 * check reported **ok** while one of the twelve keys was invisible to it, which is worse than a
 * failure: a grep that passes over what it cannot see is the false green this repo keeps writing
 * checks to avoid.
 *
 * So the coverage is enforced rather than hoped for. Every `new URLSearchParams` under
 * `src/client/` must either be chained straight into `.get(...)` or be bound to one of the names
 * below; a third spelling fails the gate instead of hiding a key from it.
 */
function readKeysUsed() {
  const used = new Map();
  const named = /(?:params|searchParams)\s*\.\s*get\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  const inline = /new\s+URLSearchParams\s*\([^)]*\)\s*\.\s*get\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  const construction = /new\s+URLSearchParams\b/g;
  const bound = /\b(?:const|let|var)\s+(?:params|searchParams)\s*=\s*new\s+URLSearchParams\b/g;

  const uncovered = [];
  let files = 0;
  for (const file of sources(CLIENT)) {
    files++;
    const source = readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');

    for (const pattern of [named, inline]) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(source)) !== null) {
        if (!used.has(m[2])) used.set(m[2], rel);
      }
    }

    const built = (source.match(construction) ?? []).length;
    const chained = (source.match(inline) ?? []).length;
    const assigned = (source.match(bound) ?? []).length;
    if (built > chained + assigned) {
      uncovered.push(
        `${rel} constructs URLSearchParams ${built} time(s) but this check can follow only ` +
          `${chained + assigned} of them. Bind it to \`params\` or \`searchParams\`, or chain ` +
          '`.get(...)` onto it, so no query key is read where the audit cannot see it.',
      );
    }
  }
  return { used, files, uncovered };
}

const problems = [];
const { rows: declared, undocumented } = readDeclaration();
const table = readReadmeTable();
const { used, files, uncovered } = readKeysUsed();
problems.push(...uncovered);

// ---- 1. the README and the declaration, row for row -------------------------
if (declared.length !== table.length) {
  problems.push(
    `README.md documents ${table.length} flag row(s); URL_FLAGS declares ${declared.length}. ` +
      'A row in one and not the other is B9: a flag documented into existence, or one that ' +
      'exists and nobody was told about.',
  );
}
for (let i = 0; i < Math.max(declared.length, table.length); i++) {
  const a = declared[i];
  const b = table[i];
  if (a === undefined || b === undefined) continue;
  if (a.syntax !== b.syntax) {
    problems.push(
      `row ${i + 1}: README.md:${b.line} says \`${b.syntax}\`, URL_FLAGS says \`${a.syntax}\`.`,
    );
  }
  if (a.effect !== b.effect) {
    problems.push(
      `row ${i + 1} (${a.syntax}): the effect text differs.\n` +
        `      README.md:${b.line}  ${b.effect}\n` +
        `      URL_FLAGS       ${a.effect}`,
    );
  }
}

// ---- 2. a documented flag names a key the client reads ----------------------
for (const row of declared) {
  if (!used.has(row.key)) {
    problems.push(
      `${row.syntax} is documented but nothing under src/client/ reads \`${row.key}\`. ` +
        'That is a flag documented into existence, which is the half of B9 this check exists ' +
        'for.',
    );
  }
}

// ---- 3. a key the client reads is declared, one way or the other ------------
const documentedKeys = new Set(declared.map((r) => r.key));
for (const [key, where] of used) {
  if (documentedKeys.has(key) || undocumented.has(key)) continue;
  problems.push(
    `${where} reads \`?${key}\`, which is in neither URL_FLAGS nor UNDOCUMENTED_URL_KEYS. ` +
      'Add it to the README table, or to the undocumented list with the reason it is not ' +
      'public — "undocumented" is a decision and not a gap.',
  );
}

if (problems.length > 0) {
  console.error('flag audit FAILED:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s). See scripts/check-flags.mjs.`);
  process.exit(1);
}

console.log(
  `flag audit ok — ${declared.length} documented row(s) over ${documentedKeys.size} key(s), ` +
    `${undocumented.size} undocumented key(s) with reasons, ${used.size} key(s) read across ` +
    `${files} client file(s), README and declaration identical.`,
);
