import { createGameBus } from '../../shared/core/Events';
import { defaultBindings } from '../../shared/core/Keybinds';
import { ScoreSystem, type ScoreTeam } from '../../shared/combat/ScoreSystem';
import type { ColumnDef } from '../../shared/modes/GameMode';
import { defaultSettings } from '../../shared/meta/SaveData';
import {
  DEFAULT_MAP_ID,
  DEFAULT_MODE_ID,
  MAPS,
  MODES,
  modesForMap,
} from '../../shared/modes/ModeRegistry';
import { Profile } from '../meta/Profile';
import { DEFAULT_CAMERA_CONFIG } from '../player/CameraConfig';
import { EndOfMatch } from '../ui/EndOfMatch';
import { LoadoutEditor } from '../ui/LoadoutEditor';
import { Menus, type MenuSelection } from '../ui/Menus';
import { PauseMenu } from '../ui/PauseMenu';
import { Settings } from '../ui/Settings';
import { PROBE_VIEWPORTS, type Viewport } from './Viewports';

/**
 * The layout probe's page half (playtest round 5, P1).
 *
 * B1, B2 and B3 were all reported as "it looks cut off", and all three were found with a
 * `getBoundingClientRect()` against a stated viewport. P0 rule 7 draws the conclusion: a
 * layout bug on this project is a **number**, not something a human has to notice, so this
 * mounts every full-screen surface at a list of viewports and asserts two things about each.
 *
 * ## The two rules
 *
 * **Reachable.** Every laid-out element in the screen must end up wholly inside the viewport
 * after `scrollIntoView({ block: 'nearest', inline: 'nearest' })` — the minimum scroll that
 * would bring it into view if any scroll could. That phrasing is what makes the rule catch
 * B1 rather than shrug at it: a flex column that centres its overflow puts half of it at a
 * negative offset, and a negative offset is not somewhere a scroll container can go. So an
 * element off the *bottom* of a scrollable screen passes and an element off the *top* of the
 * same screen fails, which is exactly the asymmetry the report described as "the wheel does
 * nothing".
 *
 * An element larger than the viewport on an axis is skipped on that axis, and its children
 * are not: the layer itself is exactly viewport-sized, and a 900px column inside a 626px
 * window is the thing under test rather than a violation in itself. What has to hold is that
 * every *part* of it can be brought into view.
 *
 * **No sideways scrolling.** Any element whose used `overflow-x` is `auto` or `scroll` must
 * have `scrollWidth <= clientWidth`. Vertical overflow is a legitimate answer to a long
 * screen; horizontal overflow is not, and B3 is what it looks like — `.eom` sets
 * `overflow-y: auto`, CSS computes the other axis to `auto` alongside it, and the AXIS half
 * of the scoreboard went under a horizontal scrollbar.
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
  readonly rule: 'unreachable' | 'sideways';
  readonly axis: 'x' | 'y';
  readonly element: string;
  /** Where it sat before anything tried to scroll to it. The reported number. */
  readonly before: Rect;
  /** Where it sat after the minimum scroll that would have revealed it. */
  readonly after: Rect;
  readonly detail: string;
}

export interface ScreenReport {
  readonly screen: string;
  /** How tall the screen's content actually is, from the union of its children's boxes. */
  readonly contentHeight: number;
  /** How wide, the same way. */
  readonly contentWidth: number;
  readonly elements: number;
  readonly violations: Violation[];
}

export interface ProbeRun {
  readonly width: number;
  readonly height: number;
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

function measure(screen: string, layer: HTMLElement): ScreenReport {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const violations: Violation[] = [];
  const all: HTMLElement[] = [layer, ...Array.from(layer.querySelectorAll<HTMLElement>('*'))];

  /*
   * The content's own extent, before anything scrolls, so the report carries the same kind of
   * number B1 and B2 were written with. Measured off the layer's descendants rather than off
   * `scrollHeight`, which cannot see the half of the overflow sitting above the origin — that
   * blind spot is why the report's "content height is 744px" and its "title at y = -118" did
   * not add up to each other.
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
    if (el === layer) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }

  for (const el of laid) {
    const before = rectOf(el);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const after = rectOf(el);
    if (after.height <= vh + EPSILON && (after.top < -EPSILON || after.bottom > vh + EPSILON)) {
      violations.push({
        rule: 'unreachable',
        axis: 'y',
        element: describe(el),
        before,
        after,
        detail:
          after.top < -EPSILON
            ? `${(-after.top).toFixed(0)}px above the top of a ${vh}px viewport, and no scroll brings it back`
            : `${(after.bottom - vh).toFixed(0)}px below the bottom of a ${vh}px viewport, and no scroll reaches it`,
      });
    }
    if (after.width <= vw + EPSILON && (after.left < -EPSILON || after.right > vw + EPSILON)) {
      violations.push({
        rule: 'unreachable',
        axis: 'x',
        element: describe(el),
        before,
        after,
        detail:
          after.left < -EPSILON
            ? `${(-after.left).toFixed(0)}px off the left of a ${vw}px viewport`
            : `${(after.right - vw).toFixed(0)}px off the right of a ${vw}px viewport`,
      });
    }
  }

  for (const el of laid) {
    const style = getComputedStyle(el);
    if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
    const spill = el.scrollWidth - el.clientWidth;
    if (spill <= 1) continue;
    violations.push({
      rule: 'sideways',
      axis: 'x',
      element: describe(el),
      before: rectOf(el),
      after: rectOf(el),
      detail: `scrolls sideways: ${el.scrollWidth}px of content in a ${el.clientWidth}px box`,
    });
  }

  return {
    screen,
    contentHeight: laid.length > 1 ? Math.round(bottom - top) : 0,
    contentWidth: laid.length > 1 ? Math.round(right - left) : 0,
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
  onResetProgress: noop,
  statusLine: () => 'LAYOUT PROBE',
  profileLine: () => 'LEVEL 1 · ASSAULT · 0 / 500 XP',
  bindings: () => defaultBindings(),
});

const settings = new Settings({
  host,
  read: () => profile.settings,
  onChange: noop,
  onBack: noop,
  onResetBindings: noop,
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

const summary = new EndOfMatch({ rowsPerTeam: 8, onContinue: noop, onExit: noop });
host.appendChild(summary.element);

const loadout = new LoadoutEditor({
  host,
  profile,
  onSaveAndExit: noop,
  unrestricted: () => false,
  anisotropy: () => 1,
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

/** A full board: eight a side, the local player among them, plausible callsigns. */
function fullBoard(): ScoreSystem {
  const score = new ScoreSystem(createGameBus());
  const teams: readonly ScoreTeam[] = ['A', 'B'];
  let id = 1;
  for (const team of teams) {
    for (let i = 0; i < 8; i++) {
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
const boardScore = fullBoard();

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
    name: 'solo-setup',
    show: () => {
      menus.show();
      const layer = layerOf(PLAIN_SCREEN);
      click(layer, 'Play Solo');
      return layer;
    },
    hide: () => menus.hide(),
  },
  ...(['CONTROLS', 'BINDINGS', 'AUDIO', 'VIDEO'] as const).map((tab) => ({
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
  {
    name: 'summary',
    show: () => {
      summary.show('B', 'A', 'SCORE LIMIT', 68, 75, boardScore);
      return summary.element;
    },
    hide: () => summary.hide(),
  },
  {
    name: 'create-a-class',
    show: () => {
      loadout.show();
      return layerOf('.lo');
    },
    hide: () => loadout.hide(),
  },
  {
    name: 'create-a-class/open-row',
    show: () => {
      loadout.show();
      const layer = layerOf('.lo');
      const head = layer.querySelector<HTMLElement>('.lo-row__head');
      if (head === null) throw new Error('layout probe: the loadout editor has no rows');
      head.click();
      return layer;
    },
    hide: () => loadout.hide(),
  },
];

function run(): ProbeRun {
  const screens: ScreenReport[] = [];
  for (const surface of SURFACES) {
    const layer = surface.show();
    screens.push(measure(surface.name, layer));
    surface.hide();
  }
  return { width: window.innerWidth, height: window.innerHeight, screens };
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
  surface.show();
}
