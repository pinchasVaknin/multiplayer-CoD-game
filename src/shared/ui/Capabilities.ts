/**
 * Whether this device can play the game at all, and whether it can aim right now (round 5).
 *
 * Two reports, one missing step. **B8**: pointer lock is refused, `Input` writes a line to the
 * console, and the match runs on unaimable with a full HUD and a running clock. **F1**: there is
 * no touch input anywhere in `src/client/`, and yet a phone loads the menu, is shown a table of
 * keyboard bindings and a note about F11, and can start a match it cannot play. The game never
 * asks whether it can be played here, and never says so when it cannot.
 *
 * ## The decision, and why it splits
 *
 * A refused pointer lock is a **banner**. A device with no fine pointer is a **block**. The
 * distinguishing property is *recoverability*, and it is worth stating because the brief offered
 * one answer for both:
 *
 * - A refusal is the **expected** state on the commonest path there is. `Input.armPointerLock`'s
 *   own comment records that Chrome refuses a lock for a window after the player leaves it with
 *   Escape — so pause, then resume, is a refusal every time. It is recoverable by exactly the
 *   gesture the banner asks for, and it clears itself the instant the lock is taken. A modal you
 *   fight through on every resume would be worse than the silence it replaces.
 * - No fine pointer is not recoverable by anything the player can do in the page. Round 4's F7
 *   made the protective call for the waiting room; this is where that precedent belongs, because
 *   here there is nothing to protect them *from* except a match they cannot play.
 *
 * ## Why the predicates are here
 *
 * They are pure functions of a record, so the harness can run every case without a browser —
 * which is the half `HeadlessClient` can normally never reach, since it builds no DOM at all.
 * The DOM-touching part is one adapter in `client/input/DeviceCapabilities.ts` that fills the
 * record in; everything that *decides* anything is below, and `shared/` still compiles with no
 * DOM library. Same reasoning that put `HudSurfaces` and `SpectatorTarget` in `shared/`.
 */

/**
 * What the browser says about the pointing devices attached to it.
 *
 * A record rather than four calls to `navigator` and `matchMedia`, because the rules below have
 * to be answerable without a browser and because "what did we detect" is worth being able to
 * print when somebody reports that the gate fired on a machine that should have passed.
 */
export interface DeviceCapabilities {
  /** `navigator.maxTouchPoints`. Non-zero on a phone, and also on a touchscreen laptop. */
  readonly maxTouchPoints: number;
  /** `(pointer: fine)` — a mouse, a trackpad or a stylus. */
  readonly finePointer: boolean;
  /** `(pointer: coarse)` — a finger. Not exclusive with `finePointer`. */
  readonly coarsePointer: boolean;
  /** Whether the Pointer Lock API exists at all. Absent, nothing here can aim. */
  readonly hasPointerLock: boolean;
}

export type PlayabilityId = 'ok' | 'no-pointer-lock' | 'no-fine-pointer';

export interface Playability {
  readonly id: PlayabilityId;
  readonly ok: boolean;
  /** The line the gate screen leads with. Empty when `ok`. */
  readonly headline: string;
  /** What the player can do about it, or why they cannot. Empty when `ok`. */
  readonly detail: string;
}

const PLAYABLE: Playability = { id: 'ok', ok: true, headline: '', detail: '' };

/**
 * Can this device play the game?
 *
 * **A fine pointer, and an API to lock it.** Touch is not consulted as a disqualifier and that
 * is deliberate: `maxTouchPoints` is non-zero on a great many laptops that have a perfectly good
 * trackpad, and gating on it would refuse a machine that plays fine. The question is not *does
 * this have a finger* but *does this have something to aim with* — so a touchscreen laptop is
 * admitted and a phone is not, which is the split F1 actually asks for.
 *
 * The pointer-lock test comes first because it is the harder failure: a device with a mouse and
 * no lock API can move a cursor around but can never look, and there is no message about
 * pointing devices that would help.
 */
export function playability(caps: DeviceCapabilities): Playability {
  if (!caps.hasPointerLock) {
    return {
      id: 'no-pointer-lock',
      ok: false,
      headline: 'This browser cannot capture the mouse',
      detail:
        'OPERATOR aims by locking the pointer to the page, and this browser does not offer the ' +
        'Pointer Lock API. A current desktop Chrome, Edge, Firefox or Safari will run it.',
    };
  }
  if (!caps.finePointer) {
    return {
      id: 'no-fine-pointer',
      ok: false,
      headline: 'OPERATOR needs a keyboard and a mouse',
      detail:
        'This is a desktop shooter: it is played with WASD and a mouse, and there is no touch ' +
        'control scheme. Nothing here would work on a touchscreen, so rather than let you into ' +
        'a match you cannot play, it stops at this screen.',
    };
  }
  return PLAYABLE;
}

/**
 * The aim warning, or `''` for no banner (B8).
 *
 * A pure function of three facts that all outlive the banner, which is the round-4 HUD surface
 * invariant applied to a new surface rather than a new kind of thing:
 *
 * - `wantsPointerLock` — the match is live and asking. False on the pause screen and in the
 *   menu, which is what makes the banner survive a pause correctly: it is *down* while paused,
 *   because a released cursor there is the player's own doing and not a fault.
 * - `pointerLocked` — whether we actually have it.
 * - `lockRefused` — whether a request has come back refused and we have not been locked since.
 *
 * The third term is what stops the banner flashing during the ordinary in-flight moment between
 * arming and the lock landing. It is evidence rather than a timer, which is what P0 asks for:
 * the state says *we asked and were told no*, not *enough time has passed*.
 */
export function aimWarning(state: {
  readonly wantsPointerLock: boolean;
  readonly pointerLocked: boolean;
  readonly lockRefused: boolean;
}): string {
  if (!state.wantsPointerLock || state.pointerLocked || !state.lockRefused) return '';
  return 'MOUSE NOT CAPTURED — CLICK TO AIM · F11 FOR FULLSCREEN';
}
