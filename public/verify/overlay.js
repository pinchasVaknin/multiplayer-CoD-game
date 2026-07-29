/**
 * Acceptance criterion 7: the debug overlay opens on F1 and every field updates.
 *
 * Opens the overlay via a real F1 KeyboardEvent, runs the real loop while the player
 * sprints, jumps and slides, then snapshots every readout twice and reports which ones
 * changed. Fields that are legitimately constant during the run are listed separately
 * rather than being quietly counted as passing.
 */
(async () => {
  const g = window.__operator.game;
  const loop = g.loop;
  const p = g.player;
  const input = g.input;

  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const timers = new Map();
  let nextId = 1;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    timers.set(id, setTimeout(() => { timers.delete(id); cb(performance.now()); }, 8));
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const h = timers.get(id);
    if (h !== undefined) { clearTimeout(h); timers.delete(id); }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));

  function snapshot() {
    const out = {};
    for (const row of document.querySelectorAll('.dbg-row')) {
      const label = row.querySelector('.dbg-row__label')?.textContent ?? '?';
      out[label] = row.querySelector('.dbg-row__value')?.textContent ?? '';
    }
    return out;
  }

  loop.stop();
  p.spawn(-20, 0.05, -14, -Math.PI / 2);
  input.setView(-Math.PI / 2, 0);
  input.clearHeld();
  g.state = 'MATCH';
  loop.start();

  // Open the overlay with a genuine F1 press.
  key('keydown', 'F1');
  await sleep(120);
  const opened = !document.querySelector('.dbg-root').hidden;
  const fieldCount = document.querySelectorAll('.dbg-row').length;
  const sliderCount = document.querySelectorAll('.dbg-slider__input').length;
  const graph = document.querySelector('.dbg-graph');

  // Ground truth straight from the sim, independent of the 15 Hz text refresh.
  const seen = { tacSprint: false, slide: false, airborne: false, crouch: false, mantle: false, maxSpeed: 0 };
  const poll = setInterval(() => {
    const s = p.sim;
    if (s.tacSprintActive) seen.tacSprint = true;
    if (s.slideActive) seen.slide = true;
    if (s.stance === 'AIRBORNE') seen.airborne = true;
    if (s.stance === 'CROUCH') seen.crouch = true;
    if (s.mantleActive) seen.mantle = true;
    if (s.speed > seen.maxSpeed) seen.maxSpeed = s.speed;
  }, 8);

  // Exercise the movement systems so every readout has something to say.
  key('keydown', 'KeyW');
  key('keydown', 'ShiftLeft');
  await sleep(500);
  // Double-tap sprint -> tactical sprint. Both presses must land inside the 300 ms
  // window, and the gap must exceed one sim tick (16.7 ms): edge detection happens in
  // the sim from the bitfield (S4.2), so a press and release inside one tick is never
  // sampled as two events.
  key('keyup', 'ShiftLeft');
  await sleep(200);
  key('keydown', 'ShiftLeft');
  await sleep(70);
  key('keyup', 'ShiftLeft');
  await sleep(70);
  key('keydown', 'ShiftLeft'); // second press, 140 ms after the first
  await sleep(500);
  const a = snapshot();
  const tacDuringA = p.sim.tacSprintActive;

  key('keydown', 'Space');
  await sleep(100);
  key('keyup', 'Space');
  await sleep(1000); // land, then re-earn the 0.3 s sprint-hold gate

  key('keydown', 'ControlLeft'); // sprint + crouch -> slide
  await sleep(200);
  const b = snapshot();
  const slideDuringB = p.sim.slideActive;

  key('keyup', 'ControlLeft');
  key('keyup', 'KeyW');
  key('keyup', 'ShiftLeft');
  await sleep(500);
  const c = snapshot();
  clearInterval(poll);

  // Collision visualisation on F2.
  key('keydown', 'F2');
  await sleep(100);
  const collisionOn = g.collisionDebug.isEnabled && g.collisionDebug.group.visible;
  const capsuleVerts = g.collisionDebug.group.children[0].geometry.drawRange.count;
  const normalVerts = g.collisionDebug.group.children[1].geometry.drawRange.count;
  const cellVerts = g.collisionDebug.group.children[2].geometry.drawRange.count;
  key('keydown', 'F2');
  await sleep(50);

  // Histogram has data.
  const stats = g.overlay.stats;
  const graphPixels = (() => {
    const ctx = graph.getContext('2d');
    const d = ctx.getImageData(0, 0, graph.width, graph.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) lit++;
    return lit;
  })();

  const peaks = { instant: g.overlay.speedo.instantPeak, sustained: g.overlay.speedo.sustainedPeak };
  const labels = Object.keys(a);
  const changed = labels.filter((k) => a[k] !== b[k] || b[k] !== c[k]);
  const constant = labels.filter((k) => !changed.includes(k)).map((k) => `${k} = ${a[k]}`);

  // Close the overlay and restore the game.
  key('keydown', 'F1');
  loop.stop();
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCancel;
  g.state = 'MENU';
  const sp = g.map.spawns[0];
  p.spawn(sp.position.x, sp.position.y, sp.position.z, sp.facingYaw);
  input.setView(sp.facingYaw, 0);
  input.clearHeld();

  return {
    opened,
    fieldCount,
    sliderCount,
    collisionVizOn: collisionOn,
    collisionVerts: { capsule: capsuleVerts, normals: normalVerts, hashCells: cellVerts },
    histogram: { samples: stats.sampleCount, p50: +stats.p50.toFixed(2), p95: +stats.p95.toFixed(2), p99: +stats.p99.toFixed(2), worst: +stats.worst.toFixed(2), litPixels: graphPixels },
    changedFieldCount: changed.length,
    totalFields: labels.length,
    constantFields: constant,
    speedoPeaks: { instant: +peaks.instant.toFixed(3), sustained: +peaks.sustained.toFixed(3) },
    simSeen: { ...seen, maxSpeed: +seen.maxSpeed.toFixed(2) },
    tacActiveAtSnapshotA: tacDuringA,
    slideActiveAtSnapshotB: slideDuringB,
    tacSprintText: a['Tac sprint'],
    slideText: b['Slide'],
    sampleC: c,
  };
})();
