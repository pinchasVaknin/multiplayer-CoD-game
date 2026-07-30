import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/Rng';
import {
  bodyBoxes,
  bodyTubes,
  barrelY,
  chargingBoxes,
  magazineBoxes,
  magazineTubes,
  muzzleZ,
  type BoxPart,
  type SurfaceKey,
  type TubePart,
} from './WeaponMeshParts';
import { modelSpecFor } from './WeaponModelSpecs';

/**
 * Viewmodels, built from primitives in code (brief S2: zero external assets).
 *
 * M2 hand-placed the AR's boxes. M5 needs twelve, and twelve hand-placed weapons is twelve
 * lists of coordinates that drift apart the first time the sight height changes — so the
 * geometry is now a *function* of a `WeaponModelSpec` and the specs are the content. The
 * carbine's spec reproduces M2's proportions; everything else varies from it.
 *
 * Geometry is merged per material, so a whole weapon is five draw calls: three for the
 * static body and two for the parts that move on their own — the magazine and the charging
 * handle (or the pump), which the reload sequence animates independently.
 *
 * Local space matches the viewmodel camera: +X right, +Y up, **-Z forward**, origin at the
 * centre of the receiver. The sights are authored so a line through them sits at
 * `spec.sightHeight` above the origin; that is the number `ViewmodelConfig.adsY` cancels
 * for the sights to land on the screen centre when aimed.
 *
 * Textures are built once per *process* and shared by every model — twelve weapons each
 * generating three 128px canvases would be thirty-six canvases for three distinct images.
 */

export interface WeaponModel {
  readonly root: THREE.Group;
  /** Slides out of the well and drops away during a reload. */
  readonly magazine: THREE.Group;
  /** Pulled and released on the empty reload. On a shotgun this is the pump. */
  readonly chargingHandle: THREE.Group;
  /** Muzzle flash is parented here so it tracks every animation the gun does. */
  readonly muzzle: THREE.Object3D;
  /**
   * Height of the sight line above the origin **in the parent's space**, metres —
   * `spec.sightHeight` with `spec.scale` already applied.
   *
   * The scale matters and was missed the first time: the root is scaled, so a weapon at
   * 1.08 has a sight line 8% higher than its spec says, and the ADS compensation in
   * `ViewmodelAnim` was cancelling the unscaled number. Measured error was up to 8.3 mm —
   * about 2.5 degrees at the ADS distance, which is a visibly misaligned sight picture on
   * the six weapons whose scale is not 1.
   */
  readonly sightHeight: number;
  /** Per-weapon correction to the shared ADS pose. See `WeaponModelSpec.adsOffsetZ`. */
  readonly adsOffsetZ: number;
  readonly weaponId: string;
  dispose(): void;
}

/**
 * Build one weapon.
 *
 * `anisotropy` reaches the shared textures on first use only; later calls reuse them, which
 * is why it is not part of the cache key. Every model in a match is built with the same
 * value in practice.
 */
export function buildWeaponModel(weaponId: string, anisotropy: number): WeaponModel {
  const spec = modelSpecFor(weaponId);
  const surfaces = sharedSurfaces(anisotropy);

  const root = new THREE.Group();
  root.name = `viewmodel:${weaponId}`;
  root.scale.setScalar(spec.scale);

  const disposables: Array<{ dispose(): void }> = [];

  addMerged(root, bodyBoxes(spec), bodyTubes(spec), surfaces, disposables, 'body');

  const magazine = new THREE.Group();
  magazine.name = 'viewmodel:magazine';
  addMerged(magazine, magazineBoxes(spec), magazineTubes(spec), surfaces, disposables, 'mag');
  root.add(magazine);

  const chargingHandle = new THREE.Group();
  chargingHandle.name = 'viewmodel:charging';
  addMerged(chargingHandle, chargingBoxes(spec), [], surfaces, disposables, 'charge');
  root.add(chargingHandle);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'viewmodel:muzzle';
  muzzle.position.set(0, barrelY(spec), muzzleZ(spec));
  root.add(muzzle);

  return {
    root,
    magazine,
    chargingHandle,
    muzzle,
    sightHeight: spec.sightHeight * spec.scale,
    adsOffsetZ: spec.adsOffsetZ,
    weaponId,
    dispose(): void {
      // Only the geometry is per model. The three materials and their textures are shared
      // for the life of the process and are released by `disposeWeaponSurfaces`.
      for (const d of disposables) d.dispose();
      root.clear();
    },
  };
}

// -- assembly ---------------------------------------------------------------

function addMerged(
  parent: THREE.Group,
  boxes: readonly BoxPart[],
  tubes: readonly TubePart[],
  surfaces: Map<SurfaceKey, THREE.MeshStandardMaterial>,
  disposables: Array<{ dispose(): void }>,
  label: string,
): void {
  const bySurface = new Map<SurfaceKey, THREE.BufferGeometry[]>();

  const push = (key: SurfaceKey, geometry: THREE.BufferGeometry): void => {
    const list = bySurface.get(key);
    if (list === undefined) bySurface.set(key, [geometry]);
    else list.push(geometry);
  };

  for (const part of boxes) {
    const g = new THREE.BoxGeometry(part.w, part.h, part.d);
    if (part.rx !== undefined) g.rotateX(part.rx);
    if (part.ry !== undefined) g.rotateY(part.ry);
    if (part.rz !== undefined) g.rotateZ(part.rz);
    g.translate(part.x, part.y, part.z);
    push(part.surface, g);
  }

  for (const part of tubes) {
    const g = new THREE.CylinderGeometry(part.radius, part.radius, part.length, part.sides ?? 12, 1);
    // CylinderGeometry runs along +Y; barrels run along Z.
    if (part.vertical !== true) g.rotateX(Math.PI / 2);
    g.translate(part.x, part.y, part.z);
    push(part.surface, g);
  }

  for (const [key, list] of bySurface) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (merged === null) continue;
    merged.computeBoundingSphere();
    const material = surfaces.get(key);
    if (material === undefined) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `viewmodel:${label}:${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    parent.add(mesh);
    disposables.push(merged);
  }
}

// -- surfaces ---------------------------------------------------------------

/**
 * The three materials, built once for the process.
 *
 * M2 built them per model, which was correct when there was one model. Twelve weapons and a
 * per-match rebuild would be thirty-six 128px canvases generated for three distinct images,
 * and every one of them a GPU upload on the frame the match starts.
 */
let cachedSurfaces: Map<SurfaceKey, THREE.MeshStandardMaterial> | null = null;

function sharedSurfaces(anisotropy: number): Map<SurfaceKey, THREE.MeshStandardMaterial> {
  if (cachedSurfaces !== null) return cachedSurfaces;
  const out = new Map<SurfaceKey, THREE.MeshStandardMaterial>();

  // A viewmodel is the one place in this project worth a real BRDF: it is a handful of
  // triangles filling a small part of the screen, and the difference between "metal" and
  // "plastic" is exactly what roughness is for.
  //
  // Metalness is deliberately kept low. A physically honest 0.85 metal has almost no
  // diffuse response and gets nearly all its colour from reflections — with no
  // environment map in the scene there is nothing to reflect, and the gun renders black.
  // Base colour lives in the textures; the material tints are left neutral.
  out.set(
    'gunmetal',
    new THREE.MeshStandardMaterial({
      map: gunmetalTexture(anisotropy),
      color: 0xffffff,
      roughness: 0.44,
      metalness: 0.3,
    }),
  );
  out.set(
    'polymer',
    new THREE.MeshStandardMaterial({
      map: polymerTexture(anisotropy),
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.02,
    }),
  );
  out.set(
    'glove',
    new THREE.MeshStandardMaterial({
      map: gloveTexture(anisotropy),
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
    }),
  );
  cachedSurfaces = out;
  return out;
}

/** Release the process-wide materials. Only the page teardown has any business calling it. */
export function disposeWeaponSurfaces(): void {
  if (cachedSurfaces === null) return;
  for (const material of cachedSurfaces.values()) {
    material.map?.dispose();
    material.dispose();
  }
  cachedSurfaces = null;
}

const TEX = 128;

function makeCanvas(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = TEX;
  canvas.height = TEX;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable; cannot build weapon textures.');
  return ctx;
}

function finish(ctx: CanvasRenderingContext2D, anisotropy: number, repeat: number): THREE.Texture {
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.repeat.set(repeat, repeat);
  texture.needsUpdate = true;
  return texture;
}

function gunmetalTexture(anisotropy: number): THREE.Texture {
  const ctx = makeCanvas();
  const rng = new Rng(0x6a17_c0de);
  ctx.fillStyle = '#565c66';
  ctx.fillRect(0, 0, TEX, TEX);
  // Machining marks running along the barrel axis.
  for (let i = 0; i < 340; i++) {
    const y = rng.float() * TEX;
    const a = rng.range(0.03, 0.11);
    ctx.fillStyle = rng.chance(0.5) ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(rng.float() * TEX, y, rng.range(12, 70), 1);
  }
  // Edge wear: a few brighter scuffs where a real rifle rubs.
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(220,225,235,${rng.range(0.05, 0.16)})`;
    ctx.fillRect(rng.float() * TEX, rng.float() * TEX, rng.range(3, 14), rng.range(1, 3));
  }
  return finish(ctx, anisotropy, 1);
}

function polymerTexture(anisotropy: number): THREE.Texture {
  const ctx = makeCanvas();
  const rng = new Rng(0x9f2b_5511);
  ctx.fillStyle = '#3a3e45';
  ctx.fillRect(0, 0, TEX, TEX);
  // Moulded stipple.
  for (let i = 0; i < 2600; i++) {
    const a = rng.range(0.03, 0.14);
    ctx.fillStyle = rng.chance(0.55) ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`;
    ctx.fillRect(rng.float() * TEX, rng.float() * TEX, rng.range(0.8, 2.2), rng.range(0.8, 2.2));
  }
  // Panel lines so the handguard does not read as one flat slab.
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 8; i++) {
    const x = (i / 8) * TEX;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEX);
    ctx.stroke();
  }
  return finish(ctx, anisotropy, 2);
}

function gloveTexture(anisotropy: number): THREE.Texture {
  const ctx = makeCanvas();
  const rng = new Rng(0x11a7_3ef0);
  ctx.fillStyle = '#5d574a';
  ctx.fillRect(0, 0, TEX, TEX);
  // Woven fabric: two crossing sets of threads.
  for (let i = 0; i < TEX; i += 3) {
    ctx.fillStyle = `rgba(0,0,0,${rng.range(0.06, 0.16)})`;
    ctx.fillRect(0, i, TEX, 1);
    ctx.fillStyle = `rgba(255,255,255,${rng.range(0.02, 0.07)})`;
    ctx.fillRect(i, 0, 1, TEX);
  }
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rng.range(0.04, 0.12)})`;
    ctx.fillRect(rng.float() * TEX, rng.float() * TEX, rng.range(1, 3), rng.range(1, 3));
  }
  return finish(ctx, anisotropy, 3);
}
