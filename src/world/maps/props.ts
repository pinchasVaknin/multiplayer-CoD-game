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
};
