import type { Match } from '../Match';
import { accuracy, type ScoreTeam } from '../combat/ScoreSystem';
import { EV, type GameBus } from '../core/Events';
import { formatClock } from '../ui/HudBanner';
import type { MapEntry } from '../modes/ModeRegistry';
import { FOUNDRY_LANES, type LaneDef } from '../world/maps/foundry';
import { MAX_WAYPOINTS, Path, type PathClient } from '../ai/Pathing';
import type { AiDebug } from './AiDebug';
import type { MatchHarness } from './MatchHarness';
import type { DebugOverlay } from './DebugOverlay';

/**
 * The M4 debug panels (brief S7): mode state, objectives, lane timings, spawn scoring and a
 * killfeed event log.
 *
 * Everything here hangs off the existing overlay's hooks rather than running a timer of its
 * own — 15 Hz for text, 5 Hz for canvases — which is what keeps the instrumentation out of
 * the frame times it exists to report.
 *
 * The lane timing is the one that does real work, and it is the answer to acceptance
 * criterion 3. It runs the *actual pathfinder* from each team's lane spawn to the point in
 * that lane where the two teams meet, measures the smoothed path, and converts it to seconds
 * at sprint speed. A hand-measured straight line would have reported the distance the author
 * intended rather than the distance a player walks around the cover the author placed.
 */

export interface LaneTiming {
  lane: string;
  /** 'A' walks from the south home spawn, 'B' from the north one. */
  team: ScoreTeam;
  /** Metres along the smoothed path. */
  metres: number;
  /** Seconds at sprint speed. */
  seconds: number;
  reachable: boolean;
}

export interface LaneReport {
  timings: LaneTiming[];
  /** Slowest / fastest as a percentage. Acceptance criterion 3 wants this under ~15%. */
  spreadPercent: number;
  sprintSpeed: number;
}

export class ModePanel {
  private readonly match: Match;
  private readonly map: MapEntry;
  private readonly harness: MatchHarness;
  private readonly aiDebug: AiDebug;
  private readonly unsubscribe: Array<() => void> = [];

  private readonly fPhase: { el: HTMLElement; last: string };
  private readonly fScore: { el: HTMLElement; last: string };
  private readonly fClock: { el: HTMLElement; last: string };
  private readonly fRespawn: { el: HTMLElement; last: string };
  private readonly fLocal: { el: HTMLElement; last: string };
  private readonly fSpawnTiers: { el: HTMLElement; last: string };
  private readonly fSpawnMin: { el: HTMLElement; last: string };
  private readonly fLanes: { el: HTMLElement; last: string };
  private readonly feedLog: HTMLElement;

  private laneCache: LaneReport | null = null;

  constructor(
    overlay: DebugOverlay,
    match: Match,
    map: MapEntry,
    harness: MatchHarness,
    aiDebug: AiDebug,
    bus: GameBus,
  ) {
    this.match = match;
    this.map = map;
    this.harness = harness;
    this.aiDebug = aiDebug;

    const mode = overlay.section('Mode', overlay.leftColumn);
    this.fPhase = mode.addField('Phase / round');
    this.fScore = mode.addField('Score A / B');
    this.fClock = mode.addField('Clock');
    this.fRespawn = mode.addField('Respawn gate');
    this.fLocal = mode.addField('You');

    const spawns = overlay.section('Spawns', overlay.leftColumn);
    this.fSpawnTiers = spawns.addField('Safe / hidden / least-bad');
    this.fSpawnMin = spawns.addField('Min enemy · cone · visible');
    spawns.addNode(
      this.toggle('Spawn score visualisation (needs F4)', false, (on) => {
        this.aiDebug.setSpawnVizEnabled(on);
      }),
    );

    const lanes = overlay.section('Lanes & objectives', overlay.leftColumn);
    this.fLanes = lanes.addField('Spawn to centre');
    lanes.addNode(
      this.button('Measure lane timings', () => {
        this.laneCache = this.measureLanes();
        this.printLanes();
      }),
    );
    lanes.addNode(
      this.toggle('Objectives on minimap', false, (on) => {
        this.match.ui.hud.minimap.showObjectives = on;
      }),
    );
    lanes.addNode(this.objectiveList());

    const feed = overlay.section('Killfeed log', overlay.leftColumn);
    this.feedLog = document.createElement('div');
    this.feedLog.className = 'dbg-log';
    feed.addNode(this.feedLog);

    const harnessSection = overlay.section('Match harness', overlay.leftColumn);
    harnessSection.addNode(
      this.button('Run 3 matches (heap)', () => {
        void this.harness.run(3);
      }),
    );
    harnessSection.addNode(
      this.button('Run 10 matches (heap)', () => {
        void this.harness.run(10);
      }),
    );
    harnessSection.addNode(
      this.button('Swap sides now', () => {
        this.match.flow.swapSides();
        console.info(`[ModePanel] sides swapped: ${String(this.match.flow.sidesSwapped)}`);
      }),
    );

    this.unsubscribe.push(
      bus.on(EV.KillfeedEntry, (p) => {
        const line = document.createElement('div');
        line.className = 'dbg-log__line';
        const weapon = p.headshot ? `${p.weaponId} · HS` : p.weaponId;
        line.textContent = p.suicide
          ? `— ${p.victimName} (${weapon})`
          : `${p.killerName} [${p.killerTeam}] → ${p.victimName} [${p.victimTeam}] (${weapon})`;
        this.feedLog.prepend(line);
        while (this.feedLog.childElementCount > 12) this.feedLog.lastElementChild?.remove();
      }),
    );

    overlay.addTextHook(() => this.refresh());
  }

  /** The lane report, measured on demand and cached. Exposed on `__operator.laneReport()`. */
  laneReport(): LaneReport {
    if (this.laneCache === null) this.laneCache = this.measureLanes();
    return this.laneCache;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  // -- lane timing -----------------------------------------------------------

  /**
   * Path each lane, both directions, and convert to seconds.
   *
   * Uses the match's own `Pathfinder`, which is resumable and budgeted — so it is stepped
   * here with a generous budget rather than being asked to solve inside one tick. The result
   * is the smoothed path a bot would actually follow, which is the same route a player takes
   * because it is the same navmesh.
   */
  private measureLanes(): LaneReport {
    const bots = this.match.bots;
    const nav = bots.nav;
    // The live config, so a retuned sprint speed changes the reported timings rather than
    // leaving the panel quoting a number the game no longer uses.
    const sprint = bots.sprintSpeed;
    const timings: LaneTiming[] = [];

    const lanes: readonly LaneDef[] =
      this.map.id === 'mp_foundry'
        ? FOUNDRY_LANES
        : // Any other map has no authored lanes; measure the one thing it does have.
          [
            {
              name: 'MAP',
              center: { x: 0, y: 0, z: 0 },
              a: this.map.def.spawns[0]?.position ?? { x: 0, y: 0, z: 0 },
              b: this.map.def.spawns[1]?.position ?? { x: 0, y: 0, z: 0 },
            },
          ];

    for (const lane of lanes) {
      for (const team of ['A', 'B'] as const) {
        const from = team === 'A' ? lane.a : lane.b;
        const startCell = nav.nearestCell(from.x, from.y, from.z, 12);
        const goalCell = nav.nearestCell(lane.center.x, lane.center.y, lane.center.z, 12);
        const metres = measurePath(bots, startCell, goalCell);
        timings.push({
          lane: lane.name,
          team,
          metres,
          seconds: metres > 0 ? metres / sprint : 0,
          reachable: metres > 0,
        });
      }
    }

    let fastest = Infinity;
    let slowest = 0;
    for (const t of timings) {
      if (!t.reachable) continue;
      if (t.seconds < fastest) fastest = t.seconds;
      if (t.seconds > slowest) slowest = t.seconds;
    }
    const spread = fastest === Infinity || fastest <= 0 ? 0 : ((slowest - fastest) / fastest) * 100;
    return { timings, spreadPercent: spread, sprintSpeed: sprint };
  }

  private printLanes(): void {
    const report = this.laneCache;
    if (report === null) return;
    const rows = report.timings.map((t) => ({
      lane: t.lane,
      team: t.team,
      metres: Number(t.metres.toFixed(2)),
      seconds: Number(t.seconds.toFixed(2)),
      reachable: t.reachable,
    }));
    console.info(
      `[ModePanel] lane timings at ${report.sprintSpeed.toFixed(2)} m/s sprint · ` +
        `spread ${report.spreadPercent.toFixed(1)}%`,
    );
    console.table(rows);
  }

  // -- read-outs -------------------------------------------------------------

  private refresh(): void {
    const flow = this.match.flow;
    const mode = this.match.mode;
    const score = this.match.score;

    set(
      this.fPhase,
      `${flow.currentPhase} · round ${flow.round}/${mode.roundsToWin}` +
        (flow.sidesSwapped ? ' · SWAPPED' : ''),
    );
    set(
      this.fScore,
      `${mode.teamScore('A')} / ${mode.teamScore('B')} (limit ${mode.scoreLimit})`,
    );
    set(
      this.fClock,
      `${formatClock(flow.secondsRemaining)} · phase ${flow.phaseSecondsRemaining.toFixed(1)}s`,
    );
    const lives = flow.livesRemaining(0);
    set(
      this.fRespawn,
      `${flow.respawnAllowed(0) ? 'open' : 'closed'} · lives ${Number.isFinite(lives) ? lives : '∞'}`,
    );

    const mine = score.row(0);
    if (mine === undefined) {
      set(this.fLocal, '—');
    } else {
      const pct = accuracy(mine);
      set(
        this.fLocal,
        `${mine.kills}k ${mine.deaths}d · ${mine.score} pts · streak ${mine.streak}/${mine.bestStreak}` +
          ` · acc ${pct < 0 ? '—' : `${pct.toFixed(0)}%`}`,
      );
    }

    const spawns = this.match.bots.spawns.stats;
    set(this.fSpawnTiers, `${spawns.safe} / ${spawns.hidden} / ${spawns.leastBad} of ${spawns.selections}`);
    set(
      this.fSpawnMin,
      `${spawns.minEnemyDistance === Infinity ? '—' : `${spawns.minEnemyDistance.toFixed(2)} m`}` +
        ` · ${spawns.coneViolations} · ${spawns.visibleViolations}`,
    );

    const lanes = this.laneCache;
    set(
      this.fLanes,
      lanes === null
        ? 'not measured'
        : lanes.timings
            .filter((t) => t.team === 'A')
            .map((t) => `${t.lane[0] ?? '?'}${t.seconds.toFixed(2)}s`)
            .join(' · ') + ` · spread ${lanes.spreadPercent.toFixed(1)}%`,
    );
  }

  private objectiveList(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'dbg-log';
    for (const o of this.map.def.objectives) {
      const line = document.createElement('div');
      line.className = 'dbg-log__line';
      line.textContent =
        `${o.kind.toUpperCase()} ${o.label} · ` +
        `${o.position.x.toFixed(0)}, ${o.position.z.toFixed(0)} · r${o.radius.toFixed(1)}`;
      wrap.appendChild(line);
    }
    return wrap;
  }

  private button(label: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dbg-btn dbg-btn--block';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private toggle(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'dbg-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    const text = document.createElement('span');
    text.textContent = label;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, text);
    return wrap;
  }
}

/**
 * Run one A* to completion and return the smoothed path length in metres, or 0.
 *
 * The pathfinder is resumable by design (S6.6) and normally spends a budget per tick. Here it
 * is stepped until it finishes, because a measurement is not a frame — and it is the *real*
 * pathfinder against the *real* navmesh, so what comes back is the route a bot would walk
 * around the cover the map author placed rather than the straight line they had in mind.
 */
function measurePath(bots: Match['bots'], startCell: number, goalCell: number): number {
  if (startCell < 0 || goalCell < 0) return 0;
  const client = new LanePathClient();
  bots.pathfinder.request(client, startCell, goalCell);
  // Generous: the grid is ~27k nodes and a lane crossing is a few thousand expansions.
  for (let i = 0; i < 64 && !client.done; i++) bots.pathfinder.step(4096);
  if (!client.found) return 0;

  const nav = bots.nav;
  let total = 0;
  let px = nav.centerX(nav.indexOfX(startCell));
  let pz = nav.centerZ(nav.indexOfZ(startCell));
  for (let i = 0; i < client.path.count && i < MAX_WAYPOINTS; i++) {
    const wx = client.path.x[i] ?? px;
    const wz = client.path.z[i] ?? pz;
    total += Math.hypot(wx - px, wz - pz);
    px = wx;
    pz = wz;
  }
  return total;
}

/** A `PathClient` that exists for the length of one measurement. */
class LanePathClient implements PathClient {
  readonly pathClientId = -1;
  readonly path = new Path();

  done = false;
  found = false;

  onPathReady(found: boolean): void {
    this.done = true;
    this.found = found;
  }
}

function set(field: { el: HTMLElement; last: string }, text: string): void {
  if (field.last === text) return;
  field.last = text;
  field.el.textContent = text;
}
