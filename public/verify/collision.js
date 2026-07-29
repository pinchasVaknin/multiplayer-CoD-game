(() => {
  const g = window.__operator.game;
  const p = g.player;
  const world = g.map.collision;
  const cfg = g.movementConfig;

  const B = { Jump: 1, Crouch: 2, Sprint: 4, Ads: 8 };
  let seq = 0;

  function mk(tick, moveX, moveZ, yaw, buttons) {
    // Normalise diagonals the way core/Input does, so policies match real input.
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }
    return { seq: seq++, tickIndex: tick, moveX, moveZ, yaw, pitch: 0, buttons, sampledAtMs: tick * 16.6667 };
  }

  function drive(name, spawn, yaw, ticks, policy, expectStance) {
    p.spawn(spawn[0], spawn[1], spawn[2], yaw);
    // Settle first: a spawn point inside geometry would otherwise be reported as a
    // collision failure when it is really a bad test position.
    for (let t = 0; t < 10; t++) p.step(mk(-10 + t, 0, 0, yaw, 0));
    const spawnClear = !world.overlapCapsule(p.sim.x, p.sim.y, p.sim.z, cfg.capsuleRadius, p.sim.capsuleHeight);

    let overlapMoving = 0;
    let overlapMantle = 0;
    let escaped = 0;
    let firstBad = -1;
    let maxSpeed = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    const stances = new Set();
    let sawSlide = false;
    let mantles = 0;
    let wasMantling = false;

    for (let t = 0; t < ticks; t++) {
      const c = policy(t, p.sim);
      p.step(mk(t, c[0], c[1], yaw, c[2]));
      const s = p.sim;
      stances.add(s.stance);
      if (s.slideActive) sawSlide = true;
      if (s.mantleActive && !wasMantling) mantles++;
      wasMantling = s.mantleActive;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
      if (s.speed > maxSpeed) maxSpeed = s.speed;

      const overlapping = world.overlapCapsule(s.x, s.y, s.z, cfg.capsuleRadius, s.capsuleHeight);
      if (overlapping) {
        // A vault deliberately passes through the ledge lip; the invariant that matters
        // is that it only starts when the destination is clear and always ends clear.
        if (s.mantleActive) overlapMantle++;
        else {
          overlapMoving++;
          if (firstBad < 0) firstBad = t;
        }
      }
      if (Math.abs(s.x) > 24.2 || Math.abs(s.z) > 18.2 || s.y < -3.6 || s.y > 12) escaped++;
    }

    const s = p.sim;
    const endClear = !world.overlapCapsule(s.x, s.y, s.z, cfg.capsuleRadius, s.capsuleHeight);
    const stanceOk = expectStance === undefined || s.stance === expectStance;
    return {
      name,
      pass: spawnClear && endClear && stanceOk && overlapMoving === 0 && escaped === 0,
      spawnClear,
      endClear,
      stanceOk,
      expectStance: expectStance ?? '-',
      overlapMoving,
      overlapMantle,
      firstBadTick: firstBad,
      escapedTicks: escaped,
      end: [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)],
      stance: s.stance,
      stances: [...stances].join('|'),
      sawSlide,
      mantles,
      maxSpeed: +maxSpeed.toFixed(2),
      minY: +minY.toFixed(3),
      maxY: +maxY.toFixed(3),
    };
  }

  const YAW = { negZ: 0, posX: -Math.PI / 2, posZ: Math.PI, negX: Math.PI / 2 };
  const sprintFwd = () => [0, 1, B.Sprint];
  const r = [];

  // --- criterion 3: nothing clips through walls -------------------------
  r.push(drive('sprint into flat wall', [0, 0.1, -14], YAW.negZ, 240, sprintFwd));
  r.push(drive('sprint into NE corner', [20, 0.1, -14], YAW.negZ, 240, () => [1, 1, B.Sprint]));
  r.push(drive('sprint into SW corner', [-20, 0.1, 14], YAW.posZ, 240, () => [1, 1, B.Sprint]));

  r.push(
    drive('slide into wall', [0, 0.1, -9], YAW.negZ, 200, (t, s) => {
      if (s.slideActive) return [0, 1, B.Sprint | B.Crouch];
      if (t >= 30 && t < 34) return [0, 1, B.Sprint | B.Crouch];
      return [0, 1, B.Sprint];
    }),
  );

  r.push(
    drive('jump into 1.5m ledge lip', [-5, 0.1, 6], YAW.negX, 300, (t) => [
      0,
      1,
      B.Sprint | (t % 24 === 0 ? B.Jump : 0),
    ]),
  );

  r.push(
    drive(
      'mantle into low ceiling',
      [17.4, 0.1, 8],
      YAW.posX,
      200,
      (t) => [0, 1, t % 30 === 5 ? B.Jump : 0],
      'CROUCH',
    ),
  );

  // --- criterion 4: standing up under the overhang is blocked -----------
  // Crouch-walk from clear ground into the middle of the 1.25 m overhang (z 2..6),
  // stop, then release crouch and hold for 2.5 s. Stance must stay CROUCH.
  const intoOverhang = (t) => {
    if (t < 80) return [0, 1, B.Crouch]; // crouch-walk in
    if (t < 100) return [0, 0, B.Crouch]; // settle
    return [0, 0, 0]; // release crouch and wait
  };
  r.push(drive('stand under 1.25m overhang', [-19.95, 0.1, 0.5], YAW.posZ, 250, intoOverhang, 'CROUCH'));

  // Same, but mash jump after releasing crouch: must not launch through the slab.
  const jumpUnderOverhang = (t) => {
    if (t < 80) return [0, 1, B.Crouch];
    if (t < 100) return [0, 0, B.Crouch];
    return [0, 0, t % 20 === 0 ? B.Jump : 0];
  };
  r.push(drive('jump under 1.25m overhang', [-19.95, 0.1, 0.5], YAW.posZ, 250, jumpUnderOverhang, 'CROUCH'));

  // --- movement features ------------------------------------------------
  r.push(drive('0.3m step-up (silent)', [0, 0.1, -8.5], YAW.negZ, 120, sprintFwd));
  r.push(
    drive('0.7m crate mantle', [2, 0.1, 12.6], YAW.negZ, 180, (t) => [
      0,
      1,
      B.Sprint | (t % 40 === 20 ? B.Jump : 0),
    ]),
  );
  r.push(drive('walk up 18deg ramp', [-17.6, 0.1, 6], YAW.posX, 180, sprintFwd));
  r.push(drive('fall into pit', [7.2, 0.1, 0.5], YAW.posZ, 240, () => [0, 1, 0]));
  r.push(drive('climb 27deg pit ramp', [10.3, -2.9, 7.4], YAW.negZ, 200, sprintFwd));
  r.push(drive('narrow 1.1m corridor', [-19.95, 0.1, -1], YAW.posZ, 240, () => [0.6, 1, B.Sprint]));

  const sp = g.map.spawns[0];
  p.spawn(sp.position.x, sp.position.y, sp.position.z, sp.facingYaw);

  return { allPass: r.every((x) => x.pass), failed: r.filter((x) => !x.pass).map((x) => x.name), results: r };
})();
