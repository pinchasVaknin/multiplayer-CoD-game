import type { PlayerScore, ScoreSystem, ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { ColumnDef } from '../../shared/modes/GameMode';
import {
  relationClass,
  relationTo,
  teamLabel,
  teamsInViewOrder,
  type ViewerContext,
} from '../../shared/ui/TeamColour';

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
  /** The two team blocks and the grid holding them, so `setViewer` can reorder and recolour. */
  private readonly grid: HTMLElement;
  private readonly blocks: Record<ScoreTeam, HTMLElement>;
  /** The name-column heading per side. Its text is `ALLIES`/`AXIS` and therefore relative. */
  private readonly teamLabels: Partial<Record<ScoreTeam, HTMLElement>> = {};
  private viewer: ViewerContext = { team: 'A', freeForAll: false };
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

    const blocks: Partial<Record<ScoreTeam, HTMLElement>> = {};
    for (const team of ['A', 'B'] as const) {
      const block = document.createElement('div');
      // The colour class is written by `setViewer`, which is the single writer of everything
      // on this board that depends on which seat is reading it (round 4, B12).
      block.className = 'sb__team';
      blocks[team] = block;

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

    const blockA = blocks.A;
    const blockB = blocks.B;
    if (blockA === undefined || blockB === undefined) {
      throw new Error('Scoreboard failed to build its team blocks');
    }
    this.grid = grid;
    this.blocks = { A: blockA, B: blockB };
    this.applyViewer();
  }

  /**
   * Which seat is reading this board (playtest round 4, B12).
   *
   * Mutable rather than a constructor argument because the two boards have different
   * lifetimes: `MatchHud`'s is built per match and could have taken it once, but the summary's
   * is built at boot by `GameScreens` and outlives every match it shows. One of the two would
   * have had to set it late, and a field that is sometimes set at construction and sometimes
   * afterwards is the shape that ends up unset.
   *
   * Idempotent, so calling it every time a match starts costs a class write and nothing else.
   */
  setViewer(viewer: ViewerContext): void {
    this.viewer = viewer;
    this.applyViewer();
  }

  /**
   * The one writer of everything relative on this board: block colour, block order, heading.
   *
   * Order is DOM order — `appendChild` on an element already in the grid moves it — so the
   * viewer's own side is always the left-hand block. That is half of what B12 reports: a
   * team-B player was reading their score on the right, in red, under a heading that told them
   * they were the Axis.
   */
  private applyViewer(): void {
    for (const team of teamsInViewOrder(this.viewer)) {
      const relation = relationTo(this.viewer, team);
      const block = this.blocks[team];
      block.className = `sb__team sb__team--${relationClass(relation)}`;
      // Re-appending in view order re-sorts the grid without rebuilding either block.
      this.grid.appendChild(block);
      const label = this.teamLabels[team];
      if (label !== undefined) label.textContent = teamLabel(relation);
    }
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
      label.textContent = teamLabel(relationTo(this.viewer, team));
      this.teamLabels[team] = label;
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
