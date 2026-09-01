import { accuracy, killDeath, type PlayerScore, type ScoreSystem, type ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { ColumnDef } from '../../shared/modes/GameMode';
import { Scoreboard } from './Scoreboard';
import type { ViewerContext } from '../../shared/ui/TeamColour';

/**
 * The post-match summary (brief S6.5).
 *
 * The result, the local player's own line, and the full scoreboard — which is the same
 * `Scoreboard` the player has been holding Tab on all match, not a second implementation of
 * it. Two boards that format the same numbers differently is exactly how a summary screen
 * ends up disagreeing with the match it is summarising.
 *
 * **The XP insertion point.** M6 adds an animated XP breakdown bar. `xpSlot` is an empty
 * element between the personal line and the scoreboard, laid out and styled, and it is
 * `hidden` while nothing fills it — so M6 appends to one place and changes nothing else here.
 * It is deliberately not a placeholder bar animating to a fake number: a summary screen that
 * shows invented progression is worse than one that shows none.
 */

export interface SummaryDeps {
  readonly rowsPerTeam: number;
  /**
   * The primary: back to the game. Connected, that is the lobby and the seat survives; in
   * single-player it is the menu, because there is nothing else there.
   */
  readonly onContinue: () => void;
  /** The secondary: leave the server for the main menu. Offered only when there is a server. */
  readonly onExit: () => void;
}

export class EndOfMatch {
  readonly element: HTMLElement;
  /** M6 appends the XP breakdown here. Empty and hidden until it does. */
  readonly xpSlot: HTMLElement;

  private readonly outcome: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly personal: HTMLElement;
  private readonly board: Scoreboard;
  private readonly continueButton: HTMLButtonElement;
  private readonly exitButton: HTMLButtonElement;
  private readonly actions: HTMLElement;

  constructor(deps: SummaryDeps) {
    this.element = document.createElement('div');
    this.element.className = 'op-screen eom';
    this.element.hidden = true;

    this.outcome = document.createElement('h1');
    this.outcome.className = 'eom__outcome';

    this.detail = document.createElement('p');
    this.detail.className = 'op-screen__sub';

    this.personal = document.createElement('div');
    this.personal.className = 'eom__personal';

    this.xpSlot = document.createElement('div');
    this.xpSlot.className = 'eom__xp';
    this.xpSlot.hidden = true;

    this.board = new Scoreboard(deps.rowsPerTeam);
    // The same component, shown flat rather than as a hold-to-view overlay.
    this.board.element.classList.add('sb--embedded', 'sb--on');

    /**
     * Two buttons, and only where they mean two different things (playtest round 4, B4).
     *
     * The report asked for an exit and a rematch. Against a dedicated server there is no
     * client-side rematch to give: the server migrates everybody back to the arena on its own
     * clock and the vote cycle running there *is* the next match, so the honest pair is
     * **return to the lobby** — keeping the seat, the socket and the world — and **exit to the
     * main menu**, which drops all three.
     *
     * In single-player the two collapse into the same action, and shipping two buttons that do
     * the same thing is worse than shipping one: `setNetworked` hides the exit there and the
     * primary goes back to reading "Continue".
     */
    this.continueButton = document.createElement('button');
    this.continueButton.type = 'button';
    this.continueButton.className = 'op-btn';
    this.continueButton.textContent = 'Continue';
    this.continueButton.addEventListener('click', () => deps.onContinue());

    this.exitButton = document.createElement('button');
    this.exitButton.type = 'button';
    this.exitButton.className = 'op-btn op-btn--quiet';
    this.exitButton.textContent = 'Exit to main menu';
    this.exitButton.hidden = true;
    this.exitButton.addEventListener('click', () => deps.onExit());

    /**
     * `op-actions`, not a new block, and `op-btn--quiet` for the secondary.
     *
     * Both already exist and both are already correct about the trap round 4's B13 was: a class
     * that sets its own `display` needs an explicit `[hidden]` companion, because the UA rule
     * that makes the attribute work is the lowest-specificity rule there is. `.op-btn` sets no
     * `display`, so `exitButton.hidden` genuinely hides it. Inventing `.eom__actions` here
     * would have been a fresh block with the same hole to forget.
     */
    this.actions = document.createElement('div');
    this.actions.className = 'op-actions';
    this.actions.append(this.continueButton, this.exitButton);

    this.element.append(
      this.outcome,
      this.detail,
      this.personal,
      this.xpSlot,
      this.board.element,
      this.actions,
    );
  }

  /** Bind the mode's scoreboard columns. Same call the in-match board gets. */

  /**
   * How long the **server** is still holding this screen, seconds. `null` when nobody is.
   *
   * Written once per frame by `Game.draw`, from `(endsTick - currentTick) * DT` against the
   * synced server clock — the same derivation the vote overlay's clock has always used. It is
   * not integrated here and there is no local `dt` any more, which is the round-4 fix for B4's
   * timer: a client counting for itself is a second clock for a fact the server owns, and it
   * kept counting through a connection that had gone away.
   *
   * Display only. Reaching zero changes the label and nothing else: the arena arrives when the
   * server migrates everybody, and a client that decided for itself would leave early and stand
   * in a world that has been torn down.
   */
  setRemainingSeconds(seconds: number | null): void {
    const next = seconds === null ? -1 : Math.max(0, Math.ceil(seconds));
    if (next === this.remainingSeconds) return;
    this.remainingSeconds = next;
    this.paintButton();
  }

  private paintButton(): void {
    const left = this.remainingSeconds;
    if (!this.networked) {
      this.continueButton.textContent = 'Continue';
      return;
    }
    this.continueButton.textContent = left > 0 ? `Return to lobby — ${left}s` : 'Return to lobby';
  }

  /**
   * Whether a server is holding this screen.
   *
   * Derived from the connection rather than from the hold it happened to send. They are
   * different facts, and taking `holdSeconds > 0` for the second meant this screen described
   * itself as single-player whenever that number was missing — which now decides a button as
   * well as a label, so a summary that lost its hold would have lost the way off the server
   * with it.
   */
  private networked = false;
  /** Whole seconds left on the server's hold, or -1 for "nobody is holding this". */
  private remainingSeconds = -1;

  setNetworked(on: boolean): void {
    this.networked = on;
    this.exitButton.hidden = !on;
    this.paintButton();
  }

  setColumns(columns: ColumnDef[], modeName: string, mapName: string): void {
    this.board.setColumns(columns, modeName, mapName);
  }

  /**
   * Which seat is reading the board (playtest round 4, B12).
   *
   * This screen is built once at boot and shows every match after it, so unlike `MatchHud`'s
   * board it cannot take the viewer at construction — there is no seat yet. `GameScreens
   * .showSummary` sets it from `match.localTeam`, beside the winner it already passes for
   * exactly the same reason: it is the one place that knows which side this client was on.
   */
  setViewer(viewer: ViewerContext): void {
    this.board.setViewer(viewer);
  }

  show(
    winner: ScoreTeam | 'DRAW',
    localTeam: ScoreTeam,
    reason: string,
    scoreA: number,
    scoreB: number,
    score: ScoreSystem,
  ): void {
    const won = winner === localTeam;
    this.outcome.textContent = winner === 'DRAW' ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    this.outcome.classList.toggle('eom__outcome--win', winner !== 'DRAW' && won);
    this.outcome.classList.toggle('eom__outcome--loss', winner !== 'DRAW' && !won);
    this.detail.textContent = `${reason} · ${scoreA} — ${scoreB}`;

    this.paintPersonal(score);
    this.board.refresh(score);
    this.element.hidden = false;
    this.continueButton.focus();
  }

  hide(): void {
    this.element.hidden = true;
  }

  dispose(): void {
    this.board.dispose();
    this.element.remove();
  }

  /** The local player's own match, in five figures. */
  private paintPersonal(score: ScoreSystem): void {
    const mine = findLocal(score.rows);
    this.personal.replaceChildren();
    if (mine === undefined) return;
    const pct = accuracy(mine);
    const stats: readonly Readonly<[string, string]>[] = [
      ['Score', String(mine.score)],
      ['Kills', String(mine.kills)],
      ['Deaths', String(mine.deaths)],
      ['K/D', killDeath(mine).toFixed(2)],
      ['Accuracy', pct < 0 ? '—' : `${pct.toFixed(0)}%`],
      ['Best streak', String(mine.bestStreak)],
    ];
    for (const [label, value] of stats) {
      const cell = document.createElement('div');
      cell.className = 'eom__stat';
      const l = document.createElement('span');
      l.className = 'op-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'eom__stat-value op-num';
      v.textContent = value;
      cell.append(l, v);
      this.personal.appendChild(cell);
    }
  }
}

function findLocal(rows: readonly PlayerScore[]): PlayerScore | undefined {
  for (const row of rows) {
    if (row.isLocal) return row;
  }
  return undefined;
}
