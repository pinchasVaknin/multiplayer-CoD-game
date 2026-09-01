import { weaponSilhouettePath } from '../weapons/WeaponSilhouette';

/**
 * Killfeed icons, drawn rather than loaded (brief S6.5, S2).
 *
 * Zero external assets means the silhouette of a rifle is geometry in a source file. It used
 * to be geometry *in this file*: one hand-typed 48-coordinate `AR` outline, keyed by weapon
 * **class**, with `iconFor` returning null for the eight classes nobody had drawn and the feed
 * falling back to the weapon's name. Eleven of the twelve shipped weapons printed their name.
 *
 * **That made this a second source for what a weapon looks like** (playtest round 4, F15), and
 * the instruction attached to F15 was that there should be one. So the path now comes from
 * `weaponSilhouettePath`, which projects the same `WeaponModelSpec` the viewmodel is built
 * from — the icon is the gun, seen from the side, and it cannot drift from it because there is
 * nothing left here to drift. Twelve weapons, twelve outlines, and a thirteenth arrives with
 * its spec rather than with a drawing session.
 *
 * The name fallback is gone with it: `iconFor` no longer returns null. An id with no spec of
 * its own gets `AR_BASE` from `modelSpecFor`, which is exactly what the *viewmodel* would draw
 * for it — so the feed and the hands still agree, which is the property that matters and the
 * one a null could not have kept.
 */

export const ICON_VIEWBOX = '0 0 48 16';

/**
 * SVG path data for one weapon's outline, in `ICON_VIEWBOX`, barrel pointing right.
 *
 * Keyed by weapon **id** rather than by class, which is the change F15 bought: an SMG and an
 * LMG are not the same shape, and the feed can now say which one killed you without printing
 * its name. `weaponSilhouettePath` memoises, so calling this per feed row costs a map lookup.
 */
export function iconFor(weaponId: string): string {
  return weaponSilhouettePath(weaponId);
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
