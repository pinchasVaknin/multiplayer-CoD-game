import * as THREE from 'three';
import { PLAYER_ENTITY_ID, type DamageSystem } from '../combat/DamageSystem';
import { HIT_ZONES, type HitZone } from '../combat/HitboxRig';

/**
 * Hitbox rig visualisation (brief S6.3, S7).
 *
 * Same discipline as `CollisionDebug`: one preallocated `LineSegments` rewritten in
 * place, so turning it on does not change the allocation behaviour of the frame it is
 * there to measure.
 *
 * Zones are colour-coded rather than labelled, because the question this answers while
 * you are shooting is "which box did I just hit", and a colour answers it without pulling
 * your eyes off the target.
 */

const MAX_RIGS = 12;
const MAX_BOXES_PER_RIG = 10;
const EDGES_PER_BOX = 12;
const VERTS = MAX_RIGS * MAX_BOXES_PER_RIG * EDGES_PER_BOX * 2;

/** Corner indices for the ordering `HitboxRig.writeWorldCorners` emits. */
const EDGE_PAIRS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, // along local X
  0, 2, 1, 3, 4, 6, 5, 7, // along local Y
  0, 4, 1, 5, 2, 6, 3, 7, // along local Z
];

const ZONE_COLORS: Readonly<Record<HitZone, number>> = {
  head: 0xffb340,
  torso: 0x6fd08c,
  arm: 0x8fa6c4,
  leg: 0x626a77,
};

export class HitboxDebug {
  readonly group = new THREE.Group();

  private readonly positions = new Float32Array(VERTS * 3);
  private readonly colors = new Float32Array(VERTS * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly lines: THREE.LineSegments;
  private readonly corners = new Float32Array(MAX_BOXES_PER_RIG * 8 * 3);
  private readonly color = new THREE.Color();

  /** Include the local player's rig. Off by default; see `update`. */
  showPlayer = false;

  private enabled = false;
  private drawn = 0;

  constructor(private readonly damage: DamageSystem) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 });
    this.lines = new THREE.LineSegments(this.geometry, material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.group.name = 'debug:hitboxes';
    this.group.visible = false;
    this.group.add(this.lines);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Edges currently drawn. Surfaced in the overlay so "on but empty" is visible. */
  get vertexCount(): number {
    return this.drawn;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (!on) {
      this.drawn = 0;
      this.geometry.setDrawRange(0, 0);
    }
  }

  /** Rebuild from the live rigs. Called once per rendered frame while enabled. */
  update(): void {
    if (!this.enabled) return;
    let w = 0;
    const list = this.damage.list;
    for (let i = 0; i < list.length && i < MAX_RIGS; i++) {
      const entity = list[i];
      if (entity === undefined || !entity.health.alive) continue;
      // The local player's own rig is centred on the camera, so drawing it fills the
      // screen with lines and tells you nothing. M3 can turn it on for a third-person
      // check; here it is noise.
      if (entity.entityId === PLAYER_ENTITY_ID && !this.showPlayer) continue;
      const rig = entity.rig;
      const written = rig.writeWorldCorners(this.corners);
      const boxCount = Math.min(rig.layout.boxes.length, Math.floor(written / 24));

      for (let b = 0; b < boxCount; b++) {
        const box = rig.layout.boxes[b];
        if (box === undefined) continue;
        this.color.setHex(ZONE_COLORS[box.zone]);
        const base = b * 24;
        for (let e = 0; e < EDGE_PAIRS.length; e++) {
          const corner = EDGE_PAIRS[e] ?? 0;
          const src = base + corner * 3;
          if (w + 3 > this.positions.length) break;
          this.positions[w] = this.corners[src] ?? 0;
          this.positions[w + 1] = this.corners[src + 1] ?? 0;
          this.positions[w + 2] = this.corners[src + 2] ?? 0;
          this.colors[w] = this.color.r;
          this.colors[w + 1] = this.color.g;
          this.colors[w + 2] = this.color.b;
          w += 3;
        }
      }
    }

    this.drawn = w / 3;
    this.geometry.setDrawRange(0, this.drawn);
    const position = this.geometry.getAttribute('position');
    const color = this.geometry.getAttribute('color');
    position.needsUpdate = true;
    color.needsUpdate = true;
  }

  /** Legend text for the overlay, so the colours mean something without a lookup. */
  static legend(): string {
    return HIT_ZONES.map((z) => `${z}=${ZONE_COLORS[z].toString(16).padStart(6, '0')}`).join(' ');
  }

  dispose(): void {
    this.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.group.clear();
  }
}
