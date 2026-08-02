import type { ProceduralAudio } from './engine/ProceduralAudio';
import { profileLine } from './GameLoadout';
import type { Match } from './Match';
import { PLAYER_TEAM } from './Match';
import type { Profile } from './meta/Profile';
import type { XpReport } from './meta/XpRules';
import type { MatchResult } from './modes/GameMode';
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
  readonly onLoadout: () => void;
  /** M8. Open the settings screen from the menu or the pause screen. */
  readonly onSettings: () => void;
  readonly onLoadoutBack: () => void;
  readonly onQuitToMenu: () => void;
  readonly onResume: () => void;
  readonly onToggleOverlay: () => void;
  readonly onLeaveSummary: () => void;

  readonly statusLine: () => string;
  readonly pauseStatusLine: () => string;
  /** Whether the selected mode lifts unlock gates (the Shooting Range does). */
  readonly unrestricted: () => boolean;
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
      onBack: deps.onLoadoutBack,
      onLaunch: deps.onLaunch,
      unrestricted: deps.unrestricted,
    });

    this.xpSummary = new XpSummary({ audio: deps.audio });

    this.pauseMenu = new PauseMenu({
      host: deps.host,
      onResume: deps.onResume,
      onToggleDebug: deps.onToggleOverlay,
      onQuit: deps.onQuitToMenu,
      statusLine: deps.pauseStatusLine,
    });
    // A pause-screen loadout edit comes back through PAUSED, so the world it left is the
    // world it returns to and the class change lands on a live match.
    this.pauseMenu.setOnLoadout(deps.onLoadout);
    this.pauseMenu.setOnSettings(deps.onSettings);

    this.summary = new EndOfMatch({
      // Sized to the largest roster any map asks for, so the board never has to grow.
      rowsPerTeam: 8,
      onContinue: () => {
        if (this.xpSummary.isPlaying) {
          this.xpSummary.finish();
          return;
        }
        deps.onLeaveSummary();
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
  ): void {
    this.summary.setColumns(match.mode.getScoreboardColumns(), match.mode.name, mapName);
    this.summary.show(
      result.winner,
      PLAYER_TEAM,
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
