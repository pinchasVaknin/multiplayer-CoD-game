import { EV, createGameBus } from '../core/Events';
import { LocalIdentity } from '../combat/LocalIdentity';
import { ScoreSystem, type ReplicatedScoreRow as WireScoreRow } from '../combat/ScoreSystem';
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
 *
 * ## The rows too (M13 Phase B, bug 4.3)
 *
 * Since Phase B a networked client's rows are the server's, delivered whole by
 * `MsgS.Scoreboard` and applied by `ScoreSystem.applyReplicated`. That path has exactly one
 * caller — `MatchWorld`, in the browser — which no harness runs, and a shared method with one
 * caller the harness never invokes is the shape round 5's B7 found broken. So `auditReplica`
 * drives the replica directly: a board arrives, a smaller board arrives (a row removed), the
 * replicated kill events that used to build the board arrive — and the rows must be the last
 * board's, no more and no less, with the row objects the board bound still the same objects.
 */

/** Kills replayed per mode. Enough that a tally which counts anything is visibly non-zero. */
const KILLS = 12;

/** What the server is pretending to have reached, so the replicated number is unmistakable. */
const SERVER_SCORE_A = 69;
const SERVER_SCORE_B = 75;

interface ReplicatedScoreRow {
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

interface ReplicaRow {
  readonly step: string;
  readonly rows: number;
  readonly detail: string;
}

export interface ReplicatedScoreAudit {
  readonly rows: readonly ReplicatedScoreRow[];
  readonly replica: readonly ReplicaRow[];
  readonly problems: string[];
  readonly kills: number;
}

function wireRow(entityId: number, name: string, team: 'A' | 'B', kills: number, deaths: number): WireScoreRow {
  return {
    entityId, displayName: name, team, kills, deaths, assists: 0, score: kills * 100, streak: 0,
    bestStreak: kills, shotsFired: kills * 3, shotsHit: kills, damageDealt: kills * 100,
    headshots: 0, captures: 0, defends: 0, plants: 0, defuses: 0, tags: 0,
  };
}

/**
 * The replica half, driven the way the browser drives it (M13 Phase B).
 *
 * Three boards and a burst of events, asserted after each:
 *
 *  1. A full board of four lands on an empty replica: four rows, the local one flagged.
 *  2. The replicated kill events that used to build the board land: the rows must not move,
 *     because a replica counts nothing for itself — that is `authoritative: false`.
 *  3. A board of three lands, one row gone and one row's kills up: three rows, the kills
 *     applied **in place** — the object the first board created is the object the third
 *     updated, which is what lets `Scoreboard` keep the slot it bound.
 */
function auditReplica(problems: string[]): ReplicaRow[] {
  const out: ReplicaRow[] = [];
  const bus = createGameBus();
  const identity = new LocalIdentity();
  identity.adopt(2);
  const score = new ScoreSystem(bus, identity, false);

  const first = [
    wireRow(1, 'OP1', 'A', 3, 1),
    wireRow(2, 'OP2', 'B', 1, 4),
    wireRow(100, 'BOT-A', 'A', 5, 2),
    wireRow(101, 'BOT-B', 'B', 0, 0),
  ];
  score.applyReplicated(first);
  const mine = score.row(2);
  out.push({ step: 'full board', rows: score.rows.length, detail: `local row ${mine?.isLocal === true ? 'flagged' : 'NOT flagged'}` });
  if (score.rows.length !== 4) problems.push(`replica: a board of 4 produced ${score.rows.length} row(s)`);
  if (mine?.isLocal !== true) problems.push('replica: the local seat\'s row is not flagged isLocal');

  // The events a networked client still receives, and used to count. It must not any more.
  for (let i = 0; i < 6; i++) {
    bus.emit(EV.DamageDealt, {
      sourceId: 1, targetId: 101, amount: 100, zone: 'torso', lethal: true, weaponId: 'm4',
      x: 0, y: 0, z: 0, distance: 12, falloffLoss: 0, penetrationLoss: 0,
    });
    bus.emit(EV.WeaponFired, {
      weaponId: 'm4', sourceId: 1, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1, endX: 0, endY: 0, endZ: 0,
      distance: 12, shotIndex: i, spreadDeg: 0, tracer: false, hitTarget: true, ammoInMag: 20,
      pellets: 1, pelletsHit: 1, minimapPing: true,
    });
  }
  const op1 = score.row(1);
  out.push({ step: 'events', rows: score.rows.length, detail: `OP1 ${op1?.kills}k/${op1?.shotsFired}sh after 6 replicated kills` });
  if (op1 === undefined || op1.kills !== 3 || op1.shotsFired !== 9 || op1.damageDealt !== 300) {
    problems.push(
      `replica: replicated events moved a row the server owns — OP1 reads ` +
        `${op1?.kills}k/${op1?.shotsFired}sh/${op1?.damageDealt}dmg against the board's 3k/9sh/300dmg`,
    );
  }

  const second = [
    wireRow(1, 'OP1', 'A', 7, 1),
    wireRow(2, 'OP2', 'B', 1, 4),
    wireRow(100, 'BOT-A', 'A', 5, 2),
  ];
  score.applyReplicated(second);
  const op1After = score.row(1);
  out.push({
    step: 'smaller board',
    rows: score.rows.length,
    detail: `BOT-B ${score.row(101) === undefined ? 'removed' : 'STILL THERE'}, OP1 ${op1After?.kills}k, ` +
      `row object ${op1After === op1 ? 'kept' : 'REPLACED'}`,
  });
  if (score.rows.length !== 3 || score.row(101) !== undefined) {
    problems.push(`replica: a row absent from the board was not removed (${score.rows.length} rows, BOT-B ${score.row(101) === undefined ? 'gone' : 'present'})`);
  }
  if (op1After?.kills !== 7) problems.push(`replica: OP1's kills read ${op1After?.kills} after a board saying 7`);
  if (op1After !== op1) problems.push('replica: a row was replaced rather than updated in place — the board\'s bound slot would be orphaned');

  score.dispose();
  return out;
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
      // Irrelevant to this audit — nothing here reads the death panel — but stated rather than
      // defaulted, because a zero that means "no killer" would be a lie about these rows.
      killerHealth: 100,
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

  const replica = auditReplica(problems);
  return { rows, replica, problems, kills: KILLS };
}
