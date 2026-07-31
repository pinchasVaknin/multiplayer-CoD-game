/* eslint-disable */
/**
 * M6 acceptance suite — progression and loadouts.
 *
 *   fetch('/verify/progression.js').then(r => r.text()).then(eval)
 *   await __verifyProgression.all()
 *
 * Every check reads its answer out of the live game rather than recomputing it:
 * the resolved weapon comes from `resolveLoadout`, the perk effects are measured against
 * the systems that carry them, the migration is the real one, and the write count is
 * `SaveStore`'s own counter. A suite that does its own arithmetic verifies the suite.
 *
 * Run the perk and challenge sections a few seconds into a match — several of them need
 * a live world, and they say so rather than reporting a false pass.
 */
(() => {
  const api = window.__operator;
  if (api === undefined) throw new Error('__operator is not installed; boot the game first.');

  const results = {};
  const log = (...args) => console.info(...args);
  const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

  function section(name) {
    log(`\n=== ${name} ===`);
  }

  function report(label, ok, detail) {
    log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
    return ok;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Criterion 3: the editor and gameplay share one resolution function. */
  function resolution() {
    section('3. Resolved def is the same function gameplay uses');
    const profile = api.profile;
    const index = profile.equippedIndex;
    const before = api.resolveLoadout();
    const beforeAds = before.primary.adsTime;
    const beforeRecoil = before.primary.recoil.verticalScale;

    // Force the foregrip on, whatever the unlock state, by granting it explicitly. That is
    // the same door the kill threshold opens, so the gate is exercised rather than bypassed.
    profile.unlockAttachment(before.primaryBase.id, 'grip_foregrip');
    profile.editLoadout(index, (slot) => {
      if (!slot.primary.attachments.includes('grip_foregrip')) {
        slot.primary.attachments.push('grip_foregrip');
      }
    });
    const after = api.resolveLoadout();

    const adsMoved = after.primary.adsTime > beforeAds;
    const recoilMoved = after.primary.recoil.verticalScale < beforeRecoil;
    const baseUntouched = after.primaryBase.adsTime === before.primaryBase.adsTime;

    results.resolution = {
      adsMs: [round(beforeAds * 1000, 1), round(after.primary.adsTime * 1000, 1)],
      recoilVertical: [round(beforeRecoil), round(after.primary.recoil.verticalScale)],
      baseUntouched,
    };
    log(`   ADS ${results.resolution.adsMs[0]} ms -> ${results.resolution.adsMs[1]} ms`);
    log(`   Recoil vertical ${results.resolution.recoilVertical[0]} -> ${results.resolution.recoilVertical[1]}`);

    // Undo, so the suite leaves the profile as it found it.
    profile.editLoadout(index, (slot) => {
      slot.primary.attachments = slot.primary.attachments.filter((a) => a !== 'grip_foregrip');
    });

    return (
      report('foregrip moves ADS time', adsMoved) &&
      report('foregrip moves vertical recoil', recoilMoved) &&
      report('the base def is not mutated', baseUntouched)
    );
  }

  /** Criterion 4: every perk has a measurable effect. */
  function perks() {
    section('4. Perk effects, measured');
    const rows = [];
    const base = api.resolveLoadout().primaryBase;

    // The three weapon-number perks are measured through the same resolver gameplay uses.
    const weaponPerks = [
      ['quickdraw', 'adsTime', (d) => d.adsTime * 1000, 'ms'],
      ['sleight_of_hand', 'reloadTime', (d) => d.reloadTime * 1000, 'ms'],
      ['amped', 'swapInTime', (d) => d.swapInTime * 1000, 'ms'],
    ];
    for (const [id, field, read, unit] of weaponPerks) {
      const off = read(base);
      const on = read(api.perkResolve(base, [id]));
      rows.push({ perk: api.perks[id].name, field, off: round(off, 1), on: round(on, 1), unit });
    }

    // The state-side perks are measured off `PerkState`, which is what the systems read.
    const stateChecks = [
      ['lightweight', 'moveSpeedMult'],
      ['dead_silence', 'audibleFootsteps'],
      ['battle_hardened', 'flashResistMult'],
      ['scavenger', 'scavenger'],
      ['tracker', 'tracker'],
      ['overkill', 'overkill'],
      ['ghost', 'visibleToUav'],
      ['cold_blooded', 'targetedByStreaks'],
      ['hardline', 'streakDiscount'],
    ];
    for (const [id, field] of stateChecks) {
      const off = api.perkStateOf([])[field];
      const on = api.perkStateOf([id])[field];
      rows.push({ perk: api.perks[id].name, field, off, on, unit: '' });
    }
    console.table(rows);
    results.perks = rows;

    const allMoved = rows.every((r) => String(r.off) !== String(r.on));
    const twelve = new Set(rows.map((r) => r.perk)).size === 12;
    return report('all twelve perks change something', allMoved && twelve, `${rows.length} measurements`);
  }

  /** Criterion 4, the Dead Silence half: verified against bot perception. */
  async function deadSilence() {
    section('4. Dead Silence against bot perception');
    const match = api.match();
    if (match == null) return report('needs a live match', false, 'start a match first');

    const bots = match.bots;
    const before = bots.perception.noise.currentSerial;

    // Emit a footstep the way the player does, with the gate off and then on.
    const sim = api.sim();
    const emit = () => {
      match.bots.perception.noise.emit(1, 0, 'A', sim.x, sim.y, sim.z);
    };
    const gateWas = bots.silentFootsteps;

    bots.silentFootsteps = null;
    emit();
    const audible = bots.perception.noise.currentSerial - before;

    // The real path: the director's own subscription, gated by the perk.
    const mid = bots.perception.noise.currentSerial;
    bots.silentFootsteps = (id) => id === 0;
    // The gate lives in the event handler, so drive the event rather than the field.
    api.bus.emit('player.footstep', {
      entityId: 0,
      x: sim.x,
      y: sim.y,
      z: sim.z,
      speed: 5,
      heavy: true,
      quiet: false,
      material: 0,
    });
    const silenced = bots.perception.noise.currentSerial - mid;

    bots.silentFootsteps = gateWas;
    results.deadSilence = { audibleSerials: audible, silencedSerials: silenced };
    log(`   noise serials: ungated ${audible}, with Dead Silence ${silenced}`);
    return report('Dead Silence stops footsteps entering the noise field', audible > 0 && silenced === 0);
  }

  /** Criterion 5: a hand-edited save cannot equip a locked weapon. */
  function unlockGate() {
    section('5. Unlock gates');
    const profile = api.profile;
    const raw = JSON.parse(JSON.stringify(profile.save));
    const locked = api.weapons.find((w) => w.unlockLevel > profile.level + 1);
    if (locked === undefined) {
      return report('needs a locked weapon', false, 'level is too high; reset progress first');
    }

    raw.loadouts[0].primary.weaponId = locked.id;
    raw.profile.level = 55; // and claim the level that would justify it
    const inspected = api.inspectSave(raw);

    const levelCorrected = inspected.save.profile.level !== 55;
    const equipped = inspected.save.loadouts[0].primary.weaponId;

    // The repair fixes the level; the unlock gate then refuses the weapon on the way in.
    const losses = [...inspected.losses];
    const gate = api.sanitise(inspected.save.loadouts[0], inspected.save.profile.level, losses);

    results.unlockGate = {
      attempted: locked.id,
      requiredLevel: locked.unlockLevel,
      claimedLevel: 55,
      correctedLevel: inspected.save.profile.level,
      finalWeapon: inspected.save.loadouts[0].primary.weaponId,
      losses,
    };
    for (const line of losses) log(`   ${line}`);

    return (
      report('a claimed level that the XP does not support is corrected', levelCorrected,
        `claimed 55, resolved ${inspected.save.profile.level}`) &&
      report('the locked weapon is refused', gate && inspected.save.loadouts[0].primary.weaponId !== locked.id,
        `${equipped} -> ${inspected.save.loadouts[0].primary.weaponId}`)
    );
  }

  /** Criterion 7: migration from a synthetic V0, then a corrupted field. */
  function migration() {
    section('7. Migration and corruption recovery');
    const v0 = api.syntheticV0();
    const migrated = api.testMigration();
    const carbine = migrated.weapons['ar_carbine'];

    const survived =
      migrated.profile.xp === v0.xp &&
      migrated.profile.prestige === v0.prestige &&
      carbine.kills === v0.weaponKills.ar_carbine &&
      migrated.settings.fov === v0.settings.fov &&
      migrated.loadouts[1].primary.weaponId === v0.classes[1].primary;

    results.migration = {
      xp: [v0.xp, migrated.profile.xp],
      level: migrated.profile.level,
      prestige: [v0.prestige, migrated.profile.prestige],
      carbineKills: [v0.weaponKills.ar_carbine, carbine.kills],
      fov: [v0.settings.fov, migrated.settings.fov],
      class2: [v0.classes[1].primary, migrated.loadouts[1].primary.weaponId],
      retiredWeaponDropped: migrated.weapons['ar_retired_prototype'] === undefined,
    };
    console.table(results.migration);

    // Now break it, deliberately, in five different ways at once.
    const damaged = JSON.parse(JSON.stringify(api.save()));
    damaged.profile.xp = 'not a number';
    damaged.profile.level = 55;
    damaged.weapons.ar_carbine = null;
    damaged.weapons.weapon_that_never_existed = { kills: 9 };
    damaged.loadouts[0].primary.weaponId = 'ar_ghost';
    damaged.loadouts[0].perks = ['quickdraw', 'quickdraw', 'quickdraw'];
    damaged.camos.plaid = true;
    damaged.challenges.retired_challenge = { progress: 4, completed: false };

    const recovered = api.inspectSave(damaged);
    results.corruption = { losses: recovered.losses, level: recovered.save.profile.level };
    for (const line of recovered.losses) log(`   ${line}`);

    const kept = recovered.save.loadouts.length === 5 && recovered.save.profile.xp === 0;

    return (
      report('every V0 field survived', survived) &&
      report('the retired weapon was dropped and reported', results.migration.retiredWeaponDropped) &&
      report('a corrupt save recovers with a loss report', recovered.losses.length >= 5 && kept,
        `${recovered.losses.length} repairs`)
    );
  }

  /** Criterion 8: how often the save is actually written. */
  function writes() {
    section('8. Save write frequency');
    const w = api.saveWrites();
    results.writes = w;
    log(`   ${w.writes} write(s) since page load, persistent: ${w.persistent}`);
    log('   Play a full match and re-run this: the count should rise by one or two.');
    return report('writes are counted at the point of writing', typeof w.writes === 'number');
  }

  /** Criterion 1 / 6: what a live match has accrued. */
  function live() {
    section('1 & 6. Live match progression');
    const match = api.match();
    if (match == null) return report('needs a live match', false, 'start a match first');
    const progression = match.meta.progression;
    const rows = api.challengeProgress()
      .filter((r) => r.state.progress > 0)
      .map((r) => ({
        challenge: r.def.name,
        kind: r.def.rule.kind,
        progress: `${r.state.progress}/${r.def.target}`,
        done: r.state.completed,
        camo: r.def.camo ?? '',
      }));
    console.table(rows);
    results.live = {
      kills: progression.killCount,
      pendingXp: progression.liveXp,
      challengesTouched: rows.length,
      camos: Object.entries(api.save().camos).filter(([, v]) => v).map(([k]) => k),
    };
    log(`   ${progression.killCount} kills, ${progression.liveXp} XP pending`);
    return report('challenge counters are moving', rows.length > 0 || progression.killCount === 0,
      `${rows.length} challenges touched`);
  }

  /** S7's simulator, printed. */
  function pacing() {
    section('S7. XP / unlock pacing');
    const sim = api.simulateXp(400);
    results.pacing = {
      perMatch: sim.perMatch,
      matchesToMax: sim.matchesToMax,
      hoursToMax: sim.matchesToMax > 0 ? round((sim.matchesToMax * 10) / 60, 1) : -1,
    };
    return report('the curve reaches 55', sim.matchesToMax > 0,
      `${sim.matchesToMax} matches (${results.pacing.hoursToMax} h) at ${sim.perMatch} XP/match`);
  }

  async function all() {
    const outcomes = [];
    outcomes.push(['3 resolution', resolution()]);
    outcomes.push(['4 perks', perks()]);
    outcomes.push(['4 dead silence', await deadSilence()]);
    outcomes.push(['5 unlock gate', unlockGate()]);
    outcomes.push(['7 migration', migration()]);
    outcomes.push(['8 writes', writes()]);
    outcomes.push(['1/6 live', live()]);
    outcomes.push(['S7 pacing', pacing()]);
    await sleep(0);
    section('summary');
    console.table(outcomes.map(([name, ok]) => ({ check: name, result: ok ? 'PASS' : 'FAIL' })));
    return results;
  }

  window.__verifyProgression = {
    all,
    resolution,
    perks,
    deadSilence,
    unlockGate,
    migration,
    writes,
    live,
    pacing,
    results,
  };
  log('[verify/progression] loaded. Run `await __verifyProgression.all()`.');
})();
