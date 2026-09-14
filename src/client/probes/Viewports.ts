/**
 * The viewports the layout probe measures at (playtest round 5, P1; M15, A1).
 *
 * In the repository rather than in the report, because a viewport list that lives in a
 * document is a list nothing runs. Eight sizes, and each is here for a reason rather than to
 * make a round number:
 *
 * - `1920x1080` is the design frame itself (M15, A1): the one size at which `--ui-scale` is
 *   exactly 1 and a screen is measured in its own pixels. Everything else is a scaled copy of
 *   what this row sees, so a screen that is over height here is over height everywhere.
 * - `1280x720` is the floor (M15, decision 3): the smallest window the no-scroll rule is
 *   *promised* legible at. Below it the rule still holds — the frame has no lower clamp — and
 *   the rows beneath this one are what prove it.
 * - `1366x626` is the round-5 report's own: a 1366x768 laptop with Chrome's chrome on it.
 *   B1 was measured here, so it is the size that had to go red before anything was changed.
 * - `1280x600` and `1024x640` are the same laptop with a window that is not maximised, and
 *   the band either side of `.op-pickers`' 840px fold.
 * - `800x600` is the smallest desktop window anybody actually drags to.
 * - `596x696` is the round-5 report's narrow window, where `START MATCH` went under the fold
 *   (B2) — tall enough that nothing is short, narrow enough that everything has folded.
 * - `375x812` is a phone held upright. F1 says there is no touch input, which is a separate
 *   session's problem; the menu still loads there and still has to be readable.
 *
 * Width was the interesting axis while the layout folded (`.op-pickers`, `.lo-columns` and
 * `.sb__grid` all fold on width, and each fold changes the height), which is why the list is
 * not three sizes. Under the frame, folding stops — the frame is always 1920 wide in its own
 * pixels — and the six smaller rows measure something else instead: that a uniform scale
 * really is uniform, and that nothing in the HUD or the debug layer, which sit outside the
 * frame, has been dragged along with it.
 */

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export const PROBE_VIEWPORTS: readonly Viewport[] = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 1366, height: 626 },
  { width: 1280, height: 600 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
  { width: 596, height: 696 },
  { width: 375, height: 812 },
];
