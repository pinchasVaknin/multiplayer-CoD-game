/**
 * The viewports the layout probe measures at (playtest round 5, P1).
 *
 * In the repository rather than in the report, because a viewport list that lives in a
 * document is a list nothing runs. Six sizes, and each is here for a reason rather than to
 * make a round number:
 *
 * - `1366x626` is the round-5 report's own: a 1366x768 laptop with Chrome's chrome on it.
 *   B1 was measured here, so it is the size that has to go red before anything is changed.
 * - `1280x600` and `1024x640` are the same laptop with a window that is not maximised, and
 *   the band either side of `.op-pickers`' 840px fold.
 * - `800x600` is the smallest desktop window anybody actually drags to.
 * - `596x696` is the round-5 report's narrow window, where `START MATCH` went under the fold
 *   (B2) — tall enough that nothing is short, narrow enough that everything has folded.
 * - `375x812` is a phone held upright. F1 says there is no touch input, which is a separate
 *   session's problem; the menu still loads there and still has to be readable.
 *
 * Width is the interesting axis on this project and the reason the list is not three sizes:
 * `.op-pickers`, `.lo-columns` and `.sb__grid` all fold or refuse to fold on width, and each
 * fold changes the height. A height-only sweep would have found B1 and missed B2 entirely.
 */

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export const PROBE_VIEWPORTS: readonly Viewport[] = [
  { width: 1366, height: 626 },
  { width: 1280, height: 600 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
  { width: 596, height: 696 },
  { width: 375, height: 812 },
];
