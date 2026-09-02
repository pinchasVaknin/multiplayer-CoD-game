import type { ViewerContext } from '../../shared/ui/TeamColour';
import type { Combatant } from '../../shared/ai/Combatant';
import type { ScoreSystem, ScoreTeam } from '../../shared/combat/ScoreSystem';
import { EV, type GameBus } from '../../shared/core/Events';
import type { ProceduralAudio } from '../engine/ProceduralAudio';
import type { ColumnDef } from '../../shared/modes/GameMode';
import type { MatchFlow } from '../../shared/modes/MatchFlow';
import type { MapDef } from '../../shared/world/maps/types';
import { captionHasCountdown, matchCaption } from '../../shared/ui/HudSurfaces';
import { Hud, makeHudState, type HudState } from './Hud';
import { Scoreboard } from './Scoreboard';
import { HudStreaks, makeStreakHudState, type StreakHudState } from './HudStreaks';

/**
 * Everything the player looks at during a match, in one owner.
 *
 * `Match.ts` is the composition root for the *simulation* side of a match — weapons, bots,
 * damage, the mode. This is the composition root for the presentation side, and the split
 * exists so neither file owns the whole screen and both stay inside S3's size guidance.
 *
 * Its whole job is subscription and assembly:
 *
 *   killfeed.entry --> a row in the feed
 *   score.changed  --> the banner's numbers
 *   announcer.cue  --> a synthesised sting and a duck on the world
 *   weapon.fired   --> a minimap ping, if the shooter was not on your side
 *
 * Nothing here computes anything about the match. If a number on screen disagrees with the
 * game, the bug is upstream of this file by construction.
 */

export interface MatchHudDeps {
  readonly bus: GameBus;
  readonly uiHost: HTMLElement;
  readonly mapDef: MapDef;
  readonly mapName: string;
  readonly modeName: string;
  readonly columns: ColumnDef[];
  readonly score: ScoreSystem;
  readonly audio: ProceduralAudio;
  readonly localTeam: ScoreTeam;
  /** Bots *and* the player. Read each frame for the minimap's friendly markers. */
  readonly roster: readonly Combatant[];
  /** Upper bound on players per side, for preallocating rows and markers. */
  readonly teamSize: number;
  /**
   * Post-M8. Free-for-All: everybody on the map is hostile, including the half of the roster
   * that shares the player's substrate side.
   *
   * The two-team substrate FFA keeps (see `modes/FreeForAll.ts`) leaked into the two places
   * the HUD asks "is this one of mine": the minimap's friendly chevrons and the gunfire ping
   * filter. So four of the seven opponents were drawn as team-mates and never pinged the
   * radar when they fired. The mode's own file already called the minimap out as "the one
   * place the seam is visible" — this closes it.
   */
  readonly freeForAll: boolean;
  /**
   * This match is the permanent warmup arena (playtest round 4, F12).
   *
   * Read by exactly one thing here — the caption over the crosshair — and passed rather than
   * derived, because `MatchHud` has no connection and no business acquiring one.
   */
  readonly warmupArena: boolean;
}

export class MatchHud {
  readonly hud: Hud;
  readonly scoreboard: Scoreboard;
  /** M7: the streak strip and the objective banner. */
  readonly streaks: HudStreaks;
  /** M7: filled by `Match` each frame, before `update`. */
  readonly streakState: StreakHudState = makeStreakHudState();
  readonly state: HudState = makeHudState();

  private readonly deps: MatchHudDeps;
  private readonly unsubscribe: Array<() => void> = [];
  private scoreboardOpen = false;

  constructor(deps: MatchHudDeps) {
    this.deps = deps;
    this.hud = new Hud({
      host: deps.uiHost,
      mapDef: deps.mapDef,
      // Room for the whole side, the player included.
      maxFriendlies: deps.teamSize + 1,
    });
    this.streaks = new HudStreaks(deps.uiHost);
    this.scoreboard = new Scoreboard(deps.teamSize + 1);

    /**
     * Every surface that paints a team, from one value (playtest round 4, B12).
     *
     * `MatchHud` already carries both halves of the viewer — the seat the server gave this
     * client, and whether the mode has teams at all — so this costs nothing to assemble and is
     * the reason it is assembled *here*: three surfaces reading one object cannot disagree
     * about which side the player is on, and disagreeing about exactly that is the bug.
     */
    const viewer: ViewerContext = { team: deps.localTeam, freeForAll: deps.freeForAll };
    this.scoreboard.setViewer(viewer);
    this.hud.banner.setViewer(viewer);
    this.hud.feed.setViewer(viewer);
    this.scoreboard.setColumns(deps.columns, deps.modeName, deps.mapName);
    deps.uiHost.appendChild(this.scoreboard.element);

    this.subscribe();
  }

  /** Wall time inside the last HUD update, ms. Reported in F1 (S7). */
  get lastUpdateMs(): number {
    return this.hud.lastUpdateMs;
  }

  get lowHealthIntensity(): number {
    return this.hud.lowHealthIntensity;
  }

  setVisible(on: boolean): void {
    this.hud.setVisible(on);
    if (!on) this.setScoreboardOpen(false);
  }

  setScoreboardOpen(on: boolean): void {
    if (on === this.scoreboardOpen) return;
    this.scoreboardOpen = on;
    this.scoreboard.setOpen(on, this.deps.score);
  }

  /**
   * Fill the parts of the HUD state that come from the match rather than the weapon, then
   * draw. `Match` fills the weapon and health fields before calling this.
   */
  update(flow: MatchFlow, playerX: number, playerZ: number, playerYaw: number, dt: number): void {
    const state = this.state;
    state.playerX = playerX;
    state.playerZ = playerZ;
    state.playerYaw = playerYaw;

    const banner = state.banner;
    banner.secondsRemaining = flow.secondsRemaining;
    banner.round = flow.round;
    /**
     * The caption over the crosshair, and it is the **one writer** of both fields (F12).
     *
     * The countdown is dropped in the arena rather than shown at zero: `phaseSecondsRemaining`
     * counts the round-end hold down through `LIVE`, so a caption that took it would open on
     * `WAITING · 5` and count toward nothing. See `captionHasCountdown`.
     */
    banner.phaseSeconds = captionHasCountdown(this.deps.warmupArena) ? flow.phaseSecondsRemaining : 0;
    banner.phaseLabel = matchCaption(flow.currentPhase, this.deps.warmupArena);

    // The flash and the threat are pushed into the HUD from the sim tick they happen on;
    // fold them into the state here so `HudTactical` still sees one record per frame.
    const tac = state.tactical;
    tac.flash = this.hud.pendingFlash;
    this.hud.readThreat(threatScratch);
    tac.threatActive = threatScratch.active;
    tac.threatX = threatScratch.x;
    tac.threatY = threatScratch.y;
    tac.threatZ = threatScratch.z;
    this.hud.readObjectiveBearing(objectiveScratch);
    tac.objectiveActive = objectiveScratch.active;
    tac.objectiveX = objectiveScratch.x;
    tac.objectiveZ = objectiveScratch.z;

    this.fillFriendlies();
    this.streaks.update(this.streakState);
    this.hud.update(state, dt);
    this.scoreboard.update(dt, this.deps.score);
  }

  /** Wipe every per-match trace so a second match starts clean. */
  resetForMatch(): void {
    this.hud.resetForMatch();
    this.setScoreboardOpen(false);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.streaks.dispose();
    this.scoreboard.dispose();
    this.hud.dispose();
  }

  // -- internals -------------------------------------------------------------

  /**
   * Teammates on the minimap, from tick positions rather than interpolated ones.
   *
   * A marker moving 168 px across a 68 m disc at 60 Hz has no visible stutter, and asking
   * the roster for an interpolated pose would mean every combatant carrying a render
   * snapshot for the sake of a 3 px chevron.
   */
  private fillFriendlies(): void {
    const markers = this.hud.minimap.friendlies;
    let at = 0;
    // No allies in Free-for-All. Every marker is left inactive rather than the loop being
    // skipped, so the deactivation pass below still runs and a mid-match mode change — which
    // only the harness can do — cannot leave a stale chevron on the disc.
    for (const c of this.deps.freeForAll ? [] : this.deps.roster) {
      if (at >= markers.length) break;
      // The local player is drawn at the centre by the minimap itself.
      if (c.entityId === 0) continue;
      if (c.team !== this.deps.localTeam) continue;
      const marker = markers[at];
      if (marker === undefined) continue;
      marker.x = c.px;
      marker.z = c.pz;
      marker.yaw = c.yaw;
      marker.active = c.participating && c.health.alive;
      at++;
    }
    for (let i = at; i < markers.length; i++) {
      const marker = markers[i];
      if (marker !== undefined) marker.active = false;
    }
  }

  private subscribe(): void {
    const { bus, audio } = this.deps;

    this.unsubscribe.push(
      bus.on(EV.KillfeedEntry, (p) => {
        this.hud.pushKillfeed(p);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.ScoreChanged, (p) => {
        const banner = this.state.banner;
        banner.scoreA = p.teamA;
        banner.scoreB = p.teamB;
        banner.limit = p.limit;
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.MatchStarted, (p) => {
        this.state.banner.roundsToWin = p.roundsToWin;
      }),
    );

    // The announcer, and the duck under it, both live inside `playAnnouncer` (S6.5).
    this.unsubscribe.push(
      bus.on(EV.AnnouncerCue, (p) => {
        audio.playAnnouncer(p.cue);
      }),
    );

    /**
     * Enemy gunfire pings the minimap; your own side's does not, because a teammate is
     * already drawn as a chevron and pinging them too turns the map into noise. This is the
     * one piece of information the minimap gives you about the enemy in M4 — the UAV that
     * shows them outright is M7.
     *
     * **M5: `minimapPing` is what a suppressor buys.** The flag rides on the event rather
     * than being looked up from the weapon id, because the shooter's *resolved* def is the
     * only thing that knows whether a can is fitted, and the resolved def lives inside
     * their `WeaponSystem`.
     */
    this.unsubscribe.push(
      bus.on(EV.WeaponFired, (p) => {
        if (!p.minimapPing) return;
        const shooter = this.findRoster(p.sourceId);
        if (shooter === undefined) return;
        // In FFA the only shot that does not ping is your own; everybody else is an enemy.
        const mine = this.deps.freeForAll
          ? shooter.entityId === 0
          : shooter.team === this.deps.localTeam;
        if (mine) return;
        this.hud.minimap.addPing(p.x, p.z);
      }),
    );
  }

  private findRoster(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) {
      if (c.entityId === entityId) return c;
    }
    return undefined;
  }
}

const threatScratch = { active: false, x: 0, y: 0, z: 0 };
/** Module-level and reused, like the threat's: the render pass allocates nothing (S4.7). */
const objectiveScratch = { active: false, x: 0, z: 0 };

