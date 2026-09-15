#!/usr/bin/env node
/**
 * The skin thumbnails (M15, B5).
 *
 * Renders every catalogued skin on the Create-a-Class stage — `probes/skin-thumb.html`, the
 * same `CharacterStage` the editor uses, held at one three-quarter pose — through the
 * headless Chrome `layout-probe.mjs` already drives, and writes the PNGs to
 * `public/models/bots/skins/thumbs/<File>.png`. Committed like any other asset; regenerated
 * when a skin is added or replaced, which `check:skins` is what tells you to.
 *
 * Why rendered once rather than live: the picker's strip shows all seven at once, and seven
 * live stages would be seven WebGL contexts and the whole 17 MB library fetched to open a
 * menu. A 320×400 PNG is tens of kilobytes and is the same picture the stage would draw.
 *
 * Software WebGL (`--disable-gpu`, SwiftShader) on purpose: the bytes are then the same on
 * every machine that regenerates them, which is what a committed asset wants. It is slower
 * than a GPU, and seven bodies take a few seconds.
 *
 * `node scripts/skin-thumbs.mjs [id ...]` — no ids renders every skin.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, withPage } from './headless-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'src/client/characters/CharacterCatalog.ts');
const THUMBS_DIR = path.join(ROOT, 'public/models/bots/skins/thumbs');

/** id → file stem, read off the catalogue the way `check-skins` reads it. */
function catalogued() {
  const source = readFileSync(CATALOG, 'utf8');
  const out = new Map();
  for (const m of source.matchAll(/character\('([a-z]+)',\s*'([A-Za-z0-9_-]+)\.glb'/g)) out.set(m[1], m[2]);
  return out;
}

const skins = catalogued();
const asked = process.argv.slice(2);
const ids = asked.length > 0 ? asked : [...skins.keys()];
for (const id of ids) {
  if (!skins.has(id)) {
    console.error(`no skin "${id}" in the catalogue. Known: ${[...skins.keys()].join(', ')}`);
    process.exit(1);
  }
}

mkdirSync(THUMBS_DIR, { recursive: true });

await withPage('thumbs', `/probes/skin-thumb.html?skin=${ids[0]}`, async ({ cdp, sessionId, load }) => {
  let first = true;
  for (const id of ids) {
    if (!first) await load(`/probes/skin-thumb.html?skin=${id}`);
    first = false;
    const ready = await evaluate(cdp, sessionId, 'window.__skinThumb !== undefined');
    if (ready !== true) throw new Error(`the thumbnail page loaded but never installed window.__skinThumb for "${id}"`);
    const started = Date.now();
    const dataUrl = await evaluate(cdp, sessionId, 'window.__skinThumb.render()');
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (match === null) throw new Error(`"${id}" did not come back as a PNG data URL`);
    const bytes = Buffer.from(match[1], 'base64');
    const file = path.join(THUMBS_DIR, `${skins.get(id)}.png`);
    writeFileSync(file, bytes);
    console.log(`${id.padEnd(8)} -> thumbs/${skins.get(id)}.png  ${Math.round(bytes.length / 1024)} kB  (${Date.now() - started} ms)`);
  }
});

console.log(`\n${ids.length} thumbnail(s) written to public/models/bots/skins/thumbs/.`);
