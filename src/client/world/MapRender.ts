import * as THREE from 'three';
import type { ProceduralTextures } from '../engine/ProceduralTextures';
import { rememberShadowAuthoring, SHADOW_TIERS } from '../engine/Renderer';
import type { ShadowQuality } from '../../shared/meta/SaveData';
import { writeBasis } from '../../shared/world/ColliderSet';
import type { CollisionWorld } from '../../shared/world/CollisionWorld';
import {
  loadMapCollision,
  type CollisionStats,
  type LoadedCollision,
} from '../../shared/world/MapLoader';
import { PROP_SHAPES } from '../../shared/world/maps/props';
import type { Box, MapDef, MaterialKey, SpawnZone } from '../../shared/world/maps/types';
import { buildBoxGeometry, type BoxSpec } from './MapMesher';

/**
 * The render half of the map loader (M9 split — see `shared/world/MapLoader.ts`).
 *
 * Merged brush geometry, instanced props, materials, lights and fog. Everything here
 * draws; nothing here decides anything the simulation depends on.
 *
 * The AO pass reads the `CollisionWorld` the shared loader already built rather than
 * building a second one, which is also why `loadMap` composes the two halves in this
 * order: collision first, then geometry that is lit against it.
 *
 * Nothing else in the codebase is allowed to place a mesh in the world by hand.
 */

export interface LoadedMap {
  readonly def: MapDef;
  readonly root: THREE.Group;
  readonly collision: CollisionWorld;
  readonly spawns: readonly SpawnZone[];
  readonly navBounds: Box;
  readonly stats: MapStats;
  dispose(): void;
}

export interface MapStats extends CollisionStats {
  drawCalls: number;
  triangles: number;
  buildMs: number;
  aoMs: number;
  /** How many chunks the build was split into (M11, §6.5). Reported by the build probe. */
  chunks: number;
}

/**
 * Shape-parts this map will mesh, counted before any are built.
 *
 * Only so the chunk total is known up front and progress is a real fraction. Counted rather
 * than estimated because the alternative is a progress bar that jumps backwards.
 */
function countPropParts(def: MapDef): number {
  const shapes = new Set(def.props.map((p) => p.shape));
  let parts = 0;
  for (const shape of shapes) parts += PROP_SHAPES[shape].parts.length;
  return parts;
}

/** Tessellation target for brush faces, metres. Smaller = better AO, more vertices. */
const BRUSH_FACE_SPACING = 1.6;
const PROP_FACE_SPACING = 0.6;

/**
 * Build a map's meshes, all at once.
 *
 * The single-player path and every existing caller. It drains the generator below without
 * yielding, so it behaves exactly as it did before M11 — one synchronous call, one frame,
 * done. HARD RULE 8 keeps that true: nothing about the solo build changed.
 */
export function loadMap(
  def: MapDef,
  textures: ProceduralTextures,
  shadowQuality: ShadowQuality = 'medium',
): LoadedMap {
  const steps = buildMapChunked(def, textures, shadowQuality);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  return step.value;
}

/** Progress out of the chunked build, for a caller that wants to show or measure it. */
export interface MapBuildProgress {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

/**
 * The same build, as a generator that can be stopped between chunks (M11, §6.5).
 *
 * §6.5: *"The build must be **chunked so it does not stall the frame**. A single synchronous
 * build call will freeze the arena, which is precisely the experience this design exists to
 * avoid."*
 *
 * ## Where the chunk boundaries are, and why there
 *
 * The cost is dominated by the ambient-occlusion bake inside `buildBoxGeometry`, which ray-
 * marches a hemisphere per vertex against the collision world. Yielding inside that loop would
 * mean threading a continuation through the mesher; yielding **per material group** does not,
 * because the mesher already merges brushes by material and produces one geometry per group.
 * So the natural seam was already there — the build is split the way its output is.
 *
 * Props are one chunk per shape-part, which is finer still, and lights are one chunk because
 * they are a handful of object constructions.
 *
 * A generator rather than a callback chain or a promise per chunk: the caller decides how much
 * to do per frame, the whole thing is cancellable by simply not calling `next` again, and
 * every local stays on the stack instead of becoming a field on a state machine object.
 */
export function* buildMapChunked(
  def: MapDef,
  textures: ProceduralTextures,
  shadowQuality: ShadowQuality = 'medium',
): Generator<MapBuildProgress, LoadedMap> {
  const t0 = performance.now();
  const root = new THREE.Group();
  root.name = `map:${def.id}`;

  // ---- 1. collision, from the shared loader -------------------------------
  const loaded: LoadedCollision = loadMapCollision(def);
  const collision = loaded.collision;

  // ---- 2. brush meshes, one chunk per material ----------------------------
  //
  // Grouped before meshing rather than after, so each `buildBoxGeometry` call is one chunk
  // producing one geometry. The alternative — one call over every brush — is a single
  // uninterruptible unit of work and is exactly the frame stall §6.5 forbids.
  const byMaterial = new Map<MaterialKey, BoxSpec[]>();
  const basisScratch = new Float32Array(9);
  for (const brush of def.brushes) {
    const basis = new Float32Array(9);
    writeBasis(brush.rotationY, brush.rotationX ?? 0, brush.rotationZ ?? 0, basisScratch);
    basis.set(basisScratch);
    const spec: BoxSpec = {
      cx: brush.position.x,
      cy: brush.position.y,
      cz: brush.position.z,
      hx: brush.size.x * 0.5,
      hy: brush.size.y * 0.5,
      hz: brush.size.z * 0.5,
      basis,
      material: brush.material,
      uvScale: brush.uvScale ?? textures.get(brush.material).worldScale,
    };
    const list = byMaterial.get(brush.material);
    if (list === undefined) byMaterial.set(brush.material, [spec]);
    else list.push(spec);
  }

  // Chunk count is known up front, so a progress bar is a real fraction rather than a guess.
  const propParts = countPropParts(def);
  const total = byMaterial.size + propParts + 1;
  let done = 0;

  const disposables: Array<{ dispose(): void }> = [];
  let drawCalls = 0;
  let triangles = 0;
  let aoMs = 0;
  let completed = false;

  /**
   * A cancelled build must not leak its GPU memory.
   *
   * Calling `.return()` on a suspended generator runs this `finally`, which is the only hook
   * there is for cleaning up work a half-finished build has already done. Without it, a build
   * abandoned mid-flight — a player disconnecting, an allocation failing after the `Prepare`
   * went out — drops its geometries and materials on the floor, and those live on the GPU for
   * the life of the page rather than being collected.
   *
   * Guarded on `completed` so the normal path does not dispose the map it just built.
   */
  try {
      for (const [material, specs] of byMaterial) {
      const aoStart = performance.now();
      const built = buildBoxGeometry(specs, collision, BRUSH_FACE_SPACING);
      aoMs += performance.now() - aoStart;

      for (const [key, geometry] of built) {
        const mesh = new THREE.Mesh(geometry, makeMaterial(textures, key));
        mesh.name = `brushes:${key}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        root.add(mesh);
        disposables.push(geometry);
        disposables.push(mesh.material as THREE.Material);
        drawCalls++;
        triangles += (geometry.getIndex()?.count ?? 0) / 3;
      }

      done++;
      yield { done, total, label: `brushes:${material}` };
    }

    // ---- 3. props, instanced ------------------------------------------------
    const byShape = new Map<string, typeof def.props>();
    for (const p of def.props) {
      const list = byShape.get(p.shape);
      if (list === undefined) byShape.set(p.shape, [p]);
      else list.push(p);
    }

    const instanceMatrix = new THREE.Matrix4();
    const instanceQuat = new THREE.Quaternion();
    const instancePos = new THREE.Vector3();
    const instanceScale = new THREE.Vector3(1, 1, 1);
    const yAxis = new THREE.Vector3(0, 1, 0);

    for (const [shapeId, placements] of byShape) {
      const shape = PROP_SHAPES[shapeId as keyof typeof PROP_SHAPES];
      for (let partIndex = 0; partIndex < shape.parts.length; partIndex++) {
        const part = shape.parts[partIndex];
        if (part === undefined) continue;
        const identity = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const geometries = buildBoxGeometry(
          [
            {
              cx: part.offset.x,
              cy: part.offset.y,
              cz: part.offset.z,
              hx: part.size.x * 0.5,
              hy: part.size.y * 0.5,
              hz: part.size.z * 0.5,
              basis: identity,
              material: part.material,
              uvScale: textures.get(part.material).worldScale,
            },
          ],
          null,
          PROP_FACE_SPACING,
        );
        const geometry = geometries.get(part.material);
        if (geometry === undefined) continue;

        const mesh = new THREE.InstancedMesh(geometry, makeMaterial(textures, part.material), placements.length);
        mesh.name = `prop:${shapeId}:${partIndex}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let i = 0; i < placements.length; i++) {
          const p = placements[i];
          if (p === undefined) continue;
          instancePos.set(p.position.x, p.position.y, p.position.z);
          instanceQuat.setFromAxisAngle(yAxis, p.rotationY);
          instanceMatrix.compose(instancePos, instanceQuat, instanceScale);
          mesh.setMatrixAt(i, instanceMatrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        root.add(mesh);
        disposables.push(geometry);
        disposables.push(mesh.material as THREE.Material);
        drawCalls++;
        triangles += ((geometry.getIndex()?.count ?? 0) / 3) * placements.length;

        done++;
        yield { done, total, label: `prop:${shapeId}:${partIndex}` };
      }
    }

    // ---- 4. lights ----------------------------------------------------------
    for (const light of def.lights) {
      switch (light.kind) {
        case 'hemisphere': {
          const l = new THREE.HemisphereLight(light.skyColor, light.groundColor, light.intensity);
          root.add(l);
          break;
        }
        case 'directional': {
          const l = new THREE.DirectionalLight(light.color, light.intensity);
          const dir = new THREE.Vector3(light.direction.x, light.direction.y, light.direction.z).normalize();
          const center = new THREE.Vector3(
            (def.navBounds.min.x + def.navBounds.max.x) * 0.5,
            (def.navBounds.min.y + def.navBounds.max.y) * 0.5,
            (def.navBounds.min.z + def.navBounds.max.z) * 0.5,
          );
          l.position.copy(center).addScaledVector(dir, -60);
          l.target.position.copy(center);
          root.add(l.target);
          l.castShadow = light.castShadow;
          if (light.castShadow) {
            const e = light.shadowExtent;
            // M8: the tier the player chose, not a constant. `SHADOW_TIERS` scales the map's
            // own softness rather than replacing it, so Dunes stays harder than Foundry at
            // every quality level.
            const tier = SHADOW_TIERS[shadowQuality];
            const size = tier.size === 0 ? 1024 : tier.size;
            l.castShadow = tier.size > 0;
            l.shadow.mapSize.set(size, size);
            l.shadow.camera.left = -e;
            l.shadow.camera.right = e;
            l.shadow.camera.top = e;
            l.shadow.camera.bottom = -e;
            l.shadow.camera.near = 1;
            l.shadow.camera.far = 160;
            // Constant bias handles the depth quantisation; normalBias handles the
            // grazing-angle acne that a pure constant bias would need to be huge for.
            // Both are per-map overridable from M8: Depot's night key is weak enough that
            // the acne Foundry never shows is the brightest thing in the frame.
            l.shadow.bias = light.shadowBias ?? -0.0004;
            // Round 3: scaled by the tier, because the distance this has to cover is one
            // shadow texel and a texel is a function of the map size. See `SHADOW_TIERS`.
            const authoredNormalBias = light.shadowNormalBias ?? 0.035;
            l.shadow.normalBias = authoredNormalBias * tier.biasScale;
            // PCF taps are spread by this radius; it is where shadow softness comes from
            // now that PCFSoftShadowMap is gone. Midday sun wants a much smaller number
            // than an industrial skylight does.
            const authoredRadius = light.shadowRadius ?? 2.5;
            l.shadow.radius = authoredRadius * (tier.radiusScale === 0 ? 1 : tier.radiusScale);
            // Remember what the map asked for, so a later quality change scales the intent
            // rather than compounding on the previous scaling.
            rememberShadowAuthoring(l.shadow, authoredRadius, light.castShadow, authoredNormalBias);
            l.shadow.camera.updateProjectionMatrix();
          }
          root.add(l);
          break;
        }
        case 'point': {
          const l = new THREE.PointLight(light.color, light.intensity, light.distance, light.decay);
          l.position.set(light.position.x, light.position.y, light.position.z);
          root.add(l);
          break;
        }
      }
    }

    done++;
    yield { done, total, label: 'lights' };

    const stats: MapStats = {
      ...loaded.stats,
      drawCalls,
      triangles: Math.round(triangles),
      buildMs: performance.now() - t0,
      aoMs,
      chunks: total,
    };

    // The build succeeded; the `finally` below must not dispose what we are handing back.
    completed = true;
    return {
      def,
      root,
      collision,
      spawns: loaded.spawns,
      navBounds: loaded.navBounds,
      stats,
      dispose(): void {
        for (const d of disposables) d.dispose();
        root.clear();
      },
    };
  } finally {
    if (!completed) {
      for (const d of disposables) d.dispose();
      root.clear();
    }
  }
}

/**
 * Materials the maps use for *decorative overlays* rather than for structure (post-M8).
 *
 * Trim lips, floor stripes, lane markers, hazard chevrons and ledge edges are all authored
 * as thin brushes laid a centimetre or two proud of the surface they mark. Every map does
 * this and every map states the rule in its own header — "no two coplanar faces" — but a
 * rule enforced by hand across four maps and several hundred brushes is a rule that will be
 * broken, and it had been: the range's bullseye plates were spaced exactly their own
 * thickness apart, so consecutive faces were *precisely* coincident. Coincident faces are
 * the textbook depth-fight, and a depth-fight at close range is the violent per-frame
 * flicker reported post-M8 as models that "jitter and shake as you approach them".
 *
 * The authoring bug is fixed where it was (see `maps/greybox.ts`). This is the guard that
 * stops the next one shipping: a decorative surface is pulled toward the viewer in depth by
 * a fixed offset, so it wins against whatever it is decorating no matter how flush the
 * author left it. It costs nothing — `polygonOffset` is fixed-function — and it is applied
 * by *material* rather than per brush because the brush geometry is merged per material
 * before it ever becomes a mesh.
 */
const TRIM_MATERIALS: ReadonlySet<MaterialKey> = new Set<MaterialKey>(['accent', 'hazard']);

function makeMaterial(textures: ProceduralTextures, key: MaterialKey): THREE.Material {
  const profile = textures.get(key);
  const trim = TRIM_MATERIALS.has(key);
  return new THREE.MeshLambertMaterial({
    map: profile.texture,
    vertexColors: true,
    // Lambert keeps the frame budget honest on integrated graphics; the surface
    // interest comes from the procedural maps and the baked AO, not from a BRDF.
    dithering: true,
    // Negative offset pulls the fragment toward the camera in depth without moving the
    // geometry, so nothing about collision, AO or the navmesh changes.
    polygonOffset: trim,
    polygonOffsetFactor: trim ? -2 : 0,
    polygonOffsetUnits: trim ? -2 : 0,
  });
}

/** Apply a map's ambient block to the scene. Kept here so maps own their look. */
export function applyAmbient(scene: THREE.Scene, def: MapDef): void {
  scene.background = new THREE.Color(def.ambient.fogColor);
  scene.fog = new THREE.Fog(def.ambient.fogColor, def.ambient.fogNear, def.ambient.fogFar);
}
