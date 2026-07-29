import * as THREE from 'three';
import { movementDebug } from '../player/Movement';
import type { MovementConfig } from '../player/MovementConfig';
import type { PlayerSim } from '../player/PlayerState';
import type { CollisionWorld } from '../world/CollisionWorld';

/**
 * Collision visualisation (brief S6): the wireframe capsule, the contact normals it
 * resolved this tick, and the spatial-hash cells the broadphase touched.
 *
 * All three buffers are preallocated and rewritten in place; toggling this on must not
 * change the allocation behaviour of the frame it is measuring.
 */

const RING_SEGMENTS = 24;
const ARC_SEGMENTS = 12;
const CAPSULE_SEGMENTS = RING_SEGMENTS * 2 + 4 + ARC_SEGMENTS * 4;
const MAX_CELLS = 96;
const MAX_NORMALS = 16;

export class CollisionDebug {
  readonly group = new THREE.Group();

  private readonly capsulePositions = new Float32Array(CAPSULE_SEGMENTS * 2 * 3);
  private readonly capsuleGeo = new THREE.BufferGeometry();
  private readonly normalPositions = new Float32Array((MAX_NORMALS + 1) * 2 * 3);
  private readonly normalGeo = new THREE.BufferGeometry();
  private readonly cellPositions = new Float32Array(MAX_CELLS * 12 * 2 * 3);
  private readonly cellGeo = new THREE.BufferGeometry();

  private readonly corner = new Float32Array(3);
  private enabled = false;

  constructor(private readonly world: CollisionWorld) {
    this.group.name = 'debug:collision';
    this.group.visible = false;
    this.group.matrixAutoUpdate = false;

    this.capsuleGeo.setAttribute('position', new THREE.BufferAttribute(this.capsulePositions, 3));
    this.normalGeo.setAttribute('position', new THREE.BufferAttribute(this.normalPositions, 3));
    this.cellGeo.setAttribute('position', new THREE.BufferAttribute(this.cellPositions, 3));

    this.group.add(new THREE.LineSegments(this.capsuleGeo, lineMaterial(0x5ad1ff)));
    this.group.add(new THREE.LineSegments(this.normalGeo, lineMaterial(0xffb340)));
    this.group.add(new THREE.LineSegments(this.cellGeo, lineMaterial(0x39404b, 0.5)));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    movementDebug.capture = on;
    this.world.hash.recordQueriedCells = on;
    if (!on) this.world.hash.clearRecordedCells();
  }

  /** Called once per rendered frame while enabled. */
  update(sim: PlayerSim, cfg: MovementConfig): void {
    if (!this.enabled) return;
    this.writeCapsule(sim.x, sim.y, sim.z, cfg.capsuleRadius, sim.capsuleHeight);
    this.writeNormals(sim);
    this.writeCells();
  }

  dispose(): void {
    this.capsuleGeo.dispose();
    this.normalGeo.dispose();
    this.cellGeo.dispose();
    for (const child of this.group.children) {
      if (child instanceof THREE.LineSegments) child.material.dispose();
    }
    this.group.clear();
  }

  // -- writers -------------------------------------------------------------

  private writeCapsule(x: number, y: number, z: number, r: number, height: number): void {
    const p = this.capsulePositions;
    let o = 0;
    const yBottom = y + r;
    const yTop = y + Math.max(height - r, r);

    // Two horizontal rings, at the centres of the end spheres.
    for (let ring = 0; ring < 2; ring++) {
      const cy = ring === 0 ? yBottom : yTop;
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const a0 = (i / RING_SEGMENTS) * Math.PI * 2;
        const a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
        p[o++] = x + Math.cos(a0) * r;
        p[o++] = cy;
        p[o++] = z + Math.sin(a0) * r;
        p[o++] = x + Math.cos(a1) * r;
        p[o++] = cy;
        p[o++] = z + Math.sin(a1) * r;
      }
    }

    // Four verticals joining them.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const cx = x + Math.cos(a) * r;
      const cz = z + Math.sin(a) * r;
      p[o++] = cx;
      p[o++] = yBottom;
      p[o++] = cz;
      p[o++] = cx;
      p[o++] = yTop;
      p[o++] = cz;
    }

    // Hemisphere caps: one semicircle per vertical plane, per end.
    // `alongX` picks which plane; `sign` picks the bottom or top hemisphere.
    for (let cap = 0; cap < 4; cap++) {
      const alongX = cap % 2 === 0;
      const top = cap >= 2;
      const cy = top ? yTop : yBottom;
      const sign = top ? 1 : -1;
      for (let i = 0; i < ARC_SEGMENTS; i++) {
        const a0 = (i / ARC_SEGMENTS) * Math.PI;
        const a1 = ((i + 1) / ARC_SEGMENTS) * Math.PI;
        const h0 = Math.cos(a0) * r;
        const v0 = Math.sin(a0) * r * sign;
        const h1 = Math.cos(a1) * r;
        const v1 = Math.sin(a1) * r * sign;
        p[o++] = alongX ? x + h0 : x;
        p[o++] = cy + v0;
        p[o++] = alongX ? z : z + h0;
        p[o++] = alongX ? x + h1 : x;
        p[o++] = cy + v1;
        p[o++] = alongX ? z : z + h1;
      }
    }

    this.capsuleGeo.setDrawRange(0, o / 3);
    const attr = this.capsuleGeo.getAttribute('position');
    attr.needsUpdate = true;
  }

  private writeNormals(sim: PlayerSim): void {
    const p = this.normalPositions;
    let o = 0;
    const count = Math.min(movementDebug.count, MAX_NORMALS);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const px = movementDebug.points[i3] ?? 0;
      const py = movementDebug.points[i3 + 1] ?? 0;
      const pz = movementDebug.points[i3 + 2] ?? 0;
      p[o++] = px;
      p[o++] = py;
      p[o++] = pz;
      p[o++] = px + (movementDebug.normals[i3] ?? 0) * 0.5;
      p[o++] = py + (movementDebug.normals[i3 + 1] ?? 0) * 0.5;
      p[o++] = pz + (movementDebug.normals[i3 + 2] ?? 0) * 0.5;
    }
    // The resolved ground normal, drawn from the feet.
    if (sim.grounded) {
      p[o++] = sim.x;
      p[o++] = sim.y;
      p[o++] = sim.z;
      p[o++] = sim.x + sim.groundNx * 0.8;
      p[o++] = sim.y + sim.groundNy * 0.8;
      p[o++] = sim.z + sim.groundNz * 0.8;
    }
    this.normalGeo.setDrawRange(0, o / 3);
    this.normalGeo.getAttribute('position').needsUpdate = true;
  }

  private writeCells(): void {
    const hash = this.world.hash;
    const cs = hash.cellSize;
    const p = this.cellPositions;
    let o = 0;
    const count = Math.min(hash.queriedCellCount, MAX_CELLS);
    for (let i = 0; i < count; i++) {
      const cell = hash.queriedCells[i] ?? 0;
      hash.cellMinCorner(cell, this.corner);
      const x0 = this.corner[0] ?? 0;
      const y0 = this.corner[1] ?? 0;
      const z0 = this.corner[2] ?? 0;
      const x1 = x0 + cs;
      const y1 = y0 + cs;
      const z1 = z0 + cs;
      o = pushBoxEdges(p, o, x0, y0, z0, x1, y1, z1);
    }
    this.cellGeo.setDrawRange(0, o / 3);
    this.cellGeo.getAttribute('position').needsUpdate = true;
  }
}

function lineMaterial(color: number, opacity = 1): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    fog: false,
  });
}

function pushBoxEdges(
  p: Float32Array,
  offset: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  const v: ReadonlyArray<readonly [number, number, number]> = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const edges: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  let o = offset;
  for (const [a, b] of edges) {
    const va = v[a];
    const vb = v[b];
    if (va === undefined || vb === undefined) continue;
    p[o++] = va[0];
    p[o++] = va[1];
    p[o++] = va[2];
    p[o++] = vb[0];
    p[o++] = vb[1];
    p[o++] = vb[2];
  }
  return o;
}
