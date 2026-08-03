import type { ColorblindMode } from '../../shared/meta/SaveData';

/**
 * Every colour that carries **gameplay meaning**, in one place (brief S6.3).
 *
 * ## Why this is not a CSS filter
 *
 * S6.3 is explicit: colorblind mode must affect "the actual team colours, hitmarkers,
 * minimap and objective indicators, not just a CSS filter over everything". The difference
 * is not cosmetic. A filter is a fixed transform applied after the fact, so it moves *every*
 * colour including the ones that were already distinguishable, and it cannot add contrast
 * that the source image never had: a green dot and a red dot that a deuteranope reads as two
 * identical browns are still two identical browns after any matrix you like. What works is
 * choosing different colours, and the only way to do that is to have somewhere the colours
 * are chosen.
 *
 * So this is that place, and it covers both worlds at once — the DOM (as CSS custom
 * properties, so `hud.css` keeps expressing intent rather than hex) and the 3D scene and
 * canvases (as numbers, for `THREE.Color` and `CanvasRenderingContext2D`). One palette, two
 * encodings, no possibility of the minimap disagreeing with the killfeed.
 *
 * ## What the three modes actually do
 *
 * The default red/green pairing is the worst possible choice for the two commonest forms of
 * colour blindness and the best possible choice for everybody else, which is why it is the
 * default and why the alternatives exist.
 *
 * - **Deuteranopia / protanopia** (red-green): friendly moves off green entirely and onto a
 *   strong cyan-blue; hostile moves off red and onto a bright amber-orange. Blue and orange
 *   is the classic safe pair — it separates on the blue-yellow axis, which both conditions
 *   leave intact — and it also separates by *lightness*, which survives even a total loss of
 *   colour vision.
 * - **Tritanopia** (blue-yellow, rare): the safe axis is the other one, so friendly goes to
 *   a clear teal-green and hostile to a strong magenta-red. Blue would be the wrong answer
 *   here for the same reason green is wrong above.
 *
 * Neutral, warning and objective colours move with them, because an objective ring that
 * stayed amber under deuteranopia would collide with the new hostile colour — a palette is
 * a set of relationships and shifting one member without the others is how you turn one
 * indistinguishable pair into a different indistinguishable pair.
 */

export interface GameplayPalette {
  /** The local player's team. */
  readonly friendly: number;
  /** Anything hostile: enemy bots, enemy-held objectives, UAV contacts, gunfire pings. */
  readonly hostile: number;
  /** The local player's own marker. Deliberately near-white in every mode. */
  readonly local: number;
  /** An unclaimed objective, and the HUD accent that goes with it. */
  readonly neutral: number;
  /** A landed hit. */
  readonly hitmarker: number;
  /** A hit that killed. */
  readonly hitmarkerKill: number;
  /** Damage taken: the vignette and the directional indicators. */
  readonly damage: number;
  /** Something going well that is not a team: a capture completing, XP. */
  readonly positive: number;
}

const BASE: GameplayPalette = {
  friendly: 0x6fd08c,
  hostile: 0xe8604c,
  local: 0xe8eaee,
  neutral: 0xffb340,
  hitmarker: 0xe8eaee,
  hitmarkerKill: 0xe8604c,
  damage: 0xe8604c,
  positive: 0x6fd08c,
};

/**
 * Red-green safe: blue against orange.
 *
 * Shared by deuteranopia and protanopia. The two conditions differ in *which* cone is
 * missing and therefore in how they mis-see red, but the pair that works is the same pair,
 * and offering two near-identical palettes would be offering a choice with no content. They
 * are separate options in the menu because a player knows which diagnosis they have and not
 * which cone axis it maps to.
 */
const RED_GREEN_SAFE: GameplayPalette = {
  friendly: 0x4cc3ff,
  hostile: 0xff9e2c,
  local: 0xf2f5f8,
  // Neutral goes cool-white rather than amber: amber and the new hostile orange are the
  // same hue, and an unclaimed flag must never read as an enemy one.
  neutral: 0xc9d6e2,
  hitmarker: 0xf2f5f8,
  hitmarkerKill: 0xff9e2c,
  damage: 0xff7a1f,
  positive: 0x4cc3ff,
};

/** Blue-yellow safe: teal against magenta. */
const BLUE_YELLOW_SAFE: GameplayPalette = {
  friendly: 0x2fd6b0,
  hostile: 0xff5c8a,
  local: 0xf4f4f4,
  neutral: 0xd8d2c4,
  hitmarker: 0xf4f4f4,
  hitmarkerKill: 0xff5c8a,
  damage: 0xff3d73,
  positive: 0x2fd6b0,
};

const PALETTES: Readonly<Record<ColorblindMode, GameplayPalette>> = {
  off: BASE,
  deuteranopia: RED_GREEN_SAFE,
  protanopia: RED_GREEN_SAFE,
  tritanopia: BLUE_YELLOW_SAFE,
};

export function paletteFor(mode: ColorblindMode): GameplayPalette {
  return PALETTES[mode] ?? BASE;
}

/** `0xRRGGBB` as `#rrggbb`, for CSS and for canvas fill styles. */
export function cssHex(value: number): string {
  return `#${(value >>> 0).toString(16).padStart(6, '0')}`;
}

/** `0xRRGGBB` plus an alpha, as `rgba(...)`. Canvases need this and CSS variables do too. */
export function cssRgba(value: number, alpha: number): string {
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The live palette, and the one thing everything else reads.
 *
 * A singleton because the alternative is threading a palette reference through the HUD, the
 * minimap, the killfeed, the scoreboard, the objective meshes and the streak strip — six
 * constructors that would each need to know when the setting changed. The setting changes
 * from exactly one place and nothing here is per-match, so a module-level current value with
 * a change notification is the honest shape.
 *
 * CSS custom properties are written onto `:root` on every change, so a stylesheet can say
 * `var(--c-hostile)` and be correct in every mode without any JavaScript at the call site.
 */
class PaletteState {
  private mode: ColorblindMode = 'off';
  private palette: GameplayPalette = BASE;
  private readonly listeners: Array<(p: GameplayPalette) => void> = [];
  /** Whether `:root` has ever been written. See `set`. */
  private written = false;

  get current(): GameplayPalette {
    return this.palette;
  }

  get currentMode(): ColorblindMode {
    return this.mode;
  }

  set(mode: ColorblindMode): void {
    // The first call always writes, even for the default: at boot nothing has put the
    // gameplay custom properties on `:root` yet, and a stylesheet asking for `--c-hit`
    // would fall through to its literal fallback for the rest of the session.
    if (mode === this.mode && this.written) return;
    this.written = true;
    this.mode = mode;
    this.palette = paletteFor(mode);
    this.writeCssVariables();
    for (const fn of this.listeners) fn(this.palette);
  }

  /**
   * Subscribe to palette changes. Returns an unsubscribe.
   *
   * Called immediately with the current palette, so a subscriber never has to also read
   * `current` at construction — one code path for "set up" and "changed" is one fewer place
   * for the two to drift.
   */
  onChange(fn: (p: GameplayPalette) => void): () => void {
    this.listeners.push(fn);
    fn(this.palette);
    return () => {
      const at = this.listeners.indexOf(fn);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  /** Push the palette onto `:root`, so CSS can name colours instead of repeating them. */
  writeCssVariables(): void {
    const root = document.documentElement.style;
    const p = this.palette;
    root.setProperty('--c-friendly', cssHex(p.friendly));
    root.setProperty('--c-hostile', cssHex(p.hostile));
    root.setProperty('--c-local', cssHex(p.local));
    root.setProperty('--c-neutral', cssHex(p.neutral));
    root.setProperty('--c-hit', cssHex(p.hitmarker));
    root.setProperty('--c-hit-kill', cssHex(p.hitmarkerKill));
    root.setProperty('--c-damage', cssHex(p.damage));
    root.setProperty('--c-positive', cssHex(p.positive));
    // Alpha variants the HUD needs, generated rather than hand-maintained alongside them.
    root.setProperty('--c-damage-soft', cssRgba(p.damage, 0.55));
    root.setProperty('--c-hostile-soft', cssRgba(p.hostile, 0.55));
    root.setProperty('--c-friendly-soft', cssRgba(p.friendly, 0.55));

    /**
     * The two semantic tokens M1 shipped, overridden.
     *
     * `--c-good` and `--c-bad` were already the vocabulary the HUD used for "your team /
     * something going well" and "the enemy / you are being hurt" — the team bars, the
     * damage chevrons, the hurt vignette, the kill hitmarker and the killfeed all resolve
     * to them. Pointing them at the palette is what makes colourblind mode reach twenty
     * existing rules without rewriting a stylesheet, and it is why this had to be a palette
     * rather than a filter: those rules already expressed intent, they were simply anchored
     * to two fixed colours.
     *
     * `--c-accent` is deliberately *not* touched. It is the interface accent — buttons,
     * labels, the crosshair — and recolouring the menus is not what the setting is for.
     */
    root.setProperty('--c-good', cssHex(p.friendly));
    root.setProperty('--c-bad', cssHex(p.hostile));
  }
}

export const palette = new PaletteState();
