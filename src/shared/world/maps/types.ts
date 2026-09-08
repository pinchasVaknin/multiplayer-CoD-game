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
 *
 * The last five are M8's, and they are what stop Dunes and Depot reading as Foundry with
 * the lights changed. `sand`, `plaster` and `clayTile` are Dunes' warm vocabulary; `asphalt`
 * and `paintedSteel` are Depot's cool one. `wood` is shared — a market stall and a cargo
 * pallet are the same plank.
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
  // M8
  'sand',
  'plaster',
  'clayTile',
  'wood',
  'asphalt',
  'paintedSteel',
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
  | 'spool'
  // M8, for Dunes.
  | 'palm'
  | 'stall'
  | 'well'
  | 'sandbags'
  // M8, for Depot.
  | 'containerBlue'
  | 'pallets'
  | 'lightMast'
  | 'forklift';

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
      /**
       * M8. How far the PCF taps are spread, in texels. This is where shadow *softness*
       * comes from, and it is a property of the light the map is describing rather than a
       * global: Foundry's 2.5 is a diffuse industrial skylight, Dunes' 1.1 is midday sun,
       * and Depot's is a floodlight. Defaults to 2.5, which is what M4 shipped.
       */
      shadowRadius?: number;
      /**
       * M8. Depth bias overrides, for maps where the default produces acne or peter-panning.
       *
       * Depot is the reason these exist. A night map's shadows are cast by point lights onto
       * surfaces at grazing angles from a low key, which is exactly the case a constant bias
       * tuned on a midday map gets wrong in both directions at once.
       */
      shadowBias?: number;
      shadowNormalBias?: number;
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
  /**
   * The **hemisphere light's** upper term. This is a lighting number, not a picture of the
   * sky: it is chosen for what it does to surfaces facing up. `sky.zenith` below is the
   * other one, and they are deliberately not the same value — see the note there.
   */
  skyColor: number;
  groundColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  /** What is actually drawn overhead and past the walls (playtest round 5, F2). */
  sky: SkyDef;
}

/**
 * The sky, as a picture (playtest round 5, F2).
 *
 * The report was that `scene.background` is the fog colour and nothing else: a uniform
 * rectangle overhead and a void past the boundary walls. What makes a generated sky *good*
 * rather than merely present is one constraint, and it is why there is no horizon colour in
 * this block to author: **the horizon is `fogColor`, always.** Geometry fades into fog, fog
 * meets the sky, and the sky at the horizon is the same colour, so there is no seam anywhere
 * and there is no second number that can drift out of step with the first.
 *
 * Everything here is per map for the same reason `fogColor` is. Foundry at dusk and Dunes at
 * noon want different answers, and a constant in the renderer would be wrong for at least
 * three of the four maps.
 */
export interface SkyDef {
  /**
   * Straight up.
   *
   * Not `skyColor`, and not a multiple of `fogColor`. A hemisphere light's sky term is picked
   * for how it lights an upward-facing surface — Depot's is `0x6d7f9c`, which is a sensible
   * bounce colour for a night yard and far too bright to be a night sky.
   */
  zenith: number;
  /**
   * How quickly the gradient leaves the horizon, as an exponent on `sin(elevation)`.
   *
   * 1 is linear. Below 1 the horizon band is tight and most of the dome is zenith; above 1
   * the haze climbs high, which is what a dusty or overcast map wants.
   */
  falloff: number;
  /** The sun or the moon. Its *direction* is not here; see `SkyDiscDef`. */
  disc: SkyDiscDef;
  /**
   * Distant silhouettes past the boundary. Omitted where there is nothing to see — the
   * testbed is a room, and giving a room a horizon would be a claim about a place that is
   * not one.
   */
  skyline?: SkylineDef;
}

/**
 * The sun or moon disc.
 *
 * **There is deliberately no direction in here.** The disc is placed from the map's own
 * directional light, so the light in the scene and the light in the sky cannot disagree — a
 * map with shadows pointing one way and a sun sitting the other is the specific failure this
 * omission makes unrepresentable. A map with no directional light draws no disc.
 */
export interface SkyDiscDef {
  color: number;
  /** Angular radius of the disc itself, degrees. The real sun is 0.27; these are stylised. */
  sizeDeg: number;
  /** Angular radius of the glow around it, degrees. Zero for a hard disc. */
  glowDeg: number;
  /** 0 removes it entirely, for an overcast map. */
  intensity: number;
}

/**
 * A ridge line past the boundary, as a profile rather than as geometry.
 *
 * It is drawn into the sky at infinity rather than placed in the world, which is a decision
 * with a reason: a map is sixty metres across, so scenery near enough to show parallax is
 * near enough to fly to, and the free camera would prove it was a wall. Real hills at a
 * kilometre shift by under two degrees across a whole map. No parallax is the accurate
 * answer, not the cheap one.
 *
 * `shared/world/SkyProfile.ts` turns this into the elevation-by-azimuth curve; the client
 * uploads that curve as a one-dimensional texture and the sky shader samples it.
 */
export interface SkylineDef {
  /** Silhouette colour. Darker than `fogColor`, or it is not a silhouette. */
  color: number;
  /** Elevation of the tallest feature above the horizon, degrees. */
  heightDeg: number;
  /** Features around the full circle. */
  count: number;
  /** 0 is a smooth ridge, 1 is hard-edged blocks. Dunes want 0; a skyline wants 1. */
  hardness: number;
  /** A map's horizon must be the same on every load, so the noise is seeded and not random. */
  seed: number;
}

// -- stubs, unused in M1 but present so M4 does not fight the schema ---------

export interface CoverPoint {
  position: Vec3Lit;
  /** Radians; the direction the cover protects from. */
  facingYaw: number;
  height: 'low' | 'high';
}

/**
 * `bombspawn` is round 2, and it is a *position* rather than a zone.
 *
 * Search & Destroy used to derive where the bomb starts by averaging the attacking side's
 * spawn zones. That was wrong in two ways at once. It averaged in the deep fallback zones
 * that sit past the centre line — which drags the mean toward mid-map — and, worse, it keyed
 * off the attacking *team* rather than the attacking *end*: after the half-time swap, Team A
 * attacks while playing out of the zones labelled `'B'`, so the average put the bomb at the
 * far end of the map, in the defenders' base. That is the reported "the bomb is spawning far
 * away", and no amount of better averaging fixes it, because the fact being averaged is not
 * the fact the mode needs.
 *
 * A map knows where its attackers muster. It says so.
 */
export type ObjectiveKind = 'flag' | 'hardpoint' | 'bombsite' | 'capture' | 'bombspawn';

export interface ObjectiveDef {
  id: string;
  kind: ObjectiveKind;
  position: Vec3Lit;
  radius: number;
  /** One or two characters, drawn on the minimap and the objective debug panel. */
  label: string;
}

/**
 * Where a lane runs, so a debug harness can path it and report seconds (M8).
 *
 * M4 declared this in `foundry.ts` and `ModePanel` imported it from there, which meant the
 * lane report was hard-coded to one map id. Lifted here so every map that authors lanes
 * gets timed by the same code — the brief's "lane timings within ~15%" is a property of a
 * map, and a number the author claims rather than the harness measures is not a number.
 */
export interface LaneDef {
  readonly name: string;
  /** Where the two teams meet: the point both are timed to. */
  readonly center: Vec3Lit;
  /** Team A's home end of this lane. */
  readonly a: Vec3Lit;
  /** Team B's home end. */
  readonly b: Vec3Lit;
}

/**
 * Airborne particulate: dust on Dunes, drifting haze on Depot (M8).
 *
 * A cloud of motes in a box that follows the camera and wraps, so a few hundred points
 * cover a whole map. Absent means no atmosphere pass at all and no cost.
 */
export interface ParticulateDef {
  /** Motes in the cloud. One draw call regardless. */
  count: number;
  /** Half-size of the box around the listener the motes live in, metres. */
  radius: number;
  color: number;
  /** Point size in world metres. */
  size: number;
  opacity: number;
  /** Drift velocity, m/s. */
  drift: Vec3Lit;
}

export interface MapDef {
  id: string;
  name: string;
  brushes: Brush[];
  props: PropDef[];
  spawns: SpawnZone[];
  lights: LightDef[];
  ambient: AmbientDef;
  /** M8. Absent means no atmosphere pass. */
  particulate?: ParticulateDef;
  /** M8. Absent means the debug harness has no lanes to time on this map. */
  lanes?: readonly LaneDef[];

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
   * M8. Walkable surfaces the navmesh keeps per XZ column. Defaults to 2.
   *
   * Three on Depot, where a column can hold the yard, a container roof and the gantry over
   * both. Every extra layer costs memory and bake time on every column of the map, so it is
   * per-map rather than global — Foundry gains nothing from a third.
   */
  navLayers?: number;
  /**
   * M8. Whether the bake emits mantle links. Defaults to true.
   *
   * A climb link lets a bot haul itself onto something it cannot walk up. Set false for a
   * map whose vertical geometry is decorative, where the only thing climb links would buy
   * is bots standing on the scenery.
   */
  navClimb?: boolean;
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
