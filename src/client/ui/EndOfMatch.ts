import { accuracy, killDeath, type PlayerScore, type ScoreSystem, type ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { ColumnDef } from '../../shared/modes/GameMode';
import { Scoreboard } from './Scoreboard';

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
  readonly onContinue: () => void;
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

    this.continueButton = document.createElement('button');
    this.continueButton.type = 'button';
    this.continueButton.className = 'op-btn';
    this.continueButton.textContent = 'Continue';
    this.continueButton.addEventListener('click', () => deps.onContinue());

    this.element.append(
      this.outcome,
      this.detail,
      this.personal,
      this.xpSlot,
      this.board.element,
      this.continueButton,
    );
  }

  /** Bind the mode's scoreboard columns. Same call the in-match board gets. */

  /**
   * Say who decides when this screen ends (M11, §6.9).
   *
   * Single-player: the player does, and the button reads "Continue". Over the network the
   * server does — it migrates everybody back to the arena on its own clock — so the button says
   * so rather than implying a choice the player does not have. Pressing it early is still
   * allowed and simply leaves to the menu; what it cannot do is keep them here.
   */
  setReturnSeconds(seconds: number): void {
    this.continueButton.textContent =
      seconds > 0 ? `Continue — back to the arena in ${Math.round(seconds)}s` : 'Continue';
  }

  setColumns(columns: ColumnDef[], modeName: string, mapName: string): void {
    this.board.setColumns(columns, modeName, mapName);
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
