import * as THREE from 'three';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';
import type { ActorAvatar, HeldWeaponAsset } from '../characters/ActorAvatar';
import type { CharacterAvatarProvider } from '../characters/CharacterAvatarProvider';
import { characterDefinition, type CharacterId } from '../characters/CharacterCatalog';
import type { CharacterAssetService } from '../characters/CharacterAssetService';
import { buildHeldWeapon, heldWeaponMaterial } from '../weapons/WeaponMesh';

/**
 * The stage (M15, B1): the player's skin on a lit disc, holding the class's primary, turning.
 * And (M15, D1) the same stage with a lineup on it — the winning team on a platform after a
 * match, each in the body the match dealt them.
 *
 * ## The same body, the same hands, the same call
 *
 * A figure is an `ActorAvatar` from `CharacterAssetService.avatarProvider(def).create()` —
 * the exact object `BotRenderer` makes for a body in a match — driven by `update` with a
 * standing, armed, idle `ActorAnimationInput`, which the selector answers with
 * `idleWeaponReady`. The weapon in its hands is `buildHeldWeapon` with the shared gunmetal,
 * the same asset a bot carries. So the operator on this screen is the operator other players
 * see, by construction rather than by a second model kept in step with the first.
 *
 * What it does not show is the camo. A held weapon is one mesh in one shared material, which
 * is right at the distance a body is seen; the finish is the viewmodel's business, and the
 * editor's SKIN tab shows it on the `WeaponPreview` that already knows how.
 *
 * ## One class, one figure or five
 *
 * The editor's stage is one body on a disc that turns; the summary's is up to five on a
 * platform that does not. They are the same lights, the same lens, the same loading rule and
 * the same disposal, so they are one class with a list of figures rather than two classes
 * kept in step: `show` is the one-figure API the editor and the thumbnail script use, and
 * `showLineup` is the same list with more than one entry. `StageOptions` names what differs —
 * the canvas, the camera, the platform under the feet, and whether it turns.
 *
 * ## Its own renderer, on the first tick
 *
 * As `WeaponPreview` does: its own scene, camera and `WebGLRenderer` on its own canvas, built
 * the first time `tick` runs and disposed with the screen — the main renderer is drawing the
 * menu's backdrop under this screen and a second context costs less than a second render
 * target and a viewport dance. The canvas's backing store follows its on-screen size, so a
 * frame at 0.58 does not rasterise 860×800 to show 500×464.
 *
 * ## Loading is a state, not a wait
 *
 * A skin arrives when it arrives (B0 made the wait a fraction of a second on a warm cache;
 * `echo` is preloaded at boot). Until the provider is ready the disc stands empty and the
 * caller's label says so; `create()` is asked once per tick and succeeds exactly once. A
 * skin that fails to load leaves the disc empty for good and logs where the service logs.
 */

export interface CharacterStageDeps {
  readonly characterAssets: CharacterAssetService;
  readonly anisotropy: () => number;
}

/** What one stage differs from another in. The editor's is the default; the summary's is `LINEUP_STAGE`. */
export interface StageOptions {
  /** Design-frame pixels; the backing store is sized from the on-screen rect. */
  readonly width: number;
  readonly height: number;
  readonly canvasClass: string;
  readonly ariaLabel: string;
  /** The lens: height, distance along +Z, and the height it looks at on the axis. */
  readonly camera: { readonly y: number; readonly z: number; readonly lookY: number };
  /** B1's disc and ring under one body, or a platform this wide and deep under a lineup. */
  readonly platform: 'disc' | { readonly width: number; readonly depth: number };
  /** Whether the stage turns on its own, can be dragged and nudged. A lineup stands still. */
  readonly turntable: boolean;
}

/** One body on the stage: which skin, what it holds, and where it stands. */
export interface StageFigure {
  readonly characterId: CharacterId;
  readonly weaponId: string | null;
  /** Metres from the stage's centre; +Z is toward the camera. */
  readonly x: number;
  readonly z: number;
  /** Radians. A body at yaw 0 faces −Z, away from the camera; π faces it. */
  readonly yaw: number;
}

/** Design-frame pixels of the editor's stage; the backing store is sized from the on-screen rect. */
export const STAGE_WIDTH = 860;
export const STAGE_HEIGHT = 800;

/**
 * The editor's stage (B1). Chest height, a little in front of the eye line, looking at the
 * sternum: the full body fills the frame with the disc under its feet and air over its head.
 */
export const EDITOR_STAGE: StageOptions = {
  width: STAGE_WIDTH,
  height: STAGE_HEIGHT,
  canvasClass: 'lo-stage__canvas',
  ariaLabel: 'Your operator, turning. Drag to turn it yourself.',
  camera: { y: 1.35, z: 4.4, lookY: 0.95 },
  platform: 'disc',
  turntable: true,
};

/**
 * The summary's stage (D1): five bodies across on a platform, the lens back far enough that
 * the whole line fits with the platform under it, and no turntable — a lineup that swung its
 * ends out of frame would be a lineup of three.
 */
export const LINEUP_STAGE: StageOptions = {
  width: 1824,
  height: 560,
  canvasClass: 'eom-stage__canvas',
  ariaLabel: 'The winning team, on the platform.',
  // 5.3 m back: five bodies at 1.25 m spacing fill two fifths of the height with the platform's
  // front edge in frame; 6.2 left them a quarter of it (measured in the pane, D1).
  camera: { y: 1.45, z: 5.3, lookY: 0.98 },
  platform: { width: 6.8, depth: 2.6 },
  turntable: false,
};

/** Radians per second when nobody is holding it. */
const IDLE_TURN = 0.1;
/** How fast a nudge or a drag settles. Per second of the remaining angle. */
const SETTLE = 6;
/** One arrow press, in radians. */
const NUDGE = Math.PI / 4;
/** Radians of turn per pixel of drag, in frame pixels. */
const DRAG_RADIANS_PER_PX = 0.008;

const STANDING_ARMED: ActorAnimationInput = {
  stance: 'STAND',
  aiming: true,
  sprinting: false,
  reloading: false,
  reloadSeconds: 0,
  firing: false,
};

interface Slot {
  readonly figure: StageFigure;
  readonly provider: CharacterAvatarProvider;
  weapon: HeldWeaponAsset | null;
  avatar: ActorAvatar | null;
}

export class CharacterStage {
  readonly canvas: HTMLCanvasElement;

  private readonly deps: CharacterStageDeps;
  private readonly options: StageOptions;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly turntable = new THREE.Group();
  private readonly platform: THREE.Group;

  private renderer: THREE.WebGLRenderer | null = null;
  private slots: Slot[] = [];
  /** The one-figure API's weapon, so `setWeapon` before or after `show` means the same thing. */
  private weaponId: string | null = null;
  private readonly weapons = new Map<string, HeldWeaponAsset>();

  /**
   * Where the turntable is and where it is going. Starts at a half turn: a body at yaw 0 faces
   * -Z, the camera stands on +Z, and a stage that opens on the operator's back is a stage
   * that opens wrong.
   */
  private angle = Math.PI;
  private target = Math.PI;
  private dragging = false;
  private dragLastX = 0;
  /** A held pose: no idle turn, no easing. The thumbnail renderer's, and nothing else's. */
  private held = false;
  private lastSeenWidth = 0;
  private lastSeenHeight = 0;
  private readonly projected = new THREE.Vector3();

  constructor(deps: CharacterStageDeps, options: StageOptions = EDITOR_STAGE) {
    this.deps = deps;
    this.options = options;

    this.canvas = document.createElement('canvas');
    this.canvas.className = options.canvasClass;
    this.canvas.width = options.width;
    this.canvas.height = options.height;
    this.canvas.setAttribute('aria-label', options.ariaLabel);

    // A key from the front-left and above, a cool rim from behind, and a soft fill: the shop
    // lighting `WeaponPreview` settled on, scaled up for a body.
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-2.2, 4.0, 3.0);
    const rim = new THREE.DirectionalLight(0x9ec4ff, 1.6);
    rim.position.set(2.5, 2.5, -3.5);
    const fill = new THREE.HemisphereLight(0x9fb0c8, 0x22252b, 1.1);
    this.scene.add(key, key.target, rim, rim.target, fill);

    this.platform = options.platform === 'disc' ? buildDisc() : buildPlatform(options.platform.width, options.platform.depth);
    this.turntable.add(this.platform);
    this.scene.add(this.turntable);

    this.camera = new THREE.PerspectiveCamera(30, options.width / options.height, 0.1, 30);
    this.camera.position.set(0, options.camera.y, options.camera.z);
    this.camera.lookAt(0, options.camera.lookY, 0);
    this.camera.updateMatrixWorld();

    if (!options.turntable) {
      // Still, facing the lens: the figures carry their own yaw.
      this.angle = 0;
      this.target = 0;
      this.turntable.rotation.y = 0;
      return;
    }

    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragLastX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const scale = this.canvas.getBoundingClientRect().width / options.width || 1;
      const dx = (e.clientX - this.dragLastX) / scale;
      this.dragLastX = e.clientX;
      this.target += dx * DRAG_RADIANS_PER_PX;
      this.angle = this.target;
    });
    const release = (): void => {
      this.dragging = false;
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
  }

  /** Whether every figure asked for is on the stage. False while any is still loading, and with none asked for. */
  get ready(): boolean {
    return this.slots.length > 0 && this.slots.every((s) => s.avatar !== null);
  }

  /** Put this skin on the disc, alone. Idempotent for the skin already there or already asked for. */
  show(characterId: CharacterId): void {
    const only = this.slots.length === 1 ? this.slots[0] : undefined;
    if (only !== undefined && only.figure.characterId === characterId) return;
    this.showLineup([{ characterId, weaponId: this.weaponId, x: 0, z: 0, yaw: 0 }]);
  }

  /** The weapon in the one figure's hands. Null empties them. */
  setWeapon(weaponId: string | null): void {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    const only = this.slots.length === 1 ? this.slots[0] : undefined;
    if (only === undefined) return;
    only.weapon = weaponId === null ? null : this.heldWeapon(weaponId);
    only.avatar?.setWeapon(only.weapon);
  }

  /**
   * Put these figures on the stage, replacing whatever was there (D1). Each loads through
   * its own provider — a skin the match already drew is a warm cache, a skin it did not is a
   * fetch — and stands where the figure says, holding what it says, as soon as it arrives.
   */
  showLineup(figures: readonly StageFigure[]): void {
    this.dropAll();
    this.slots = figures.map((figure) => ({
      figure,
      provider: this.deps.characterAssets.avatarProvider(characterDefinition(figure.characterId)),
      weapon: figure.weaponId === null ? null : this.heldWeapon(figure.weaponId),
      avatar: null,
    }));
  }

  /**
   * Where a point on the stage lands on the canvas, as fractions of its width and height from
   * the top left — for a nameplate under a figure's feet. Pure lens arithmetic: it needs no
   * renderer and no tick, so it answers on a page that never draws.
   */
  projectToCanvas(x: number, y: number, z: number): { readonly u: number; readonly v: number } {
    const point = this.projected.set(x, y, z);
    point.applyAxisAngle(UP, this.angle);
    point.project(this.camera);
    return { u: (point.x + 1) / 2, v: (1 - point.y) / 2 };
  }

  /** One arrow press: an eighth of a turn, eased. */
  nudge(direction: -1 | 1): void {
    this.target += NUDGE * direction;
  }

  /**
   * Hold the turntable at an angle and stop it turning (M15, B5: `scripts/skin-thumbs.mjs`
   * renders every skin at one pose so the strip's thumbnails match). Radians, 0 facing -Z.
   */
  hold(angle: number, distance = 4.4): void {
    this.held = true;
    this.angle = angle;
    this.target = angle;
    // Closer for a portrait: the stage's own distance leaves a 320×400 thumbnail half air.
    this.camera.position.set(0, 1.35 - (4.4 - distance) * 0.09, distance);
    this.camera.lookAt(0, 0.95, 0);
    this.camera.updateMatrixWorld();
  }

  /** The canvas as a PNG data URL, read right after a `tick` in the same task — the buffer is not preserved past it. */
  snapshot(): string {
    return this.canvas.toDataURL('image/png');
  }

  /**
   * One frame: adopt the bodies that have arrived, turn, animate, draw.
   *
   * Driven from `Game.draw` through the screen, so it stops with the frame loop.
   */
  tick(dt: number): void {
    for (const slot of this.slots) {
      if (slot.avatar !== null || !slot.provider.isReady) continue;
      const made = slot.provider.create();
      if (made === null) continue;
      slot.avatar = made;
      made.setWeapon(slot.weapon);
      this.turntable.add(made.group);
    }

    if (this.dragging || this.held || !this.options.turntable) {
      // The hand is on it, a script is, or it does not turn: no idle turn, no easing.
    } else {
      this.target += IDLE_TURN * dt;
      this.angle += (this.target - this.angle) * Math.min(1, SETTLE * dt);
    }
    this.turntable.rotation.y = this.angle;

    // A body's own yaw is the figure's — 0 on the editor's stage, where the turntable carries
    // it — and its position is where the figure stands, so `update`'s planar speed reads 0
    // and the selector answers with the idle.
    for (const slot of this.slots) {
      const f = slot.figure;
      slot.avatar?.update(STANDING_ARMED, f.x, 0, f.z, f.yaw, 1, dt);
    }

    const renderer = this.ensureRenderer();
    this.fitBackingStore(renderer);
    renderer.render(this.scene, this.camera);
  }

  /** Take every body off the stage and forget the skins; the next `show` loads afresh. */
  release(): void {
    this.dropAll();
  }

  dispose(): void {
    this.release();
    for (const asset of this.weapons.values()) asset.geometry.dispose();
    this.weapons.clear();
    disposePlatform(this.platform);
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas.remove();
  }

  // -- internals -------------------------------------------------------------

  private dropAll(): void {
    for (const slot of this.slots) {
      const avatar = slot.avatar;
      if (avatar !== null) {
        this.turntable.remove(avatar.group);
        avatar.dispose();
      }
      slot.provider.dispose();
    }
    this.slots = [];
  }

  /** The held weapon for an id, built once and kept — `BotRenderer.heldWeapon`'s shape. */
  private heldWeapon(weaponId: string): HeldWeaponAsset {
    const existing = this.weapons.get(weaponId);
    if (existing !== undefined) return existing;
    const built = buildHeldWeapon(weaponId);
    const asset: HeldWeaponAsset = {
      weaponId,
      geometry: built.geometry,
      material: heldWeaponMaterial(this.deps.anisotropy()),
      gripAnchor: built.gripAnchor,
      supportAnchor: built.supportAnchor,
    };
    this.weapons.set(weaponId, asset);
    return asset;
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    const existing = this.renderer;
    if (existing !== null) return existing;
    const made = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    // The same colour pipeline as `Renderer`, or the skin here is a different colour from the
    // skin in the match. Exposure included: ACES without it is a different curve.
    made.outputColorSpace = THREE.SRGBColorSpace;
    made.toneMapping = THREE.ACESFilmicToneMapping;
    made.toneMappingExposure = 1.25;
    this.renderer = made;
    return made;
  }

  /**
   * Size the backing store to what is on screen: the canvas's CSS box is in frame pixels
   * and the frame is zoomed, so the rect is the truth and the attribute is not.
   */
  private fitBackingStore(renderer: THREE.WebGLRenderer): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (width === this.lastSeenWidth && height === this.lastSeenHeight) return;
    this.lastSeenWidth = width;
    this.lastSeenHeight = height;
    // `false`: the CSS size is the stylesheet's, not the renderer's to set.
    renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

const PLINTH_MATERIAL = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.65, metalness: 0.2 });
const ACCENT_MATERIAL = (): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: 0xffb340, toneMapped: false });

/**
 * The lit disc: a low cylinder in a dark surface with an emissive ring at its edge — the
 * reference's platform, built from two primitives and no texture.
 */
function buildDisc(): THREE.Group {
  const group = new THREE.Group();
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.15, 0.12, 64), PLINTH_MATERIAL());
  plinth.position.y = -0.06;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.018, 12, 96), ACCENT_MATERIAL());
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.002;
  group.add(plinth, ring);
  return group;
}

/**
 * The lineup's platform (D1): the disc's plinth stretched to a slab, with the accent as a
 * frame around its top edge — four thin bars in the ring's material, so the two stages read
 * as the same furniture.
 */
function buildPlatform(width: number, depth: number): THREE.Group {
  const group = new THREE.Group();
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(width, 0.12, depth), PLINTH_MATERIAL());
  plinth.position.y = -0.06;
  group.add(plinth);
  const bar = 0.036;
  const accent = ACCENT_MATERIAL();
  const along = new THREE.BoxGeometry(width, bar, bar);
  const across = new THREE.BoxGeometry(bar, bar, depth);
  for (const sign of [-1, 1]) {
    const front = new THREE.Mesh(along, accent);
    front.position.set(0, 0.002, (sign * (depth - bar)) / 2);
    const side = new THREE.Mesh(across, accent);
    side.position.set((sign * (width - bar)) / 2, 0.002, 0);
    group.add(front, side);
  }
  return group;
}

function disposePlatform(platform: THREE.Group): void {
  const seen = new Set<object>();
  platform.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry !== undefined && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const material = mesh.material as THREE.Material | undefined;
    if (material !== undefined && typeof material.dispose === 'function' && !seen.has(material)) {
      seen.add(material);
      material.dispose();
    }
  });
}
