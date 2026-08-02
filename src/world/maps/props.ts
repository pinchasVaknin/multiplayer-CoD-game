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

  // ---- M8: Dunes ----------------------------------------------------------

  /**
   * Date palm. A 0.42 m trunk and a crown five metres up.
   *
   * The crown is **not solid**, and that is the point rather than a shortcut: on a map
   * whose identity is a 70 m sniper lane, something has to break a silhouette without
   * breaking the sight line, or the lane stops being a lane and becomes a corridor of
   * hard cover. A palm makes you harder to *see* down the street and does nothing at all
   * to stop a bullet — which is exactly the trade a long lane needs to stay dangerous.
   */
  palm: {
    id: 'palm',
    parts: [
      { offset: { x: 0, y: 2.6, z: 0 }, size: { x: 0.42, y: 5.2, z: 0.42 }, material: 'wood', solid: true },
      { offset: { x: 0, y: 0.12, z: 0 }, size: { x: 0.9, y: 0.24, z: 0.9 }, material: 'sand', solid: false },
      // Crown: four fronds crossed, sitting above head height and above mantle height.
      { offset: { x: 0, y: 5.3, z: 0 }, size: { x: 4.4, y: 0.12, z: 0.9 }, material: 'clayTile', solid: false },
      { offset: { x: 0, y: 5.45, z: 0 }, size: { x: 0.9, y: 0.12, z: 4.4 }, material: 'clayTile', solid: false },
      { offset: { x: 0, y: 5.6, z: 0 }, size: { x: 3.2, y: 0.12, z: 3.2 }, material: 'clayTile', solid: false },
    ],
  },

  /**
   * Market stall: a counter you can shoot over and an awning you cannot see through.
   *
   * The counter is 1.15 m — low cover you crouch behind and vault over. The awning is at
   * 2.5 m and non-solid, so it cuts the view from a rooftop or a raised terrace without
   * ever being something the capsule can catch on.
   */
  stall: {
    id: 'stall',
    parts: [
      { offset: { x: 0, y: 0.575, z: 0 }, size: { x: 2.6, y: 1.15, z: 0.9 }, material: 'wood', solid: true },
      { offset: { x: 0, y: 1.19, z: 0 }, size: { x: 2.76, y: 0.08, z: 1.04 }, material: 'clayTile', solid: false },
      { offset: { x: -1.2, y: 1.25, z: 0.36 }, size: { x: 0.12, y: 2.5, z: 0.12 }, material: 'wood', solid: false },
      { offset: { x: 1.2, y: 1.25, z: 0.36 }, size: { x: 0.12, y: 2.5, z: 0.12 }, material: 'wood', solid: false },
      { offset: { x: 0, y: 2.52, z: 0.1 }, size: { x: 3.0, y: 0.1, z: 1.9 }, material: 'accent', solid: false },
    ],
  },

  /**
   * Village well. Hard cover in the middle of the plaza and the map's only round-reading
   * object — approximated, like everything else, by boxes, because the collision scheme is
   * capsule versus oriented box and a silhouette that disagrees with the collider is worse
   * than a blocky one.
   */
  well: {
    id: 'well',
    parts: [
      { offset: { x: 0, y: 0.5, z: 0 }, size: { x: 2.2, y: 1.0, z: 2.2 }, material: 'concrete', solid: true },
      { offset: { x: 0, y: 0.5, z: 0 }, size: { x: 2.6, y: 0.9, z: 1.6 }, material: 'concrete', solid: true },
      { offset: { x: 0, y: 0.5, z: 0 }, size: { x: 1.6, y: 0.9, z: 2.6 }, material: 'concrete', solid: true },
      { offset: { x: 0, y: 1.03, z: 0 }, size: { x: 2.4, y: 0.1, z: 2.4 }, material: 'plaster', solid: false },
      { offset: { x: -0.9, y: 1.8, z: 0 }, size: { x: 0.16, y: 1.6, z: 0.16 }, material: 'wood', solid: false },
      { offset: { x: 0.9, y: 1.8, z: 0 }, size: { x: 0.16, y: 1.6, z: 0.16 }, material: 'wood', solid: false },
      { offset: { x: 0, y: 2.6, z: 0 }, size: { x: 2.2, y: 0.5, z: 1.4 }, material: 'clayTile', solid: false },
    ],
  },

  /**
   * Sandbag revetment. 1.05 m of low cover, deliberately just under `mantleMaxHeight` so
   * it is both something to shoot over and something to get out of in a hurry.
   */
  sandbags: {
    id: 'sandbags',
    parts: [
      { offset: { x: 0, y: 0.35, z: 0 }, size: { x: 2.4, y: 0.7, z: 0.8 }, material: 'sand', solid: true },
      { offset: { x: 0, y: 0.87, z: 0 }, size: { x: 2.0, y: 0.36, z: 0.7 }, material: 'sand', solid: true },
      { offset: { x: 0, y: 1.06, z: 0 }, size: { x: 2.06, y: 0.06, z: 0.76 }, material: 'wood', solid: false },
    ],
  },

  // ---- M8: Depot ----------------------------------------------------------

  /**
   * Painted shipping container. The same 6.0 x 2.6 x 2.5 box as Foundry's, because that is
   * what a shipping container is, in `paintedSteel` rather than `rust`.
   *
   * The difference that matters is not the colour: at 1.62 penetration density against
   * `rust`'s 1.35, a Depot container is meaningfully harder to shoot through than a Foundry
   * one. On a map whose entire cover vocabulary is containers, a stack has to be worth
   * *climbing* rather than worth shooting through, and that number is what decides it.
   *
   * The corner castings are 0.15 m proud of the ends — they are what a stacked container
   * visibly rests on, and they stop a two-high stack reading as one 5 m slab.
   */
  containerBlue: {
    id: 'containerBlue',
    parts: [
      { offset: { x: 0, y: 1.3, z: 0 }, size: { x: 6.0, y: 2.6, z: 2.5 }, material: 'paintedSteel', solid: true },
      { offset: { x: 0, y: 2.62, z: 0 }, size: { x: 6.1, y: 0.08, z: 2.6 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 0.09, z: 0 }, size: { x: 6.1, y: 0.18, z: 2.62 }, material: 'metal', solid: false },
      { offset: { x: -2.9, y: 1.3, z: 0 }, size: { x: 0.14, y: 2.2, z: 2.16 }, material: 'metal', solid: false },
      { offset: { x: 2.9, y: 1.3, z: 0 }, size: { x: 0.14, y: 2.2, z: 2.16 }, material: 'metal', solid: false },
    ],
  },

  /**
   * Pallet stack. 0.9 m — under step-up plus a mantle, so it is the **first rung** of
   * Depot's climbing vocabulary: pallets to a container roof, container roof to a stack.
   * Every height on that map is chosen against `mantleMaxHeight` (1.6 m) rather than
   * against taste.
   */
  pallets: {
    id: 'pallets',
    parts: [
      { offset: { x: 0, y: 0.45, z: 0 }, size: { x: 1.6, y: 0.9, z: 1.3 }, material: 'wood', solid: true },
      { offset: { x: 0, y: 0.92, z: 0 }, size: { x: 1.68, y: 0.06, z: 1.38 }, material: 'wood', solid: false },
      { offset: { x: 0, y: 0.3, z: 0 }, size: { x: 1.66, y: 0.05, z: 1.36 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 0.62, z: 0 }, size: { x: 1.66, y: 0.05, z: 1.36 }, material: 'metal', solid: false },
    ],
  },

  /**
   * Yard light mast: an 8 m pole with a lamp head. Non-solid above the base so it never
   * snags, and it is what a `point` light in the map def is *hung on* — a pooled light
   * with no visible source reads as a bug at night.
   */
  lightMast: {
    id: 'lightMast',
    parts: [
      { offset: { x: 0, y: 0.9, z: 0 }, size: { x: 0.34, y: 1.8, z: 0.34 }, material: 'metal', solid: true },
      { offset: { x: 0, y: 0.12, z: 0 }, size: { x: 0.8, y: 0.24, z: 0.8 }, material: 'concreteDark', solid: false },
      { offset: { x: 0, y: 5.0, z: 0 }, size: { x: 0.26, y: 6.4, z: 0.26 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 8.1, z: 0.3 }, size: { x: 0.9, y: 0.28, z: 1.0 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 7.94, z: 0.3 }, size: { x: 0.8, y: 0.06, z: 0.9 }, material: 'accent', solid: false },
    ],
  },

  /**
   * Forklift. 1.45 m of hard cover with a mast that reads at a distance, so the yard has
   * something that is recognisably machinery rather than another box.
   */
  forklift: {
    id: 'forklift',
    parts: [
      { offset: { x: 0, y: 0.725, z: 0 }, size: { x: 1.5, y: 1.45, z: 2.4 }, material: 'hazard', solid: true },
      { offset: { x: 0, y: 1.5, z: -0.2 }, size: { x: 1.3, y: 0.12, z: 1.4 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 2.3, z: 1.1 }, size: { x: 1.2, y: 3.0, z: 0.18 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 0.2, z: 1.5 }, size: { x: 1.0, y: 0.12, z: 1.0 }, material: 'metal', solid: false },
      { offset: { x: 0, y: 1.9, z: -0.6 }, size: { x: 1.4, y: 0.1, z: 1.4 }, material: 'metal', solid: false },
    ],
  },
};
