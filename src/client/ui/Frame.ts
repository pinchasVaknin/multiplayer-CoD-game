/**
 * The design frame (M15, Phase A1): every front-end screen is laid out at 1920×1080 and the
 * whole frame is scaled to the window.
 *
 * ## Why a frame rather than a responsive layout
 *
 * M15's rule is that nothing scrolls, at any window size. The responsive answer — let each
 * screen fold its columns and cap its widths, and scroll whatever is left — is what the front
 * end did through playtest round 5 (B1, B2, B11), and it is a rule per screen: every new
 * screen has to be argued into fitting again, and the argument is only ever checked at the
 * viewports somebody thought to list. A frame is one argument. A screen that fits 1920×1080
 * fits every window, because the window never sees anything but a scaled copy of the frame.
 *
 * ## `zoom`, not `transform: scale()`
 *
 * A transform is applied *after* layout: the element is laid out at its unscaled size and the
 * result is rasterised through a matrix, so text is blurred at fractional scales and every
 * `getBoundingClientRect()` still reports the unscaled box. `zoom` is applied *in* layout —
 * the used value of every length inside the frame is multiplied by it — so text is rasterised
 * at its final size, hit-testing is exact, and the layout probe measures what is on screen.
 * Chrome has always had it; Firefox since 126; it is in the CSS Viewport module now.
 *
 * ## The scale is set from the window, in one place
 *
 * `applyFrameScale` writes `--ui-scale` onto `#ui-root`, and `.op-frame` reads it. `Game`
 * calls it beside `Renderer.setSize` — the two are the same fact, "the window is this big",
 * answered for the canvas and for the DOM — and the layout probe calls it at the top of every
 * run, because a viewport it has just emulated has not fired anything's resize listener.
 *
 * The formula has no lower clamp on purpose. Below the 1280×720 floor the rule "nothing
 * scrolls" still holds — a 375-wide window gets a frame at 0.2 and everything on it — and what
 * is not promised there is legibility, which is the device gate's question, not this file's.
 *
 * ## What is *not* in the frame
 *
 * The HUD. `MatchFeedback` and `ScreenProjection` place hit markers, nameplates and the
 * direction indicators in real pixels, and a zoomed ancestor would put every one of them at
 * the wrong place by exactly `1 / scale`. So the zoom is not on `#ui-root`; it is on the
 * `.op-frame` each front-end screen holds, and the HUD stays in the window's own pixels.
 */

export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;

/** The largest uniform scale at which the frame fits the window. */
export function frameScale(viewportWidth: number, viewportHeight: number): number {
  return Math.min(viewportWidth / FRAME_WIDTH, viewportHeight / FRAME_HEIGHT);
}

/** Write the scale for this window onto the UI root, and return it. */
export function applyFrameScale(root: HTMLElement, viewportWidth: number, viewportHeight: number): number {
  const scale = frameScale(viewportWidth, viewportHeight);
  root.style.setProperty('--ui-scale', String(scale));
  return scale;
}

/**
 * A full-screen layer and the frame inside it.
 *
 * The layer (`.op-screen`) is full-bleed: it carries the backdrop, the blur and the z-order,
 * and it is what `hidden` toggles. The frame (`.op-frame`) is the 1920×1080 box the screen's
 * content lives in, centred by the layer and scaled by `--ui-scale`. Screens append to the
 * frame and never to the layer, so a screen cannot put anything outside the frame by
 * accident — there is nowhere else to put it.
 */
export function createScreen(layerClass: string): { layer: HTMLElement; frame: HTMLElement } {
  const layer = document.createElement('div');
  layer.className = layerClass;
  const frame = document.createElement('div');
  frame.className = 'op-frame';
  layer.appendChild(frame);
  return { layer, frame };
}
