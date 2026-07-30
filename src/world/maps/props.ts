import type { PropShapeDef, PropShapeId } from './types';

/**
 * The authored prop catalogue.
 *
 * A prop is a small composite of boxes in local space with its origin at the base,
 * so placements only need a ground position and a yaw. Parts marked `solid` become
 * colliders; trim does not. Every placement of a shape is drawn with one InstancedMesh
 * per part.
 *
 * Boxes only — the collision scheme is capsule versus oriented box and nothing else
 * (brief S4.3), so a prop's silhouette is never allowed to disagree with what the
 * player can walk into.
 */
export const PROP_SHAPES: Readonly<Record<PropShapeId, PropShapeDef>> = {
  crate: {
    id: 'crate',
    parts: [
      { offset: { x: 0, y: 0.35, z: 0 }, size: { x: 1.0, y: 0.7, z: 1.0 }, material: 'metal', solid: true },
      {
        offset: { x: 0, y: 0.715, z: 0 },
        size: { x: 0.86, y: 0.03, z: 0.86 },
        material: 'concreteDark',
        solid: false,
      },
    ],
  },
  crateTall: {
    id: 'crateTall',
    parts: [
      { offset: { x: 0, y: 0.75, z: 0 }, size: { x: 1.1, y: 1.5, z: 1.1 }, material: 'metal', solid: true },
      {
        offset: { x: 0, y: 1.515, z: 0 },
        size: { x: 0.94, y: 0.03, z: 0.94 },
        material: 'concreteDark',
        solid: false,
      },
    ],
  },
  pillar: {
    id: 'pillar',
    parts: [
      {
        offset: { x: 0, y: 2.4, z: 0 },
        size: { x: 0.7, y: 4.8, z: 0.7 },
        material: 'concreteDark',
        solid: true,
      },
      { offset: { x: 0, y: 0.15, z: 0 }, size: { x: 0.92, y: 0.3, z: 0.92 }, material: 'metal', solid: false },
    ],
  },
  barrier: {
    id: 'barrier',
    parts: [
      {
        offset: { x: 0, y: 0.5, z: 0 },
        size: { x: 2.0, y: 1.0, z: 0.4 },
        material: 'concreteDark',
        solid: true,
      },
      { offset: { x: 0, y: 1.02, z: 0 }, size: { x: 2.0, y: 0.06, z: 0.44 }, material: 'hazard', solid: false },
    ],
  },
  lightBox: {
    id: 'lightBox',
    parts: [
      { offset: { x: 0, y: 0.06, z: 0 }, size: { x: 0.7, y: 0.12, z: 0.3 }, material: 'accent', solid: false },
      { offset: { x: 0, y: 0.16, z: 0 }, size: { x: 0.5, y: 0.1, z: 0.22 }, material: 'metal', solid: false },
    ],
  },

  // ---- M4: Foundry's industrial vocabulary --------------------------------
  //
  // Where two solid parts stack, the upper one is sunk *into* the lower rather than resting
  // exactly on it. Two coplanar overlapping faces is a z-fighting bug (Hard Rule 4), and a
  // 0.08 m overlap puts the hidden face inside solid geometry where it can never win a
  // depth test.

  /**
   * Shipping container. 2.6 m is deliberately past `mantleMaxHeight`: a container is a wall
   * segment a lane is shaped by, not a thing to climb. The M2 penetration system will let a
   * round through one wall of it with damage left, which is what makes a stack worth
   * shooting at rather than only hiding behind.
   */
  container: {
    id: 'container',
    parts: [
      { offset: { x: 0, y: 1.3, z: 0 }, size: { x: 6.0, y: 2.6, z: 2.5 }, material: 'rust', solid: true },
      { offset: { x: 0, y: 2.62, z: 0 }, size: { x: 6.1, y: 0.08, z: 2.6 }, material: 'metal', solid: false },
      { offset: { x: 2.98, y: 1.3, z: 0 }, size: { x: 0.1, y: 2.3, z: 2.2 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 0.09, z: 0 }, size: { x: 6.1, y: 0.18, z: 2.62 }, material: 'metal', solid: false },
    ],
  },

  /**
   * Plant machinery. 1.55 m: shoot over it standing, disappear behind it crouched, and
   * mantle it if you want the height — which is the whole reason the number sits just under
   * `mantleMaxHeight` rather than just over.
   */
  machine: {
    id: 'machine',
    parts: [
      { offset: { x: 0, y: 0.775, z: 0 }, size: { x: 2.2, y: 1.55, z: 1.4 }, material: 'metal', solid: true },
      { offset: { x: 0, y: 1.58, z: 0 }, size: { x: 1.5, y: 0.1, z: 1.0 }, material: 'hazard', solid: false },
      { offset: { x: -0.7, y: 1.85, z: 0 }, size: { x: 0.24, y: 0.6, z: 0.24 }, material: 'rust', solid: false },
    ],
  },

  /** A pair of drums. Low cover, and the only 1 m object in Foundry's centre. */
  barrels: {
    id: 'barrels',
    parts: [
      { offset: { x: -0.42, y: 0.5, z: 0 }, size: { x: 0.62, y: 1.0, z: 0.62 }, material: 'hazard', solid: true },
      { offset: { x: 0.42, y: 0.5, z: 0.14 }, size: { x: 0.62, y: 1.0, z: 0.62 }, material: 'rust', solid: true },
      { offset: { x: -0.42, y: 1.02, z: 0 }, size: { x: 0.68, y: 0.06, z: 0.68 }, material: 'metal', solid: false },
      { offset: { x: 0.42, y: 1.02, z: 0.14 }, size: { x: 0.68, y: 0.06, z: 0.68 }, material: 'metal', solid: false },
    ],
  },

  /** Structural column. Tall, thin, and something for the shadow pass to fall across. */
  girder: {
    id: 'girder',
    parts: [
      { offset: { x: 0, y: 2.7, z: 0 }, size: { x: 0.42, y: 5.4, z: 0.42 }, material: 'metal', solid: true },
      { offset: { x: 0, y: 0.1, z: 0 }, size: { x: 0.9, y: 0.2, z: 0.9 }, material: 'concreteDark', solid: false },
      { offset: { x: 0, y: 3.9, z: 0 }, size: { x: 1.1, y: 0.16, z: 0.2 }, material: 'rust', solid: false },
    ],
  },

  /** The foundry's ladle on its stand. Foundry's centrepiece and its tallest hard cover. */
  ladle: {
    id: 'ladle',
    parts: [
      { offset: { x: 0, y: 0.25, z: 0 }, size: { x: 2.6, y: 0.5, z: 2.6 }, material: 'concreteDark', solid: true },
      { offset: { x: 0, y: 1.31, z: 0 }, size: { x: 2.2, y: 1.78, z: 2.2 }, material: 'rust', solid: true },
      { offset: { x: 0, y: 2.16, z: 0 }, size: { x: 2.32, y: 0.14, z: 2.32 }, material: 'hazard', solid: false },
      { offset: { x: 0, y: 1.5, z: 1.16 }, size: { x: 0.5, y: 0.5, z: 0.12 }, material: 'metal', solid: false },
    ],
  },

  /** Cable drum. 1.1 m of low cover you can also vault. */
  spool: {
    id: 'spool',
    parts: [
      { offset: { x: 0, y: 0.55, z: 0 }, size: { x: 1.3, y: 1.1, z: 1.3 }, material: 'rubber', solid: true },
      { offset: { x: 0, y: 0.55, z: 0 }, size: { x: 1.44, y: 0.22, z: 1.44 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 1.12, z: 0 }, size: { x: 1.36, y: 0.06, z: 1.36 }, material: 'metal', solid: false },
    ],
  },
};
