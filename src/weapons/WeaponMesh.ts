import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/Rng';

/**
 * The assault rifle, built from primitives in code (brief S2: zero external assets).
 *
 * Geometry is merged per material so the whole viewmodel is five draw calls: three for
 * the static body and two for the parts that have to move on their own — the magazine
 * and the charging handle, which the reload sequence animates independently.
 *
 * Local space matches the viewmodel camera: +X right, +Y up, **-Z forward**, origin at
 * the centre of the receiver. The iron sights are authored so that a line through the
 * rear notch and the front post sits at `SIGHT_HEIGHT` above the origin; that is the
 * number `ViewmodelConfig.adsY` has to cancel for the sights to land on the screen
 * centre when aimed.
 */

/** Height of the sight line above the weapon origin, metres. */
export const SIGHT_HEIGHT = 0.0915;

/** Where the muzzle flash is anchored, in weapon-local space. */
export const MUZZLE_LOCAL = { x: 0, y: 0.011, z: -0.585 } as const;

export interface WeaponModel {
  readonly root: THREE.Group;
  /** Slides out of the well and drops away during a reload. */
  readonly magazine: THREE.Group;
  /** Pulled and released on the empty reload. */
  readonly chargingHandle: THREE.Group;
  /** Muzzle flash is parented here so it tracks every animation the gun does. */
  readonly muzzle: THREE.Object3D;
  dispose(): void;
}

type SurfaceKey = 'gunmetal' | 'polymer' | 'glove';

interface BoxPart {
  readonly surface: SurfaceKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
}

interface TubePart {
  readonly surface: SurfaceKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly length: number;
  readonly sides?: number;
}

const BODY_BOXES: readonly BoxPart[] = [
  // -- receiver group, metal ---------------------------------------------
  { surface: 'gunmetal', x: 0, y: 0, z: 0, w: 0.058, h: 0.082, d: 0.3 },
  { surface: 'gunmetal', x: 0, y: 0.05, z: -0.02, w: 0.036, h: 0.022, d: 0.3 },
  { surface: 'gunmetal', x: 0.031, y: 0.018, z: -0.045, w: 0.005, h: 0.03, d: 0.07 },
  { surface: 'gunmetal', x: 0, y: 0.004, z: 0.2, w: 0.032, h: 0.036, d: 0.14 },
  { surface: 'gunmetal', x: 0, y: -0.038, z: 0.038, w: 0.008, h: 0.024, d: 0.01 },
  { surface: 'gunmetal', x: 0, y: 0.042, z: -0.352, w: 0.032, h: 0.038, d: 0.045 },

  // -- iron sights --------------------------------------------------------
  { surface: 'gunmetal', x: 0, y: 0.058, z: -0.352, w: 0.03, h: 0.026, d: 0.032 },
  { surface: 'gunmetal', x: 0, y: 0.079, z: -0.352, w: 0.007, h: 0.03, d: 0.007 },
  { surface: 'gunmetal', x: 0, y: 0.062, z: 0.062, w: 0.034, h: 0.02, d: 0.028 },
  { surface: 'gunmetal', x: -0.0135, y: 0.081, z: 0.062, w: 0.008, h: 0.026, d: 0.024 },
  { surface: 'gunmetal', x: 0.0135, y: 0.081, z: 0.062, w: 0.008, h: 0.026, d: 0.024 },

  // -- polymer furniture ---------------------------------------------------
  { surface: 'polymer', x: 0, y: 0.004, z: -0.255, w: 0.056, h: 0.062, d: 0.25 },
  { surface: 'polymer', x: 0, y: -0.088, z: 0.075, w: 0.036, h: 0.12, d: 0.055, rx: -0.28 },
  { surface: 'polymer', x: 0, y: -0.012, z: 0.265, w: 0.05, h: 0.095, d: 0.055 },
  { surface: 'polymer', x: 0, y: 0.03, z: 0.195, w: 0.036, h: 0.03, d: 0.11 },
  { surface: 'polymer', x: 0, y: -0.048, z: 0.028, w: 0.03, h: 0.008, d: 0.052 },

  // -- hands. Grey-box, but a viewmodel with no hands reads as a floating prop.
  { surface: 'glove', x: 0.006, y: -0.072, z: 0.072, w: 0.058, h: 0.085, d: 0.088, rx: -0.28 },
  { surface: 'glove', x: 0.036, y: -0.166, z: 0.196, w: 0.072, h: 0.078, d: 0.2, rx: -0.5 },
  { surface: 'glove', x: 0, y: -0.03, z: -0.262, w: 0.064, h: 0.076, d: 0.1 },
  { surface: 'glove', x: -0.056, y: -0.132, z: -0.168, w: 0.076, h: 0.076, d: 0.19, rx: 0.42, rz: -0.5 },
];

const BODY_TUBES: readonly TubePart[] = [
  { surface: 'gunmetal', x: 0, y: 0.011, z: -0.44, radius: 0.0105, length: 0.2 },
  { surface: 'gunmetal', x: 0, y: 0.011, z: -0.556, radius: 0.017, length: 0.052, sides: 10 },
];

const MAGAZINE_BOXES: readonly BoxPart[] = [
  { surface: 'polymer', x: 0, y: -0.105, z: -0.012, w: 0.03, h: 0.155, d: 0.078, rx: 0.12 },
  { surface: 'polymer', x: 0, y: -0.184, z: -0.002, w: 0.036, h: 0.014, d: 0.086, rx: 0.12 },
];

const CHARGING_BOXES: readonly BoxPart[] = [
  { surface: 'gunmetal', x: 0, y: 0.047, z: 0.152, w: 0.058, h: 0.016, d: 0.03 },
  { surface: 'gunmetal', x: 0, y: 0.047, z: 0.128, w: 0.02, h: 0.012, d: 0.05 },
];

export function buildWeaponModel(anisotropy: number): WeaponModel {
  const surfaces = buildSurfaces(anisotropy);
  const disposables: Array<{ dispose(): void }> = [];
  for (const material of surfaces.values()) {
    disposables.push(material);
    const map = material.map;
    if (map !== null) disposables.push(map);
  }

  const root = new THREE.Group();
  root.name = 'viewmodel:ar';

  addMerged(root, BODY_BOXES, BODY_TUBES, surfaces, disposables, 'body');

  const magazine = new THREE.Group();
  magazine.name = 'viewmodel:magazine';
  addMerged(magazine, MAGAZINE_BOXES, [], surfaces, disposables, 'mag');
  root.add(magazine);

  const chargingHandle = new THREE.Group();
  chargingHandle.name = 'viewmodel:charging';
  addMerged(chargingHandle, CHARGING_BOXES, [], surfaces, disposables, 'charge');
  root.add(chargingHandle);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'viewmodel:muzzle';
  muzzle.position.set(MUZZLE_LOCAL.x, MUZZLE_LOCAL.y, MUZZLE_LOCAL.z);
  root.add(muzzle);

  return {
    root,
    magazine,
    chargingHandle,
    muzzle,
    dispose(): void {
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
    // CylinderGeometry runs along +Y; the barrel runs along Z.
    g.rotateX(Math.PI / 2);
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

function buildSurfaces(anisotropy: number): Map<SurfaceKey, THREE.MeshStandardMaterial> {
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
  return out;
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
