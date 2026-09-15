#!/usr/bin/env node
/**
 * The skin texture pass (M15, B0 — decision 5).
 *
 * Seven Mixamo skins weighed 109 MB, and three of them — Viper, Echo and Hazard — were 24 to
 * 38 MB each. Not geometry: 24–32 k vertices is 1.5–1.9 MB. Textures. Each carried two or
 * three material sets with a 2048×2048 PNG normal map and a 2048×2048 PNG diffuse (6–8 MB
 * apiece), where the four light skins carried the same maps at 1024 (1–1.6 MB). The default
 * skin, the one that preloads at boot, was the 28 MB one.
 *
 * This runs every skin through two `gltf-transform` steps — `resize` to at most 1024 on a side
 * (Lanczos3; nothing is ever enlarged) and `jpeg` at quality 88 over the PNGs — and replaces
 * the file only if the rig came through untouched: same node names in the same order, same
 * joint counts, same animations with the same channel counts (`rigSignature`). Every material
 * in the library is `OPAQUE` metallic-roughness, so JPEG loses nothing a material reads.
 * Measured on the day: **109 MB → 17.3 MB**, the heaviest skin 4.0 MB.
 *
 * ## Not a dependency
 *
 * S2 admits no new package, and this adds none: the CLI runs through `npx` at a pinned
 * version, downloads on first use, and is not part of `npm run build`. It is a pass you run
 * when a skin is added or replaced — `check:skins` is what tells you to — and the result is
 * committed like any other asset. Run it as `node scripts/skin-compress.mjs`; add `--dry` to
 * see the sizes without replacing anything.
 *
 * After a pass, bump `CHARACTER_VERSION` in `CharacterCatalog.ts`: the skin URLs are
 * versioned for the cache, and a client that already holds the old bytes will keep them
 * until the version moves.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, rigSignature } from './glb-images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKINS_DIR = path.join(ROOT, 'public/models/bots/skins');
/** Pinned: the pass should produce the same bytes next year as today. */
const CLI = '@gltf-transform/cli@4.5.0';
const MAX_SIDE = 1024;
const JPEG_QUALITY = 88;

const dry = process.argv.includes('--dry');
/**
 * npx as the JS entry beside this node binary, run by this node binary: no shell, so no
 * `.cmd` shim on Windows and no argument concatenation for Node 24 to warn about.
 */
const NPX_CLI = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');

function run(args) {
  execFileSync(process.execPath, [NPX_CLI, '--yes', CLI, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const work = mkdtempSync(path.join(tmpdir(), 'operator-skins-'));
const files = readdirSync(SKINS_DIR).filter((f) => f.endsWith('.glb')).sort();
let before = 0;
let after = 0;
try {
  for (const file of files) {
    const src = path.join(SKINS_DIR, file);
    const resized = path.join(work, file.replace(/\.glb$/, '.resized.glb'));
    const out = path.join(work, file);
    run(['resize', src, resized, '--width', String(MAX_SIDE), '--height', String(MAX_SIDE)]);
    run(['jpeg', resized, out, '--formats', 'png', '--quality', String(JPEG_QUALITY)]);

    const was = statSync(src).size;
    const now = statSync(out).size;
    before += was;
    after += now;
    const same = rigSignature(readGlb(src)) === rigSignature(readGlb(out));
    const verdict = same ? (dry ? 'would replace' : 'replaced') : 'RIG CHANGED — kept the original';
    console.log(`${file.padEnd(12)} ${(was / 1048576).toFixed(2).padStart(6)} MB -> ${(now / 1048576).toFixed(2).padStart(5)} MB  ${verdict}`);
    if (same && !dry) copyFileSync(out, src);
    if (!same) process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${files.length} skins: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB${dry ? ' (dry run, nothing written)' : ''}.`);
if (!dry) console.log('Now bump CHARACTER_VERSION in src/client/characters/CharacterCatalog.ts and run npm run check:skins.');
