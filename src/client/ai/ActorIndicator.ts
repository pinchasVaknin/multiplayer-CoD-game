import * as THREE from 'three';
import type { TeamRelation } from '../../shared/ui/TeamColour';
import { ACTOR_INDICATOR_LAYER } from '../engine/Renderer';
import type { ActorAvatar, ActorIndicatorAnchor } from '../characters/ActorAvatar';
import { cssHex, palette, type GameplayPalette } from '../ui/Palette';

const MARKER_ANCHORS = [
  'leftUpperArm',
  'rightUpperArm',
  'leftKnee',
  'rightKnee',
] as const satisfies readonly ActorIndicatorAnchor[];

type MarkerAnchor = (typeof MARKER_ANCHORS)[number];

const LABEL_WIDTH = 512;
const LABEL_HEIGHT = 160;
const LABEL_WORLD_WIDTH = 1.28;
const LABEL_WORLD_HEIGHT = LABEL_WORLD_WIDTH * (LABEL_HEIGHT / LABEL_WIDTH);
const LABEL_CLEARANCE = 0.38;
const MARKER_SURFACE_OFFSET = 0.045;
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
 * One material for the four hostile-only points on every body, and one colour table for every
 * label. Both follow the palette: `paletteSerial` moves when it changes, and an indicator that
 * sees a serial other than the one it last painted with redraws its canvas on its next update.
 * The repaint is therefore lazy and per-indicator, and nobody has to walk the roster.
 */
export interface ActorIndicatorAssets {
  readonly markerGeometry: THREE.SphereGeometry;
  readonly markerMaterial: THREE.MeshStandardMaterial;
  readonly colours: Readonly<Record<TeamRelation, RelationColours>>;
  /** Bumped on every palette change. Compared, never interpreted. */
  readonly paletteSerial: number;
  dispose(): void;
}

export function buildActorIndicatorAssets(): ActorIndicatorAssets {
  const markerGeometry = new THREE.SphereGeometry(0.078, 10, 8);
  const markerMaterial = new THREE.MeshStandardMaterial({
    emissiveIntensity: 3.2,
    roughness: 0.28,
    metalness: 0.08,
    toneMapped: false,
  });

  const assets = {
    markerGeometry,
    markerMaterial,
    colours: relationColours(palette.current),
    paletteSerial: 0,
    dispose(): void {
      unsubscribe();
      markerGeometry.dispose();
      markerMaterial.dispose();
    },
  };

  // Called once immediately, which is what paints the material in the first place.
  const unsubscribe = palette.onChange((p) => {
    markerMaterial.color.setHex(p.hostile);
    markerMaterial.emissive.setHex(p.hostile);
    assets.colours = relationColours(p);
    assets.paletteSerial++;
  });

  return assets;
}

export interface ActorIndicatorState {
  readonly displayName: string;
  readonly healthFraction: number;
  readonly relation: TeamRelation;
  readonly participating: boolean;
}

/**
 * One actor's client-only IFF presentation.
 *
 * The avatar supplies animated semantic landmarks, this object draws them, and `BotRenderer`
 * decides the viewer-relative relation. None of those layers needs to know the other's details.
 */
export class ActorIndicator {
  readonly group = new THREE.Group();

  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelContext: CanvasRenderingContext2D;
  private readonly labelTexture: THREE.CanvasTexture;
  private readonly labelMaterial: THREE.SpriteMaterial;
  private readonly label: THREE.Sprite;
  private readonly markers = new Map<MarkerAnchor, THREE.Mesh>();
  private readonly head = new THREE.Vector3();
  private readonly markerPosition = new THREE.Vector3();
  private readonly outward = new THREE.Vector3();
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
      const marker = new THREE.Mesh(assets.markerGeometry, assets.markerMaterial);
      marker.name = `actor-indicator:${anchor}`;
      marker.castShadow = false;
      marker.receiveShadow = false;
      marker.layers.set(ACTOR_INDICATOR_LAYER);
      this.markers.set(anchor, marker);
      this.group.add(marker);
    }
  }

  /** Reconcile position, visibility, relation colours, and the smoothly rendered HP value. */
  update(state: ActorIndicatorState, avatar: ActorAvatar, dt: number): void {
    if (!state.participating || !avatar.getIndicatorAnchor('head', this.head)) {
      this.group.visible = false;
      this.wasVisible = false;
      return;
    }

    this.group.visible = true;
    this.group.updateWorldMatrix(true, false);
    this.markerPosition.copy(this.head);
    this.markerPosition.y += LABEL_CLEARANCE;
    this.placeAtWorld(this.label, this.markerPosition);

    const hostile = state.relation === 'HOSTILE';
    for (const anchor of MARKER_ANCHORS) {
      const marker = this.markers.get(anchor);
      if (marker === undefined) continue;
      if (!hostile || !avatar.getIndicatorAnchor(anchor, this.markerPosition)) {
        marker.visible = false;
        continue;
      }

      // The source landmark is at the skeleton/box centre. Nudge the emissive sphere away
      // from the body centre so it remains legible on the outside of a sleeve or knee pad.
      this.outward.set(this.markerPosition.x - this.head.x, 0, this.markerPosition.z - this.head.z);
      if (this.outward.lengthSq() > 1e-6) {
        this.outward.normalize().multiplyScalar(MARKER_SURFACE_OFFSET);
        this.markerPosition.add(this.outward);
      }
      this.placeAtWorld(marker, this.markerPosition);
      marker.visible = true;
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
    this.markers.clear();
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
