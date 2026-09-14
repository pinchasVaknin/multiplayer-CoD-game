import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { TeamRelation } from '../../shared/ui/TeamColour';
import { ACTOR_INDICATOR_LAYER } from '../engine/Renderer';
import {
  INDICATOR_FRAME_ANCHORS,
  type ActorAvatar,
  type ActorIndicatorFrameAnchor,
} from '../characters/ActorAvatar';
import { cssHex, palette, type GameplayPalette } from '../ui/Palette';

/**
 * The enemy tell is two shoulder pads (M13 C3): small flat red pads on the outer upper arm,
 * flush with the sleeve, lit, each with a soft halo — Call of Duty Mobile's enemy dress,
 * equipment rather than a marker. They replaced four emissive spheres on the arms and knees
 * that read as a rash: geometry floating at the centre of a bone, the same from every angle.
 *
 * Pixel arithmetic, so nobody is surprised: at 90° and 1920 px a 5 cm pad is ~5 px at 10 m,
 * ~2 px at 25 m and ~1 px at 50 m — and the first cut, at exactly that size and a 0.3 halo,
 * was read on a real display as part of the skin at 1.5 m (M13 C3 gate, 2026-09-14): 24 px
 * across a 2000 px frame at 5 m, on a shoulder that has red details of its own. So the pad is
 * twice the plan's size, lit as the spheres were, its halo doubled, and it has the plan's
 * screen-space floor: below `PAD_MIN_SCREEN_FRACTION` of the frame height the whole frame is
 * scaled up so the pad holds ~6 px at 1080p. At range that is a red dot on the shoulder rather
 * than nothing, and the nameplate (1.28 m wide, ~25 px at 50 m) remains the tell.
 */
const MARKER_ANCHORS = INDICATOR_FRAME_ANCHORS;

/** The pad: 10 × 6 × 1 cm, long side down the arm, thin side out of the sleeve (+Z). */
const PAD_LENGTH = 0.1;
const PAD_WIDTH = 0.06;
const PAD_THICKNESS = 0.01;
const PAD_CORNER = 0.006;
/** The spheres ran 3.2; 1.5 read as paint on the sleeve. */
const PAD_EMISSIVE_INTENSITY = 3.0;
/** The halo: an additive sprite behind the pad. There is no bloom pass; this is the glow. */
const HALO_RADIUS = 0.14;
const HALO_ALPHA = 0.55;
const HALO_TEXTURE_SIZE = 64;
/**
 * The pad's long side must cover at least this fraction of the frame height: 6 px of 1080.
 * `scale = max(1, minPx / pxPerMetre(distance))`, the plan's one line, in frame fractions so it
 * needs no buffer size — only the camera's vertical field of view and the distance.
 */
const PAD_MIN_SCREEN_FRACTION = 6 / 1080;

const LABEL_WIDTH = 512;
const LABEL_HEIGHT = 160;
const LABEL_WORLD_WIDTH = 1.28;
const LABEL_WORLD_HEIGHT = LABEL_WORLD_WIDTH * (LABEL_HEIGHT / LABEL_WIDTH);
const LABEL_CLEARANCE = 0.38;
const HEALTH_SMOOTHING = 16;

/** Canvas fill styles for one relation, derived from the live palette and nothing else. */
interface RelationColours {
  readonly name: string;
  readonly health: string;
}

/**
 * The colours the label paints with, as a function of the palette.
 *
 * Taken from `ui/Palette` rather than written here, for the reason `Palette.ts` gives at
 * length: a colourblind mode is a palette swap, and it reaches a surface only if that surface
 * asked the palette. The old `BotMesh` body tint did; the first cut of this file did not, so
 * under deuteranopia the minimap dot went amber while the body in front of the player kept
 * glowing a red the player could not see. NEUTRAL cannot occur for an actor — every body is on
 * side A or B — but `TeamRelation` has three values and the table is complete so the type
 * system, not a runtime branch, guarantees a colour.
 */
function relationColours(p: GameplayPalette): Readonly<Record<TeamRelation, RelationColours>> {
  return {
    FRIENDLY: { name: cssHex(p.friendly), health: cssHex(p.local) },
    HOSTILE: { name: cssHex(p.hostile), health: cssHex(p.hostile) },
    NEUTRAL: { name: cssHex(p.neutral), health: cssHex(p.local) },
  };
}

/**
 * Shared surfaces and colours for every indicator the renderer draws.
 *
 * One pad geometry, one pad material and one halo material for the two hostile-only pads on
 * every body, and one colour table for every label. All follow the palette: `paletteSerial`
 * moves when it changes, and an indicator that sees a serial other than the one it last
 * painted with redraws its canvas on its next update. The repaint is therefore lazy and
 * per-indicator, and nobody has to walk the roster; the pad and halo materials are shared, so
 * they are repainted once, in the palette callback.
 */
export interface ActorIndicatorAssets {
  readonly padGeometry: THREE.BufferGeometry;
  readonly padMaterial: THREE.MeshStandardMaterial;
  readonly haloMaterial: THREE.SpriteMaterial;
  readonly colours: Readonly<Record<TeamRelation, RelationColours>>;
  /** Bumped on every palette change. Compared, never interpreted. */
  readonly paletteSerial: number;
  dispose(): void;
}

export function buildActorIndicatorAssets(): ActorIndicatorAssets {
  const padGeometry = new RoundedBoxGeometry(PAD_LENGTH, PAD_WIDTH, PAD_THICKNESS, 2, PAD_CORNER);
  const padMaterial = new THREE.MeshStandardMaterial({
    emissiveIntensity: PAD_EMISSIVE_INTENSITY,
    roughness: 0.35,
    metalness: 0.1,
    toneMapped: false,
  });
  const haloTexture = buildHaloTexture();
  const haloMaterial = new THREE.SpriteMaterial({
    map: haloTexture,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: HALO_ALPHA,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });

  const assets = {
    padGeometry,
    padMaterial,
    haloMaterial,
    colours: relationColours(palette.current),
    paletteSerial: 0,
    dispose(): void {
      unsubscribe();
      padGeometry.dispose();
      padMaterial.dispose();
      haloMaterial.dispose();
      haloTexture.dispose();
    },
  };

  // Called once immediately, which is what paints the materials in the first place.
  const unsubscribe = palette.onChange((p) => {
    padMaterial.color.setHex(p.hostile);
    padMaterial.emissive.setHex(p.hostile);
    haloMaterial.color.setHex(p.hostile);
    assets.colours = relationColours(p);
    assets.paletteSerial++;
  });

  return assets;
}

/** A soft radial falloff, white on transparent; the sprite material tints it. */
function buildHaloTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = HALO_TEXTURE_SIZE;
  canvas.height = HALO_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable; cannot build the pad halo.');
  const half = HALO_TEXTURE_SIZE / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.45)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, HALO_TEXTURE_SIZE, HALO_TEXTURE_SIZE);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** One shoulder's pad and its halo, placed together on the avatar's frame. */
interface ShoulderPad {
  readonly frame: THREE.Group;
  readonly pad: THREE.Mesh;
  readonly halo: THREE.Sprite;
}

export interface ActorIndicatorState {
  readonly displayName: string;
  readonly healthFraction: number;
  readonly relation: TeamRelation;
  readonly participating: boolean;
}

/**
 * One actor's client-only IFF presentation: the nameplate over the head, and the two shoulder
 * pads on a hostile body.
 *
 * The avatar supplies animated semantic landmarks — a point for the head, a frame for each
 * shoulder — this object draws on them, and `BotRenderer` decides the viewer-relative relation
 * (`relationTo`, which is `isHostile` plus the neutral case no actor can be). None of those
 * layers needs to know the other's details.
 */
export class ActorIndicator {
  readonly group = new THREE.Group();

  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelContext: CanvasRenderingContext2D;
  private readonly labelTexture: THREE.CanvasTexture;
  private readonly labelMaterial: THREE.SpriteMaterial;
  private readonly label: THREE.Sprite;
  private readonly pads = new Map<ActorIndicatorFrameAnchor, ShoulderPad>();
  private readonly head = new THREE.Vector3();
  private readonly labelPosition = new THREE.Vector3();
  private readonly framePosition = new THREE.Vector3();
  private readonly frameQuaternion = new THREE.Quaternion();
  private readonly parentQuaternion = new THREE.Quaternion();
  private readonly localPosition = new THREE.Vector3();

  private shownHealth = 1;
  private paintedHealth = -1;
  private paintedName = '';
  private paintedRelation: TeamRelation | null = null;
  private paintedPaletteSerial = -1;
  private wasVisible = false;

  constructor(
    entityId: number,
    private readonly assets: ActorIndicatorAssets,
  ) {
    this.group.name = `actor-indicator:${entityId}`;

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = LABEL_WIDTH;
    this.labelCanvas.height = LABEL_HEIGHT;
    const context = this.labelCanvas.getContext('2d');
    if (context === null) throw new Error('2D canvas context unavailable; cannot build actor indicators.');
    this.labelContext = context;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.minFilter = THREE.LinearFilter;
    this.labelTexture.magFilter = THREE.LinearFilter;
    this.labelMaterial = new THREE.SpriteMaterial({
      map: this.labelTexture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.label = new THREE.Sprite(this.labelMaterial);
    this.label.name = 'actor-indicator:label';
    this.label.scale.set(LABEL_WORLD_WIDTH, LABEL_WORLD_HEIGHT, 1);
    this.label.layers.set(ACTOR_INDICATOR_LAYER);
    this.group.add(this.label);

    for (const anchor of MARKER_ANCHORS) {
      // The frame is the avatar's; the pad sits half its thickness out along +Z so its back
      // face is on the sleeve, and the halo sits on the surface behind it, billboarded.
      const frame = new THREE.Group();
      frame.name = `actor-indicator:${anchor}`;
      const pad = new THREE.Mesh(assets.padGeometry, assets.padMaterial);
      pad.name = 'pad';
      pad.position.z = PAD_THICKNESS * 0.5;
      pad.castShadow = false;
      pad.receiveShadow = false;
      pad.layers.set(ACTOR_INDICATOR_LAYER);
      const halo = new THREE.Sprite(assets.haloMaterial);
      halo.name = 'halo';
      halo.scale.set(HALO_RADIUS * 2, HALO_RADIUS * 2, 1);
      halo.layers.set(ACTOR_INDICATOR_LAYER);
      frame.add(halo, pad);
      this.pads.set(anchor, { frame, pad, halo });
      this.group.add(frame);
    }
  }

  /**
   * Reconcile position, visibility, relation colours, the pads, and the smoothly rendered HP
   * value. `camera` sizes the pads' screen-space floor; without one they stay at world size.
   */
  update(state: ActorIndicatorState, avatar: ActorAvatar, dt: number, camera?: THREE.PerspectiveCamera): void {
    if (!state.participating || !avatar.getIndicatorAnchor('head', this.head)) {
      this.group.visible = false;
      this.wasVisible = false;
      return;
    }

    this.group.visible = true;
    this.group.updateWorldMatrix(true, false);
    this.labelPosition.copy(this.head);
    this.labelPosition.y += LABEL_CLEARANCE;
    this.placeAtWorld(this.label, this.labelPosition);

    // Hostile bodies wear the pads; friendly ones rely on the plate.
    const hostile = state.relation === 'HOSTILE';
    this.group.getWorldQuaternion(this.parentQuaternion).invert();
    for (const anchor of MARKER_ANCHORS) {
      const shoulder = this.pads.get(anchor);
      if (shoulder === undefined) continue;
      if (!hostile || !avatar.getIndicatorFrame(anchor, this.framePosition, this.frameQuaternion)) {
        shoulder.frame.visible = false;
        continue;
      }
      this.placeAtWorld(shoulder.frame, this.framePosition);
      shoulder.frame.quaternion.copy(this.parentQuaternion).multiply(this.frameQuaternion);
      shoulder.frame.scale.setScalar(camera === undefined ? 1 : this.padFloorScale(camera));
      shoulder.frame.visible = true;
    }

    const name = normaliseName(state.displayName);
    const targetHealth = clamp01(state.healthFraction);
    if (!this.wasVisible) {
      this.shownHealth = targetHealth;
    } else {
      const safeDt = Math.max(0, Math.min(dt, 0.1));
      const blend = 1 - Math.exp(-HEALTH_SMOOTHING * safeDt);
      this.shownHealth += (targetHealth - this.shownHealth) * blend;
      if (Math.abs(targetHealth - this.shownHealth) < 1e-4) this.shownHealth = targetHealth;
    }
    this.wasVisible = true;

    if (
      name !== this.paintedName ||
      state.relation !== this.paintedRelation ||
      this.assets.paletteSerial !== this.paintedPaletteSerial ||
      Math.abs(this.shownHealth - this.paintedHealth) > 1e-3
    ) {
      this.drawLabel(name, state.relation, this.shownHealth);
      this.paintedName = name;
      this.paintedRelation = state.relation;
      this.paintedPaletteSerial = this.assets.paletteSerial;
      this.paintedHealth = this.shownHealth;
    }
  }

  dispose(): void {
    this.labelTexture.dispose();
    this.labelMaterial.dispose();
    this.group.clear();
    this.pads.clear();
  }

  /**
   * How much to grow a pad at `framePosition` so its long side covers `PAD_MIN_SCREEN_FRACTION`
   * of the frame height; 1 when it already does. A perspective camera's frame height at
   * distance d is `2 d tan(fov / 2)`, so the pad's fraction is `PAD_LENGTH / that`.
   */
  private padFloorScale(camera: THREE.PerspectiveCamera): number {
    const distance = this.framePosition.distanceTo(camera.position);
    const frameHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    if (frameHeight <= 0) return 1;
    return Math.max(1, (PAD_MIN_SCREEN_FRACTION * frameHeight) / PAD_LENGTH);
  }

  private placeAtWorld(node: THREE.Object3D, position: THREE.Vector3): void {
    this.localPosition.copy(position);
    this.group.worldToLocal(this.localPosition);
    node.position.copy(this.localPosition);
  }

  private drawLabel(name: string, relation: TeamRelation, health: number): void {
    const ctx = this.labelContext;
    const colours = this.assets.colours[relation];
    ctx.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);

    ctx.fillStyle = 'rgba(4, 7, 12, 0.82)';
    ctx.fillRect(8, 8, LABEL_WIDTH - 16, LABEL_HEIGHT - 16);
    ctx.strokeStyle = colours.name;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 3;
    ctx.strokeRect(9.5, 9.5, LABEL_WIDTH - 19, LABEL_HEIGHT - 19);
    ctx.globalAlpha = 1;

    const family = 'ui-sans-serif, system-ui, Segoe UI, Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colours.name;
    ctx.font = `800 38px ${family}`;
    ctx.fillText(name, LABEL_WIDTH * 0.5, 49, LABEL_WIDTH - 42);

    const barX = 52;
    const barY = 92;
    const barWidth = LABEL_WIDTH - barX * 2;
    const barHeight = 34;
    const innerX = barX + 3;
    const innerY = barY + 3;
    const innerWidth = barWidth - 6;
    const innerHeight = barHeight - 6;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillRect(barX, barY, barWidth, barHeight);
    ctx.fillStyle = colours.health;
    // Deliberately continuous: the four vertical lines below are only a quick-read grid.
    ctx.fillRect(innerX, innerY, innerWidth * clamp01(health), innerHeight);
    ctx.strokeStyle = 'rgba(232, 238, 248, 0.86)';
    ctx.lineWidth = 2;
    ctx.strokeRect(barX + 1, barY + 1, barWidth - 2, barHeight - 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.lineWidth = 3;
    for (let segment = 1; segment < 4; segment++) {
      const x = innerX + (innerWidth * segment) / 4;
      ctx.beginPath();
      ctx.moveTo(x, innerY);
      ctx.lineTo(x, innerY + innerHeight);
      ctx.stroke();
    }

    this.labelTexture.needsUpdate = true;
  }
}

function normaliseName(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? 'OPERATIVE' : trimmed.toUpperCase();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
