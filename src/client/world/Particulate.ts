import * as THREE from 'three';
import { Rng } from '../../shared/core/Rng';
import type { ParticulateDef } from '../../shared/world/maps/types';

/**
 * Airborne particulate: Dunes' dust, Depot's cold haze (brief S6.1, S6.2).
 *
 * ## Why a map needs this at all
 *
 * Dunes has 72 m sight lines and Depot is lit by six pools in the dark. Both are cases
 * where the picture gives the player almost no cue about *distance* — a street with
 * nothing in the air is a flat backdrop, and a light pool with nothing in it is a bright
 * disc on the floor rather than a beam. Motes fix both, and they are the cheapest thing on
 * the frame that does.
 *
 * ## Why it costs nothing
 *
 * A few hundred points, one `THREE.Points`, one draw call, **one buffer upload per frame**
 * and zero allocation after construction. The cloud is a box that follows the listener and
 * **wraps**: a mote that leaves one face re-enters through the opposite one, so a 26 m box
 * of 460 points covers an 80 m map without ever needing more points than fit in the box.
 * That is the whole trick — the alternative, scattering motes over the map volume, needs
 * two orders of magnitude more of them to reach the same local density.
 *
 * Depth-write is off and the material is additive-ish (`transparent`, no depth write) so
 * motes never occlude anything or fight the depth buffer, and `sizeAttenuation` is on so a
 * mote across the yard is smaller than one at your eye — without which the cloud reads as
 * a screen-space overlay rather than as air.
 */

/**
 * Wrapping is done against the position the cloud was last *recentred* on, not the live
 * camera, and it only recentres when the camera has moved this far. Recentring every frame
 * would wrap motes continuously and make the cloud appear to be dragged along, which is
 * exactly the artefact that gives a camera-locked particle system away.
 */
const RECENTRE_DISTANCE = 4;

export class Particulate {
  readonly points: THREE.Points;

  private readonly def: ParticulateDef;
  private readonly positions: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  /** Per-mote drift jitter, so the cloud does not move as one rigid block. */
  private readonly wobble: Float32Array;

  private centreX = 0;
  private centreY = 0;
  private centreZ = 0;
  private elapsed = 0;

  constructor(def: ParticulateDef) {
    this.def = def;
    const count = Math.max(1, Math.floor(def.count));
    this.positions = new Float32Array(count * 3);
    this.wobble = new Float32Array(count * 2);

    // Seeded, so the same map always produces the same cloud. Decoration must not depend
    // on Math.random any more than geometry does.
    const rng = new Rng(0x0d05_7a11 ^ count);
    for (let i = 0; i < count; i++) {
      this.positions[i * 3] = rng.spread() * def.radius;
      // Biased low: dust hangs nearer the ground than the sky, and motes above the roofs
      // are motes nobody ever sees.
      this.positions[i * 3 + 1] = rng.float() * def.radius * 0.55;
      this.positions[i * 3 + 2] = rng.spread() * def.radius;
      this.wobble[i * 2] = rng.range(0.4, 1.8);
      this.wobble[i * 2 + 1] = rng.float() * Math.PI * 2;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), def.radius * 2);

    this.material = new THREE.PointsMaterial({
      color: def.color,
      size: def.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: def.opacity,
      depthWrite: false,
      // Unlit and untouched by tone mapping: a mote is a speck catching light, and running
      // it through ACES with everything else turns the cloud grey at exactly the exposure
      // where it is supposed to be visible.
      fog: false,
      toneMapped: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'particulate';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  /**
   * Advance the cloud and keep it around the camera.
   *
   * `dt` is a real frame delta rather than the sim's fixed step, deliberately: this is
   * decoration and drives nothing, so it belongs on the render clock with the camera shake
   * and the viewmodel sway rather than in the tick budget (S4.1's rule is about *gameplay*
   * values, and no gameplay value is computed here).
   */
  update(cameraX: number, cameraY: number, cameraZ: number, dt: number): void {
    const def = this.def;
    const pos = this.positions;
    const n = pos.length / 3;
    const r = def.radius;
    const span = r * 2;

    // Recentre in whole steps so motes stay put in world space between recentres.
    if (
      Math.abs(cameraX - this.centreX) > RECENTRE_DISTANCE ||
      Math.abs(cameraY - this.centreY) > RECENTRE_DISTANCE ||
      Math.abs(cameraZ - this.centreZ) > RECENTRE_DISTANCE
    ) {
      this.centreX = cameraX;
      this.centreY = cameraY;
      this.centreZ = cameraZ;
      this.points.position.set(cameraX, cameraY - r * 0.2, cameraZ);
    }

    this.elapsed += dt;
    const dx = def.drift.x * dt;
    const dy = def.drift.y * dt;
    const dz = def.drift.z * dt;
    const t = this.elapsed;

    for (let i = 0; i < n; i++) {
      const p = i * 3;
      const rate = this.wobble[i * 2] ?? 1;
      const phase = this.wobble[i * 2 + 1] ?? 0;
      // A slow per-mote sway across the drift, so the cloud is air rather than a conveyor.
      pos[p] = wrap((pos[p] ?? 0) + dx + Math.sin(t * rate + phase) * dt * 0.35, r, span);
      pos[p + 1] = wrapUp((pos[p + 1] ?? 0) + dy + Math.cos(t * rate * 0.7 + phase) * dt * 0.18, r);
      pos[p + 2] = wrap((pos[p + 2] ?? 0) + dz + Math.cos(t * rate + phase) * dt * 0.35, r, span);
    }

    const attribute = this.geometry.attributes['position'];
    if (attribute !== undefined) attribute.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Wrap a coordinate into `[-r, r)`. */
function wrap(v: number, r: number, span: number): number {
  if (v >= r) return v - span;
  if (v < -r) return v + span;
  return v;
}

/** Vertical wrap: the cloud sits from 0 to `r * 0.55` above its own origin. */
function wrapUp(v: number, r: number): number {
  const top = r * 0.55;
  if (v >= top) return v - top;
  if (v < 0) return v + top;
  return v;
}
