/**
 * Milestone 3 acceptance measurements (brief S8).
 *
 * Drives the REAL loop, collision world, damage system and bot brains. The frame source
 * is substituted because requestAnimationFrame does not fire in a tab that is not
 * compositing; nothing else is faked. Every number printed here was measured on this
 * build during this run.
 *
 *   await window.__verifyBots()          full suite
 *   await window.__verifyBots('ttk')     one section
 *
 * Sections: states, ttk, hitrate, spawns, scheduler.
 */
(() => {
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

  /** Run `ticks` simulation steps directly, with no renderer and no wall-clock waiting. */
  function stepSim(g, ticks) {
    for (let i = 0; i < ticks; i++) {
      g.simulate(g.loop.currentTick);
      g.loop.tickIndex++;
    }
  }

  function ctx() {
    const g = window.__operator.game;
    return {
      g,
      match: g.match,
      bots: g.match.bots,
      player: g.player,
      input: g.input,
      loop: g.loop,
    };
  }

  async function enterMatch() {
    const { g, loop } = ctx();
    loop.stop();
    installFrameSource(16);
    if (g.currentState !== 'MATCH') g.transitionTo('MATCH');
    loop.start();
    await sleep(60);
  }

  // ---- 1. every state is entered ----------------------------------------
  async function states() {
    const { g, bots, match, loop } = ctx();
    await enterMatch();
    if (bots.botCount === 0) match.populateDefault();

    const seen = new Map();
    const off = g.bus.on('bot.stateChanged', (p) => {
      seen.set(p.to, (seen.get(p.to) ?? 0) + 1);
    });

    loop.stop();
    // 90 simulated seconds, run flat out with no rendering.
    stepSim(g, 60 * 90);
    off();

    const all = ['IDLE', 'PATROL', 'INVESTIGATE', 'ENGAGE', 'SUPPRESS', 'RELOAD', 'SEEK_COVER', 'FLANK', 'PUSH', 'DEAD'];
    const rows = all.map((s) => ({ state: s, entered: seen.get(s) ?? 0 }));
    console.table(rows);
    const missing = rows.filter((r) => r.entered === 0).map((r) => r.state);
    console.log(missing.length === 0 ? 'All 10 states entered.' : `NOT ENTERED: ${missing.join(', ')}`);
    return rows;
  }

  // ---- 2. time to kill, both directions, at 10 m -------------------------
  /**
   * Both directions use the same weapon def and the same DamageSystem, so this measures
   * whether that is actually true rather than assuming it. Timed in sim ticks, which is
   * the only clock the result depends on.
   */
  const BTN_ADS = 1 << 3;
  const BTN_FIRE = 1 << 4;
  const RANGE = 10;

  /**
   * The M1 measurement lane at z = -14: the one straight in the room with a clear line
   * for its whole length. Facing yaw is -PI/2, which is +X.
   */
  const LANE_Z = -14;
  const LANE_X = -20;
  const LANE_YAW = -Math.PI / 2;

  /**
   * Take the M2 range out of the damage list for the duration of a measurement.
   *
   * The dummies stand in this same lane at 5, 16, 26 and 42 m, and `Ballistics` picks the
   * nearest target along the ray — so the 5 m dummy eats every round aimed at a bot
   * placed at 10 m. Restored by the returned function.
   */
  function detachRange(match) {
    const dummies = match.range.dummies.slice();
    for (const d of dummies) match.damage.unregister(d.entityId);
    return () => {
      for (const d of dummies) match.damage.register(d);
    };
  }

  /** Collect every damage event matching a source/target pair. */
  function watchDamage(g, sourceId, targetId, out) {
    return g.bus.on('damage.dealt', (p) => {
      if (sourceId !== null && p.sourceId !== sourceId) return;
      if (p.targetId !== targetId) return;
      out.hits.push({ amount: p.amount, zone: p.zone, distance: p.distance, tick: g.loop.currentTick });
      if (p.lethal) out.killTick = g.loop.currentTick;
    });
  }

  function summarise(label, out) {
    const first = out.hits[0];
    const torso = out.hits.filter((h) => h.zone === 'torso');
    return {
      direction: label,
      hitsToKill: out.hits.length,
      ticks: out.killTick < 0 || first === undefined ? -1 : out.killTick - first.tick,
      seconds: out.killTick < 0 || first === undefined ? -1 : (out.killTick - first.tick) / 60,
      torsoDamage: torso.length > 0 ? Number(torso[0].amount.toFixed(2)) : -1,
      range: first === undefined ? -1 : Number(first.distance.toFixed(2)),
      zones: out.hits.map((h) => h.zone).join(','),
    };
  }

  async function ttk() {
    const { g, bots, match, loop, player, input } = ctx();
    await enterMatch();
    loop.stop();
    const reattach = detachRange(match);

    // Exactly one opponent, so nothing else in the room can contribute a round.
    bots.populate(0, 1, ['VETERAN']);
    const target = bots.bots[0];
    const botX = LANE_X + RANGE;

    // --- player -> bot ---------------------------------------------------
    // Weapon system, ballistics and damage system are the real ones. Only the bot is held
    // still, because this measures the damage path rather than whether a Veteran dodges.
    player.spawn(LANE_X, 0.05, LANE_Z, LANE_YAW);
    input.setView(LANE_YAW, 0);
    match.playerHealth.reset();
    match.weapons.reset();
    target.spawn(botX, 0.05, LANE_Z, Math.PI / 2);

    // Aim at the torso box centre (1.26 m) from eye height, over 10 m.
    const eye = 0.05 + player.sim.eyeHeight;
    const aimPitch = Math.atan2(0.05 + 1.26 - eye, RANGE);

    const pin = () => {
      target.controller.sim.x = botX;
      target.controller.sim.z = LANE_Z;
      target.rig.setTransform(botX, 0.05, LANE_Z, Math.PI / 2);
    };

    const fire = (buttons) => {
      const cmd = input.sampleNeutral(g.loop.currentTick, performance.now());
      cmd.buttons = buttons;
      cmd.yaw = LANE_YAW;
      cmd.pitch = aimPitch;
      player.step(cmd);
      pin();
      match.weapons.step(cmd, player.sim);
      g.loop.tickIndex++;
    };

    // Settle into the sights first: TTK is a number about the weapon, not about how long
    // the shooter took to raise it.
    for (let i = 0; i < 40; i++) fire(BTN_ADS);

    const p2b = { hits: [], killTick: -1 };
    const offA = watchDamage(g, 0, target.entityId, p2b);
    for (let i = 0; i < 60 * 5 && p2b.killTick < 0; i++) fire(BTN_ADS | BTN_FIRE);
    offA();

    // --- bot -> player ---------------------------------------------------
    // The full brain runs: perception, reaction delay, aim convergence, recoil, bursts.
    // Only the bot's position is pinned, so the engagement stays at 10 m.
    player.spawn(LANE_X, 0.05, LANE_Z, LANE_YAW);
    input.setView(LANE_YAW, 0);
    match.playerHealth.reset();
    match.weapons.reset();
    target.spawn(botX, 0.05, LANE_Z, Math.PI / 2);

    const b2p = { hits: [], killTick: -1 };
    const offB = watchDamage(g, target.entityId, 0, b2p);

    for (let i = 0; i < 60 * 30 && b2p.killTick < 0; i++) {
      stepSim(g, 1);
      target.controller.sim.x = botX;
      target.controller.sim.z = LANE_Z;
      target.rig.setTransform(botX, 0.05, LANE_Z, target.controller.sim.yaw);
    }
    offB();
    reattach();

    const rows = [summarise('player -> bot', p2b), summarise('bot -> player (VETERAN)', b2p)];
    console.table(rows);
    return { playerToBot: rows[0], botToPlayer: rows[1] };
  }

  // ---- 3a. hit rate per tier, fixed engagement --------------------------
  /**
   * The measurement criterion 3 actually asks for: every tier shooting at the *same*
   * target, so the number describes the shooter and nothing else.
   *
   * One bot at 15 m from a stationary player on the open lane. The player's health is
   * restored every tick, which keeps one continuous engagement running for the whole
   * sample instead of ending it at the first kill — the bot still pays its reaction
   * delay once, then fires bursts with its own recoil, spread and convergence.
   *
   * The 8v8 melee below is the same question asked in a real firefight, where a tier is
   * also fighting *itself*: Veteran targets strafe and peek far more than Recruit ones,
   * so that number conflates shooting skill with evasion skill. Both are reported.
   */
  async function hitrateFixed(seconds = 30, range = 15) {
    const { g, bots, match, loop, player, input } = ctx();
    await enterMatch();
    loop.stop();
    const reattach = detachRange(match);

    const tiers = ['RECRUIT', 'REGULAR', 'HARDENED', 'VETERAN'];
    const rows = [];
    const botX = LANE_X + range;

    for (const tier of tiers) {
      bots.populate(0, 1, [tier]);
      const bot = bots.bots[0];
      player.spawn(LANE_X, 0.05, LANE_Z, LANE_YAW);
      input.setView(LANE_YAW, 0);
      match.playerHealth.reset();
      bot.spawn(botX, 0.05, LANE_Z, Math.PI / 2);
      bots.resetCounters();

      let fired = 0;
      let hit = 0;
      const offF = g.bus.on('weapon.fired', (p) => {
        if (p.sourceId === bot.entityId) fired++;
      });
      const offD = g.bus.on('damage.dealt', (p) => {
        if (p.sourceId === bot.entityId && p.targetId === 0) hit++;
      });

      for (let i = 0; i < 60 * seconds; i++) {
        stepSim(g, 1);
        // Hold the engagement open: an immortal, motionless target at a fixed range.
        match.playerHealth.reset();
        bot.controller.sim.x = botX;
        bot.controller.sim.z = LANE_Z;
        bot.rig.setTransform(botX, 0.05, LANE_Z, bot.controller.sim.yaw);
      }
      offF();
      offD();

      rows.push({
        tier,
        fired,
        hit,
        hitRate: fired > 0 ? `${((hit / fired) * 100).toFixed(1)}%` : 'n/a',
      });
    }

    reattach();
    console.table(rows);
    return rows;
  }

  // ---- 3b. hit rate per tier, live firefight ----------------------------
  /**
   * Eight bots of one tier against eight more of the same tier, run for `seconds` of
   * simulated time. See the note on `hitrateFixed` about what this number does and does
   * not isolate.
   */
  async function hitrate(seconds = 60) {
    const { g, bots, match, loop } = ctx();
    await enterMatch();
    loop.stop();
    // Rounds that stop on a range dummy would count as hits against the shooter's tier.
    const reattach = detachRange(match);

    const tiers = ['RECRUIT', 'REGULAR', 'HARDENED', 'VETERAN'];
    const rows = [];

    for (const tier of tiers) {
      bots.populate(4, 4, [tier]);
      bots.resetCounters();
      stepSim(g, 60 * seconds);
      const r = bots.report();
      const t = r.perTier[tier];
      rows.push({
        tier,
        bots: t.bots,
        fired: t.shotsFired,
        hit: t.shotsHit,
        hitRate: `${(t.hitRate * 100).toFixed(1)}%`,
        kills: t.kills,
      });
    }

    reattach();
    console.table(rows);
    return rows;
  }

  // ---- 4. spawn safety, 50 respawns -------------------------------------
  async function spawns(count = 50) {
    const { g, bots, loop } = ctx();
    await enterMatch();
    loop.stop();
    if (bots.botCount === 0) bots.populate(3, 4, ['REGULAR']);

    // Let the roster spread out and start fighting, so respawns happen with enemies
    // genuinely nearby rather than into an empty room.
    stepSim(g, 60 * 20);
    bots.resetCounters();

    let done = 0;
    let minDist = Infinity;
    const choice = { x: 0, y: 0, z: 0, yaw: 0, tier: 'safe', nearestEnemy: 0, insideCone: false, visible: false };
    while (done < count) {
      for (const bot of bots.bots) {
        if (done >= count) break;
        bots.selectSpawn(bot.team, bot.entityId, choice);
        bot.spawn(choice.x, choice.y + 0.05, choice.z, choice.yaw);
        if (choice.nearestEnemy < minDist) minDist = choice.nearestEnemy;
        done++;
      }
      stepSim(g, 60 * 2);
    }

    const s = bots.report().spawns;
    const out = {
      respawns: s.selections,
      minEnemyDistance: `${s.minEnemyDistance.toFixed(2)} m`,
      safe: s.safe,
      hidden: s.hidden,
      leastBad: s.leastBad,
      insideViewCone: s.coneViolations,
      actuallyVisible: s.visibleViolations,
    };
    console.table([out]);
    return out;
  }

  // ---- 5. scheduler cost -------------------------------------------------
  async function scheduler(botCount = 10, seconds = 60) {
    const { g, bots, loop } = ctx();
    await enterMatch();
    loop.stop();

    const half = Math.floor(botCount / 2);
    bots.populate(half, botCount - half, ['RECRUIT', 'REGULAR', 'HARDENED', 'VETERAN']);
    bots.resetCounters();
    stepSim(g, 60 * seconds);

    const r = bots.report();
    const out = {
      bots: r.bots,
      aiP50: `${r.ai.p50Ms.toFixed(3)} ms`,
      aiP99: `${r.ai.p99Ms.toFixed(3)} ms`,
      aiWorst: `${r.ai.worstMs.toFixed(3)} ms`,
      aiMean: `${r.ai.meanMs.toFixed(3)} ms`,
      astarWorstNodes: r.astar.worstNodesPerTick,
      astarDeferred: r.astar.deferred,
      budgetExhaustedTicks: r.astar.budgetExhaustedTicks,
      searchesOk: r.astar.completed,
      searchesFailed: r.astar.failed,
      stuckEvents: r.stuckEvents,
    };
    console.table([out]);
    return out;
  }

  window.__verifyBots = async (only) => {
    const results = {};
    try {
      if (!only || only === 'states') results.states = await states();
      if (!only || only === 'ttk') results.ttk = await ttk();
      if (!only || only === 'hitrate') results.hitrateFixed = await hitrateFixed();
      if (!only || only === 'hitrate') results.hitrateMelee = await hitrate();
      if (!only || only === 'spawns') results.spawns = await spawns();
      if (!only || only === 'scheduler') results.scheduler = await scheduler();
    } finally {
      restoreFrameSource();
    }
    return results;
  };

  console.log('verify/bots.js ready: await window.__verifyBots()');
})();
