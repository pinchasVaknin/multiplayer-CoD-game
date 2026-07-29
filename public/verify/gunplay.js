/**
 * Acceptance criteria 1, 5, 6 and 8: the parts of M2 that only exist once real frames
 * are being produced.
 *
 * Everything that is purely a property of the simulation is measured by
 * `__operator.weaponHarness` instead — see verify/report.js. What is left here needs the
 * render callback to run, because it is about the *presentation* path: the hitmarker
 * appearing, the input-latency probe closing its loop, and sixty seconds of continuous
 * fire not growing a pool or dropping a frame.
 *
 * The frame source is substituted for the same reason M1's framerate.js substitutes it:
 * requestAnimationFrame does not fire in a tab that is not compositing. The loop,
 * accumulator, input path, renderer and every system under test are untouched — only
 * what calls `frame()` changes.
 */
(async () => {
  const g = window.__operator.game;
  const loop = g.loop;
  const input = g.input;
  const player = g.player;
  const match = g.match;
  const canvas = document.getElementById('viewport');

  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);

  function installFrameSource(intervalMs) {
    const timers = new Map();
    let nextId = 1;
    window.requestAnimationFrame = (cb) => {
      const id = nextId++;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          cb(performance.now());
        }, intervalMs),
      );
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const h = timers.get(id);
      if (h !== undefined) {
        clearTimeout(h);
        timers.delete(id);
      }
    };
  }

  const restoreFrameSource = () => {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancel;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mouse = (type, button) =>
    canvas.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }));
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));

  /** Stand on the firing line facing the range, with the loop running. */
  function takeTheLine(intervalMs = 16) {
    loop.stop();
    restoreFrameSource();
    // Setting `g.state` directly skips the MATCH enter handler, so the audio graph has
    // to be built here or the soak measures a silent game.
    g.audio.start();
    player.spawn(-20, 0.05, -14, -Math.PI / 2);
    input.setView(-Math.PI / 2, 0);
    input.clearHeld();
    match.weapons.weapon.resetAmmo();
    match.weapons.recoil.reset();
    match.range.resetAll();
    match.setActive(true);
    g.state = 'MATCH';
    installFrameSource(intervalMs);
    loop.start();
  }

  function standDown() {
    key('keyup', 'KeyW');
    mouse('mouseup', 0);
    loop.stop();
    loop.syntheticLoadMs = 0;
    restoreFrameSource();
    match.setActive(false);
    g.state = 'MENU';
    const sp = g.map.spawns[0];
    player.spawn(sp.position.x, sp.position.y, sp.position.z, sp.facingYaw);
    input.setView(sp.facingYaw, 0);
    input.clearHeld();
    loop.start();
  }

  const results = {};

  // ---- criterion 1: fire, ADS, reload, ammo, sprint-to-fire all behave -----
  {
    takeTheLine();
    const w = match.weapons.weapon;
    const trace = [];
    const note = (label) =>
      trace.push({
        at: label,
        mag: w.mag,
        reserve: w.reserve,
        raise: +w.raise.toFixed(3),
        ads: +w.adsFraction.toFixed(3),
        reloading: w.reloading,
        step: w.reloading ? w.reloadStep : '-',
        canFire: w.canFire,
        agrees: w.canFire === (w.raise >= 1 && !w.reloading),
      });

    note('idle');
    mouse('mousedown', 0);
    await sleep(420);
    mouse('mouseup', 0);
    note('after 0.42s of fire');

    mouse('mousedown', 2);
    await sleep(400);
    note('aimed');
    mouse('mouseup', 2);
    await sleep(400);

    key('keydown', 'KeyR');
    await sleep(40);
    key('keyup', 'KeyR');
    await sleep(300);
    note('mid tactical reload');
    await sleep(2200);
    note('after tactical reload');

    // Empty the magazine, which should auto-reload with the longer sequence.
    mouse('mousedown', 0);
    await sleep(3200);
    note('mid empty reload');
    mouse('mouseup', 0);
    await sleep(3000);
    note('after empty reload');

    // Sprint, then release, and confirm the gun is unusable until it is up.
    key('keydown', 'KeyW');
    key('keydown', 'ShiftLeft');
    await sleep(600);
    note('sprinting');
    key('keyup', 'ShiftLeft');
    await sleep(100);
    note('100ms after sprint release');
    await sleep(300);
    note('400ms after sprint release');
    key('keyup', 'KeyW');

    results.handling = {
      trace,
      animationNeverDisagrees: trace.every((t) => t.agrees),
    };
    standDown();
  }

  // ---- criteria 5 and 8: hitmarker and input latency -----------------------
  {
    takeTheLine();
    match.latency.reset();
    match.hud.lastHitLatencyMs = -1;
    const markers = [];

    // Aim at the close dummy: it is 5 m away and slightly north of the lane.
    const target = match.range.get(1);
    const aimAt = (t) => {
      const sim = player.sim;
      const dx = t.rig.x - sim.x;
      const dy = t.rig.y + 1.26 - (sim.y + sim.eyeHeight);
      const dz = t.rig.z - sim.z;
      input.setView(Math.atan2(-dx, -dz), Math.asin(dy / Math.hypot(dx, dy, dz)));
    };

    for (let i = 0; i < 24; i++) {
      aimAt(target);
      match.hud.lastHitLatencyMs = -1;
      mouse('mousedown', 0);
      await sleep(40);
      mouse('mouseup', 0);
      await sleep(120);
      if (match.hud.lastHitLatencyMs >= 0) markers.push(match.hud.lastHitLatencyMs);
      if (target.health.current < 40) target.reset();
    }

    match.latency.recompute();
    markers.sort((a, b) => a - b);
    const pick = (q) => markers[Math.min(markers.length - 1, Math.round(q * (markers.length - 1)))] ?? -1;

    // The substituted frame source does not run at exactly 60 Hz, so express latency
    // against the frames that actually happened as well as against a nominal 16.7 ms.
    // Only the first is meaningful as "how many frames behind the input is the picture".
    const stats = window.__operator.stats();
    stats.recompute();
    const measuredFrameMs = stats.p50 > 1 ? stats.p50 : 1000 / 60;

    results.hitmarker = {
      samples: markers.length,
      p50Ms: +pick(0.5).toFixed(2),
      p99Ms: +pick(0.99).toFixed(2),
      worstMs: +(markers[markers.length - 1] ?? -1).toFixed(2),
      underBudget: markers.every((m) => m < 30),
    };
    results.inputLatency = {
      samples: match.latency.count,
      p50Ms: +match.latency.p50.toFixed(2),
      p99Ms: +match.latency.p99.toFixed(2),
      measuredFrameMs: +measuredFrameMs.toFixed(2),
      p50Frames: +(match.latency.p50 / measuredFrameMs).toFixed(2),
      p99Frames: +(match.latency.p99 / measuredFrameMs).toFixed(2),
      p50FramesNominal60: +(match.latency.p50 / (1000 / 60)).toFixed(2),
      p99FramesNominal60: +(match.latency.p99 / (1000 / 60)).toFixed(2),
      dropped: match.latency.dropped,
    };
    standDown();
  }

  // ---- criterion 6: 60 s of continuous fire --------------------------------
  {
    takeTheLine();
    const stats = window.__operator.stats();
    const audio = g.audio;
    const fx = match.fx;
    const w = match.weapons.weapon;

    // Infinite ammo for the soak: the criterion is about sustained fire, not logistics.
    const refill = setInterval(() => {
      if (w.reserve < 60) w.reserve = w.definition.reserveAmmo;
    }, 500);

    // Sweep the aim so decals land all over the room rather than in one hole.
    let sweep = 0;
    const aim = setInterval(() => {
      sweep += 0.11;
      input.setView(-Math.PI / 2 + Math.sin(sweep) * 0.9, Math.sin(sweep * 0.37) * 0.25);
    }, 50);

    const before = {
      voicePool: audio.poolSize,
      sourcesStarted: audio.sourcesStarted,
      decals: fx.decals,
      heapMb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    };

    stats.reset();
    mouse('mousedown', 0);
    const t0 = performance.now();
    const samples = [];
    let roundsAtStart = null;
    let shots = 0;
    const offFired = g.bus.on('weapon.fired', () => {
      shots++;
    });

    for (let i = 0; i < 12; i++) {
      // Track sim cost inside the window, not just the frame interval: the substituted
      // frame source sets the interval, so only sim/render time says anything about the
      // 3.0 ms logic budget in S4.7.
      let simPeak = 0;
      let renderPeak = 0;
      let simSum = 0;
      let n = 0;
      const end = performance.now() + 5000;
      while (performance.now() < end) {
        await sleep(100);
        simPeak = Math.max(simPeak, stats.lastSimMs);
        renderPeak = Math.max(renderPeak, stats.lastRenderMs);
        simSum += stats.lastSimMs;
        n++;
      }
      stats.recompute();
      if (roundsAtStart === null) roundsAtStart = shots;
      samples.push({
        atS: +((performance.now() - t0) / 1000).toFixed(1),
        shots,
        p99: +stats.p99.toFixed(2),
        worst: +stats.worst.toFixed(2),
        simPeakMs: +simPeak.toFixed(2),
        simMeanMs: +(simSum / Math.max(n, 1)).toFixed(3),
        renderPeakMs: +renderPeak.toFixed(2),
        voicePool: audio.poolSize,
        voicesLive: audio.voiceCount,
        audioSources: audio.sourcesStarted,
        decals: fx.decals,
        tracers: fx.activeTracers,
        particles: fx.activeParticles,
      });
    }
    mouse('mouseup', 0);
    offFired();
    clearInterval(refill);
    clearInterval(aim);
    stats.recompute();

    const after = {
      voicePool: audio.poolSize,
      sourcesStarted: audio.sourcesStarted,
      decals: fx.decals,
      heapMb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    };

    results.soak = {
      seconds: +((performance.now() - t0) / 1000).toFixed(1),
      shotsFired: shots,
      audioRunning: audio.isRunning,
      samples,
      before,
      after,
      audioPoolGrew: after.voicePool > before.voicePool,
      decalsWithinCap: fx.decals <= fx.decalCapacity,
      p50: +stats.p50.toFixed(2),
      p95: +stats.p95.toFixed(2),
      p99: +stats.p99.toFixed(2),
      worst: +stats.worst.toFixed(2),
      overBudget: `${stats.overBudget} / ${stats.sampleCount}`,
    };
    standDown();
  }

  // ---- criterion 7: fixed rate under load ----------------------------------
  {
    const runs = [];
    for (const [label, interval, load] of [
      ['~60 fps', 16, 0],
      ['~15 fps + 55 ms CPU burn', 66, 55],
    ]) {
      takeTheLine(interval);
      loop.syntheticLoadMs = load;
      const w = match.weapons.weapon;
      w.resetAmmo();
      await sleep(300);

      // Timestamp the rounds themselves rather than polling for an empty magazine.
      // At 15 fps a poll can be a whole frame late, which is 2.6% of a 2.5 s magazine —
      // enough slop to swamp the effect being measured.
      const shotTimes = [];
      const offShot = g.bus.on('weapon.fired', () => shotTimes.push(performance.now()));

      const t0 = performance.now();
      mouse('mousedown', 0);
      // Hold through empty: the automatic reload is triggered by a dry trigger pull, so
      // releasing first measures nothing.
      while (w.mag > 0 && performance.now() - t0 < 8000) await sleep(20);
      const emptyAt = performance.now();
      while (!w.reloading && performance.now() - emptyAt < 1000) await sleep(10);
      const reloadStart = performance.now();
      mouse('mouseup', 0);
      while (w.reloading && performance.now() - reloadStart < 8000) await sleep(20);
      const reloadEnd = performance.now();
      offShot();

      const first = shotTimes[0] ?? 0;
      const last = shotTimes[shotTimes.length - 1] ?? 0;
      const span = (last - first) / 1000;
      runs.push({
        label,
        frameIntervalMs: interval,
        syntheticLoadMs: load,
        shots: shotTimes.length,
        firstToLastSeconds: +span.toFixed(4),
        measuredRpm: span > 0 ? +(((shotTimes.length - 1) / span) * 60).toFixed(1) : 0,
        reloadSeconds: +((reloadEnd - reloadStart) / 1000).toFixed(3),
      });
      standDown();
    }
    const rpms = runs.map((r) => r.measuredRpm);
    results.fixedRate = {
      runs,
      rpmSpread: +(Math.max(...rpms) - Math.min(...rpms)).toFixed(1),
      rpmSpreadPercent: +(((Math.max(...rpms) - Math.min(...rpms)) / rpms[0]) * 100).toFixed(2),
      reloadSpread: +(
        Math.max(...runs.map((r) => r.reloadSeconds)) - Math.min(...runs.map((r) => r.reloadSeconds))
      ).toFixed(3),
    };
  }

  return results;
})();
