# OPERATOR — debug tooling

Everything here exists from M1 and every later milestone extends it rather than
building a second overlay.

---

## Keys

| Key | Effect |
|---|---|
| `F1` | *(unbound since M6)* — the overlay opens from the pause screen, and from round 4 only after `DEBUG666`. See "Cheat codes" below. |
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

---

## The M5 arsenal panels

### Keys

`Q` swaps primary/secondary, `1` and `2` select a slot outright, `G` throws the lethal
(hold to cook a frag), `F` throws the tactical, and `Shift` holds breath while scoped.
`Esc` now **pauses** instead of quitting — see below.

### `Arsenal` (left column)

The weapon picker is the first thing you need: twelve weapons exist and without it only one
is reachable. Two chip rows — slot, then weapon — then the five attachments. An attachment
the weapon has no slot for is drawn struck through rather than hidden, so "this gun cannot
take a foregrip" is visible rather than mysterious.

**Base against resolved** prints only the rows that changed. A forty-row table where two
rows moved hides the two rows.

**The pattern plot draws all twelve traces in one space**, active one in the accent colour,
on a shared scale. That is the only way to look at acceptance criterion 1 — "if two weapons
feel the same, one of them is wrong" is a claim about the *relationship* between the
patterns, and twelve separate plots cannot show it. The suite reports the same thing as a
number: the closest pair by RMS distance in degrees.

**The pellet plot** is drawn from a real measured shell, not from the cone's parameters:
press MEASURE PELLET SPREAD and it fires one through `ArsenalHarness` and colours every
pellet by the zone it actually found, against a chest-and-head silhouette and the cone bound
at that range.

**MEASURE BALANCE TABLE** runs the full 12 x 4 x 2 measurement (about 40 ms) and copies it
to the clipboard as the Markdown that goes into `docs/BALANCE.md`.

### `Equipment` (left column)

Four read-out lines — the flash's angle curve evaluated at 0/45/90/180 degrees, the smoke
field's query and rejection counts, the projectile pool, and the bot thrower's accept and
reject tallies — plus two visualisations:

- **Trajectory preview** draws where a throw would land, through the *real* integrator
  against the *real* collision world. It is the same `previewTrajectory` the bots' safety
  check calls, so the line and the grenade cannot disagree.
- **Smoke occlusion** draws every live sight line between opposing combatants, green when
  clear and red when the smoke field rejected it, with brightness carrying the accumulated
  optical depth — so a line that is *nearly* blocked looks different from one in clear air.
  Blue rings mark each cloud's current radius. This is acceptance criterion 6 as a picture.

The equipment picker also *equips* what you pick, because a preview of something you are not
holding is a diagram rather than a tool.

`Equipment` also adds a generated slider set to the right column, with the same COPY CONFIG
and RESET as every other config in the project.

---

## The arsenal harness

`debug/ArsenalHarness.ts` is to the *arsenal* what `WeaponHarness` is to one weapon. Real
`WeaponSystem`, real `Ballistics`, real `DamageSystem`, real `TargetDummy` wearing the shared
rig; no renderer, no audio, no DOM.

```js
__operator.arsenal()                          // the harness
__operator.balanceTable()                     // the TTK table as Markdown
__operator.arsenalReport()                    // TTK + attachment deltas + purity checks
__operator.attachmentDeltas()                 // what each attachment measurably costs
__operator.arsenal().measureTtk(def, 25, 'head')
__operator.arsenal().measurePelletSpread(def, 6)
__operator.arsenal().measureSlideEntry(def)   // one slide into a room
__operator.arsenal().measureSlideAggression(def, 30)  // the chained exploit
__operator.weapons                            // every WeaponDef
__operator.equipmentDefs                      // every EquipmentDef
__operator.equipment()                        // the live MatchEquipment
```

**`measureTtk` zeroes spread and recoil and does not zero the pellet cone.** A TTK table
answers "how fast can this kill", not "how likely is it to" — but a shotgun's spread *is* the
weapon, and its dash at 25 m is the honest result. See `docs/BALANCE.md`.

**`measureSlideAggression` is the criterion-8 instrument.** It runs the same adversarial
chain `Harness.measureMaxSustained` uses with a real weapon stepping alongside, and reports
`fireableFraction` — what proportion of a slide-cancel chain the weapon is actually up for.
It measures 0.000, which is the finding: a player moving at 7.9 m/s is a player who cannot
shoot.

### `verify/arsenal.js`

```js
fetch('/verify/arsenal.js').then(r => r.text()).then(eval)
await __verifyArsenal.all()        // every criterion, in order
__verifyArsenal.patterns()         // 1 — twelve patterns, and the closest pair by RMS
__verifyArsenal.voices()           // 1 — twelve voices, and the closest body-band pair
__verifyArsenal.balance()          // 2 — the TTK table
__verifyArsenal.purity()           // 3 — attachment resolution is pure
__verifyArsenal.attachments()      // 4 — measured attachment costs
__verifyArsenal.pellets()          // 5 — mixed head/torso pellet spread at four ranges
await __verifyArsenal.smoke()      // 6 — smoke blocks bot perception
__verifyArsenal.flash()            // 7 — flash magnitude by angle
__verifyArsenal.slide()            // 8 — the slide-cancel retune
await __verifyArsenal.frameTime()  // 9 — frame time with equipment live
await __verifyArsenal.botAim()     // 8 — hit rates at the tuned ceiling
__verifyArsenal.results            // everything measured so far, stashed
```

**Run `smoke()` a few seconds into a match.** It searches the roster for an enemy pair that
can currently see each other and puts a cloud on the midpoint; immediately after the match
builds, nobody has line of sight to anybody yet and it correctly reports that it found no
pair to test.

**`frameTime` is a deliberate over-load**: three grenades every 0.9 s on top of a live
ten-bot firefight, which fills the smoke pool and is far more than ordinary play produces.
Read `equipmentMs`, `peakModeMs` and `peakHudMs` rather than the frame percentiles — the
percentiles under a substituted frame source are mostly the source (see PLAN.md).

---

## The pause state

`Esc` enters `PAUSED` rather than quitting the match. The world stays built, `Game.simulate`
returns early, and the render pass keeps running so the screen is composited over a live
scene and `FrameStats` keeps sampling. `Esc` again resumes.

**The debug overlay is a read-out while the cursor is captured and a control panel when it
is not.** `body.op-locked .dbg-root { pointer-events: none }` — M4 playtesting reported that
opening F1 mid-match "breaks pointer lock"; it was not the key, it was that a click (which is
also the fire button) could land on a slider and give it DOM focus, at which point
`Input.domFocusGuard` correctly stops feeding the game keys. Paused, the cursor is free and
every control works, which is why the pause menu has a button for the overlay.

### Pointer lock, after the M5 hotfix

```js
__operator.pointer()   // { locked, armed, keyboardCapture }
```

`armed` is the thing worth knowing. A bare `requestPointerLock` only succeeds from a user
gesture, and Chrome additionally refuses one for a short window after the user has left the
lock with Escape — so resuming from the pause screen could not rely on it. While a match is
live the input layer is *armed*: any click re-acquires the lock, and that click is consumed
rather than passed on, so it cannot also fire the weapon. Armed in MATCH, disarmed in PAUSED
(where a click belongs to the buttons) and in MENU.

If `locked` is false while `armed` is true and clicking does nothing, the platform is
refusing pointer lock outright — the embedded Browser pane does, because the canvas lives in
a nested document (`WrongDocumentError`). The warning is throttled to once per arming.

---

## The M6 progression panels

### Keys

`X` activates the loadout's field upgrade once its charge is full.

**`F1` no longer opens the overlay.** From the M5 playtest notes: the overlay is a large
interactive panel and opening it under the crosshair put focus-stealing controls in the
middle of a firefight. It is now reached from **the pause menu's DEBUG OVERLAY button**, it
has an **× in its own header**, and **Esc closes it** rather than falling through to
"resume" — pressing Esc with the panel open used to throw you back into the fight.

`F2` (collision) and `F3` (reset stats) are unchanged: they toggle *drawing* rather than
opening a panel, and neither takes DOM focus. `F1` is still `preventDefault`ed so Chrome's
own help does not open over the game.

### `Progression` (left column)

Level and XP into it, what the current match has accrued and is worth so far, the save
write count and whether the store is persistent, the held weapon's per-weapon stats, the
active perks, the field upgrade's charge, the Scavenger and Tracker counters, and
`Meta ms` — wall time inside `MatchMeta.simulate`, which is the number acceptance
criterion 9 is really about.

### `Perk & attachment modifiers` (left column)

S7's "base value → resolved value per stat". The base is re-resolved through
`resolveWeaponDef` with an *empty* modifier list rather than read out of the registry, so
both sides of every comparison have been through the same clone and the same code path —
**a difference in this table can only have come from a modifier.** Rows that did not move
are not drawn.

The perks a weapon field cannot express get their own rows underneath, compared against the
neutrals in `NO_PERKS`: movement multiplier, footstep audibility, flash resistance, and the
three that S9 leaves inert (Ghost, Cold-Blooded, Hardline), each labelled as such.

### `Challenges` (left column)

The ten challenges closest to completion, sorted by fraction, then the completed count and
the camos owned. Thirty rows nobody can scan is the same as no rows.

### `EventBus tap` (left column)

Every event type that fired this match, by count, busiest first. It exists because
"challenge progress is driven off the EventBus, not by polling" is a claim about plumbing,
and the way to check plumbing is to watch what actually came down it.

### `XP simulator` (right column)

S7's pacing instrument. Three preset run lengths plus **TO LEVEL 55 FROM HERE**, which
starts from the live profile's XP. It prints the per-source breakdown of one average match,
then one line per level with the match number, the hours at ten minutes a match, and what
that level unlocked.

It is deliberately **not** a Monte Carlo: a simulated match is a fixed set of counts pushed
through the same `XP_SOURCES` table `MatchProgression` uses, so the answer is exact for the
performance you describe. Variance would hide the thing the panel exists to show, which is
whether the *curve* is right.

### `Save inspector` (right column)

S7's four asks, as four groups of buttons.

- **REFRESH / APPLY / COPY** — the raw save as editable JSON. APPLY runs the text through
  the same `normaliseSave` a real load uses, so hand-editing it exercises the repair path
  rather than going around it.
- **FORCE MIGRATION (V0)** — pushes `makeSyntheticV0Save()` through the real `migrateSave`
  and prints what survived, without touching the live profile. Acceptance criterion 7 as a
  button, run against the *current* migration every time it is pressed.
- **WRITE V0 AND RELOAD** — writes the V0 payload over the real key so the next page load
  migrates it at boot. Different from the button above: this exercises the path
  `SaveStore`'s constructor takes, version check included.
- **RESET PROGRESS**, **+10,000 / +100,000 XP**, **PRESTIGE** — the levers for reaching a
  state without playing to it.

---

## The M6 console API

```js
__operator.profile                     // the Profile. Process-wide, unlike the match handles
__operator.save()                      // the live SaveV1 document
__operator.unlocks()                   // the UnlockState snapshot
__operator.loadouts()                  // all five slots
__operator.resolveLoadout(unrestricted?)  // the same call Game.buildWorld makes
__operator.perks / .challenges / .camos / .fieldUpgrades / .levelTable
__operator.perkState()                 // the live match's resolved PerkState
__operator.perkResolve(def, ids)       // a def with perks applied, through the real resolver
__operator.perkStateOf(ids)            // a PerkState without equipping anything
__operator.challengeProgress()         // every challenge with its definition and counter
__operator.progression()               // the live MatchProgression
__operator.simulateXp(n, startXp?)     // fast-forward n matches, printed
__operator.testMigration()             // V0 -> V1 without touching the save
__operator.syntheticV0()               // the hand-written V0 payload
__operator.inspectSave(raw)            // { save, losses } — repair without importing
__operator.sanitise(slot, level, out)  // force a loadout legal at a level
__operator.saveWrites()                // { writes, lastWriteMs, persistent }
__operator.bus                         // the EventBus, for driving a real event
```

**`saveWrites().writes` is what acceptance criterion 8 is read from.** It counts writes at
the point they happen rather than the calls that might have caused one, so a coalesced
burst is one write. A full match is **one** write; the page load is another.

---

## `verify/progression.js`

```js
fetch('/verify/progression.js').then(r => r.text()).then(eval)
await __verifyProgression.all()      // every criterion, in order
__verifyProgression.resolution()     // 3 — editor and gameplay share one resolver
__verifyProgression.perks()          // 4 — all twelve, measured
await __verifyProgression.deadSilence()  // 4 — against the real noise field
__verifyProgression.unlockGate()     // 5 — a hand-edited save cannot equip a locked weapon
__verifyProgression.migration()      // 7 — V0 -> V1, then a corrupted field
__verifyProgression.writes()         // 8 — write frequency
__verifyProgression.live()           // 1, 6 — what a live match has accrued
__verifyProgression.pacing()         // S7 — the curve
__verifyProgression.results          // everything measured so far, stashed
```

**Run the perk and challenge sections a few seconds into a match.** Several of them need a
live world and report "needs a live match" rather than passing by silence.

**`unlockGate` needs a *locked* weapon to exist**, so it refuses to run on a high-level
profile and says so. Reset progress first, or run it on a fresh save.

`resolution()` leaves the profile as it found it: it grants the foregrip, fits it, measures,
and removes it again.

---

# M8 — the hand-over tools, and the index

M8 adds no second overlay and no second console object. What it adds is the four
measurements the human runs on hardware this build has never seen, one wall sweep, and this
index — because seven milestones of tooling documented in seven places is tooling nobody
finds.

## The index

Everything, in one table. The detail is in the sections above and below.

| Tool | How to reach it | Answers |
|---|---|---|
| Debug overlay | `F1` in a match | Frame time, player state, weapon state, AI budget, mode, streaks |
| Collision visualiser | `F2` | Is the capsule where I think it is; which hash cells are queried |
| AI visualiser | `F4` | Navmesh, paths, sight lines, cover occupancy, spawn scores |
| Tuning sliders | `F1`, right column | Every feel constant, live; **COPY CONFIG** writes it back as source |
| Movement harness | `__operator.report()` | Speeds, slide timings, the speed bound — headless |
| Weapon harness | `__operator.weaponReport()` | Fire timing, recoil determinism, damage, penetration |
| Arsenal harness | `__operator.balanceTable()` | TTK across all twelve weapons; attachment deltas |
| Bot harness | `?harness=botmatch` | An AFK bot match, at up to 32x speed |
| Match harness | `__operator.runMatches(n)` | Does a build-and-teardown cycle leak |
| Lane report | `__operator.laneReport()` | Are this map's lanes within 15% of each other |
| **Snag sweep** | `__operator.snagSweep()` | **Sprint every wall on this map** |
| **Frame export** | `__operator.frameReport()` | p50/p95/p99/worst, plus the whole buffer, as JSON |
| **Latency export** | `__operator.latencyReport()` | Input latency in ms and in frames |
| **Render sweep** | `__operator.renderSweep()` | Which render scale fits this machine |
| **Allocation probe** | `__operator.allocationProbe()` | Does the per-tick sim path allocate |
| Save inspector | `F1`, right column | Migration, repair, what a bad save costs you |

## URL flags

All of them compose.

| Flag | Default | Effect |
|---|---|---|
| `?harness=botmatch` | — | Boot straight into an AFK bot match. Required for the rest. |
| `&bots=N` | 10 | Total bots across both sides, 2-32. |
| `&speed=N` | 1 | Sim seconds per wall second, 1-32. Adds whole 1/60 s ticks; never changes `dt`. |
| `&tier=NAME` | MIX | `RECRUIT`, `REGULAR`, `HARDENED`, `VETERAN`, or the default spread. |
| `&map=ID` | menu | `mp_foundry`, `mp_dunes`, `mp_depot`, `mp_greybox`. |
| `&mode=ID` | menu | `TDM`, `DOM`, `KC`, `FFA`, `SND`, `RANGE`. |
| `&matches=N` | 1 | **M8.** Above 1, hands the run to the match harness: N matches back to back, heap logged at every boundary. |

Ten matches of Depot Domination with ten bots, as fast as the harness will go:

```
http://127.0.0.1:5173/?harness=botmatch&map=mp_depot&mode=DOM&bots=10&speed=32&matches=10
```

## The export envelope

Every M8 tool returns the same wrapper:

```json
{
  "tool": "frame-histogram",
  "at": "2026-08-02T...",
  "context": {
    "map": "mp_depot", "mode": "DOMINATION", "state": "MATCH", "bots": 9,
    "renderScale": 1, "shadowQuality": "medium", "motionBlur": false,
    "pixelRatio": 1.25, "viewport": "1920x1080", "cores": 8, "userAgent": "..."
  },
  "...": "payload"
}
```

The context block is the part that makes an export worth keeping. "p99 was 31 ms" is
indistinguishable from noise unless it also says what it was 31 ms *of* — which map, how
many bots, at what render scale, on what machine.

`__operator.copyReport(report)` puts any of them on the clipboard as JSON.

---

## Worked example 1 — "is the AI over budget?"

S4.7 gives all game logic 3.0 ms a frame. The AI is the part most likely to spend it.

1. Boot a heavy bot match: `?harness=botmatch&map=mp_depot&bots=10&speed=1`.
2. `F1`, and read the **AI** section: `decide`, `steer`, `perception` and `path` in
   milliseconds, plus nodes expanded and deferred requests.
3. Leave it a minute, then `__operator.frameReport()`.

Read `peaks.mode` and the AI figures against 3.0 ms. If `deferredRequests` is climbing and
`budgetExhaustedTicks` is non-zero, the pathfinder is the problem and `ai/AiScheduler.ts`
owns the budget. If `decide` is the cost, it is running too often — the interval is in the
same file.

**What this looks like when it is fine:** on this build, Depot with nine bots, AI mean
0.03-0.05 ms and `peakModeMs` around 0.3 ms.

**What it looked like when it was not:** M3 measured AI mean climbing from 0.39 to 1.30 ms
across a ten-minute soak. The AI was innocent — an uncapped audio voice pool was allocating
node graphs *inside* the sim tick from a `weapon.fired` handler. The lesson is that this
read-out tells you where the time went, not whose fault it is; check `Pools` in the same
overlay before believing the label.

## Worked example 2 — "did the last match leak?"

1. `await __operator.runMatches(3)` — or use `&matches=3`, which is the same code.
2. Read the boundary table it prints.

Each row is a settled heap sample: the harness provokes a collection and waits before
reading, because `usedJSHeapSize` immediately after a teardown is mostly garbage nobody has
collected yet.

**A flat or falling `heapDeltaMB` is the answer you want.** A *monotonic* rise across every
boundary is a leak, and the place to look is `MatchWorld.dispose` — it is written as the
exact mirror of its own constructor precisely so that a missing line is visible by reading
the two halves next to each other.

**What this looks like when it is fine:** M7 measured 29.0 -> 32.9 -> 38.0 -> 34.8 MB across
three modes; the third boundary *fell*, so nothing was retained.

## Worked example 3 — "does the sim path allocate?"

S4.7 asks for zero allocations in the per-tick sim path.

```js
await __operator.allocationProbe()
```

It stops the loop, warms up 5,000 ticks, then runs 300,000 ticks — eighty-three minutes of
simulated play — sampling the heap ten times, and does the same for an empty control loop.

**Read the control first.** It must be exactly flat. If it is not, the machine is doing
something else and the run means nothing.

**Then read the shape of `simSeriesMB`.** Flat is no allocation. A sawtooth that returns to
where it started is garbage being made and collected at the same rate. A staircase that
never comes down is a leak.

**Why the tool works this way:** the obvious implementation — read `usedJSHeapSize` before
and after — does not work. Chrome updates that counter in very coarse steps; a calibration
on this build showed **no movement at all** for 300,000 small objects allocated in a row,
then a 49 MB jump. A naive before/after therefore reports a confident zero for a path that
allocates. Anything the probe reports under about 4 bytes/tick is below the floor and should
be read as "under the resolution of the instrument", not as zero.

**For a per-call-site answer**, the counter is not enough and DevTools is: Performance panel
-> tick *Memory* -> record ten seconds of a live match -> open the *JS Heap* track, or use
Memory -> *Allocation instrumentation on timeline*, which attributes every surviving
allocation to a stack.

## Worked example 4 — "which render scale should this machine use?"

Start a match on the heaviest thing available — Depot, ten bots — and:

```js
const sweep = await __operator.renderSweep()
```

Six four-second holds at 1.0 down to 0.5, percentiles at each, and the setting restored to
whatever it was. `backingPixels` is the number that actually drives fill cost, and it is the
column to plot against.

Look for the knee. If p99 barely moves between 1.0 and 0.7, the machine is CPU-bound and
render scale is the wrong lever — check `peaks.mode` and the AI section instead.

## Worked example 5 — "is there anywhere on this map you get stuck?"

```js
__operator.snagSweep()
```

`debug/SnagHarness.ts` derives its run lines from the collision world rather than from a
list somebody typed: every world-axis-aligned collider tall enough to block a player
contributes one pass per vertical face, offset by the capsule radius, driven both ways with
sprint held. A wall that exists is a wall that gets swept, and a container that moved during
tuning moves its own run line with it.

Three numbers matter in the output:

- **`intersectingTicks` must be zero.** Anything else is the capsule inside geometry, which
  is a hard bug.
- **`findings`** are places the player stopped making progress *with open space ahead* —
  caught on a lip, wedged in a slot. Each names the collider and face so it can be walked to.
- **`deadEnds`** are places the player stopped with a wall in front. Ordinary geometry, not a
  fault. Reported so that a sweep which found nothing cannot be confused with one that ran
  nothing.

On this build: Foundry 142 passes, Dunes 260, Depot 192 — zero findings and zero
intersecting ticks on all three.

---

## M8 panels and settings

There is no new debug panel. The settings screen is a *player* surface, not a debug one, but
three of its controls are useful while measuring:

- **Render scale** — the same lever `renderSweep` walks, if you want to sit at one value.
- **Shadow quality** — `off` disables the shadow map outright, which is the quickest way to
  find out whether the depth pass is your problem.
- **FPS counter** — a 4 Hz read-out that survives leaving a match, unlike the overlay.

`__operator.settings()` returns the live record and `__operator.applySettings(patch)` applies
one the same way the screen does, so a script can change a setting and assert what moved.
`__operator.palette()` returns the live gameplay colours, which is how the colourblind
acceptance check is made rather than asserted.

## The navmesh read-outs M8 added

`F4` and the AI panel gained three numbers, all of them about Depot:

- **`layers`** — walkable surfaces per column. Two on Foundry and Dunes, three on Depot.
- **`climbLinks`** — of the total links, how many are mantles rather than walks. Zero on
  every map that does not set `navClimb`.
- **`coverage`** — walkable nodes as a fraction of the columns inside `navBounds`. A large
  drop between two builds of the same map means geometry has closed something off.

---

# Post-M8 — the QA spectator

The tool the polish pass added, and the one to reach for when the question is *"what are the
bots actually doing?"* rather than *"how fast is this frame?"*.

## Three switches, not one mode

F1 → **Spectator (QA)**, or `__operator.spectate.*` from the console. They are independent on
purpose, because they answer different questions:

| Switch | Code | What it does | The question it answers |
|---|---|---|---|
| **God mode** | `SPEC[]1` | `Damageable.invulnerable`, tested inside `DamageSystem.apply` | *How long does a VETERAN take to notice me, and how hard does it hit?* Stand in the open with a stopwatch. |
| **Invisible** | `SPEC[]2` | `Combatant.participating = false` | *What does this firefight look like when I am not in it?* Removes you from perception, bot target selection **and** spawn scoring. |
| **Free-cam** | `SPEC[]3` | `PlayerController.noclip` | *Where exactly is this collider seam / spawn cluster / navmesh hole?* |
| **All three** | `SPEC[]4` | the set | *Watch a whole round from inside it.* |

**From playtest round 4 these are cheat entitlements, and the server decides.** Against a
dedicated server they need `CHEATS_ENABLED=1` in the environment; without it every request is
refused and you are told so. Nothing changes offline, where this process is the authority and
always was. The panel's checkboxes are redrawn from the live entitlement rather than from your
click, so a refused switch simply springs back.

**Invisibility no longer turns god mode on with it.** It did until round 4, for a good reason —
a grenade, a mortar or a sentry burst already in the air does not know that nobody is aiming at
you, and dying mid-observation drops you into a respawn timer in the middle of the thing you
were watching. That reason is now served by `SPEC[]4` instead. Coupled, the two entitlements
were indistinguishable, and no measurement could tell perception from invulnerability — which is
exactly what F14's verification had to do.

**God mode is not "regenerate very fast".** The check is at the damage door, before anything
is subtracted, so you take no damage *events* either — no flinch, no hurt vignette, no
directional indicator, no low-health muffle. That is the difference between a mode you can
observe through and one that is strobing at you.

## Free-cam controls

| Input | Effect |
|---|---|
| `WASD` | Fly along your look direction, pitch included |
| `Space` | Straight up, 10 m/s |
| Crouch | Straight down |
| Sprint | ×4 — crossing Dunes |
| ADS | ×¼ — easing up to a seam |

Leaving free-cam drops you where you were floating and hands you back to gravity and
collision. That is deliberate: teleporting you back to the take-off point would hide the case
where the geometry you flew out to inspect is geometry you cannot get out of.

## Console

```js
__operator.spectate.all(true)        // all three; the common case
__operator.spectate.god(true)        // just invulnerability
__operator.spectate.invisible(true)  // implies god
__operator.spectate.noclip(true)     // just the free-cam
__operator.spectate.off()            // everything back
__operator.spectate.state()          // "god · unseen · noclip", or "off"
```

Each returns the state line, so a console session reads back what it just did. Reachable
without the overlay on purpose — the overlay is a large modal panel, and half the reason to
spectate is to *watch the screen*.

## What it does not do

- **It is not a free-flying camera detached from the player.** It is the player, flying. The
  audio listener, the minimap and the viewmodel all follow you, because they read `sim` and
  `sim` is still being written every tick.
- **It does not pause anything.** The match runs, the clock runs, the mode can still end.
- **It leaves no trace.** Every switch writes through to the object that owns the behaviour,
  and those are re-applied from state every tick (`Match.syncChopperBody` is the one to read).
  There is no undo path to maintain — turn it off and the match is exactly as it was.
- **In Search & Destroy, being invisible makes you non-participating**, so the round will
  count you as eliminated. That is correct — you are spectating — but it means you cannot
  observe a full S&D round from the attacking side without ending it. True on the server too
  since round 4, where `SearchAndDestroy.anyAlive` is what reads it.
- **It does not hide your body from other players.** Invisible means nothing *looks* for you:
  perception, target selection and spawn scoring. The mesh is still in everybody's snapshot, and
  deliberately — removing an entity to hide a player is the mistake Ghost's implementation
  records, and here it would additionally desync who can be shot from what the server resolves
  rounds against.
- **Free cam costs one snapshot interval of prediction on each toggle** over a network. The
  server flies the body from the replicated entitlement and the client learns of it up to 50 ms
  later, so collision disagrees for a few ticks and prediction corrects. It happens on the toggle
  and nowhere else.

---

# Playtest round 4 — cheat codes (F14)

Typed into the **code field on the pause screen**, which is the only input this feature has.
A text field rather than a key sequence on purpose: `DEBUG666` shares D, E, B, U and G with
movement and Use, and `SPEC[]n`'s brackets are not keystrokes on a keyboard that does not have
them. Type the literal text, brackets included. Case does not matter.

| Code | Effect | Who decides |
|---|---|---|
| `DEBUG666` | Unlocks the debug overlay, and puts it up. The pause screen's **Debug overlay** button appears with it. | The client. It is a client surface and no simulation reads it, so it works offline and against any server. |
| `SPEC[]1` | God mode | The server, and only with `CHEATS_ENABLED=1` |
| `SPEC[]2` | Invisible | " |
| `SPEC[]3` | Free cam | " |
| `SPEC[]4` | All three | " |
| `MO951357` | +30 kills to the killstreak balance, **not** to the scoreboard | " |

## Toggles and instants, which behave differently on purpose

Every code declares a `CheatKind`, and the HUD renders by it:

- **Toggles** — `DEBUG666` and the four `SPEC[]n` — are states you are *in*. Typing one again
  clears it. `SPEC[]4` completes the set unless the whole set is already on, in which case it
  clears all of it; that is the same rule the spectator panel's headline button has always used
  and is now literally the same function.
- **Instants** — `MO951357` — are transactions. They cannot be "on", so there is nothing to type
  again to undo; typing it twice pays twice. The HUD *announces* one for **4 seconds**
  (`CHEAT_NOTICE_SECONDS`) and then stops, and the announcement joins any standing toggle tag
  rather than replacing it: `CHEATS · GOD · +30 KILLS` becomes `CHEATS · GOD`.

## Lifetimes — a cheat does not follow you into the next match

| Entitlement | Lifetime |
|---|---|
| `DEBUG666` | **the session.** Survives a migration and a map rotation, exactly as the overlay's own open/closed request does. |
| `SPEC[]1` – `SPEC[]4` | **the seat.** `MatchInstance.unseat` clears them, so being migrated from the arena into a match — or dropping out — ends them. Type them again in the match you want them in. |
| `MO951357` | the payment lands and is over. What it pays *into* is a killstreak balance, which belongs to a life and is forgotten when you leave an instance. |

That is a fix rather than a design: F14 shipped with all of them held for the life of the
connection, so a code typed in the arena took effect in the match the ballot sent you to — and
god mode in the arena does nothing at all, so nobody would have noticed until they were
invulnerable somewhere it mattered.

`MO951357` pays into the balance through `StreakSystem.creditKills`, the door round 4's B9
built for exactly this: the balance is *credited from* `PlayerScore.kills` rather than read out
of it, so unearned kills buy streaks and never appear in the match results.

**A cheat that is on says so.** A tag reads `CHEATS · GOD · UNSEEN · …` at the bottom of the
HUD for as long as a toggle is on, and the server logs every grant, revoke and refusal with the
player and the resulting entitlements. `DEBUG666` is deliberately not on the tag: having the
overlay unlocked says nothing about the simulation, and a warning that is up for most of a
developer's session stops being one.

An **instant** leaves no tag behind it, because there is no state for one to describe — its
durable record is the server's log line and `StreakEconomyReport.credited`, which is where a
transaction's record belongs. F14 gave the wallet payment a latched bit instead and the tag
outlived the balance it was describing.

**Nothing is applied optimistically.** A code goes to the server and the entitlement arrives
back replicated, in the owner block of every snapshot — state rather than an edge, so a dropped
frame cannot leave the two sides disagreeing about whether a wall stops you.

## Melee, for reference

Post-M8 also added the knife (`V`). It has no panel, but the swing is on the bus as
`weapon.meleeSwing` with `{ sourceId, x, y, z, hit, lethal }`, which is enough to tap:

```js
__operator.game.bus.on('weapon.meleeSwing', (p) => console.log(p));
```

A swing that reports `hit: false` at the full 2 m reach found no target; one that reports
`hit: false` at a shorter range was blocked by world geometry between the eye and the target.

Round 2 gave it a blade (`weapons/KnifeMesh.ts`). The state machine and the event are
unchanged; what changed is that the rifle is hidden for the duration and the knife is posed
from `Melee.fraction` by `ViewmodelAnim.poseKnife`. The strike keyframe is pinned to `0.222`,
which is `WINDUP_SECONDS / (WINDUP_SECONDS + RECOVER_SECONDS)` — if either timing is retuned,
that constant has to move with it or the blade will be somewhere other than extended on the
frame the hitbox test runs.

---

# Post-M8, round 2 — what is newly observable

**The Chopper Gunner's belt.** `describe()` on the streak now carries it, and the HUD shows it
through the ordinary ammunition readout with an infinity glyph in the reserve slot:

```js
__operator.match().streaks.activeChopperFor(0)   // .mag, .magSize, .reloading, .reloadFraction
```

**Where the S&D bomb starts.** Authored per map rather than derived, so it can be read without
a live match:

```js
__operator.game.world.map.def.objectives.filter((o) => o.kind === 'bombspawn')
```

**Whether the depth buffer is actually 24-bit.** The z-fighting fix depends on it, and it is a
driver decision rather than ours — worth checking on any machine that still reports flicker:

```js
const gl = document.querySelector('canvas').getContext('webgl2');
({ depth: gl.getParameter(gl.DEPTH_BITS), stencil: gl.getParameter(gl.STENCIL_BITS) })
```

24 and 8 is what the build asks for. A 16 there means the driver refused, and trim lips will
fight at range no matter what the maps do.

---

# M11 — the skirmish flow

Five new instruments, and the four questions they exist to answer.

| Tool | Where | Answers |
|---|---|---|
| **Skirmish panel** | F1 overlay, right column | What phase is the vote in? Which instance am I in? Did that migration cost me anything? |
| **Divergence checker** | `MatchWorld.divergence`, always on | Does my score agree with the server's? |
| **Flow harness** | `npm run skirmish` | Does the whole flow work, unattended, under any network condition? |
| **Leak harness** | `npm run leak` | Did allocating and destroying N matches leave anything behind? |
| **Boot report** | Server log, first three lines | What did the map pre-bake cost, in time and memory? |

---

## "Why did a player stall on transition?"

The transition is: map vote resolves → `Prepare` goes out → clients build in the background →
every client reports `Ready` (or the timeout fires) → everybody migrates on one named tick.

Read it in that order and the first thing missing is the cause.

```bash
grep -E "sent Prepare|ready for match|ready timeout|started on tick" server.log
```

A healthy cycle:

```
allocated match 1: SND on mp_dunes for 3 human(s).
sent Prepare for match 1 (mp_dunes) to 3 client(s).
OP1 ready for match 1 after 412ms of background build.
OP2 ready for match 1 after 455ms of background build.
OP3 ready for match 1 after 1170ms of background build.
match 1 started on tick 2640 with 3 human(s) migrated.
```

**No `sent Prepare` line at all.** Allocation failed. Look for `allocation failed (capacity|
failure)` immediately above it, and for a `Notice` reaching the players — §4.17 requires every
one of them to stay in the arena with a message.

**`sent Prepare` but no `ready for match`, then `ready timeout`.** The client never finished
building. Three causes, in order of likelihood:

1. **The tab was in the background.** `requestAnimationFrame` is throttled to near-zero, and the
   build is pumped from the render pass, so it makes no progress. Working as designed: §4.18
   migrates them anyway and they get the loading screen.
2. **The `Prepare` never arrived.** Check the client console for `[netclient] prepare: match N on
   mapId`. Absent means it was lost or never encoded — this is the failure mode the shared-writer
   bug produced, and the fix was to give each session its own `ByteWriter`. If it recurs, look for
   a new send path that encodes into a shared buffer.
3. **The machine is genuinely slow.** The skirmish panel's *Last build* row gives the real
   number. `READY_TIMEOUT_MS` is the knob.

**A client that timed out and then never caught up.** The loading screen should be up. If the
world is frozen with no screen, the deferral in `Game.servicePendingTransitions` did not run —
the screen must paint *before* the blocking build, which is what `loadingHeldFrames` buys.

---

## "Why did the tally disagree?"

It cannot, structurally: there is exactly one tally in the codebase (`VoteCycle.votes`, keyed by
player id) and the client renders a broadcast of it. So a disagreement is one of three things.

**A vote that did not count.** The server logs every rejection:

```
OP2 voted 3 in phase 2; the server is in phase 3 — rejected.
```

That is a vote arriving after its window closed, which is ordinary on a real link. The tally not
moving is the client's feedback.

**A tie or an empty ballot resolved "wrongly".** It was resolved randomly, and the draw is
reconstructible rather than arguable:

```
map vote: no votes cast — broke randomly to option 1. seed=1 draw=1 candidates=[0,1,2]
```

Re-seed an `Rng` with `seed`, advance it `draw` times, and `int(0, candidates.length)` gives the
same index. The structured form is on the `vote/randomPick` metric with the same fields.

**Two clients showing different countdowns.** They cannot be showing different *numbers* from the
same broadcast — the countdown is `(phaseEndsTick - clientTick) * DT` against the synced server
clock. A difference means one client's clock sync is off; check the net panel's *Clock offset*
and *Server / client tick* rows, not the vote panel.

---

## "Why did that hit not register?" — the M11 additions

M10's answer still applies (rewind, interpolation delay, the 200 ms cap). What M11 adds is that
**there are now two worlds**, and a shot resolved in the wrong one hits nothing.

Check the skirmish panel's *This client* row against the server's instance metrics. If the client
says `live match 1` and the server has the player seated in instance 0, the migration half-failed
— read the migration log:

```bash
grep -E "migration" server.log | tail -20
```

Every move logs its tick and duration. A `failed` line names the reason; §4.18 requires the
player to be left where they were, never dropped.

---

## "Did the server leak overnight?"

Two numbers, and the second is the one to trust.

```bash
npm run leak            # 100 allocate/destroy cycles
```

```
leak baseline: heap 11.61 MiB, 21 live subscriptions.
cycle 100: heap 12.25 MiB, 21 subscriptions.
LEAK CHECK PASSED.
```

**`EventBus.liveSubscriptions` is the leading indicator and must be exactly flat.** It is a
process-wide count, incremented by `on` and decremented by `off` and `clear`, so it measures
whether `dispose()` mirrors its constructor — not whether the garbage collector got round to the
bus. A per-bus count would read zero for a bus that was leaked whole, which is precisely the case
worth catching. At one leaked subscription per cycle, a twelve-hour soak ends with ~700 dead
listeners on a bus every gameplay event walks.

Heap is allowed a small margin because it is not a count: the collector's timing, the harness's
own metric arrays and V8's growth all move it. Run with `--expose-gc` or the series is dominated
by collection timing.

---

## The flow harness

```bash
npm run skirmish                          # 3 clients, 2 cycles, shipped timings
npm run skirmish -- --cycles 5 --net bad  # under 100ms +/-30ms, 2% loss
npm run skirmish -- --fault capacity      # latency | failure | capacity
npm run skirmish -- --slow-client         # one client that misses the ready timeout
npm run skirmish -- --no-perks            # the control run for the misprediction probe
```

The gate it enforces is **mispredictions in the 60 ticks after migrating into a live match**, and
it must be zero. That is §8.9's regression test for Tier 1 #20.

**The arena-return window is reported next to it and not folded into it.** They are different
claims: entering a match is where the loadout is locked and where a movement perk could diverge;
returning is the same machinery run backwards into a world that was already running. Summing them
would let a real regression hide behind a residual that was never zero.

### Shortening the timings is a documented hazard

```bash
PLAY_SECONDS=6 MODE_VOTE_SECONDS=4 MAP_VOTE_SECONDS=4 npm run skirmish
```

Every run that uses a shortened cycle says so in its first line and in its JSON
(`shortenedTimings: true`). Handover Tier 2 §C: *"A harness that shortens a timer to go faster can
shorten past the bug it exists to find."* The M11 case was a 6 s countdown reaching a match inside
a 10 s session timeout every time, so the 30 s case that broke never ran. **Always do at least one
pass at the shipped values before making a timing claim.**

### `--no-perks` is the control, and it matters

The misprediction probe can only mean something if it can fail. The harness fields a class
carrying Lightweight and applies `speedScale` on its own controller, exactly as
`MatchMeta.applyPerkHooks` does in the browser — so if the server has not been told about the
perk, the two sides disagree by 7% on every tick and the number goes red. Comment out the
assignment in `NetPlayer` and watch it go red before believing it green.

---

## The divergence checker

Runs on every applied snapshot whether or not the overlay is open, and reports on the skirmish
panel's *Divergence* row and in the console:

```
DIVERGENCE on tick 4213: scoreA — client says 14, server says 15.
Confirmed across 4 consecutive snapshots.
```

**It compares two independent paths**: the score this client derived from replicated kill events
through its own `ScoreSystem`, against the score stated in the snapshot header. Comparing the
client's `MatchFlow` against the header instead would be comparing a value with itself — the flow
is *assigned from* that header — and could never fail.

A mismatch means a replicated event was dropped, counted twice, or credited to the wrong side.
§8.21 makes any mismatch a blocking bug.

**Single disagreeing samples are not reported.** A client's copy is always one snapshot stale, so
a discrete field must disagree across four consecutive snapshots before it counts, and `timeLeft`
is compared with a 1.5 s tolerance. Without that this fires on every kill, and a check that cries
wolf teaches its reader to ignore it.

---

## The boot report

First three lines of the server log, every start:

```
FOUNDRY: collision 1.2ms, navmesh 42.9ms, 0.37 MiB resident.
DUNES:   collision 0.4ms, navmesh 20.4ms, 0.59 MiB resident.
DEPOT:   collision 0.4ms, navmesh 21.3ms, 0.71 MiB resident.
TESTBED: collision 0.2ms, navmesh  6.4ms, 0.24 MiB resident.
baked 4 maps in 93.9ms — 1.90 MiB of geometry and navmesh, heap +0.55 MiB, RSS 69 MiB.
```

Four maps, not three: the warmup arena is the greybox room and it is baked here too, so its cost
is in the report rather than hidden in a constructor.

If this number ever climbs into the seconds, something has started baking on demand — §4.19
forbids it, because a lazy bake is a stall in the middle of the transition §6.5 exists to make
seamless. The structured form is on the `bakery/boot` metric.
