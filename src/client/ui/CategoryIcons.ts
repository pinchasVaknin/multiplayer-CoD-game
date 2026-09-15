/**
 * Glyphs for the things that have no silhouette (Create-a-Class round 2, 2026-09-15).
 *
 * The weapons draw their own outlines (`WeaponIcons`). Everything else a class holds — a
 * grenade, a flash, a smoke, a perk, a killstreak, a field upgrade, a finish, an attachment —
 * had a letter in a circle, and the round-2 brief asks for pictures at twice the size. There
 * are no image assets (M12's first paragraph), so these are paths, one per kind, drawn through
 * `makeIconSvg` the way the menu's four are: `fill: currentColor`, so they take the bar's
 * state. 24×24, drawn to read at 64 px.
 */

export const CATEGORY_VIEWBOX = '0 0 24 24';

export type CategoryIconId =
  | 'lethal'
  | 'tactical'
  | 'smoke'
  | 'perk'
  | 'streak'
  | 'field'
  | 'camo'
  | 'attachment'
  | 'equipment';

const PATHS: Readonly<Record<CategoryIconId, string>> = {
  /** A frag: a body of segments under a lever and a pin ring. */
  lethal:
    'M10 3h4v2h-1v1.2c2.9.6 5 3.1 5 6.3 0 3.6-2.9 6.5-6.5 6.5S5 16.1 5 12.5c0-3.2 2.1-5.7 5-6.3V5h-1V3z' +
    'M11.5 8.2c-2.1 0-3.8 1.9-3.8 4.3s1.7 4.3 3.8 4.3 3.8-1.9 3.8-4.3-1.7-4.3-3.8-4.3z' +
    'M15.5 2.5l2.5 1-1 2.4-2.5-1z M8 11h7v1.4H8z M8 13.6h7V15H8z',
  /** A flash: a burst of eight spokes round a core. */
  tactical:
    'M12 2l1.4 5.2L18 3.8l-2.6 4.7L20.8 10l-5.1 1.4 3.7 4-5-1.6L12 19l-1.4-5.2L6 17.6l2.6-4.6L3.2 12l5.1-1.4-3.7-4 5 1.6z' +
    'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  /** A smoke: three rounded puffs stacked. */
  smoke:
    'M7 19a3.5 3.5 0 0 1-.6-6.9A4.5 4.5 0 0 1 15 9.4 4 4 0 0 1 18.6 12 3.5 3.5 0 0 1 17.5 19z' +
    'M9.5 6a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4z M14.8 5.2a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z',
  /** A perk: a shield with a bar. */
  perk:
    'M12 2l8 3v6c0 5-3.4 8.7-8 11-4.6-2.3-8-6-8-11V5z M12 4.3L6 6.6V11c0 3.8 2.5 6.7 6 8.7 3.5-2 6-4.9 6-8.7V6.6z' +
    'M9 10.5h6v1.8H9z',
  /** A killstreak: a UAV — a body with two wings and a tail fin. */
  streak:
    'M12 4l1.2 5H22v2h-8.8l-.4 5.5L16 19v1.5l-4-1-4 1V19l3.2-2.5-.4-5.5H2V9h8.8z',
  /** A field upgrade: a case with a handle and a clasp. */
  field:
    'M9 4h6v2h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4z M10.5 5.5v.5h3v-.5z' +
    'M5 8v10h14V8z M10 11h4v3h-4z',
  /** A finish: a swatch — a tilted square over another. */
  camo:
    'M4 6h10v10H4z M6 8v6h6V8z M10 4h10v10h-2V6h-8z',
  /** An attachment: a scope — a tube with an eyepiece and a mount. */
  attachment:
    'M3 9h13a3 3 0 0 1 3 3 3 3 0 0 1-3 3H3z M5 11v2h11a1 1 0 0 0 0-2z M19.5 10h1.5v4h-1.5z M8 15h4v3H8z',
  /** Equipment, the category: the frag again, smaller in a ring. */
  equipment:
    'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19z M12 4.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15z' +
    'M11 7h2v1.4c1.7.5 3 2 3 3.9 0 2.3-1.8 4.1-4 4.1s-4-1.8-4-4.1c0-1.9 1.3-3.4 3-3.9z',
};

export function categoryIcon(id: CategoryIconId): string {
  return PATHS[id];
}
