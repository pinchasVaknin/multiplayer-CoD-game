import * as THREE from 'three';
import { makeChopperView, type ChopperGunner } from '../../shared/streaks/ChopperGunner';

/**
 * The camera a Chopper Gunner takeover renders through (M9).
 *
 * The streak used to own a `THREE.PerspectiveCamera` and write its position, rotation and
 * projection directly. It now reports a pose and a field of view — `ChopperView` — and this
 * class maintains the camera from it.
 *
 * The projection is only rebuilt when the lens actually changed, exactly as before:
 * `updateProjectionMatrix` is not free and must not run on a frame where nothing moved.
 */
export class ChopperCamera {
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.5, 400);
  private readonly view = makeChopperView();

  /**
   * The camera to render this frame, or null when no takeover owns the view.
   *
   * `Game` asks once per frame and does not care which streak answered — the same shape the
   * takeover has had since M7, so nothing about "one thing puts the camera back" changed.
   */
  cameraFor(chopper: ChopperGunner | null, aspect: number): THREE.PerspectiveCamera | null {
    if (chopper === null) return null;
    if (!chopper.activeView(this.view)) return null;

    const v = this.view;
    if (this.camera.aspect !== aspect || Math.abs(this.camera.fov - v.fov) > 1e-3) {
      this.camera.aspect = aspect;
      this.camera.fov = v.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(v.x, v.y, v.z);
    this.camera.rotation.set(v.pitch, v.yaw, 0, 'YXZ');
    return this.camera;
  }
}
