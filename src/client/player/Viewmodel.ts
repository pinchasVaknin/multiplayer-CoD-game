import * as THREE from 'three';
import type { CameraConfig } from './CameraConfig';

/**
 * The viewmodel layer.
 *
 * M1 has no weapon to draw, but the *plumbing* has to be right now (brief S5.4): a
 * viewmodel needs its own FOV and its own depth range so a gun near the camera never
 * intersects world geometry, and retrofitting that after M2 has built animations
 * against the world camera is exactly the kind of rewrite this milestone is meant to
 * prevent.
 *
 * The scene is real and is rendered as a second pass over a cleared depth buffer.
 * While it is empty the pass is skipped entirely, so it costs nothing today.
 *
 * M2 note: the weapon and its lights hang off the *camera*, not off the scene root, so
 * everything M2's animation writes is a camera-relative transform and the viewmodel's
 * lighting does not swing around as the player walks. The camera is therefore a child of
 * the scene — Three only traverses the scene graph, so a camera outside it would render
 * nothing attached to it.
 */
export class ViewmodelLayer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Everything drawable, parented to the camera. */
  private readonly root = new THREE.Group();

  /** Lights the viewmodel independently of the world, as an FPS viewmodel should be. */
  private readonly key = new THREE.DirectionalLight(0xffffff, 2.6);
  private readonly fill = new THREE.HemisphereLight(0x9fb0c8, 0x22252b, 1.35);
  /** A cool rim from behind-left keeps the silhouette off the world behind it. */
  private readonly rim = new THREE.DirectionalLight(0x9ec4ff, 1.1);

  constructor(cfg: CameraConfig) {
    this.camera = new THREE.PerspectiveCamera(cfg.viewmodelFov, 1, 0.008, 6);
    // Both lights aim at where the weapon actually sits (down and forward of the
    // camera), not at the camera origin. A light placed at +Z is *behind* the gun, which
    // is the easy way to end up with a correctly built viewmodel that renders as a
    // silhouette. Key from above-left-front; rim from beyond it, throwing an edge back.
    this.key.position.set(-0.55, 0.85, 0.35);
    this.key.target.position.set(0.15, -0.16, -0.45);
    this.rim.position.set(0.95, 0.2, -1.5);
    this.rim.target.position.set(0.15, -0.14, -0.35);
    this.camera.add(this.key);
    this.camera.add(this.key.target);
    this.camera.add(this.rim);
    this.camera.add(this.rim.target);
    this.camera.add(this.fill);
    this.camera.add(this.root);
    this.scene.add(this.camera);
  }

  /** True when there is anything worth drawing. Lights alone do not count. */
  get hasContent(): boolean {
    return this.root.children.length > 0;
  }

  /** M2 attaches weapon meshes here. */
  add(object: THREE.Object3D): void {
    this.root.add(object);
  }

  remove(object: THREE.Object3D): void {
    this.root.remove(object);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setFov(fovDeg: number): void {
    if (Math.abs(this.camera.fov - fovDeg) < 0.01) return;
    this.camera.fov = fovDeg;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.root.clear();
    this.scene.clear();
  }
}
