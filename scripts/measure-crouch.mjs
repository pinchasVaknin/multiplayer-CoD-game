#!/usr/bin/env node
/**
 * M13 Phase C1 — measure the crouching body before deciding what to do about its hitboxes.
 *
 * Until C2, `HitboxRig` compressed `HUMANOID_RIG` uniformly by `heightScale` (capsule height
 * over `standHeight`): 0.61 in a crouch, 0.31 in a slide. The skinned avatar ignores that number
 * and plays a crouch clip instead (`CharacterAvatar.update`), so where the drawn head actually is
 * during a crouch is a property of the clip, not of the rig — and nobody had measured it. This
 * script does, headless, with no browser and no game loop; C2 built the low layouts in
 * `HitboxRig` from its `--pose` table, and it stays the instrument for re-measuring them when a
 * crouch clip changes:
 *
 *   1. parse a catalogued skin with the same `GLTFLoader` the client uses (textures are
 *      declined through a parser plugin, since a skeleton needs none);
 *   2. wrap it in the real `CharacterSkin` so `modelYaw` and `modelScale` are the game's;
 *   3. prepare each crouch/slide clip with the real `importClip` — the same "last clip in the
 *      file" rule, the same root lock, the same translation scale — and play it through an
 *      `AnimationMixer` frame by frame;
 *   4. read `mixamorigHead`, `mixamorigHeadTop_End`, the spine chain and the hips in world
 *      space, with the skin at the actor origin (feet), which is exactly where the rig's boxes
 *      are measured from.
 *
 * The output is Markdown: the drawn body per clip, then each clip against the layout the game
 * wears while drawing it — the standing layout for a standing clip, and for a crouch clip the
 * low layout `rigLayoutFor` picks at that clip's speed (idle, walk or run; a slide draws the
 * same loops and wears the same layouts). A delta larger than the layout's padding means the
 * clip has moved and the layout has not. A clip whose export skeleton differs from the skin's
 * (the `incoming/` files carry a `mixamorigNeck1` the skins lack) is measured on its own
 * skeleton as well, so the height the skin loses to the missing bone is a number.
 *
 * The game's TypeScript is loaded through Vite's `ssrLoadModule`, the same trick
 * `layout-probe.mjs` uses to serve it: Node cannot read the tree's extensionless imports on
 * its own (see `vite.server.config.ts`), and copying the rig table into a script is how a
 * measurement quietly drifts from the thing it measures.
 *
 * This is an instrument. It changes nothing; Phase C2 decides from its table.
 *
 *   node scripts/measure-crouch.mjs
 *   node scripts/measure-crouch.mjs --dir public/models/bots/animations/locomotion/crouch --skin all
 *   node scripts/measure-crouch.mjs --skin path/to/other.glb --match 'crouch|slide|idle'
 *
 * Since M13 Phase D the library is a tree of slot folders (`locomotion/stand`, `deaths`, …)
 * and `--dir` is one folder, not recursive; the default is still `incoming/`, where a clip
 * waits to be measured. `scripts/animation-manifest.mjs` is the cheaper first look — clip
 * names, durations, bones — and this is the one that plays the clip on a skin.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DEFAULT_DIR = 'public/models/bots/animations/incoming';

// -- arguments ----------------------------------------------------------------

function parseArgs(argv) {
  const args = { dirs: [], skin: 'echo', match: 'crouch|slide', fps: 30, pose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--dir') args.dirs.push(next());
    else if (arg === '--skin') args.skin = next();
    else if (arg === '--match') args.match = next();
    else if (arg === '--fps') args.fps = Number(next());
    else if (arg === '--pose') args.pose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: measure-crouch.mjs [--dir <animations dir>]... [--skin <id|all|file.glb>] [--match <regex>] [--fps <n>] [--pose]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (args.dirs.length === 0) args.dirs.push(DEFAULT_DIR);
  if (!Number.isFinite(args.fps) || args.fps <= 0) throw new Error('--fps must be a positive number');
  return args;
}

// -- loading ------------------------------------------------------------------

const loader = new GLTFLoader();
// A skeleton needs no textures, and Node has no image decoder. `assignTexture` already treats a
// null texture as "no map", so declining every texture here is a supported path, not a shim.
loader.register(() => ({ name: 'measure-crouch:no-textures', loadTexture: () => Promise.resolve(null) }));

async function parseGlb(file) {
  const bytes = readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return loader.parseAsync(buffer, '');
}

/** Every bone under `root`, by name — what a clip's tracks can bind to. */
function boneNames(root) {
  const names = new Set();
  root.traverse((node) => {
    if (node.isBone === true) names.add(node.name);
  });
  return names;
}

/** Snapshot every bone's local transform so the bind pose can be put back between clips. */
function captureBindPose(root) {
  const pose = [];
  root.traverse((node) => {
    if (node.isBone !== true) return;
    pose.push({ node, p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() });
  });
  return pose;
}

function restoreBindPose(pose) {
  for (const { node, p, q, s } of pose) {
    node.position.copy(p);
    node.quaternion.copy(q);
    node.scale.copy(s);
  }
}

// -- sampling -----------------------------------------------------------------

/** Bones sampled, top of the body first. `HeadTop_End` is the crown; `Head` is the skull base. */
const LANDMARKS = [
  'mixamorigHeadTop_End',
  'mixamorigHead',
  'mixamorigNeck',
  'mixamorigSpine2',
  'mixamorigSpine1',
  'mixamorigSpine',
  'mixamorigHips',
];

/**
 * The limbs as well, for `--pose`: enough joints to place a box per body segment. Printed in
 * the actor's frame — the one `HitboxRig` measures its boxes in — where the body faces −Z.
 */
const POSE_LANDMARKS = [
  ...LANDMARKS,
  'mixamorigLeftArm',
  'mixamorigLeftForeArm',
  'mixamorigLeftHand',
  'mixamorigRightArm',
  'mixamorigRightForeArm',
  'mixamorigRightHand',
  'mixamorigLeftUpLeg',
  'mixamorigLeftLeg',
  'mixamorigLeftFoot',
  'mixamorigRightUpLeg',
  'mixamorigRightLeg',
  'mixamorigRightFoot',
];

/**
 * World position of each landmark at each frame of `clip`, played on `root` through the
 * mixer. The root must already be positioned as the game positions it (the actor origin at
 * the feet). Y is stored under the bone name; x and z under `name.x` / `name.z`.
 */
function sampleClip(root, clip, fps) {
  const bones = new Map();
  for (const name of POSE_LANDMARKS) {
    const bone = root.getObjectByName(name);
    if (bone !== undefined) bones.set(name, bone);
  }

  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();

  // Frame times strictly inside [0, duration): a looping action at exactly `duration` wraps
  // to frame 0, which would make the last sample of a transition its first pose.
  const times = [];
  for (let i = 0; i * (1 / fps) < clip.duration - 1e-6; i++) times.push(i / fps);
  times.push(Math.max(0, clip.duration - 1e-4));

  const frames = [];
  const scratch = new THREE.Vector3();
  for (const t of times) {
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    const frame = { t };
    for (const [name, bone] of bones) {
      bone.getWorldPosition(scratch);
      frame[name] = scratch.y;
      frame[name + '.x'] = scratch.x;
      frame[name + '.z'] = scratch.z;
    }
    frames.push(frame);
  }

  action.stop();
  mixer.uncacheClip(clip);
  return frames;
}

function stats(frames, name) {
  const values = frames.map((f) => f[name]).filter((v) => typeof v === 'number');
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  return { min, max, mean: sum / values.length, first: values[0], last: values[values.length - 1] };
}

// -- what a clip is -----------------------------------------------------------

/**
 * Which stance the game is in while it draws this clip, from the file name. Loops are compared
 * on their mean pose; a transition on its last frame, the pose it settles in. A death is not
 * compared: the rig of a dead body is nobody's target. A clip that names no low stance is a
 * standing one, which is how `--match idle` gets the standing baseline into the same table.
 */
function classify(stem) {
  if (/death/i.test(stem)) return { kind: 'death', stance: null };
  if (/transition|_to_/i.test(stem)) {
    return { kind: 'transition', stance: /to_stand/i.test(stem) ? 'stand' : 'crouch' };
  }
  if (/slide/i.test(stem)) return { kind: 'loop', stance: 'slide' };
  if (/crouch/i.test(stem)) return { kind: 'loop', stance: 'crouch' };
  return { kind: 'loop', stance: 'stand' };
}

// -- the run ------------------------------------------------------------------

function listClipFiles(dirs, match) {
  const regex = new RegExp(match, 'i');
  const files = [];
  for (const dir of dirs) {
    const abs = path.resolve(ROOT, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a directory: ${dir}`);
    for (const name of readdirSync(abs).sort()) {
      if (!name.toLowerCase().endsWith('.glb') || !regex.test(name)) continue;
      files.push({ dir, name, abs: path.join(abs, name) });
    }
  }
  return files;
}

function fmt(v, digits = 3) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function signed(v, digits = 3) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const vite = await createServer({
    root: ROOT,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  });
  try {
    const { HUMANOID_LAYOUTS, rigLayoutFor } = await vite.ssrLoadModule('/src/shared/combat/HitboxRig.ts');
    const { LOCOMOTION_IDLE_SPEED, LOCOMOTION_RUN_SPEED } = await vite.ssrLoadModule('/src/shared/player/Stance.ts');
    const { CHARACTER_DEFINITIONS } = await vite.ssrLoadModule('/src/client/characters/CharacterCatalog.ts');
    const { validateSkin, importClip } = await vite.ssrLoadModule('/src/client/characters/CharacterAssetImport.ts');
    const { CharacterSkin } = await vite.ssrLoadModule('/src/client/characters/CharacterSkin.ts');

    /**
     * The layout the game wears while drawing a clip, asked of the same function the runtimes
     * ask (`rigLayoutFor`), with the speed the clip's name implies: a run loop is only ever
     * reached above the run threshold, a walk loop between the two, an idle below the dead zone.
     */
    const layoutForClip = (stem, kind) => {
      if (kind.kind === 'death') return null;
      const stance = kind.stance === 'stand' ? 'STAND' : 'CROUCH';
      const speed = /run/i.test(stem)
        ? LOCOMOTION_RUN_SPEED
        : /walk/i.test(stem)
          ? (LOCOMOTION_IDLE_SPEED + LOCOMOTION_RUN_SPEED) / 2
          : 0;
      return rigLayoutFor(stance, speed, 0);
    };
    const landmarksOf = (layout) => {
      const head = layout.boxes.find((b) => b.name === 'head');
      const chest = layout.boxes.find((b) => b.upper === true);
      if (head === undefined || chest === undefined) throw new Error(`layout "${layout.id}" has no head or chest box`);
      return {
        id: layout.id,
        headTop: head.oy + head.sy / 2,
        headBottom: head.oy - head.sy / 2,
        chestCentre: chest.oy,
      };
    };

    // Which skins.
    let skins;
    if (args.skin === 'all') {
      skins = Object.values(CHARACTER_DEFINITIONS).map((d) => ({
        id: d.id,
        rig: d.rig,
        file: path.join(PUBLIC, d.skinUrl.split('?')[0]),
      }));
    } else if (args.skin.toLowerCase().endsWith('.glb')) {
      const file = path.resolve(ROOT, args.skin);
      if (!existsSync(file)) throw new Error(`no such skin file: ${args.skin}`);
      skins = [{ id: path.basename(file, '.glb'), rig: CHARACTER_DEFINITIONS.echo.rig, file }];
    } else {
      const definition = CHARACTER_DEFINITIONS[args.skin];
      if (definition === undefined) {
        throw new Error(`unknown skin "${args.skin}"; catalogued: ${Object.keys(CHARACTER_DEFINITIONS).join(', ')}, or "all"`);
      }
      skins = [{ id: definition.id, rig: definition.rig, file: path.join(PUBLIC, definition.skinUrl.split('?')[0]) }];
    }

    const clipFiles = listClipFiles(args.dirs, args.match);
    if (clipFiles.length === 0) {
      throw new Error(`no .glb matching /${args.match}/i in ${args.dirs.join(', ')}`);
    }

    // Parse every clip file once; they are shared across skins exactly as the repository shares them.
    const sources = [];
    for (const file of clipFiles) {
      const gltf = await parseGlb(file.abs);
      const clip = gltf.animations.at(-1);
      if (clip === undefined) throw new Error(`${file.name} contains no clips`);
      sources.push({ ...file, stem: path.basename(file.name, '.glb'), gltf, clip, clipCount: gltf.animations.length });
    }

    // results[skinId] = { bind, clips: [{ stem, ... }] }
    const results = [];
    for (const skin of skins) {
      results.push(await measureSkin(skin, sources, args.fps, { validateSkin, importClip, CharacterSkin }));
    }

    printReport({
      args,
      skins: results,
      sources,
      layouts: HUMANOID_LAYOUTS.map(landmarksOf),
      layoutFor: (clip) => {
        const layout = layoutForClip(clip.stem, clip.kind);
        return layout === null ? null : landmarksOf(layout);
      },
      standing: landmarksOf(rigLayoutFor('STAND', 0, 0)),
    });
  } finally {
    await vite.close();
  }
}

async function measureSkin(skin, sources, fps, game) {
  const gltf = await parseGlb(skin.file);
  const scene = gltf.scene;
  const binding = game.validateSkin(scene, skin.rig, skin.id);
  const skinBones = binding.bones;

  // The real skin wrapper: `modelYaw` and `modelScale` are applied where the game applies them.
  const wrapped = new game.CharacterSkin(scene, skin.rig);
  const root = new THREE.Group();
  root.add(wrapped.root);
  root.updateMatrixWorld(true);
  const bindPose = captureBindPose(scene);

  const scratch = new THREE.Vector3();
  const bind = {};
  const bindLandmarks = {};
  for (const name of POSE_LANDMARKS) {
    const bone = scene.getObjectByName(name);
    if (bone === undefined) continue;
    bone.getWorldPosition(scratch);
    bind[name] = scratch.y;
    bindLandmarks[name] = { x: scratch.x, y: scratch.y, z: scratch.z };
  }

  const clips = [];
  for (const source of sources) {
    // The last clip of the file, by its own name: the catalogue's rule for a contract file
    // (one clip, named after the file) and the session-export rule for a raw `incoming/` one.
    const definition = {
      id: source.stem,
      url: source.name,
      clipName: source.clip.name,
      loop: true,
      weaponReady: true,
    };
    // `importClip` drops the tracks for bones this skin does not have (Phase D); which ones
    // is worth a column, because a bone the clip has and the skin lacks is a height difference.
    const prepared = game.importClip(definition, source.gltf.animations, skin.rig, binding);
    const offSkin = new Set();
    for (const track of source.clip.tracks) {
      const bone = track.name.split('.')[0] ?? '';
      if (!skinBones.has(bone)) offSkin.add(bone);
    }

    restoreBindPose(bindPose);
    const frames = sampleClip(root, prepared, fps);

    // The same clip on the skeleton it was exported with, placed as the skin is placed, so
    // "what was authored" and "what the skin draws" are two columns of one table.
    let authored = null;
    if (offSkin.size > 0) {
      const own = source.gltf.scene;
      const ownRoot = new THREE.Group();
      ownRoot.rotation.y = skin.rig.modelYaw;
      ownRoot.scale.setScalar(skin.rig.modelScale);
      ownRoot.add(own);
      const ownMotion = own.getObjectByName(skin.rig.motionBone);
      if (ownMotion === undefined) throw new Error(`${source.name} has no ${skin.rig.motionBone}`);
      const ownBindPose = captureBindPose(own);
      const ownPrepared = game.importClip(definition, source.gltf.animations, skin.rig, {
        bindMotionPosition: ownMotion.position.clone(),
        bones: boneNames(own),
      });
      const ownFrames = sampleClip(ownRoot, ownPrepared, fps);
      restoreBindPose(ownBindPose);
      ownRoot.remove(own);
      authored = Object.fromEntries(LANDMARKS.map((name) => [name, stats(ownFrames, name)]));
    }

    clips.push({
      stem: source.stem,
      dir: source.dir,
      clipCount: source.clipCount,
      duration: prepared.duration,
      frames: frames.length,
      kind: classify(source.stem),
      offSkin: [...offSkin],
      stats: Object.fromEntries(LANDMARKS.map((name) => [name, stats(frames, name)])),
      pose: Object.fromEntries(
        POSE_LANDMARKS.map((name) => [
          name,
          { x: stats(frames, name + '.x'), y: stats(frames, name), z: stats(frames, name + '.z') },
        ]),
      ),
      authored,
    });
  }
  restoreBindPose(bindPose);

  return { id: skin.id, rigId: skin.rig.id, modelScale: skin.rig.modelScale, bind, bindLandmarks, clips };
}

// -- the report ---------------------------------------------------------------

function printReport({ args, skins, sources, layouts, layoutFor, standing }) {
  const out = [];
  const line = (s = '') => out.push(s);

  line('# Crouch measurement (M13 Phase C1)');
  line();
  line(`- Clips: ${sources.length} file(s) matching \`/${args.match}/i\` in ${args.dirs.map((d) => `\`${d}\``).join(', ')}, the **last** clip of each (the only one in a contract file; the wanted one in a session export), sampled at ${args.fps} fps.`);
  line(`- Skin(s): ${skins.map((s) => `\`${s.id}\` (${s.rigId}, modelScale ${s.modelScale})`).join(', ')}. World Y in metres, actor origin at the feet.`);
  line(
    `- Layouts (\`HitboxRig\`), head box top / head box bottom / chest centre: ` +
      layouts.map((l) => `\`${l.id}\` ${fmt(l.headTop)} / ${fmt(l.headBottom)} / ${fmt(l.chestCentre)}`).join('; ') +
      '.',
  );
  line();

  for (const skin of skins) {
    if (skins.length > 1) {
      line(`## Skin \`${skin.id}\``);
      line();
    }

    line('### Where the drawn body is');
    line();
    line('Head top is `mixamorigHeadTop_End` (the crown); head is `mixamorigHead` (skull base). Loops: min / **mean** / max over the clip. Transitions and deaths: first → last frame.');
    line();
    line('| Clip | Clips in file | Length | Head top Y | Head Y | Spine2 Y | Spine1 Y | Hips Y | Tracks not on skin |');
    line('|---|---|---|---|---|---|---|---|---|');
    line(
      `| *bind pose (no clip)* | — | — | ${fmt(skin.bind['mixamorigHeadTop_End'])} | ${fmt(skin.bind['mixamorigHead'])} | ${fmt(skin.bind['mixamorigSpine2'])} | ${fmt(skin.bind['mixamorigSpine1'])} | ${fmt(skin.bind['mixamorigHips'])} | — |`,
    );
    for (const clip of skin.clips) {
      const cell = (name) => {
        const s = clip.stats[name];
        if (s === null) return '—';
        if (clip.kind.kind === 'loop') return `${fmt(s.min)} / **${fmt(s.mean)}** / ${fmt(s.max)}`;
        return `${fmt(s.first)} → ${fmt(s.last)} (min ${fmt(s.min)})`;
      };
      line(
        `| \`${clip.stem}\` | ${clip.clipCount} | ${fmt(clip.duration, 2)} s, ${clip.frames} f | ${cell('mixamorigHeadTop_End')} | ${cell('mixamorigHead')} | ${cell('mixamorigSpine2')} | ${cell('mixamorigSpine1')} | ${cell('mixamorigHips')} | ${clip.offSkin.length === 0 ? 'none' : clip.offSkin.map((b) => b.replace('mixamorig', '')).join(', ')} |`,
      );
    }
    line();

    line('### Against the layout the game wears');
    line();
    line('The layout `rigLayoutFor` picks for the clip (a slide draws these same loops and wears these same layouts). Δ = drawn − layout; positive means the drawn body is above the box. The head box is padded 1 cm above and below the measured crown and skull base, so a |Δ| over a few centimetres means the clip moved and the layout did not. `Spine2` is the landmark that sits on the standing chest centre in the bind pose.');
    line();
    line('| Clip | Pose | Layout | Drawn head top | Layout head top | Δ head top | Drawn head | Layout head-box bottom | Δ head | Drawn Spine2 | Layout chest centre | Δ chest |');
    line('|---|---|---|---|---|---|---|---|---|---|---|---|');

    const rows = [
      {
        label: '*bind pose*',
        pose: 'bind',
        headTop: skin.bind['mixamorigHeadTop_End'],
        head: skin.bind['mixamorigHead'],
        spine2: skin.bind['mixamorigSpine2'],
        layout: standing,
      },
    ];
    for (const clip of skin.clips) {
      const { kind } = clip.kind;
      const layout = layoutFor(clip);
      if (layout === null) continue;
      const pick = (name) => {
        const s = clip.stats[name];
        if (s === null) return undefined;
        return kind === 'loop' ? s.mean : s.last;
      };
      rows.push({
        label: `\`${clip.stem}\``,
        pose: kind === 'loop' ? 'mean' : 'last frame',
        headTop: pick('mixamorigHeadTop_End'),
        head: pick('mixamorigHead'),
        spine2: pick('mixamorigSpine2'),
        layout,
      });
    }
    for (const row of rows) {
      const l = row.layout;
      line(
        `| ${row.label} | ${row.pose} | \`${l.id}\` | ${fmt(row.headTop)} | ${fmt(l.headTop)} | **${signed(row.headTop - l.headTop)}** | ${fmt(row.head)} | ${fmt(l.headBottom)} | ${signed(row.head - l.headBottom)} | ${fmt(row.spine2)} | ${fmt(l.chestCentre)} | ${signed(row.spine2 - l.chestCentre)} |`,
      );
    }
    line();

    if (args.pose) {
      line('### Pose, actor frame (mean over the clip; last frame for transitions)');
      line();
      line('x right, y up, and the body faces **−z**: a negative z is in front of the feet. `HitboxRig` boxes are authored in this frame.');
      line();
      const shown = skin.clips.filter((c) => c.kind.kind !== 'death');
      const columns = ['*bind*', ...shown.map((c) => `\`${c.stem}\``)];
      line(`| Landmark | ${columns.join(' | ')} |`);
      line(`|---|${columns.map(() => '---').join('|')}|`);
      const xyz = (x, y, z) => `${fmt(x, 2)}, ${fmt(y, 2)}, ${fmt(z, 2)}`;
      for (const name of POSE_LANDMARKS) {
        const cells = [];
        const b = skin.bindLandmarks[name];
        cells.push(b === undefined ? '—' : xyz(b.x, b.y, b.z));
        for (const clip of shown) {
          const p = clip.pose[name];
          if (p === undefined || p.x === null || p.y === null || p.z === null) {
            cells.push('—');
            continue;
          }
          const pick = (s) => (clip.kind.kind === 'loop' ? s.mean : s.last);
          cells.push(xyz(pick(p.x), pick(p.y), pick(p.z)));
        }
        line(`| ${name.replace('mixamorig', '')} | ${cells.join(' | ')} |`);
      }
      line();
    }

    const differing = skin.clips.filter((c) => c.authored !== null);
    if (differing.length > 0) {
      line('### Clip on its own export skeleton vs on this skin');
      line();
      line('These clips were exported on a skeleton with bones this skin lacks. Played on the skin, the tracks for those bones bind to nothing and the offset they carried is gone. Mean over the clip; Δ = on skin − authored.');
      line();
      line('| Clip | Authored head top | On skin | Δ | Authored head | On skin | Δ | Authored Spine1 | On skin | Δ |');
      line('|---|---|---|---|---|---|---|---|---|---|');
      for (const clip of differing) {
        const pair = (name) => {
          const a = clip.authored[name];
          const b = clip.stats[name];
          if (a === null || b === null) return '— | — | —';
          return `${fmt(a.mean)} | ${fmt(b.mean)} | ${signed(b.mean - a.mean)}`;
        };
        line(`| \`${clip.stem}\` | ${pair('mixamorigHeadTop_End')} | ${pair('mixamorigHead')} | ${pair('mixamorigSpine1')} |`);
      }
      line();
    }
  }

  if (skins.length > 1) {
    line('## Head top by skin (mean over the clip; last frame for transitions)');
    line();
    line(`| Clip | ${skins.map((s) => `\`${s.id}\``).join(' | ')} | Spread |`);
    line(`|---|${skins.map(() => '---').join('|')}|---|`);
    const bindValues = skins.map((s) => s.bind['mixamorigHeadTop_End']);
    line(`| *bind pose* | ${bindValues.map((v) => fmt(v)).join(' | ')} | ${fmt(Math.max(...bindValues) - Math.min(...bindValues))} |`);
    for (let i = 0; i < sources.length; i++) {
      const values = skins.map((s) => {
        const clip = s.clips[i];
        const st = clip.stats['mixamorigHeadTop_End'];
        if (st === null) return undefined;
        return clip.kind.kind === 'loop' ? st.mean : st.last;
      });
      const finite = values.filter((v) => typeof v === 'number');
      line(`| \`${sources[i].stem}\` | ${values.map((v) => fmt(v)).join(' | ')} | ${finite.length > 0 ? fmt(Math.max(...finite) - Math.min(...finite)) : '—'} |`);
    }
    line();
  }

  process.stdout.write(out.join('\n') + '\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
