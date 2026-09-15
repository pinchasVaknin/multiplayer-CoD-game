/**
 * The PROTOCOL SEVEN brand (2026-09-15): the human's logo, as the human's logo.
 *
 * Three files under `public/brand/`, the project's first and only image assets — a decision
 * taken on the day, after a vector reading of the mask was tried and turned down ("I can see
 * you cannot draw it"): the logo on the boot screen and the skull beside the wordmark are the
 * artwork, not an approximation of it.
 *
 * - `logo.png`   — the full logo, its black keyed to alpha, so it stands on any dark ground
 *                  without a box. 1024², 272 kB. The boot screen and the device gate.
 * - `mark.png`   — the skull cut from the logo (438 × 611), keyed the same way; the edge
 *                  pixels un-premultiplied so they composite back to the original over black.
 * - `mark-eyes.png` — only the cyan of the same cut: the eyes and the light across them, alpha
 *                  from the cyan-ness. Laid over the mark and breathed by `app.css`
 *                  (`.op-mark__eyes`), which is how a raster's eyes glow more and less.
 *
 * Made by a one-off Pillow pass from the file the human supplied; the numbers (a key from 12
 * to 72 on the brightest channel, the cyan from 18 to 90 of min(g, b) − r) are in the commit
 * that added them, not in a script the build depends on.
 */

const BRAND_ROOT = '/brand';

/** The skull beside the name: the mark, with its eyes as a second layer that breathes. */
export function makeMark(className: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `op-mark ${className}`;
  wrap.setAttribute('aria-hidden', 'true');
  const face = document.createElement('img');
  face.className = 'op-mark__face';
  face.src = `${BRAND_ROOT}/mark.png`;
  face.alt = '';
  face.draggable = false;
  const eyes = document.createElement('img');
  eyes.className = 'op-mark__eyes';
  eyes.src = `${BRAND_ROOT}/mark-eyes.png`;
  eyes.alt = '';
  eyes.draggable = false;
  wrap.append(face, eyes);
  return wrap;
}

/** The logo, whole, for the boot screen and the device gate. */
export function makeLockup(): HTMLElement {
  const img = document.createElement('img');
  img.className = 'op-lockup';
  img.src = `${BRAND_ROOT}/logo.png`;
  img.alt = 'PROTOCOL SEVEN';
  img.draggable = false;
  return img;
}
