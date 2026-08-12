import { DT } from '../../shared/core/Loop';
import {
  MAP_BALLOT,
  MODE_BALLOT,
  votePhaseName,
  VotePhase,
  WARMUP_MATCH_ID,
} from '../../shared/net/Skirmish';
import type { NetSession } from '../net/NetSession';
import type { BuildReport } from '../world/MapBuildQueue';
import type { DivergenceChecker } from '../../shared/debug/DivergenceChecker';
import type { FrameStats } from './FrameStats';
import { setField, type DebugOverlay } from './DebugOverlay';

/**
 * The M11 read-outs, in the M8 tabbed overlay (§7).
 *
 * §7 asks for four client-visible instruments and this is all four, for the same reason
 * `NetPanel` is three: they share a source, and splitting them across four files would mean
 * four lookups of the same session and four places to keep in step.
 *
 * - **Vote cycle**: phase, true remaining time, the tally as the server sees it, and the
 *   resolved winners.
 * - **Instance**: which world this client is in, and what the transition cost.
 * - **Migration**: every move this client has made, with the misprediction count in the
 *   sixty ticks after each — §7's *"direct regression test for Tier 1 #20"*.
 * - **Background build**: build time per map, chunk count, and the worst frame observed.
 *
 * ## What this panel cannot show, and where to look instead
 *
 * §7's instance panel wants *"both instances side by side — state, player count, bot count,
 * per-instance tick ms, and total tick ms"*. A client can see exactly one instance: its own,
 * and only the parts of it that are replicated. Per-instance tick ms is a property of the
 * server's event loop and no amount of client instrumentation can recover it.
 *
 * So the honest split is that the **server** reports that pair, on its metrics interval and in
 * the `skirmish` harness's per-cycle rows, and this panel reports what a player's machine can
 * actually observe. Pretending otherwise would mean a panel showing a number it inferred, which
 * is worse than a panel that says where the number lives.
 *
 * Everything updates on the overlay's 15 Hz text hook rather than per frame, because a panel
 * that costs frame time is a panel that corrupts the frame times next to it.
 */

export interface SkirmishPanelDeps {
  readonly session: () => NetSession | null;
  readonly divergence: () => DivergenceChecker | null;
  readonly stats: FrameStats;
  /** The most recent completed background build, or null. */
  readonly lastBuild: () => BuildReport | null;
  /** Whether a build is in flight, and how far through it is. */
  readonly buildProgress: () => { done: number; total: number; label: string } | null;
  /** Post-migration misprediction windows, newest last. See `Game`. */
  readonly migrationWindows: () => readonly { matchId: number; tick: number; mispredictions: number }[];
}

export class SkirmishPanel {
  constructor(overlay: DebugOverlay, deps: SkirmishPanelDeps) {
    const right = overlay.rightColumn;

    // ---- VOTE CYCLE --------------------------------------------------------
    const vote = overlay.section('Vote cycle', right);
    const fPhase = vote.addField('Phase');
    const fRemaining = vote.addField('Remaining');
    const fTally = vote.addField('Tally');
    const fSelf = vote.addField('Your vote');
    const fDecided = vote.addField('Decided');
    const fHumans = vote.addField('Humans');

    // ---- INSTANCE ----------------------------------------------------------
    const instance = overlay.section('Instance', right);
    const fWhere = instance.addField('This client');
    const fMapMode = instance.addField('Map / mode');
    const fEffective = instance.addField('Seated from tick');
    const fDivergence = instance.addField('Divergence');

    // ---- MIGRATION ---------------------------------------------------------
    const migration = overlay.section('Migration', right);
    const fMigrations = migration.addField('Count');
    const fLastMove = migration.addField('Last move');
    const fMispred = migration.addField('Post-migration');

    // ---- BACKGROUND BUILD --------------------------------------------------
    const build = overlay.section('Background build', right);
    const fBuildState = build.addField('State');
    const fBuildTime = build.addField('Last build');
    const fChunks = build.addField('Chunks');
    const fWorstFrame = build.addField('Worst build frame');

    overlay.addTextHook(() => {
      const session = deps.session();
      const client = session?.client ?? null;

      // ---- vote ------------------------------------------------------------
      const info = session?.lastVote ?? null;
      if (info === null) {
        setField(fPhase, '—');
        setField(fRemaining, '—');
        setField(fTally, '—');
        setField(fSelf, '—');
        setField(fDecided, '—');
        setField(fHumans, '—');
      } else {
        setField(fPhase, votePhaseName(info.phase));
        const remaining = Math.max(0, (info.phaseEndsTick - (client?.stats.clientTick ?? 0)) * DT);
        setField(fRemaining, `${remaining.toFixed(1)}s (ends tick ${info.phaseEndsTick})`);

        const ballot = info.phase === VotePhase.MAP_VOTE ? MAP_BALLOT : MODE_BALLOT;
        const tally = info.tally
          .map((count, i) => `${shortName(ballot[i] ?? String(i))} ${count}`)
          .join('  ');
        setField(fTally, tally === '' ? '—' : tally);
        setField(fSelf, info.selfVote < 0 ? 'abstained' : shortName(ballot[info.selfVote] ?? '?'));
        setField(
          fDecided,
          `${info.decidedMode < 0 ? '—' : MODE_BALLOT[info.decidedMode] ?? '?'} / ` +
            `${info.decidedMap < 0 ? '—' : MAP_BALLOT[info.decidedMap] ?? '?'}`,
        );
        setField(fHumans, String(info.humans));
      }

      // ---- instance --------------------------------------------------------
      if (client === null) {
        setField(fWhere, 'single-player');
        setField(fMapMode, '—');
        setField(fEffective, '—');
      } else {
        setField(
          fWhere,
          client.matchId === WARMUP_MATCH_ID ? 'warmup arena' : `live match ${client.matchId}`,
        );
        setField(fMapMode, `${client.mapId} / ${client.modeId}`);
        setField(fEffective, String(client.effectiveTick));
      }
      const divergence = deps.divergence();
      setField(fDivergence, divergence === null ? '—' : divergence.summary());

      // ---- migration -------------------------------------------------------
      const windows = deps.migrationWindows();
      setField(fMigrations, String(client?.migrations ?? 0));
      const last = windows[windows.length - 1];
      setField(fLastMove, last === undefined ? '—' : `to ${last.matchId} on tick ${last.tick}`);
      /**
       * The Tier 1 #20 regression number, and the whole reason this row exists.
       *
       * §8.9 expects zero after every migration into a live match. A non-zero value here means
       * a class reached the server after the entity it was meant to configure — read the
       * migration log on the server for which player and which tick.
       */
      const worst = windows.reduce((max, w) => Math.max(max, w.mispredictions), 0);
      setField(
        fMispred,
        windows.length === 0
          ? '—'
          : `worst ${worst} in 60 ticks (${windows.map((w) => w.mispredictions).join(',')})` +
            (worst > 0 ? '  ** TIER 1 #20 **' : '  ok'),
      );

      // ---- background build ------------------------------------------------
      const progress = deps.buildProgress();
      setField(
        fBuildState,
        progress === null ? 'idle' : `building ${progress.label} (${progress.done}/${progress.total})`,
      );
      const report = deps.lastBuild();
      setField(
        fBuildTime,
        report === null
          ? '—'
          : `${report.mapId}: ${report.workMs}ms work / ${report.elapsedMs}ms wall`,
      );
      setField(
        fChunks,
        report === null ? '—' : `${report.chunks} over ${report.frames} frames`,
      );
      /**
       * The number §6.5 asks for: *"the worst frame time observed during a background build"*.
       *
       * A frame spike here defeats the whole design, so it is shown against the budget rather
       * than bare. The build's own budget is 2 ms and one chunk may overrun it, so the honest
       * expectation is "a couple of milliseconds", and anything approaching a frame is a
       * failure of the chunking rather than of the machine.
       */
      const worstFrame = deps.stats.worstBackgroundBuildMs;
      setField(
        fWorstFrame,
        `${worstFrame.toFixed(2)}ms` +
          (report === null ? '' : ` · worst chunk ${report.worstChunkMs}ms`) +
          (worstFrame > 8 ? '  ** SPIKE **' : ''),
      );
    });
  }
}

/** Ballot ids are long; the tally row is not. */
function shortName(id: string): string {
  return id.startsWith('mp_') ? id.slice(3).toUpperCase() : id;
}
