import {
  BOT_DIFFICULTIES,
  BOT_DIFFICULTY_BLURBS,
  type BotDifficulty,
} from '../../shared/ai/DifficultyTiers';
import { inputLabel, type ActionId, type BindingMap } from '../../shared/core/Keybinds';
import type { GameModeId } from '../../shared/modes/GameMode';
import { MAPS, MODES, modesForMap } from '../../shared/modes/ModeRegistry';


/**
 * The front end (brief S6.7): main -> play -> match.
 *
 * "It does not need to be elaborate, but it must not look like unstyled HTML." So it is two
 * pages, every value resolved from the design tokens in `styles/tokens.css`, and the mode and
 * map lists are built from `ModeRegistry` rather than hardcoded — a new mode in M7 appears
 * here for free, and a mode that only exists in this file could never be played.
 *
 * Pointer lock can only be requested from a user gesture, so the button that starts a match
 * is genuinely load-bearing rather than a formality.
 */

export interface MenuSelection {
  modeId: GameModeId;
  mapId: string;
  /**
   * How hard the bots are (playtest round 4, F1).
   *
   * Beside the mode and the map because it is the same kind of choice and it is answered on the
   * same screen. Solo only: a connected client populates no roster, and the bots it shoots at
   * belong to the server that made them.
   */
  difficulty: BotDifficulty;
}

export interface MenuDeps {
  readonly host: HTMLElement;
  readonly selection: MenuSelection;
  readonly onLaunch: () => void;
  /** M11 (§6.1): connect and drop straight into the warmup arena. No intermediate screen. */
  readonly onPlayMultiplayer: () => void;
  /** Whether an address is configured at all. False disables the button with a reason. */
  readonly serverConfigured: () => boolean;
  /** The persisted callsign, prefilled so it never blocks entry (§6.1). */
  readonly displayName: () => string;
  readonly onDisplayName: (name: string) => void;
  /** M6: enter the `LOADOUT` state. */
  readonly onLoadout: () => void;
  /** M8: enter the `SETTINGS` state. */
  readonly onSettings: () => void;
  /** M6: wipe the profile. The confirmation is this file's, the wipe is `Profile`'s. */
  readonly onResetProgress: () => void;
  /** Shown under the title: build stats, or whatever the caller wants to say. */
  readonly statusLine: () => string;
  /** M6: level, class and record. Redrawn every time the menu is shown. */
  readonly profileLine: () => string;
  /** M8: the live binding table, so the controls card names the player's own keys. */
  readonly bindings: () => BindingMap;
}

type Page = 'MAIN' | 'PLAY';

/**
 * The controls card, built from the player's actual bindings (M8).
 *
 * It used to be a hard-coded list, which was fine until S6.3 made every key reassignable —
 * at which point a card that still said "W A S D" for a player who had moved to the arrow
 * keys would be worse than no card at all. Each row names the actions it summarises and the
 * card resolves them through `Keybinds`, so it is correct by construction.
 *
 * The last three rows are chords and modifiers rather than single actions, so they are
 * composed from the bindings of their parts.
 */
const CONTROL_ROWS: readonly Readonly<{ actions: readonly ActionId[]; label: string }>[] = [
  { actions: ['moveForward', 'moveLeft', 'moveBack', 'moveRight'], label: 'Move' },
  { actions: ['sprint'], label: 'Sprint (double-tap for tactical)' },
  { actions: ['crouch'], label: 'Crouch (with sprint, slide)' },
  { actions: ['jump'], label: 'Jump / mantle' },
  { actions: ['fire'], label: 'Fire' },
  { actions: ['ads'], label: 'Aim down sights' },
  { actions: ['reload'], label: 'Reload' },
  { actions: ['swapWeapon', 'slot1', 'slot2'], label: 'Swap weapon' },
  { actions: ['lethal', 'tactical'], label: 'Lethal / tactical' },
  { actions: ['fieldUpgrade'], label: 'Field upgrade' },
  { actions: ['streak1', 'streak2', 'streak3'], label: 'Killstreaks' },
  { actions: ['use'], label: 'Use / plant / defuse' },
  { actions: ['scoreboard'], label: 'Scoreboard' },
];

/**
 * `Ctrl+W` closes a browser tab and no amount of `preventDefault` stops it; only the Keyboard
 * Lock API can, and only while the page is fullscreen. Saying so on the menu is better than
 * letting a player discover it mid-slide. See PLAN.md.
 */
const FULLSCREEN_HINT = 'F11 for fullscreen — required to capture Ctrl+W (crouch + forward)';

export class Menus {
  private readonly deps: MenuDeps;
  private readonly screen: HTMLElement;
  private page: Page = 'MAIN';
  /** Whether the reset button is one click from doing it. Cleared on every `show`. */
  private resetArmed = false;

  constructor(deps: MenuDeps) {
    this.deps = deps;
    this.screen = document.createElement('div');
    this.screen.className = 'op-screen';
    this.screen.hidden = true;
    deps.host.appendChild(this.screen);
  }

  showBoot(message: string): void {
    this.page = 'MAIN';
    this.screen.hidden = false;
    this.screen.replaceChildren(title('OPERATOR'), subtitle(message));
  }

  /**
   * The device gate (playtest round 5, F1).
   *
   * A terminal screen: there is no button, no way back, and `Game` never leaves `BOOT` behind
   * it. F1 asked for *"the honest version — a screen that says the game needs a keyboard and a
   * mouse"* and explicitly **not** a half-built touch scheme, so this is the whole feature.
   *
   * Deliberately not a new `GameStateId`. The gate is *not reaching* `MENU`, which means there
   * is nothing to press rather than a disabled thing to press — and it needs no entry in
   * `LEGAL_TRANSITIONS`, no handler, and no interaction with the pause or summary machinery
   * that a real state would have dragged in for a screen nobody can leave.
   */
  showUnsupported(headline: string, detail: string): void {
    this.page = 'MAIN';
    this.screen.hidden = false;
    const body = document.createElement('p');
    body.className = 'op-screen__note';
    body.textContent = detail;
    this.screen.replaceChildren(title('OPERATOR'), subtitle(headline), body);
  }

  /** Open the front end at its main page. */
  show(): void {
    this.page = 'MAIN';
    this.resetArmed = false;
    this.screen.hidden = false;
    this.paint();
  }

  hide(): void {
    this.screen.hidden = true;
  }

  get isVisible(): boolean {
    return !this.screen.hidden;
  }

  dispose(): void {
    this.screen.remove();
  }

  // -- pages -----------------------------------------------------------------

  private paint(): void {
    if (this.page === 'MAIN') this.paintMain();
    else this.paintPlay();
  }

  private paintMain(): void {
    /**
     * Two buttons (M11, §6.1).
     *
     * **Play Multiplayer** is first and primary, and it is one click from shooting: no server
     * picker, no name gate, no intermediate screen. §6.1 is explicit that a display name is
     * *requested* but never *blocks* — the field below is prefilled with a generated default,
     * so a player who ignores it entirely is in the arena within a round trip.
     *
     * **Play Solo** keeps the M1-M8 game reachable. §6.2: *"Leaving this button inert would
     * ship a build in which all of that work is unreachable."* It goes to the existing mode and
     * map picker, unchanged.
     */
    const multiplayer = this.button('Play Multiplayer', () => this.deps.onPlayMultiplayer());
    multiplayer.classList.add('op-btn--primary');
    if (!this.deps.serverConfigured()) {
      // No address configured at build or runtime (§4.9 forbids hardcoding one). Disabled with
      // a reason rather than failing on click — an inert button is what §6.2 refuses.
      multiplayer.disabled = true;
      multiplayer.title = 'No server address configured — set VITE_SERVER_URL or ?server=';
    }

    const play = this.button('Play Solo', () => {
      this.page = 'PLAY';
      this.paint();
    });

    const loadout = this.button('Create a class', () => this.deps.onLoadout());
    const settings = this.button('Settings', () => this.deps.onSettings());

    const bindings = this.deps.bindings();
    const keys = document.createElement('dl');
    keys.className = 'op-keys';
    for (const row of CONTROL_ROWS) {
      // Only the first binding of each action: the card is a reminder, not the settings
      // screen, and a row reading "L Ctrl / C / L Shift" helps nobody.
      const combo = row.actions
        .map((id) => bindings[id]?.[0])
        .filter((input): input is string => input !== undefined)
        .map(inputLabel)
        .join(' ');
      if (combo === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = combo;
      const dd = document.createElement('dd');
      dd.textContent = row.label;
      keys.append(dt, dd);
    }
    const esc = document.createElement('dt');
    esc.textContent = 'Esc';
    const escLabel = document.createElement('dd');
    escLabel.textContent = 'Pause';
    keys.append(esc, escLabel);

    const profile = document.createElement('p');
    profile.className = 'op-screen__sub op-accent';
    profile.textContent = this.deps.profileLine();

    this.screen.replaceChildren(
      title('OPERATOR'),
      subtitle(this.deps.statusLine()),
      profile,
      multiplayer,
      this.nameField(),
      play,
      loadout,
      settings,
      keys,
      subtitle(FULLSCREEN_HINT),
      this.resetControl(),
    );
    multiplayer.focus();
  }

  /**
   * The display name (§6.1).
   *
   * *"A display name is requested but a default is generated so a player can be in the arena
   * in one click."* So this is a field, not a gate: it starts filled, it is never validated
   * before entry, and nothing about it can stop the button above it working. The value is
   * written straight back to the profile on every keystroke, which is also how it survives a
   * reload.
   */
  private nameField(): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'op-field';

    const label = document.createElement('span');
    label.className = 'op-label';
    label.textContent = 'CALLSIGN';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'op-input';
    input.maxLength = 20;
    input.value = this.deps.displayName();
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => this.deps.onDisplayName(input.value));
    // The menu is a DOM surface over a canvas that owns the keyboard. Without this, typing
    // "W" in the callsign field also walks the player forward.
    input.addEventListener('keydown', (e) => e.stopPropagation());

    wrap.append(label, input);
    return wrap;
  }

  /**
   * "Reset progress", behind a confirmation (S6.6).
   *
   * A two-step button rather than a `window.confirm`: the page owns pointer lock and a
   * native modal steals focus in a way the input layer then has to recover from. The
   * second press has to be a deliberate second click, and clicking anything else — or
   * re-entering the menu — puts it back.
   */
  private resetControl(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'op-danger';
    const button = this.button(
      this.resetArmed ? 'Confirm — erase all progress' : 'Reset progress',
      () => {
        if (!this.resetArmed) {
          this.resetArmed = true;
          this.paint();
          return;
        }
        this.resetArmed = false;
        this.deps.onResetProgress();
        this.paint();
      },
    );
    button.classList.add(this.resetArmed ? 'op-btn--danger' : 'op-btn--quiet');
    wrap.appendChild(button);
    if (this.resetArmed) {
      const warn = document.createElement('span');
      warn.className = 'op-label';
      warn.textContent = 'LEVEL, UNLOCKS, CAMOS AND CLASSES. SETTINGS ARE KEPT.';
      wrap.appendChild(warn);
    }
    return wrap;
  }

  private paintPlay(): void {
    const modeList = this.picker(
      'Mode',
      // Only what this map can run: Domination needs flags and S&D needs bomb sites, and
      // offering a mode whose objectives the map does not author throws on match build.
      modesForMap(this.deps.selection.mapId).map((m) => ({ id: m.id, name: m.name, blurb: m.blurb })),
      this.deps.selection.modeId,
      (id) => {
        this.deps.selection.modeId = id as GameModeId;
        this.paint();
      },
    );

    // A mode may pin its map — the Shooting Range only exists where the dummies are. The
    // picker still shows the map so the player knows where they are going; it simply
    // cannot be changed, which is more informative than hiding the column.
    const modeEntry = MODES.find((m) => m.id === this.deps.selection.modeId);
    const forced = modeEntry?.forcedMapId ?? null;
    const mapList = this.picker(
      'Map',
      MAPS.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb })),
      forced ?? this.deps.selection.mapId,
      (id) => {
        if (forced !== null) return;
        this.deps.selection.mapId = id;
        this.paint();
      },
      forced !== null,
    );

    /**
     * Difficulty (F1), and it is a third column rather than a control below the two.
     *
     * The four tiers have been in `DifficultyTiers.ts` since M3 with nothing outside a debug
     * panel able to choose between them. `MIX` is last and is the default: it is not a fifth
     * tier but the map's authored spread of all four, which is what every match in this project
     * has run — so the picker's default selection is the behaviour that was already shipped.
     */
    const difficultyList = this.picker(
      'Difficulty',
      BOT_DIFFICULTIES.map((id) => ({
        id,
        name: id === 'MIX' ? 'MIXED' : id,
        blurb: BOT_DIFFICULTY_BLURBS[id],
      })),
      this.deps.selection.difficulty,
      (id) => {
        this.deps.selection.difficulty = id as BotDifficulty;
        this.paint();
      },
      // The Shooting Range fills no roster (`populatesRoster: false`), so there is nobody for a
      // difficulty to describe. Shown and locked rather than hidden, for the reason the map
      // column is: a picker that vanishes tells the player less than one that says why.
      // `false` for a selection the registry does not recognise: the picker stays live, and
      // `findMode` throws on launch, which is where a bad mode id should be found.
      modeEntry !== undefined && !modeEntry.populatesRoster,
      'no bots in this mode',
    );

    const launch = this.button('Start match', () => this.deps.onLaunch());
    launch.classList.add('op-btn--primary');
    const back = this.button('Back', () => {
      this.page = 'MAIN';
      this.paint();
    });
    back.classList.add('op-btn--quiet');

    const actions = document.createElement('div');
    actions.className = 'op-actions';
    actions.append(back, launch);

    const columns = document.createElement('div');
    columns.className = 'op-pickers';
    columns.append(modeList, mapList, difficultyList);

    this.screen.replaceChildren(
      title('OPERATOR'),
      subtitle('Select mode, map and difficulty'),
      columns,
      actions,
    );
    launch.focus();
  }

  // -- primitives ------------------------------------------------------------

  private picker(
    label: string,
    entries: readonly Readonly<{ id: string; name: string; blurb: string }>[],
    selected: string,
    onPick: (id: string) => void,
    locked = false,
    /**
     * Why it is locked, appended to the heading.
     *
     * The map picker's reason — *"fixed by this mode"* — was the only one until the difficulty
     * picker arrived, and it is the wrong sentence for that one: the Shooting Range does not
     * *fix* a difficulty, it has nobody to apply one to. A locked control that misstates its own
     * reason is worse than an enabled one that does nothing, because the player then believes
     * the wrong thing about the mode.
     */
    lockedNote = 'fixed by this mode',
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'op-picker';
    wrap.classList.toggle('is-locked', locked);

    const heading = document.createElement('span');
    heading.className = 'op-label';
    heading.textContent = locked ? `${label} — ${lockedNote}` : label;
    wrap.appendChild(heading);

    for (const entry of entries) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'op-option';
      option.classList.toggle('op-option--on', entry.id === selected);
      option.disabled = locked && entry.id !== selected;
      option.setAttribute('aria-pressed', entry.id === selected ? 'true' : 'false');

      const name = document.createElement('span');
      name.className = 'op-option__name';
      name.textContent = entry.name;
      const blurb = document.createElement('span');
      blurb.className = 'op-option__blurb';
      blurb.textContent = entry.blurb;

      option.append(name, blurb);
      option.addEventListener('click', () => onPick(entry.id));
      wrap.appendChild(option);
    }
    return wrap;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-btn';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }
}

function title(text: string): HTMLElement {
  const h = document.createElement('h1');
  h.className = 'op-screen__title';
  h.textContent = text;
  return h;
}

function subtitle(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'op-screen__sub';
  p.textContent = text;
  return p;
}
