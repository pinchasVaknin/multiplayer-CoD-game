#!/usr/bin/env node
/**
 * Where a decorator may not go (M14, Phase D).
 *
 * M14 admitted legacy decorators (`experimentalDecorators` + `oxc.decorator.legacy`) under
 * three rules that the compiler cannot state and the transform will not refuse:
 *
 *  1. **Never on the simulation tick.** A wrapper call per entity per tick is an allocation on
 *     the path S4.7 froze, and the seeded harness would not necessarily notice — a `finally`
 *     around `step` changes no outcome, only the per-tick cost. So no decorator on a method
 *     named `simulate`, `step`, `onTick` or `tick` anywhere in `src/`, and none at all under
 *     `src/shared/net`, `src/shared/player`, `src/shared/combat` or `src/shared/ai`, the hot
 *     loops and the wire.
 *  2. **Never on a field.** With `useDefineForClassFields: true` a field is [[Define]]d on the
 *     instance and shadows whatever a legacy property decorator put on the prototype, so the
 *     decorator silently does nothing — the worst kind of wrong. Classes and methods only;
 *     `accessor` is refused for the same reason (the legacy transform cannot lower it).
 *  3. Tests are files like any other. A `.test.ts` under `src/` is scanned; a toy `step` in a
 *     test is renamed, not exempted (the Phase B test's became `double` for exactly this).
 *
 * Text, not types: the tree is scanned with comments and string bodies blanked, so `@param`
 * in a doc comment and an `@` in a string are not decorators. A decorator is `@name`, with or
 * without arguments, at the start of a statement; what it decorates is whatever follows the
 * stack of them — `class`, a method (an identifier before `(` or `<`), or a field (an
 * identifier before `:`, `=`, `;`, `!`, `?` or a line end). Parameter decorators are not looked
 * for: nothing here uses them and nothing here should.
 *
 * Exit code is 1 on any violation, which is what makes it a gate rather than a report. It was
 * proved red on three planted violations (a decorated `step`, a decorated field, a decorator
 * under `shared/combat`) before it joined the chain, as `check-plan` was.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/** Method names that are the tick path, wherever they are. */
const TICK_METHODS = new Set(['simulate', 'step', 'onTick', 'tick']);

/** Folders where no decorator of any kind may appear. */
const FROZEN_DIRS = ['shared/net', 'shared/player', 'shared/combat', 'shared/ai'];

const MODIFIERS =
  /^(?:export|default|abstract|public|private|protected|static|readonly|override|async|declare)\s+/;

// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Blank out comments and string/template bodies, preserving offsets and newlines. */
function stripCommentsAndStrings(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index just past a balanced `(...)` starting at `at` (which must be `(`). */
function skipParens(code, at) {
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

function skipSpace(code, at) {
  let i = at;
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/**
 * What the decorator stack starting at `at` (the `@`) decorates.
 *
 * Returns `{ kind, name, end }`: kind is 'class' | 'method' | 'field' | 'accessor' | 'unknown',
 * and `end` is where the target begins, so a stacked decorator is not counted twice.
 */
function targetOf(code, at) {
  let i = at;
  // The whole stack: `@a @b(...) @c` share one target.
  while (code[i] === '@') {
    i++;
    while (i < code.length && /[\w$.]/.test(code[i])) i++;
    i = skipSpace(code, i);
    if (code[i] === '(') i = skipParens(code, i);
    i = skipSpace(code, i);
  }
  let rest = code.slice(i, i + 200);
  let m;
  while ((m = MODIFIERS.exec(rest)) !== null) rest = rest.slice(m[0].length);

  if (/^class\b/.test(rest)) {
    const name = /^class\s+([A-Za-z_$][\w$]*)/.exec(rest);
    return { kind: 'class', name: name?.[1] ?? '(anonymous)', end: i };
  }
  if (/^accessor\b/.test(rest)) {
    const name = /^accessor\s+([A-Za-z_$][\w$]*)/.exec(rest);
    return { kind: 'accessor', name: name?.[1] ?? '?', end: i };
  }
  const getset = /^(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
  if (getset !== null) return { kind: 'method', name: getset[1], end: i };
  const method = /^\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/.exec(rest);
  if (method !== null) return { kind: 'method', name: method[1], end: i };
  const field = /^([A-Za-z_$][\w$]*)\s*[?!]?\s*(?:[:=;]|\n)/.exec(rest);
  if (field !== null) return { kind: 'field', name: field[1], end: i };
  return { kind: 'unknown', name: rest.split('\n')[0].trim().slice(0, 40), end: i };
}

// ---------------------------------------------------------------------------

const violations = [];
let decorators = 0;
const files = walk(SRC);

for (const abs of files) {
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  const raw = readFileSync(abs, 'utf8');
  const code = stripCommentsAndStrings(raw);
  const frozen = FROZEN_DIRS.find((d) => rel.startsWith(d + '/'));

  // A decorator starts a statement: `@` after a newline, `;`, `{` or `}` (whitespace aside).
  const re = /(^|[\n;{}])[ \t]*@(?=[A-Za-z_$])/g;
  let m;
  let lastStackEnd = -1;
  while ((m = re.exec(code)) !== null) {
    const at = m.index + m[0].length - 1;
    // A second decorator in the same stack was accounted for with the first.
    if (at < lastStackEnd) continue;
    decorators++;
    const line = code.slice(0, at).split('\n').length;
    const target = targetOf(code, at);
    lastStackEnd = target.end;
    const where = `src/${rel}:${line}`;
    const text = raw.split('\n')[line - 1]?.trim() ?? '';

    if (frozen !== undefined) {
      violations.push(
        `${where}  a decorator under src/${frozen}/ — the hot loops and the wire take no wrapper (S3)\n      ${text}`,
      );
    }
    if (target.kind === 'method' && TICK_METHODS.has(target.name)) {
      violations.push(
        `${where}  a decorator on ${target.name}() — the simulation tick takes no wrapper (S3)\n      ${text}`,
      );
    }
    if (target.kind === 'field') {
      violations.push(
        `${where}  a decorator on the field '${target.name}' — a [[Define]] field shadows the prototype, ` +
          `so a legacy property decorator does nothing; methods and classes only\n      ${text}`,
      );
    }
    if (target.kind === 'accessor') {
      violations.push(
        `${where}  a decorator on 'accessor ${target.name}' — the legacy transform cannot lower it\n      ${text}`,
      );
    }
    if (target.kind === 'unknown') {
      violations.push(
        `${where}  a decorator on something this check cannot classify: '${target.name}'\n      ${text}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`\nDECORATOR VIOLATIONS (${violations.length})\n`);
  for (const v of violations) console.error(`  ${v}\n`);
  console.error(
    'Legacy decorators go on classes and methods off the tick path, never on a field and never under ' +
      'shared/net, shared/player, shared/combat or shared/ai — see src/shared/core/Decorators.ts.\n',
  );
  process.exit(1);
}

console.log(
  `decorator audit ok — ${decorators} decorator use(s) across ${files.length} files, none on a tick ` +
    `method, none on a field, none under ${FROZEN_DIRS.join(', ')}.`,
);
