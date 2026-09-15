import { createGameBus } from '../../shared/core/Events';
import { ScoreSystem, type ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { ColumnDef } from '../../shared/modes/GameMode';
import { defaultSettings } from '../../shared/meta/SaveData';
import { XP_SOURCES, type XpLine, type XpLines, type XpReport } from '../../shared/meta/XpRules';
import { ALL_WEAPONS } from '../../shared/weapons/WeaponDefs';
import { playability } from '../../shared/ui/Capabilities';
import {
  DEFAULT_MAP_ID,
  DEFAULT_MODE_ID,
  MAPS,
  MODES,
  modesForMap,
} from '../../shared/modes/ModeRegistry';
import { CharacterAssetService } from '../characters/CharacterAssetService';
import { BOT_CHARACTER_IDS, DEFAULT_CHARACTER_ID } from '../characters/CharacterCatalog';
import { Profile } from '../meta/Profile';
import { DEFAULT_CAMERA_CONFIG } from '../player/CameraConfig';
import { EndOfMatch, type LineupSource } from '../ui/EndOfMatch';
import { LoadoutEditor } from '../ui/LoadoutEditor';
import { Menus, type MenuSelection } from '../ui/Menus';
import { PauseMenu } from '../ui/PauseMenu';
import { Settings } from '../ui/Settings';
import { XpSummary } from '../ui/XpSummary';
import { applyFrameScale } from '../ui/Frame';
import { PROBE_VIEWPORTS, type Viewport } from './Viewports';

/**
 * The layout probe's page half (playtest round 5, P1; rewritten for M15, A1).
 *
 * B1, B2 and B3 were all reported as "it looks cut off", and all three were found with a
 * `getBoundingClientRect()` against a stated viewport. P0 rule 7 draws the conclusion: a
 * layout bug on this project is a **number**, not something a human has to notice, so this
 * mounts every full-screen surface at a list of viewports and asserts one thing about each.
 *
 * ## The rule: nothing scrolls, nothing is clipped, nothing leaves the window
 *
 * M15's rule for the front end is that nothing scrolls at any window size, and the mechanism
 * is the design frame (`ui/Frame.ts`): every screen is laid out at 1920x1080 and the frame is
 * `zoom`ed to the window. So the probe asks, of every laid-out element on a mounted screen:
 *
 * - **Outside.** Its rect is wholly inside the viewport. No scroll is attempted first — the
 *   old rule scrolled each element into view and asked whether *that* had worked, because
 *   vertical overflow was then "a legitimate answer to a long screen". It is not one now, so
 *   an element off any edge is a violation on the spot, and an element larger than the
 *   viewport on an axis is one too rather than a thing to skip.
 * - **Overflow.** If it clips or scrolls (`overflow` other than `visible` on an axis), its
 *   content fits it: `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth`. This is
 *   the rule that sees a scroller — `.op-settings`' binding list, the editor's option list —
 *   and the one that sees the frame itself clip a screen that is over height, which is how
 *   A1's first measurement was taken. B3's *sideways* is the x-axis case of it. Two
 *   exemptions, both designed truncations of one string rather than a scroll: a single-line
 *   ellipsis (`text-overflow: ellipsis` with `white-space: nowrap`) on the x axis, and a line
 *   clamp (`-webkit-line-clamp`) on the y axis — the editor's tile blurbs are cut at two
 *   lines on purpose, and the cut is the design.
 *
 * One finding per cause. `getBoundingClientRect()` does not know about clipping, so every row
 * a scroller has scrolled past is also "outside the window" by the first rule — the first run
 * of this version reported one binding list as thirty-eight lines. An element that an
 * ancestor clips on an axis is therefore not reported as outside on that axis: the ancestor's
 * overflow line is the finding, and the row count is in its detail.
 *
 * Both are reported in window pixels, as the browser sees them; the content size beside each
 * screen is in **frame** pixels (window pixels over `--ui-scale`), because "1336 tall in a
 * 1080 frame" is the number a fix is written against and it is the same at every viewport.
 *
 * ## What it deliberately does not do
 *
 * It renders nothing and starts no game. There is no canvas on the page, `WeaponPreview`
 * builds its `WebGLRenderer` on the first `tick()` and nothing here ticks, so the whole probe
 * is layout and computed style. That is the half of the front end a headless run can be
 * honest about; anything about how it *looks* is still a browser pass.
 */

/** Half a pixel. Sub-pixel layout rounds, and a 0.4px overhang is not a bug report. */
const EPSILON = 0.5;

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

export interface Violation {
  readonly rule: 'outside' | 'overflow';
  readonly axis: 'x' | 'y';
  readonly element: string;
  /** Where it sat, in window pixels. The reported number. */
  readonly rect: Rect;
  readonly detail: string;
}

export interface ScreenReport {
  readonly screen: string;
  /** How tall the screen's content is in frame pixels, from the union of its children's boxes. */
  readonly contentHeight: number;
  /** How wide, the same way. */
  readonly contentWidth: number;
  readonly elements: number;
  readonly violations: Violation[];
}

export interface ProbeRun {
  readonly width: number;
  readonly height: number;
  /** `--ui-scale` at this viewport: frame pixels times this are window pixels. */
  readonly scale: number;
  readonly screens: ScreenReport[];
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    top: r.top,
    left: r.left,
    bottom: r.bottom,
    right: r.right,
    width: r.width,
    height: r.height,
  };
}

/** Enough of an element to find it again in a stylesheet. */
function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const classes = el.getAttribute('class');
  const selector = classes === null ? tag : tag + '.' + classes.trim().split(/\s+/).join('.');
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return text === '' ? selector : `${selector} "${text}"`;
}

function measure(screen: string, layer: HTMLElement, scale: number): ScreenReport {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const violations: Violation[] = [];
  const all: HTMLElement[] = [layer, ...Array.from(layer.querySelectorAll<HTMLElement>('*'))];

  /*
   * The content's own extent, so the report carries the same kind of number B1 and B2 were
   * written with. Measured off the layer's descendants rather than off `scrollHeight`, which
   * cannot see content sitting above the origin — that blind spot is why the old report's
   * "content height is 744px" and its "title at y = -118" did not add up to each other.
   */
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;

  const laid: HTMLElement[] = [];
  for (const el of all) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    laid.push(el);
    // The layer is the window and the frame is the frame; the content is what is in it.
    if (el === layer || el.classList.contains('op-frame')) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }

  /** Whether some ancestor up to the layer clips `el` on this axis — then it is that ancestor's finding. */
  const clippedByAncestor = (el: HTMLElement, axis: 'x' | 'y'): boolean => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a !== null && a !== layer.parentElement; a = a.parentElement) {
      const style = getComputedStyle(a);
      const clips = axis === 'y' ? style.overflowY !== 'visible' : style.overflowX !== 'visible';
      if (!clips) continue;
      const box = a.getBoundingClientRect();
      const out =
        axis === 'y'
          ? r.top < box.top - EPSILON || r.bottom > box.bottom + EPSILON
          : r.left < box.left - EPSILON || r.right > box.right + EPSILON;
      if (out) return true;
    }
    return false;
  };

  for (const el of laid) {
    const rect = rectOf(el);
    if ((rect.top < -EPSILON || rect.bottom > vh + EPSILON) && !clippedByAncestor(el, 'y')) {
      violations.push({
        rule: 'outside',
        axis: 'y',
        element: describe(el),
        rect,
        detail:
          rect.top < -EPSILON
            ? `${(-rect.top).toFixed(0)}px above the top of a ${vh}px window`
            : `${(rect.bottom - vh).toFixed(0)}px below the bottom of a ${vh}px window`,
      });
    }
    if ((rect.left < -EPSILON || rect.right > vw + EPSILON) && !clippedByAncestor(el, 'x')) {
      violations.push({
        rule: 'outside',
        axis: 'x',
        element: describe(el),
        rect,
        detail:
          rect.left < -EPSILON
            ? `${(-rect.left).toFixed(0)}px off the left of a ${vw}px window`
            : `${(rect.right - vw).toFixed(0)}px off the right of a ${vw}px window`,
      });
    }
  }

  for (const el of laid) {
    const style = getComputedStyle(el);
    const rect = rectOf(el);
    // `scrollHeight` and `clientHeight` are both in the element's own (zoomed) pixels, so the
    // comparison holds at any scale and the numbers in the message are frame pixels.
    const spillY = el.scrollHeight - el.clientHeight;
    const spillX = el.scrollWidth - el.clientWidth;
    const clamped = style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '';
    if (style.overflowY !== 'visible' && spillY > 1 && !clamped) {
      violations.push({
        rule: 'overflow',
        axis: 'y',
        element: describe(el),
        rect,
        detail: `${el.scrollHeight}px of content in a ${el.clientHeight}px box (overflow-y: ${style.overflowY})`,
      });
    }
    const ellipsis = style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap';
    if (style.overflowX !== 'visible' && spillX > 1 && !ellipsis) {
      violations.push({
        rule: 'overflow',
        axis: 'x',
        element: describe(el),
        rect,
        detail: `${el.scrollWidth}px of content in a ${el.clientWidth}px box (overflow-x: ${style.overflowX})`,
      });
    }
  }

  return {
    screen,
    contentHeight: laid.length > 1 ? Math.round((bottom - top) / scale) : 0,
    contentWidth: laid.length > 1 ? Math.round((right - left) / scale) : 0,
    elements: laid.length,
    violations,
  };
}

// -- the surfaces ------------------------------------------------------------

/** Typed non-null, so the hoisted helpers below do not each have to re-narrow it. */
function uiRoot(): HTMLElement {
  const found = document.getElementById('ui-root');
  if (found === null) throw new Error('layout probe: the page has no #ui-root');
  return found;
}

const host = uiRoot();

const profile = new Profile({
  fallbackSettings: defaultSettings(DEFAULT_MODE_ID, DEFAULT_MAP_ID, DEFAULT_CAMERA_CONFIG.fov),
});

const selection: MenuSelection = {
  modeId: DEFAULT_MODE_ID,
  mapId: DEFAULT_MAP_ID,
  difficulty: 'MIX',
};

const noop = (): void => {};

const menus = new Menus({
  host,
  selection,
  onLaunch: noop,
  onPlayMultiplayer: noop,
  // True, because a disabled Play Multiplayer button is one control shorter and therefore a
  // shorter menu. The probe has to measure the taller of the two.
  serverConfigured: () => true,
  displayName: () => profile.settings.callsign,
  onDisplayName: noop,
  onLoadout: noop,
  onSettings: noop,
  statusLine: () => 'LAYOUT PROBE',
  profileLine: () => 'LEVEL 1 · ASSAULT · 0 / 500 XP',
});

const settings = new Settings({
  host,
  read: () => profile.settings,
  onChange: noop,
  onBack: noop,
  onResetBindings: noop,
  onResetProgress: noop,
});

const pause = new PauseMenu({
  host,
  onResume: noop,
  onToggleDebug: noop,
  onQuit: noop,
  statusLine: () => 'FOUNDRY · TEAM DEATHMATCH · 42 — 39',
  onCheatCode: noop,
});
// The debug button is an entitlement the pause screen shows only to a session that has typed
// `DEBUG666`. On here for the same reason `serverConfigured` is true: the tallest legal
// version of a screen is the one that has to fit.
pause.setDebugAvailable(true);

/**
 * A skin service whose repository never answers: the stage asks for a body when the editor
 * or the summary is shown, and this page measures layout — a 4 MB fetch per surface would be
 * a download with no reader, and a body that arrived would change nothing the probe measures.
 */
const characterAssets = new CharacterAssetService({ preload: () => new Promise(() => undefined), dispose: noop });

const summary = new EndOfMatch({ rowsPerTeam: 8, onContinue: noop, onExit: noop, characterAssets, anisotropy: () => 1 });
host.appendChild(summary.element);

/**
 * The XP accordion in the summary's band (M15, D2), with the two cues stubbed: the cadence's
 * `requestAnimationFrame` loop runs on this page as it does in the client, and a probe that
 * measured the band without the accordion in it would measure the easy state.
 */
const xpSummary = new XpSummary({ audio: { playXpTick: noop, playLevelUp: noop } });
summary.xpSlot.appendChild(xpSummary.element);
// `GameScreens.showSummary` un-hides the slot for a mode that banks; every summary here does.
summary.xpSlot.hidden = false;

const loadout = new LoadoutEditor({
  host,
  profile,
  onSaveAndExit: noop,
  unrestricted: () => false,
  anisotropy: () => 1,
  characterAssets,
});

/**
 * The widest scoreboard any shipped mode asks for, derived rather than transcribed.
 *
 * `ColumnDef.width` is in `ch` and the row template is `minmax(96px, 1fr)` followed by one
 * fixed track per column, so the mode with the most `ch` is the mode whose board is hardest
 * to fit — and B3 is a board that does not fit. Every mode is built the way `auditModeBriefs`
 * builds them (a throwaway bus and score, an empty roster, the first map that authors its
 * objectives), so a sixth mode with an eighth column is covered by this probe on the day it
 * is added rather than on the day somebody reports it.
 */
function widestColumns(): { columns: ColumnDef[]; modeName: string; mapName: string } {
  let best: { columns: ColumnDef[]; modeName: string; mapName: string } | null = null;
  let bestWidth = -1;
  for (const entry of MODES) {
    const map = MAPS.find((m) => modesForMap(m.id).some((mode) => mode.id === entry.id));
    if (map === undefined) continue;
    const mode = entry.create({
      bus: createGameBus(),
      score: new ScoreSystem(createGameBus()),
      roster: [],
      mapDef: map.def,
    });
    const columns = mode.getScoreboardColumns();
    const width = columns.reduce((sum, c) => sum + c.width, 0);
    if (width <= bestWidth) continue;
    bestWidth = width;
    best = { columns, modeName: entry.name, mapName: map.name };
  }
  if (best === null) throw new Error('layout probe: no mode could be built on any map');
  return best;
}

/** A board of `perTeam` a side, the local player among them, plausible callsigns. Eight a side is full. */
function boardOf(perTeam: number): ScoreSystem {
  const score = new ScoreSystem(createGameBus());
  const teams: readonly ScoreTeam[] = ['A', 'B'];
  let id = 1;
  for (const team of teams) {
    for (let i = 0; i < perTeam; i++) {
      const name = `${team === 'A' ? 'ALLY' : 'HOSTILE'}-${String(id).padStart(3, '0')}`;
      const row = score.register(id, name, team);
      if (row !== undefined) {
        row.isLocal = id === 1;
        row.kills = 12 + i;
        row.deaths = 9 + i;
        row.score = 1200 + i * 137;
        row.bestStreak = 4 + i;
        row.shotsFired = 240 + i * 7;
        row.shotsHit = 96 + i * 3;
        row.captures = i;
        row.defends = i;
        row.plants = i % 3;
        row.defuses = i % 2;
        row.tags = i;
      }
      id++;
    }
  }
  return score;
}

const board = widestColumns();
summary.setColumns(board.columns, board.modeName, board.mapName);
summary.setNetworked(true);
const boardScore = boardOf(8);

/**
 * What each podium body wears and holds (D1): the catalogue dealt round by entity id, and the
 * widest weapon in the arsenal — the plates are what the probe measures, and a body that never
 * arrives (see `characterAssets`) has no width of its own.
 */
const lineupFixture: LineupSource = {
  characterIdFor: (entityId) => BOT_CHARACTER_IDS[entityId % BOT_CHARACTER_IDS.length] ?? DEFAULT_CHARACTER_ID,
  weaponIdFor: () => ALL_WEAPONS[0]?.id ?? null,
};

/**
 * The fullest report the accordion can be handed (D2): every source in the table with a count
 * that prints, and a tail of two of each unlock kind. The list's ceiling is measured against
 * this, and a thirteenth source or a taller tag is a red run here before it is a clipped row
 * on a screen.
 */
function fullestReport(): XpReport {
  const lines = XP_SOURCES.map<XpLine>((source) => ({
    id: source.id,
    label: source.label,
    count: source.kind === 'each' ? 12 : 1,
    xp: source.value * (source.kind === 'each' ? 12 : 1),
    kind: source.kind,
  }));
  const head = lines[0];
  if (head === undefined) throw new Error('layout probe: XP_SOURCES is empty');
  const total = lines.reduce((sum, line) => sum + line.xp, 0);
  return {
    lines: [head, ...lines.slice(1)] as unknown as XpLines,
    total,
    xpBefore: 12_000,
    levelBefore: 7,
    levelAfter: 9,
    weaponLevelUps: ['ar_m4', 'smg_mp5'].filter((id) => ALL_WEAPONS.some((w) => w.id === id)),
    challengesCompleted: ['first_blood', 'double_kill'],
    camosUnlocked: ['digital', 'tiger'],
  };
}

/** A team-mode result for `perTeam` a side: B wins, so the podium is the far side of the board. */
function teamResult(perTeam: number): { show: () => HTMLElement; hide: () => void } {
  const score = boardOf(perTeam);
  return {
    show: () => {
      summary.show(
        { kind: 'match', winner: 'B', reason: 'SCORE LIMIT', scoreA: 68, scoreB: 75, roundsA: 0, roundsB: 1 },
        'A',
        1,
        score,
        lineupFixture,
      );
      xpSummary.play(fullestReport());
      return summary.element;
    },
    hide: () => {
      xpSummary.stop();
      summary.hide();
    },
  };
}

/** Click a button by its exact label, and say so loudly when it is no longer there. */
function click(within: HTMLElement, label: string): void {
  for (const button of Array.from(within.querySelectorAll('button'))) {
    if ((button.textContent ?? '').trim() === label) {
      button.click();
      return;
    }
  }
  throw new Error(`layout probe: no button labelled "${label}" on this screen`);
}

function layerOf(selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`layout probe: no "${selector}" in the page`);
  return found;
}

/** The main menu and the setup page are the same layer: the one with no modifier class. */
const PLAIN_SCREEN = '.op-screen:not(.eom):not(.lo):not(.op-screen--pause):not(.op-screen--wide)';

/**
 * Every surface, and how to put it on screen.
 *
 * Each entry shows itself, is measured, and hides itself again, so no screen is ever measured
 * through another one's backdrop. The setup page and the four settings tabs are reached by
 * clicking the controls that reach them in the real client rather than by poking at private
 * state: the point of measuring is to measure what a player gets.
 */
const SURFACES: readonly Readonly<{ name: string; show: () => HTMLElement; hide: () => void }>[] = [
  {
    name: 'menu',
    show: () => {
      menus.show();
      return layerOf(PLAIN_SCREEN);
    },
    hide: () => menus.hide(),
  },
  {
    /**
     * The device gate (playtest round 5, F1).
     *
     * Measured here because it is a new full-screen surface and P0 rule 7 is explicit that a
     * layout claim which can be a rect should be one — and because the *only* viewport this
     * screen is ever shown at is a small one. It is the answer to "your device is too small to
     * play", so a version of it that is itself cut off at 375x812 would be a joke at the
     * player's expense.
     *
     * The longest copy of the two verdicts, not an arbitrary one: `no-fine-pointer` is the
     * message a phone actually gets, and it is the one with three lines of body text under the
     * headline.
     */
    name: 'unsupported',
    show: () => {
      const verdict = playability({
        maxTouchPoints: 5,
        finePointer: false,
        coarsePointer: true,
        hasPointerLock: true,
      });
      menus.showUnsupported(verdict.headline, verdict.detail);
      return layerOf(PLAIN_SCREEN);
    },
    hide: () => menus.hide(),
  },
  {
    name: 'solo-setup',
    show: () => {
      menus.show();
      const layer = layerOf(PLAIN_SCREEN);
      click(layer, 'PLAY SOLO');
      return layer;
    },
    hide: () => menus.hide(),
  },
  ...(['CONTROLS', 'BINDINGS', 'AUDIO', 'VIDEO', 'INFO'] as const).map((tab) => ({
    name: `settings/${tab}`,
    show: (): HTMLElement => {
      settings.show();
      const layer = layerOf('.op-screen--wide');
      click(layer, tab);
      return layer;
    },
    hide: (): void => settings.hide(),
  })),
  {
    name: 'pause',
    show: () => {
      pause.show();
      return layerOf('.op-screen--pause');
    },
    hide: () => pause.hide(),
  },
  /**
   * The summary at three roster sizes, the accordion folded and open (M15, Gate D). Folded is
   * the state the screen opens in — the strip, the lineup, the buttons; open is the state it
   * reaches when the cadence finishes, taken instantly here (`open(true)`) because the probe
   * measures in the task it shows in, and it wants the geometry the client reaches
   * `--dur-med` later rather than the first keyframe of it. The fullest report the accordion
   * can be handed is what opens.
   */
  ...([2, 6, 10] as const).flatMap((players) => {
    const fixture = teamResult(players / 2);
    return [
      { name: `summary/${players}`, show: fixture.show, hide: fixture.hide },
      {
        name: `summary/${players}/xp`,
        show: (): HTMLElement => {
          const layer = fixture.show();
          xpSummary.finish();
          xpSummary.open(true);
          return layer;
        },
        hide: fixture.hide,
      },
    ];
  }),
  /** The SCOREBOARD tab over a full team board: two blocks of eight, side by side at the frame's width. */
  {
    name: 'summary/board',
    show: () => {
      summary.show(
        { kind: 'match', winner: 'B', reason: 'SCORE LIMIT', scoreA: 68, scoreB: 75, roundsA: 0, roundsB: 1 },
        'A',
        1,
        boardScore,
        lineupFixture,
      );
      xpSummary.play(fullestReport());
      summary.showBoard(true);
      return summary.element;
    },
    hide: () => {
      xpSummary.stop();
      summary.hide();
    },
  },
  /**
   * The Free-for-All summary (M13 Phase A, bug 4.4).
   *
   * One ladder of sixteen rather than two columns of eight — the tallest board this screen
   * can be handed, on the SCOREBOARD tab — and the case the bug was about: the winner is
   * entity 3, on the local player's own substrate side, so the headline must be a place and
   * not VICTORY. The podium is the ladder's top three.
   */
  ...(['lineup', 'board'] as const).map((tab) => ({
    name: tab === 'lineup' ? 'summary/ffa' : 'summary/ffa/board',
    show: (): HTMLElement => {
      summary.setViewer({ team: 'A', freeForAll: true });
      summary.show(
        {
          kind: 'match',
          winner: 'A',
          winnerEntityId: 3,
          reason: 'KILL LIMIT',
          scoreA: 30,
          scoreB: 27,
          roundsA: 1,
          roundsB: 0,
        },
        'A',
        1,
        boardScore,
        lineupFixture,
      );
      xpSummary.play(fullestReport());
      summary.showBoard(tab === 'board');
      return summary.element;
    },
    hide: (): void => {
      xpSummary.stop();
      summary.hide();
      summary.setViewer({ team: 'A', freeForAll: false });
    },
  })),
  {
    name: 'create-a-class',
    show: () => {
      loadout.show();
      return layerOf('.lo');
    },
    hide: () => loadout.hide(),
  },
  /**
   * Every box open, and the weapon box on each of its tabs (M15, B3): a probe that measures
   * only the closed editor measures the easy state. The zone is docked in one place, so these
   * are nine measurements of one layout with different contents — which is the claim.
   */
  ...(
    [
      ['primary', 0],
      ['primary', 1],
      ['primary', 2],
      ['secondary', 0],
      ['equipment', 0],
      ['perks', 0],
      ['streaks', 0],
      ['field', 0],
    ] as const
  ).map(([box, tab]) => ({
    name: `create-a-class/${box}${tab > 0 ? `/${tab}` : ''}`,
    show: (): HTMLElement => {
      loadout.show();
      loadout.openBox(box, tab);
      return layerOf('.lo');
    },
    hide: (): void => loadout.hide(),
  })),
  {
    name: 'create-a-class/skins',
    show: () => {
      loadout.show();
      loadout.openSkins();
      return layerOf('.lo');
    },
    hide: () => loadout.hide(),
  },
];

function run(): ProbeRun {
  // The viewport was just emulated by the driver and nothing has fired a resize listener, so
  // the frame is scaled here, the way `Game.onResize` does it in the real client.
  const scale = applyFrameScale(host, window.innerWidth, window.innerHeight);
  const screens: ScreenReport[] = [];
  for (const surface of SURFACES) {
    const layer = surface.show();
    screens.push(measure(surface.name, layer, scale));
    surface.hide();
  }
  return { width: window.innerWidth, height: window.innerHeight, scale, screens };
}

declare global {
  interface Window {
    /**
     * The driver in `scripts/layout-probe.mjs` reads `viewports` once and calls `run` once per
     * entry. The list is served from the page rather than duplicated in the driver, so
     * `Viewports.ts` is the only place a viewport is written down.
     */
    __layoutProbe?: {
      run: () => ProbeRun;
      surfaces: readonly string[];
      viewports: readonly Viewport[];
    };
  }
}

window.__layoutProbe = {
  run,
  surfaces: SURFACES.map((s) => s.name),
  viewports: PROBE_VIEWPORTS,
};

/*
 * `?show=<surface>` leaves one screen up instead of measuring, and it is not a debug
 * convenience — it is the browser half of this session's verification.
 *
 * A green rule says every box is inside the window. It says nothing about whether the screen
 * still *reads* right at that size, and that is the half a human has to do. Opening
 * `/probes/layout.html?show=summary` and dragging the window is a way to do it that does not
 * need a server, a match, or ten minutes of play to reach the screen in question. The names
 * are in `window.__layoutProbe.surfaces`.
 */
const wanted = new URLSearchParams(window.location.search).get('show');
if (wanted !== null) {
  const surface = SURFACES.find((s) => s.name === wanted);
  if (surface === undefined) {
    throw new Error(`layout probe: no surface "${wanted}". Try one of: ${SURFACES.map((s) => s.name).join(', ')}`);
  }
  // Scaled on load and on every drag, so the window a human resizes shows what the probe saw.
  const rescale = (): void => {
    applyFrameScale(host, window.innerWidth, window.innerHeight);
  };
  rescale();
  window.addEventListener('resize', rescale);
  surface.show();
}
