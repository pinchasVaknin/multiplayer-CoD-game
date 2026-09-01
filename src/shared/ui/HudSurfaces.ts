import type { GameStateId } from '../core/GameStates';
import type { MatchPhase } from '../modes/MatchFlow';
import { DT } from '../core/Loop';

/**
 * What every HUD surface's visibility is derived from (M11 Gate B, playtest round 4).
 *
 * ## The invariant this file exists to make checkable
 *
 * *Every HUD surface has exactly one writer, and its visibility is a pure function of state
 * that outlives the surface, evaluated once per frame from one place.*
 *
 * Three reports in round four were the same defect wearing different hats, and the shape was
 * always one of two things: a surface whose "am I open" was stored in **two** places and only
 * one of them was written (the debug overlay's ×), or a surface written from a code path that
 * **stops running** at the moment the answer needed to change (the scoreboard, driven from the
 * sim tick, which does not tick while paused). Round three had already established half the
 * rule — *a hidden surface never consumes a key* — and this is the other half: a surface that
 * has stopped being shown must release what it latched, and the cheapest way to guarantee that
 * is for it never to have latched anything in the first place.
 *
 * ## Why these live in `shared/`
 *
 * They are the half that can be wrong invisibly. `HeadlessClient` builds no `ClientMatch` and
 * has no DOM, so a claim about a panel is a browser claim — but a claim about the *rule* is an
 * ordinary function with an ordinary answer, and the harness can run it over a real connection
 * across death, respawn, round end and migration. That is the same reasoning that put
 * `pickSpectatorTarget` in `shared/modes/SpectatorTarget.ts`, and it caught 292 selections'
 * worth of invariant there.
 *
 * Nothing here touches the DOM, so `shared/` compiles without the DOM lib exactly as it did
 * before. See `scripts/check-boundaries.mjs`.
 *
 * ## `editorOpen` is gone (round 4, B8)
 *
 * Both predicates below used to test it: Create-a-Class could be open as an overlay over a
 * live match, and a surface behind a full-screen editor is a surface that must be down. Round
 * four's loadout doctrine removed that route — the editor is a front-end screen and
 * `LEGAL_TRANSITIONS` no longer admits `MATCH -> LOADOUT` — so the flag could only ever be
 * false wherever these are evaluated. A condition that cannot fire is a rule guarding nothing,
 * and leaving one in a table whose whole purpose is to say what each surface is derived from
 * is how the table stops describing the code.
 */

/**
 * Where the player last asked for the debug overlay. **One value, not two booleans.**
 *
 * The B1 report — *"the × closes it, but coming back to the game reopens it"* — is what two
 * booleans cost. `Game` held "was it open when we paused" beside `DebugOverlay`'s own
 * `visible`, the × wrote only the second, and the resume restored an intent the player had
 * already cancelled.
 *
 * A single tri-state carries everything the two booleans were trying to say, and it says it
 * about the **request** rather than about the surface — so it survives the world being torn
 * down and rebuilt underneath it, which a flag on the overlay cannot:
 *
 * - `'none'` — not wanted. The only thing the × and Escape ever write.
 * - `'inMatch'` — wanted, asked for from the game. Hidden for the duration of a pause and put
 *   back on resume, which is M5's rule: the overlay is a large interactive panel and the pause
 *   screen is modal, and two of those stacked is the UI clash the pause menu was reported for.
 * - `'onPause'` — wanted, asked for **from the pause screen**. Visible over it, because the
 *   tuning sliders need a cursor and paused is the only time there is one. It demotes to
 *   `'inMatch'` on resume, which is how *"once the overlay has been opened on purpose it stays
 *   open through the resume"* is kept without a second flag remembering it.
 */
export type DebugOverlayRequest = 'none' | 'inMatch' | 'onPause';

/** Which of the quick class selector's two windows is open, if either. */
export type QuickLoadoutWindow = 'none' | 'prematch' | 'respawn';

/**
 * Everything the predicates below read. All of it outlives the surfaces it decides.
 *
 * Deliberately flat and primitive: the point of the extraction is that a harness can build one
 * of these from the wire without a `ClientMatch`, and anything that needed a live object here
 * would put half the rule back out of reach.
 */
export interface HudSurfaceState {
  /** The front-end state machine. A surface belonging to the world is never up outside it. */
  readonly screen: GameStateId;
  /** False between a teardown and the next build; every surface is down. */
  readonly hasWorld: boolean;
  readonly playerDead: boolean;
  /** The death screen's own countdown. Zero means "not coming back on a clock". */
  readonly respawnSeconds: number;
  readonly phase: MatchPhase;
  readonly round: number;
  /** The scoreboard key, as of the last command the match consumed. */
  readonly scoreboardHeld: boolean;
  readonly debugRequest: DebugOverlayRequest;
}

/**
 * The scoreboard (B6).
 *
 * Held Tab, and nothing else — but evaluated against `screen` as well, which is what stops it
 * latching. The write used to live at the end of `ClientMatch.simulate`, and a tick is not a
 * frame: pausing stops the tick, `Input.clearHeld` drops the Tab bit into a loop that is no
 * longer running, and the board stays up over the pause screen holding a key nobody is
 * pressing. Asked once per frame from state that outlives the tick, there is nothing to stick.
 */
export function scoreboardOpen(s: HudSurfaceState): boolean {
  if (!s.hasWorld || s.screen !== 'MATCH') return false;
  return s.scoreboardHeld;
}

/**
 * The quick class selector (B13), and its two windows.
 *
 * Unchanged in substance from `Game.updateQuickLoadout`, which round two got right and round
 * three measured end to end; extracted so the harness can run it over a real connection
 * instead of somebody watching a panel. The windows are the moments when *"applies on your
 * next spawn"* means "in a second or two":
 *
 *  - **respawn** — dead with a countdown actually running. `playerDead` alone is the wrong
 *    window: an S&D corpse waits out the round, and a player who dies as the match ends is dead
 *    until the summary.
 *  - **prematch** — round one's ten-second freeze, and only round one. `phase` rather than a
 *    frozen flag, because the round-end hold is also frozen and offering a class change over a
 *    decided round offers it for a body that is about to be reset anyway.
 */
export function quickLoadoutWindow(s: HudSurfaceState): QuickLoadoutWindow {
  if (!s.hasWorld || s.screen !== 'MATCH') return 'none';
  if (s.playerDead && s.respawnSeconds > 0) return 'respawn';
  if (s.phase === 'WARMUP' && s.round <= 1) return 'prematch';
  return 'none';
}

/**
 * The debug overlay (B1). See `DebugOverlayRequest` for why this is a tri-state.
 *
 * `PAUSED` is a legal screen for it — the tuning sliders need a released cursor and that is
 * the only screen with one — but only for a request made *there*. Everything else is off.
 */
export function debugOverlayVisible(s: HudSurfaceState): boolean {
  if (!s.hasWorld || s.debugRequest === 'none') return false;
  if (s.screen === 'MATCH') return true;
  if (s.screen === 'PAUSED') return s.debugRequest === 'onPause';
  return false;
}

/**
 * The death screen's countdown, as a function rather than as a method on a match.
 *
 * Presentational and clamped at zero: the authoritative *"you are alive again"* is the
 * replicated alive bit, and this must never be mistaken for a second opinion about it. If the
 * server is slower than the local estimate the display sits at zero and waits.
 *
 * Extracted for one reason: it is the input `quickLoadoutWindow` reads, so a harness that
 * cannot step a `ClientMatch` can still step *this* and evaluate the window honestly.
 */
export function stepRespawnDisplay(seconds: number, dead: boolean, dt: number = DT): number {
  if (!dead || seconds <= 0) return seconds;
  return Math.max(0, seconds - dt);
}
