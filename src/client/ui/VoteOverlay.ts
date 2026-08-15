import { DT } from '../../shared/core/Loop';
import type { VoteInfo } from '../../shared/net/Messages';
import {
  MAP_BALLOT,
  MODE_BALLOT,
  VOTE_CYCLE_CONFIG,
  VotePhase,
} from '../../shared/net/Skirmish';
import { findMap, findMode } from '../../shared/modes/ModeRegistry';
import type { GameModeId } from '../../shared/modes/GameMode';

/**
 * The vote overlay (M11, §6.4, §6.10).
 *
 * ## It never blocks, and it is keyboard-only
 *
 * §4.20: *"The vote UI is a **non-blocking overlay**. Players keep moving and shooting through
 * it."* The whole surface carries `pointer-events: none` — **including the options** — so not
 * one pixel of it can take a click.
 *
 * §6.4 offers *"number keys plus click"* and the click half is deliberately not built. The
 * playtest found the reason: the game holds pointer lock, so a click on the overlay is a click
 * the browser has already given to the canvas as a *shot*. Making the buttons clickable meant
 * either releasing pointer lock to vote — which drops the player out of the game to answer a
 * question they are meant to answer *while playing* — or fighting the lock and firing a round
 * every time somebody voted. Neither is worth having when a keypress does the job.
 *
 * The options are still rendered as `<button>` elements, because they are still the live tally
 * and the accessible name of each is what a screen reader should read. They are marked
 * `disabled` and `aria-disabled` so nothing suggests they can be pressed.
 *
 * ## Every number here comes from the server
 *
 * §4.20: *"The tally is computed **only** on the server; the client displays a broadcast tally
 * and never counts votes itself."* This class holds no tally, no timer and no notion of who
 * voted for what. The countdown is `(phaseEndsTick - currentTick) * DT` against the synced
 * server clock — so two clients cannot see different numbers, and a client that paused for a
 * second does not come back with a countdown that is a second wrong.
 *
 * ## The `replaceChildren` discipline (handover Tier 2 §B)
 *
 * **A DOM node that is replaced cannot be clicked.** A browser fires `click` only when
 * `mousedown` and `mouseup` land on the same element, so a surface rebuilt on a periodic
 * broadcast destroys the row under the pointer every 250 ms and a click registers only if the
 * whole press falls between two rebuilds. It was reported at M11 as *"clicking on a map
 * requires multiple clicks; a single click does not work"*, which is exactly what a 250 ms
 * window looks like from the other side.
 *
 * So rows are built **once**, keyed, and updated in place. `replaceChildren` runs only when
 * the row *set* changes — which here means only when the phase changes from mode to map. The
 * listener is attached in `buildRow` and never re-attached.
 */

export interface VoteOverlayDeps {
  readonly host: HTMLElement;
  /** Cast a vote for `option` in `phase`. The server decides whether it counts. */
  readonly onVote: (phase: number, option: number) => void;
  /** The client's current tick, from the synced server clock. Drives the countdown. */
  readonly currentTick: () => number;
}

interface Row {
  readonly button: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
  readonly fill: HTMLElement;
}

export class VoteOverlay {
  private readonly deps: VoteOverlayDeps;
  private readonly root: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly optionHost: HTMLElement;
  private readonly hint: HTMLElement;

  private readonly rows = new Map<number, Row>();
  /** Identifies the current row *set*. A change here is the only thing that rebuilds. */
  private rowsKey = '';

  private info: VoteInfo | null = null;

  /** A server notice being shown, and how many frames it has left. See `notice`. */
  private noticeText = '';
  private noticeFramesLeft = 0;

  constructor(deps: VoteOverlayDeps) {
    this.deps = deps;

    this.root = document.createElement('div');
    this.root.className = 'op-vote';
    this.root.hidden = true;

    /**
     * The announced mode, kept on screen through the map vote (§6.4).
     *
     * *"The mode result stays on screen through the map vote. Players choose a map knowing the
     * mode, which is the entire reason for sequencing them rather than showing both at once."*
     */
    this.banner = document.createElement('div');
    this.banner.className = 'op-vote__banner';
    this.banner.hidden = true;

    this.heading = document.createElement('h2');
    this.heading.className = 'op-vote__heading';

    this.clock = document.createElement('span');
    this.clock.className = 'op-vote__clock';

    this.optionHost = document.createElement('div');
    this.optionHost.className = 'op-vote__options';

    this.hint = document.createElement('p');
    this.hint.className = 'op-vote__hint';
    this.hint.textContent = 'PRESS 1-5 TO VOTE — KEEP PLAYING';

    const head = document.createElement('div');
    head.className = 'op-vote__head';
    head.append(this.heading, this.clock);

    this.root.append(this.banner, head, this.optionHost, this.hint);
    deps.host.appendChild(this.root);
  }

  /**
   * Apply a broadcast from the server.
   *
   * Called at whatever rate the server sends (4 Hz) — never on a local timer, because a local
   * timer is a second opinion about a number §4.20 gives exactly one authority.
   */
  apply(info: VoteInfo): void {
    this.info = info;
    const balloting = info.phase === VotePhase.MODE_VOTE || info.phase === VotePhase.MAP_VOTE;
    /**
     * A live notice keeps the surface up (M11 playtest).
     *
     * This used to be `hidden = !balloting && phase !== PLAY`, full stop — and the phase during
     * a failed allocation is `ALLOCATING`, so the very next 4 Hz broadcast hid the overlay
     * again. A notice explaining why the match did not start was therefore visible for at most
     * one broadcast interval before being wiped, which is why the playtest reported the
     * transition aborting *silently*.
     *
     * §4.17 requires every player to be left in the arena **with a message**. A message shown
     * for 250 ms is not one.
     */
    this.root.hidden = !balloting && info.phase !== VotePhase.PLAY && this.noticeFramesLeft === 0;

    if (info.phase === VotePhase.PLAY) {
      // The countdown to the next ballot: *"visible but unobtrusive"* (§6.4). No options, no
      // banner — just how long you have left to shoot before you are asked.
      this.heading.textContent = 'NEXT VOTE IN';
      this.showNoticeOrHideBanner();
      this.hint.hidden = true;
      this.renderRows([]);
      this.tick();
      return;
    }

    if (!balloting) {
      /**
       * `ALLOCATING`: no ballot, and normally nothing to say.
       *
       * The exception is a notice, and it is the important case — this is the phase a failed
       * allocation leaves the cycle in. The clock and the options are cleared so the surface
       * carries the message and nothing stale beside it.
       */
      this.heading.textContent = 'STARTING THE MATCH';
      this.clock.textContent = '';
      this.hint.hidden = true;
      this.renderRows([]);
      this.showNoticeOrHideBanner();
      return;
    }

    this.hint.hidden = false;
    this.heading.textContent = info.phase === VotePhase.MODE_VOTE ? 'VOTE — MODE' : 'VOTE — MAP';

    const decidedMode = MODE_BALLOT[info.decidedMode];
    if (this.noticeFramesLeft > 0) {
      // A notice outranks the mode announcement for as long as it is up: it is the answer to
      // something the player just tried to do, and the mode banner will still be there after.
      this.banner.hidden = false;
      this.banner.textContent = this.noticeText;
    } else if (info.phase === VotePhase.MAP_VOTE && decidedMode !== undefined) {
      this.banner.hidden = false;
      this.banner.textContent = `${modeName(decidedMode)} — NOW PICK THE MAP`;
    } else {
      this.banner.hidden = true;
    }

    this.renderRows(this.optionsFor(info));
    this.tick();
  }

  /** Put a live notice on the banner, or hide it. The only writer of both, outside `apply`. */
  private showNoticeOrHideBanner(): void {
    if (this.noticeFramesLeft > 0) {
      this.banner.hidden = false;
      this.banner.textContent = this.noticeText;
      return;
    }
    this.banner.hidden = true;
  }

  /**
   * Redraw the countdown. Called every frame; touches one text node.
   *
   * Separate from `apply` because the clock changes sixty times a second and the tally changes
   * four times a second, and rebuilding the tally at frame rate is the bug this whole file is
   * shaped around.
   */
  tick(): void {
    if (this.noticeFramesLeft > 0) {
      this.noticeFramesLeft--;
      if (this.noticeFramesLeft === 0) {
        this.noticeText = '';
        this.banner.hidden = true;
        /**
         * The notice was the only reason this surface was up during `ALLOCATING`; take it down
         * with the message. Without this the empty panel outlives the thing it existed to say.
         */
        const phase = this.info?.phase ?? VotePhase.IDLE;
        if (phase !== VotePhase.PLAY && phase !== VotePhase.MODE_VOTE && phase !== VotePhase.MAP_VOTE) {
          this.root.hidden = true;
        }
      }
    }

    const info = this.info;
    if (info === null || this.root.hidden) return;
    const remaining = Math.max(0, (info.phaseEndsTick - this.deps.currentTick()) * DT);
    this.clock.textContent = remaining.toFixed(1);
  }

  /**
   * A number key was pressed while the overlay was open.
   *
   * Returns whether it was consumed, so the caller knows not to pass it on. Voting is
   * deliberately reachable without the mouse: the overlay opens while the player is mid-
   * firefight and taking a hand off the mouse to click a button is a death.
   */
  handleDigit(digit: number): boolean {
    const info = this.info;
    /**
     * A surface that is not on screen never eats a key (M11 Gate B playtest round 3).
     *
     * `root.hidden` is not the *whole* test — the overlay is also visible during PLAY, showing
     * the countdown, and 1-5 must behave normally then, which the phase check below handles.
     * But the converse is absolute, and it was missing: while this is hidden it is not asking
     * the player anything, so it has no business consuming their input.
     *
     * That mattered because `apply` is the only writer of `info`, and the server broadcasts the
     * vote state **to the arena only**. A player migrated into a live match stops being told
     * anything, so whatever phase they last heard is what they keep — and if the migration beat
     * the 4 Hz broadcast that would have said `ALLOCATING`, they carried a live `MAP_VOTE` into
     * the match. Keys 1-3 then went to a ballot nobody could see instead of to the class
     * selector, which is the reported *"sometimes I can't switch class"* — sometimes, because it
     * is a race, and it is won or lost on whether this client had already built that map.
     */
    if (this.root.hidden) return false;
    if (info === null) return false;
    if (info.phase !== VotePhase.MODE_VOTE && info.phase !== VotePhase.MAP_VOTE) return false;
    const option = digit - 1;
    const size = info.phase === VotePhase.MODE_VOTE ? MODE_BALLOT.length : MAP_BALLOT.length;
    if (option < 0 || option >= size) return false;
    this.deps.onVote(info.phase, option);
    return true;
  }

  /**
   * Show a line from the server for a few seconds (§4.17, §4.18).
   *
   * Allocation failed, the arena was rebuilt, the match could not be joined. It reuses the
   * announcement banner rather than adding a surface: this strip is already on screen during
   * the flow, already styled, and already positioned clear of the crosshair — and a notice is
   * exactly the same kind of thing as "TDM — NOW PICK THE MAP".
   *
   * The expiry is a tick count against the render loop rather than a `setTimeout`, so it
   * cannot fire into a disposed overlay.
   */
  notice(text: string, seconds = 8): void {
    this.noticeText = text;
    this.noticeFramesLeft = Math.round(seconds * 60);
    this.root.hidden = false;
    this.banner.hidden = false;
    this.banner.textContent = text;
  }

  /**
   * Take the surface down and forget the ballot.
   *
   * Called on migration as well as on teardown: the vote cycle belongs to the arena, and a
   * client that has been moved into a live match is no longer being told about it. Dropping
   * `info` is the half that matters — it is what stops `handleDigit` answering for a ballot
   * that has since resolved.
   */
  hide(): void {
    this.root.hidden = true;
    this.info = null;
    this.noticeFramesLeft = 0;
    this.noticeText = '';
    this.banner.hidden = true;
  }

  dispose(): void {
    this.rows.clear();
    this.root.remove();
  }

  // -- rendering ---------------------------------------------------------------

  private optionsFor(info: VoteInfo): OptionView[] {
    const isMode = info.phase === VotePhase.MODE_VOTE;
    const ids = isMode ? MODE_BALLOT : MAP_BALLOT;
    const total = info.tally.reduce((sum, n) => sum + n, 0);
    return ids.map((id, index) => ({
      index,
      label: isMode ? modeName(id as GameModeId) : mapName(id),
      count: info.tally[index] ?? 0,
      pct: total === 0 ? 0 : Math.round(((info.tally[index] ?? 0) / total) * 100),
      self: info.selfVote === index,
    }));
  }

  /**
   * The template from handover Tier 2 §B, applied verbatim.
   *
   * The set of rows only changes when the underlying collection does — here, when the ballot
   * switches from five modes to three maps. Every broadcast in between writes text, classes
   * and widths into the *surviving* nodes, so the button under the pointer is the same DOM
   * element from the moment it appears to the moment the phase ends.
   */
  private renderRows(items: readonly OptionView[]): void {
    const wanted = items.map((v) => v.label).join('|');
    if (wanted !== this.rowsKey) {
      this.rowsKey = wanted;
      this.rows.clear();
      this.optionHost.replaceChildren();
      for (const item of items) this.optionHost.appendChild(this.buildRow(item));
    }

    for (const item of items) {
      const row = this.rows.get(item.index);
      if (row === undefined) continue;
      row.name.textContent = `${item.index + 1}  ${item.label}`;
      row.count.textContent = String(item.count);
      row.fill.style.width = `${item.pct}%`;
      row.button.classList.toggle('op-vote__option--on', item.self);
      // Still announced: which option *this* player chose is real information, even though the
      // control cannot be operated with a pointer.
      row.button.setAttribute('aria-pressed', item.self ? 'true' : 'false');
    }
  }

  private buildRow(item: OptionView): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'op-vote__option';

    const fill = document.createElement('span');
    fill.className = 'op-vote__option-fill';

    const name = document.createElement('span');
    name.className = 'op-vote__option-name';

    const count = document.createElement('span');
    count.className = 'op-vote__option-count';

    button.append(fill, name, count);
    /**
     * No click listener, by design. See the class header.
     *
     * The `replaceChildren` discipline below still applies in full and is not weakened by
     * this: rows are built once and updated in place because a node replaced on a 4 Hz
     * broadcast also loses focus, `aria-live` continuity and any CSS transition mid-flight.
     * The click argument was the sharpest case for it, not the only one.
     */
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');

    this.rows.set(item.index, { button, name, count, fill });
    return button;
  }
}

interface OptionView {
  readonly index: number;
  readonly label: string;
  readonly count: number;
  readonly pct: number;
  readonly self: boolean;
}

/** Total cycle length, for a caller that wants to size a progress bar. */
export const VOTE_CYCLE_SECONDS =
  VOTE_CYCLE_CONFIG.playSeconds + VOTE_CYCLE_CONFIG.modeVoteSeconds + VOTE_CYCLE_CONFIG.mapVoteSeconds;

function modeName(id: GameModeId): string {
  try {
    return findMode(id).name;
  } catch {
    // A ballot entry this build does not know. The server decides the outcome regardless, and
    // showing the raw id beats showing nothing or throwing inside a render pass.
    return id;
  }
}

function mapName(id: string): string {
  try {
    return findMap(id).name;
  } catch {
    return id;
  }
}
