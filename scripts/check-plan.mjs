#!/usr/bin/env node
/**
 * PLAN.md against the archive it indexes (deep clean, 2026-09-14).
 *
 * PLAN.md is the handover: a fresh session inherits the repository and this file, nothing
 * else. By milestone thirteen it had reached 14,500 lines, of which 12,800 were the record of
 * milestones already closed — every session was loading eight milestones of history to find
 * the one it was there to continue. The clean-up moved the closed sections to
 * `docs/archive/plan/`, one file per section, and left an index. That fixes the file once; a
 * rule fixes it for good, and *"a rule a human has to remember is a rule that will be broken by
 * milestone eleven"* (check-boundaries.mjs). So this holds the file and the folder to each other:
 *
 *  1. PLAN.md carries at most two `# ` sections besides its title: the content backlog and the
 *     milestone in progress. A third means a milestone closed and was not archived.
 *  2. Every row of the index names a file that exists, and every file in the archive folder
 *     has a row. The index is the only way a "see PLAN.md, M5 notes" comment resolves.
 *  3. Every archive file opens with the provenance line the others carry, so a section's origin
 *     is on the file and not in anybody's memory.
 *
 * Exit code is 1 on any violation, which is what makes it a gate rather than a report.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = path.join(ROOT, 'PLAN.md');
const ARCHIVE = path.join(ROOT, 'docs/archive/plan');

/** The backlog and the milestone in progress. A third is a closed milestone nobody archived. */
const MAX_LIVING_SECTIONS = 2;

const problems = [];
const lines = readFileSync(PLAN, 'utf8').split(/\r?\n/);

// ---- 1. at most two living sections ------------------------------------------
let inFence = false;
const sections = [];
for (const [i, line] of lines.entries()) {
  if (line.startsWith('```')) inFence = !inFence;
  if (inFence) continue;
  if (line.startsWith('# ') && i > 0) sections.push({ line: i + 1, title: line.slice(2).trim() });
}
if (sections.length > MAX_LIVING_SECTIONS) {
  problems.push(
    `PLAN.md has ${sections.length} top-level sections besides its title; the limit is ` +
      `${MAX_LIVING_SECTIONS} (the backlog and the milestone in progress). A closed milestone ` +
      'moves to docs/archive/plan/ and gets a row in the index — see "How this file stays short":\n' +
      sections.map((s) => `      line ${s.line}: # ${s.title}`).join('\n'),
  );
}

// ---- 2. the index and the folder agree -----------------------------------------
const indexed = new Map();
for (const line of lines) {
  const m = /^\| \d+ \| .+ \| [\d,]+ \| \[([^\]]+)\]\(docs\/archive\/plan\/([^)]+)\) \|$/.exec(line);
  if (m !== null) indexed.set(m[2], m[1]);
}
let onDisk = [];
try {
  onDisk = readdirSync(ARCHIVE).filter((f) => f.endsWith('.md')).sort();
} catch {
  problems.push(`${path.relative(ROOT, ARCHIVE)} does not exist, but the index in PLAN.md points into it.`);
}
if (indexed.size === 0) problems.push('PLAN.md has no index rows of the form `| N | title | lines | [file](docs/archive/plan/file) |`.');
for (const [file, label] of indexed) {
  if (!onDisk.includes(file)) problems.push(`index row [${label}] names docs/archive/plan/${file}, which does not exist.`);
  if (label !== file) problems.push(`index row for ${file} is labelled "${label}"; the label is the file name.`);
}
for (const file of onDisk) {
  if (!indexed.has(file)) problems.push(`docs/archive/plan/${file} has no row in PLAN.md's index.`);
}

// ---- 3. every archive file says where it came from -----------------------------
const PROVENANCE = /^<!-- Moved verbatim from PLAN\.md lines \d+–\d+ at [0-9a-f]{7,} \(\d{4}-\d{2}-\d{2}\)\./;
for (const file of onDisk) {
  const first = readFileSync(path.join(ARCHIVE, file), 'utf8').split(/\r?\n/, 1)[0];
  if (!PROVENANCE.test(first)) {
    problems.push(
      `docs/archive/plan/${file} does not open with the provenance line ` +
        '`<!-- Moved verbatim from PLAN.md lines A–B at <commit> (<date>). ... -->`.',
    );
  }
}

if (problems.length > 0) {
  console.error('plan audit FAILED:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s). See scripts/check-plan.mjs and "How this file stays short" in PLAN.md.`);
  process.exit(1);
}

console.log(
  `plan audit ok — PLAN.md is ${lines.length} lines with ${sections.length} living section(s) ` +
    `(${sections.map((s) => s.title.split(' — ')[0]).join(', ')}), ${indexed.size} archived section(s) ` +
    'indexed, every one on disk with its provenance line.',
);
