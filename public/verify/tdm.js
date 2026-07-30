/**
 * Milestone 4 acceptance suite.
 *
 * Everything that is purely a property of the simulation is measured through the real
 * systems: the real Loop, the real CollisionWorld, the real navmesh, the real MatchFlow.
 * Nothing here reimplements a rule in order to check it.
 *
 * The frame source is substituted for the same reason M1's `framerate.js` substitutes it —
 * `requestAnimationFrame` does not fire in a tab that is not compositing, so without this
 * no frame, no sim tick and no match would ever happen. The loop, accumulator, input path,
 * collision, AI and mode are untouched; only what calls `frame()` changes.
 *
 * Run it on a freshly loaded page: Chrome clamps timers in a tab that has been hidden for
 * about five minutes, which would make every wall-clock number here meaningless.
 *
 *   fetch('/verify/tdm.js').then(r => r.text()).then(eval)
 *   await __verifyTdm.all()          // everything, in order
 *   await __verifyTdm.snagSweep()    // criterion 2 on its own
 *   __verifyTdm.lanes()              // criterion 3
 */
(() => {
  const api = window.__operator;
  const game = api.game;

  /**
   * Results are stashed here as well as returned.
   *
   * A check that runs for thirty wall seconds outlives the console call that started it, and
   * losing a measurement to a tool timeout is not a reason to run it again.
   */
  const results = {};

  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  let frameSourceInstalled = false;

  /**
   * Substitute the frame source with a `MessageChannel`.
   *
   * M1's `framerate.js` used `setTimeout`, which is the right tool when the point is to *pace*
   * frames at a chosen interval. It is the wrong tool here: Chrome clamps timers in a tab that
   * is not visible, and the first run of this suite got 348 sim ticks out of nineteen wall
   * seconds — the measurement was of the browser's throttling, not of the game.
   *
   * A `MessagePort` callback is a macrotask that is not clamped, so the loop runs as fast as it
   * can actually do the work. Timers still interleave, so the `await sleep(...)` this file is
   * built on continues to work. The loop, accumulator, sim, AI, mode and collision are
   * untouched; only what calls `frame()` changes.
   */
  function installFrameSource() {
    if (frameSourceInstalled) return;
    frameSourceInstalled = true;
    const channel = new MessageChannel();
    const pending = new Map();
    let nextId = 1;
    channel.port1.onmessage = (event) => {
      const id = event.data;
      const cb = pending.get(id);
      if (cb === undefined) return;
      pending.delete(id);
      cb(performance.now());
    };
    window.requestAnimationFrame = (cb) => {
      const id = nextId++;
      pending.set(id, cb);
      channel.port2.postMessage(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
    };
    // The loop was started at boot against the real rAF, which never fired. Restart it so it
    // picks up the substitute.
    game.loop.stop();
    game.loop.start();
  }

  function restoreFrameSource() {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancel;
    frameSourceInstalled = false;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate, timeoutMs, label) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (predicate()) return true;
      await sleep(40);
    }
    console.warn(`[verifyTdm] timed out waiting for ${label}`);
    return false;
  }

  function toMenu() {
    if (game.currentState === 'MATCH') game.transitionTo('MENU');
    else if (game.currentState === 'SUMMARY') game.transitionTo('MENU');
  }

  function startMatch(mapId) {
    toMenu();
    if (mapId !== undefined) game.menuSelection.mapId = mapId;
    game.transitionTo('MATCH');
    return api.match();
  }

  // ==========================================================================
  // Criterion 3 — lane timings
  // ==========================================================================

  /**
   * Spawn-to-centre timings for all three lanes, both directions, measured by pathing the
   * real navmesh with the real A* and dividing by sprint speed.
   */
  function lanes() {
    const report = api.laneReport();
    const rows = report.timings.map((t) => ({
      lane: t.lane,
      from: t.team === 'A' ? 'south spawn' : 'north spawn',
      metres: Number(t.metres.toFixed(2)),
      seconds: Number(t.seconds.toFixed(2)),
      reachable: t.reachable,
    }));
    console.info(
      `[verifyTdm] criterion 3 — lane timings at ${report.sprintSpeed.toFixed(2)} m/s sprint. ` +
        `Spread slowest/fastest: ${report.spreadPercent.toFixed(1)}% (target under ~15%)`,
    );
    console.table(rows);
    results.lanes = { rows, spreadPercent: Number(report.spreadPercent.toFixed(2)), sprintSpeed: report.sprintSpeed };
    return results.lanes;
  }

  // ==========================================================================
  // Criterion 2 — sprint along every wall
  // ==========================================================================

  /**
   * Drive the real PlayerController at sprint speed along every wall in the map and report
   * anything that catches.
   *
   * A snag is **failure to make progress**, not merely being blocked: sliding along a wall
   * is blocked on every tick and is exactly what is supposed to happen. So each pass tracks
   * how far it has advanced *along the run* and flags a tick where the last 20 ticks moved
   * the player less than 0.15 m while the command still said go. That is what catching on a
   * corner actually is, and it cannot be confused with a clean slide.
   *
   * Each pass also stops the moment it reaches the end of its run. The first version of this
   * did not, and every wall "snagged" — because after arriving the player spent four hundred
   * ticks pressed into the far corner at zero speed. The finding was in the harness.
   *
   * Two kinds of run:
   *   - **wall**: hugged from both sides in turn, so which side the wall is on never has to
   *     be authored and cannot be authored wrong.
   *   - **traverse**: ramps, stairs, the bridge and the catwalk runs, driven straight with no
   *     hug, and additionally asserted to *arrive at the expected height* — which is the real
   *     question about a ramp.
   *
   * The capsule is asserted not to be inside geometry on any tick either way, using the same
   * `overlapCapsule` the navmesh bake uses.
   */
  async function snagSweep() {
    if (api.match() === null) startMatch('mp_foundry');
    // The loop is stopped: this drives the controller by hand so nothing else moves the
    // player and no bot shoots them half way along a wall.
    const wasRunning = game.loop.isRunning;
    game.loop.stop();

    const world = game.loadedMap.collision;
    const player = game.player;
    const cfg = game.movementConfig;
    const Btn = { Jump: 1, Crouch: 2, Sprint: 4, Ads: 8, Fire: 16, Reload: 32 };

    /**
     * (kind, label, x0, z0, x1, z1, startY, expectEndY)
     *
     * **Every wall run line sits exactly `capsuleRadius + 0.01` from the face it follows**, so
     * the pass rubs the wall along its length without being asked to stand inside it. That is
     * not fussiness: run lines authored 0.5 m too far in produced fourteen "snags", every one
     * of them the harness driving the player into a doorway and jamming it on the far jamb. A
     * concave corner is supposed to stop you.
     */
    const runs = [
      ['wall', 'perimeter N', -27, -24.64, 27, -24.64],
      ['wall', 'perimeter S', 27, 24.64, -27, 24.64],
      ['wall', 'perimeter W', -28.64, -23, -28.64, 23],
      ['wall', 'perimeter E', 28.64, 23, 28.64, -23],
      ['wall', 'hall N exterior', -10.6, -12.06, 10.6, -12.06],
      ['wall', 'hall S exterior', 10.6, 12.06, -10.6, 12.06],
      ['wall', 'hall W exterior', -12.06, -10.6, -12.06, 10.6],
      ['wall', 'hall E exterior', 12.06, 10.6, 12.06, -10.6],
      ['wall', 'hall N interior', -10.4, -10.64, 10.4, -10.64],
      ['wall', 'hall S interior', 10.4, 10.64, -10.4, 10.64],
      ['wall', 'hall W interior', -10.64, -10.4, -10.64, 10.4],
      ['wall', 'hall E interior', 10.64, 10.4, 10.64, -10.4],
      ['wall', 'west container spine (east face)', -23.39, -21, -23.39, 9],
      ['wall', 'east container spine (west face)', 23.39, 21, 23.39, -9],
      ['wall', 'west mid container (north face)', -21, -7.61, -14, -7.61],
      ['wall', 'east mid container (south face)', 21, 7.61, 14, 7.61],
      ['wall', 'hall partition (north face)', -8.5, -8.66, -0.5, -8.66],
      ['wall', 'hall partition (south face)', -0.5, -7.34, -8.5, -7.34],

      ['traverse', 'west ramp up', -20.4, 7.9, -12.4, 7.9, 0.05, 4.0],
      ['traverse', 'east ramp up', 20.4, -7.9, 12.4, -7.9, 0.05, 4.0],
      ['traverse', 'internal stair E up', 7.4, -0.4, 7.4, -8.4, 0.05, 4.0],
      ['traverse', 'internal stair W up', -7.4, 0.4, -7.4, 8.4, 0.05, 4.0],
      ['traverse', 'ring west run', -10.4, -8, -10.4, 8, 4.05, 4.0],
      ['traverse', 'ring north run', -10.4, -10.4, 10.4, -10.4, 4.05, 4.0],
      ['traverse', 'ring east run', 10.4, 8, 10.4, -8, 4.05, 4.0],
      ['traverse', 'ring south run', 10.4, 10.4, -10.4, 10.4, 4.05, 4.0],
      ['traverse', 'centre bridge west→east', -8.4, 0, 8.4, 0, 4.05, 4.0],
      ['traverse', 'ramp down west', -12.4, 7.9, -20.4, 7.9, 4.05, 0.0],
      ['traverse', 'hall main gate N→S', 0, -14, 0, 14, 0.05, 0.0],
      ['traverse', 'hall main gate W→E', -14, 0, 14, 0, 0.05, 0.0],
    ];

    /** Window over which "no progress" is judged, in ticks. */
    const PROGRESS_WINDOW = 20;
    const PROGRESS_MIN_M = 0.15;
    /**
     * Perpendicular distance at which a pass has stopped being a wall hug.
     *
     * Each run is driven from both sides, so one of the two is pushing *away* from the wall
     * into open floor. Without this the away-side pass wanders across the map and reports a
     * snag on whatever unrelated geometry it eventually reaches — which is how the first
     * version of this sweep produced findings against walls it had never touched.
     */
    const OFF_LINE_M = 0.9;

    const findings = [];
    const traversals = [];
    let totalTicks = 0;
    let intersecting = 0;
    let passes = 0;
    let skipped = 0;
    /** Per-wall summary, so a wall that was never actually hugged cannot pass by silence. */
    const wallRuns = new Map();

    function onePass(kind, label, x0, z0, x1, z1, startY, expectEndY, hug) {
      const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
      player.spawn(x0, startY, z0, yaw);
      passes++;

      const distance = Math.hypot(x1 - x0, z1 - z0);
      const ux = (x1 - x0) / distance;
      const uz = (z1 - z0) / distance;

      const cmd = {
        seq: 0,
        tickIndex: 0,
        moveX: 0,
        moveZ: 1,
        yaw,
        pitch: 0,
        buttons: Btn.Sprint,
        sampledAtMs: 0,
      };

      // Twice the time a clean run needs, so a genuine snag has room to be seen while the
      // pass still cannot wander past its own end.
      const maxTicks = Math.ceil((distance / 3.0) * 60) + 40;
      const progress = new Float64Array(maxTicks + 1);
      let snags = 0;
      let blockedTicks = 0;
      let worst = null;
      let arrived = false;
      let ticksUsed = 0;
      let fellOff = false;
      let offLine = false;
      // A descending traversal is supposed to lose height; only a level one can fall off.
      const canFall = startY > 1 && expectEndY >= startY - 0.5;
      const arriveWithin = kind === 'traverse' ? 0.35 : 0.6;

      for (let t = 0; t < maxTicks; t++) {
        cmd.seq = t;
        cmd.tickIndex = t;
        cmd.sampledAtMs = t * (1000 / 60);
        player.step(cmd);
        const sim = player.sim;
        totalTicks++;
        ticksUsed = t + 1;

        if (world.overlapCapsule(sim.x, sim.y, sim.z, cfg.capsuleRadius, sim.capsuleHeight)) {
          intersecting++;
        }

        const dx = sim.x - x0;
        const dz = sim.z - z0;
        const advanced = dx * ux + dz * uz;
        // Signed: positive is to the right of the run direction.
        const signed = dx * -uz + dz * ux;
        const lateral = Math.abs(signed);
        progress[t] = advanced;

        /**
         * Hold the player `hug` metres off the line rather than pushing constantly toward it.
         *
         * A constant push escapes through the first doorway — and Foundry's walls all have
         * doorways, which is why the first run of this sweep quietly tested only the four
         * unbroken perimeter walls and reported success. A servo keeps the run on its line
         * across a gap and brings the player back onto the far jamb, which is exactly the
         * corner most likely to catch.
         */
        const error = signed - hug;
        const strafe = Math.max(-0.5, Math.min(0.5, -error * 1.6));
        const norm = 1 / Math.hypot(strafe, 1);
        cmd.moveX = strafe * norm;
        cmd.moveZ = norm;
        if (advanced >= distance - arriveWithin) {
          arrived = true;
          break;
        }
        if (kind === 'wall' && lateral > OFF_LINE_M) {
          offLine = true;
          break;
        }
        if (canFall && sim.y < startY - 1.2) {
          // Left the deck. The catwalks have no railings by design, so this is information
          // about the pass, not a defect.
          fellOff = true;
          break;
        }

        if (sim.blockedHorizontally) blockedTicks++;
        if (t < PROGRESS_WINDOW + 6) continue;
        const gained = advanced - (progress[t - PROGRESS_WINDOW] ?? 0);
        if (gained >= PROGRESS_MIN_M) continue;
        snags++;
        if (worst === null || gained < worst.gained) {
          worst = {
            gained: Number(gained.toFixed(3)),
            x: Number(sim.x.toFixed(2)),
            y: Number(sim.y.toFixed(2)),
            z: Number(sim.z.toFixed(2)),
            speed: Number(sim.speed.toFixed(2)),
            lateral: Number(lateral.toFixed(2)),
          };
        }
      }

      const sim = player.sim;
      if (offLine) skipped++;
      if (kind === 'wall') {
        const row = wallRuns.get(label) ?? { run: label, passesOnWall: 0, snagTicks: 0, blockedTicks: 0, arrived: 0 };
        if (!offLine) {
          row.passesOnWall++;
          row.snagTicks += snags;
          row.blockedTicks += blockedTicks;
          if (arrived) row.arrived++;
        }
        wallRuns.set(label, row);
      }
      if (snags > 0 && !offLine) {
        findings.push({
          run: `${label}${kind === 'wall' ? ` (hug ${hug > 0 ? 'right' : 'left'})` : ''}`,
          snagTicks: snags,
          blockedTicks,
          arrived,
          worst,
        });
      }
      if (kind === 'traverse') {
        traversals.push({
          run: label,
          arrived,
          fellOff,
          seconds: Number((ticksUsed / 60).toFixed(2)),
          endY: Number(sim.y.toFixed(2)),
          expectEndY,
          heightOk: Math.abs(sim.y - expectEndY) < 0.4,
        });
      }
    }

    for (const run of runs) {
      const [kind, label, x0, z0, x1, z1, startY, expectEndY] = run;
      const y0 = startY === undefined ? 0.05 : startY;
      if (kind === 'wall') {
        // Both sides in turn: which side the wall is on is never authored.
        // A light bias only: enough to keep contact, small enough that drifting into a
        // doorway leaves the capsule mostly outside the wall band so it slides back out.
        onePass(kind, label, x0, z0, x1, z1, y0, 0, 0.12);
        onePass(kind, label, x0, z0, x1, z1, y0, 0, -0.12);
      } else {
        onePass(kind, label, x0, z0, x1, z1, y0, expectEndY ?? 0, 0);
      }
      await sleep(0);
    }

    if (wasRunning) game.loop.start();

    console.info(
      `[verifyTdm] criterion 2 — ${passes} sprint passes over ${runs.length} runs, ` +
        `${totalTicks} ticks. ${skipped} passes left the wall and were discarded. ` +
        `Passes that failed to make progress: ${findings.length}. ` +
        `Ticks with the capsule inside geometry: ${intersecting}.`,
    );
    if (findings.length > 0) console.table(findings);
    const wallSummary = Array.from(wallRuns.values());
    const untested = wallSummary.filter((w) => w.passesOnWall === 0 || w.arrived === 0);
    console.info(
      `[verifyTdm] walls actually hugged: ${wallSummary.length - untested.length}/${wallSummary.length}. ` +
        `A wall with zero completed passes was never tested.`,
    );
    console.table(wallSummary);
    if (untested.length > 0) console.warn('[verifyTdm] walls with no completed hug pass:', untested);
    console.info('[verifyTdm] traversals (ramps, stairs, catwalk):');
    console.table(traversals);
    results.snag = {
      runs: runs.length,
      passes,
      skipped,
      totalTicks,
      intersecting,
      findings,
      traversals,
      wallSummary,
      untested,
    };
    return results.snag;
  }

  // ==========================================================================
  // Criterion 2, the other half — pinches the sweep would only find by luck
  // ==========================================================================

  /**
   * Every gap in the map that is too narrow for the capsule to pass but wide enough to look
   * passable.
   *
   * The sprint sweep found two of these by walking into them, and only because a run line
   * happened to pass through. That is not a way to be sure. This is the data check for the
   * whole bug class: take every solid collider as an axis-aligned footprint in plan, and for
   * every pair that overlaps vertically in the standing band, report any pair separated on one
   * axis by less than a capsule diameter while overlapping on the other.
   *
   * A gap under 0.70 m cannot be walked through at all; between 0.70 and 0.95 m it can, but it
   * will feel like snagging. Both are worth seeing. Gaps of zero are touching geometry and are
   * fine.
   */
  function clearanceAudit(minGap = 0.02, maxGap = 0.95) {
    const colliders = game.loadedMap.collision.colliders;
    const capsule = game.movementConfig.capsuleRadius * 2;
    const n = colliders.count;

    // Plan footprints from the collider AABBs, which already account for rotation.
    const boxes = [];
    for (let i = 0; i < n; i++) {
      const b = i * 6;
      const minY = colliders.aabb[b + 1];
      const maxY = colliders.aabb[b + 4];
      // Only geometry that stands in the way of a walking capsule matters.
      if (maxY <= 0.36 || minY >= 1.8) continue;
      boxes.push({
        i,
        minX: colliders.aabb[b],
        maxX: colliders.aabb[b + 3],
        minZ: colliders.aabb[b + 2],
        maxZ: colliders.aabb[b + 5],
        minY,
        maxY,
      });
    }

    const found = [];
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const p = boxes[a];
        const q = boxes[b];
        const gapX = Math.max(p.minX - q.maxX, q.minX - p.maxX);
        const gapZ = Math.max(p.minZ - q.maxZ, q.minZ - p.maxZ);
        // A corridor exists only where they are separated on one axis and overlap on the
        // other. Separated on both is a diagonal opening, which is wider than either gap.
        const corridorX = gapX > minGap && gapX < maxGap && gapZ < -0.05;
        const corridorZ = gapZ > minGap && gapZ < maxGap && gapX < -0.05;
        if (!corridorX && !corridorZ) continue;
        const gap = corridorX ? gapX : gapZ;
        found.push({
          axis: corridorX ? 'x' : 'z',
          gap: Number(gap.toFixed(3)),
          passable: gap >= capsule,
          at: {
            x: Number(((Math.max(p.minX, q.minX) + Math.min(p.maxX, q.maxX)) / 2).toFixed(2)),
            z: Number(((Math.max(p.minZ, q.minZ) + Math.min(p.maxZ, q.maxZ)) / 2).toFixed(2)),
          },
          // Overlap length along the corridor: a 0.2 m long pinch is a corner, a 6 m one is
          // a corridor you would try to run down.
          length: Number(
            (corridorX
              ? Math.min(p.maxZ, q.maxZ) - Math.max(p.minZ, q.minZ)
              : Math.min(p.maxX, q.maxX) - Math.max(p.minX, q.minX)
            ).toFixed(2),
          ),
        });
      }
    }
    /**
     * Only pinches long enough to walk into are interesting.
     *
     * A 5 cm corner overlap is not a corridor, and neither is the 0.7 m slot between the two
     * drums of a single barrel prop — a composite prop's own parts stand next to each other by
     * design. One metre is the shortest gap a player would read as a way through.
     */
    const real = found.filter((f) => f.length >= 1.0).sort((x, y) => x.gap - y.gap);
    const impassable = real.filter((f) => !f.passable);
    console.info(
      `[verifyTdm] clearance audit — ${boxes.length} standing colliders, ` +
        `${real.length} gaps under ${maxGap} m, of which ${impassable.length} are narrower ` +
        `than the ${capsule.toFixed(2)} m capsule.`,
    );
    if (real.length > 0) console.table(real);
    results.clearance = { standingColliders: boxes.length, gaps: real, impassable };
    return results.clearance;
  }

  // ==========================================================================
  // Criterion 4 — bots on the catwalks, in cover, over the centre
  // ==========================================================================

  /**
   * Sample where the bots actually are and what they are doing over a stretch of a live
   * match. Catwalk occupancy is measured by feet height, which is unambiguous: the deck is
   * at 4.0 m and there is nothing else above 1.6 m a bot can stand on.
   */
  async function botCoverage(seconds = 90) {
    installFrameSource();
    const match = api.match() ?? startMatch('mp_foundry');
    await waitFor(() => match.flow.isLive, 8000, 'round to go live');

    game.loop.simSpeed = 8;
    game.loop.maxStepsPerFrame = 10;

    const stats = {
      samples: 0,
      catwalkSamples: 0,
      botsEverOnCatwalk: new Set(),
      centreSamples: 0,
      coverPeak: 0,
      stateCounts: {},
      minEnemyDistanceOnSpawn: Infinity,
      spawnsSeen: 0,
    };

    const offSpawn = game.bus.on('bot.spawned', (p) => {
      stats.spawnsSeen++;
      if (p.nearestEnemy < stats.minEnemyDistanceOnSpawn) stats.minEnemyDistanceOnSpawn = p.nearestEnemy;
    });

    const deadline = performance.now() + (seconds / 8) * 1000;
    while (performance.now() < deadline && !match.flow.isOver) {
      for (const bot of match.bots.bots) {
        if (!bot.health.alive) continue;
        stats.samples++;
        if (bot.py > 3.0) {
          stats.catwalkSamples++;
          stats.botsEverOnCatwalk.add(bot.entityId);
        }
        // "Over the centre" is the hall footprint.
        if (Math.abs(bot.px) < 11 && Math.abs(bot.pz) < 11) stats.centreSamples++;
        stats.stateCounts[bot.state] = (stats.stateCounts[bot.state] ?? 0) + 1;
      }
      const occupied = match.bots.cover.occupiedCount;
      if (occupied > stats.coverPeak) stats.coverPeak = occupied;
      await sleep(50);
    }
    offSpawn();

    game.loop.simSpeed = 1;
    game.loop.maxStepsPerFrame = 5;

    const result = {
      simSeconds: Number(match.bots.simSeconds.toFixed(1)),
      samples: stats.samples,
      catwalkPercent: Number(((stats.catwalkSamples / Math.max(1, stats.samples)) * 100).toFixed(2)),
      distinctBotsOnCatwalk: stats.botsEverOnCatwalk.size,
      centrePercent: Number(((stats.centreSamples / Math.max(1, stats.samples)) * 100).toFixed(2)),
      coverSlotsHeldPeak: stats.coverPeak,
      coverSlotsTotal: match.bots.cover.count,
      states: stats.stateCounts,
      spawnsSeen: stats.spawnsSeen,
      minEnemyDistanceOnSpawn: Number(stats.minEnemyDistanceOnSpawn.toFixed(2)),
      spawnTiers: { ...match.bots.spawns.stats },
      ai: match.bots.report().ai,
      astar: match.bots.report().astar,
      stuckEvents: match.bots.report().stuckEvents,
      pathFailures: match.bots.report().pathFailures,
      score: { A: match.mode.teamScore('A'), B: match.mode.teamScore('B') },
    };
    console.info('[verifyTdm] criterion 4 + 5 — bot coverage');
    console.log(result);
    results.bots = result;
    return result;
  }

  // ==========================================================================
  // Criterion 8 — frame time during a real firefight
  // ==========================================================================

  async function frameProfile(seconds = 30) {
    installFrameSource();
    const match = api.match() ?? startMatch('mp_foundry');
    await waitFor(() => match.flow.isLive, 8000, 'round to go live');

    game.loop.simSpeed = 1;
    game.loop.maxStepsPerFrame = 5;
    api.stats().reset();
    match.bots.resetCounters();

    await sleep(seconds * 1000);
    api.stats().recompute();
    const s = api.stats();
    const bots = match.bots.report();
    const result = {
      botsAlive: match.bots.bots.filter((b) => b.health.alive).length,
      frame: {
        p50: Number(s.p50.toFixed(2)),
        p95: Number(s.p95.toFixed(2)),
        p99: Number(s.p99.toFixed(2)),
        worst: Number(s.worst.toFixed(2)),
        mean: Number(s.mean.toFixed(2)),
        samples: s.sampleCount,
      },
      simMs: Number(s.lastSimMs.toFixed(3)),
      ai: { meanMs: Number(bots.ai.meanMs.toFixed(3)), p99Ms: Number(bots.ai.p99Ms.toFixed(3)) },
      mode: { lastMs: Number(s.lastModeMs.toFixed(4)), peakMs: Number(s.peakModeMs.toFixed(3)) },
      hud: { lastMs: Number(s.lastHudMs.toFixed(3)), peakMs: Number(s.peakHudMs.toFixed(3)) },
      astarWorstNodes: bots.astar.worstNodesPerTick,
      audioVoices: game.audio.voiceCount,
      voicesDropped: game.audio.voicesDropped,
      note:
        'The frame source is an uncapped MessageChannel, so frames run as fast as the work ' +
        'allows and the percentiles are of real work rather than of a timer interval. They ' +
        'still exclude compositing, which never happens in a hidden tab. voicesDropped is ' +
        'cumulative for the page and only ever grows while the sim is fast-forwarded; it is ' +
        'flat during 1x play.',
    };
    console.info('[verifyTdm] criterion 8 — frame profile');
    console.log(result);
    results.frame = result;
    return result;
  }

  // ==========================================================================
  // Criterion 9 — fixed rate under load
  // ==========================================================================

  /**
   * Run the same stretch of match twice, once at a healthy frame rate and once with 55 ms of
   * real CPU burned inside every frame, and compare what the *simulation* did.
   *
   * The match clock is the interesting one: it is stored in ticks and derived to seconds, so
   * if it drifts under load the whole mode layer is frame-rate dependent.
   */
  async function fixedRate() {
    installFrameSource();
    const rows = [];

    for (const [label, load] of [
      ['unloaded', 0],
      ['55 ms CPU burn per frame', 55],
    ]) {
      const match = startMatch('mp_foundry');
      await waitFor(() => match.flow.isLive, 8000, 'round to go live');
      game.loop.syntheticLoadMs = load;
      api.stats().reset();

      const tick0 = game.loop.currentTick;
      const clock0 = match.flow.secondsRemaining;
      const wall0 = performance.now();
      await sleep(6000);
      const wallSeconds = (performance.now() - wall0) / 1000;
      const ticks = game.loop.currentTick - tick0;
      const clockSpent = clock0 - match.flow.secondsRemaining;
      game.loop.syntheticLoadMs = 0;
      api.stats().recompute();

      rows.push({
        label,
        wallSeconds: Number(wallSeconds.toFixed(3)),
        simTicks: ticks,
        simSeconds: Number((ticks / 60).toFixed(3)),
        measuredHz: Number((ticks / wallSeconds).toFixed(3)),
        matchClockSpent: Number(clockSpent.toFixed(3)),
        clockVsWall: Number((clockSpent / wallSeconds).toFixed(4)),
        framesRendered: api.stats().sampleCount,
        fps: Number((api.stats().sampleCount / wallSeconds).toFixed(1)),
      });
      toMenu();
    }

    const a = rows[0];
    const b = rows[1];
    const drift = Math.abs(b.clockVsWall - a.clockVsWall) / a.clockVsWall;
    console.info(
      `[verifyTdm] criterion 9 — match clock per wall second: ` +
        `${a.clockVsWall} unloaded vs ${b.clockVsWall} loaded (drift ${(drift * 100).toFixed(2)}%)`,
    );
    console.table(rows);
    results.fixedRate = { rows, driftPercent: Number((drift * 100).toFixed(3)) };
    return results.fixedRate;
  }

  // ==========================================================================
  // Criterion 6 — the HUD is telling the truth
  // ==========================================================================

  /**
   * Check the HUD against the systems behind it rather than against a screenshot: the
   * killfeed's newest row against the model's newest line, the banner against the mode, the
   * scoreboard against the score system, and the low-health state against health.
   */
  async function hudCheck() {
    installFrameSource();
    const match = api.match() ?? startMatch('mp_foundry');
    await waitFor(() => match.flow.isLive, 8000, 'round to go live');
    game.loop.simSpeed = 8;
    game.loop.maxStepsPerFrame = 10;

    // Let some kills happen so there is a feed to check.
    await waitFor(() => match.flow.killfeed.count >= 3, 30000, 'three kills');
    game.loop.simSpeed = 1;
    game.loop.maxStepsPerFrame = 5;
    await sleep(200);

    const feedModel = match.flow.killfeed.at(0);
    const feedRow = document.querySelector('.hud-feed__row');
    const names = feedRow === null ? [] : Array.from(feedRow.querySelectorAll('.hud-feed__name')).map((n) => n.textContent);
    const icon = feedRow === null ? null : feedRow.querySelector('.hud-feed__icon-svg');

    const bannerA = document.querySelector('.hud-banner__team--friendly .hud-banner__score');
    const bannerB = document.querySelector('.hud-banner__team--hostile .hud-banner__score');
    const clock = document.querySelector('.hud-banner__clock');

    // Scoreboard: open it through the command path, exactly as Tab does.
    match.ui.setScoreboardOpen(true);
    match.ui.scoreboard.refresh(match.score);
    // Scoped to the in-match board: the summary screen owns a second `Scoreboard` and an
    // unscoped selector counts both, which reads as twice the roster.
    const sbRoot = match.ui.scoreboard.element;
    const sbRows = Array.from(sbRoot.querySelectorAll('.sb__row')).filter((r) => !r.hidden);
    const sbLocal = sbRoot.querySelector('.sb__row--local');
    const sbCells = sbLocal === null ? [] : Array.from(sbLocal.querySelectorAll('.sb__cell')).map((c) => c.textContent);
    match.ui.setScoreboardOpen(false);

    /**
     * Low health: apply real damage through the one door and read the state back.
     *
     * `applySelfDamage` solves for a single round's worth, so it cannot exceed the weapon's
     * near damage (34) in one call however large the argument. Repeat until the threshold is
     * genuinely crossed rather than assuming one call gets there.
     */
    const before = { intensity: match.ui.lowHealthIntensity, muffle: game.audio.muffleAmount };
    // 34 + 34 + 20 from full leaves 12 HP: well under the 35 HP threshold and well clear of
    // zero, because a dead player has no low-health state and that would prove nothing.
    for (const amount of [34, 34, 20]) {
      match.applySelfDamage(amount);
      await sleep(50);
    }
    await sleep(200);
    const hurt = {
      health: Number(match.playerHealth.current.toFixed(1)),
      intensity: Number(match.ui.lowHealthIntensity.toFixed(3)),
      muffle: Number(game.audio.muffleAmount.toFixed(3)),
      vignetteOpacity: document.querySelector('.hud-low')?.style.opacity ?? null,
      dirIndicatorsAlive: Array.from(document.querySelectorAll('.hud-dir')).filter(
        (d) => Number(d.style.opacity) > 0,
      ).length,
    };
    // Directional indicator: fire one at a known bearing and read the transform back.
    match.ui.hud.showHitDirection(Math.PI / 2);
    await sleep(60);
    const dirTransforms = Array.from(document.querySelectorAll('.hud-dir'))
      .map((d) => d.style.transform)
      .filter((t) => t !== '');

    const minimapPings = match.ui.hud.minimap;
    const result = {
      killfeed: {
        modelNewest: feedModel === undefined ? null : `${feedModel.killerName} -> ${feedModel.victimName}`,
        domNewest: names.join(' -> '),
        matches: feedModel !== undefined && names[0] === feedModel.killerName && names[1] === feedModel.victimName,
        weaponIconDrawn: icon !== null,
        modelLines: match.flow.killfeed.count,
      },
      banner: {
        domA: bannerA?.textContent ?? null,
        domB: bannerB?.textContent ?? null,
        modeA: String(match.mode.teamScore('A')),
        modeB: String(match.mode.teamScore('B')),
        matches:
          bannerA?.textContent === String(match.mode.teamScore('A')) &&
          bannerB?.textContent === String(match.mode.teamScore('B')),
        clock: clock?.textContent ?? null,
      },
      scoreboard: {
        visibleRows: sbRows.length,
        rosterRows: match.score.rows.length,
        matches: sbRows.length === match.score.rows.length,
        localRowCells: sbCells,
        columns: match.mode.getScoreboardColumns().map((c) => c.label),
      },
      lowHealth: { before, after: hurt, thresholdHp: match.lowHealthThreshold },
      damageDirection: { indicators: dirTransforms.length, transforms: dirTransforms },
      minimap: {
        canvasPresent: document.querySelector('.hud-map__canvas') !== null,
        friendlyMarkers: minimapPings.friendlies.filter((f) => f.active).length,
      },
    };
    console.info('[verifyTdm] criterion 6 — HUD correctness');
    console.log(result);
    results.hud = result;
    return result;
  }

  // ==========================================================================
  // Criteria 1 + 7 — matches back to back, and the heap at each boundary
  // ==========================================================================

  async function matchCycle(count = 3) {
    installFrameSource();
    const report = await api.runMatches(count);
    console.info('[verifyTdm] criteria 1 + 7 — match cycle');
    console.table(report.boundaries);
    results.cycle = report;
    return report;
  }

  async function all() {
    const out = {};
    out.lanes = lanes();
    out.clearance = clearanceAudit();
    out.snag = await snagSweep();
    out.bots = await botCoverage(120);
    out.frame = await frameProfile(20);
    out.hud = await hudCheck();
    out.fixedRate = await fixedRate();
    out.cycle = await matchCycle(3);
    restoreFrameSource();
    console.info('[verifyTdm] done. Full result object returned.');
    return out;
  }

  window.__verifyTdm = {
    results,
    all,
    lanes,
    clearanceAudit,
    snagSweep,
    botCoverage,
    frameProfile,
    fixedRate,
    hudCheck,
    matchCycle,
    installFrameSource,
    restoreFrameSource,
    startMatch,
  };
  console.info('[verifyTdm] loaded. await __verifyTdm.all()');
})();
