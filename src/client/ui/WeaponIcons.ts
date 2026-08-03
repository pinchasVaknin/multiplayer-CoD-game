import type { WeaponClass } from '../../shared/weapons/WeaponDefs';

/**
 * Killfeed icons, as SVG path data written here rather than loaded (brief S6.5, S2).
 *
 * Zero external assets means the silhouette of a rifle is a string of coordinates in a
 * source file. Each path is drawn in a 48 x 16 viewBox with the barrel pointing right and
 * the grip below the line, so every class shares one baseline and a feed row does not shift
 * when the weapon changes.
 *
 * **Only the classes that exist are drawn.** M4 ships one weapon, and eight silhouettes for
 * weapons that do not exist yet is exactly the kind of scaffolding this project does not
 * ship. `iconFor` therefore returns `null` for a class with no path and the feed falls back
 * to the weapon's *name* — a real alternative rendering, not a placeholder box, and the one
 * M5 will see for each new weapon until its outline is drawn.
 */

export const ICON_VIEWBOX = '0 0 48 16';

const PATHS: Partial<Record<WeaponClass, string>> = {
  /**
   * Assault rifle: receiver, long barrel with a front sight block, carry handle, magazine
   * raked forward, and a stock behind the grip. Reads at 16 px, which is the only test.
   */
  AR:
    'M6 6 H30 V10 H6 Z' +
    'M30 7 H43 V9 H30 Z' +
    'M40 4 H42 V7 H40 Z' +
    'M12 4 H24 V6 H12 Z' +
    'M18 10 L21 16 H17 L15 10 Z' +
    'M6 7 L1 8 V11 H6 Z' +
    'M9 10 H12 V13 H9 Z',
};

/** SVG path data for a weapon class, or null when that class has no outline drawn yet. */
export function iconFor(weaponClass: WeaponClass | undefined): string | null {
  if (weaponClass === undefined) return null;
  return PATHS[weaponClass] ?? null;
}

/**
 * A headshot marker: a small skull-ish glyph, drawn beside the icon.
 *
 * Its own viewBox, because it is a badge rather than a silhouette and sharing the 48 x 16
 * box would make it either tiny or distorted.
 */
export const HEADSHOT_VIEWBOX = '0 0 12 12';
export const HEADSHOT_PATH =
  'M6 1 C3 1 1.5 3 1.5 5.2 C1.5 6.6 2.3 7.6 3.2 8.1 V10 H4.8 V8.6 H7.2 V10 H8.8 V8.1 ' +
  'C9.7 7.6 10.5 6.6 10.5 5.2 C10.5 3 9 1 6 1 Z M4.2 4.6 A0.9 0.9 0 1 1 4.2 6.4 ' +
  'A0.9 0.9 0 1 1 4.2 4.6 Z M7.8 4.6 A0.9 0.9 0 1 1 7.8 6.4 A0.9 0.9 0 1 1 7.8 4.6 Z';

/** Build an inline SVG element for a path. Namespaced, so it renders inside the DOM HUD. */
export function makeIconSvg(path: string, viewBox: string, className: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(NS, 'path');
  shape.setAttribute('d', path);
  svg.appendChild(shape);
  return svg;
}
