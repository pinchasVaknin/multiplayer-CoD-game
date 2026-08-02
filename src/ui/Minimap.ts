import { PROP_SHAPES } from '../world/maps/props';
import type { Brush, MapDef, ObjectiveDef, ObjectiveKind } from '../world/maps/types';

/**
 * The minimap (brief S6.4): rotating, canvas-drawn, **from the `MapDef`**.
 *
 * Not from a screenshot and not from a hand-drawn image — the geometry on screen is the
 * geometry you collide with, so a wall that moves in the map file moves here too and cannot
 * silently disagree.
 *
 * The cost model is the interesting part. Redrawing 130 brush footprints every frame would
 * be a real per-frame expense for a 168 px widget, so the world is rasterised **once** into
 * an offscreen canvas at load and each frame is one transformed `drawImage` plus a handful
 * of arcs. Rotation is therefore free: it is a canvas transform on an image that already
 * exists.
 *
 * Brushes are classified by their vertical extent rather than tagged in the map:
 *   - top at or below 0.1 m      floor slabs and painted trim, not drawn
 *   - entirely above 5.5 m       roofs and overhead structure, not drawn (they would hide
 *                                the catwalk underneath them, which is the useful part)
 *   - sitting above 3.0 m        catwalk decks and ramps, drawn light
 *   - everything else            walls and cover, drawn dark
 */

/** Pixel size of the offscreen world raster per metre. Higher is sharper and dearer. */
const RASTER_PX_PER_M = 6;
/** Metres from the player to the edge of the visible disc. */
const VIEW_RADIUS_M = 34;

/** Gunfire pings alive at once, and how long one lasts. */
const PING_POOL = 24;
const PING_SECONDS = 2.4;

const COLOR_WALL = '#2b313b';
const COLOR_WALL_EDGE = '#3d4552';
const COLOR_DECK = '#4a5462';
const COLOR_BACKDROP = 'rgba(9, 11, 14, 0.72)';
const COLOR_FRIENDLY = '#6fd08c';
const COLOR_LOCAL = '#e8eaee';
const COLOR_PING = '#e8604c';
/** M7: a UAV contact and the sweep line that found it. */
const COLOR_CONTACT = '#e8604c';
const COLOR_SWEEP = 'rgba(232, 96, 76, 0.55)';
/** M7: flag ownership. Neutral keeps the objective amber the map already uses. */
const COLOR_OWNED_FRIENDLY = '#6fd08c';
const COLOR_OWNED_ENEMY = '#e8604c';
const COLOR_OBJECTIVE = 'rgba(255, 179, 64, 0.85)';

interface Ping {
  x: number;
  z: number;
  life: number;
}

/** One dot to draw. Filled by the caller each frame; never allocated per dot. */
export interface MinimapActor {
  x: number;
  z: number;
  yaw: number;
  active: boolean;
}

/**
 * A UAV contact (M7).
 *
 * `age` is seconds since the sweep crossed it, so the dot fades rather than blinking off. A
 * contact you can still just see is the difference between "somebody was there" and "somebody
 * is there", which is the whole reason the radar sweeps rather than streams.
 */
export interface MinimapContact {
  x: number;
  z: number;
  age: number;
  active: boolean;
}

/** Who owns an objective, for the flag pips (M7). */
export interface MinimapObjectiveState {
  id: string;
  /** Resolved by the caller against the local team, so the minimap needs no team logic. */
  owner: 'FRIENDLY' | 'ENEMY' | 'NONE';
  /** 0..1 capture progress, drawn as an arc around the pip. */
  progress: number;
  contested: boolean;
}

export class Minimap {
  readonly element: HTMLElement;

  /**
   * Teammate markers. The caller writes into this array each frame and sets `active`, so a
   * ten-bot match does no allocation to draw its dots.
   */
  readonly friendlies: MinimapActor[] = [];

  /** Off by default: Domination flags on a Team Deathmatch minimap are noise (see PLAN.md). */
  showObjectives = false;

  // ---- M7 ----------------------------------------------------------------
  /**
   * Enemy contacts from a friendly UAV. Written by the caller each frame, never allocated,
   * for the same reason `friendlies` is not: a ten-bot match must not allocate to draw dots.
   */
  readonly contacts: MinimapContact[] = [];
  /** Bearing of the sweep line, radians, or null when no UAV is up. */
  sweepAngle: number | null = null;
  /** Seconds a contact stays visible after the beam passes. Matches the streak's own fade. */
  contactFadeSeconds = 1.1;
  /** True while an enemy Counter-UAV is running: the map goes to noise. */
  scrambled = false;
  /** Per-objective ownership, for Domination's flag pips. Empty in a mode without them. */
  readonly objectiveStates: MinimapObjectiveState[] = [];

  /**
   * Which objective kinds this mode actually uses, or null for all of them.
   *
   * `MapDef.objectives` holds *every* objective the map authors — Foundry carries Domination's
   * three flags and Search & Destroy's two bomb sites together — so drawing the list wholesale
   * put flags on an S&D minimap and bomb sites on a Domination one. Reported from a live match.
   * The mode says what it uses and nothing else is drawn.
   */
  objectiveKinds: readonly ObjectiveKind[] | null = null;

  private scrambleSeed = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly raster: HTMLCanvasElement;
  private readonly objectives: readonly ObjectiveDef[];
  private readonly pings: Ping[] = [];
  /** World-space bounds of the raster, so it can be positioned under the transform. */
  private readonly rasterMinX: number;
  private readonly rasterMinZ: number;
  private readonly rasterW: number;
  private readonly rasterH: number;
  private readonly sizePx: number;

  constructor(def: MapDef, maxFriendlies: number, sizePx = 168) {
    this.sizePx = sizePx;
    this.objectives = def.objectives;

    this.element = document.createElement('div');
    this.element.className = 'hud-map';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-map__canvas';
    // Drawn at 2x and scaled down by CSS, so the lines stay crisp on a HiDPI panel without
    // asking the page for its device ratio every frame.
    this.canvas.width = sizePx * 2;
    this.canvas.height = sizePx * 2;
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('Minimap needs a 2D context');
    this.ctx = ctx;
    this.element.appendChild(this.canvas);

    const ring = document.createElement('i');
    ring.className = 'hud-map__ring';
    this.element.appendChild(ring);

    for (let i = 0; i < maxFriendlies; i++) this.friendlies.push({ x: 0, z: 0, yaw: 0, active: false });
    // Enough for a full roster of contacts; the caller only ever activates what it has.
    for (let i = 0; i < maxFriendlies * 2 + 2; i++) {
      this.contacts.push({ x: 0, z: 0, age: 0, active: false });
    }
    for (let i = 0; i < PING_POOL; i++) this.pings.push({ x: 0, z: 0, life: 0 });

    const bounds = def.navBounds;
    this.rasterMinX = bounds.min.x;
    this.rasterMinZ = bounds.min.z;
    this.rasterW = Math.ceil((bounds.max.x - bounds.min.x) * RASTER_PX_PER_M);
    this.rasterH = Math.ceil((bounds.max.z - bounds.min.z) * RASTER_PX_PER_M);
    this.raster = this.buildRaster(def);
  }

  /** A shot was fired at a position the player should know about. */
  addPing(x: number, z: number): void {
    let oldest: Ping | undefined;
    let oldestLife = Infinity;
    for (const p of this.pings) {
      if (p.life <= 0) {
        oldest = p;
        break;
      }
      if (p.life < oldestLife) {
        oldestLife = p.life;
        oldest = p;
      }
    }
    if (oldest === undefined) return;
    oldest.x = x;
    oldest.z = z;
    oldest.life = PING_SECONDS;
  }

  clearPings(): void {
    for (const p of this.pings) p.life = 0;
  }

  /**
   * Draw one frame. `px/pz/yaw` is the local player.
   *
   * The transform maps world XZ straight onto the canvas: `rotate(yaw)` is what puts the
   * player's facing at the top, because forward is `(-sin yaw, -cos yaw)` and rotating that
   * by `+yaw` in a y-down space gives `(0, -1)`.
   */
  update(px: number, pz: number, yaw: number, dt: number): void {
    const ctx = this.ctx;
    const size = this.sizePx * 2;
    const half = size / 2;
    const scale = half / VIEW_RADIUS_M;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = COLOR_BACKDROP;
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(half, half);
    ctx.rotate(yaw);
    ctx.scale(scale, scale);
    ctx.translate(-px, -pz);

    // The world, as one image.
    ctx.drawImage(
      this.raster,
      this.rasterMinX,
      this.rasterMinZ,
      this.rasterW / RASTER_PX_PER_M,
      this.rasterH / RASTER_PX_PER_M,
    );

    if (this.showObjectives) this.drawObjectives(ctx, scale);
    this.drawPings(ctx, scale, dt);
    this.drawContacts(ctx);
    this.drawFriendlies(ctx, scale);

    ctx.restore();
    if (this.sweepAngle !== null) this.drawSweep(ctx, half, yaw);
    this.drawLocal(ctx, half);
    // Last, over everything: being blinded should hide the map, not sit under it.
    if (this.scrambled) this.drawScramble(ctx, half, dt);
  }

  dispose(): void {
    this.element.remove();
  }

  // -- internals -------------------------------------------------------------

  /**
   * Rasterise the map once.
   *
   * Brush footprints are drawn as rotated rectangles and prop footprints as the union of
   * their solid parts, in world units scaled by `RASTER_PX_PER_M`, so the result can be
   * placed under the live transform with a single `drawImage`.
   */
  private buildRaster(def: MapDef): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.rasterW;
    canvas.height = this.rasterH;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Minimap raster needs a 2D context');

    ctx.setTransform(RASTER_PX_PER_M, 0, 0, RASTER_PX_PER_M, -this.rasterMinX * RASTER_PX_PER_M, -this.rasterMinZ * RASTER_PX_PER_M);
    ctx.lineWidth = 0.12;

    // Two passes so every deck sits above every wall, whatever order the map lists them in.
    for (const pass of ['wall', 'deck'] as const) {
      for (const brush of def.brushes) {
        if (brush.solid === false) continue;
        const kind = classify(brush);
        if (kind !== pass) continue;
        ctx.fillStyle = kind === 'deck' ? COLOR_DECK : COLOR_WALL;
        ctx.strokeStyle = COLOR_WALL_EDGE;
        // A pitched brush is longer than its footprint: 9.85 m of ramp covers 9.0 m of
        // ground. Project the extents rather than drawing the box's own dimensions.
        const planX = brush.size.x * Math.cos(brush.rotationZ ?? 0);
        const planZ = brush.size.z * Math.cos(brush.rotationX ?? 0);
        this.footprint(ctx, brush.position.x, brush.position.z, planX, planZ, brush.rotationY);
      }
    }

    ctx.fillStyle = COLOR_WALL;
    ctx.strokeStyle = COLOR_WALL_EDGE;
    for (const placement of def.props) {
      const shape = PROP_SHAPES[placement.shape];
      for (const part of shape.parts) {
        if (!part.solid) continue;
        const c = Math.cos(placement.rotationY);
        const s = Math.sin(placement.rotationY);
        const wx = placement.position.x + part.offset.x * c + part.offset.z * s;
        const wz = placement.position.z - part.offset.x * s + part.offset.z * c;
        this.footprint(ctx, wx, wz, part.size.x, part.size.z, placement.rotationY);
      }
    }
    return canvas;
  }

  private footprint(
    ctx: CanvasRenderingContext2D,
    x: number,
    z: number,
    sx: number,
    sz: number,
    yaw: number,
  ): void {
    ctx.save();
    ctx.translate(x, z);
    // The prop mesher's yaw convention rotates +X toward -Z, hence the negated angle here.
    ctx.rotate(-yaw);
    ctx.beginPath();
    ctx.rect(-sx / 2, -sz / 2, sx, sz);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawObjectives(ctx: CanvasRenderingContext2D, scale: number): void {
    ctx.lineWidth = 2 / scale;
    for (const o of this.objectives) {
      if (this.objectiveKinds !== null && !this.objectiveKinds.includes(o.kind)) continue;
      // M7: ownership colours the pip and a capture in progress draws an arc around it.
      const state = this.objectiveStates.find((entry) => entry.id === o.id);
      const colour =
        state === undefined || state.owner === 'NONE'
          ? COLOR_OBJECTIVE
          : state.owner === 'FRIENDLY'
            ? COLOR_OWNED_FRIENDLY
            : COLOR_OWNED_ENEMY;
      ctx.fillStyle = colour;
      ctx.strokeStyle = colour;

      ctx.beginPath();
      if (o.kind === 'bombsite') {
        const r = 1.6;
        ctx.moveTo(o.position.x, o.position.z - r);
        ctx.lineTo(o.position.x + r, o.position.z + r);
        ctx.lineTo(o.position.x - r, o.position.z + r);
        ctx.closePath();
      } else {
        ctx.arc(o.position.x, o.position.z, 1.5, 0, Math.PI * 2);
      }
      // A held objective is filled; neutral or contested is outline only.
      if (state !== undefined && state.owner !== 'NONE' && !state.contested) {
        ctx.globalAlpha = 0.35;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.stroke();

      if (state !== undefined && state.progress > 0.001) {
        ctx.lineWidth = 3 / scale;
        ctx.beginPath();
        ctx.arc(
          o.position.x,
          o.position.z,
          2.4,
          -Math.PI / 2,
          -Math.PI / 2 + state.progress * Math.PI * 2,
        );
        ctx.stroke();
        ctx.lineWidth = 2 / scale;
      }
    }
  }

  private drawPings(ctx: CanvasRenderingContext2D, scale: number, dt: number): void {
    for (const p of this.pings) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      const t = p.life / PING_SECONDS;
      // A ring that grows as it fades: the eye catches expansion far better than a dot.
      ctx.strokeStyle = COLOR_PING;
      ctx.globalAlpha = t * t;
      ctx.lineWidth = 2 / scale;
      ctx.beginPath();
      ctx.arc(p.x, p.z, 0.8 + (1 - t) * 3.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * UAV contacts (M7): a dot that fades over `contactFadeSeconds`.
   *
   * Ages are advanced by the streak on the sim tick, so a stalled frame cannot make a contact
   * live longer than the sweep says it did. This only reads them.
   */
  private drawContacts(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = COLOR_CONTACT;
    for (const c of this.contacts) {
      if (!c.active) continue;
      const t = 1 - Math.min(1, c.age / Math.max(0.05, this.contactFadeSeconds));
      if (t <= 0) continue;
      ctx.globalAlpha = t;
      ctx.beginPath();
      ctx.arc(c.x, c.z, 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The radar beam.
   *
   * Drawn in *screen* space after the world transform is popped, because the sweep belongs to
   * the radar set rather than to the world — adding the player's yaw is what keeps it rotating
   * with the map underneath it.
   */
  private drawSweep(ctx: CanvasRenderingContext2D, half: number, yaw: number): void {
    const angle = (this.sweepAngle ?? 0) + yaw;
    const gradient = ctx.createLinearGradient(
      half,
      half,
      half + Math.cos(angle) * half,
      half + Math.sin(angle) * half,
    );
    gradient.addColorStop(0, COLOR_SWEEP);
    gradient.addColorStop(1, 'rgba(232, 96, 76, 0)');
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(half, half);
    ctx.lineTo(half + Math.cos(angle) * half, half + Math.sin(angle) * half);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Counter-UAV: bands of interference across the disc (M7).
   *
   * Deliberately legible *as* jamming rather than simply blanking the map — a player whose
   * minimap went black would think it had broken. The seed advances per frame so the noise
   * moves, and the hash is deterministic so nothing allocates and no `Math.random` runs in a
   * draw path.
   */
  private drawScramble(ctx: CanvasRenderingContext2D, half: number, dt: number): void {
    this.scrambleSeed = (this.scrambleSeed + dt * 37) % 1000;
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(9, 11, 14, 0.55)';
    ctx.fillRect(0, 0, half * 2, half * 2);
    ctx.fillStyle = 'rgba(232, 234, 238, 0.13)';
    const bands = 22;
    for (let i = 0; i < bands; i++) {
      const n = Math.abs(Math.sin((i * 12.9898 + this.scrambleSeed) * 43758.5453) % 1);
      const y = (i / bands) * half * 2;
      ctx.fillRect(n * half * 0.6, y, half * 2 * (0.35 + n * 0.65), 2 + n * 3);
    }
    ctx.restore();
  }

  private drawFriendlies(ctx: CanvasRenderingContext2D, scale: number): void {
    ctx.fillStyle = COLOR_FRIENDLY;
    ctx.strokeStyle = COLOR_FRIENDLY;
    ctx.lineWidth = 1.4 / scale;
    for (const a of this.friendlies) {
      if (!a.active) continue;
      // A chevron, not a dot: which way a teammate is looking is most of what makes a
      // friendly marker worth glancing at.
      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      const len = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x + fx * len, a.z + fz * len);
      ctx.lineTo(a.x - fz * 0.9 - fx * 0.5, a.z + fx * 0.9 - fz * 0.5);
      ctx.lineTo(a.x + fz * 0.9 - fx * 0.5, a.z - fx * 0.9 - fz * 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** The player, always at the centre and always pointing up. */
  private drawLocal(ctx: CanvasRenderingContext2D, half: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOR_LOCAL;
    ctx.beginPath();
    ctx.moveTo(half, half - 9);
    ctx.lineTo(half + 6, half + 7);
    ctx.lineTo(half, half + 3);
    ctx.lineTo(half - 6, half + 7);
    ctx.closePath();
    ctx.fill();
  }
}

function classify(brush: Brush): 'skip' | 'wall' | 'deck' {
  const top = brush.position.y + brush.size.y / 2;
  const bottom = brush.position.y - brush.size.y / 2;
  if (top <= 0.1) return 'skip';
  if (bottom > 5.5) return 'skip';
  // A pitched brush is a ramp, and a ramp is somewhere to walk rather than something in the
  // way — it reads with the deck it leads to, not with the walls it passes.
  if (brush.rotationX !== undefined || brush.rotationZ !== undefined) return 'deck';
  if (bottom > 3.0) return 'deck';
  return 'wall';
}
