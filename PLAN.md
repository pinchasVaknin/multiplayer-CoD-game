# OPERATOR — PLAN

Browser arena FPS, eight milestones. This file is the running record of what exists,
what was decided, and what the next milestone needs to know.

---

## Milestone status

| # | Milestone | State |
|---|---|---|
| 1 | Core loop and movement | **Complete** — see below |
| 2 | Weapons and shooting | Not started |
| 3 | Bots | Not started |
| 4 | Maps | Not started |
| 5 | Game modes | Not started |
| 6 | Progression and loadouts | Not started |
| 7 | Killstreaks and perks | Not started |
| 8 | UI, settings, polish | Not started |

---

# Milestone 1 — Core Loop and Movement

## What was built

**Core (`src/core/`)**
`Loop` (60 Hz accumulator, 5-step cap, interpolation alpha, frame-stats hook),
`EventBus` (typed, zero-allocation dispatch, re-entrancy safe), `Events` (the event map
and `EV` name constants), `Input` (the only DOM listener in the project; render-rate
view integration, pointer lock, command sampling), `InputCommand` (the S4.2 interface
plus a reused ring so the per-tick path allocates nothing), `ObjectPool`, `Rng`
(xorshift128, seeded), `SaveStore` (versioned localStorage with a migration hook and an
in-memory fallback), `Transport` (`INetworkTransport` + `LocalBotTransport`), `MathUtil`.

**Engine (`src/engine/`)**
`Renderer` (two-pass world + viewmodel, capped pixel ratio, ACES tone mapping, shadow
setup), `CameraRig` (interpolated position, FOV kick, bob, landing dip, roll, additive
shake), `ProceduralTextures` (seven materials from seeded value noise and authored
structure, all `CanvasTexture`), `ProceduralAudio` (the S4.5 bus graph, exactly one
convolver on a send, pooled voices, `PannerNode` positioning, synthesised footsteps and
landings).

**World (`src/world/`)**
`ColliderSet` (oriented boxes in flat typed arrays), `SpatialHash` (uniform 4 m grid,
CSR layout, allocation-free queries), `Geometry` (capsule-vs-OBB penetration and
ray-vs-OBB, both by rigid transform into box-local space), `CollisionWorld` (substepped
swept capsule, de-penetration along the contact normal with a 4-iteration cap, ground
probe, and the custom DDA raycaster), `MapMesher` (world-projected UVs, edge-refined
tessellation, baked vertex AO), `MapLoader`, `maps/types.ts` (map format v1),
`maps/props.ts`, `maps/greybox.ts`.

**Player (`src/player/`)**
`MovementConfig` and `CameraConfig` (every feel constant, with slider metadata),
`Stance` (the five-state machine and its legal-transition table), `Movement`
(friction, acceleration, the collision pass, step-up, ground snap), `Slide`,
`Mantle`, `PlayerController`, `PlayerState`, `CameraShake`, `Viewmodel`.

**Debug (`src/debug/`)**
`DebugOverlay` (F1, 24 read-outs, extension API), `FrameStats` (600-frame rolling
buffer, percentiles, canvas graph), `Speedometer` (wall-clock speed),
`CollisionDebug` (wireframe capsule, contact normals, queried hash cells),
`TuningPanel` (68 generated sliders, copy-config-to-clipboard), `Harness` (headless
simulation driver).

**UI (`src/ui/`)** — design tokens, app chrome, debug styles, boot/menu screens.
**Root** — `Game.ts` (state machine + wiring), `GameStates.ts`, `main.ts`.

---

## Deviations, and why

Nothing in S4 was relitigated. These are additions or corrections, each forced by
something that did not work.

### 1. Ground friction is decomposed against the commanded direction — **required**

The brief gives ground acceleration 60 m/s² and friction 12, and separately gives walk
4.6, sprint 6.9 and tactical sprint 8.2 m/s. Under the obvious model (scale the whole
velocity by friction each tick, then accelerate toward the target) the terminal speed is
`accel / friction` = **5.0 m/s**, independent of the target. Walk works because 4.6 is
below that. Sprint and tactical sprint are unreachable — the speed table cannot be hit.

This was caught by the harness on the first run: it measured sprint and tac sprint both
at exactly 5.000 m/s.

`Movement.applyFriction` now splits velocity against the wish direction: the component
across the command always takes full friction (crisp direction changes), the component
along it only loses the *excess* above the target (so a slide-jump's 8 m/s bleeds back
to sprint speed at the friction rate), and with no command at all everything is "across"
and the player stops at the friction rate. Both constants keep their stated meaning and
the S5.1 table is now hit exactly.

### 2. `Brush.rotationX` / `rotationZ` added to map format v1 — **required**

The v1 schema specifies `rotationY` only. A ramp is a pitched box and cannot be
expressed with yaw alone, and S5.6 requires a ramp. Both fields are optional and feed
the same oriented-box collider, so there is no second collision scheme and no change to
the `MapLoader` contract. Existing yaw-only brushes are unaffected.

### 3. Air and ground speed are hard-clamped after acceleration — **required**

Two ways to beat the S5.2 bound, both found by the verification scripts:

- **Air-strafing.** Accelerating perpendicular to existing momentum adds speed without
  the `addSpeed <= 0` guard ever firing. `PlayerSim.airSpeedCap` latches the horizontal
  speed at take-off; air control may redirect momentum but never grow it.
- **Wall-hugging.** Sliding along a wall with the stick held diagonally lets the
  along-wish component reach the full cap while the velocity actually parallel to the
  wall is `cap / cos(theta)`. Measured 7.51 m/s while sprinting (cap 6.9); at tactical
  sprint it would have been 9.6 and would have broken the bound outright.

`Movement.clampHorizontalSpeed` is applied after acceleration with the limit
`max(speedCap, speedBeforeAccelerating)`, so acceleration can never push past the cap
while pre-existing momentum is still left for friction to bleed off.

### 4. Additions not in the brief

- **Coyote time (0.08 s) and jump buffering (0.10 s).** Standard responsiveness; both
  are config fields and can be set to zero.
- **`stopSpeed` (1.2 m/s)** so friction goes linear at low speed and the player reaches
  zero rather than creeping.
- **`maxFallSpeed` (32 m/s)**, which also keeps per-tick displacement below the capsule
  radius.
- **Auto-vault** for ledges under 0.85 m when sprinting into them, alongside the
  jump-triggered mantle.
- **`Loop.syntheticLoadMs`**, a debug busy-wait used to throttle the render loop
  reproducibly (acceptance criterion 5).

### 5. Interpretations worth recording

- **"Discard the remainder"** on hitting the 5-step cap is implemented as
  `accumulator %= DT`: the whole-tick backlog is dropped, the sub-tick fraction is kept
  so interpolation stays smooth. Zeroing it entirely would also work.
- **ADS speed** is described as "reserved". It is bound to right mouse and applies the
  3.0 m/s cap and an FOV pull-in, so the constant is exercised rather than dead. M2
  takes the binding over.
- **Footsteps and landings only.** S8 permits footsteps; landings are treated as a
  footstep variant. No jump or slide audio — that is M2's, through the same buses.
- **Collision is disabled during a vault.** The destination is validated against the
  real capsule before the vault starts and the vault always ends in a clear pose. The
  motion curves were tightened (rise finishes at t=0.55, swing starts at t=0.50) so the
  capsule no longer spends measurable time inside the ledge lip; the collision harness
  now reports zero intersecting ticks even during mantles.

### 6. Architecture files deliberately absent

`engine/Fx.ts`, `world/Navmesh.ts`, `player/Health.ts` and the `weapons/`, `combat/`,
`ai/`, `modes/`, `meta/`, `streaks/`, `perks/` directories do not exist. Hard Rule 1
forbids stubs, and an empty `Fx.ts` is a stub. They arrive with the milestone that has
something to put in them.

Likewise `LOADOUT` and `SUMMARY` are declared in `GameStates.ts` with their legal edges,
but no handler is registered. `Game.transitionTo` throws a named error if something
tries to enter them, rather than silently doing nothing.

---

## Problems found in the brief

Deliverable 4 asks for these explicitly.

1. **The friction and acceleration constants contradict the speed table.** 60 m/s² with
   friction 12 caps ground speed at 5.0 m/s under any straightforward friction model.
   Sprint (6.9) and tactical sprint (8.2) are unreachable. See deviation 1. This is the
   one genuine inconsistency in the brief and it is load-bearing — anyone implementing
   S5.1 literally will ship a game where sprint does nothing.

2. **`rotationY` alone cannot express the required ramp.** S5.5 fixes the brush schema
   to `rotationY`; S5.6 requires a ramp. See deviation 2.

3. **"Maximum sustained speed is bounded at 8.2 m/s" needs a window definition.** Peak
   instantaneous speed legitimately exceeds sprint (a slide starts at 8.0 and a
   jump-cancel carries it). The bound only means anything over a window. This build
   treats it as the highest average over any one-second window and reports 8.2 exactly.

4. **The tactical-sprint input is unspecified.** The brief gives its speed, duration and
   cooldown but never says how a player enters it. Implemented as a double-tap of the
   sprint key inside a 0.3 s window (`tacSprintDoubleTapWindow`), matching CoD.

5. **The tactical-sprint decay shape is unspecified.** "Decays to sprint" is implemented
   as a linear ramp over `tacSprintDecay` (0.35 s), and the 5 s cooldown starts when the
   decay finishes.

6. **The slide-cooldown reference point is unspecified.** Implemented as starting when
   the slide *ends*, not when it starts. Measured slide-to-slide is 1.217 s.

7. **Frame-time p99 "after 60 s of active movement" cannot be self-measured in a
   non-compositing browser.** `requestAnimationFrame` does not fire in a tab that is not
   displayed, so no frames exist to time. Noted under verification below.

---

## Verification

Reproducible from the browser console; see DEBUG.md. Everything below was measured on
this build, not asserted.

### Verified

| Criterion | Result |
|---|---|
| 2. Inputs mapped | WASD, sprint, double-tap tactical sprint, crouch, slide, jump, mantle, ADS all exercised and observed in the sim. |
| 3. Nothing clips | 14/14 cases pass in `/verify/collision.js`: sprinting into a flat wall and into both corner types, sliding into a wall at 8 m/s, repeatedly jumping into a 1.5 m ledge lip, mantling into the 1.25 m-clearance alcove, the 1.1 m corridor, the ramp, the pit. Zero intersecting ticks, zero ticks outside the room shell. Player rests exactly `radius` from each wall (±23.645 / ±17.645). |
| 4. Standing under the overhang blocked | Crouch-walk to the centre of the 1.25 m overhang, release crouch, hold 2.5 s → stance stays CROUCH, no intersection. Mashing jump under it also stays CROUCH. |
| 5. Fixed 60 Hz | Measured over the long straight in wall-clock time at three frame rates: **6.928 m/s @ ~125 fps**, **6.904 m/s @ ~62 fps**, **6.897 m/s @ ~15 fps with 55 ms of CPU burn per frame**. Spread 0.031 m/s (0.45%). Sim rate measured 60.24 / 60.04 / 59.97 Hz. Distance travelled 17.365 / 17.365 / 17.480 m. |
| 6. Slide-cancel rules | Read back out of a live run, not from the config: slide duration 0.867 s, sprint held before slide 0.300 s, tac-sprint lockout on exit **1.000 s** (measured to zero: 1.000 s), slide cooldown on exit **1.200 s** (measured slide-to-slide: 1.217 s). Steady-state speeds walk 4.600 / sprint 6.900 / crouch 2.800 / tac sprint 8.200. |
| 6. Speed bound | An adversarial policy chaining slide → jump-cancel → sprint → slide for 60 s reaches peak instantaneous 8.200 m/s and **peak sustained (any 1 s window) 7.943 m/s**. Independently, a per-tick recorder over a tac-sprint run gives max displacement 0.13667 m/tick = 8.2 × 1/60 exactly, and a best-60-tick window of exactly 8.200 m/s. |
| 7. Overlay | Opens on F1. 24 read-outs, 20 of which change during a sprint/tac-sprint/jump/slide run; the 4 that do not are legitimately constant (draw calls, map info, ground normal on flat ground, audio state). 68 tuning sliders. F2 collision visualisation draws 200 capsule vertices, live contact normals and 48 hash-cell vertices. Histogram fills to 600 samples and reports percentiles. |
| 9. `tsc --noEmit` | Clean. `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`. Zero `any`, zero `!`, zero `@ts-expect-error`. |
| S4.5 audio graph | One `AudioContext`, buses `master -> {sfx, music, ui}`, **exactly one `ConvolverNode`** built once. 50 sounds fired in a burst created **zero** additional convolvers. Voices pooled. |
| Console on load | Clean through boot and map build — only Vite's own dev messages. |

### Left for the human

The Browser pane in this environment never composited, so `requestAnimationFrame` never
fired and no frames could be rendered or captured. These four need a visible browser:

1. **Criterion 1 — pointer lock.** Click *Click to play*, confirm the cursor locks and
   look works; press Esc, confirm it releases and the menu returns; click again and
   confirm the camera does not jump. (First-delta swallowing and a 400-count per-event
   clamp are in `core/Input.ts` for exactly this.)
2. **Criterion 5, DevTools form.** DevTools → Performance → CPU 6× slowdown, then run
   the long straight and read *Speed (1.0 s)* in the F1 overlay. Expect ~6.90 m/s,
   unchanged. The in-build equivalent is already measured above.
3. **Criterion 8 — p99 after 60 s of movement.** Play for 60 s, then read
   *p50 / p95 / p99* in the overlay, or `__operator.stats()`.
4. **Hard Rule 4 — visual quality.** Shadow acne, z-fighting, muddy lighting. The
   deliberate choices: shadow `bias -0.0004` + `normalBias 0.035` + `radius 2.5` on a
   2048 map with the ortho frustum fitted to the room; every floor-sitting brush is sunk
   so no downward face is coplanar with the floor; lane markers and trim are non-solid
   and raised 1 cm rather than being decals on the floor plane; contact AO is baked into
   vertex colours at load (~40 ms).

---

## What Milestone 2 needs to know

**The input seam is real.** `PlayerController.step(cmd)` sees nothing but an
`InputCommand`. Fire, ADS and reload go in as bits in `Btn` (bits 0–3 are used; ADS is
currently bound to right mouse for its speed cap and M2 should take that binding over).
Do not read the DOM from gameplay, and do not do edge detection in a DOM handler.

**Commands come from a ring.** They are valid for 128 ticks and then overwritten. Copy
anything you retain. The same applies to every EventBus payload.

**The raycaster is ready.** `CollisionWorld.raycast(ox,oy,oz, dx,dy,dz, maxDist, out)`
walks the same 4 m hash the broadphase uses and is allocation-free. Hitscan should use
it directly. `segmentClear` is there for line-of-sight. Do not reach for
`THREE.Raycaster`.

**Hitboxes do not exist yet.** The hash holds static world geometry only. M2/M3 need a
separate dynamic broadphase or per-frame insertion for characters; do not bolt actors
into the static CSR structure, which is built once at load.

**The viewmodel layer is plumbed and empty.** `ViewmodelLayer` owns its own scene,
camera (separate FOV, near 0.008) and lights, and is rendered over a cleared depth
buffer. It skips its pass entirely while empty. `viewmodel.add(mesh)` and it starts
drawing.

**The shake channel is live.** `cameraRig.shake.add(trauma)` where trauma is 0–1;
amplitude is trauma squared and decays at `shakeDecay` per second. Landing already uses
it. Weapon fire should add small values (0.1–0.25) rather than large ones.

**Audio buses exist; use them.** `ProceduralAudio` has `sfx`/`music`/`ui` and one
convolver on a send. Add weapon sounds as new synthesis methods that acquire a pooled
voice. Never create a `ConvolverNode`. The voice pool starts at 24 and warns once if it
grows — raise `VOICE_POOL_SIZE` when M2's gunfire arrives rather than ignoring it.

**Extend the overlay, do not replace it.** `overlay.section('Weapons')` then `addField`.
See DEBUG.md.

**Config tables are compile-checked.** Adding a field to `MovementConfig` or
`CameraConfig` without a matching entry in its `*_TUNABLES` table is a type error. Weapon
configs should follow the same pattern so the tuning panel stays free.

**The event map is per-milestone.** `core/Events.ts` declares only what M1 emits.
`damage.dealt`, `player.killed` and friends belong to M2/M3 — add them when something
emits them.

**Known limitation.** Edge detection happens in the sim from the bitfield (S4.2), so a
press and release inside a single 16.7 ms tick is never sampled as two events. Real
double-taps are 100–200 ms apart, so this has no practical effect, but automated tests
must space synthetic key events by more than one tick.

**Housekeeping.** `public/verify/*.js` are development verification scripts and
currently ship in a production build. Gate or remove them before any public release.

### Bugs & UX Issues from M1 Playtesting (To be fixed in M2)

- **Browser Shortcut Conflicts (Missing Overrides):** The input system currently does not block default browser actions.
For example, pressing `Ctrl + W` (Crouch + Move Forward) closes the browser tab instead of executing the gameplay action. 
The DOM input listeners in `core/Input.ts` must implement `e.preventDefault()` to strictly override and capture all mapped game controls.
- **Slide Audio Mismatch:** When the player executes a slide (Sprint + Crouch), the stance machine updates correctly, 
but the audio system plays standard walking/sprinting footstep sounds instead of a sliding noise. 
The audio synthesis logic in `ProceduralAudio` needs to be updated to recognize the `SLIDE` stance and trigger the appropriate acoustic feedback.
