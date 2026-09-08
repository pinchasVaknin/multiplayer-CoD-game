import { EV, createGameBus } from '../core/Events';
import { ScoreSystem } from '../combat/ScoreSystem';
import { MatchFlow } from '../modes/MatchFlow';
import { MAPS, MODES, modesForMap } from '../modes/ModeRegistry';

/**
 * Which team-score accessor is correct on a replicated client (playtest round 5, B7).
 *
 * The report was the game accusing itself: dozens of `error` lines saying *"scoreA — client
 * says 0, server says 69"*. It was right about the zero and wrong about whose fault it was.
 * `GameMode.teamScore` is the local copy of a fact the server has owned since M10, and
 * `MatchFlow` sets a replicated client up with `authoritative: false` — under which the mode
 * never scores. So for four of the five modes the local copy is not stale, not lagging and not
 * off by a few: it is a **structural constant zero**, and anything comparing it against the
 * server's number reports a divergence in every networked match.
 *
 * This is the numeric half of the fix. `scripts/check-authority.mjs` is the structural half: it
 * stops a client file reaching for the wrong accessor and cannot say what the wrong one
 * returns. Together they are "which one, and why".
 *
 * ## What it does
 *
 * For every registered mode, on the first map that authors its objectives, it builds a
 * **replicated** flow — the client's arrangement, not the server's — replays a run of lethal
 * damage events through it, hands it a snapshot state the way `NetSession` does, and asks both
 * accessors what the score is. Then it asserts the two things a client depends on:
 *
 * - `MatchFlow.teamScore` returns the replicated number, for every mode. That is what the HUD,
 *   the pause screen, the debug panel and the divergence checker must read.
 * - `GameMode.teamScore` does **not**, and the audit prints what it does return, because the
 *   count of modes where it happens to track is the whole reason this looked plausible for a
 *   milestone. Free-for-All's score is the leader's kill count, which the replicated path does
 *   maintain — so one mode in five looked fine and four screamed.
 *
 * Pure: a throwaway bus, score and mode per row, nothing subscribed that outlives the call, no
 * clock and no wire. One run is a fact rather than a sample, which is what puts it beside
 * `auditModeBriefs` and `auditRosterDeal` at the top of a harness run rather than inside one.
 */

/** Kills replayed per mode. Enough that a tally which counts anything is visibly non-zero. */
const KILLS = 12;

/** What the server is pretending to have reached, so the replicated number is unmistakable. */
const SERVER_SCORE_A = 69;
const SERVER_SCORE_B = 75;

export interface ReplicatedScoreRow {
  readonly modeId: string;
  readonly mapId: string;
  /** What the server said, on the header. */
  readonly serverScore: number;
  /** What `GameMode.teamScore` returns on a replicated client. */
  readonly localCopy: number;
  /** What `MatchFlow.teamScore` returns on a replicated client. */
  readonly replicated: number;
  /** Whether this mode's local copy moves at all when replicated kills arrive. */
  readonly localCopyTracks: boolean;
}

export interface ReplicatedScoreAudit {
  readonly rows: readonly ReplicatedScoreRow[];
  readonly problems: string[];
  readonly kills: number;
}

/**
 * One mode, on a replicated flow, after `KILLS` replicated kills and one snapshot.
 *
 * The kills go on the bus as `DamageDealt` with `lethal`, which is exactly how they reach a
 * networked client — `EventCollector` writes them and `NetClient` replays them onto this bus.
 * Nothing here calls `simulate`, for the same reason a real client does not: a replicated flow
 * is driven by `applyReplicated` alone.
 */
function auditOne(flow: MatchFlow, bus: ReturnType<typeof createGameBus>): void {
  /*
   * The snapshot first, and the kills after it. Order, not tidiness.
   *
   * `MatchFlow` refuses to score outside `LIVE` — *"a round that ended two ticks ago is not
   * still scoring"* — and a replicated flow reaches `LIVE` only by being told. Emitting the
   * kills first put every one of them into a `WARMUP` phase that dropped them on the floor, and
   * the audit then reported a zero that was its own fault rather than the code's. It went red
   * on Free-for-All, which is the one mode that could tell the difference, which is the
   * argument for having a mode in the table whose local copy is supposed to move.
   */
  flow.applyReplicated({
    phase: 'LIVE',
    round: 1,
    scoreA: SERVER_SCORE_A,
    scoreB: SERVER_SCORE_B,
    secondsRemaining: 120,
    phaseSeconds: 0,
    serverTick: 67_010,
  });

  for (let i = 0; i < KILLS; i++) {
    /*
     * Both directions, and that is not symmetry for its own sake.
     *
     * Free-for-All's `teamScore` is the highest kill count among its own rows, which the
     * replicated path *does* maintain — so it is the one mode whose local copy moves, and it is
     * the reason this looked plausible for a milestone. A run that only ever killed one way
     * would show FFA at zero as well and hide the exception the report needs to name.
     */
    const attackerIsA = i % 2 === 0;
    const attacker = (attackerIsA ? 100 : 200) + (i % 3);
    const victim = (attackerIsA ? 200 : 100) + (i % 3);

    // Both events, in the order the real path produces them: `EventCollector` writes the damage
    // and the kill, and `NetClient` replays them onto this bus.
    bus.emit(EV.DamageDealt, {
      sourceId: attacker,
      targetId: victim,
      amount: 100,
      zone: 'torso',
      lethal: true,
      weaponId: 'm4',
      x: 0,
      y: 0,
      z: 0,
      distance: 12,
      falloffLoss: 0,
      penetrationLoss: 0,
    });
    bus.emit(EV.EntityKilled, {
      targetId: victim,
      sourceId: attacker,
      weaponId: 'm4',
      zone: 'torso',
    });
  }
}

export function auditReplicatedScore(): ReplicatedScoreAudit {
  const rows: ReplicatedScoreRow[] = [];
  const problems: string[] = [];

  for (const entry of MODES) {
    const map = MAPS.find((m) => modesForMap(m.id).some((mode) => mode.id === entry.id));
    if (map === undefined) continue;

    const bus = createGameBus();
    const score = new ScoreSystem(bus);
    // Rows for both sides, so a mode that reads them has something to read. Registered before
    // the kills, exactly as `NetSession.onRosterEntry` does it on a real client.
    for (let i = 0; i < 3; i++) {
      score.register(100 + i, `A${i}`, 'A');
      score.register(200 + i, `B${i}`, 'B');
    }

    const mode = entry.create({ bus, score, roster: [], mapDef: map.def });
    const flow = new MatchFlow({
      bus,
      score,
      roster: [],
      mode,
      mapId: map.id,
      mapName: map.name,
      localTeam: 'A',
      onSidesSwapped: () => {},
      // The whole point: this is the client's arrangement, not the server's.
      authoritative: false,
    });

    auditOne(flow, bus);

    const localCopy = mode.teamScore('A');
    const replicated = flow.teamScore('A');
    rows.push({
      modeId: entry.id,
      mapId: map.id,
      serverScore: SERVER_SCORE_A,
      localCopy,
      replicated,
      localCopyTracks: localCopy !== 0,
    });

    if (replicated !== SERVER_SCORE_A) {
      problems.push(
        `${entry.id}: MatchFlow.teamScore('A') returned ${replicated} where the server said ` +
          `${SERVER_SCORE_A}. A replicated client reads the score through the flow, and if that ` +
          'does not carry the header there is nowhere left for it to come from.',
      );
    }
    if (localCopy === SERVER_SCORE_A) {
      problems.push(
        `${entry.id}: GameMode.teamScore('A') returned the server's ${SERVER_SCORE_A} on a ` +
          'replicated client. That should be impossible — the mode does not score there — and ' +
          'if it has become possible, this audit is no longer describing the code.',
      );
    }
    flow.dispose();
    score.dispose();
  }

  return { rows, problems, kills: KILLS };
}
