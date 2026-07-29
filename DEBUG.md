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
| `Esc` | Release pointer lock (drops back to the menu) |

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
