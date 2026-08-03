#!/usr/bin/env node
/**
 * Target-boundary enforcement (M9, S3 and S6.3).
 *
 * The brief's phrasing is why this exists: *"a rule a human has to remember is a rule that
 * will be broken by milestone eleven."* Eight milestones of habit will pull code back across
 * the line — a HUD read added to the sim path, an `engine/` type imported for one field —
 * and this is the only thing that will notice.
 *
 * ## Why this is hand-written
 *
 * S6.3 names `dependency-cruiser`, an ESLint boundaries rule, "or an equivalent". Both named
 * options were tried first. This project is on **TypeScript 7**, and dependency-cruiser
 * refuses to load a compiler newer than 6 — it reported `0 modules, 0 dependencies cruised`
 * and then exited **zero**. A check that passes because it read nothing is worse than no
 * check at all, because it is trusted. Pinning TypeScript backwards to satisfy a linter was
 * not worth it, so the check is written against the source directly.
 *
 * It does one thing the off-the-shelf tools do not, which turns out to matter here: it
 * checks **identifiers as well as imports**. `shared/` never importing `client/` is only
 * half the boundary — a bare `window.innerWidth` crosses it just as completely, and no
 * import graph can see that.
 *
 * ## What it enforces
 *
 *   shared/ -> client/    forbidden.  The simulation must load in Node.
 *   shared/ -> server/    forbidden.  The simulation must load in a browser.
 *   client/ -> server/    forbidden.  Two processes; neither links the other.
 *   server/ -> client/    forbidden.  Same.
 *   shared/ -> three      forbidden.  See BAN_THREE_IN_SHARED below.
 *   server/ -> three      forbidden.  A headless process does not render.
 *   shared/, server/      may not name a browser global (window, document, localStorage,
 *                         requestAnimationFrame, AudioContext, CanvasTexture,
 *                         performance.now, ...). Time comes from shared/core/Clock.
 *
 * Comments and string literals are stripped before the identifier scan, so prose about a
 * "multikill window" or a "save document" is not a violation. That is not a nicety — the
 * naive version of this check produced two false positives on its first run.
 *
 * Exit code is 1 on any violation, which is what makes it a build gate rather than a report.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/**
 * S3 permits Three's math classes in `shared/`, on the grounds that rewriting the vector
 * maths across eight milestones would be a large refactor with real regression risk.
 *
 * The M9 audit found the allowance is not needed: the simulation carries poses as loose
 * numbers throughout, and after the partition no file in `shared/` imports `three` at all.
 * A blanket ban is easier to enforce than a named-import whitelist and costs nothing today.
 * If a later milestone genuinely needs `Vector3` in shared code, relax this to a named-export
 * check — do not delete the rule.
 */
const BAN_THREE_IN_SHARED = true;

/** partition -> partitions it may not import from. */
const FORBIDDEN_EDGES = {
  shared: ['client', 'server'],
  client: ['server'],
  server: ['client'],
};

/** Bare module specifiers each partition may not import. */
const FORBIDDEN_PACKAGES = {
  shared: BAN_THREE_IN_SHARED ? [/^three(\/|$)/] : [],
  server: [/^three(\/|$)/],
  client: [],
};

/**
 * Identifiers that only exist in a browser.
 *
 * `performance` is here because S3 names `performance.now()` explicitly: the server has one
 * too, and using it would still be wrong, because the two runtimes must measure through the
 * same abstraction or the harness numbers are not comparable. See `shared/core/Clock.ts`.
 */
const BROWSER_GLOBALS = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'AudioContext',
  'webkitAudioContext',
  'CanvasTexture',
  'HTMLElement',
  'HTMLCanvasElement',
  'HTMLDivElement',
  'CanvasRenderingContext2D',
  'devicePixelRatio',
  'matchMedia',
  'getComputedStyle',
  'performance',
  'alert',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
];

const GLOBAL_CHECKED_PARTITIONS = new Set(['shared', 'server']);

/**
 * Maths whose result is not bit-identical across JavaScript engines.
 *
 * ECMA-262 leaves `sin`, `cos` and `tan` implementation-approximated, and the M9
 * cross-runtime check proved that is not theoretical: Node 24 (V8 13.6) and Chrome 148
 * (V8 14.x) disagree, which showed up as the simulation diverging on tick 149 of 3600.
 * Everything else the simulation uses — `sqrt`, `exp`, `pow`, `atan2`, `log`, `hypot` —
 * agreed, so the ban is narrow rather than a blanket one.
 *
 * `shared/core/SimMath.ts` provides `simSin`/`simCos`/`simTan`, built from operations IEEE
 * 754 specifies exactly. Client-side code is free to use the natives: a camera angle is not
 * simulation state and nobody replays it.
 */
const NON_DETERMINISTIC_MATH = ['sin', 'cos', 'tan'];

/** Files allowed to name them: the replacement itself, and the tool that compares the two. */
const MATH_EXEMPT = new Set(['shared/core/SimMath.ts', 'shared/debug/Determinism.ts']);

// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Blank out comments and string/template literals, preserving offsets and newlines.
 *
 * Offsets are preserved so a violation still reports the line it is really on. Replacing
 * with spaces rather than deleting is what buys that.
 */
function stripCommentsAndStrings(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
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

/** Every module specifier in a file: static imports/exports and dynamic import(). */
function specifiersOf(code) {
  const found = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const upto = code.slice(0, m.index);
    found.push({ spec: m[2], line: upto.split('\n').length });
  }
  return found;
}

function partitionOf(relPath) {
  const first = relPath.split('/')[0];
  return ['shared', 'client', 'server'].includes(first) ? first : null;
}

const violations = [];

function report(file, line, rule, message) {
  violations.push({ file, line, rule, message });
}

// ---- 1. import edges -------------------------------------------------------

const files = walk(SRC);

for (const abs of files) {
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  const from = partitionOf(rel);
  if (from === null) {
    report(rel, 1, 'unpartitioned', 'File is outside shared/, client/ and server/.');
    continue;
  }

  const raw = fs.readFileSync(abs, 'utf8');
  const code = stripCommentsAndStrings(raw);

  // Specifiers must be read from the *raw* source: stripping blanks their contents.
  for (const { spec, line } of specifiersOf(raw)) {
    if (spec.startsWith('.')) {
      const target = path
        .normalize(path.join(path.dirname(rel), spec))
        .split(path.sep)
        .join('/');
      const to = partitionOf(target);
      if (to !== null && FORBIDDEN_EDGES[from].includes(to)) {
        report(rel, line, `${from}-no-${to}`, `imports ${to}/ — '${spec}'`);
      }
      continue;
    }
    for (const pattern of FORBIDDEN_PACKAGES[from]) {
      if (pattern.test(spec)) {
        report(rel, line, `${from}-no-package`, `imports forbidden package '${spec}'`);
      }
    }
  }

  // ---- 2. engine-dependent maths ------------------------------------------
  // Only where the result is simulation state. `client/` draws with it and nobody replays
  // a camera angle, so the natives stay available there — see `shared/core/SimMath.ts`.
  if (GLOBAL_CHECKED_PARTITIONS.has(from) && !MATH_EXEMPT.has(rel)) {
    for (const fn of NON_DETERMINISTIC_MATH) {
      const re = new RegExp(`\\bMath\\.${fn}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(code)) !== null) {
        const line = code.slice(0, m.index).split('\n').length;
        report(
          rel,
          line,
          `${from}-no-engine-math`,
          `Math.${fn} is not bit-identical across engines — use sim${fn[0].toUpperCase()}${fn.slice(1)} from shared/core/SimMath`,
        );
      }
    }
  }

  // ---- 3. browser globals -------------------------------------------------
  if (!GLOBAL_CHECKED_PARTITIONS.has(from)) continue;

  for (const name of BROWSER_GLOBALS) {
    // Bare identifier, not a property access (`this.window`, `foo.document`) and not a
    // declaration of something with the same name.
    const re = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      const line = code.slice(0, m.index).split('\n').length;
      const text = raw.split('\n')[line - 1]?.trim() ?? '';
      report(rel, line, `${from}-no-browser-global`, `references '${name}' — ${text}`);
    }
  }
}

// ---- report ----------------------------------------------------------------

if (violations.length === 0) {
  const counts = { shared: 0, client: 0, server: 0 };
  for (const abs of files) {
    const p = partitionOf(path.relative(SRC, abs).split(path.sep).join('/'));
    if (p !== null) counts[p]++;
  }
  console.log(
    `boundaries ok — ${files.length} files (shared ${counts.shared}, client ${counts.client}, server ${counts.server})`,
  );
  process.exit(0);
}

console.error(`\nBOUNDARY VIOLATIONS (${violations.length})\n`);
const byRule = new Map();
for (const v of violations) {
  const list = byRule.get(v.rule) ?? [];
  list.push(v);
  byRule.set(v.rule, list);
}
for (const [rule, list] of byRule) {
  console.error(`  ${rule}  (${list.length})`);
  for (const v of list) console.error(`    src/${v.file}:${v.line}  ${v.message}`);
  console.error('');
}
console.error(
  'The partition is enforced, not advisory (M9 S3). If shared/ needs something the client ' +
    'has,\ninvert it behind an interface in shared/ — see StreakPresentation and ' +
    'ProgressionStore.\n',
);
process.exit(1);
