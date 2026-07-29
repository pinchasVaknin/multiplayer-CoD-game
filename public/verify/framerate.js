/**
 * Acceptance criterion 5: the sim runs at a fixed 60 Hz regardless of frame rate.
 *
 * Drives the REAL Loop / Input / PlayerController through the REAL map, over the long
 * straight at z = -14, and measures metres travelled per second of WALL CLOCK time at
 * several frame rates. Measuring sim ticks against sim ticks would prove nothing, so
 * every number here comes from performance.now().
 *
 * The frame source is substituted because requestAnimationFrame does not fire in a
 * tab that is not compositing. The loop, accumulator, input path and collision are
 * untouched — only what calls `frame()` changes. `loadMs` additionally burns real CPU
 * inside each frame, which is the same pressure DevTools CPU throttling applies.
 */
(async () => {
  const g = window.__operator.game;
  const loop = g.loop;
  const p = g.player;
  const input = g.input;

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

  function restoreFrameSource() {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancel;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));

  async function measure(label, intervalMs, loadMs) {
    loop.stop();
    restoreFrameSource();

    // Spawn at the west end of the measurement lane, facing +X down the straight.
    p.spawn(-20, 0.05, -14, -Math.PI / 2);
    input.setView(-Math.PI / 2, 0);
    input.clearHeld();
    g.state = 'MATCH'; // sample real input without requesting pointer lock

    installFrameSource(intervalMs);
    loop.syntheticLoadMs = loadMs;
    const tick0 = loop.currentTick;
    loop.start();

    key('keydown', 'KeyW');
    key('keydown', 'ShiftLeft');

    await sleep(700); // reach steady state

    const t0 = performance.now();
    const x0 = p.sim.x;
    const z0 = p.sim.z;
    const tickA = loop.currentTick;

    await sleep(2500);

    const t1 = performance.now();
    const x1 = p.sim.x;
    const z1 = p.sim.z;
    const tickB = loop.currentTick;

    key('keyup', 'KeyW');
    key('keyup', 'ShiftLeft');
    loop.stop();
    loop.syntheticLoadMs = 0;
    restoreFrameSource();

    const seconds = (t1 - t0) / 1000;
    const distance = Math.hypot(x1 - x0, z1 - z0);
    const simTicks = tickB - tickA;
    return {
      label,
      frameIntervalMs: intervalMs,
      syntheticLoadMs: loadMs,
      targetFps: +(1000 / intervalMs).toFixed(1),
      ticksSinceStart: loop.currentTick - tick0,
      wallSeconds: +seconds.toFixed(3),
      distanceM: +distance.toFixed(3),
      metresPerSecond: +(distance / seconds).toFixed(4),
      simTicks,
      simHzMeasured: +(simTicks / seconds).toFixed(2),
      startX: +x0.toFixed(2),
      endX: +x1.toFixed(2),
    };
  }

  const results = [];
  results.push(await measure('fast (~120 fps)', 8, 0));
  results.push(await measure('normal (~60 fps)', 16, 0));
  results.push(await measure('throttled (~15 fps + 55ms CPU burn)', 66, 55));

  // Leave the game where it started.
  restoreFrameSource();
  loop.syntheticLoadMs = 0;
  g.state = 'MENU';
  const sp = g.map.spawns[0];
  p.spawn(sp.position.x, sp.position.y, sp.position.z, sp.facingYaw);
  input.setView(sp.facingYaw, 0);
  input.clearHeld();

  const speeds = results.map((r) => r.metresPerSecond);
  const spread = Math.max(...speeds) - Math.min(...speeds);
  return { results, spreadMps: +spread.toFixed(4), spreadPercent: +((spread / speeds[0]) * 100).toFixed(3) };
})();
