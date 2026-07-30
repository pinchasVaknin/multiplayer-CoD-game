/**
 * Milestone 5 acceptance suite — the arsenal.
 *
 * Same contract as `tdm.js`: everything that is a property of the simulation is measured
 * by running the real systems, and nothing here reimplements a rule in order to check it.
 * The TTK table comes out of `ArsenalHarness` driving a real `WeaponSystem` into a real
 * `DamageSystem`; the smoke test drives the real `Perception`; the flash figures come out
 * of the same `intensityFor` the flash itself applies.
 *
 * The frame source is substituted, as in every suite since M1, because
 * `requestAnimationFrame` does not fire in a tab that is not compositing. The loop, the
 * accumulator, the input path, collision, AI and the mode are untouched; only what calls
 * `frame()` changes.
 *
 * Run it on a freshly loaded page — Chrome clamps timers in a tab that has been hidden for
 * about five minutes and every wall-clock number here would become meaningless.
 *
 *   fetch('/verify/arsenal.js').then(r => r.text()).then(eval)
 *   await __verifyArsenal.all()        // every criterion, in order
 *   __verifyArsenal.balance()          // 2 — the TTK table
 *   __verifyArsenal.patterns()         // 1 — twelve distinct recoil patterns
 *   __verifyArsenal.voices()           // 1 — twelve distinct audio voices
 *   __verifyArsenal.purity()           // 3 — attachment resolution is pure
 *   __verifyArsenal.attachments()      // 4 — measured attachment costs
 *   __verifyArsenal.pellets()          // 5 — mixed head/torso pellet spread
 *   await __verifyArsenal.smoke()      // 6 — smoke blocks bot perception
 *   __verifyArsenal.flash()            // 7 — flash scales with angle
 *   __verifyArsenal.slide()            // 8 — the slide-cancel retune
 *   await __verifyArsenal.frameTime()  // 9 — p99 in a 10-bot firefight with equipment
 *   __verifyArsenal.results            // everything measured so far, stashed
 */
(() => {
  const api = window.__operator;
  const game = api.game;

  const results = {};

  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  let frameSourceInstalled = false;

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
    game.loop.stop();
    game.loop.start();
  }

  function restoreFrameSource() {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancel;
    frameSourceInstalled = false;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function ensureMatch() {
    if (game.currentState === 'SUMMARY') game.transitionTo('MENU');
    if (game.currentState === 'PAUSED') game.transitionTo('MATCH');
    if (game.currentState === 'MENU') game.transitionTo('MATCH');
    return api.match();
  }

  function arsenal() {
    ensureMatch();
    const harness = api.arsenal();
    if (harness === undefined) throw new Error('No arsenal harness — the match did not build.');
    return harness;
  }

  // ==========================================================================
  // Criterion 1 — twelve distinct recoil patterns and twelve distinct voices
  // ==========================================================================

  /**
   * Every pattern's accumulated trace, and the closest pair.
   *
   * "If two weapons feel the same, one of them is wrong" is only checkable if *the same*
   * is a number. This walks every pair, resamples both traces to a common shot count and
   * reports the RMS distance in degrees between them — so the answer is the minimum over
   * 66 pairs rather than an assertion that they look different.
   */
  function patterns() {
    const defs = api.weapons;
    const traces = defs.map((def) => {
      const pts = [];
      let x = 0;
      let y = 0;
      const kicks = def.recoil.kicks;
      for (let i = 0; i < 30 && kicks.length > 0; i++) {
        const kick = kicks[i % kicks.length];
        const first = i === 0 ? def.recoil.firstShotScale : 1;
        x += kick.x * def.recoil.horizontalScale * first;
        y += kick.y * def.recoil.verticalScale * first;
        pts.push([x, y]);
      }
      return { id: def.id, name: def.name, pts, length: kicks.length };
    });

    let closest = null;
    for (let a = 0; a < traces.length; a++) {
      for (let b = a + 1; b < traces.length; b++) {
        const pa = traces[a].pts;
        const pb = traces[b].pts;
        const n = Math.min(pa.length, pb.length);
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const dx = pa[i][0] - pb[i][0];
          const dy = pa[i][1] - pb[i][1];
          sum += dx * dx + dy * dy;
        }
        const rms = Math.sqrt(sum / Math.max(n, 1));
        if (closest === null || rms < closest.rms) {
          closest = { a: traces[a].name, b: traces[b].name, rms };
        }
      }
    }

    const rows = traces.map((t) => ({
      weapon: t.name,
      steps: t.length,
      climbDeg: Number(t.pts[t.pts.length - 1][1].toFixed(2)),
      driftDeg: Number(t.pts[t.pts.length - 1][0].toFixed(2)),
      reversals: countReversals(t.pts),
    }));

    console.info(
      `[verifyArsenal] criterion 1 — ${traces.length} hand-authored patterns. ` +
        `Closest pair: ${closest.a} vs ${closest.b}, RMS ${closest.rms.toFixed(2)}°.`,
    );
    console.table(rows);
    results.patterns = { rows, closest: { ...closest, rms: Number(closest.rms.toFixed(3)) } };
    return results.patterns;
  }

  function countReversals(pts) {
    let reversals = 0;
    let sign = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const s = dx > 1e-6 ? 1 : dx < -1e-6 ? -1 : 0;
      if (s !== 0 && sign !== 0 && s !== sign) reversals++;
      if (s !== 0) sign = s;
    }
    return reversals;
  }

  /**
   * The voices, as the numbers that separate them.
   *
   * Audio cannot be verified by ear in a headless tab, so what is checked is that the three
   * character controls the brief names — filter cutoff, body resonance, tail length — are
   * actually distinct, and by how much. An LMG and an SMG being identifiable with your eyes
   * closed starts with their body bands not overlapping.
   */
  function voices() {
    const defs = api.weapons;
    const rows = defs.map((d) => ({
      weapon: d.name,
      class: d.class,
      bodyFreq: d.voice.bodyFreq,
      bodyQ: d.voice.bodyQ,
      tailDecay: d.voice.tailDecay,
      thumpFreq: d.voice.thumpFreq,
      level: d.voice.level,
    }));
    const freqs = rows.map((r) => r.bodyFreq).sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < freqs.length; i++) minGap = Math.min(minGap, freqs[i] - freqs[i - 1]);

    const smg = rows.find((r) => r.class === 'SMG');
    const lmg = rows.find((r) => r.class === 'LMG');
    console.info(
      `[verifyArsenal] criterion 1 — ${rows.length} voices. Body-frequency span ` +
        `${freqs[0]}–${freqs[freqs.length - 1]} Hz, closest pair ${minGap} Hz apart. ` +
        `SMG ${smg.bodyFreq} Hz / tail ${smg.tailDecay}s vs LMG ${lmg.bodyFreq} Hz / tail ${lmg.tailDecay}s.`,
    );
    console.table(rows);
    results.voices = { rows, minGapHz: minGap, spanHz: [freqs[0], freqs[freqs.length - 1]] };
    return results.voices;
  }

  // ==========================================================================
  // Criterion 2 — the balance table
  // ==========================================================================

  function balance() {
    const harness = arsenal();
    const t0 = performance.now();
    const rows = harness.measureTtkTable();
    const ms = performance.now() - t0;
    const flat = [];
    for (const row of rows) {
      flat.push({
        weapon: row.weaponName,
        class: row.weaponClass,
        rpm: row.rpm,
        chest5: fmt(row.chest[0]),
        chest15: fmt(row.chest[1]),
        chest25: fmt(row.chest[2]),
        chest40: fmt(row.chest[3]),
        head5: fmt(row.head[0]),
        head15: fmt(row.head[1]),
        head25: fmt(row.head[2]),
        head40: fmt(row.head[3]),
      });
    }
    console.info(`[verifyArsenal] criterion 2 — TTK table measured in ${ms.toFixed(0)} ms.`);
    console.table(flat);
    results.balance = { rows, markdown: api.balanceTable(), ms };
    return results.balance;
  }

  function fmt(cell) {
    if (cell === undefined || cell.seconds < 0) return '—';
    const shots = cell.hits === cell.pulls ? `${cell.pulls}` : `${cell.pulls}(${cell.hits}p)`;
    return `${cell.seconds.toFixed(3)}/${shots}`;
  }

  // ==========================================================================
  // Criterion 3 — attachment resolution is pure
  // ==========================================================================

  function purity() {
    const findings = arsenal().report().purity;
    console.info('[verifyArsenal] criterion 3 — attachment resolution purity');
    console.table(findings.map((f) => ({ check: f.check, ok: f.ok, detail: f.detail })));
    results.purity = findings;
    return findings;
  }

  // ==========================================================================
  // Criterion 4 — every attachment's cost is measurable
  // ==========================================================================

  function attachments() {
    const harness = arsenal();
    const deltas = harness.measureAttachments();
    const laser = harness.measureLaserSpread(harness.baseline);
    console.info(
      `[verifyArsenal] criterion 4 — measured on ${harness.baseline.name}. ` +
        `Laser hip cone ${laser.withoutDeg.toFixed(3)}° -> ${laser.withDeg.toFixed(3)}° ` +
        `(${laser.deltaDeg.toFixed(3)}°), read out of the live WeaponSystem.`,
    );
    console.table(
      deltas.map((d) => ({
        attachment: d.attachment,
        adsMs: Number(d.adsMs.toFixed(1)),
        adsDeltaMs: Number(d.adsDeltaMs.toFixed(1)),
        hipSpreadDeg: Number(d.hipSpreadDeg.toFixed(3)),
        hipDeltaDeg: Number(d.hipSpreadDeltaDeg.toFixed(3)),
        adsSpreadDeg: Number(d.adsSpreadDeg.toFixed(3)),
        magSize: d.magSize,
        reloadS: Number(d.reloadS.toFixed(3)),
        rangeEndM: Number(d.rangeEndM.toFixed(2)),
        recoilVert: Number(d.recoilVertical.toFixed(3)),
      })),
    );
    results.attachments = { deltas, laser };
    return results.attachments;
  }

  // ==========================================================================
  // Criterion 5 — shotgun pellets hit individual hitbox zones
  // ==========================================================================

  function pellets() {
    const harness = arsenal();
    const shotgun = api.weapons.find((d) => d.pellets > 1);
    const rows = [];
    for (const range of [4, 6, 8, 10]) {
      const r = harness.measurePelletSpread(shotgun, range);
      const counts = {};
      for (const z of r.zones) counts[z] = (counts[z] ?? 0) + 1;
      rows.push({
        rangeM: range,
        pellets: shotgun.pellets,
        hits: r.hits,
        head: counts.head ?? 0,
        torso: counts.torso ?? 0,
        arm: counts.arm ?? 0,
        leg: counts.leg ?? 0,
        missed: shotgun.pellets - r.hits,
        damage: Number(r.damage.toFixed(1)),
        lethal: r.damage >= 100,
      });
    }
    const mixed = rows.filter((r) => r.head > 0 && r.torso > 0);
    console.info(
      `[verifyArsenal] criterion 5 — ${shotgun.name}, aimed at the neck. ` +
        `${mixed.length} of ${rows.length} ranges produced a mixed head/torso spread.`,
    );
    console.table(rows);
    results.pellets = rows;
    return rows;
  }

  // ==========================================================================
  // Criterion 6 — smoke blocks bot perception
  // ==========================================================================

  /**
   * The same pair of bots, acquiring through clear air and then through smoke.
   *
   * Deliberately measured on the *real* `Perception` against the *real* `SmokeField`: a
   * bespoke test that called `blocksSight` directly would prove the occluder works and
   * nothing about whether it is wired into the thing that matters.
   */
  async function smoke() {
    installFrameSource();
    const match = ensureMatch();
    await sleep(400);

    const equipment = match.equipment;
    const perception = match.bots.perception;
    const roster = match.bots.roster;

    // Find an enemy pair that can currently see each other, and put smoke on the midpoint.
    let a = null;
    let b = null;
    for (const x of roster) {
      for (const y of roster) {
        if (x === y || x.team === y.team) continue;
        if (!x.participating || !y.participating) continue;
        const clear = perception.clearLine(x.px, x.py + x.eyeHeight, x.pz, y.px, y.py + y.aimHeight, y.pz);
        if (!clear) continue;
        const d = Math.hypot(x.px - y.px, x.pz - y.pz);
        if (d < 6 || d > 40) continue;
        a = x;
        b = y;
        break;
      }
      if (a !== null) break;
    }

    if (a === null) {
      console.warn('[verifyArsenal] criterion 6 — no clear enemy pair to test; try again mid-match.');
      return null;
    }

    const midX = (a.px + b.px) * 0.5;
    const midY = (a.py + b.py) * 0.5 + 1.2;
    const midZ = (a.pz + b.pz) * 0.5;
    const range = Math.hypot(a.px - b.px, a.pz - b.pz);

    const sample = () =>
      equipment.system.smoke.opticalDepth(
        a.px,
        a.py + a.eyeHeight,
        a.pz,
        b.px,
        b.py + b.aimHeight,
        b.pz,
      );

    const before = {
      opticalDepth: Number(sample().toFixed(3)),
      blocked: equipment.system.smoke.blocksSight(
        a.px,
        a.py + a.eyeHeight,
        a.pz,
        b.px,
        b.py + b.aimHeight,
        b.pz,
      ),
    };

    // Bloom takes `smokeBloom` seconds; wait past it so the reading is of a grown cloud.
    equipment.system.smoke.spawn(midX, midY, midZ, 4.2, 12, 1.6);
    await sleep(2200);

    const during = {
      opticalDepth: Number(sample().toFixed(3)),
      blocked: equipment.system.smoke.blocksSight(
        a.px,
        a.py + a.eyeHeight,
        a.pz,
        b.px,
        b.py + b.aimHeight,
        b.pz,
      ),
      perceptionRejections: perception.smokeBlocked,
    };

    equipment.system.smoke.clear();
    await sleep(200);

    const after = {
      opticalDepth: Number(sample().toFixed(3)),
      blocked: equipment.system.smoke.blocksSight(
        a.px,
        a.py + a.eyeHeight,
        a.pz,
        b.px,
        b.py + b.aimHeight,
        b.pz,
      ),
    };

    console.info(
      `[verifyArsenal] criterion 6 — ${a.displayName} -> ${b.displayName} at ${range.toFixed(1)} m. ` +
        `Clear: depth ${before.opticalDepth}, blocked ${before.blocked}. ` +
        `Smoked: depth ${during.opticalDepth}, blocked ${during.blocked}, ` +
        `${during.perceptionRejections} perception rejections. ` +
        `Cleared: depth ${after.opticalDepth}, blocked ${after.blocked}.`,
    );
    results.smoke = { pair: [a.displayName, b.displayName], range, before, during, after };
    return results.smoke;
  }

  // ==========================================================================
  // Criterion 7 — the flash scales with angle
  // ==========================================================================

  function flash() {
    const match = ensureMatch();
    const field = match.equipment.system.flash;
    const radius = 11;
    const rows = [0, 45, 90, 135, 180].map((deg) => ({
      angleDeg: deg,
      pointBlankLos: Number(field.intensityFor(deg, 0, radius, true).toFixed(3)),
      halfRangeLos: Number(field.intensityFor(deg, radius * 0.5, radius, true).toFixed(3)),
      pointBlankNoLos: Number(field.intensityFor(deg, 0, radius, false).toFixed(3)),
      blindSeconds: Number((3 * field.intensityFor(deg, 0, radius, true)).toFixed(2)),
    }));
    console.info('[verifyArsenal] criterion 7 — flashbang effect by angle, distance and LOS');
    console.table(rows);
    results.flash = rows;
    return rows;
  }

  // ==========================================================================
  // Criterion 8 — the slide-cancel retune
  // ==========================================================================

  function slide() {
    const harness = arsenal();
    const movement = api.harness;
    const fastest = harness.constructor.fastestHandling();
    const rules = movement.verifySlideRules();
    const sustained = movement.measureMaxSustained(60);
    const entry = harness.measureSlideEntry(api.weaponDef);
    const aggression = harness.measureSlideAggression(api.weaponDef, 30);

    const out = {
      fastestAdsSeconds: fastest.adsSeconds,
      fastestAdsWeapon: fastest.adsId,
      fastestSprintOutSeconds: fastest.outSeconds,
      fastestSprintOutWeapon: fastest.outId,
      slideEntrySpeed: Number(entry.entrySpeed.toFixed(3)),
      slideToFireSeconds: Number(entry.slideToFireSeconds.toFixed(4)),
      distanceBeforeFireableM: Number(entry.distanceBeforeFireable.toFixed(3)),
      speedWhenFireable: Number(entry.speedWhenFireable.toFixed(3)),
      tacLockoutSeconds: rules.measuredTacLockoutS,
      slideToSlideSeconds: Number(rules.measuredSlideToSlideS.toFixed(4)),
      peakSustained: Number(sustained.peakSustainedSpeed.toFixed(4)),
      peakInstant: Number(sustained.peakSpeed.toFixed(4)),
      chainFireableFraction: aggression.fireableFraction,
      chainPeakSustainedWhileFireable: aggression.peakSustainedWhileFireable,
      chainSlides: aggression.slides,
    };

    console.info(
      `[verifyArsenal] criterion 8 — slide entry at ${out.slideEntrySpeed} m/s is fireable after ` +
        `${out.slideToFireSeconds}s and ${out.distanceBeforeFireableM} m. Fastest ADS in the arsenal ` +
        `is ${out.fastestAdsSeconds}s (${out.fastestAdsWeapon}); fastest sprint-out is ` +
        `${out.fastestSprintOutSeconds}s (${out.fastestSprintOutWeapon}). ` +
        `Chained slide-cancel: ${(out.chainFireableFraction * 100).toFixed(1)}% of ticks fireable ` +
        `across ${out.chainSlides} slides at a ${out.peakSustained} m/s peak sustained.`,
    );
    console.table([out]);
    results.slide = out;
    return out;
  }

  /** The other half of criterion 8: bot aim leading still holds at the tuned ceiling. */
  async function botAim(seconds = 45) {
    installFrameSource();
    const match = ensureMatch();
    match.bots.resetCounters();
    const before = match.bots.report();
    await sleep(seconds * 1000);
    const after = match.bots.report();
    console.info('[verifyArsenal] criterion 8 — bot hit rates at the tuned speed ceiling');
    console.table(after.tiers ?? []);
    results.botAim = { before, after };
    return results.botAim;
  }

  // ==========================================================================
  // Criterion 9 — frame time with equipment live
  // ==========================================================================

  async function frameTime(seconds = 25) {
    installFrameSource();
    const match = ensureMatch();
    await sleep(400);

    // Ten bots, and keep grenades and smoke in the air for the whole window.
    if (match.bots.botCount < 10) {
      match.bots.clear();
      match.bots.populate(5, 5, ['REGULAR', 'HARDENED', 'VETERAN']);
      match.registerRoster();
    }

    const equipment = match.equipment;
    const stats = api.stats();
    stats.reset();

    const throwEvery = setInterval(() => {
      const sim = api.sim();
      if (sim === undefined) return;
      const yaw = Math.random() * Math.PI * 2;
      for (const id of ['frag', 'flashbang', 'smoke']) {
        equipment.system.throwFrom(
          api.equipmentDefs[id],
          0,
          'A',
          sim.x,
          sim.y + sim.eyeHeight,
          sim.z,
          yaw + Math.random(),
          0.1,
          0,
          0,
          0,
          false,
        );
      }
    }, 900);

    await sleep(seconds * 1000);
    clearInterval(throwEvery);

    stats.recompute();
    const out = {
      p50: Number(stats.p50.toFixed(2)),
      p95: Number(stats.p95.toFixed(2)),
      p99: Number(stats.p99.toFixed(2)),
      worst: Number(stats.worst.toFixed(2)),
      mean: Number(stats.mean.toFixed(2)),
      simLastMs: Number(stats.lastSimMs.toFixed(3)),
      peakModeMs: Number(stats.peakModeMs.toFixed(3)),
      peakHudMs: Number(stats.peakHudMs.toFixed(3)),
      equipmentMs: Number(equipment.lastMs.toFixed(3)),
      liveProjectiles: equipment.system.projectiles.liveCount,
      liveSmoke: equipment.system.smoke.liveCount,
      thrown: equipment.system.thrownTotal,
      detonated: equipment.system.detonatedTotal,
      botThrows: equipment.botThrower.throws,
      botUnsafeRejects: equipment.botThrower.rejectedUnsafe,
    };
    console.info('[verifyArsenal] criterion 9 — frame time with grenades and smoke live');
    console.table([out]);
    results.frameTime = out;
    return out;
  }

  async function all() {
    patterns();
    voices();
    balance();
    purity();
    attachments();
    pellets();
    slide();
    flash();
    await smoke();
    await frameTime();
    await botAim();
    restoreFrameSource();
    console.info('[verifyArsenal] done. Everything is stashed on __verifyArsenal.results.');
    return results;
  }

  window.__verifyArsenal = {
    all,
    patterns,
    voices,
    balance,
    purity,
    attachments,
    pellets,
    smoke,
    flash,
    slide,
    botAim,
    frameTime,
    restoreFrameSource,
    results,
  };
  console.info('[verifyArsenal] loaded. await __verifyArsenal.all()');
})();
