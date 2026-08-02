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
  /** Built on first use: most matches never call in a Chopper Gunner. */
  private thermalWorldMaterial: THREE.ShaderMaterial | null = null;
  private thermalHotMaterial: THREE.ShaderMaterial | null = null;

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
    // Raised from 1.05 in M5. ACES rolls the shoulder off hard, and at 1.05 the mid-tones
    // of a grey-box map — which is nearly all of it — were sitting in the part of the curve
    // where everything converges on the same dark grey. See the M4 playtest note.
    this.three.toneMappingExposure = 1.25;
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

  /**
   * The Chopper Gunner's thermal view (M7, brief S6.1).
   *
   * The brief asks for "a render pass, not a colour filter over the normal view", and the
   * difference is not pedantry — it decides what the picture can *say*. A filter tints an
   * already-lit image, so a body in shadow stays dark and the sky stays bright, which is the
   * opposite of what thermal optics show. A pass decides heat per object:
   *
   *  1. The world is drawn with an override material that ignores lighting entirely and ramps
   *     cold-to-warm on view depth, so the map reads as flat cool terrain.
   *  2. Depth is kept, and `hot` — the bot group — is drawn again with an unlit bright
   *     material, so bodies glow *through* an unlit room while still being occluded by walls.
   *
   * Nothing is post-processed and no render target is allocated, which is what keeps this
   * inside the frame budget on integrated graphics.
   */
  renderThermal(scene: THREE.Scene, camera: THREE.Camera, hot: THREE.Object3D | null): void {
    const previousOverride = scene.overrideMaterial;
    const previousBackground = scene.background;
    const previousFog = scene.fog;

    scene.overrideMaterial = this.thermalWorld();
    // Fog and a sky colour are lighting cues, and thermal has neither.
    scene.background = THERMAL_BACKGROUND;
    scene.fog = null;

    this.three.clear(true, true, false);
    this.three.render(scene, camera);

    scene.overrideMaterial = previousOverride;

    if (hot !== null) {
      scene.overrideMaterial = this.thermalHot();
      const wasVisible = new Map<THREE.Object3D, boolean>();
      // Only the hot group is drawn in the second pass; everything else is hidden rather
      // than re-rendered, so the depth buffer from pass one still occludes it.
      for (const child of scene.children) {
        wasVisible.set(child, child.visible);
        child.visible = child === hot;
      }
      this.three.render(scene, camera);
      for (const [child, visible] of wasVisible) child.visible = visible;
      scene.overrideMaterial = previousOverride;
    }

    scene.background = previousBackground;
    scene.fog = previousFog;
  }

  private thermalWorld(): THREE.Material {
    if (this.thermalWorldMaterial === null) {
      this.thermalWorldMaterial = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: THERMAL_VERT,
        fragmentShader: THERMAL_WORLD_FRAG,
        fog: false,
      });
    }
    return this.thermalWorldMaterial;
  }

  private thermalHot(): THREE.Material {
    if (this.thermalHotMaterial === null) {
      this.thermalHotMaterial = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: THERMAL_VERT,
        fragmentShader: THERMAL_HOT_FRAG,
        fog: false,
      });
    }
    return this.thermalHotMaterial;
  }

  /**
   * Clear to the background colour and draw nothing.
   *
   * `autoClear` is off (the two-pass draw controls its own clears), so without this the
   * canvas holds the last frame it rendered — which from M4 means the final frame of the
   * previous match sitting behind the main menu.
   */
  clear(): void {
    this.three.clear(true, true, false);
  }

  get info(): THREE.WebGLInfo {
    return this.three.info;
  }

  dispose(): void {
    this.thermalWorldMaterial?.dispose();
    this.thermalWorldMaterial = null;
    this.thermalHotMaterial?.dispose();
    this.thermalHotMaterial = null;
    this.three.dispose();
  }
}

/** Thermal has no sky. A flat mid-dark grey, so the horizon is not a black void. */
const THERMAL_BACKGROUND = new THREE.Color(0x121212);

/**
 * Shared vertex stage: view-space depth is the only thing either fragment stage needs.
 *
 * `viewDepth` is negated because view space looks down -Z, so this is a positive distance.
 */
const THERMAL_VERT = `
varying float vViewDepth;
varying vec3 vViewNormal;
void main() {
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -viewPosition.z;
  // View-space normal, so the grey pass can separate surfaces by facing without needing a
  // light in the scene. Thermal optics still resolve edges; a depth ramp alone cannot.
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewPosition;
}
`;

/**
 * The world, in grayscale.
 *
 * The first version ramped on **depth alone**, which meant every fragment at a similar
 * distance was the same colour and the map read as a black void with orange shapes floating
 * in it — reported from a live match. A thermal image is monochrome, not absent: it still
 * shows walls, floors and edges, it just shows them by temperature rather than by albedo.
 *
 * So the luminance comes from surface *facing* against a fixed view-space key, which is what
 * separates a wall from the floor it meets, and depth only darkens gently on top. The result
 * is a readable grey map that never uses colour, leaving orange exclusively for bodies.
 */
const THERMAL_WORLD_FRAG = `
varying float vViewDepth;
varying vec3 vViewNormal;
void main() {
  vec3 n = normalize(vViewNormal);
  float lambert = clamp(dot(n, normalize(vec3(0.35, 0.78, 0.52))), 0.0, 1.0);
  // Never reaches black: distant geometry has to stay legible or the gun cannot be aimed.
  float depthFade = 1.0 - 0.42 * clamp(vViewDepth / 130.0, 0.0, 1.0);
  float lum = (0.16 + 0.60 * lambert) * depthFade;
  gl_FragColor = vec4(vec3(lum), 1.0);
}
`;

/**
 * Bodies: flat, hot orange.
 *
 * Unlit and unshaded on purpose — a body is a heat *source*, not a lit surface, and shading it
 * would make a contact in shadow read as colder than one in the open, which is the opposite of
 * what thermal shows. It brightens slightly with distance so a far contact still separates
 * from the grey behind it.
 */
const THERMAL_HOT_FRAG = `
varying float vViewDepth;
varying vec3 vViewNormal;
void main() {
  float t = clamp(vViewDepth / 110.0, 0.0, 1.0);
  vec3 near = vec3(1.0, 0.45, 0.06);
  vec3 far = vec3(1.0, 0.68, 0.24);
  gl_FragColor = vec4(mix(near, far, t), 1.0);
}
`;
