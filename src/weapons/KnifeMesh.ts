import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sharedWeaponSurfaces } from './WeaponMesh';
import type { SurfaceKey } from './WeaponMeshParts';

/**
 * The knife viewmodel (round 2 playtest).
 *
 * ## Why there is a mesh at all now
 *
 * Post-M8 shipped melee as a *bash*: the rifle stayed in frame and swung, because a swing is
 * cheap in transforms that already exist and a second viewmodel is a thing to build, camo,
 * dispose and keep in step with a weapon swap. That was the right call for getting the hitbox
 * and the damage door right, and QA agreed the mechanic works. What it is not is a knife —
 * the report asks for the blade — and the machinery it was avoiding turns out to be small,
 * because a knife is the one viewmodel with no moving parts: no magazine, no charging handle,
 * no muzzle, no sights, and no ADS pose to compensate for.
 *
 * So it is one static group, built once per match, hidden until `Melee.busy`. It shares the
 * weapon surfaces (see `sharedWeaponSurfaces`) so the blade is lit by the same three
 * materials the rifle is, and it is never camouflaged — a camo is a property of a weapon and
 * a knife is not one.
 *
 * ## The blade is a flattened four-gon, not a box
 *
 * Everything in this project is primitives, and a box makes a *shim*. A blade needs a section
 * that is thin across and deep top-to-bottom, coming to a point — which is exactly a
 * four-sided cylinder scaled hard in X, capped by a four-sided cone of the same section. Two
 * geometries, one merge, and the silhouette reads as a knife from the one angle that matters:
 * the lower right of the screen, mid-swing.
 *
 * Local space matches the weapon models: +X right, +Y up, **-Z forward**, roughly metres,
 * origin at the fist. The blade runs from the guard at `z = -0.072` to the point at
 * `z = -0.24`, which is a 168 mm blade — a fighting knife rather than a bayonet.
 */

export interface KnifeModel {
  readonly root: THREE.Group;
  dispose(): void;
}

/** How hard the blade's four-gon section is squashed across. 0.22 gives a ~9 mm blade. */
const BLADE_FLATTEN = 0.22;
/** Half-height of the blade section, metres. */
const BLADE_HALF = 0.021;
/** Height the blade and grip sit above the fist's centre line. */
const LINE_Y = 0.012;

export function buildKnifeModel(anisotropy: number): KnifeModel {
  const surfaces = sharedWeaponSurfaces(anisotropy);
  const root = new THREE.Group();
  root.name = 'viewmodel:knife';

  const bySurface = new Map<SurfaceKey, THREE.BufferGeometry[]>();
  const push = (key: SurfaceKey, geometry: THREE.BufferGeometry): void => {
    const list = bySurface.get(key);
    if (list === undefined) bySurface.set(key, [geometry]);
    else list.push(geometry);
  };

  const box = (
    key: SurfaceKey,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
  ): void => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx !== 0) g.rotateX(rx);
    g.translate(x, y, z);
    push(key, g);
  };

  /**
   * A length of blade. `tip` makes it a point rather than a prism.
   *
   * Built along +Y because that is the axis `CylinderGeometry` uses, flattened in X while the
   * section is still in the XZ plane, and only then swung down -Z — doing the squash after the
   * rotation would thin the blade top to bottom instead of across it.
   */
  const blade = (length: number, z: number, tip: boolean): void => {
    const g = new THREE.CylinderGeometry(tip ? 0 : BLADE_HALF, BLADE_HALF, length, 4, 1);
    g.scale(BLADE_FLATTEN, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, LINE_Y, z);
    push('gunmetal', g);
  };

  // The hand. Not detailed: it is behind the guard and mostly off the edge of the frame, and
  // its whole job is to stop the knife reading as a floating object.
  box('glove', 0.072, 0.082, 0.100, 0, -0.004, 0.052);
  box('glove', 0.076, 0.030, 0.052, 0, 0.030, 0.020);

  // Grip, slightly nose-down so the blade sits along the natural line of a held knife.
  box('polymer', 0.030, 0.038, 0.110, 0, LINE_Y - 0.002, -0.010, 0.06);
  box('polymer', 0.034, 0.014, 0.026, 0, LINE_Y - 0.018, 0.040);

  // Guard and ricasso: the two blocks that make a blade look attached to something.
  box('gunmetal', 0.050, 0.020, 0.014, 0, LINE_Y + 0.002, -0.072);
  box('gunmetal', 0.011, 0.034, 0.024, 0, LINE_Y, -0.090);

  blade(0.104, -0.134, false);
  blade(0.056, -0.213, true);

  const disposables: Array<{ dispose(): void }> = [];
  for (const [key, list] of bySurface) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (merged === null) continue;
    merged.computeBoundingSphere();
    const material = surfaces.get(key);
    if (material === undefined) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `viewmodel:knife:${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    disposables.push(merged);
  }

  return {
    root,
    dispose(): void {
      // Geometry only. The materials and their textures are shared for the life of the
      // process and are released by `disposeWeaponSurfaces`, exactly as a weapon's are.
      for (const d of disposables) d.dispose();
      root.clear();
    },
  };
}
