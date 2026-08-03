import type { PlayerScore, ScoreSystem, ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { ColumnDef } from '../../shared/modes/GameMode';

/**
 * The scoreboard, on held Tab (brief S6.5).
 *
 * Columns come from `GameMode.getScoreboardColumns()` and nothing here knows what a column
 * means — which is the point: Domination's captures and Kill Confirmed's tags become new
 * columns in those modes rather than new branches in this file.
 *
 * Rows are preallocated to the roster size once, so opening the board mid-firefight does no
 * layout beyond the reflow of showing it. It refreshes at 6 Hz while open and not at all
 * while closed, because a scoreboard that repaints sixty times a second is a scoreboard that
 * costs frames during the one moment the player is standing still and safe.
 */

const REFRESH_HZ = 6;

interface Row {
  readonly el: HTMLElement;
  readonly name: HTMLElement;
  readonly cells: HTMLElement[];
  readonly last: string[];
  lastName: string;
  bound: PlayerScore | null;
}

export class Scoreboard {
  readonly element: HTMLElement;

  private readonly teamHeads: Record<ScoreTeam, HTMLElement>;
  private readonly bodies: Record<ScoreTeam, HTMLElement>;
  private readonly rows: Record<ScoreTeam, Row[]> = { A: [], B: [] };
  private readonly title: HTMLElement;
  private columns: ColumnDef[] = [];
  private open = false;
  private accumulator = 0;
  /** Reused sort buffer, so opening the board allocates nothing. */
  private readonly sortBuffer: PlayerScore[] = [];

  constructor(rowsPerTeam: number) {
    this.element = document.createElement('div');
    this.element.className = 'sb';

    this.title = document.createElement('div');
    this.title.className = 'sb__title op-label';
    this.element.appendChild(this.title);

    const grid = document.createElement('div');
    grid.className = 'sb__grid';
    this.element.appendChild(grid);

    const heads: Partial<Record<ScoreTeam, HTMLElement>> = {};
    const bodies: Partial<Record<ScoreTeam, HTMLElement>> = {};

    for (const team of ['A', 'B'] as const) {
      const block = document.createElement('div');
      block.className = `sb__team sb__team--${team === 'A' ? 'friendly' : 'hostile'}`;

      const head = document.createElement('div');
      head.className = 'sb__head';
      block.appendChild(head);
      heads[team] = head;

      const body = document.createElement('div');
      body.className = 'sb__body';
      block.appendChild(body);
      bodies[team] = body;

      for (let i = 0; i < rowsPerTeam; i++) {
        const el = document.createElement('div');
        el.className = 'sb__row';
        el.hidden = true;
        const name = document.createElement('span');
        name.className = 'sb__name';
        el.appendChild(name);
        body.appendChild(el);
        this.rows[team].push({ el, name, cells: [], last: [], lastName: '', bound: null });
      }

      grid.appendChild(block);
    }

    const headA = heads.A;
    const headB = heads.B;
    const bodyA = bodies.A;
    const bodyB = bodies.B;
    if (headA === undefined || headB === undefined || bodyA === undefined || bodyB === undefined) {
      throw new Error('Scoreboard failed to build its team blocks');
    }
    this.teamHeads = { A: headA, B: headB };
    this.bodies = { A: bodyA, B: bodyB };
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Bind the mode's columns. Called once per match, because the columns are a property of
   * the mode and the mode does not change mid-match.
   */
  setColumns(columns: ColumnDef[], modeName: string, mapName: string): void {
    this.columns = columns;
    this.title.textContent = `${modeName} · ${mapName}`;

    const template = `minmax(96px, 1fr) ${columns.map((c) => `${c.width}ch`).join(' ')}`;
    for (const team of ['A', 'B'] as const) {
      const head = this.teamHeads[team];
      head.replaceChildren();
      head.style.gridTemplateColumns = template;
      const label = document.createElement('span');
      label.className = 'sb__col sb__col--name';
      label.textContent = team === 'A' ? 'ALLIES' : 'AXIS';
      head.appendChild(label);
      for (const column of columns) {
        const cell = document.createElement('span');
        cell.className = `sb__col sb__col--${column.align}`;
        cell.textContent = column.label;
        head.appendChild(cell);
      }
      this.bodies[team].style.setProperty('--sb-cols', template);

      for (const row of this.rows[team]) {
        row.el.style.gridTemplateColumns = template;
        row.cells.length = 0;
        row.last.length = 0;
        row.el.replaceChildren(row.name);
        for (const column of columns) {
          const cell = document.createElement('span');
          cell.className = `sb__cell sb__cell--${column.align} op-num`;
          row.el.appendChild(cell);
          row.cells.push(cell);
          row.last.push('');
        }
      }
    }
  }

  setOpen(on: boolean, score: ScoreSystem): void {
    if (on === this.open) return;
    this.open = on;
    this.element.classList.toggle('sb--on', on);
    // Refresh immediately on open rather than waiting up to a sixth of a second: the board
    // is asked for at exactly the moment its contents matter.
    if (on) this.refresh(score);
    this.accumulator = 0;
  }

  /** Called once per rendered frame. Does nothing while closed. */
  update(dt: number, score: ScoreSystem): void {
    if (!this.open) return;
    this.accumulator += dt;
    if (this.accumulator < 1 / REFRESH_HZ) return;
    this.accumulator = 0;
    this.refresh(score);
  }

  /** Fill the board once. Also used by the end-of-match summary. */
  refresh(score: ScoreSystem): void {
    for (const team of ['A', 'B'] as const) {
      this.sortBuffer.length = 0;
      for (const row of score.rows) {
        if (row.team === team) this.sortBuffer.push(row);
      }
      // Score, then kills, then fewest deaths. The CoD ordering, and stable enough that a
      // row does not jump while the player is reading it.
      this.sortBuffer.sort(
        (a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths,
      );

      const rows = this.rows[team];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row === undefined) continue;
        const data = this.sortBuffer[i];
        if (data === undefined) {
          if (!row.el.hidden) row.el.hidden = true;
          row.bound = null;
          continue;
        }
        if (row.el.hidden) row.el.hidden = false;
        if (row.bound !== data) {
          row.bound = data;
          row.el.classList.toggle('sb__row--local', data.isLocal);
        }
        if (data.displayName !== row.lastName) {
          row.lastName = data.displayName;
          row.name.textContent = data.displayName;
        }
        for (let c = 0; c < this.columns.length; c++) {
          const column = this.columns[c];
          const cell = row.cells[c];
          if (column === undefined || cell === undefined) continue;
          const text = column.value(data);
          if (text === row.last[c]) continue;
          row.last[c] = text;
          cell.textContent = text;
        }
      }
    }
  }

  dispose(): void {
    this.element.remove();
  }
}
