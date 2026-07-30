# OPERATOR — debug tooling

Everything here exists from M1 and every later milestone extends it rather than
building a second overlay.

---

## Keys

| Key | Effect |
|---|---|
| `F1` | Toggle the debug overlay |
| `F2` | Toggle collision visualisation (wireframe capsule, contact normals, queried hash cells) |
| `F3` | Reset the frame-time histogram and the speed measurement |
| `F4` | Toggle the AI layer: navmesh, paths, sight lines, cover, spawn scores (M3/M4) |
| `Tab` | Hold for the scoreboard (M4) |
| `Esc` | Release pointer lock (drops back to the menu) |

**The overlay is per-match from M4.** The world — map, player, match, and all of the tooling that
holds a reference to them — is built on entering MATCH and disposed on leaving SUMMARY, so `F1`
does nothing in the menu. `FrameStats` and the `Speedometer` deliberately outlive a match: the
multi-match heap run needs one continuous frame-time history across the boundaries it measures.

Gameplay keys are listed on the menu screen.

---

## The overlay

`F1` opens `debug/DebugOverlay.ts`. Left column is read-outs, right column is live
tuning.

### Performance

| Field | Meaning |
|---|---|
| FPS | Smoothed. Deliberately laggy so it does not flicker; do not tune against it. |
| Frame / Sim / Render | Last frame's wall time, time inside sim steps, time inside the render callback. |
| Sim steps | Steps executed last frame (0–5), and a cumulative count of frames that hit the 5-step cap and discarded a backlog. |
| p50 / p95 / p99 | Percentiles over the rolling 600-frame buffer. **p99 is the number that matters**, not average FPS. |
| Worst / mean | Worst frame in the buffer, and the mean. |
| Over 16.7ms | How many of the buffered frames missed a 60 Hz budget. |
| Draws / tris | `WebGLRenderer.info.render`. Includes the shadow pass. |
| Map | Collider count, spatial-hash cell count, and how long the AO bake took at load. |

The graph underneath is the same 600-frame buffer: a line for total frame time, a
filled area for sim time (so a sim spike is distinguishable from a GPU stall), grid
lines at 16.7 and 33.4 ms, and a dashed marker at p99.

Text refreshes at 15 Hz and the graph at 5 Hz. Updating every frame would have the
overlay measurably perturbing the frame times it is there to report.

### Player

Position, velocity, horizontal speed, stance, grounded flag with the resolved ground
normal's Y, capsule and eye height, the tactical-sprint timer with its cooldown and
slide lockout, the slide timer with its cooldown, the sprint-hold / coyote / jump-buffer
timers, the active speed cap and airborne speed cap, current FOV, and a flags line
(`blocked`, `step`, `mantle`, live audio voice count).

### Measurement

Wall-clock speed over a 0.25 s and a 1.0 s window, plus the peaks.

**Read the peak fields with care.** Position only advances on 60 Hz sim ticks, so a
wall-clock window of length T contains `round(T/DT) ± 1` ticks. Averages are unbiased;
*peaks* select the window that caught the extra tick and read about `+1/N` high — near
+1.7% at a one-second window. A correctly bounded 8.2 m/s shows a sustained peak near
8.3 here. That is measurement quantisation, not a movement bug. Use the harness
(below) when you need an exact figure; it counts whole ticks.

**Synthetic load** burns the given number of milliseconds inside every frame. This is
how to prove the simulation is frame-rate independent without DevTools: drag it up,
watch FPS collapse, and confirm the 1.0 s speed read-out does not move.

### Tools

Collision visualisation toggle and a frame-stats reset.

### Tuning

Sliders for **every** constant in `player/MovementConfig.ts` and
`player/CameraConfig.ts`, generated from the metadata tables in those files. Adding a
config field without metadata is a compile error, so the panel cannot drift out of date
with the config.

**Copy config** writes the tuned values back out as TypeScript source, ready to paste
over the defaults. If the clipboard is unavailable (insecure origin, denied permission)
it falls back to the console. **Reset** restores the shipped defaults.

---

## Console API

`window.__operator` is installed once the world is built.

```js
__operator.report()            // full harness report: speeds, slide rules, movement bound
__operator.harness             // debug/Harness.ts instance, for custom runs
__operator.sim()               // live PlayerSim
__operator.stats()             // FrameStats
__operator.speedometer()       // Speedometer
__operator.setSyntheticLoad(30) // ms of busy-wait per frame
__operator.game                // everything else
```

### The headless harness

`debug/Harness.ts` drives synthetic `InputCommand`s through a real `PlayerController`
against a real `CollisionWorld`, with no renderer and no wall clock. It is the right
tool for anything that is a property of the simulation.

```js
__operator.harness.measureSpeeds()          // steady-state speed per locomotion mode
__operator.harness.measureMaxSustained(60)  // adversarial slide-cancel chaining, 60 s
__operator.harness.verifySlideRules()       // the LOCKED S5.2 numbers, read back out of a live run
__operator.harness.run(seconds, policy)     // custom policy
```

A policy is `(tick, player, cmd) => void` and writes into a reused mutable command.
`Harness.walkForward`, `.sprintForward`, `.crouchForward`, `.tacSprintForward` and
`.chainSlideCancel` are provided.

### Reproducible verification scripts

Three scripts under `public/verify/` reproduce the M1 acceptance measurements. They run
against the live build:

```js
fetch('/verify/collision.js').then(r => r.text()).then(eval)  // 14 clipping / stance cases
fetch('/verify/framerate.js').then(r => r.text()).then(eval)  // m/s at ~125, ~62, ~15 fps
fetch('/verify/overlay.js').then(r => r.text()).then(eval)    // overlay fields, collision viz, histogram
```

`collision.js` drives the real controller into every wall, corner, ledge and the low
overhang, asserting after every tick that the capsule does not intersect geometry and
never leaves the room shell. Vault ticks are counted separately: a mantle deliberately
passes through the ledge lip, and the invariant that matters is that it only starts when
the destination is clear and always ends clear.

`framerate.js` substitutes the frame source (rAF does not fire in a tab that is not
compositing) and measures metres per second of wall-clock time at three frame rates.
The loop, accumulator, input path and collision are untouched.

---

## The M2 weapon panels

`debug/WeaponDebug.ts` adds four sections to the left column and three slider sets to the
right. All of it refreshes on the overlay's own hooks (`addTextHook` at 15 Hz,
`addGraphHook` at 5 Hz) rather than on a timer of its own.

### Weapon

Ammo, state, ADS and raise fractions, live spread, measured RPM, player health.

**`ADS / raise` is the field to watch when something feels wrong.** `raise` is the single
authority for whether the weapon can fire, and the viewmodel poses against the same
number — so if the read-out says `0.53 (cannot fire)` while the gun looks ready, that is a
bug in the pose, not a disagreement between two states. There is only one state.

### Last hit

Target, zone, range, then `base x mult = final`, with the falloff and penetration losses
broken out separately. This is what acceptance criteria 3 and 4 are read from. The
hitmarker latency underneath is hit-to-visual in milliseconds: from `damage.dealt` being
applied in the sim to the HUD making the marker visible. Budget is 30 ms.

`F4`, or the toggle here, draws every live hitbox rig, colour-coded by zone: amber head,
green torso, blue arms, grey legs. The local player's own rig is excluded — it is centred
on the camera and would just fill the screen.

### Recoil pattern

Two canvases.

The **pattern plot** draws three traces in one space: the authored pattern in grey, the
burst you just fired in amber, and the burst before it in green. Two magazines fired with
the trigger held from a fixed position land exactly on top of each other — that is
acceptance criterion 2, visible rather than asserted. Call
`__operator.weaponDebug().resetBursts()` first if you want only the next two mags in view.

The **spread ring** shows the live cone against the weapon's authored bounds (hip moving,
hip standing, ADS) with the last thirty rounds plotted inside it.

### Input latency

`mousedown` to the end of the render callback that first draws the shot, as a bucketed
histogram (half a frame per bucket, gridlines at 1/2/3 frames) and as p50/p99 in both
frames and milliseconds. Green under two frames, red over.

**This does not include the compositor.** A page has no way to observe when its pixels
reach the panel, so every number here has one further frame of presentation on top of it.
That is why the read-out is in frames as well as milliseconds — the frame count is the
part that is actionable.

### Pools

Live tracers, particles, decals against their cap, and audio voices against the pool size
with its high-water mark. **The pool figure is the one acceptance criterion 6 is really
about**: a correctly pooled audio graph holds `poolSize` at 64 no matter how long the
trigger is held, and `ObjectPool` warns to the console once if it ever has to grow.

### Tuning

Three more generated slider sets: the AR's full `WeaponDef` (every numeric leaf, derived
from the schema), `ViewmodelConfig`, and `HealthConfig`. Same COPY / RESET behaviour as
M1's panels.

The recoil *pattern array* is not slidered — it is authored data, not a scalar. Its
scalars (`verticalScale`, `horizontalScale`, `firstShotScale`, the recovery pair, and the
ADS and visual multipliers) are, and the plot redraws as you move them.

---

## The weapon harness

`debug/WeaponHarness.ts` is the M2 counterpart to `Harness`: real `InputCommand`s through
a real `PlayerController` and a real `WeaponSystem`, against a purpose-built world with a
thin steel panel and a thick concrete one. No renderer, no audio, no DOM.

```js
__operator.weaponReport()                       // everything the criteria ask for
__operator.weaponHarness.verifyDeterminism()    // two magazines, same seed, max deviation
__operator.weaponHarness.measureZones(26)       // head / torso / limb at a range
__operator.weaponHarness.measurePenetration()   // thin panel through, thick panel blocked
__operator.weaponHarness.measureTimings()       // ADS, both reloads, sprint-to-fire, RPM
__operator.weaponHarness.fireMagazine(seed)     // raw shot placements, degrees
```

`measureZoneDamage` reads its numbers back out of `DamageSystem.lastHit` rather than
recomputing them — a harness that does its own arithmetic verifies the harness.

### `verify/gunplay.js`

```js
fetch('/verify/gunplay.js').then(r => r.text()).then(eval)   // criteria 1, 5, 6, 8
```

Everything that is purely a property of the simulation is in the harness above. This
script covers what only exists once frames are being produced: the handling trace, the
hitmarker and input-latency loops, sixty seconds of continuous fire, and the fire rate
under a throttled frame source. It substitutes the frame source the same way
`framerate.js` does.

**Run it on a freshly loaded page.** Chrome applies intensive timer throttling to pages
that have been hidden for about five minutes, which clamps the substituted frame source
and makes every wall-clock number in the script meaningless — the tick counter crawls and
the soak reports nonsense. A reload resets the grace period; the script finishes well
inside it.

---

## The M4 mode panels

`debug/ModePanel.ts` adds four sections to the left column, all refreshed on the overlay's own
15 Hz text hook.

### Mode

Phase and round (`WARMUP` / `LIVE` / `ROUND_END` / `MATCH_END`, plus `SWAPPED` when the ends have
changed), team scores against the limit, the match clock and the phase countdown, whether the
respawn gate is open and how many lives are left, and the local player's own line.

**`Phase` is the field to watch when the match seems stuck.** Kills only count while the round is
`LIVE`, and nobody respawns during `ROUND_END` or `MATCH_END` — so a match that appears frozen is
usually a flow phase, not a broken mode.

### Spawns

Safe / hidden / least-bad tallies, the minimum enemy distance any selection has produced, and the
cone and visible violation counts. **The two violation counters mean different things**: inside a
cone is unavoidable on a map smaller than `visionRange`, and *visible* is the one that should be
zero.

`Spawn score visualisation` draws every candidate spawn as a point coloured by the tier the
selector would put it in right now — green safe, amber hidden, red least-bad, grey for the other
end's zones — with brightness carrying the score inside the tier. It needs the F4 layer visible,
and it rescores at 4 Hz through `SpawnSelector.inspect`, which is the same `measure` call the
selector itself uses. A visualisation that recomputed the score its own way would be a picture of
a second spawn selector.

### Lanes & objectives

`Measure lane timings` runs the **real** A\* from each team's lane spawn to the point in that lane
where the two teams meet, measures the smoothed path and divides by sprint speed. It prints a
table and caches the result on `__operator.laneReport()`. This is what acceptance criterion 3 is
read from; a hand-measured straight line would report the distance the author intended rather than
the distance a player walks around the cover the author placed.

`Objectives on minimap` turns on the Domination flags and S\&D bomb sites. **Off by default**:
they are authored for M7 and drawing them during Team Deathmatch is noise. The list underneath
shows every objective's kind, label, position and radius whether or not the minimap is drawing it.

### Killfeed log

The last twelve kills as `KILLER [team] → VICTIM [team] (weapon)`, newest first, from
`killfeed.entry`. Useful when the on-screen feed has faded and you want to know what just happened.

### Match harness

`Run 3 matches (heap)` and `Run 10 matches (heap)` are one click each; `Swap sides now` exercises
the round abstraction's side swap, which Team Deathmatch never triggers by itself.

---

## The match harness

`debug/MatchHarness.ts` plays whole matches back to back with a full teardown between them and
logs the heap at every boundary (S7).

```js
await __operator.runMatches(3)     // or 10
__operator.matchReport()           // the boundaries again, without re-running
```

The M3 harness proved a *firefight* does not leak. This proves a **match** does not, which is a
different question: M4 builds and destroys the map, the navmesh, the collision hash, every mesh
and material, the bot roster, the HUD, the scoreboard and a dozen subscriptions on every cycle,
and any one of them held past `teardownWorld` is a step in `usedJSHeapSize` that a single long
match would never show.

Three things make the number trustworthy:

- **The match is driven to its real end**, not cut short. `MatchFlow` decides when it is over
  exactly as it would for a player, and the harness waits for the state machine to reach SUMMARY.
- **The clock is compressed by adding ticks, never by changing `DT`.** `Loop.simSpeed` runs the
  same 1/60 s simulation more times per frame (S4.1).
- **The heap is provoked before it is sampled.** `usedJSHeapSize` straight after a teardown is
  mostly uncollected garbage. Six consecutive matches once came back 51.9, 50.9, 65.3, 70.1, 56.9,
  60.1 MB — a 19 MB spread with no trend, which is V8 deciding when to collect rather than
  anything the game did. `window.gc` only exists behind `--expose-gc`, so the harness allocates
  and drops ~48 MB to force a cycle, then waits, then reads. What survives that is what is
  actually retained.

Each boundary also carries that match's frame percentiles and the peak mode and HUD milliseconds,
so a match that got slower is visible next to the heap that did or did not grow.

---

## `verify/tdm.js`

```js
fetch('/verify/tdm.js').then(r => r.text()).then(eval)
await __verifyTdm.all()          // every criterion, in order
__verifyTdm.lanes()              // 3 — lane timings
__verifyTdm.clearanceAudit()     // 2 — gaps too narrow to walk through
await __verifyTdm.snagSweep()    // 2 — sprint every wall
await __verifyTdm.botCoverage()  // 4, 5 — catwalks, cover, centre, spawn safety
await __verifyTdm.frameProfile() // 8 — frame, AI, mode and HUD milliseconds
await __verifyTdm.hudCheck()     // 6 — the HUD against the systems behind it
await __verifyTdm.fixedRate()    // 9 — the match clock under CPU load
await __verifyTdm.matchCycle(3)  // 1, 7 — matches back to back, heap at each boundary
__verifyTdm.results              // everything measured so far, stashed
```

**The frame source is a `MessageChannel`, not a `setTimeout`.** M1's `framerate.js` uses a timer
because its whole point is to *pace* frames at a chosen interval. That is the wrong tool here:
Chrome clamps timers in a tab that is not visible, and the first run of this suite got 348 sim
ticks out of nineteen wall seconds — it was measuring the browser's throttling. A `MessagePort`
callback is a macrotask that is not clamped, so the loop runs as fast as the work allows and the
sim holds a measured 60.0 Hz.

Two notes on reading the output:

- **`snagSweep` defines a snag as failure to make progress**, not as being blocked. Sliding along a
  wall is blocked on every tick and is exactly what should happen, so each pass tracks how far it
  has advanced *along its run* and flags a window of 20 ticks that gained less than 0.15 m. Wall
  runs are driven from both sides and the side with no wall is discarded; a wall with no completed
  pass is reported as untested rather than passing by silence.
- **`clearanceAudit` is the data check `snagSweep` cannot be.** The sweep finds a pinch only if a
  run line happens to pass through one. The audit takes every standing collider's footprint and
  reports any pair separated on one axis by less than a capsule diameter while overlapping on the
  other — which is the whole bug class, found in one pass.

---

## Adding a panel

`DebugOverlay.section(title, column?)` returns a `DebugSection`.

```ts
const weapons = overlay.section('Weapons');
const fAmmo = weapons.addField('Ammo');
weapons.addNode(myCanvas);

// in your per-frame update:
fAmmo.el.textContent = `${mag} / ${reserve}`;
```

`addField` returns `{ el, last }`. Use the `set(field, text)` pattern from
`DebugOverlay.refreshText` — it skips the DOM write when the string has not changed,
which is what keeps 24 read-outs off the frame budget.

To hang a panel off the right-hand column, pass the column element, or append to
`section.element` yourself.

### Adding a tunable

Add the field to the config interface and to its `*_TUNABLES` metadata table. The
slider, the read-out formatting and the copy-to-clipboard output are all generated. No
overlay code changes.

### Adding collision debug geometry

`debug/CollisionDebug.ts` owns three preallocated `LineSegments` buffers and rewrites
them in place. Toggling it on must not change the allocation behaviour of the frame it
is measuring, so grow the existing buffers rather than creating geometry per frame.
`movementDebug` in `player/Movement.ts` is the capture hook: it is off by default and
costs one branch per collision pass when off.
