/**
 * The PROTOCOL SEVEN emblem and lockup (2026-09-15, from the human's logo).
 *
 * The logo is a split skull mask — two angular halves on a dark ridge, cyan eye slits, a thin
 * cyan light across the eyes running out past the mask, brush strokes flying off the top
 * right and the bottom left — beside PROTOCOL over a cyan rule over SEVEN with its V in cyan.
 * There are no image assets in this project (M12's first paragraph), so the mask is drawn
 * here as paths, the way the menu's four glyphs and the category icons are: it scales to a
 * 56 px header mark and a 360 px boot mark from the same element, and the eyes and the light
 * are their own shapes so a stylesheet animation can breathe through them (`.op-emblem__eye`,
 * `.op-emblem__slash` — `app.css`). What the paths cannot be is the raster's grain; a PNG at
 * `public/brand/` would be the one asset the project ships, and that is the human's call.
 */

const NS = 'http://www.w3.org/2000/svg';
export const EMBLEM_VIEWBOX = '0 0 120 120';

/** The mask's left half, the ridge's left edge at x = 58. */
const LEFT_HALF =
  'M58 10 L46 2 L36 12 L24 4 L14 22 L12 44 L5 54 L12 66 L16 84 L30 102 L46 114 L58 122 Z';
/** The right half, mirrored on x = 60 with the ridge's right edge at x = 62. */
const RIGHT_HALF =
  'M62 10 L74 2 L84 12 L96 4 L106 22 L108 44 L115 54 L108 66 L104 84 L90 102 L74 114 L62 122 Z';
/** Cuts that read as the right half's brush damage: three diagonal slashes through it. */
const DAMAGE = [
  'M86 8 L91 6 L78 40 L74 38 Z',
  'M100 22 L104 25 L92 46 L88 44 Z',
  'M94 30 L97 33 L84 52 L81 50 Z',
  'M70 96 L74 94 L84 104 L80 106 Z',
];
/** Brush strokes flying off the mask, top right and bottom left. */
const STROKES = [
  'M92 6 L124 -8 L126 -5 L96 10 Z',
  'M100 12 L128 2 L129 5 L102 15 Z',
  'M104 18 L126 12 L126 15 L106 21 Z',
  'M10 104 L-4 122 L-1 124 L14 106 Z',
  'M18 108 L8 126 L11 127 L21 110 Z',
];
/** The eye slits: slanted, pointed toward the ridge. */
const LEFT_EYE = 'M14 46 L48 58 L46 66 L30 64 L16 54 Z';
const RIGHT_EYE = 'M106 46 L72 58 L74 66 L90 64 L104 54 Z';
/** The nose: two slits either side of the ridge. */
const NOSE = ['M50 76 L55 74 L55 92 L51 90 Z', 'M70 76 L65 74 L65 92 L69 90 Z'];
/** Grooves down the cheeks. */
const GROOVES = ['M22 72 L27 72 L38 98 L34 100 Z', 'M98 72 L93 72 L82 98 L86 100 Z', 'M40 78 L44 78 L44 96 L40 94 Z', 'M80 78 L76 78 L76 96 L80 94 Z'];
/** The light across the eyes: pointed at both ends, longer than the mask is wide. */
const SLASH = 'M-16 57 L20 55 L100 55 L136 57 L100 59 L20 59 Z';

function path(d: string, className: string): SVGPathElement {
  const el = document.createElementNS(NS, 'path');
  el.setAttribute('d', d);
  el.setAttribute('class', className);
  return el;
}

/** The skull mark. `className` is the caller's size and place; the parts carry their own. */
export function makeEmblem(className: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', EMBLEM_VIEWBOX);
  svg.setAttribute('class', `op-emblem ${className}`);
  svg.setAttribute('aria-hidden', 'true');
  // Under everything: the light, so it shows past the mask and the eyes sit on it.
  svg.appendChild(path(SLASH, 'op-emblem__slash'));
  for (const d of STROKES) svg.appendChild(path(d, 'op-emblem__stroke'));
  svg.appendChild(path(LEFT_HALF, 'op-emblem__half op-emblem__half--left'));
  svg.appendChild(path(RIGHT_HALF, 'op-emblem__half op-emblem__half--right'));
  for (const d of DAMAGE) svg.appendChild(path(d, 'op-emblem__cut'));
  for (const d of NOSE) svg.appendChild(path(d, 'op-emblem__cut'));
  for (const d of GROOVES) svg.appendChild(path(d, 'op-emblem__cut'));
  svg.appendChild(path(LEFT_EYE, 'op-emblem__eye'));
  svg.appendChild(path(RIGHT_EYE, 'op-emblem__eye'));
  return svg;
}

/**
 * The lockup: the mark beside PROTOCOL / a cyan rule / SEVEN with its V in the accent — the
 * logo's arrangement, in type. The boot screen and the device gate stand on it.
 */
export function makeLockup(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'op-lockup';
  wrap.appendChild(makeEmblem('op-lockup__emblem'));

  const words = document.createElement('div');
  words.className = 'op-lockup__words';
  const line1 = document.createElement('span');
  line1.className = 'op-lockup__protocol';
  line1.textContent = 'PROTOCOL';
  const rule = document.createElement('span');
  rule.className = 'op-lockup__rule';
  const line2 = document.createElement('span');
  line2.className = 'op-lockup__seven';
  const v = document.createElement('span');
  v.className = 'op-lockup__v';
  v.textContent = 'V';
  line2.append('SE', v, 'EN');
  words.append(line1, rule, line2);
  wrap.appendChild(words);
  return wrap;
}
