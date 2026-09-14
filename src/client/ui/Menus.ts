import {
  BOT_DIFFICULTIES,
  BOT_DIFFICULTY_BLURBS,
  type BotDifficulty,
} from '../../shared/ai/DifficultyTiers';
import type { GameModeId } from '../../shared/modes/GameMode';
import { MAPS, MODES, modesForMap } from '../../shared/modes/ModeRegistry';
import { createScreen } from './Frame';
import { makeIconSvg } from './WeaponIcons';

/**
 * The front end (brief S6.7; rebuilt on the design frame by M15, A2): main -> play -> match.
 *
 * ## Two halves
 *
 * The frame is a header, a stage and a footer. The **header** is the wordmark on the left and
 * the player card on the right — the callsign, editable in place, and the profile line under
 * it — where the references put them. The **stage** is the left half, which is nothing but
 * the backdrop (the canvas underneath, which A3 fills with a map on a dolly), and the right
 * half, which holds the navigation: four buttons, and only four, because that is how many
 * places there are to go — PLAY (multiplayer, primary, one click to the arena as §6.1
 * requires), PLAY SOLO, CREATE A CLASS and SETTINGS. The reference has six; ZOMBIES and STORE
 * do not exist here and QUIT is out by decision 7, a tab being a thing that closes itself.
 * The **footer** carries the status line.
 *
 * The controls card, the fullscreen hint and the reset control that used to stack under the
 * buttons are in Settings → INFO now (A4, `KeyCard.ts`): the menu has no room for fourteen
 * rows in this layout, and none of the three is a thing that should greet a player.
 *
 * ## The buttons are cut, not boxed
 *
 * "Not standard rigid boxes" is the brief's phrase, and it is three declarations in
 * `app.css`: a `clip-path` polygon that skews the leading edge, a `mask-image` that dissolves
 * the primary's leading end into the backdrop rather than ending it on a line, and a
 * pseudo-element that sweeps a highlight along the skew on hover. No image, because there are
 * none (M12's first paragraph), and the look reads the same at every scale of the frame.
 *
 * ## Play Solo is a panel, not a page
 *
 * The mode / map / difficulty pickers used to replace the whole screen. They slide in over
 * the stage now and the header and footer stay where they are, so going to pick a map is not
 * leaving the menu. The slide is 16 px and the frame's padding is 64, so a probe that
 * measures the panel on the frame it was inserted into finds it inside the window even at
 * the first keyframe.
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
  /** Shown in the footer: build stats, or whatever the caller wants to say. */
  readonly statusLine: () => string;
  /** M6: level, class and record. Redrawn every time the menu is shown. */
  readonly profileLine: () => string;
}

type Page = 'MAIN' | 'PLAY';

/**
 * The four glyphs, one path each in a 24-box, filled with `currentColor` (`fill-rule:
 * evenodd` in the stylesheet is what makes the ring a ring). Drawn here for the reason
 * `WeaponIcons` draws the rifles: there are no image assets, and a glyph in a source file is
 * one the frame scales without a second copy.
 */
const GLYPH = {
  play: 'M7 4 L19 12 L7 20 Z',
  solo:
    'M12 4 A8 8 0 1 0 12 20 A8 8 0 1 0 12 4 Z M12 7 A5 5 0 1 1 12 17 A5 5 0 1 1 12 7 Z ' +
    'M11 1h2v4h-2z M11 19h2v4h-2z M1 11h4v2H1z M19 11h4v2h-4z ' +
    'M12 10.5 A1.5 1.5 0 1 0 12 13.5 A1.5 1.5 0 1 0 12 10.5 Z',
  loadout: 'M3 5h18v3H3z M3 10.5h18v3H3z M3 16h11v3H3z',
  settings:
    'M3 6h9v2H3z M16 6h5v2h-5z M3 16h4v2H3z M11 16h10v2H11z ' +
    'M14 4.5 A2.5 2.5 0 1 0 14 9.5 A2.5 2.5 0 1 0 14 4.5 Z M9 14.5 A2.5 2.5 0 1 0 9 19.5 A2.5 2.5 0 1 0 9 14.5 Z',
  chevron: 'M9 4 L17 12 L9 20 L7.4 18.4 L13.8 12 L7.4 5.6 Z',
} as const;

export class Menus {
  private readonly deps: MenuDeps;
  private readonly screen: HTMLElement;
  /** The 1920x1080 box the pages are painted into (M15, A1). `screen` is the layer. */
  private readonly frame: HTMLElement;
  private page: Page = 'MAIN';

  constructor(deps: MenuDeps) {
    this.deps = deps;
    const { layer, frame } = createScreen('op-screen op-screen--menu');
    this.screen = layer;
    this.frame = frame;
    this.screen.hidden = true;
    deps.host.appendChild(this.screen);
  }

  /**
   * A one-line status over the backdrop: booting, connecting, reconnecting, refused.
   *
   * The plain centred frame rather than the menu layout, because there is nothing to press
   * and the message is the whole screen.
   */
  showBoot(message: string): void {
    this.page = 'MAIN';
    this.screen.hidden = false;
    this.frame.classList.remove('op-menu');
    this.frame.replaceChildren(title('OPERATOR'), subtitle(message));
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
    this.frame.classList.remove('op-menu');
    const body = document.createElement('p');
    body.className = 'op-screen__note';
    body.textContent = detail;
    this.frame.replaceChildren(title('OPERATOR'), subtitle(headline), body);
  }

  /** Open the front end at its main page. */
  show(): void {
    this.page = 'MAIN';
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
    this.frame.classList.add('op-menu');
    const stage = document.createElement('div');
    stage.className = 'op-menu__stage';
    const focus = this.page === 'MAIN' ? this.paintNav(stage) : this.paintSetup(stage);
    this.frame.replaceChildren(this.header(), stage, this.footer());
    focus.focus();
  }

  /** The wordmark and the player card. */
  private header(): HTMLElement {
    const head = document.createElement('header');
    head.className = 'op-menu__head';

    const brand = document.createElement('div');
    brand.className = 'op-menu__brand';
    const wordmark = document.createElement('h1');
    wordmark.className = 'op-menu__wordmark';
    wordmark.textContent = 'OPERATOR';
    const rule = document.createElement('span');
    rule.className = 'op-menu__rule';
    const tag = document.createElement('span');
    tag.className = 'op-menu__tag';
    tag.textContent = 'ARENA FPS';
    brand.append(wordmark, rule, tag);

    head.append(brand, this.playerCard());
    return head;
  }

  /**
   * The player card: the display name (§6.1) and the profile line.
   *
   * *"A display name is requested but a default is generated so a player can be in the arena
   * in one click."* So the callsign is a field, not a gate: it starts filled, it is never
   * validated before entry, and nothing about it can stop PLAY working. The value is written
   * straight back to the profile on every keystroke, which is also how it survives a reload.
   */
  private playerCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'op-menu__player';

    const field = document.createElement('label');
    field.className = 'op-menu__callsign';
    const label = document.createElement('span');
    label.className = 'op-label';
    label.textContent = 'CALLSIGN';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'op-input op-menu__name';
    input.maxLength = 20;
    input.value = this.deps.displayName();
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => this.deps.onDisplayName(input.value));
    // The menu is a DOM surface over a canvas that owns the keyboard. Without this, typing
    // "W" in the callsign field also walks the player forward.
    input.addEventListener('keydown', (e) => e.stopPropagation());
    field.append(label, input);

    const profile = document.createElement('p');
    profile.className = 'op-menu__profile op-label';
    profile.textContent = this.deps.profileLine();

    card.append(field, profile);
    return card;
  }

  private footer(): HTMLElement {
    const foot = document.createElement('footer');
    foot.className = 'op-menu__foot';
    const status = document.createElement('span');
    status.className = 'op-label';
    status.textContent = this.deps.statusLine();
    foot.appendChild(status);
    return foot;
  }

  /** The four buttons. Returns the one to focus. */
  private paintNav(stage: HTMLElement): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'op-menu__nav';

    /**
     * **PLAY** is first and primary, and it is one click from shooting: no server picker, no
     * name gate, no intermediate screen (M11, §6.1). **PLAY SOLO** keeps the M1-M8 game
     * reachable (§6.2: *"Leaving this button inert would ship a build in which all of that
     * work is unreachable."*).
     */
    const multiplayer = this.navButton('PLAY', GLYPH.play, () => this.deps.onPlayMultiplayer());
    multiplayer.classList.add('op-nav--primary');
    if (!this.deps.serverConfigured()) {
      // No address configured at build or runtime (§4.9 forbids hardcoding one). Disabled with
      // a reason rather than failing on click — an inert button is what §6.2 refuses.
      multiplayer.disabled = true;
      multiplayer.title = 'No server address configured — set VITE_SERVER_URL or ?server=';
    }
    const solo = this.navButton('PLAY SOLO', GLYPH.solo, () => {
      this.page = 'PLAY';
      this.paint();
    });
    const loadout = this.navButton('CREATE A CLASS', GLYPH.loadout, () => this.deps.onLoadout());
    const settings = this.navButton('SETTINGS', GLYPH.settings, () => this.deps.onSettings());

    nav.append(multiplayer, solo, loadout, settings);
    stage.appendChild(nav);
    return multiplayer.disabled ? solo : multiplayer;
  }

  private navButton(label: string, glyph: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-nav';
    const icon = makeIconSvg(glyph, '0 0 24 24', 'op-nav__icon');
    const text = document.createElement('span');
    text.className = 'op-nav__label';
    text.textContent = label;
    const chevron = makeIconSvg(GLYPH.chevron, '0 0 24 24', 'op-nav__chevron');
    b.append(icon, text, chevron);
    b.addEventListener('click', onClick);
    return b;
  }

  /** The mode / map / difficulty panel. Returns the one to focus. */
  private paintSetup(stage: HTMLElement): HTMLElement {
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

    const heading = document.createElement('span');
    heading.className = 'op-label op-setup__heading';
    heading.textContent = 'PLAY SOLO — select mode, map and difficulty';

    const panel = document.createElement('section');
    panel.className = 'op-setup';
    panel.append(heading, columns, actions);
    stage.appendChild(panel);
    return launch;
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
