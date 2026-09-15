import * as THREE from 'three';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';
import type { ActorAvatar, HeldWeaponAsset } from '../characters/ActorAvatar';
import type { CharacterAvatarProvider } from '../characters/CharacterAvatarProvider';
import { characterDefinition, type CharacterId } from '../characters/CharacterCatalog';
import type { CharacterAssetService } from '../characters/CharacterAssetService';
import { buildHeldWeapon, heldWeaponMaterial } from '../weapons/WeaponMesh';

/**
 * The stage (M15, B1): the player's skin on a lit disc, holding the class's primary, turning.
 *
 * ## The same body, the same hands, the same call
 *
 * The figure is an `ActorAvatar` from `CharacterAssetService.avatarProvider(def).create()` —
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

/** Design-frame pixels; the backing store is sized from the on-screen rect. */
export const STAGE_WIDTH = 860;
export const STAGE_HEIGHT = 800;

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

export class CharacterStage {
  readonly canvas: HTMLCanvasElement;

  private readonly deps: CharacterStageDeps;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, STAGE_WIDTH / STAGE_HEIGHT, 0.1, 30);
  private readonly turntable = new THREE.Group();
  private readonly disc: THREE.Group;

  private renderer: THREE.WebGLRenderer | null = null;
  private provider: CharacterAvatarProvider | null = null;
  private avatar: ActorAvatar | null = null;
  private characterId: CharacterId | null = null;
  private weapon: HeldWeaponAsset | null = null;
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

  constructor(deps: CharacterStageDeps) {
    this.deps = deps;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lo-stage__canvas';
    this.canvas.width = STAGE_WIDTH;
    this.canvas.height = STAGE_HEIGHT;
    this.canvas.setAttribute('aria-label', 'Your operator, turning. Drag to turn it yourself.');

    // A key from the front-left and above, a cool rim from behind, and a soft fill: the shop
    // lighting `WeaponPreview` settled on, scaled up for a body.
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-2.2, 4.0, 3.0);
    const rim = new THREE.DirectionalLight(0x9ec4ff, 1.6);
    rim.position.set(2.5, 2.5, -3.5);
    const fill = new THREE.HemisphereLight(0x9fb0c8, 0x22252b, 1.1);
    this.scene.add(key, key.target, rim, rim.target, fill);

    this.disc = buildDisc();
    this.turntable.add(this.disc);
    this.scene.add(this.turntable);

    // Chest height, a little in front of the eye line, looking at the sternum: the full body
    // fills the frame with the disc under its feet and air over its head.
    this.camera.position.set(0, 1.35, 4.4);
    this.camera.lookAt(0, 0.95, 0);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragLastX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const scale = this.canvas.getBoundingClientRect().width / STAGE_WIDTH || 1;
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

  /** Whether a body is on the disc. */
  get ready(): boolean {
    return this.avatar !== null;
  }

  /** Put this skin on the disc. Idempotent for the skin already there or already asked for. */
  show(characterId: CharacterId): void {
    if (characterId === this.characterId) return;
    this.characterId = characterId;
    this.dropAvatar();
    this.provider?.dispose();
    this.provider = this.deps.characterAssets.avatarProvider(characterDefinition(characterId));
  }

  /** The weapon in its hands. Null empties them. */
  setWeapon(weaponId: string | null): void {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    this.weapon = weaponId === null ? null : this.heldWeapon(weaponId);
    this.avatar?.setWeapon(this.weapon);
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
  }

  /** The canvas as a PNG data URL, read right after a `tick` in the same task — the buffer is not preserved past it. */
  snapshot(): string {
    return this.canvas.toDataURL('image/png');
  }

  /**
   * One frame: adopt the body if it has arrived, turn, animate, draw.
   *
   * Driven from `Game.draw` through the editor, so it stops with the frame loop.
   */
  tick(dt: number): void {
    if (this.avatar === null && this.provider !== null && this.provider.isReady) {
      const made = this.provider.create();
      if (made !== null) {
        this.avatar = made;
        made.setWeapon(this.weapon);
        this.turntable.add(made.group);
      }
    }

    if (this.dragging || this.held) {
      // The hand is on it, or a script is: no idle turn, no easing.
    } else {
      this.target += IDLE_TURN * dt;
      this.angle += (this.target - this.angle) * Math.min(1, SETTLE * dt);
    }
    this.turntable.rotation.y = this.angle;

    // The body's own yaw stays 0 — the turntable carries it — and its position is the disc's
    // centre, so `update`'s planar speed reads 0 and the selector answers with the idle.
    this.avatar?.update(STANDING_ARMED, 0, 0, 0, 0, 1, dt);

    const renderer = this.ensureRenderer();
    this.fitBackingStore(renderer);
    renderer.render(this.scene, this.camera);
  }

  /** Take the body off the disc and forget the skin; the next `show` loads afresh. */
  release(): void {
    this.dropAvatar();
    this.provider?.dispose();
    this.provider = null;
    this.characterId = null;
  }

  dispose(): void {
    this.release();
    for (const asset of this.weapons.values()) asset.geometry.dispose();
    this.weapons.clear();
    disposeDisc(this.disc);
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas.remove();
  }

  // -- internals -------------------------------------------------------------

  private dropAvatar(): void {
    const avatar = this.avatar;
    if (avatar === null) return;
    this.turntable.remove(avatar.group);
    avatar.dispose();
    this.avatar = null;
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

/**
 * The lit disc: a low cylinder in a dark surface with an emissive ring at its edge — the
 * reference's platform, built from two primitives and no texture.
 */
function buildDisc(): THREE.Group {
  const group = new THREE.Group();
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(1.05, 1.15, 0.12, 64),
    new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.65, metalness: 0.2 }),
  );
  plinth.position.y = -0.06;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.018, 12, 96),
    new THREE.MeshBasicMaterial({ color: 0xffb340, toneMapped: false }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.002;
  group.add(plinth, ring);
  return group;
}

function disposeDisc(disc: THREE.Group): void {
  disc.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry !== undefined) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | undefined;
    if (material !== undefined && typeof material.dispose === 'function') material.dispose();
  });
}
