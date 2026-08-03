import * as THREE from 'three';
import type { ProceduralTextures } from '../engine/ProceduralTextures';
import { rememberShadowAuthoring, SHADOW_TIERS } from '../engine/Renderer';
import type { ShadowQuality } from '../meta/SaveData';
import { ColliderSet, writeBasis } from './ColliderSet';
import { CollisionWorld } from './CollisionWorld';
import { buildBoxGeometry, type BoxSpec } from './MapMesher';
import { PROP_SHAPES } from './maps/props';
import type { Box, MapDef, MaterialKey, SpawnZone } from './maps/types';

/**
 * Consumes a MapDef and produces the three things the game needs from a map:
 * render meshes (merged by material, props instanced), the static spatial hash
 * wrapped in a CollisionWorld, and the nav bounds.
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

export interface MapStats {
  brushes: number;
  props: number;
  colliders: number;
  drawCalls: number;
  triangles: number;
  hashCells: number;
  hashEntries: number;
  buildMs: number;
  aoMs: number;
}

/** Tessellation target for brush faces, metres. Smaller = better AO, more vertices. */
const BRUSH_FACE_SPACING = 1.6;
const PROP_FACE_SPACING = 0.6;

export function loadMap(
  def: MapDef,
  textures: ProceduralTextures,
  shadowQuality: ShadowQuality = 'medium',
): LoadedMap {
  const t0 = performance.now();
  const root = new THREE.Group();
  root.name = `map:${def.id}`;

  // ---- 1. colliders -------------------------------------------------------
  const solidBrushes = def.brushes.filter((b) => b.solid !== false).length;
  let solidPropParts = 0;
  for (const p of def.props) {
    const shape = PROP_SHAPES[p.shape];
    for (const part of shape.parts) if (part.solid) solidPropParts++;
  }

  const colliders = new ColliderSet(solidBrushes + solidPropParts + 8);

  for (const brush of def.brushes) {
    if (brush.solid === false) continue;
    colliders.add(
      brush.position,
      brush.size,
      brush.rotationY,
      brush.rotationX ?? 0,
      brush.rotationZ ?? 0,
      brush.material,
    );
  }

  const worldOffset = { x: 0, y: 0, z: 0 };
  for (const placement of def.props) {
    const shape = PROP_SHAPES[placement.shape];
    const c = Math.cos(placement.rotationY);
    const s = Math.sin(placement.rotationY);
    for (const part of shape.parts) {
      if (!part.solid) continue;
      worldOffset.x = placement.position.x + part.offset.x * c + part.offset.z * s;
      worldOffset.y = placement.position.y + part.offset.y;
      worldOffset.z = placement.position.z - part.offset.x * s + part.offset.z * c;
      colliders.add(worldOffset, part.size, placement.rotationY, 0, 0, part.material);
    }
  }

  const collision = new CollisionWorld(colliders, def.navBounds, 4);

  // ---- 2. brush meshes ----------------------------------------------------
  const brushSpecs: BoxSpec[] = [];
  const basisScratch = new Float32Array(9);
  for (const brush of def.brushes) {
    const basis = new Float32Array(9);
    writeBasis(brush.rotationY, brush.rotationX ?? 0, brush.rotationZ ?? 0, basisScratch);
    basis.set(basisScratch);
    brushSpecs.push({
      cx: brush.position.x,
      cy: brush.position.y,
      cz: brush.position.z,
      hx: brush.size.x * 0.5,
      hy: brush.size.y * 0.5,
      hz: brush.size.z * 0.5,
      basis,
      material: brush.material,
      uvScale: brush.uvScale ?? textures.get(brush.material).worldScale,
    });
  }

  const aoStart = performance.now();
  const brushGeometries = buildBoxGeometry(brushSpecs, collision, BRUSH_FACE_SPACING);
  const aoMs = performance.now() - aoStart;

  const disposables: Array<{ dispose(): void }> = [];
  let drawCalls = 0;
  let triangles = 0;

  for (const [material, geometry] of brushGeometries) {
    const mesh = new THREE.Mesh(geometry, makeMaterial(textures, material));
    mesh.name = `brushes:${material}`;
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

  const [dx, dy, dz] = collision.hash.dimensions;
  const stats: MapStats = {
    brushes: def.brushes.length,
    props: def.props.length,
    colliders: colliders.count,
    drawCalls,
    triangles: Math.round(triangles),
    hashCells: dx * dy * dz,
    hashEntries: collision.hash.itemCount,
    buildMs: performance.now() - t0,
    aoMs,
  };

  return {
    def,
    root,
    collision,
    spawns: def.spawns,
    navBounds: def.navBounds,
    stats,
    dispose(): void {
      for (const d of disposables) d.dispose();
      root.clear();
    },
  };
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
