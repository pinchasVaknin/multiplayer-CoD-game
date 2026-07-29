import * as THREE from 'three';
import type { ViewmodelLayer } from '../player/Viewmodel';

/**
 * Renderer ownership: size, colour management, shadows, and the two-pass draw
 * (world, then viewmodel over a cleared depth buffer).
 *
 * Target is 60 FPS in Chrome on integrated graphics, so the defaults lean cheap:
 * pixel ratio is capped, shadows are a single 2048 PCF-soft cascade, and there is no
 * post-processing stack. Antialiasing is MSAA on the default framebuffer, which
 * integrated parts do in hardware for close to free.
 */
export class Renderer {
  readonly three: THREE.WebGLRenderer;
  private widthPx = 1;
  private heightPx = 1;
  private ratio = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.three.autoClear = false;
    this.three.setClearColor(0x0c0e11, 1);
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1.05;
    this.three.shadowMap.enabled = true;
    // PCFSoftShadowMap was deprecated in three r185 and silently falls back to
    // PCFShadowMap with a console warning. Ask for what we actually get; softness
    // comes from the map size and the light's shadow radius instead.
    this.three.shadowMap.type = THREE.PCFShadowMap;
  }

  /** `scale` is the user's render-scale setting; device pixel ratio is capped at 2. */
  setSize(width: number, height: number, scale: number): void {
    this.widthPx = Math.max(1, Math.floor(width));
    this.heightPx = Math.max(1, Math.floor(height));
    this.ratio = Math.min(2, Math.max(0.5, window.devicePixelRatio * scale));
    this.three.setPixelRatio(this.ratio);
    this.three.setSize(this.widthPx, this.heightPx, false);
  }

  get aspect(): number {
    return this.widthPx / this.heightPx;
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, viewmodel: ViewmodelLayer | null): void {
    this.three.clear(true, true, false);
    this.three.render(scene, camera);
    if (viewmodel !== null && viewmodel.hasContent) {
      // Fresh depth so the viewmodel can never intersect world geometry.
      this.three.clearDepth();
      this.three.render(viewmodel.scene, viewmodel.camera);
    }
  }

  get info(): THREE.WebGLInfo {
    return this.three.info;
  }

  dispose(): void {
    this.three.dispose();
  }
}
