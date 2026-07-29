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
 */
export class ViewmodelLayer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Lights the viewmodel independently of the world, as an FPS viewmodel should be. */
  private readonly key = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly fill = new THREE.HemisphereLight(0x9fb0c8, 0x22252b, 1.1);

  constructor(cfg: CameraConfig) {
    this.camera = new THREE.PerspectiveCamera(cfg.viewmodelFov, 1, 0.008, 6);
    this.key.position.set(-0.6, 1.2, 0.9);
    this.scene.add(this.key);
    this.scene.add(this.fill);
  }

  /** True when there is anything worth drawing. Lights alone do not count. */
  get hasContent(): boolean {
    return this.scene.children.length > 2;
  }

  /** M2 attaches weapon meshes here. */
  add(object: THREE.Object3D): void {
    this.scene.add(object);
  }

  remove(object: THREE.Object3D): void {
    this.scene.remove(object);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setFov(fovDeg: number): void {
    if (this.camera.fov === fovDeg) return;
    this.camera.fov = fovDeg;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.scene.clear();
  }
}
