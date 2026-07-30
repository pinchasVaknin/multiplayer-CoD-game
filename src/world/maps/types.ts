/**
 * Map data format v1 (brief S5.5).
 *
 * Maps are data, never scene-setup code. M4 authors a real map with this schema, so
 * the shape is designed for that job now: box brushes for the shell, instanced props
 * for repeated detail, and the AI/objective fields present but unused so M4 does not
 * have to fight a migration.
 *
 * Everything is a plain JSON-compatible literal. No Three.js types leak in here.
 */

export interface Vec3Lit {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  min: Vec3Lit;
  max: Vec3Lit;
}

/**
 * Procedural material identifiers. Resolved to CanvasTextures by ProceduralTextures.
 *
 * The first seven are M1's. `brick`, `rust` and `grate` are M4's, added because Foundry
 * needs its shell, its container stacks and its catwalk decks to read as three different
 * things at a glance — and because the M2 penetration system consumes a density per
 * material, so "distinct material" and "shoots through differently" are the same
 * statement. Append only: `materialIndex` is an index into this list and `ColliderSet`
 * stores it.
 */
export const MATERIAL_KEYS = [
  'concrete',
  'concreteDark',
  'floor',
  'metal',
  'hazard',
  'accent',
  'rubber',
  'brick',
  'rust',
  'grate',
] as const;

export type MaterialKey = (typeof MATERIAL_KEYS)[number];

export function materialIndex(key: MaterialKey): number {
  return MATERIAL_KEYS.indexOf(key);
}

/**
 * A box volume.
 *
 * `rotationY` is the v1 field from the brief. `rotationX` / `rotationZ` are a v1
 * extension: a ramp is a pitched box and cannot be expressed with yaw alone. All three
 * feed the same oriented-box collider, so there is no second collision scheme.
 */
export interface Brush {
  position: Vec3Lit;
  /** Full extents, not half. */
  size: Vec3Lit;
  rotationY: number;
  rotationX?: number;
  rotationZ?: number;
  material: MaterialKey;
  /** Default true. Set false for pure decoration (light housings, trim). */
  solid?: boolean;
  /** Default true. Set false for surfaces that should not receive/cast shadows. */
  shadows?: boolean;
  /** Metres per texture repeat, overriding the material default. */
  uvScale?: number;
}

/** One box of an authored prop shape, in the prop's local space. */
export interface PropPart {
  offset: Vec3Lit;
  size: Vec3Lit;
  material: MaterialKey;
  /** Whether this part collides. Trim and rails are usually false. */
  solid: boolean;
}

export type PropShapeId =
  | 'crate'
  | 'crateTall'
  | 'pillar'
  | 'barrier'
  | 'lightBox'
  // M4, for Foundry.
  | 'container'
  | 'machine'
  | 'barrels'
  | 'girder'
  | 'ladle'
  | 'spool';

export interface PropShapeDef {
  id: PropShapeId;
  parts: readonly PropPart[];
}

/** A placement of an authored shape. Placements of the same shape are instanced. */
export interface PropDef {
  shape: PropShapeId;
  position: Vec3Lit;
  rotationY: number;
}

export type TeamId = 'A' | 'B' | 'FFA';

export interface SpawnZone {
  team: TeamId;
  position: Vec3Lit;
  /** Radians. 0 looks down -Z. */
  facingYaw: number;
  radius: number;
}

export type LightDef =
  | {
      kind: 'hemisphere';
      skyColor: number;
      groundColor: number;
      intensity: number;
    }
  | {
      kind: 'directional';
      color: number;
      intensity: number;
      /** Direction the light travels. Normalised on load. */
      direction: Vec3Lit;
      castShadow: boolean;
      /** Half-size of the shadow ortho frustum, metres. */
      shadowExtent: number;
    }
  | {
      kind: 'point';
      color: number;
      intensity: number;
      position: Vec3Lit;
      distance: number;
      decay: number;
    };

export interface AmbientDef {
  skyColor: number;
  groundColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
}

// -- stubs, unused in M1 but present so M4 does not fight the schema ---------

export interface CoverPoint {
  position: Vec3Lit;
  /** Radians; the direction the cover protects from. */
  facingYaw: number;
  height: 'low' | 'high';
}

export type ObjectiveKind = 'flag' | 'hardpoint' | 'bombsite' | 'capture';

export interface ObjectiveDef {
  id: string;
  kind: ObjectiveKind;
  position: Vec3Lit;
  radius: number;
  /** One or two characters, drawn on the minimap and the objective debug panel. */
  label: string;
}

export interface MapDef {
  id: string;
  name: string;
  brushes: Brush[];
  props: PropDef[];
  spawns: SpawnZone[];
  lights: LightDef[];
  ambient: AmbientDef;

  /** Populated from M3 (bots) onward. */
  coverPoints: CoverPoint[];
  /**
   * Populated from M4. Authored ahead of the modes that consume them: Domination arrives
   * in M7, and moving three flags after the lanes have been balanced means re-balancing
   * the lanes.
   */
  objectives: ObjectiveDef[];
  /** Bounds of playable space; also sizes the collision grid and the navmesh bake. */
  navBounds: Box;
  /**
   * The reverberant character of this space, for the single convolver's impulse response
   * (S6.6). Absent means the default room.
   */
  reverb?: ReverbDef;
}

/**
 * A room, as the audio graph hears it. Consumed by `buildImpulseResponse` at load and
 * swapped into the one `ConvolverNode` — never a second convolver (S4.5).
 */
export interface ReverbDef {
  /** Tail length, seconds. */
  seconds: number;
  /** Decay exponent. Higher is a faster, drier fall-off. */
  decay: number;
  /**
   * Brightness of the early part, 0..1. High reads as bare steel and concrete, low as a
   * furnished space.
   */
  brightness: number;
  /** Discrete early reflections: delay in seconds and amplitude, 0..1. */
  earlyTaps: readonly Readonly<{ delay: number; gain: number }>[];
}
