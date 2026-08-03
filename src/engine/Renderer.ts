import * as THREE from 'three';
import type { ShadowQuality } from '../meta/SaveData';
import { MotionBlur } from './MotionBlur';
import type { ViewmodelLayer } from '../player/Viewmodel';

/**
 * What each shadow tier costs and buys (M8, brief S6.3).
 *
 * `size` is the shadow map edge in texels and is the whole cost: 4096 is four times the
 * fill of 2048 and sixteen times 1024, and on integrated graphics the depth pass is a real
 * fraction of the frame. `radiusScale` multiplies whatever softness the *map* asked for
 * (`LightDef.shadowRadius`), so a tier change never overrides a map's art direction — Dunes
 * stays harder-edged than Foundry at every quality level, it is simply blurrier or sharper
 * in proportion.
 *
 * `off` disables the shadow map outright rather than shrinking it to nothing. A 256-texel
 * shadow is worse than no shadow: it is a rectangle of noise under everything.
 */
export const SHADOW_TIERS: Readonly<Record<ShadowQuality, { size: number; radiusScale: number }>> = {
  off: { size: 0, radiusScale: 0 },
  low: { size: 1024, radiusScale: 0.6 },
  medium: { size: 2048, radiusScale: 1 },
  high: { size: 4096, radiusScale: 1.6 },
};

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
  /** Post-M8: the gunner's own side, drawn near-black. See `renderGunship`. */
  private thermalColdMaterial: THREE.ShaderMaterial | null = null;
  /** M8. The live shadow tier; lights read it when a map is loaded and when it changes. */
  private shadowTier: ShadowQuality = 'medium';
  /** M8. Null unless the player has asked for motion blur. */
  private blur: MotionBlur | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      /**
       * Round 2: `stencil: false` -> true, and it is a *depth* decision.
       *
       * Nothing here draws a stencil. The reason to ask for one is that the pair is what
       * drivers actually allocate: a context asking for depth-without-stencil is free to hand
       * back `DEPTH_COMPONENT16`, and several do, where depth-plus-stencil is
       * `DEPTH24_STENCIL8` on every implementation this game can run on. Sixteen bits across
       * a 0.12-400 m frustum cannot separate a 1 cm trim lip from the wall behind it at
       * ordinary combat range, which is the reported jitter; twenty-four bits has two orders
       * of magnitude in hand.
       *
       * The cost is 8 bits per sample on the MSAA buffer and no fill: the clears here are
       * explicit and none of them touch stencil.
       */
      stencil: true,
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

  get shadowQuality(): ShadowQuality {
    return this.shadowTier;
  }

  /**
   * Set the shadow tier and push it into every shadow-casting light in the scene (M8).
   *
   * Applied live rather than at the next map load: a setting that needs a restart to take
   * effect is a setting a player cannot evaluate, and evaluating it is the entire reason it
   * exists on a screen whose job is finding a playable configuration.
   *
   * Changing `mapSize` on an existing shadow needs its render target disposed, or three.js
   * keeps drawing into the old one at the old resolution and the setting appears to do
   * nothing at all.
   */
  setShadowQuality(quality: ShadowQuality, scene: THREE.Object3D): void {
    this.shadowTier = quality;
    const tier = SHADOW_TIERS[quality];
    this.three.shadowMap.enabled = tier.size > 0;

    scene.traverse((object) => {
      const light = object as THREE.Object3D & { isLight?: boolean; shadow?: THREE.LightShadow };
      const shadow = light.shadow;
      if (light.isLight !== true || shadow === undefined) return;
      const authored = shadowAuthoring.get(shadow);
      if (authored === undefined) return;

      if (tier.size === 0) {
        light.castShadow = false;
        return;
      }
      light.castShadow = authored.castShadow;
      shadow.radius = authored.radius * tier.radiusScale;
      if (shadow.mapSize.width !== tier.size) {
        shadow.mapSize.set(tier.size, tier.size);
        // The existing target is the old size; it has to go or nothing changes on screen.
        shadow.map?.dispose();
        shadow.map = null;
      }
    });
    this.three.shadowMap.needsUpdate = true;
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, viewmodel: ViewmodelLayer | null): void {
    const blur = this.blur;
    if (blur === null) {
      this.three.clear(true, true, false);
      this.drawFrame(scene, camera, viewmodel);
      return;
    }
    // The same closure the direct path calls, so there is one description of what a frame
    // contains and the blurred path cannot forget the viewmodel pass.
    blur.render(this.three, () => this.drawFrame(scene, camera, viewmodel));
  }

  private drawFrame(scene: THREE.Scene, camera: THREE.Camera, viewmodel: ViewmodelLayer | null): void {
    this.three.render(scene, camera);
    if (viewmodel !== null && viewmodel.hasContent) {
      // Fresh depth so the viewmodel can never intersect world geometry.
      this.three.clearDepth();
      this.three.render(viewmodel.scene, viewmodel.camera);
    }
  }

  /**
   * Turn accumulation motion blur on or off (M8, S6.3).
   *
   * Built on the first frame it is wanted and destroyed the moment it is not, so a player
   * who leaves it off never allocates a render target. See `engine/MotionBlur.ts`.
   */
  setMotionBlur(on: boolean): void {
    if (on === (this.blur !== null)) return;
    if (on) {
      this.blur = new MotionBlur();
      return;
    }
    this.blur?.dispose();
    this.blur = null;
  }

  get motionBlurEnabled(): boolean {
    return this.blur !== null;
  }

  /** Drop the blur history — on a respawn, a map change or a camera takeover. */
  resetMotionBlur(): void {
    this.blur?.reset();
  }

  /**
   * The Chopper Gunner's view (M7, brief S6.1; reworked post-M8).
   *
   * The brief asks for "a render pass, not a colour filter over the normal view", and the
   * difference is not pedantry — it decides what the picture can *say*. A filter tints an
   * already-lit image, so a body in shadow stays dark and the sky stays bright, which is the
   * opposite of what a gunship optic shows. A pass decides what each object is:
   *
   *  1. The world is drawn with an override material that ignores lighting entirely and
   *     shades on surface facing, so the map reads as legible grey terrain **at night as
   *     well as by day** — the map's own lights are not consulted at all, which is the whole
   *     point on Depot.
   *  2. Depth is kept and the bodies are drawn in two further passes: `cold` — the gunner's
   *     own side — in near-black, and `hot` — everybody else — in orange. Both are occluded
   *     by the depth buffer pass one wrote, so a body behind a container is still behind it.
   *
   * **The IFF split is the post-M8 change.** M7 drew every body hot, so the gunner could not
   * tell their own team from the enemy and the streak was as likely to wipe the friendly
   * half of the map as the hostile one. Two groups rather than a per-object test keeps this
   * a render pass that knows nothing about teams: it is handed the cold ones and the hot
   * ones and draws them differently.
   *
   * ## Why the sky is the *renderer's* clear colour and not `scene.background` (round 2)
   *
   * This is three passes that share one depth buffer and one colour buffer, and that only
   * works if passes two and three do not clear. `autoClear` is off for exactly that reason —
   * but `scene.background`, when it holds a `Color`, is not a passive backdrop: three's
   * background stage sets `forceClear` and calls `renderer.clear(autoClearColor,
   * autoClearDepth, ...)` *regardless* of `autoClear`. Those two flags default to true and
   * nothing here was turning them off, so every one of the three `render` calls wiped the
   * one before it. The player saw the last pass only: a flat background with orange enemies
   * floating on it, no map and no team-mates. That is verbatim the post-M8 report, and both
   * halves of it — "the world is pitch black" and "teammates are invisible" — are this one
   * line.
   *
   * So the optic's sky is set as the *renderer's* clear colour and cleared once, by hand,
   * and the scene's background is nulled for the duration. A null background leaves
   * `forceClear` false, which leaves `autoClear` in charge, which is off.
   *
   * Nothing is post-processed and no render target is allocated, which is what keeps this
   * inside the frame budget on integrated graphics.
   */
  renderGunship(
    scene: THREE.Scene,
    camera: THREE.Camera,
    hot: THREE.Object3D | null,
    cold: THREE.Object3D | null,
  ): void {
    const previousOverride = scene.overrideMaterial;
    const previousBackground = scene.background;
    const previousFog = scene.fog;
    this.three.getClearColor(previousClear);
    const previousClearAlpha = this.three.getClearAlpha();

    // Bodies are hidden for the world pass and drawn by the two that follow. Without this
    // they would be shaded as terrain first and then overdrawn, which costs a pass and — on
    // a body exactly coplanar with the floor it stands on — flickers between the two.
    const hotWasVisible = hot?.visible ?? false;
    const coldWasVisible = cold?.visible ?? false;
    if (hot !== null) hot.visible = false;
    if (cold !== null) cold.visible = false;

    scene.overrideMaterial = this.gunshipWorld();
    // Fog and a sky colour are lighting cues, and the optic has neither. The optic's own
    // flat sky is the clear colour rather than the scene background — see the note above.
    scene.background = null;
    scene.fog = null;
    this.three.setClearColor(GUNSHIP_BACKGROUND, 1);

    // The one clear of the three passes. Everything after this shares the depth buffer it
    // writes, which is what makes a body behind a container stay behind it.
    this.three.clear(true, true, false);
    this.three.render(scene, camera);
    scene.overrideMaterial = previousOverride;

    if (hot !== null) hot.visible = hotWasVisible;
    if (cold !== null) cold.visible = coldWasVisible;

    this.drawBodies(scene, camera, cold, hot, this.gunshipCold(), previousOverride);
    this.drawBodies(scene, camera, hot, cold, this.gunshipHot(), previousOverride);

    scene.background = previousBackground;
    scene.fog = previousFog;
    this.three.setClearColor(previousClear, previousClearAlpha);
  }

  /**
   * Draw one body group with an override material, with everything else hidden.
   *
   * `exclude` is the *other* body group, which has to be hidden explicitly because it is a
   * sibling under the same top-level node — hiding by scene child alone would draw both.
   */
  private drawBodies(
    scene: THREE.Scene,
    camera: THREE.Camera,
    subject: THREE.Object3D | null,
    exclude: THREE.Object3D | null,
    material: THREE.Material,
    restoreOverride: THREE.Material | null,
  ): void {
    if (subject === null || !subject.visible) return;

    const wasVisible = new Map<THREE.Object3D, boolean>();
    for (const child of scene.children) {
      wasVisible.set(child, child.visible);
      // The subject may be nested (a team group under the roster node), so the test is
      // ancestry rather than identity.
      child.visible = child === subject || isAncestorOf(child, subject);
    }
    const excludeWas = exclude?.visible ?? false;
    if (exclude !== null) exclude.visible = false;

    scene.overrideMaterial = material;
    this.three.render(scene, camera);
    scene.overrideMaterial = restoreOverride;

    if (exclude !== null) exclude.visible = excludeWas;
    for (const [child, visible] of wasVisible) child.visible = visible;
  }

  private gunshipWorld(): THREE.Material {
    if (this.thermalWorldMaterial === null) {
      this.thermalWorldMaterial = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: GUNSHIP_VERT,
        fragmentShader: GUNSHIP_WORLD_FRAG,
        fog: false,
      });
    }
    return this.thermalWorldMaterial;
  }

  private gunshipHot(): THREE.Material {
    if (this.thermalHotMaterial === null) {
      this.thermalHotMaterial = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: GUNSHIP_VERT,
        fragmentShader: GUNSHIP_HOT_FRAG,
        fog: false,
      });
    }
    return this.thermalHotMaterial;
  }

  private gunshipCold(): THREE.Material {
    if (this.thermalColdMaterial === null) {
      this.thermalColdMaterial = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: GUNSHIP_VERT,
        fragmentShader: GUNSHIP_COLD_FRAG,
        fog: false,
      });
    }
    return this.thermalColdMaterial;
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
    this.blur?.dispose();
    this.blur = null;
    this.thermalWorldMaterial?.dispose();
    this.thermalWorldMaterial = null;
    this.thermalHotMaterial?.dispose();
    this.thermalHotMaterial = null;
    this.thermalColdMaterial?.dispose();
    this.thermalColdMaterial = null;
    this.three.dispose();
  }
}

/**
 * What each shadow was *authored* at, keyed by the shadow itself.
 *
 * The quality tier scales a map's intent rather than replacing it, so the intent has to
 * survive being scaled — without this, going medium → high → medium would multiply the
 * radius by 1.6 and then by 1 against the already-scaled value, and the map's art direction
 * would drift a little further every time the player touched the slider.
 *
 * A `WeakMap` because the key is a light that belongs to a map, and a map is disposed
 * between matches: entries go with it and there is nothing to clean up.
 */
const shadowAuthoring = new WeakMap<THREE.LightShadow, { radius: number; castShadow: boolean }>();

/** Whether `descendant` sits anywhere below `node`. Used by the gunship body passes. */
function isAncestorOf(node: THREE.Object3D, descendant: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = descendant.parent;
  while (current !== null) {
    if (current === node) return true;
    current = current.parent;
  }
  return false;
}

/** Called by `MapLoader` once per light, with the values the map asked for. */
export function rememberShadowAuthoring(
  shadow: THREE.LightShadow,
  radius: number,
  castShadow: boolean,
): void {
  shadowAuthoring.set(shadow, { radius, castShadow });
}

/**
 * The optic has no sky. A flat mid grey, so the horizon is not a black void.
 *
 * Lifted post-M8 along with the world shader: at 0x121212 the ground and the background were
 * close enough that Depot's yard had no discernible edge from 60 m up.
 */
const GUNSHIP_BACKGROUND = new THREE.Color(0x1e2226);

/** Scratch for saving the renderer's clear colour across a gunship frame. */
const previousClear = new THREE.Color();

/**
 * Shared vertex stage: view-space depth is the only thing either fragment stage needs.
 *
 * `viewDepth` is negated because view space looks down -Z, so this is a positive distance.
 *
 * **Instancing has to be applied by hand** (round 2). An override material replaces whatever
 * a mesh was built with, and half of what a map draws is `THREE.InstancedMesh` — every
 * container, crate, barrier and pillar. three declares `instanceMatrix` for us (the
 * `USE_INSTANCING` define comes from the object, not the material) but only its *own* shader
 * chunks consume it, so a custom vertex stage that ignores the attribute collapses every
 * instance onto the origin. On Depot the containers are the map, so the optic showed a bare
 * yard with a knot of geometry in the middle of it. `mat3(instanceMatrix)` is a pure
 * rotation here — placements are yaw-and-translate, never scaled — so it composes with the
 * normal matrix directly.
 */
const GUNSHIP_VERT = `
varying float vViewDepth;
varying vec3 vViewNormal;
void main() {
  vec3 objectNormal = normal;
  vec4 localPosition = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    localPosition = instanceMatrix * localPosition;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  vec4 viewPosition = modelViewMatrix * localPosition;
  vViewDepth = -viewPosition.z;
  // View-space normal, so the grey pass can separate surfaces by facing without needing a
  // light in the scene. Thermal optics still resolve edges; a depth ramp alone cannot.
  vViewNormal = normalize(normalMatrix * objectNormal);
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
const GUNSHIP_WORLD_FRAG = `
varying float vViewDepth;
varying vec3 vViewNormal;
void main() {
  vec3 n = normalize(vViewNormal);
  // Two keys rather than one. A single overhead key left every horizontal surface — which,
  // from a gunship, is nearly the whole picture — at one flat value, so the yard read as a
  // sheet of grey with no containers on it. The fill comes in from the side and separates a
  // wall from the floor it meets.
  float key = clamp(dot(n, normalize(vec3(0.35, 0.86, 0.38))), 0.0, 1.0);
  float fill = clamp(dot(n, normalize(vec3(-0.62, 0.24, -0.75))), 0.0, 1.0);
  // Post-M8: the floor was 0.16 + 0.60 * lambert and the depth term took another 42% off it
  // at range, which on a night map produced the reported "cannot see the map at all". The
  // ambient term is more than doubled, the range falloff is halved, and the result is a
  // legible mid-grey everywhere — this is an optic, and an optic is not lit by the map.
  float depthFade = 1.0 - 0.20 * clamp(vViewDepth / 150.0, 0.0, 1.0);
  float lum = (0.34 + 0.46 * key + 0.16 * fill) * depthFade;
  gl_FragColor = vec4(vec3(clamp(lum, 0.0, 1.0)), 1.0);
}
`;

/**
 * The gunner's own side: near-black, unlit (post-M8).
 *
 * The brief for this pass is "teammates appear dark, only enemies glow orange", and dark is
 * doing real work rather than being a colour choice — a silhouette that is *darker* than the
 * grey terrain is instantly separable from one that is brighter, so a glance at the picture
 * sorts the map into three categories without reading any of them. A slight lift with
 * distance keeps a far team-mate from disappearing into a shadowed corner entirely.
 *
 * Round 2 adds a shallow facing term and lifts the floor off pure black. The report asked
 * for team-mates that are "identifiable but don't distract", and a flat 0.03 silhouette is
 * neither: at that value a team-mate standing over a shadowed seam has no edge at all and
 * reads as a hole in the picture rather than as a person. 0.07-0.20 stays well under the
 * world pass's 0.27 floor — so a team-mate is still unambiguously the darkest thing in the
 * frame — while the facing term gives the silhouette enough internal structure to count as
 * one body rather than two overlapping ones.
 */
const GUNSHIP_COLD_FRAG = `
varying float vViewDepth;
varying vec3 vViewNormal;
void main() {
  vec3 n = normalize(vViewNormal);
  float key = clamp(dot(n, normalize(vec3(0.35, 0.86, 0.38))), 0.0, 1.0);
  float t = clamp(vViewDepth / 120.0, 0.0, 1.0);
  float lum = mix(0.05, 0.14, t) + 0.06 * key;
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
const GUNSHIP_HOT_FRAG = `
varying float vViewDepth;
varying vec3 vViewNormal;
void main() {
  float t = clamp(vViewDepth / 110.0, 0.0, 1.0);
  vec3 near = vec3(1.0, 0.45, 0.06);
  vec3 far = vec3(1.0, 0.68, 0.24);
  gl_FragColor = vec4(mix(near, far, t), 1.0);
}
`;
