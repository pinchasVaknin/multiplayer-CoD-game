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
  /** Blade, guard, grip and fist. Posed as one rigid object by `ViewmodelAnim.poseKnife`. */
  readonly root: THREE.Group;
  /**
   * The forearm, which is *not* a child of `root` (round 4).
   *
   * The report was that the hand "completely detaches from the player's body" once the poses
   * moved into frame — and it did, because there was nothing behind the fist. At `READY` the
   * fist had been sitting essentially on the camera, so the cut-off wrist was behind the near
   * plane and nobody saw it; moving the pose forward to make the knife visible made the stump
   * visible with it.
   *
   * It cannot be part of `root`, because `root` rotates through 100° of yaw across the swing
   * and a rigidly attached arm would swing with it and point at the ceiling. An arm connects
   * two points — a shoulder that does not move and a fist that does — so it is built as a unit
   * length along -Z and then aimed and stretched between them each frame. `KNIFE_SHOULDER` is
   * behind the camera, so the far end is always off-screen and the arm always runs out of
   * frame at the bottom right, which is the "cutoff point hidden off-screen" the report asked
   * for.
   */
  readonly arm: THREE.Group;
  dispose(): void;
}

/**
 * Viewmodel exaggeration (round 3).
 *
 * The geometry below is authored at life size — a 168 mm blade on a 110 mm grip — and life
 * size is the wrong size for the lower corner of a screen. The rifle gets away with it by
 * being 700 mm long; a knife at the same scale is a detail, which is the "barely visible"
 * half of the report that moving it into frame does not fix. 1.3 puts the blade at 218 mm,
 * which reads as a weapon at arm's length without becoming a machete.
 *
 * On the root, so `poseKnife` keeps writing plain position and rotation and the two concerns
 * stay separate.
 */
const KNIFE_SCALE = 1.3;

/** How hard the blade's four-gon section is squashed across. 0.22 gives a ~9 mm blade. */
const BLADE_FLATTEN = 0.22;
/** Half-height of the blade section, metres. */
const BLADE_HALF = 0.021;
/** Height the blade and grip sit above the fist's centre line. */
const LINE_Y = 0.012;

/** Forearm thickness at each end, metres. Not scaled by `KNIFE_SCALE` — see the build. */
const ARM_WRIST_RADIUS = 0.048;
const ARM_ELBOW_RADIUS = 0.062;

export function buildKnifeModel(anisotropy: number): KnifeModel {
  const surfaces = sharedWeaponSurfaces(anisotropy);
  const root = new THREE.Group();
  root.name = 'viewmodel:knife';
  root.scale.setScalar(KNIFE_SCALE);

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

  // The hand, and the cuff that covers the joint where the forearm meets it. The cuff is a
  // little wider than the arm on purpose: the fist yaws with the blade and the arm does not,
  // so without it the seam opens at the extremes of the swing.
  box('glove', 0.072, 0.082, 0.100, 0, -0.004, 0.052);
  box('glove', 0.076, 0.030, 0.052, 0, 0.030, 0.020);
  box('glove', 0.096, 0.096, 0.046, 0, 0.000, 0.098);

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

  /**
   * The forearm: one unit long down -Z, so `lookAt` plus a Z scale spans any two points.
   *
   * Tapered from the elbow to the wrist, and deliberately *not* scaled by `KNIFE_SCALE` — the
   * knife is exaggerated because it is a prop being read at a glance, an arm is exaggerated
   * by being long, and scaling its radius with the blade would produce a forearm thicker than
   * the fist on the end of it.
   */
  const arm = new THREE.Group();
  arm.name = 'viewmodel:knife:arm';
  const sleeve = new THREE.CylinderGeometry(ARM_WRIST_RADIUS, ARM_ELBOW_RADIUS, 1, 10, 1);
  sleeve.rotateX(-Math.PI / 2);
  sleeve.translate(0, 0, -0.5);
  const gloveMaterial = surfaces.get('glove');
  if (gloveMaterial !== undefined) {
    const armMesh = new THREE.Mesh(sleeve, gloveMaterial);
    armMesh.name = 'viewmodel:knife:forearm';
    arm.add(armMesh);
    disposables.push(sleeve);
  } else {
    sleeve.dispose();
  }

  return {
    root,
    arm,
    dispose(): void {
      // Geometry only. The materials and their textures are shared for the life of the
      // process and are released by `disposeWeaponSurfaces`, exactly as a weapon's are.
      for (const d of disposables) d.dispose();
      root.clear();
      arm.clear();
    },
  };
}
