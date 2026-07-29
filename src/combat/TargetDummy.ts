import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DT } from '../core/Loop';
import { clamp01, smoothstep } from '../core/MathUtil';
import { Health, type HealthConfig } from '../player/Health';
import type { Damageable } from './DamageSystem';
import { HitboxRig, HUMANOID_RIG, type HitZone } from './HitboxRig';

/**
 * Range dummies (brief S6.8): a static target, one that pops up on a timer, and one that
 * strafes a fixed path.
 *
 * Each one carries the **real** hitbox rig — the same `HUMANOID_RIG` M3's bots will
 * attach — and its mesh is built directly from the rig boxes. That is deliberate: on a
 * grey-box target, what you see should be exactly what you can hit, because the whole
 * point of shooting these is to verify the multipliers against printed damage.
 *
 * The printed read-out lives on a `CanvasTexture` above the target rather than in the
 * console, so it is legible while you are still holding the trigger.
 */

export type DummyBehaviour = 'static' | 'popup' | 'strafe';

export interface DummySpec {
  readonly id: number;
  readonly name: string;
  readonly behaviour: DummyBehaviour;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Strafe half-travel along the local X axis, metres. */
  readonly travel?: number;
  readonly speed?: number;
  /** Pop-up cycle, seconds: time up, then time down. */
  readonly upTime?: number;
  readonly downTime?: number;
}

/** Seconds a downed dummy stays down before it resets. */
const RESPAWN_SECONDS = 2.5;
/** How far a popup target sinks, metres. Below the rig height, so it fully hides. */
const POPUP_DEPTH = 2.0;
const POPUP_TRANSITION = 0.32;

const LABEL_W = 256;
const LABEL_H = 96;

export class TargetDummy implements Damageable {
  readonly entityId: number;
  readonly displayName: string;
  readonly health: Health;
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly group = new THREE.Group();

  /** Total damage taken since the last reset, for the printed read-out. */
  totalDamage = 0;
  lastDamage = 0;
  lastZone: HitZone = 'torso';
  lastDistance = 0;

  private readonly spec: DummySpec;
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly label: THREE.Mesh;
  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelCtx: CanvasRenderingContext2D;
  private readonly labelTexture: THREE.CanvasTexture;
  private readonly disposables: Array<{ dispose(): void }> = [];

  private phase = 0;
  private respawnTimer = 0;
  private strafeDir = 1;
  private strafeOffset = 0;
  private labelDirty = true;
  /**
   * Health as it is currently printed. Regeneration changes `health.current` every tick;
   * repainting a canvas and re-uploading a texture sixty times a second to move a number
   * that has not visibly changed is exactly the kind of cost that hides in a soak test.
   */
  private shownHealth = -1;
  private shownAlive = true;

  /** Interpolation snapshots: dummies move in the sim and render between ticks. */
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private currX = 0;
  private currY = 0;
  private currZ = 0;

  constructor(spec: DummySpec, healthConfig: HealthConfig, materials: DummyMaterials) {
    this.spec = spec;
    this.entityId = spec.id;
    this.displayName = spec.name;
    this.health = new Health(healthConfig);

    this.body = new THREE.Mesh(buildZoneGeometry(['torso', 'arm', 'leg']), materials.body);
    this.head = new THREE.Mesh(buildZoneGeometry(['head']), materials.head);
    this.body.castShadow = true;
    this.head.castShadow = true;
    this.disposables.push(this.body.geometry, this.head.geometry);

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = LABEL_W;
    this.labelCanvas.height = LABEL_H;
    const ctx = this.labelCanvas.getContext('2d');
    if (ctx === null) throw new Error('2D canvas context unavailable; cannot build target read-outs.');
    this.labelCtx = ctx;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: this.labelTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(this.labelTexture, labelMaterial);
    const labelGeometry = new THREE.PlaneGeometry(0.9, 0.34);
    this.disposables.push(labelGeometry);
    this.label = new THREE.Mesh(labelGeometry, labelMaterial);
    this.label.position.set(0, HUMANOID_RIG.height + 0.34, 0);

    this.group.name = `dummy:${spec.name}`;
    this.group.add(this.body, this.head, this.label);
    this.group.position.set(spec.x, spec.y, spec.z);
    this.group.rotation.y = spec.yaw;

    this.currX = spec.x;
    this.currY = spec.y;
    this.currZ = spec.z;
    this.prevX = spec.x;
    this.prevY = spec.y;
    this.prevZ = spec.z;
    this.rig.setTransform(spec.x, spec.y, spec.z, spec.yaw);
    this.drawLabel();
  }

  get behaviour(): DummyBehaviour {
    return this.spec.behaviour;
  }

  /** True when the target is standing and shootable. */
  get exposed(): boolean {
    return this.health.alive && this.currY > this.spec.y - POPUP_DEPTH * 0.75;
  }

  /** Record a hit for the printed read-out. The damage itself came from DamageSystem. */
  noteHit(amount: number, zone: HitZone, distance: number): void {
    this.lastDamage = amount;
    this.lastZone = zone;
    this.lastDistance = distance;
    this.totalDamage += amount;
    this.labelDirty = true;
  }

  reset(): void {
    this.health.reset();
    this.totalDamage = 0;
    this.lastDamage = 0;
    this.respawnTimer = 0;
    this.labelDirty = true;
  }

  /** One sim tick. Movement is gameplay: it decides whether your shot connects. */
  step(): void {
    this.prevX = this.currX;
    this.prevY = this.currY;
    this.prevZ = this.currZ;

    this.health.step();

    if (!this.health.alive) {
      this.respawnTimer += DT;
      if (this.respawnTimer >= RESPAWN_SECONDS) this.reset();
    }

    const hp = Math.round(this.health.current);
    if (hp !== this.shownHealth || this.health.alive !== this.shownAlive) {
      this.shownHealth = hp;
      this.shownAlive = this.health.alive;
      this.labelDirty = true;
    }

    const spec = this.spec;
    let x = spec.x;
    let y = spec.y;
    let z = spec.z;

    switch (spec.behaviour) {
      case 'static':
        break;
      case 'popup': {
        const up = spec.upTime ?? 3;
        const down = spec.downTime ?? 2;
        const cycle = up + down;
        this.phase = (this.phase + DT) % cycle;
        // Rise, hold, drop. Downed targets stay down until they respawn.
        const raised = this.health.alive
          ? this.phase < up
            ? smoothstep(0, POPUP_TRANSITION, this.phase)
            : 1 - smoothstep(up, up + POPUP_TRANSITION, this.phase)
          : 0;
        y = spec.y - POPUP_DEPTH * (1 - clamp01(raised));
        break;
      }
      case 'strafe': {
        const travel = spec.travel ?? 3;
        const speed = spec.speed ?? 2.6;
        this.strafeOffset += this.strafeDir * speed * DT;
        if (this.strafeOffset > travel) {
          this.strafeOffset = travel;
          this.strafeDir = -1;
        } else if (this.strafeOffset < -travel) {
          this.strafeOffset = -travel;
          this.strafeDir = 1;
        }
        // The path is fixed in world space along the target's own right vector.
        x = spec.x + Math.cos(spec.yaw) * this.strafeOffset;
        z = spec.z - Math.sin(spec.yaw) * this.strafeOffset;
        break;
      }
    }

    this.currX = x;
    this.currY = y;
    this.currZ = z;
    // The rig tracks the *simulation* pose, not the interpolated render pose: a shot is
    // resolved on a tick, so it must be resolved against where the target is on that tick.
    this.rig.setTransform(x, y, z, this.spec.yaw);
  }

  /** Render pass: interpolate the pose and billboard the read-out. */
  updateVisual(alpha: number, cameraX: number, cameraY: number, cameraZ: number): void {
    this.group.position.set(
      this.prevX + (this.currX - this.prevX) * alpha,
      this.prevY + (this.currY - this.prevY) * alpha,
      this.prevZ + (this.currZ - this.prevZ) * alpha,
    );
    const visible = this.health.alive;
    if (this.body.visible !== visible) {
      this.body.visible = visible;
      this.head.visible = visible;
    }

    // The label lives inside the rotated group, so undo that rotation before facing the
    // camera; otherwise the dummy's own yaw fights the billboard.
    const dx = cameraX - this.group.position.x;
    const dz = cameraZ - this.group.position.z;
    this.label.rotation.y = Math.atan2(dx, dz) - this.spec.yaw;
    const dy = cameraY - (this.group.position.y + this.label.position.y);
    this.label.rotation.x = Math.atan2(dy, Math.hypot(dx, dz));

    if (this.labelDirty) {
      this.labelDirty = false;
      this.drawLabel();
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }

  private drawLabel(): void {
    const ctx = this.labelCtx;
    ctx.clearRect(0, 0, LABEL_W, LABEL_H);
    ctx.fillStyle = 'rgba(7,8,10,0.82)';
    ctx.fillRect(0, 0, LABEL_W, LABEL_H);
    ctx.strokeStyle = this.health.alive ? 'rgba(38,43,51,1)' : 'rgba(232,96,76,0.9)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, LABEL_W - 3, LABEL_H - 3);

    const family = 'ui-sans-serif, system-ui, Segoe UI, Roboto, Arial, sans-serif';

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#626a77';
    ctx.font = `800 15px ${family}`;
    ctx.fillText(this.displayName.toUpperCase(), 12, 18);

    if (!this.health.alive) {
      ctx.fillStyle = '#e8604c';
      ctx.font = `800 34px ${family}`;
      ctx.fillText('DOWN', 12, 56);
      ctx.fillStyle = '#9aa1ad';
      ctx.font = `500 15px ${family}`;
      ctx.fillText(`TOTAL ${this.totalDamage.toFixed(1)}`, 12, 82);
    } else {
      ctx.fillStyle = this.lastZone === 'head' ? '#ffb340' : '#e8eaee';
      ctx.font = `800 34px ${family}`;
      ctx.fillText(this.lastDamage > 0 ? this.lastDamage.toFixed(1) : '—', 12, 54);

      ctx.fillStyle = '#9aa1ad';
      ctx.font = `800 14px ${family}`;
      const zoneText = this.lastDamage > 0 ? this.lastZone.toUpperCase() : 'NO HITS';
      ctx.fillText(zoneText, 108, 48);
      ctx.fillStyle = '#626a77';
      ctx.font = `500 13px ${family}`;
      if (this.lastDamage > 0) ctx.fillText(`${this.lastDistance.toFixed(1)} m`, 108, 66);

      ctx.fillStyle = '#6fd08c';
      ctx.font = `800 15px ${family}`;
      ctx.fillText(`HP ${Math.round(this.health.current)}`, 12, 82);
      ctx.fillStyle = '#626a77';
      ctx.font = `500 13px ${family}`;
      ctx.fillText(`TOTAL ${this.totalDamage.toFixed(1)}`, 92, 82);
    }

    this.labelTexture.needsUpdate = true;
  }

  /** Called by the range when health changed without a hit (regeneration). */
  markLabelDirty(): void {
    this.labelDirty = true;
  }
}

export interface DummyMaterials {
  readonly body: THREE.Material;
  readonly head: THREE.Material;
}

export function buildDummyMaterials(): DummyMaterials & { dispose(): void } {
  const body = new THREE.MeshLambertMaterial({ color: 0x59616e });
  const head = new THREE.MeshLambertMaterial({ color: 0x8a6a3c });
  return {
    body,
    head,
    dispose(): void {
      body.dispose();
      head.dispose();
    },
  };
}

/** The mesh IS the rig: same boxes, same offsets, no separate art to drift out of sync. */
function buildZoneGeometry(zones: readonly HitZone[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const box of HUMANOID_RIG.boxes) {
    if (!zones.includes(box.zone)) continue;
    const g = new THREE.BoxGeometry(box.sx, box.sy, box.sz);
    g.translate(box.ox, box.oy, box.oz);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error('Failed to merge dummy geometry');
  merged.computeBoundingSphere();
  return merged;
}
