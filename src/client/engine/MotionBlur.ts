import * as THREE from 'three';

/**
 * Optional accumulation motion blur (brief S6.3).
 *
 * ## Why this exists at all, given "no post-processing stack"
 *
 * `Renderer`'s own note says there is no post stack, and that is still the default: with the
 * setting off, not one line of this file runs and no render target is allocated. It is
 * built lazily on the first frame the player turns it on and torn down when they turn it
 * off, because S6.3's rule is that a setting must do something and a motion-blur toggle
 * that toggles nothing is the worst kind of setting there is.
 *
 * ## How it works, and why it is two targets rather than one
 *
 * Exponential accumulation: `accum = accum * k + scene * (1 - k)`. The obvious
 * implementation is to render the scene straight into a buffer that is never cleared and
 * fade it each frame — and that does not work, because the world is *opaque*. Opaque
 * geometry overwrites whatever was under it, so the fade survives only where nothing was
 * drawn, which is the sky.
 *
 * The other obvious implementation is to skip the buffer and blend onto the canvas
 * directly, letting the default framebuffer be the history. That needs
 * `preserveDrawingBuffer: true` on the context, which is a construction-time flag with a
 * real cost on some drivers — paid by every player including the ones who never enable
 * blur.
 *
 * So: the scene goes to a target, a quad blends it onto a second target that is never
 * cleared, and that target is blitted to the canvas. Two targets, two fullscreen quads, and
 * the cost is confined to the people who asked for it.
 *
 * ## Keeping it short
 *
 * S6.4 asks for effects that are "all short, all low-frequency, none nauseating". The
 * strength is capped well below the point where the trail becomes a smear: at `STRENGTH`
 * the contribution of a frame has decayed to under a tenth after four frames, which at
 * 60 Hz is 67 ms — enough to smooth a fast flick, not enough to leave a ghost of a player
 * you already shot.
 */

/** How much of the previous frame survives. Higher is a longer trail. */
const STRENGTH = 0.55;

const QUAD_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const QUAD_FRAG = `
uniform sampler2D uTexture;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(uTexture, vUv).rgb, uOpacity);
}
`;

export class MotionBlur {
  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private accumTarget: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private width = 0;
  private height = 0;
  /** True until the accumulation buffer holds a real frame. */
  private cold = true;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTexture: { value: null }, uOpacity: { value: 1 } },
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Render `draw` through the blur and composite to the canvas.
   *
   * `draw` is handed a target to render into and is otherwise the same closure the
   * un-blurred path calls directly, so there is exactly one description of what a frame
   * contains and this file cannot forget the viewmodel pass.
   */
  render(
    renderer: THREE.WebGLRenderer,
    draw: () => void,
  ): void {
    const size = renderer.getDrawingBufferSize(sizeScratch);
    this.ensureTargets(renderer, size.x, size.y);
    const sceneTarget = this.sceneTarget;
    const accumTarget = this.accumTarget;
    if (sceneTarget === null || accumTarget === null) return;

    // 1. The frame, into a target of our own.
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(sceneTarget);
    renderer.clear(true, true, false);
    draw();

    // 2. Blend it onto the history. The history is never cleared, which is the whole
    //    mechanism — on the first frame it is blended at full strength so the effect does
    //    not start with a black screen fading in.
    renderer.setRenderTarget(accumTarget);
    this.setQuad(sceneTarget.texture, this.cold ? 1 : 1 - STRENGTH);
    renderer.render(this.quadScene, this.quadCamera);
    this.cold = false;

    // 3. History to the canvas, opaque.
    renderer.setRenderTarget(previousTarget);
    renderer.clear(true, true, false);
    this.setQuad(accumTarget.texture, 1);
    renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Drop the history.
   *
   * Called on a map change and on respawn: a trail of the map you just left, smeared over
   * the map you just arrived in, reads as a rendering bug rather than as motion.
   */
  reset(): void {
    this.cold = true;
  }

  dispose(): void {
    this.sceneTarget?.dispose();
    this.accumTarget?.dispose();
    this.sceneTarget = null;
    this.accumTarget = null;
    this.material.dispose();
    this.quad.geometry.dispose();
    this.width = 0;
    this.height = 0;
  }

  /** `noUncheckedIndexedAccess` makes uniform lookups optional; resolve both in one place. */
  private setQuad(texture: THREE.Texture, opacity: number): void {
    const uniforms = this.material.uniforms;
    const tex = uniforms['uTexture'];
    const op = uniforms['uOpacity'];
    if (tex !== undefined) tex.value = texture;
    if (op !== undefined) op.value = opacity;
  }

  private ensureTargets(renderer: THREE.WebGLRenderer, width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.sceneTarget !== null && this.width === w && this.height === h) return;

    this.sceneTarget?.dispose();
    this.accumTarget?.dispose();
    this.width = w;
    this.height = h;
    // No depth buffer on the accumulation target: nothing is depth-tested into it. The
    // scene target needs one, and it is the only place depth is used here.
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      colorSpace: renderer.outputColorSpace as THREE.ColorSpace,
    });
    this.accumTarget = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      colorSpace: renderer.outputColorSpace as THREE.ColorSpace,
    });
    this.cold = true;
  }
}

const sizeScratch = new THREE.Vector2();
