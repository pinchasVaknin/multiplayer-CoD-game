import * as THREE from 'three';
import type { Bot } from '../ai/Bot';
import type { BotDirector } from '../ai/BotDirector';
import { MAX_WAYPOINTS } from '../ai/Pathing';
import type { NavGrid } from '../world/Navmesh';

/**
 * The AI's world-space debug layer (brief S7).
 *
 * Five things S7 asks to be able to see: the baked navmesh, each bot's current path, the
 * line of sight it is acting on, the cover points and who holds them, and — in
 * `AiPanel` — what one selected bot believes. Everything here is geometry; the text is
 * next door.
 *
 * **Every buffer is allocated once at construction and rewritten in place.** A debug
 * view that allocates per frame produces exactly the GC sawtooth acceptance criterion 7
 * is looking for, which would make the tool a liar about the thing it exists to measure.
 * `setDrawRange` is what hides the unused tail rather than rebuilding the attribute.
 *
 * Toggled with F4. Off by default and skipped entirely while off.
 */

/** Bots the path and LOS buffers are sized for. Well past any M3 roster. */
const MAX_BOTS = 24;

/** Two vertices per segment, and one segment per waypoint hop. */
const PATH_VERTS = MAX_BOTS * MAX_WAYPOINTS * 2;
const LOS_VERTS = MAX_BOTS * 2;

const COLOR_PATH = new THREE.Color(0xffb340);
const COLOR_LOS_SEEN = new THREE.Color(0xe8604c);
const COLOR_LOS_MEMORY = new THREE.Color(0x6e5a44);
const COLOR_COVER_FREE = new THREE.Color(0x6fd08c);
const COLOR_COVER_TAKEN = new THREE.Color(0xe8604c);

export class AiDebug {
  readonly group = new THREE.Group();

  private readonly navPoints: THREE.Points;
  private readonly pathLines: THREE.LineSegments;
  private readonly losLines: THREE.LineSegments;
  private readonly coverPoints: THREE.Points;

  private readonly pathPos: Float32Array;
  private readonly pathCol: Float32Array;
  private readonly losPos: Float32Array;
  private readonly losCol: Float32Array;
  private readonly coverPos: Float32Array;
  private readonly coverCol: Float32Array;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private enabled = false;

  constructor(private readonly director: BotDirector) {
    this.group.name = 'ai-debug';
    this.group.visible = false;

    this.navPoints = this.buildNavmesh(director.nav);
    this.group.add(this.navPoints);

    // ---- paths ------------------------------------------------------------
    this.pathPos = new Float32Array(PATH_VERTS * 3);
    this.pathCol = new Float32Array(PATH_VERTS * 3);
    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute('position', new THREE.BufferAttribute(this.pathPos, 3));
    pathGeo.setAttribute('color', new THREE.BufferAttribute(this.pathCol, 3));
    const pathMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
    this.pathLines = new THREE.LineSegments(pathGeo, pathMat);
    this.pathLines.renderOrder = 900;
    this.pathLines.frustumCulled = false;
    this.disposables.push(pathGeo, pathMat);
    this.group.add(this.pathLines);

    // ---- line of sight ----------------------------------------------------
    this.losPos = new Float32Array(LOS_VERTS * 3);
    this.losCol = new Float32Array(LOS_VERTS * 3);
    const losGeo = new THREE.BufferGeometry();
    losGeo.setAttribute('position', new THREE.BufferAttribute(this.losPos, 3));
    losGeo.setAttribute('color', new THREE.BufferAttribute(this.losCol, 3));
    const losMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
    this.losLines = new THREE.LineSegments(losGeo, losMat);
    this.losLines.renderOrder = 901;
    this.losLines.frustumCulled = false;
    this.disposables.push(losGeo, losMat);
    this.group.add(this.losLines);

    // ---- cover ------------------------------------------------------------
    const coverCount = Math.max(1, director.cover.count);
    this.coverPos = new Float32Array(coverCount * 3);
    this.coverCol = new Float32Array(coverCount * 3);
    for (let i = 0; i < director.cover.count; i++) {
      const slot = director.cover.slots[i];
      if (slot === undefined) continue;
      // Lifted to chest height so the marker is not buried in the floor mesh.
      this.coverPos[i * 3] = slot.x;
      this.coverPos[i * 3 + 1] = slot.y + 1.1;
      this.coverPos[i * 3 + 2] = slot.z;
    }
    const coverGeo = new THREE.BufferGeometry();
    coverGeo.setAttribute('position', new THREE.BufferAttribute(this.coverPos, 3));
    coverGeo.setAttribute('color', new THREE.BufferAttribute(this.coverCol, 3));
    const coverMat = new THREE.PointsMaterial({ size: 0.24, vertexColors: true, depthTest: false, transparent: true });
    this.coverPoints = new THREE.Points(coverGeo, coverMat);
    this.coverPoints.renderOrder = 902;
    this.coverPoints.frustumCulled = false;
    this.disposables.push(coverGeo, coverMat);
    this.group.add(this.coverPoints);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
  }

  /** Rebuild the dynamic buffers. Called once per rendered frame, skipped while off. */
  update(): void {
    if (!this.enabled) return;
    this.updatePaths();
    this.updateLos();
    this.updateCover();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }

  // -- internals -------------------------------------------------------------

  /**
   * The baked grid as one point per walkable cell, tinted by height so the ramp and the
   * pit floor read as separate surfaces rather than one flat sheet. Static: the navmesh
   * is baked once at load, so this buffer is written once too.
   */
  private buildNavmesh(nav: NavGrid): THREE.Points {
    let walkable = 0;
    for (let i = 0; i < nav.cellCount; i++) {
      if (nav.isWalkable(i)) walkable++;
    }
    const pos = new Float32Array(Math.max(1, walkable) * 3);
    const col = new Float32Array(Math.max(1, walkable) * 3);

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < nav.cellCount; i++) {
      if (!nav.isWalkable(i)) continue;
      const h = nav.heightAt(i);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const span = Math.max(1e-3, hi - lo);

    let w = 0;
    for (let i = 0; i < nav.cellCount; i++) {
      if (!nav.isWalkable(i)) continue;
      const h = nav.heightAt(i);
      pos[w * 3] = nav.centerX(nav.indexOfX(i));
      pos[w * 3 + 1] = h + 0.03;
      pos[w * 3 + 2] = nav.centerZ(nav.indexOfZ(i));
      const t = (h - lo) / span;
      col[w * 3] = 0.25 + t * 0.75;
      col[w * 3 + 1] = 0.5;
      col[w * 3 + 2] = 1 - t * 0.65;
      w++;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 0.11, vertexColors: true, transparent: true, opacity: 0.7 });
    this.disposables.push(geo, mat);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return points;
  }

  private updatePaths(): void {
    const bots = this.director.bots;
    let v = 0;

    for (const bot of bots) {
      if (!bot.health.alive) continue;
      const path = bot.path;
      if (!path.active) continue;

      // Start the polyline at the bot itself, so a path is visibly attached to the thing
      // following it rather than beginning at some waypoint it has already passed.
      let px = bot.px;
      let py = bot.py + 0.1;
      let pz = bot.pz;

      for (let i = path.cursor; i < path.count; i++) {
        if (v + 2 > PATH_VERTS) break;
        const wx = path.x[i] ?? px;
        const wy = (path.y[i] ?? py) + 0.1;
        const wz = path.z[i] ?? pz;
        writeSegment(this.pathPos, this.pathCol, v, px, py, pz, wx, wy, wz, COLOR_PATH, COLOR_PATH);
        v += 2;
        px = wx;
        py = wy;
        pz = wz;
      }
    }

    this.pathLines.geometry.setDrawRange(0, v);
    markUpdated(this.pathLines.geometry);
  }

  /**
   * One ray per bot, from its eye to the position on its blackboard.
   *
   * Red while the bot actually holds line of sight, brown once it is shooting at a
   * memory — which is the single most useful thing to be able to see, because "the bot
   * is firing at where I was" and "the bot can see me" look identical from the outside.
   */
  private updateLos(): void {
    const bots = this.director.bots;
    let v = 0;

    for (const bot of bots) {
      if (!bot.health.alive || v + 2 > LOS_VERTS) continue;
      const bb = bot.blackboard;
      if (!bb.hasKnownTarget) continue;
      const colour = bb.hasLos ? COLOR_LOS_SEEN : COLOR_LOS_MEMORY;
      writeSegment(
        this.losPos,
        this.losCol,
        v,
        bot.px,
        bot.py + bot.eyeHeight,
        bot.pz,
        bb.lastKnownX,
        bb.lastKnownY,
        bb.lastKnownZ,
        colour,
        colour,
      );
      v += 2;
    }

    this.losLines.geometry.setDrawRange(0, v);
    markUpdated(this.losLines.geometry);
  }

  private updateCover(): void {
    const slots = this.director.cover.slots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === undefined) continue;
      const c = slot.occupantId >= 0 ? COLOR_COVER_TAKEN : COLOR_COVER_FREE;
      this.coverCol[i * 3] = c.r;
      this.coverCol[i * 3 + 1] = c.g;
      this.coverCol[i * 3 + 2] = c.b;
    }
    const attr = this.coverPoints.geometry.getAttribute('color');
    attr.needsUpdate = true;
  }
}

/** Where a bot's floating state label belongs, in world space. */
export function labelAnchorY(bot: Bot): number {
  return bot.py + bot.rig.standingHeight + 0.35;
}

function writeSegment(
  pos: Float32Array,
  col: Float32Array,
  v: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  ca: THREE.Color,
  cb: THREE.Color,
): void {
  const p = v * 3;
  pos[p] = ax;
  pos[p + 1] = ay;
  pos[p + 2] = az;
  pos[p + 3] = bx;
  pos[p + 4] = by;
  pos[p + 5] = bz;
  col[p] = ca.r;
  col[p + 1] = ca.g;
  col[p + 2] = ca.b;
  col[p + 3] = cb.r;
  col[p + 4] = cb.g;
  col[p + 5] = cb.b;
}

function markUpdated(geo: THREE.BufferGeometry): void {
  geo.getAttribute('position').needsUpdate = true;
  geo.getAttribute('color').needsUpdate = true;
}
