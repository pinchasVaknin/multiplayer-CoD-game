import type { ProceduralAudio } from './engine/ProceduralAudio';
import { profileLine } from './GameLoadout';
import type { Match } from './ClientMatch';
import type { Profile } from './meta/Profile';
import type { XpReport } from '../shared/meta/XpRules';
import type { MatchResult } from '../shared/modes/GameMode';
import { EndOfMatch } from './ui/EndOfMatch';
import { LoadoutEditor } from './ui/LoadoutEditor';
import { Menus, type MenuSelection } from './ui/Menus';
import { PauseMenu } from './ui/PauseMenu';
import { XpSummary } from './ui/XpSummary';

/**
 * The front end: every full-screen DOM surface that is not the HUD (M7).
 *
 * Five screens with one lifetime — the main menu, Create-a-Class, the pause screen, the
 * post-match board and the XP animation inside it — all built at boot and kept for the life
 * of the page, because unlike the world they are cheap and hold nothing between matches.
 *
 * They were constructed inline in `Game`'s constructor, which put eighty lines of DOM wiring
 * in the middle of a file whose subject is the state machine, with the summary screen's
 * presentation logic inside a state handler. Pulling them out draws the line where it
 * belongs: **the screens raise intents, `Game` decides what state to go to.** Nothing here
 * calls `transitionTo` — every button is a callback the state machine supplies, which is what
 * keeps the legal-transition table the only description of how the application moves.
 *
 * The one piece of logic that stayed is the Continue button's: a player who has already seen
 * their XP total does not need to watch the bar arrive at it, so the first press finishes the
 * animation and only the second leaves. That is a property of the two screens involved and
 * belongs with them.
 */

export interface GameScreensDeps {
  readonly host: HTMLElement;
  readonly profile: Profile;
  readonly audio: ProceduralAudio;
  /** The live mode/map choice. `Menus` writes into it; `Game` reads it. */
  readonly selection: MenuSelection;

  // ---- intents. `Game` owns the state machine; the screens only ask --------
  readonly onLaunch: () => void;
  /** M11 (§6.1): connect and drop into the warmup arena. */
  readonly onPlayMultiplayer: () => void;
  readonly serverConfigured: () => boolean;
  readonly displayName: () => string;
  readonly onDisplayName: (name: string) => void;
  /** The menu's Create-a-Class button. The only door into the editor (round 4, B8). */
  readonly onLoadout: () => void;
  /** M8. Open the settings screen from the menu or the pause screen. */
  readonly onSettings: () => void;
  /** The editor's one action: persist and go back to the menu (round 4, B5). */
  readonly onLoadoutSaveAndExit: () => void;
  readonly onQuitToMenu: () => void;
  readonly onResume: () => void;
  readonly onToggleOverlay: () => void;
  /**
   * A cheat code was typed on the pause screen (playtest round 4, F14).
   *
   * An intent like every other on this interface: the screen collects a string, `Game` decides
   * what it means and whether the server has to be asked.
   */
  readonly onCheatCode: (code: string) => void;
  readonly onLeaveSummary: () => void;
  /** The summary's secondary: leave the server for the main menu (playtest round 4, B4). */
  readonly onExitSummary: () => void;

  readonly statusLine: () => string;
  readonly pauseStatusLine: () => string;
  /** Whether the selected mode lifts unlock gates (the Shooting Range does). */
  readonly unrestricted: () => boolean;
  /**
   * Anisotropy for the editor's weapon preview (round 4, F15).
   *
   * The same number `ClientMatch` builds its viewmodels with, read from the one
   * `ProceduralTextures` the renderer owns — the weapon textures are cached per process and
   * the first caller decides, so passing a different one here would be a silent second answer.
   */
  readonly anisotropy: () => number;
}

export class GameScreens {
  readonly menus: Menus;
  readonly loadoutEditor: LoadoutEditor;
  readonly xpSummary: XpSummary;
  readonly pauseMenu: PauseMenu;
  readonly summary: EndOfMatch;

  constructor(deps: GameScreensDeps) {
    this.menus = new Menus({
      host: deps.host,
      selection: deps.selection,
      onLaunch: deps.onLaunch,
      onPlayMultiplayer: deps.onPlayMultiplayer,
      serverConfigured: deps.serverConfigured,
      displayName: deps.displayName,
      onDisplayName: deps.onDisplayName,
      onLoadout: deps.onLoadout,
      onSettings: deps.onSettings,
      onResetProgress: () => deps.profile.resetProgress(),
      statusLine: deps.statusLine,
      profileLine: () => profileLine(deps.profile),
      bindings: () => deps.profile.settings.bindings,
    });

    this.loadoutEditor = new LoadoutEditor({
      host: deps.host,
      profile: deps.profile,
      onSaveAndExit: deps.onLoadoutSaveAndExit,
      anisotropy: deps.anisotropy,
      unrestricted: deps.unrestricted,
    });

    this.xpSummary = new XpSummary({ audio: deps.audio });

    this.pauseMenu = new PauseMenu({
      host: deps.host,
      onResume: deps.onResume,
      onToggleDebug: deps.onToggleOverlay,
      onQuit: deps.onQuitToMenu,
      statusLine: deps.pauseStatusLine,
      onCheatCode: deps.onCheatCode,
    });
    this.pauseMenu.setOnSettings(deps.onSettings);

    this.summary = new EndOfMatch({
      // Sized to the largest roster any map asks for, so the board never has to grow.
      rowsPerTeam: 8,
      /**
       * Acts on the first press (playtest round 4, B4).
       *
       * This used to swallow the first click to finish the XP animation and leave only on the
       * second, which is the reported *"you have to click twice"* — and it was this, not a
       * focus guard and not pointer lock. The reasoning behind it was sound and the shape was
       * not: a button labelled "Return to lobby" that does something else is a button that
       * lies, and the moment there are two of them the player cannot tell which press was
       * eaten by which.
       *
       * The XP is banked when SUMMARY is *entered*, not when the bar finishes, so skipping the
       * animation costs nothing but the animation. Leaving finishes it and goes.
       */
      onContinue: () => {
        this.xpSummary.finish();
        deps.onLeaveSummary();
      },
      onExit: () => {
        this.xpSummary.finish();
        deps.onExitSummary();
      },
    });
    // The M4 insertion point, filled (S6.1). `EndOfMatch` needed no other change.
    this.summary.xpSlot.appendChild(this.xpSummary.element);
    deps.host.appendChild(this.summary.element);
  }

  /**
   * Put the post-match board up.
   *
   * `report` is null for a mode that does not bank progress — the Shooting Range, whose whole
   * point is that nothing done there can move the account. The XP slot is hidden rather than
   * played empty, because an animation that counts to zero reads as a bug.
   */
  showSummary(
    match: Match,
    result: MatchResult,
    mapName: string,
    report: XpReport | null,
    prestige: number,
    /**
     * Whether a server is holding this screen (M11, §6.9).
     *
     * The *connection*, not the hold it sent: over the network the player does not get to
     * choose when this screen ends — the server takes them back to the arena on its own clock —
     * and that stays true whether or not the number describing it arrived. The countdown itself
     * is pushed in per frame by `Game.draw`; see `EndOfMatch.setRemainingSeconds`.
     */
    networked = false,
  ): void {
    this.summary.setNetworked(networked);
    // Before the columns, because the heading the columns build is itself relative (B12).
    this.summary.setViewer(match.viewer);
    this.summary.setColumns(match.mode.getScoreboardColumns(), match.mode.name, mapName);
    this.summary.show(
      result.winner,
      // The side the server put this client on, so a team-B player is not congratulated for
      // losing — the same constant-standing-in-for-an-assignment bug as the alive counter.
      match.localTeam,
      result.reason,
      result.scoreA,
      result.scoreB,
      match.score,
    );
    this.summary.xpSlot.hidden = report === null;
    if (report === null) return;
    this.xpSummary.prestige = prestige;
    this.xpSummary.play(report);
  }

  hideSummary(): void {
    this.xpSummary.stop();
    this.summary.hide();
  }
}
