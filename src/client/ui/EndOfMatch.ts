import { accuracy, killDeath, type PlayerScore, type ScoreSystem, type ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { ColumnDef, MatchResult } from '../../shared/modes/GameMode';
import { personalOutcome } from '../../shared/modes/MatchOutcome';
import { relationClass, relationTo, type ViewerContext } from '../../shared/ui/TeamColour';
import type { CharacterAssetService } from '../characters/CharacterAssetService';
import type { CharacterId } from '../characters/CharacterCatalog';
import { CharacterStage, LINEUP_STAGE, type StageFigure } from './CharacterStage';
import { createScreen } from './Frame';
import { lineupOf, slotPositions } from './Lineup';
import { Scoreboard } from './Scoreboard';

/**
 * The post-match summary (brief S6.5; rebuilt on the design frame for M15, Phase D).
 *
 * Three bands on the 1920×1080 frame, and nothing scrolls. **The head**: the result — VICTORY,
 * DEFEAT, a place — the detail line, the local player's own match in six figures, and the
 * LINEUP / SCOREBOARD tabs. **The top**: the lineup — the winning team on B1's `CharacterStage`
 * with a platform under it, the MVP centre and a step forward, each body the one the match
 * dealt that entity (`characterSelector.characterIdFor`, through `LineupSource`) and the local
 * player in the skin they picked (B5), holding their last weapon, nameplates in team colour
 * under their feet; or, on the SCOREBOARD tab, the board — the same `Scoreboard` the player
 * has been holding Tab on all match, not a second implementation of it. Two boards that
 * format the same numbers differently is exactly how a summary screen ends up disagreeing
 * with the match it is summarising. **The band**: fixed height, bottom-anchored, holding the
 * XP accordion (`XpSummary`, in `xpSlot`) and, at its right end, CONTINUE and EXIT, which
 * never move.
 *
 * **The XP insertion point.** `xpSlot` is the band's left cell; `GameScreens` appends the
 * `XpSummary` to it and hides it for a mode that banks nothing. It is not a placeholder bar
 * animating to a fake number: a summary screen that shows invented progression is worse than
 * one that shows none.
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
  /** The skins, for the lineup (D1). The same service the match drew the bodies from. */
  readonly characterAssets: CharacterAssetService;
  readonly anisotropy: () => number;
}

/**
 * What the lineup needs to know about an entity that the board does not carry (D1): which
 * body it wore and what it held. `Game` answers from the world's own character selector and
 * the renderer's actor list; the layout probe answers with a fixture.
 */
export interface LineupSource {
  /** The body the match dealt this entity — or, for the local player, the skin they picked. */
  characterIdFor(entityId: number): CharacterId;
  /** What this entity was last holding, or null for a body the screen never saw armed. */
  weaponIdFor(entityId: number): string | null;
}

/** Just in front of the toes, where the nameplate hangs. Metres. */
const PLATE_LEAD = 0.42;

export class EndOfMatch {
  readonly element: HTMLElement;
  /** M6 appends the XP breakdown here. Empty and hidden until it does. */
  readonly xpSlot: HTMLElement;

  private readonly outcome: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly personal: HTMLElement;
  private readonly lineupTab: HTMLButtonElement;
  private readonly boardTab: HTMLButtonElement;
  private readonly stageBox: HTMLElement;
  private readonly stage: CharacterStage;
  private readonly plates: HTMLElement;
  private readonly board: Scoreboard;
  private readonly continueButton: HTMLButtonElement;
  private readonly exitButton: HTMLButtonElement;
  private readonly actions: HTMLElement;
  private viewer: ViewerContext = { team: 'A', freeForAll: false };

  constructor(deps: SummaryDeps) {
    const { layer, frame } = createScreen('op-screen eom');
    this.element = layer;
    this.element.hidden = true;

    // ---- the head ----
    const head = document.createElement('div');
    head.className = 'eom__head';

    const titles = document.createElement('div');
    titles.className = 'eom__titles';
    this.outcome = document.createElement('h1');
    this.outcome.className = 'eom__outcome';
    this.detail = document.createElement('p');
    this.detail.className = 'eom__detail op-screen__sub';
    titles.append(this.outcome, this.detail);

    this.personal = document.createElement('div');
    this.personal.className = 'eom__personal';

    const tabs = document.createElement('div');
    tabs.className = 'eom__tabs';
    tabs.setAttribute('role', 'tablist');
    this.lineupTab = makeTab('Lineup');
    this.boardTab = makeTab('Scoreboard');
    this.lineupTab.addEventListener('click', () => this.showBoard(false));
    this.boardTab.addEventListener('click', () => this.showBoard(true));
    tabs.append(this.lineupTab, this.boardTab);

    head.append(titles, this.personal, tabs);

    // ---- the top: the lineup, or the board ----
    const top = document.createElement('div');
    top.className = 'eom__top';

    this.stageBox = document.createElement('div');
    this.stageBox.className = 'eom-stage';
    this.stage = new CharacterStage({ characterAssets: deps.characterAssets, anisotropy: deps.anisotropy }, LINEUP_STAGE);
    this.plates = document.createElement('div');
    this.plates.className = 'eom-stage__plates';
    this.stageBox.append(this.stage.canvas, this.plates);

    this.board = new Scoreboard(deps.rowsPerTeam);
    // The same component, shown flat rather than as a hold-to-view overlay.
    this.board.element.classList.add('sb--embedded', 'sb--on');
    this.board.element.hidden = true;

    top.append(this.stageBox, this.board.element);

    // ---- the band: the XP accordion, and the way out ----
    const band = document.createElement('div');
    band.className = 'eom__band';

    this.xpSlot = document.createElement('div');
    this.xpSlot.className = 'eom__xp';
    this.xpSlot.hidden = true;

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
    this.actions.className = 'op-actions eom__actions';
    this.actions.append(this.continueButton, this.exitButton);

    band.append(this.xpSlot, this.actions);

    frame.append(head, top, band);
  }

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

  /** Bind the mode's scoreboard columns. Same call the in-match board gets. */
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
   * The nameplates on the platform read it too: a colour is a relation to the viewer.
   */
  setViewer(viewer: ViewerContext): void {
    this.viewer = viewer;
    this.board.setViewer(viewer);
  }

  /**
   * The headline and the detail line, per recipient (M13 Phase A, bug 4.4).
   *
   * `personalOutcome` decides what this seat reads — VICTORY, DEFEAT, DRAW, or in a mode that
   * crowned one individual, that individual's VICTORY and everybody else's place. The seat is
   * a side *and* an entity, because in Free-for-All the side is substrate and three of every
   * four players on the winner's side did not win.
   *
   * The detail line names the winner where there is one to name: in a team mode the two team
   * scores say who won, and in Free-for-All `scoreA — scoreB` are the leader's and the
   * runner-up's kills, which say nothing about *who* unless the leader is named.
   *
   * Then the lineup (D1): `lineupOf` decides who stands on the platform and `slotPositions`
   * where; `lineup` says what body and what weapon each of them gets. The board is refreshed
   * behind the LINEUP tab, which is the one the screen opens on.
   */
  show(result: MatchResult, localTeam: ScoreTeam, localId: number, score: ScoreSystem, lineup: LineupSource): void {
    const outcome = personalOutcome(result, localTeam, localId, score.rows);
    this.outcome.textContent = outcome.label;
    this.outcome.classList.toggle('eom__outcome--win', outcome.kind === 'WIN');
    this.outcome.classList.toggle('eom__outcome--loss', outcome.kind === 'LOSS');
    const winnerName =
      result.winnerEntityId === undefined ? '' : nameOf(score.rows, result.winnerEntityId);
    this.detail.textContent =
      winnerName === ''
        ? `${result.reason} · ${result.scoreA} — ${result.scoreB}`
        : `${winnerName} wins · ${result.reason} · ${result.scoreA} — ${result.scoreB}`;

    this.paintPersonal(score);
    this.board.refresh(score);

    const rows = lineupOf(result, score.rows, this.viewer.freeForAll);
    const slots = slotPositions(rows.length);
    const figures: StageFigure[] = [];
    this.plates.replaceChildren();
    rows.forEach((row, index) => {
      const slot = slots[index];
      if (slot === undefined) return;
      figures.push({
        characterId: lineup.characterIdFor(row.entityId),
        weaponId: lineup.weaponIdFor(row.entityId),
        x: slot.x,
        z: slot.z,
        yaw: slot.yaw,
      });
      this.plates.appendChild(this.plateFor(row, index === 0, this.stage.projectToCanvas(slot.x, 0, slot.z + PLATE_LEAD)));
    });
    this.stage.showLineup(figures);

    this.showBoard(false);
    this.element.hidden = false;
    this.continueButton.focus();
  }

  /** The SCOREBOARD tab, or the LINEUP tab. The probe measures both. */
  showBoard(on: boolean): void {
    this.stageBox.hidden = on;
    this.board.element.hidden = !on;
    this.lineupTab.setAttribute('aria-selected', on ? 'false' : 'true');
    this.boardTab.setAttribute('aria-selected', on ? 'true' : 'false');
    this.lineupTab.classList.toggle('is-on', !on);
    this.boardTab.classList.toggle('is-on', on);
  }

  /** One frame of the lineup. Driven from `Game.draw`, so it stops with the frame loop. */
  tick(dt: number): void {
    if (this.element.hidden || this.stageBox.hidden) return;
    this.stage.tick(dt);
  }

  hide(): void {
    this.element.hidden = true;
    // The bodies go with the screen: a lineup nobody is looking at is five skins held for nothing.
    this.stage.release();
  }

  dispose(): void {
    this.stage.dispose();
    this.board.dispose();
    this.element.remove();
  }

  /** The local player's own match, in six figures. */
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

  /**
   * A nameplate under a figure's feet: the callsign in the team's colour — a relation to the
   * viewer, as the board's is — the score, and MVP on the first. Positioned as fractions of
   * the canvas from the lens's own projection, so it lands where the body stands at any
   * frame scale; the canvas's CSS box keeps the lens's aspect for exactly this reason.
   */
  private plateFor(row: PlayerScore, mvp: boolean, at: { readonly u: number; readonly v: number }): HTMLElement {
    const plate = document.createElement('div');
    plate.className = `eom-plate eom-plate--${relationClass(relationTo(this.viewer, row.team))}`;
    if (row.isLocal) plate.classList.add('eom-plate--local');
    plate.style.left = `${(at.u * 100).toFixed(2)}%`;
    plate.style.top = `${(at.v * 100).toFixed(2)}%`;
    const name = document.createElement('span');
    name.className = 'eom-plate__name';
    name.textContent = row.displayName;
    const sub = document.createElement('span');
    sub.className = 'eom-plate__sub op-num';
    sub.textContent = mvp ? `MVP · ${row.score.toLocaleString()}` : row.score.toLocaleString();
    plate.append(name, sub);
    return plate;
  }
}

function makeTab(label: string): HTMLButtonElement {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'eom__tab';
  tab.setAttribute('role', 'tab');
  tab.textContent = label;
  return tab;
}

function findLocal(rows: readonly PlayerScore[]): PlayerScore | undefined {
  for (const row of rows) {
    if (row.isLocal) return row;
  }
  return undefined;
}

/** A row's callsign, or empty for an entity the board has no row for. */
function nameOf(rows: readonly PlayerScore[], entityId: number): string {
  for (const row of rows) {
    if (row.entityId === entityId) return row.displayName;
  }
  return '';
}
