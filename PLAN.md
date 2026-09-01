# OPERATOR — PLAN

Browser arena FPS, eleven milestones. This file is the running record of what exists,
what was decided, and what the next milestone needs to know.

M1–M8 built a complete single-player browser game. M9–M11 move it onto a dedicated external
server: the split first, then the netcode, then everything else on top of it.

---

## Milestone status

| # | Milestone | State |
|---|---|---|
| 1 | Core loop and movement | **Complete** — see below |
| 2 | Gunplay | **Complete** — see below |
| 3 | Bots | **Complete** — see below |
| 4 | Map and Team Deathmatch | **Complete** — see below |
| 5 | Arsenal | **Complete** — see below |
| 6 | Progression and loadouts | **Complete** — see below |
| 7 | Killstreaks and Modes | **Complete** — see below |
| 8 | Content and polish | **Complete** — see below |
| 9 | Headless server split | **Complete** — see below |
| 10 | Netcode foundation | Planned |
| 11 | Multiplayer completion | Planned |

**Survival mode is cancelled** — permanently, not deferred. See the roadmap update at the end of
this file.

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

### Bugs & UX Issues from M1 Playtesting — **both addressed in M2**

- **Browser Shortcut Conflicts (Missing Overrides):** The input system currently does not block default browser actions.
For example, pressing `Ctrl + W` (Crouch + Move Forward) closes the browser tab instead of executing the gameplay action. 
The DOM input listeners in `core/Input.ts` must implement `e.preventDefault()` to strictly override and capture all mapped game controls.
- **Slide Audio Mismatch:** When the player executes a slide (Sprint + Crouch), the stance machine updates correctly, 
but the audio system plays standard walking/sprinting footstep sounds instead of a sliding noise. 
The audio synthesis logic in `ProceduralAudio` needs to be updated to recognize the `SLIDE` stance and trigger the appropriate acoustic feedback.

See "M1 playtest bugs" under Milestone 2 below. The slide audio is fixed outright. The
shortcut conflict is fixed for every chord a web page is allowed to intercept; `Ctrl+W`
specifically is not one of them, and the remaining mitigation needs fullscreen.

---

# Milestone 2 — Gunplay

One assault rifle, and the system underneath it. M5's eleven other weapons are meant to be
new rows of data in `WeaponDefs.ts` and nothing else, so the split between "what a weapon
*is*" and "what a weapon *does*" is the thing this milestone was really building.

## What was built

**Weapons (`src/weapons/`)**
`WeaponDefs` (the S6.1 schema, the AR, and the extra feel fields), `WeaponTuning` (slider
metadata and accessors, derived from the schema so they cannot drift), `WeaponBase` (the
runtime: ammo, fire timing, ADS, both reloads, sprint-to-fire), `Recoil` (deterministic
pattern, seeded spread cone, separate aim and visual channels, recovery with a residual),
`Ballistics` (hitscan against the M1 spatial hash, interleaved with hitbox rigs, wall
penetration), `WeaponSystem` (the per-tick orchestration and the only non-event output),
`WeaponMesh` (the AR built from primitives, merged to five draws), `ViewmodelAnim`
(sway, ADS with overshoot, kick, keyframed reloads, sprint/slide poses), `ViewmodelConfig`,
`WeaponAudio` (the four-layer gunshot and the mechanical vocabulary).

**Combat (`src/combat/`)**
`HitboxRig` (eight oriented boxes, four zones, ray-vs-rig with a bounding-sphere reject),
`DamageSystem` (the only place damage is applied; falloff, zone multipliers, penetration
loss, `damage.dealt`), `TargetDummy` (mesh built *from* the rig, printed read-out on a
canvas), `TargetRange` (six dummies across the three required behaviours).

**Engine (`src/engine/`)**
`AudioSpecs` / `AudioGraph` / `ProceduralAudio` (M1's graph split three ways and grown
into the S6.7 toolkit: two primitives, one convolver, 64 pooled voices, occlusion
low-pass through the gameplay raycaster), `Fx` + `FxAssets` + `Decals` (pooled muzzle
flash with a reused point light, tracers, material-dependent debris, LRU decals).

**Player (`src/player/`)** `Health` (100 HP, 4.2 s delay, 40 HP/s), `Viewmodel` rebuilt so
the weapon and its lights hang off the camera.

**UI (`src/ui/`)** `Hud` + `hud.css`: dynamic crosshair, hitmarker, ammo, optional damage
numbers.

**Debug (`src/debug/`)** `WeaponDebug`, `WeaponPlots`, `HitboxDebug`, `LatencyProbe`,
`WeaponHarness`. **Root** `Match.ts`, the MATCH-state composition root.

**World** `maps/materials.ts` (penetration density, impact and footstep character per
material) and a penetration bay added to the grey-box room.

---

## Deviations, and why

### 1. `combat/Killfeed.ts` and `combat/ScoreSystem.ts` do not exist

S3 lists them under `combat/`. Nothing in M2 kills anything that has a name worth feeding,
and S9 puts scoring out of scope. Same reasoning M1 used for the directories it left out:
an empty `Killfeed` is a stub, and Hard Rule 1 forbids stubs. Likewise
`weapons/Attachments.ts` — the `AttachmentSlot` type lives in `WeaponDefs`, and the file
arrives with M5, which is the milestone that has attachments.

### 2. Zone multipliers live on the weapon, not on the rig

S6.3 writes the multipliers into the rig (head 2.0x, torso 1.0x, limbs 0.9x); S6.1 puts
`headshotMult` and `limbMult` on the `WeaponDef`. Both cannot be the source of truth. The
rig carries *zones* and the weapon carries *multipliers*, because a sniper and an SMG want
different headshot behaviour against the same body — and the M2 numbers are exactly the
ones S6.3 asks for. `DamageSystem.zoneMultiplier` is where they meet.

### 3. Penetration loss divides by the weapon's budget rather than multiplying by it

S6.4 says to "reduce damage by accumulated material thickness x the weapon's
`penetration`", which read literally makes a weapon with *more* penetration lose *more*
damage. Implemented the way it must have been meant: material thickness times the
material's density accumulates a cost, and the surviving fraction is
`1 - cost / penetration`, with the round stopped outright once the cost exceeds the budget.

### 4. `src/Match.ts` is a new file outside the S3 layout

S3 gives `Game.ts` as the state machine and no home for "everything a match is made of".
Wiring the weapon, the range, the Fx, the HUD and the audio into `Game.ts` directly would
have pushed it well past the 400-line limit in the same section. `Match` owns the MATCH
state's composition and nothing else; every connection inside it is an EventBus
subscription.

### 5. `CameraDrive.ads` became `adsFraction`

M1's camera took a boolean from the mouse button. The FOV has to travel *with* the sights
or the ADS transition reads as a snap followed by the gun catching up, so the camera now
takes the weapon's animation fraction and the weapon's own FOV scales.

### 6. Additions not in the brief

- **`groundMaterial` on `PlayerSim`.** S6.7 asks for footsteps that vary by surface, and
  nothing was carrying which surface. Set from the collision output, added to the
  footstep and landing event payloads.
- **`rayBoxExit` in `world/Geometry.ts`.** Penetration needs to know how much material is
  in the way; the far slab intersection against the collider already hit is both cheaper
  and more robust than re-casting from inside the geometry.
- **Fire suppresses sprint.** Pulling the trigger ends a sprint, which is what starts the
  sprint-to-fire timer. Without it, holding shift into a gunfight is free and the 0.22 s
  lever S6.6 calls core does nothing.
- **Empty-magazine auto-reload.** Running dry with the trigger *held* now clicks once and
  starts the reload. See "bugs found by verification" below.
- **A firing-line marker and a penetration bay** in the grey-box room, so the acceptance
  numbers can be read off the world rather than trusted.

### 7. Interpretations worth recording

- **"Three dummy types" is shipped as three behaviours across six instances.** Static,
  pop-up and strafing, with four static ones at different ranges because a single static
  dummy cannot bracket the falloff curve, and targets in a line shadow each other.
- **Tracers are counted, not diced.** S6.5 asks for "roughly 1 in 3"; a counter gives even
  spacing where a coin flip clumps.
- **Damage is a float internally** and rounded only for display, so the falloff read-outs
  are legible to a tenth.
- **Dummies have no collision.** They are damageable, not solid; the static hash is built
  once at load and M1's note says not to bolt actors into it. Walking through a target is
  odd but harmless on a range, and dynamic collision is M3's problem.

---

## Bugs found by verification, and fixed

Both of these were found by the acceptance scripts, not by reading the code.

1. **Running the magazine dry while holding the trigger did nothing.** The dry-fire click
   and the automatic reload were gated on a trigger *press* edge, and there is no press
   edge on the tick the last round leaves. Holding fire through a magazine left the weapon
   empty and silent until the player released and re-pressed — which is the single most
   common way a player empties a magazine. `dryFiredThisPull` replaces the edge test.
   The first soak run made this obvious: it fired 30 rounds and then sat idle for 58
   seconds while reporting a healthy frame time.

2. **The ADS overshoot fed back into its own state.** The bump was added to the same
   variable the follower damped, so it compounded frame over frame instead of shaping a
   single approach. Replaced with an `easeOutBack` curve evaluated on `adsFraction`, which
   is linear in time — the shape is now identical at any frame rate, with a fast follower
   on top solely to absorb a mid-transition button release.

Two smaller ones, found by reasoning rather than measurement, are worth recording because
neither would have shown up in any automated check: the viewmodel's key and rim lights
were both positioned *behind* the weapon (a correctly built gun rendering as a
silhouette), and `metalness: 0.85` on a scene with no environment map has almost nothing
to reflect and renders near-black. Both are corrected; neither is visually confirmed —
see "left for the human".

---

## M1 playtest bugs

**Slide audio — fixed.** `AudioGraph` now owns one sustained, looping, band-passed noise
bed, driven per frame from `sim.slideActive` and coloured by the surface underfoot. A
slide is one continuous event and cannot be expressed as a stream of footstep bursts.

**Browser shortcut conflicts — fixed as far as a web page is permitted to fix them.**
Every bound code (`WASD`, `Space`, `ControlLeft`, `KeyC`, `ShiftLeft`, `KeyR`, arrows) is
now `preventDefault`ed, which kills `Ctrl+S`, `Ctrl+A`, `Ctrl+D`, `Ctrl+F`, `Ctrl+P` and
the rest. **`Ctrl+W` is not one of them.** Chrome reserves it and ignores
`preventDefault` entirely; the only mechanism that can capture it is the Keyboard Lock
API, which is granted only while the document is fullscreen. So `Input.lockKeyboard()`
arms the request on entering a match and takes it the moment fullscreen happens — press
F11 and the chord is captured; play windowed and it is not. The menu says so.

Making the play button force fullscreen would close this outright, and is the obvious M8
settings item, but it is a UX decision that belongs with the settings screen rather than
being smuggled in here.

---

## Problems found in the brief

Deliverable 4 asks for these explicitly.

1. **The penetration formula is backwards as written.** S6.4: "reduce damage by
   accumulated material thickness x the weapon's `penetration`" makes a *more* penetrating
   weapon lose *more* damage. See deviation 3 for what was built instead. This is the one
   line in the brief that cannot be implemented literally.

2. **Zone multipliers are specified in two places.** S6.3 puts them on the rig, S6.1 puts
   them on the `WeaponDef`. See deviation 2.

3. **A 2.0x headshot multiplier is very strong for an assault rifle.** With the 3-4 shot
   kill S6.1 asks for, it makes a two-shot headshot kill inside 26 m — a 0.086 s TTK. It
   is built to spec and it is a single slider, but M5 should expect to bring it toward
   1.3-1.5x when the arsenal has weapons that are *supposed* to one-shot.

4. **"Under 30 ms from hit to visual" needs a definition of "visual".** A page cannot
   observe when its pixels reach the panel. Measured here as damage-applied to
   marker-made-visible, which is the last moment the game controls, with one further frame
   of compositing on top. Same caveat on the input-latency probe. Both are reported in
   frames for that reason.

5. **The recoil pattern cannot be a slider.** S7 asks for "live tuning sliders for the
   AR's full `WeaponDef`", and the pattern is an array of authored kicks. Its scalars are
   slidered and the array is plotted; a 30-row two-axis editor is an M8 tooling job.

6. **"Fire continuously for 60 s" is ambiguous once magazines exist.** Read as: hold the
   trigger for 60 s and let the automatic reload cycle. That is 348 rounds and eleven
   reloads, not 700 rounds. Reported below.

---

## Verification

Reproducible from the browser console; see DEBUG.md. Everything below was measured on this
build. Simulation properties come from `__operator.weaponReport()`; anything needing real
frames comes from `verify/gunplay.js`.

### Verified

| Criterion | Result |
|---|---|
| 1. Firing / ADS / reload / ammo / sprint-to-fire | Ten-point state trace through fire, ADS, tactical reload, empty reload, sprint and sprint-release. Ammo tracked exactly (30→28 firing, 28→30 with reserve 240→238 on the tactical reload, 0→30 with 238→208 on the empty one). **`canFire` agreed with `raise >= 1 && !reloading` at every one of the ten points** — by construction, since there is only one state and the viewmodel poses against it. |
| 1. Handling timings | ADS **0.2833 s** (config 0.28), tactical reload **2.0667 s** (2.05), empty reload **2.8667 s** (2.85), sprint-to-fire **0.2333 s** (0.22). Every figure is the config value rounded up to the next whole 60 Hz tick, which is the only quantisation available. |
| 2. Recoil determinism | Two 30-round magazines, same seed, fired from a fixed position with the trigger held: 30 shots each, **max angular deviation 0.000000°**, `identical: true`. The plot in the overlay draws both, and the traces are coincident. |
| 3. Hitbox multipliers | At ~5 m: head **68.00** (34.00 x 2.0), torso **34.00** (x 1.0), limb **30.60** (x 0.9). At falloff start (~26 m): identical, since damage is flat to `falloff.start`. Beyond falloff end (~48 m): head **50.00**, torso **25.00**, limb **22.50** (base 25.00, falloff loss 18.00 / 9.00 / 8.10). |
| 4. Wall penetration | Thin steel, 0.05 m: **through**, cost 0.095 of the 0.28 budget, retains 66.1%, target takes **22.46** where an unobstructed shot does 34.00 — a reported loss of **11.54**. Thick concrete, 0.60 m: **blocked**, cost 0.600 against a 0.28 budget, target takes **0**. |
| 5. Hitmarker | 24 hits: **p50 1.2 ms, p99 3.1 ms**, worst 3.1 ms, all under the 30 ms budget. Measured from damage applied in the sim to the HUD making the marker visible; the audio click is scheduled at `currentTime` on the UI bus with no send, so it is not waiting on anything either. |
| 6. 60 s of continuous fire | 349 rounds and eleven automatic reloads. **Audio voice pool 64 → 64** (no growth, no `ObjectPool` warning). **Decals 20 → 96 and held at the 96 cap** — LRU recycling working. Heap 24.0 → 24.1 MB. Frame p99 flat across the whole minute (27.3 / 27.2 / 27.6 / 27.7 / 28.5 / 27.7 / 27.0 / 27.6 / 28.4 / 28.5 / 28.4 / 27.3 ms) — no drift, no sawtooth. |
| 6. Logic budget | Sim time inside the same run: **mean 0.11–0.28 ms, peak 2.9 ms** against the 3.0 ms budget in S4.7. Render peak 3.7–7.6 ms. |
| 7. Fixed rate under load | Same magazine at ~60 fps and at ~15 fps with 55 ms of real CPU burned per frame (the in-build equivalent of the DevTools 6x throttle M1 used). Timestamped off the rounds themselves, not polled. **702.4 vs 712.7 RPM — a spread of 1.47%** — and **reload 2.868 s vs 2.941 s**. The residual is the ±1 tick of quantisation on when a shot lands relative to the wall clock, which over a 29-interval window is 0.7% before the frame source's own jitter. |
| 8. Input latency | 24 samples, 0 dropped: **p50 0.97 frames (19.2 ms), p99 1.29 frames (25.6 ms)** against the measured 19.8 ms frame interval. Against a nominal 60 Hz frame that is 1.15 / 1.54. Under the two-frame target either way, and it excludes the compositor. |
| 9. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`. |
| S4.5 audio graph | Still exactly one `ConvolverNode`, built once. 1743 one-shot source nodes were started across the 60 s soak against a **constant** pool of 64 voices — one-shot sources are required to be single-use by the Web Audio spec, so that number is a rate, not a leak. |
| Console on load | Clean. The Three.js "multiple instances" warning that `three/examples/jsm` introduced is fixed in `vite.config.ts` (`resolve.dedupe`), not silenced. |

### Left for the human

The Browser pane in this environment reports `document.visibilityState === 'hidden'` and
never composites, so `requestAnimationFrame` never fires on its own and no frame can be
seen. The verification above works around that the way M1's `framerate.js` does — by
substituting the frame source, which drives the real loop, the real renderer, the real HUD
and the real audio graph — but **substituting the frame source does not produce a picture**.
Everything below needs eyes on a visible browser.

1. **The viewmodel.** Whether the AR reads as a rifle at all: proportions, the hip pose
   sitting in the lower right, the sights landing on the screen centre at full ADS, and
   whether the materials are lit. Two blind corrections went in here (the key and rim
   lights were behind the weapon; metalness 0.85 with no environment map renders black) and
   neither has been seen. If the gun looks wrong, `ViewmodelConfig` is entirely sliders and
   `hipX/hipY/hipZ` plus `adsY/adsZ` are the five numbers that matter.
2. **Feel.** Hard Rule 3 is the one thing a harness cannot check. Does the recoil pattern
   read as learnable? Is the ADS overshoot a flick or a wobble? Does the gunshot have
   weight, or is it a hiss? Every number involved is a slider, and COPY CONFIG writes the
   result back out as source.
3. **Fx.** Muzzle flash shape and duration, tracers reading as travel, decals landing flat
   on angled surfaces, the hitmarker being legible at a glance.
4. **`Ctrl+W` capture.** Press F11, start a match, and confirm crouch-plus-forward no
   longer closes the tab. Windowed, it still will; that is a browser limit, not a bug.
5. **Frame time with a real compositor.** The p99 figures above come from a substituted
   `setTimeout` frame source whose own interval is ~20 ms, so the reported p99 of ~28 ms is
   mostly the timer. The numbers that are actually about this build are the sim times
   (mean 0.14–0.25 ms) and the flatness of the curve across the minute.

---

## What Milestone 3 needs to know

**The rig is already yours.** `HUMANOID_RIG` in `combat/HitboxRig.ts` is the real thing,
verified against printed damage on the range. A bot needs `new HitboxRig()`, a `Health`,
an `entityId` and a `displayName` — that is the whole `Damageable` interface — and then
`damageSystem.register(bot)`. Ballistics, falloff, penetration, hitmarkers, damage numbers
and the debug visualiser all start working with no further wiring. **Call
`rig.setTransform` from the sim tick, not the render pass:** a shot is resolved on a tick,
so it must be resolved against where the target was on that tick. `TargetDummy` shows the
pattern, including keeping separate interpolation snapshots for rendering.

**Targets are a linear scan, deliberately.** `Ballistics.nearestTarget` walks
`DamageSystem.list` with a bounding-sphere reject per rig. That is right for tens of
actors and wrong for thousands; if M3's bot count goes past ~64, give the actors their own
dynamic broadphase — but do **not** put them in the static spatial hash, which is built
once at load (M1's note still stands).

**The player is already a target.** Entity 0 is registered with a rig that follows the
capsule, and `Ballistics` excludes `request.sourceId`. A bot shooting the player needs
nothing new except a source id that is not 0.

**Damage has exactly one door.** `DamageSystem.apply`. It is the only place health is
reduced in gameplay, and `lastHit` is what the overlay prints — so what the debug panel
says is what the game did, by construction. Build a request with `makeDamageRequest(def)`
once and reuse it.

**`weapon.fired` carries the whole shot.** Muzzle, direction, end point, distance, pattern
index, spread and whether it hit — emitted *after* the trace resolves so tracers have an
end point. Bot weapons should go through the same `WeaponSystem`, which means bots get
recoil, spread, sprint-to-fire and reloads for free; a bot that fires by calling
`Ballistics` directly is a bot that ignores every balance number in the def.

**The audio toolkit is two functions.** `noiseBurst` and `oscHit`. Bot footsteps, voice
lines and weapon fire all compose from those; never build a node graph, and never add a
`ConvolverNode`. The voice pool is 64 and holds flat under sustained fire — if M3 pushes
it over, raise `VOICE_POOL_SIZE` rather than ignoring the warning.

**Occlusion is already wired.** `ProceduralAudio.setOccluder` takes a predicate; `Match`
gives it a `segmentClear` against the gameplay raycaster. Bot audio gets muffled through
walls for free, and the same raycaster is what `Perception` should use for line of sight.

**`Match.ts` is where a match is composed.** Add bots there, not in `Game.ts`. Everything
in it is an EventBus subscription, which is what lets `WeaponHarness` run the entire combat
path headlessly — keep it that way and M3's bots stay testable without a renderer.

**Config tables are still compile-checked**, and `WeaponTuning.ts` shows the pattern for a
nested config: derive the key union from the schema so a new field without a slider is a
type error at the metadata table, and a key without an accessor is a type error at the
switch.

**Housekeeping.** `public/verify/*.js` still ship in a production build; gate or remove
them before release. Nine files sit in the 420–480 line range against S3's ~400 guidance
(`DebugOverlay`, `Geometry`, `Game`, `WeaponHarness`, `AudioGraph`, `Fx`,
`PlayerController`, `Input`, `CollisionWorld`) — the same tolerance M1 shipped at.
Everything that grew past 500 was split.

---

## What is playable right now

Click into the grey-box room and you are standing on a marked firing line with an M4 in
your hands and a range laid out in front of you. Six targets: one at five metres, a pop-up
on a timer, one strafing across at sixteen, one sitting exactly on the falloff line at
twenty-six, and two at forty-two behind a pair of panels — thin steel you can shoot
through, thick concrete you cannot. Every target prints what you just did to it on a board
above its head: the zone, the range, the damage, and the health it has left. Shoot one in
the head and it says 68.0; shoot it in the leg and it says 30.6; walk backwards past the
falloff line and watch both numbers fall. Hold the trigger and the gun climbs for five
rounds and then starts walking right, then left, then right again, and the crosshair opens
up as it goes; let go and it settles back down — not quite to where it started, which is
the point. Aim down the sights and the spread collapses, the FOV pulls in, and the iron
sights land on the centre of the screen. Run the magazine dry and the reload starts on its
own, with the charging handle worked at the end; hit R early and you get the shorter one.
Sprint and the gun drops out of the way, and there is a fifth of a second after you let go
before it will fire again — you can feel it. Press F1 and the whole thing is visible:
every shot you have just fired plotted against the pattern it came from, the last hit
broken into base damage, multiplier and losses, the input latency in frames, and sliders
for every number involved.

---

# Milestone 3 — Bots

Bots that patrol, notice you, chase, take cover, shoot back, miss believably, and die with
weight. The organising idea is S6.1's: **a bot is not a special case.** It owns the same
`HitboxRig`, the same `Health`, the same `WeaponDef` and — the part that makes the rest
true — a real `PlayerController`. The only difference between the human and a bot is where
the `InputCommand` comes from.

## What was built

**AI (`src/ai/`)**
`Combatant` (the interface that makes the player and a bot the same thing to everything in
`ai/`), `BotStates` (the ten states and the one transition table), `BotBlackboard` (the
only thing the brain may read about an enemy), `Perception` (110 deg cone, torso-then-head
LOS, the noise field), `CombatBehaviour` (the converging aim error, the miss-first-burst
rule, trigger discipline), `BotBrain` (`decide` at 4 Hz, `steer` at 60 Hz), `Pathing`
(resumable budget-capped A* with string pulling), `Cover` (validated, scored and occupied),
`SpawnSelector` (safe / hidden / least-bad), `DifficultyTiers`, `AiScheduler`, `Bot`,
`BotMesh` (ragdoll-lite death), `BotDirector` (the per-match owner and the only translator
of world events into AI input), `PlayerCombatant`.

**World** `Navmesh` (0.5 m grid baked from capsule clearance tests against the existing
collision world, 8320 cells / 5539 walkable / 41252 links, ~100 ms), and `maps/greybox.ts`
grew derived `coverPoints` and ten more `spawns`.

**Debug (`src/debug/`)** `AiDebug` (navmesh, path polylines, LOS rays, cover occupancy —
all preallocated, F4), `AiPanel` (the budget read-outs, one selected bot's whole
blackboard, floating per-bot state labels, and 102 sliders across six panels),
`BotHarness` (the AFK bot-match mode and its URL flags).

**Elsewhere** `Match` composes the director and owns player death and respawn; `Hud` grew
health, a hurt vignette, directional hit indicators and a death overlay; `Loop` grew
`simSpeed`; `HitboxRig` grew `heightScale`; every `player.*` and `weapon.*` event grew an
entity id. `public/verify/bots.js` is the acceptance suite.

## Deviations, and why

### 1. `sourceId` was added to six more weapon events — required

M3's plumbing gave `weapon.fired` a `sourceId`. The mechanical vocabulary —
`weapon.dryFired`, `reloadStarted`, `reloadStep`, `reloadFinished`, `adsChanged`,
`ammoChanged` — did not get one, and `Match` was positioning all of it at the *player's*
eye. The result was a bot working its charging handle across the room sounding like it was
at your shoulder. All six now carry `sourceId` and `Match.sourcePosition` resolves it.

### 2. Cover selection now uses the `y` it was already being passed

`CoverIndex.select` took a `y` and ignored it, so cover was chosen on plan distance alone.
In this room the pit floor and the alcove shelf are both within a metre of open floor in
plan, so a bot could pick cover on another level. A `MAX_HEIGHT_DELTA` of 1.6 m rejects it.

### 3. `SAMPLES_PER_ZONE` raised from 5 to 9

Measured, not guessed: at 3v4 every candidate clearing 15 m was sometimes *visible* to an
enemy, forcing three spawns in fifty to appear in front of somebody. A wider candidate pool
took actually-visible spawns to zero. Spawn selection runs a few times a minute; the cost
is irrelevant.

### 4. Veteran fires *shorter* bursts than Hardened

The first hit-rate measurement had Veteran **below** Hardened — 12.2% against 14.5% — while
firing 20% more rounds. Long bursts let the weapon's own recoil walk off target, and a
52 m engage range spent rounds at the far wall. Veteran now fires 3-5 round bursts inside
46 m and its edge comes from the cone, the convergence rate and the reaction time, which
are the levers S6.7 actually names.

### 5. Aim cones widened across all four tiers

Also measured. Against a fixed target at 15 m, Regular / Hardened / Veteran all landed
~54% and were indistinguishable, because the AR's ADS spread floor swamped aim cones of
1.15-3.0 deg. Recruit was separated only because its `adsRange` of 16 m left it hip-firing.
Cones are now 5.6 / 4.0 / 2.5 / 1.35 deg, which produces a monotonic, visibly separated
progression. See the table below.

### 6. A dead player submits neutral commands rather than being skipped

`Game.simulate` swaps `input.sample` for `input.sampleNeutral` while dead. The sim still
runs for the player, and the seam stays honest — it is what a real server would send while
waiting on a respawn.

### 7. `modes/`, `meta/`, `streaks/`, `perks/` still do not exist

Same reasoning M1 and M2 used. S9 puts all of it out of scope and Hard Rule 1 forbids
stubs. `combat/Killfeed.ts` and `ScoreSystem.ts` likewise: bots die with names now, but
nothing is keeping score until M5.

## Bugs found by verification, and fixed

All three were found by measurement, not by reading the code.

1. **The audio voice pool grew without bound, and it was costing the sim.** The
   ten-minute soak took it from 64 voices to **81,117**, and AI mean time climbed with it
   from 0.39 ms to 1.30 ms (p99 3.2 -> 11.5 ms). Voices are released on a timestamp taken
   from `AudioContext.currentTime`, which advances in *wall clock*; the moment the
   simulation runs faster than real time — exactly what S7's speed multiplier asks for —
   sounds are created faster than they can expire. Worse, once the pool was exhausted every
   subsequent shot allocated a fresh `GainNode`/`BiquadFilterNode`/`PannerNode` **inside
   the sim tick**, because the `weapon.fired` handler runs synchronously inside
   `BotDirector.simulate`. `MAX_ACTIVE_VOICES` (112) now refuses a sound rather than
   allocating one. After the fix the same soak holds voices flat at 112, heap flat at
   ~25 MB, and AI mean at **0.033-0.05 ms** — a tenfold improvement that was never about
   the AI at all. Two related guards went in beside it: neither primitive may acquire a
   voice while the context is suspended (its clock is stopped, so nothing could free it),
   and `AudioGraph.update` now runs every frame instead of only while the context is
   running.

2. **`DEAD -> IDLE` was decorative.** `Bot.spawn` set `brain.state` directly, so the one
   legal edge out of `DEAD` never went through the transition table and never emitted
   `bot.stateChanged`. The state-coverage run reported IDLE entered zero times in 90
   seconds. A respawn is now announced as the transition it is.

3. **Bot landings dipped the player's camera.** `EV.PlayerLanded` grew an `entityId` in
   M3 but `Game`'s subscriber did not read it, so every bot that hit the ground applied
   `cameraRig.applyLanding` to the local view. Audio still plays for all of them — that is
   how you hear one drop in behind you — but the camera dip is gated on the player's id.

## Problems found in the brief

1. **Acceptance criterion 5's "expected: zero" cone violations is unreachable in this
   room.** `visionRange` is 60 m and the grey-box room's diagonal is ~60 m, so every
   candidate spawn is inside every enemy's *range* and the cone test reduces to pure angle.
   A 110 deg cone covers 30.5% of directions; with seven living enemies, roughly 8% of
   bearings are clear of all of them. Measured, 22-25 of 50 spawns land inside some cone.
   The number that can be driven to zero, and is, is how many were **actually visible** —
   cone *and* line of sight. That is the property the rule exists to protect, and it is
   what should be reported. Criterion 5 becomes satisfiable as written on an M4 map larger
   than the vision range.

2. **The 15 m spawn rule is unsatisfiable by area at higher bot counts.** Four 15 m
   exclusion discs cover 2827 m2 against 1728 m2 of floor in a 48 x 36 room. The selector
   degrades to least-bad exactly as S6.9 instructs, but "never within 15 m" cannot be a
   guarantee until maps are bigger. Measured minimum across rosters: 18.25 m at 1v1,
   21.24 m at 2v2, 32.93 m at 3v3, and 8.87 m at 5v5 where the geometry gives out.

3. **"Accuracy cone" is meaningless without a range and a reference target.** Two tiers
   with cones 2.6x apart measured identically at 15 m because the weapon's own ADS spread
   dominated both. The tier table is only tunable against a stated engagement — hence the
   fixed-engagement measurement below, which is the one that actually describes the
   shooter.

4. **S6.7 lists `engageRange` and burst length nowhere**, yet both were varied by tier and
   both actively hurt the tier they were supposed to help. See deviation 4.

## Verification

Reproducible from the browser console; `public/verify/bots.js`, then
`await window.__verifyBots()`. Every number was measured on this build.

| Criterion | Result |
|---|---|
| 1. All ten states entered | Over 90 simulated seconds with 7 bots: IDLE 39, PATROL 20, INVESTIGATE 41, ENGAGE 212, SUPPRESS 50, RELOAD 24, SEEK_COVER 42, FLANK 95, PUSH 83, DEAD 40. **10/10.** |
| 2. TTK both directions at 10 m | **Identical.** Player -> bot: 3 torso hits, **34.00** damage each, **10 ticks = 0.167 s** at 9.87 m. Bot -> player (Veteran): 3 torso hits, **34.00** each, **10 ticks = 0.167 s** at 9.88 m. The 34.00 is M2's verified torso figure unchanged, which is the point — one `DamageSystem`, one `WeaponDef`, no second implementation. |
| 3. Bots miss (fixed engagement) | One bot at 15 m against a stationary target, 30 s: **Recruit 21.3%** (17/80), **Regular 39.4%** (41/104), **Hardened 46.7%** (56/120), **Veteran 56.0%** (75/134). Monotonic and well separated. |
| 3. Bots miss (live 8v8 firefight) | Recruit 9.0%, Regular 13.2%, Hardened 10.4%, Veteran 11.9% — flat, because each tier is also fighting *itself* and higher tiers strafe and peek far more. Kills track tier cleanly: **13 / 27 / 29 / 37**. Both numbers are reported because neither alone is honest. |
| 4. No jitter, no walking into walls, no pit | **1 stuck event** across 6 simulated minutes with 10 bots, and 0-1 across the 60 s scheduler runs. Strafes and peeks are validated against the navmesh before they are taken, and the pit lip is rejected by a height test. Path failures run ~20/min and are goals in unreachable cells, not wedged bots. |
| 5. Spawn safety, 50 respawns | 3v4: min enemy distance **11.14 m**, 28 safe / 16 hidden / 6 least-bad, 22 inside a cone, **0 actually visible**. 5v5: min **17.43 m**, 25 safe / 25 hidden / 0 least-bad, 25 inside a cone, **0 actually visible**. See "problems found in the brief" 1 and 2 for why cone violations are non-zero and why the 15 m floor is not absolute. |
| 6. Scheduler with 10 bots | Over 60 simulated seconds: AI **p50 0.000 ms, p99 0.500 ms, mean 0.073 ms**, worst 7.4 ms (a single cold outlier). A* **worst 420 nodes/tick — exactly the cap**, 0 deferred, 158 of 3600 ticks budget-exhausted, 333 searches completed / 17 failed. Comfortably inside the 3 ms budget. |
| 6. Scheduler at 4x through the real loop | 10 bots, `?harness=botmatch&bots=10&speed=4`: AI p50 0.100 ms, p99 0.800 ms, mean 0.148 ms. |
| 7. Ten-minute soak | 10 bots, 6 simulated minutes after the audio fix: heap **24.8 -> 26.1 MB with no trend**, audio voices **flat at 112**, AI mean **0.033-0.050 ms** and p99 **0.2-0.3 ms**, both flat. No sawtooth. Before the fix the same run showed heap 35 -> 55 MB, voices 15,592 -> 81,117 and AI mean 0.39 -> 1.30 ms — the soak did its job. |
| 8. Fixed rate | Every AI timer — reaction delay, burst pause, convergence, strafe period, respawn — advances by the `DT` constant on sim ticks, and the TTK figures above are measured in **ticks**, so they cannot vary with frame rate by construction. `Loop.simSpeed` scales the *number* of ticks per frame and never `DT`; 79.3 simulated seconds ran in ~20 wall seconds at `speed=4` with bot behaviour unchanged. |
| 9. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`, zero TODOs. |
| 9. Console | Clean through a harness run: Vite's own messages and one `[BotHarness]` info line. No pool warnings, no errors. |

### Left for the human

The Browser pane in this environment reports `visibilityState === 'hidden'` and never
composites, so `requestAnimationFrame` never fires and **nothing above was ever seen**. The
measurements substitute the frame source, which drives the real loop, sim, damage path and
audio graph — but that does not produce a picture. These need eyes:

1. **Do bots read as people?** The silhouette, the two team colours, the visor plate you
   are supposed to be able to read facing from, and whether the four death variants land
   convincingly or look like falling doors.
2. **Feel.** Hard Rule 3. Is a Veteran punishing but fair? Is the miss-first-burst enough
   warning to react to? Does the hurt vignette read without blinding you? All 102 numbers
   involved are sliders under F1, and COPY CONFIG writes them back out as source.
3. **The frame-time figures in the harness read-out are the `setTimeout` frame source's own
   interval** (p50 16.7 ms), not this build's. The numbers that are about this build are
   the AI times and the flatness of the heap.
4. **F4 visualisation.** The navmesh point cloud, path polylines, LOS rays, cover
   occupancy and floating state labels have been exercised in code but never rendered.

## What Milestone 4 needs to know

**The navmesh is baked from the collision world, not from map data.** `bakeNavmesh` runs
capsule clearance tests against whatever `CollisionWorld` holds, so a new map needs no nav
authoring — but it does need `navBounds` set honestly, because the bake walks that volume
and it is ~100 ms for this room at 0.5 m.

**`coverPoints` is derived, not authored.** `maps/greybox.ts` generates cover from prop
placements via a per-shape profile table. Copy that pattern rather than hand-listing
positions, which rot the first time a crate moves. Points the navmesh rejects are dropped
at load and counted in `navStats.coverRejected` — a non-zero count on a new map is a data
bug worth looking at.

**Bigger maps fix two things measured here.** Both spawn findings above are room-size
problems: once the map is larger than `visionRange`, the cone test stops being pure angle
and criterion 5 becomes satisfiable as written.

**The roster is bots *and* the player.** `BotDirector.roster` holds `Combatant`s and
nothing in `ai/` knows which one is human. Game modes should add to that array, not around
it. `PlayerCombatant.active = false` is how the harness spectates and is the hook a
killcam or a spectator mode would reuse.

**Damage still has exactly one door**, and TTK is symmetric *by construction* rather than
by agreement — same `WeaponSystem`, same `Ballistics`, same `DamageSystem`, one
`WeaponDef`. Do not add a second damage path for anything, including killstreaks.

**Do not create audio nodes per event.** `MAX_ACTIVE_VOICES` is a hard ceiling and
`voicesDropped` is on the F1 read-out; if M4+ adds sound sources and that counter climbs
during ordinary play, raise the ceiling deliberately rather than removing it. The
unbounded version cost 10x the AI budget and was invisible until a soak ran.

**The AI budget has room.** 0.073 ms mean with 10 bots against a 3 ms frame budget means
M5's grenades and M7's killstreak AI have somewhere to go. The scheduler's rates are live
sliders; add new work as a new `*Due(index)` rate rather than putting it on the tick.

**Housekeeping.** `public/verify/*.js` still ship in a production build — now four files.
`BotBrain.ts` (592) and `BotDirector.ts` (554) are over S3's ~400-line guidance; both split
cleanly along `decide`/`steer` and roster/events if they grow further.

### M3 Playtest Bugs — **fixed in M4**

**Muzzle flash desync — fixed.** The flash was bound to `weapon.fired` correctly all along; the
bug was *whose* flash it was. The flash **mesh** is parented to the local player's viewmodel
muzzle, and `Match` fired it for every shot on the map — so the player's own rifle lit up
whenever any bot pulled a trigger, which reads exactly as a flash out of sync with your own
shooting. The **light** is a world light and does belong to whoever fired. `Fx.fireMuzzleFlash`
now takes a `local` flag and runs the two on separate timers: the light for everybody, the mesh
for the local player only.

## What is playable right now

Click into the grey-box room and there are seven other people in it — three on your side,
four against — and they were already fighting before you arrived. They patrol the room on
real paths, and the first thing that happens when one notices you is that it *misses*: the
opening burst goes deliberately wide, which is your cue to find cover, and then its aim
walks onto you over the next second or so. Break line of sight and it does not follow you
through the wall — it shoots at where you were, then comes looking, and if you have moved
it stands in the wrong doorway. Crouch-walk and it cannot hear you at all; fire a round and
everything within forty metres knows roughly where you are. Hurt one badly enough and it
breaks contact for a crate and reloads behind it, then leans out to shoot and drops back.
Hurt yourself badly enough and the screen rims red, a chevron tells you which way the round
came from, and a bar in the corner tells you how much is left. When you die you watch a
four-second counter and come back somewhere that is not in front of anybody. When they die
they fall in the direction the round was travelling, in one of four ways, and the body
stays there until it respawns. Press F1 for the whole thing in numbers — every bot's state,
the selected one's entire blackboard, AI milliseconds per tick, A* nodes, and 102 sliders —
and F4 to see the navmesh, the paths, the sight lines and which cover is taken. Add
`?harness=botmatch&bots=10&speed=4` to the URL and it runs itself without you.

---

# Milestone 4 — Map and Team Deathmatch

Foundry, 5v5 Team Deathmatch, main menu to post-match summary. The first milestone that
produces something a stranger could sit down and play.

The organising problem was not the map or the mode — it was that M1–M3 built one world at boot
and kept it for the life of the page. A map *choice* and a summary screen you come back from
mean the world is now per-match, and `buildWorld` / `teardownWorld` have to be exact mirrors.
That constraint is what most of this milestone's real bugs were about.

## What was built

**World (`src/world/`)**
`NavGrid` + `NavBake` (M3's `Navmesh` split in two and **grown to two layers**; `Navmesh.ts` is
now a barrel so no consumer changed), `maps/foundry.ts` (the map), `maps/build.ts` (authoring
helpers: spans, ramps defined by their endpoints, 180-degree rotation), `maps/cover.ts` (the
cover derivation, moved out of `greybox.ts` so both maps share one copy), three new materials
and six new prop shapes.

**Modes (`src/modes/`)**
`GameMode` (the S6.2 abstract base, with round support abstract so a mode cannot forget to
answer), `MatchFlow` (rounds, the clock, the respawn gate, the side swap, the killfeed's
input), `Tdm`, `ModeRegistry` (what the menu can offer).

**Combat (`src/combat/`)** `ScoreSystem` (the single answer to "what is the score"), `Killfeed`
(the model; the view is next door). `DamageSystem` grew `team` on `Damageable` and a
friendly-fire gate; `Ballistics` skips friendly rigs during target selection.

**UI (`src/ui/`)** `Hud` completed (score banner, round timer, killfeed, minimap, low-health
state), plus `HudBanner`, `Killfeed`, `Minimap`, `Scoreboard`, `EndOfMatch`, `Menus`,
`MatchHud`, `WeaponIcons`. `Screens.ts` is gone — `Menus` replaces it.

**Engine** `AudioSpecs.buildImpulseResponse` takes a room description with discrete early taps;
`AudioGraph` gained `setReverb`, `duckWorld`, `setMuffle` and a delay argument on both
primitives; `ProceduralAudio` gained the announcer and the heartbeat.

**Root** `Game.ts` rewritten around BOOT to MENU to MATCH to SUMMARY with a real teardown;
`MatchFeedback.ts` (everything that presents a shot, split out of `Match`).

**Debug (`src/debug/`)** `DebugSuite` (all per-match tooling, built and destroyed together),
`ModePanel` (mode state, spawn scoring, lane timings, objectives, killfeed log), `MatchHarness`
(matches back to back with the heap at each boundary), `ConsoleApi`. `AiDebug` gained the
spawn-score visualisation; `FrameStats` gained mode and HUD milliseconds.

## Deviations, and why

### 1. The navmesh grew a second layer — required, and predicted

M3's PLAN said: *"Single-layer, deliberately… M4's real maps will [overlap], and that is when
this grows a second layer."* Foundry's catwalk deck runs directly over walkable floor, so a
single height per XZ cell can only ever describe one of them, and acceptance criterion 4
requires bots to navigate the catwalks.

A node is now `layer * columnCount + iz * dimX + ix`. `indexOfX` / `indexOfZ` mod the layer
out, so every consumer that only cares where a node is *in plan* is unchanged. Links became
layer-resolving — `linkLayer` packs two bits per direction — and `neighbour(node, dir)`
replaces the manual `index(jx, jz)` that `Pathing` and the flood fill used to do. Foundry bakes
1000 stacked columns and 1300 deck nodes out of 10,602 walkable in 70 ms.

Three callers had to become height-aware rather than plan-aware: `Cover` (a railing four metres
above floor cover is not the same cover), and `BotBrain`'s flank probe and strafe probe.

### 2. TDM's team score is a kill count, not scoreboard points — a real bug, found by running it

`onKill` added `pointsPerKill` (100) to the *team* total against a `scoreLimit` of 75, so every
match ended on its first kill. Every other number in the mode looked plausible, which is what
made it worth recording: the win condition and the scoreboard are two different scales and the
mode has to say which is which.

### 3. Two subscriptions leaked per match — found by the heap harness, which is the point of it

`DebugOverlay` subscribed to `player.spawned` and `WeaponDebug` to `weapon.fired`, and neither
retained the unsubscribe. Both are rebuilt every match from M4, so each leaked closure kept a
whole overlay or panel alive — and through them the match, the bot director, the navmesh and
the map's collision world. The heap climbed a monotonic **+3.4 MB per match**; after the fix
four matches read 31.96 / 33.17 / 34.09 / 33.95 MB. Verified structurally as well: in the menu
the bus holds **zero** listeners and the scene **zero** children.

### 4. Bots would not use the catwalks, and the reason was commitment — not pathing

Worth spelling out because the first two hypotheses were both wrong. The navmesh linked the
levels correctly (A* pathed spawn to deck in five waypoints) and a bot handed a deck goal
walked up and stood on it. But across eighteen simulated minutes no bot ever left the floor.

`decide` runs at 4 Hz and re-derives everything, and `tryFlank` is gated on the tier's
`flankChance` — so a bot already flanking dropped the plan on the *next* decision unless the
dice came up again. At Regular's 0.15 that is a mean commitment of about a third of a second.
Measured: ten deck-level flank goals set in 216 simulated seconds, none reached.

`FLANK_COMMIT_SECONDS` (5.0) holds a flank that is already under way; ammo and a bad wound
still interrupt it, a wobble in the tactical picture no longer does. FLANK samples went from 99
to 776 and four distinct bots reached the deck. Two supporting changes: upper navmesh layers
are sampled for patrol points at half the stride (a deck is a *route*, and a lattice sized for
a floor plan walks past it), and a flank probes `HIGH_FLANK_PROBE` above itself so "get around
the side of them" and "get above them" are the same manoeuvre.

This is a general improvement rather than a catwalk fix. A plan re-rolled eight times before it
completes was never reading as a plan.

### 5. Friendly fire is off, and it had to be decided somewhere

M3 had no score, so bots shooting each other cost nothing. In TDM it decides the match.
`Damageable` gained an optional `team` and `Ballistics` skips friendly rigs during target
selection, so a round passes *through* a teammate rather than stopping harmlessly in one;
`DamageSystem.apply` carries the same gate for whatever damage source arrives next. It is a
flag, not a hardcode.

### 6. Objectives are on the minimap only when a mode has them

S6.4 asks the minimap to show objectives and S6.1 asks for Domination flags and S&D bomb sites
authored now. Both are done, but drawing three Domination flags during Team Deathmatch is
noise, so `Minimap.showObjectives` defaults off and the mode panel toggles it. The objective
list is always visible in the panel.

### 7. `Match.ts` and `Game.ts` were split, and the HUD was split seven ways

S3's ~400-line rule. `Match` shed `MatchFeedback`; `Game` shed `DebugSuite` and `ConsoleApi`;
the HUD's large pieces became `HudBanner`, `Killfeed`, `Minimap` and `MatchHud`, with
`Scoreboard`, `EndOfMatch` and `Menus` alongside. See housekeeping for what is still over.

### 8. Interpretations worth recording

- **Foundry is rotationally symmetric, not mirrored.** Everything but the two bomb sites is
  authored for one half and put through `rotateHalf` (`(x, z)` to `(-x, -z)`). A mirror makes
  the two teams' lanes handed; rotation gives both sides literally the same map, which is why
  the lane spread is 2.25% rather than something that needed tuning. The bomb sites are
  deliberately *not* symmetric: S&D is the one mode where the two teams do different jobs.
- **No railings on the catwalks.** Dropping into the hall or into a lane is a route, and an
  open edge is one fewer 0.12 m ledge for the navmesh to call walkable. Deck cover comes from
  the structural girders that pass through it.
- **`swapSidesAfterRound` is implemented, not stubbed.** Spawns are the only side-dependent
  thing a match owns, so changing ends swaps the team totals and makes each team draw from the
  other's spawn zones. TDM never triggers it; the mode panel has a button that does.
- **`livesPerRound` rides the same respawn gate that M4 needs anyway** — nobody respawns once
  the match is over, which is what stops a bot appearing behind the summary screen.
- **The announcer is cues, not words.** Ten phrases, each two or three band-passed noise
  formants and a low body, distinguished by *shape*: a rising pair for good news, a falling
  triple for bad, three short bright ones for urgency. The world ducks under each one and the
  `ui` bus is routed around both the duck and the low-health muffle, so a call still cuts
  through at 12 HP.

## Problems found in the brief

1. **S6.4 asks the minimap to show objectives; S9 makes the modes that use them out of scope.**
   Drawing them anyway is misinformation during TDM. Resolved as a default-off toggle — see
   deviation 6 — but the brief cannot have both as written.
2. **"Sprint along every wall … anything that catches is a bug" needs a definition of
   catches.** Sliding along a wall is *blocked on every tick* and is exactly what should
   happen; a concave corner is *supposed* to stop you. Three successive versions of the sweep
   reported findings that were all artefacts of the harness (see verification). The definition
   that survives is failure to make progress along the run.
3. **The heap-growth harness needs a garbage collector it cannot have.** `usedJSHeapSize`
   immediately after a teardown is mostly uncollected garbage; six consecutive matches came
   back with a 19 MB spread and no trend. `window.gc` needs `--expose-gc`. The harness now
   provokes a collection by allocating and dropping ~48 MB. Without that step the instrument
   cannot answer the question the brief asks it.
4. **"Within about 15% of each other from spawn to centre" needs a definition of centre.**
   Measured to the *lane's* midpoint — the point in that lane equidistant from both spawns —
   because measuring an outer lane to the geometric centre of the map is always longer and the
   comparison would be meaningless.
5. **A 5v5 with an AFK player is 4v5.** Every harness match was won by team B, 75 to 40–54.
   That is not a map bias: the harness leaves the human standing still on team A, one active
   fighter short and feeding kills. Worth stating because it looks exactly like a balance bug.

## Verification

Load `/verify/tdm.js` and call `await __verifyTdm.all()`; see DEBUG.md. Every number below was
measured on this build.

The frame source is substituted, as in M1–M3, because `requestAnimationFrame` never fires in a
tab that is not compositing. **It is a `MessageChannel` rather than a `setTimeout`**: Chrome
clamps timers in a hidden tab, and the first run of this suite got 348 sim ticks out of nineteen
wall seconds — it was measuring the browser's throttling. With the channel the sim holds a
measured **60.0 Hz**, so for the first time the frame percentiles are of real work.

| Criterion | Result |
|---|---|
| 1. Menu to match to summary to menu to match | Four consecutive matches, all ended by the mode on the 75-kill limit, then back to the menu. **In the menu the event bus holds 0 listeners, the scene holds 0 children, `debug-root` holds 0 elements**, and match, map and debug suite are all null. Console clean throughout. |
| 2. Sprint every wall | 26 runs, 48 passes, 11,284 ticks: **0 passes failed to make progress, 0 ticks with the capsule inside geometry, 0 walls untested.** All 12 traversals (both outer ramps, both internal stairs, all four ring runs, the centre bridge, a ramp descent and both hall gates) arrive at the expected height. Two snags were found and fixed — see below. |
| 2. Clearance audit | 90 standing colliders, **0 gaps narrower than the 0.70 m capsule**. Tightest remaining is 0.821 m. Three impassable pinches were found and fixed. |
| 3. Lane timings | At 6.90 m/s sprint, spawn to lane centre: **WEST 3.07 s / 3.05 s, CENTRE 3.12 s / 3.12 s, EAST 3.05 s / 3.05 s** (south spawn / north spawn). Path lengths 21.03–21.50 m. **Spread 2.25%** against a 15% target. Measured by running the real A* over the real navmesh and dividing by sprint speed. |
| 4. Bots on the catwalks | Over 237 simulated seconds with 9 bots: **4 distinct bots reached the deck**, 1.1% of samples on it. 27.7% of samples inside the hall — they fight over the centre. Cover held peaked at 4 of 209 slots. All nine live states entered. **2 stuck events.** |
| 5. Spawn safety under match load | 114 selections across a full match: **minimum enemy distance 15.00 m** (the S6.9 rule exactly), 45 safe / 69 hidden / **0 least-bad**, **0 spawns an enemy could actually see**. 69 were inside a cone with no line of sight — see M3's note 1; the number that can be driven to zero is the visible one, and it is. No spawn trap observed: the flip-side zones past the centre line are what the selector reaches for when a team is pushed back. |
| 6. Killfeed | Newest DOM row matches the model's newest line exactly (`HALYARD -> KESTREL`), weapon icon drawn from SVG path data, 5 lines retained. |
| 6. Scoreboard | 10 visible rows against a 10-strong roster; columns `Score / K / D / K/D / Acc / Best` supplied by `getScoreboardColumns()`. Local row verified against the score system: `250 / 2 / 0 / 2.00 / — / 2`. |
| 6. Banner and clock | DOM scores match `mode.teamScore` for both sides; clock counts down from 10:00. |
| 6. Low health | At 12 HP: intensity 0.657, **audio muffle 0.657** (the world low-pass engaged), vignette opacity 0.47, threshold 35 HP. Cleared to 0 on death and on teardown. |
| 6. Damage direction | `showHitDirection(pi/2)` produces `rotate(90deg)`; the pool holds four so a crossfire reads as two directions. |
| 6. Minimap | Canvas present, drawn from `MapDef`, 2–4 friendly chevrons live. |
| 7. Heap across matches | Four matches: baseline 65.46 (uncollected boot), then **31.96, 33.17, 34.09, 33.95 MB**. Flat, and the last boundary is lower than the one before. Before the subscription fix the same run climbed monotonically at +3.4 MB a match. |
| 8. Frame time, 10 bots, real firefight | **p50 4.1 ms, p95 22.1 ms, p99 29.4 ms**, worst 38.6, mean 8.43 over 600 frames. **AI mean 0.331 ms, p99 1.7 ms. Mode peak 0.30 ms. HUD peak 1.7 ms.** Against S4.7's 3.0 ms logic budget the mode and HUD costs are a rounding error; A* worst 420 nodes/tick, exactly the cap. |
| 9. Fixed rate under load | Same stretch of match unloaded and with 55 ms of real CPU burned per frame: **60.04 Hz vs 59.77 Hz** sim, 99.2 vs **17.2 fps** (a 5.8x frame-rate collapse). Match clock **1.0007 vs 0.9962** seconds per wall second — **drift 0.45%**. TTK is measured in ticks by construction (M3). |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`, zero TODOs. |
| 10. Console | Clean across the four-match run: harness `info` lines and Vite's own messages only. No warnings, no errors. |
| S4.5 audio graph | **0 `ConvolverNode`s constructed across two match loads including a map change.** The per-map impulse response assigns a new *buffer* to the one convolver built at boot. Voice pool flat at 128, 0 voices after teardown, muffle reset to 0. `voicesDropped` is flat at 1x play and only grows while the sim is fast-forwarded — the M3 ceiling doing its job. |
| Map build | 48 brushes, 76 props, 102 colliders, **37 draw calls**, 83,384 triangles, 1,728 hash cells. Build 134 ms of which 125 ms is the AO bake. Navmesh 26,784 nodes / 10,602 walkable / 1,000 stacked columns / 76,702 links in 70 ms. 209 cover points (11 rejected), 92 patrol points, 144 spawn candidates from 16 zones, 5 objectives. |

### Bugs found by verification, and fixed

Five, and only one of them was found by reading code.

1. **Three impassable pinches in the map.** The clearance audit found gaps of 0.31 m, 0.35 m and
   0.12 m where a prop's footprint stopped within a capsule diameter of a wall or another prop:
   the two deck girders sat 0.39 m from the hall walls, a machine 0.31 m from the north wall,
   and a crate 0.35 m from a container. All look like routes and none are. Fixed by moving four
   placements; the girder positions now come from one `DECK_GIRDERS` list so the prop and its
   deck-level cover cannot drift apart.
2. **Girders dead-centre in a 3 m catwalk.** Passable either side but exactly the kind of thing
   that reads as a snag. Moved inboard, which also fixed pinch 1 — the deck keeps a 2.4 m clear
   lane and the hall wall keeps 1.5 m of clear floor.
3. **TDM ended on its first kill.** See deviation 2.
4. **Two leaked subscriptions per match.** See deviation 3.
5. **Footstep audio, landing audio and the camera landing dip were silently dropped** by the
   `Game.ts` rewrite. Found by grepping for the call sites after the split rather than by
   noticing the silence, which is the uncomfortable part. They live in `MatchFeedback` now,
   which is where they belong: positional for every combatant, and the camera dip gated on the
   local player's entity id.

### Findings that were in the harness, not the game

Recorded because three successive versions of the sprint sweep produced confident, wrong
answers, and each one looked plausible.

1. **Version one flagged every wall.** Each pass ran a fixed number of ticks with no arrival
   test, so after reaching the end it spent four hundred ticks pressed into the far corner at
   zero speed. Fixed by stopping at the end of the run.
2. **Version two silently tested four walls out of eighteen.** A constant sideways push escapes
   through the first doorway, and every one of Foundry's walls has doorways — the away-side
   pass wandered off and was discarded, and so was the toward-side pass the moment it found a
   gap. Fixed with a servo that holds the run line across a gap, and by reporting per-wall
   coverage so a wall with no completed pass is called untested rather than passing by silence.
3. **Version three flagged fourteen walls.** Run lines authored 0.5 m too far in asked the
   player to stand *inside* the wall, so each pass drove into a doorway and jammed on the far
   jamb. Fixed by authoring every run line at exactly `capsuleRadius + 0.01` from its face.

The lesson worth keeping: a sweep that reports zero is worthless unless it also reports what it
covered.

### Left for the human

The Browser pane in this environment reports `visibilityState === 'hidden'` and never
composites, so **nothing above was ever seen**. The measurements drive the real loop, sim,
navmesh, damage path, mode and audio graph, and the DOM assertions read the real HUD — but that
does not produce a picture. These need eyes:

1. **Does Foundry read as a place?** The three lanes, the hall's silhouette from the yards, the
   catwalk against the roof, whether brick / rust / grate / concrete read as four materials, and
   whether the two ladle point lights make the centre feel like somewhere. No z-fighting was
   designed in — abutting boxes share coplanar faces only with *opposing* normals, which
   back-face culling resolves — but that is an argument, not an observation.
2. **Shadow quality on a bigger map.** The ortho frustum is fitted to `navBounds` at
   `shadowExtent` 42, which is 2048 texels over 84 m — 24 texels/m against the grey-box room's
   30. Acne and peter-panning at the catwalk edges are the thing to look for.
3. **Feel of the round flow.** Three seconds of warm-up, "GET READY" over the crosshair, the
   announcer sting, then FIGHT. Is the pause right? Do the ten cues read as distinct?
4. **The minimap at a glance.** It is drawn from map data and rotates with the player; whether
   it is *legible* at 168 px while moving is not something a DOM assertion can answer.
5. **Ten consecutive matches.** `__operator.runMatches(10)` is one call. Four are reported
   above; the brief asks for ten.
6. **Whether the catwalks are worth fighting for.** 1.1% bot occupancy says they get used, not
   that they are good. `FLANK_COMMIT_SECONDS`, `HIGH_FLANK_CHANCE` and the patrol stride are the
   three numbers involved.

## What Milestone 5 needs to know

**The navmesh is two-layered now, and the API hides it.** `indexOfX` / `indexOfZ` mod the layer
out, so anything that only cares where a node is in plan is unchanged. Anything that cares
*which level* must use `cellAtY(x, y, z)` rather than `cellAt(x, z)` — that distinction is the
whole reason bots can use a catwalk. `NAV_LAYERS` is 2 and `linkLayer` packs two bits per
direction, so 4 is the ceiling without widening that word.

**A mode is thin, and `MatchFlow` owns rounds.** M5's modes should be about the size of `Tdm`
(178 lines) and should not know what a round *is*. The base declares `roundsToWin`,
`swapSidesAfterRound`, `livesPerRound`, `roundSeconds` and `scoreLimit` as **abstract**, so a
new mode cannot forget to answer. `MatchFlow.respawnAllowed` is the single gate both the bot
director and the player's respawn ask; add mode-specific respawn rules there, not in two places.

**The score has exactly one door**, the way damage does. `ScoreSystem` subscribes to
`weapon.fired` and `damage.dealt` and is the only thing that counts anything — the scoreboard,
the banner, the killfeed and the summary are four views of it. Do not add a second tally.

**Objectives are already authored.** Foundry carries three Domination flags and two S&D bomb
sites with labels, positions and radii. `Minimap.showObjectives` draws them and the mode panel
lists them. M7 should consume that data, not re-place it.

**`MapDef` carries its own room.** `reverb` is a `ReverbDef` and `AudioGraph.setReverb` assigns
a new buffer to the one convolver. A new map that omits it gets the default room. Never
construct a `ConvolverNode`.

**The map DSL grew helpers worth using.** `maps/build.ts` has `addSpan`, `rampAlongX`,
`rampAlongZ` (defined by the two ends of the walking surface, which is what stops a 2 cm lip)
and `rotateHalf`, which throws on a pitched brush rather than silently producing one pointing
into the floor. `maps/cover.ts` derives cover from placements via a shape profile table — add a
profile when adding a prop shape, and never hand-list positions.

**Run the clearance audit on every new map.** `__verifyTdm.clearanceAudit()` found three
impassable pinches in Foundry that the sprint sweep only caught by luck. It is a data check over
collider footprints and takes no time.

**The world is per-match. Mirror it.** `buildWorld` and `teardownWorld` in `Game.ts` are exact
mirrors and `DebugSuite` / `MatchFeedback` / `MatchHud` each mirror their own construction.
Anything added to a match that is not released shows up as a step in `usedJSHeapSize` at the
next boundary — and the two leaks this milestone found were both a missing unsubscribe, so
**retain what `bus.on` returns**.

**Friendly fire is a flag.** `DamageSystem.friendlyFire` is false and `Ballistics` skips
friendly rigs. A mode that wants it on sets it; nothing is hardcoded.

**Housekeeping.** Twenty files are over S3's ~400-line guidance, most inherited: this milestone
split `Navmesh` into `NavGrid` + `NavBake`, `Match` into `Match` + `MatchFeedback`, `Game` into
`Game` + `DebugSuite` + `ConsoleApi`, and the HUD into seven files — but `Game.ts` (670),
`ui/Hud.ts` (606) and `world/maps/foundry.ts` (497) are still over, and `Game.ts` is the one to
split next, along the world-lifecycle seam. `public/verify/*.js` still ship in a production
build — now five files. `voicesDropped` is cumulative for the page and only grows under
fast-forward; it is not a per-match figure.

### M4 Playtest Bugs & UX Feedback (Action Required in Next Milestone)
**Lighting Adjustment:** The Foundry map is too dark. Please adjust the ambient/directional lighting intensity, shadow darkness, or ACES exposure settings to brighten the environment significantly.
**Combat / Sliding:** Players currently cannot fire while sliding. 
Please update the weapon state machine and stance constraints to explicitly allow firing your weapon while in the `SLIDE` stance.
**Pause State & UI:** Pressing `ESC` currently quits the match entirely. This needs to be changed. 
`ESC` must transition the game into a `PAUSED` state (freezing the simulation) and display an in-game Pause menu. 
**Debug Overlay / Pointer Lock:** Pressing `F1` currently breaks pointer lock and causes control issues. 
The Debug Overlay/Tuning Panel access should either gracefully handle pointer lock suspension, or ideally, be accessible as an option directly from the new Pause menu.
**Scoreboard during Death:** The scoreboard (`Tab` key) is currently inaccessible while the player is in the `DEAD` state waiting to respawn. 
Players must be able to view the scoreboard at any time, especially during the death screen.

## What is playable right now

Pick Team Deathmatch and Foundry from the menu and you drop into an industrial yard with a
foundry hall in the middle of it, four teammates and five enemies, and a three-second countdown
before anyone is allowed to shoot. There are three ways from your spawn to the middle and they
all take about three seconds at a sprint, so the fight starts wherever you chose to run. The
hall has a gate on each side and a two-storey gantry over it: a ramp up from each outer lane,
stairs inside, and a walkway that crosses the middle of the building — and you can drop off any
edge of it into the room below, because there are no railings. Bots use it. They will come round
the side and arrive above you, and they hold a flank now instead of changing their mind twice on
the way. Kills stack up in the corner with a rifle silhouette between the two names, the score
bar at the top fills toward seventy-five, and a synthesised sting marks two minutes, one minute
and thirty seconds while the world ducks under it. Hold Tab for the scoreboard and your row is
the one with the accent edge. Get below thirty-five health and the world goes quiet and woolly
behind a low-pass while your own heartbeat speeds up in front of it — and a chevron still tells
you which way the round came from, because that is the one thing you need when everything else
has gone muffled. When somebody reaches seventy-five the match stops, nobody respawns, and you
get a summary with your score, kills, K/D, accuracy and best streak over the full scoreboard,
then a button back to the menu that tears the whole world down and lets you do it again. Press
F1 for the mode's phase and clock, the spawn scoring, the lane timings, an objective list and a
killfeed log; F4 to see the navmesh on both levels with every spawn candidate coloured by score;
and `__operator.runMatches(10)` to watch ten matches play themselves and print the heap at every
boundary.

---

# Milestone 5 — Arsenal

Twelve weapons, five attachments, five pieces of equipment, and the balance work that makes
them mean something. M2 promised that "M5 adds eleven more entries to `WeaponDefs.ts` and
writes no new classes to do it". That held: **no weapon in this milestone is a subclass**, and
every behavioural difference between the twelve is a number on a `WeaponDef`.

The genuinely new code is four things the data could not express on its own — a pellet loop, a
scope, a two-slot inventory, and a pure attachment resolver — plus `equipment/`, which is a
subsystem rather than a weapon.

## What was built

**Weapons (`src/weapons/`)**
`WeaponDefs` reduced to the schema, the registry and the helpers; the twelve weapons moved to
`defs/` (`assaultRifles`, `smgs`, `shotguns`, `lmgs`, `snipers`, `pistols`), because twelve
hand-authored recoil patterns is four hundred lines of *content*. `Attachments` (the five
trade-offs, the pure resolver, and the purity verifier), `Inventory` (two slots and the swap
machine), `Scope` (breath sway, hold-breath, glint), `WeaponModelSpecs` + `WeaponMeshParts`
(twelve viewmodels as proportions rather than twelve coordinate lists). `Recoil` grew
`aimWithOffset` and `pelletOffset`; `WeaponSystem` grew the pellet loop, the swap and the
scope; `WeaponBase` grew `handlingSeconds` and `stepHolstered`; `WeaponTuning` grew the new
keys and a `scope.*` group; `ViewmodelAnim` grew a swap pose and per-weapon sight-height
compensation.

**Equipment (`src/equipment/`)** — a new directory. `EquipmentDefs` (frag, semtex, flashbang,
smoke, claymore, each carrying a `WeaponDef`-shaped `damageProfile`), `EquipmentConfig`,
`Projectile` (the integrated arc through the existing swept collision, plus
`previewTrajectory`), `SmokeField` (density-based occluder), `FlashField` (angle- and
LOS-scaled blindness), `EquipmentSystem` (fuses, detonation, claymore triggers, the threat
indicator), `ThrowController` (the player's cook and release), `BotThrower` (tier-gated, with
the self-safety check), `EquipmentFx`, `EquipmentAudio`.

**Combat (`src/combat/`)** `HitboxRig` gained an `upper` flag on the chest box and
`RigHit.upper`; `DamageSystem` gained `upperTorso` on the request and in `zoneMultiplier`;
`TargetDummy` gained a measured TTK read-out and a mutable position; `TargetRange` was
re-laid out at exactly 5/15/25/40 m.

**AI (`src/ai/`)** `Perception` gained a `SightOccluder` and a `BlindSource` (both null by
default, so every M3 measurement still describes the same system) and a glint bypass on the
cone; `Combatant` gained `glinting`; `DifficultyTiers` gained the four grenade fields S6.7
listed and M3 deliberately left out.

**UI (`src/ui/`)** `HudTactical` (weapon plate, equipment counters, cook timer, breath meter,
grenade indicator, flash white-out, scope overlay), `PauseMenu`. `Hud` composes both.

**Root** `MatchEquipment.ts`, the equipment composition root, split out of `Match` for the
same reason `MatchFeedback` was. `Game` gained the `PAUSED` state.

**Debug (`src/debug/`)** `ArsenalHarness` (the TTK table, attachment deltas, pellet spread,
the slide-cancel measurements), `ArsenalPanel` (weapon picker, attachment chips,
base-vs-resolved diff, twelve overlaid pattern plots, pellet plot, clipboard export),
`EquipmentPanel` (trajectory preview, smoke-occlusion visualisation, flash angle report,
sliders). `public/verify/arsenal.js` is the acceptance suite.

**Docs** `docs/BALANCE.md` — the measured TTK table and the slide-cancel retune report.

## Deviations, and why

### 1. `src/equipment/` is a directory S3 does not name — required

The alternative was `weapons/`, which is already the largest package in the project and whose
contents are all "a thing you shoot". A frag is a thrown, fused, bouncing volume that damages
by radius and blinds by angle; it shares exactly one thing with a rifle, and that one thing is
deliberate:

**An explosion is a `WeaponDef`.** Every piece of equipment carries a `damageProfile` shaped
like a weapon, so radial damage goes through `DamageSystem.apply` unchanged. M3's rule — damage
has exactly one door — survives, a grenade kill appears in the killfeed with no special case,
and the F1 read-out prints a grenade the same way it prints a bullet.

### 2. The headshot multiplier came down from 2.0 — predicted by M2

M2's own "problems found in the brief" note said: *"a 2.0x headshot multiplier is very strong
for an assault rifle… M5 should expect to bring it toward 1.3-1.5x when the arsenal has weapons
that are supposed to one-shot."* It is now 1.45–1.55 on everything except the snipers (1.8 and
1.95). This changes M2's verified head figure of 68.00 to 51.00 for the carbine; the mechanism
is untouched and `measureZones` still reads it back out of `DamageSystem.lastHit`.

### 3. "Upper torso" is a flag on a hitbox, not a fifth zone

S6.1 wants the snipers to one-shot the upper torso. The M2 rig already splits the torso into
`chest` and `abdomen`, so `HitboxDef.upper` marks the chest and `WeaponDef.upperTorsoMult`
applies to it. A weapon that leaves the multiplier at 1.0 — every weapon but the two snipers —
behaves *exactly* as it did in M2, which is what keeps every M2 number verified. A fifth
`HitZone` would have changed the meaning of `torso` everywhere and invalidated all of them.

### 4. `ScopeProfile` has no `scopeInTime`

S6.1 gives snipers "0.35 s scope-in". That is `adsTime`, and the KESTREL's is exactly 0.35.
A second timer beside it would be a field that either duplicates `adsTime` or lies about it;
the VANTAGE is slower (0.44 s) because it is semi-automatic, which is a balance decision
rather than a different mechanism.

### 5. Firing while sliding is now legal, and the slide no longer lowers the weapon

From the M4 playtest notes. The cost moved from "you cannot shoot" to a spread penalty — a
slide is treated as airborne in `SpreadContext`, so the cone opens by `airScale`. This is the
change that made S6.5's slide-cancel question worth asking, and it is why the answer had to be
measured rather than assumed.

### 6. Twelve viewmodels are a function of a spec, not twelve coordinate lists

M2 hand-placed the AR's boxes, which was right for one weapon. Twelve hand-placed weapons is
twelve lists that drift apart the first time a sight height changes, so the geometry became a
function of a `WeaponModelSpec` and the specs became the content. The carbine's spec reproduces
M2's proportions exactly. `ViewmodelConfig.adsY` is still one number: each weapon's ADS pose is
derived from it by the difference between its sight height and the carbine's.

### 7. The materials are process-wide, not per model

M2 built three 128 px canvases per weapon model. Twelve weapons rebuilt every match would be
thirty-six canvas generations and thirty-six GPU uploads on the frame a match starts, for three
distinct images. `sharedSurfaces` caches them; `disposeWeaponSurfaces` exists for a page
teardown that does not currently happen.

### 8. Bots carry no secondary

`WeaponSystem` takes `secondary: WeaponDef | null` and every bot passes null. Nothing in `ai/`
swaps weapons, and a holstered pistol a bot will never draw is a second magazine to keep in
sync for nothing.

### 9. Bot grenade policy lives outside `BotBrain`

`BotThrower` is driven from `MatchEquipment` at one bot per tick rather than from the 4 Hz
`decide` loop. `BotBrain` is already the largest file in `ai/` at 648 lines, and grenade policy
needs the collision world and the equipment system, neither of which the brain has. The safety
check runs the *real* integrator (`previewTrajectory`), so "where would this land" is answered
by the thing that decides where it lands.

### 10. Smoke has a render cull that the occluder does not share

`EquipmentFx` stops drawing a cloud's billboards past 38 m. `SmokeField.blocksSight` knows
nothing about it, so a cloud you cannot see still blocks the line of sight through it — only
the picture is culled, never the gameplay. Added after the first frame-time run: eight clouds
at eleven transparent quads each was measurably the largest cost equipment added.

## Bugs found by verification, and fixed

All four were found by measurement, and two of them were the *instrument* rather than the game —
which is worth recording, because both produced confident, wrong numbers first.

1. **Every cell of the first balance table was measured at 10 m.** `ArsenalHarness` moved the
   target's rig to the requested range, but `TargetDummy.step` re-wrote the transform from its
   *spec* position on the next tick. The table looked plausible — the carbine read 3 shots at
   40 m, which is impossible for 26 damage — and that impossibility is what gave it away.
   `TargetDummy` now has a mutable base position.
2. **The laser's measured hip cone was 3.99° for a 1.9° weapon.** The harness spawned the
   player at 0.2 m and read the spread on tick zero, while they were still airborne — and
   `airScale` is 2.1. The *delta* was right (exactly −20%) and the absolute figure was
   nonsense. It now steps thirty ticks to let them land.
3. **The pellet report counted misses as torso hits.** `lastPellets.zones` carries a default
   for pellets that found nothing, so the first run claimed eight zone hits out of five landed
   pellets. Filtered on `targets[i] >= 0`.
4. **The trigger cannot be held during a slide run-up.** M2 made firing suppress sprint, so the
   first version of `measureSlideEntry` never reached the 0.3 s slide gate and reported that no
   slide had happened at all. The policy now pulls the trigger on the tick the slide begins,
   which is also what a player does.

## Problems found in the brief

Deliverable 4 asks for these explicitly.

1. **"Lengthen the lockout" is aimed at the wrong number.** S6.5 asks whether sliding into a
   room beats the fastest ADS and says to lengthen the tac-sprint lockout if it does. Measured:
   it did, by 45 ms — and that 45 ms lived in `sprintOutTime` on three weapon defs, not in the
   movement rule. The lockout governs *chaining*, and chaining measured `fireableFraction =
   0.000` over thirty adversarial seconds: a player moving at 7.9 m/s cannot shoot at all. Both
   changes were made — the lockout went to 1.25 s as instructed, and the three fast weapons went
   to 0.18 s, which is where the problem actually was. See `docs/BALANCE.md`.
2. **"8 pellets, one-shot inside 6 m" is only satisfiable with a stated cone.** Eight pellets
   at 18 damage is 144, but what matters is how many land. At `pelletSpread` 2.6° the cone is
   0.27 m across at six metres against a 0.46 m chest, which puts six on target for 108 — a
   kill. At 3.5° it would not be. The pellet count and the damage are meaningless without the
   cone, and the brief gives only the first two.
3. **"Scope glint visible to enemies" needs a rule for what a bot does with it.** Implemented as
   a bypass of the vision cone but *not* of line of sight: a glint is what makes you turn round,
   and you still cannot see one through a wall. The brief says it is visible and not what
   visible means.
4. **A shotgun with a hard range wall is unusable, not spiky.** The first table had the BREACHER
   unable to kill *at all* at 15 m inside six seconds. That is maximally spiky and nobody would
   carry it; `far` went from 4 to 7 so it is a four-shell grind out there — hopeless, but a
   fight. "Spiky" needs a floor.
5. **Frame-time p99 still cannot be measured honestly in a non-compositing tab.** Same finding
   as M1–M4, and the numbers below say so plainly.

## Verification

`fetch('/verify/arsenal.js').then(r => r.text()).then(eval)` then
`await __verifyArsenal.all()`; see DEBUG.md. Every number was measured on this build.

| Criterion | Result |
|---|---|
| 1. Twelve weapons functional | All twelve equipped through `Match.equip` — which rebuilds the viewmodel — and fired through the real `WeaponSystem`. Rounds consumed over an identical 40-tick window track RPM exactly: 8 / 7 / 10 / 6 / 12 / 9 / 2 / 8 / 9 / 1 / 3 / 5 for 700 / 620 / 820 / 480 / 1000 / 780 / 90 / 650 / 800 / 48 / 200 / 400 RPM. Twelve distinct viewmodels build, with sight heights 0.042–0.118 m. |
| 1. Twelve distinct patterns | Pattern lengths 5–40 steps; 30-shot accumulated climb **6.24° to 129.90°**; lateral drift **−10.68° to +6.00°**; direction reversals **0 to 26**. Closest pair over all 66 comparisons is WASP 9 vs MERIDIAN P40 at **0.788° RMS**. All twelve are overlaid in one plot in the F1 *Arsenal* panel. |
| 1. Twelve distinct voices | Body bands span **395–1950 Hz** with the closest pair **75 Hz** apart. The LMG/SMG pair S6.1 names — BASTION 545 Hz / 0.68 s tail against WASP 1950 Hz / 0.17 s tail — is a 3.6x ratio in centre frequency and 4x in tail length. |
| 2. `docs/BALANCE.md` | Measured, 12 weapons x 4 ranges x 2 zones, both tables. Measurement takes ~40 ms and is one button in the F1 panel. |
| 3. Attachment purity | 5/5 checks pass: base unmodified; three distinct roots; `spread`/`recoil`/`damage`/`falloff`/`voice` all separately cloned; **writing 99 into one resolved def leaves the other and the base untouched**; effects landed. |
| 4. Attachment costs measured | Optic **+39.2 ms** ADS (280.0 → 319.2) for a 0.180° → 0.130° aimed cone. Foregrip **+24.3 ms** ADS (280.0 → 304.3) for recoil scale 1.00 → 0.75. Laser hip cone **1.900° → 1.520° (−0.380°)**, read out of a live `WeaponSystem.spreadDeg`. Suppressor range 42.0 → 37.8 m. Extended mag 30 → 45 rounds, reload 2.050 → 2.563 s. |
| 5. Mixed pellet spread | BREACHER aimed at the neck at 4 m and 6 m: **3 head + 2 torso pellets, 111.6 damage, lethal**. At 8 m: 2 head + 2 torso + 1 arm, 84.0, not lethal. At 10 m: 66.4. Every pellet is an independent hitscan ray resolved against the rig. |
| 6. Smoke blocks bot perception | VULTURE → KESTREL at 19.3 m. **Clear: optical depth 0.00, not blocked. Smoked: depth 5.38 against a threshold of 1.0, blocked, and 117 perception rejections. Cleared: depth 0.00, not blocked.** Measured through the real `Perception`, not by calling the occluder directly. |
| 7. Flash scales with angle | Point blank with line of sight: **0° = 1.000, 45° = 0.696, 90° = 0.403, 135° = 0.273, 180° = 0.213** — 3.00 s, 2.09 s, 1.21 s and 0.64 s of blindness. Without line of sight at 0°: **0.250**. At half range at 0°: **0.500**. |
| 8. Slide-cancel retune | Reported in full in `docs/BALANCE.md`. Slide entry 8.000 m/s, fireable after **0.217 s** and **1.702 m**, still doing 7.610 m/s. Fastest ADS 0.175 s; fastest sprint-out was 0.120 s and is now **0.180 s**. Lockout 1.00 → **1.25 s** (measured back at 1.250). Peak sustained 7.943 → **7.897 m/s**, peak instantaneous 8.200. **Chained slide-cancel `fireableFraction` = 0.000 over 30 s and 22 slides.** |
| 8. Bot aim at the tuned ceiling | 45 s, 10 bots, live firefight: **REGULAR 13.3% (27/203, 4 kills), HARDENED 15.3% (35/229, 6 kills), VETERAN 18.4% (50/272, 18 kills)** — monotonic in both hit rate and kills, which M3's live figures were not. AI **p50 0.20 ms, p99 1.00 ms, mean 0.224 ms** over 2701 samples. 0 stuck events. Spawns: 0 visible violations, minimum enemy distance 16.06 m. |
| 9. Frame time | See the note below. Sim-side, under a deliberate over-load: **equipment 0.0–0.2 ms, mode peak 0.7 ms, HUD peak 1.1 ms, sim 0.0–0.7 ms** against S4.7's 3.0 ms budget. In the one window where the pane genuinely composited, a 10-bot firefight held **p50 16.7 / p95 16.8 / p99 17.0 ms** — vsync-locked 60 Hz — both with bots throwing and with them not. |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`, zero TODOs. |
| 10. Console | Clean through all twelve weapons, a swap, all five pieces of equipment, a pause and a resume: Vite's own messages, the verify script's own `info` lines, and the embedded pane's pointer-lock rejection (`WrongDocumentError` — the canvas is in a nested document Chrome will not grant lock to). No pool warnings, no errors. |
| S4.5 audio graph | No `ConvolverNode` is constructed anywhere in `equipment/` or the twelve voices — every sound is `noiseBurst` or `oscHit` on the existing pooled voices and the one send. |

### The frame-time caveat, again

Under the substituted `MessageChannel` frame source the p95/p99 varied between 33 and 47 ms
across four runs of the *same* load, while the sim-side numbers stayed at 0.0–0.7 ms
throughout. That spread is the frame source and the environment, not the game — the same
finding M1 through M4 recorded. The two numbers worth trusting are the sim-side costs, which
are an order of magnitude inside budget, and the single genuinely-composited window at a
locked 60 Hz.

The load itself is deliberately unreasonable: three grenades every 0.9 s for thirty seconds on
top of a live ten-bot firefight, which fills the eight-cloud smoke pool and keeps it full. 106
thrown, 97 detonated. Ordinary play — bots throwing on their own 12–22 s cooldowns — produced
7 to 21 throws in the same window.

### Left for the human

The Browser pane composited for exactly one measurement window and was `visibilityState:
"hidden"` for the rest, so **almost nothing below was ever seen**. These need eyes:

1. **Do twelve weapons read as twelve weapons?** The specs are authored to be distinguishable
   at a glance in the lower right of a moving screen — drum and bipod on the LMGs, tube
   magazine and pump on the shotgun, no stock on the bullpup, a scope you can see the objective
   bell of on the snipers. Whether that survives contact with the actual FOV is unverified.
2. **Feel, which is Hard Rule 3 and the one thing no harness reaches.** Do the twelve patterns
   read as learnable and *different*? Does the WASP's 0.117 s kill feel like the reward its
   falloff cliff is paying for? Is the scope sway a mechanic or a nuisance? Every number is a
   slider under F1 and COPY CONFIG writes them back out as source.
3. **The audio.** Twelve voices were authored against three numbers and verified as *numbers*.
   "An LMG and an SMG identifiable with your eyes closed" is a claim about ears.
4. **The Foundry lighting fix.** Hemisphere 0.78 → 1.35 with the ground colour lifted, key
   2.0 → 2.35, exposure 1.05 → 1.25, fog pushed from 38 m to 55 m. The diagnosis — that the
   *fill* was the problem rather than the key — is an argument, not an observation.
5. **The pause screen, the scope overlay, the flash white-out and the grenade indicator.** All
   four are DOM and CSS that have been exercised in code and never rendered.
6. **Smoke as a picture.** The occlusion is verified as a number (117 perception rejections);
   whether the billboards read as a volume you cannot see through is a different question.
7. **`__operator.runMatches(10)`** with equipment live — the M4 heap harness has not been
   re-run since `equipment/` was added, and `MatchEquipment.dispose` is the new thing that
   could leak.

## M5 hotfixes — reported in playtesting, fixed immediately after the milestone commit

Three, and the first was a defect that had been latent since M1.

### 1. The pause menu's buttons were unclickable — a CSS specificity bug

`app.css` granted pointer events with `#ui-root > * { pointer-events: auto }`. That selector
is specificity (1,0,0) and therefore silently outranked `.hud { pointer-events: none }` at
(0,1,0) — so the HUD, which is a full-screen element, had been quietly *accepting* clicks for
four milestones. Nothing was underneath it until M5 put the pause screen there.

Measured before the fix, hit-testing the centre of the Resume button:

    stack: [hud-dirs, hud-hurt, hud-low, hud-numbers, hud, op-btn, op-screen--pause, CANVAS]

Five HUD layers above the button. Fixed by making interactive layers opt *in* by class
(`.op-screen, .sb, .dbg-root`) rather than being granted by an ID selector, so a child that
declares `pointer-events: none` is believed. `.op-screen` also gained `z-index: 10`, because
a modal state overlay should be above the in-match UI and the HUD is appended to `#ui-root`
later than the pause screen is.

After: all three buttons hit-test to themselves, and `.hud` computes to `pointer-events: none`
as its own rule always intended.

### 2. Pointer lock did not come back on resume

Two failure modes, one fix. Resuming with **Escape** has no user gesture at all, so
`requestPointerLock` can only ever be rejected; resuming with the **button** does have one,
but Chrome refuses a re-lock for a short window after the user has left the lock with Escape,
so it lands inside the cooldown often enough to feel broken.

`Input.armPointerLock(on)` now arms click-to-recapture for the whole time a match is live:
while armed and unlocked, a click re-acquires the lock. That click is **consumed** rather than
passed on — verified: magazine 30 before, 30 after, so the click that gets you back into the
game does not also fire your weapon. Armed in MATCH, disarmed in PAUSED (a click there belongs
to the buttons) and in MENU. The rejection warning is throttled to once per arming so a
platform that refuses lock outright does not fill the console.

### 3. The pistol filled the screen at ADS

Two causes, and the second was the bigger one.

- The shared ADS pose puts every weapon's receiver centre at the same distance. On a 0.17 m
  pistol that is far closer to the eye, in useful terms, than on a 0.75 m rifle.
- **The hands were a rifle's.** `bodyBoxes` placed a support hand and a 0.19 m forearm out on
  the handguard — and the pistol's `handguardLength` is 0, so `supportZ` collapsed back to the
  receiver and put a forearm between the sights and the camera.

Fixed by giving `WeaponModelSpec` an `adsOffsetZ` (pistol: −0.13 m, zero on everything else)
and by holding a weapon with no handguard in two hands *on the grip*. Measured at full ADS,
nearest point of the weapon to the eye:

| Weapon | Nearest point | Silhouette height |
|---|---:|---:|
| WASP 9 | 0.009 m | 0.330 m |
| M4 CARBINE | 0.035 m | 0.349 m |
| **TALON 9** | **0.134 m** | **0.318 m** |
| MONOLITH 60 | 0.189 m | 0.518 m |

The pistol is now further from the eye than seven of the other eleven weapons and has the
smallest silhouette of the twelve.

**A vertical correction was tried first and reverted.** `adsOffsetY: -0.012` moved the sights
12 mm off the screen centre — about 5 degrees at that distance. The sight-height compensation
has already put the sight line on the camera axis, and moving along that axis is the only
correction that does not leave it. `adsOffsetZ` is Z-only for that reason.

### A real bug the pistol measurement exposed

Checking that the fix had not moved the sights turned up that **M5's sight-height compensation
ignored `spec.scale`**. The viewmodel root is scaled, so a weapon at 1.08 has a sight line 8%
higher than its spec says, and the compensation was cancelling the unscaled number. Measured
error ran to 8.3 mm on the MONOLITH — roughly 2.5 degrees, a visibly misaligned sight picture
on the six weapons whose scale is not 1. `WeaponModel.sightHeight` is now the *effective*
height with scale applied; all twelve weapons now measure **−0.61 mm**, identically, which is
the residual of `ViewmodelConfig.adsY` itself. One number to tune, twelve weapons following it.

### Also

Entering PAUSED hides the F1 overlay and remembers whether it was open, because a large
interactive panel over a modal screen is the clash that was reported. The pause menu's DEBUG
OVERLAY button brings it back deliberately, and resuming restores whatever the player last
chose.

`__operator.pointer()` reports `{ locked, armed, keyboardCapture }` — pointer-lock state is
otherwise unobservable from a verification script.

## What Milestone 6 needs to know

**A weapon is still only data.** Twelve exist and none of them is a subclass. If M6's loadout
editor needs a thirteenth, it is a record in `weapons/defs/` and a `WeaponModelSpec` — nothing
else. `ALL_WEAPONS` is the registry and `weaponsOfClass` filters it.

**Attachment resolution is pure and that is load-bearing.** `resolveWeaponDef(base, ids)`
returns a new def every time. A loadout editor may call it per keystroke without caching, and
two players may hold the same base weapon with different attachments — which is exactly what
`verifyAttachmentPurity` checks and what M7's killstreaks must not break.

**`unlockLevel` is authored on all twelve and enforced nowhere**, as S9 requires. The values
run 1 to 38 and are ready for M6 to gate against.

**The inventory has two slots and the swap is `raise`.** `Inventory` drives `Weapon.raise` via
`handlingSeconds` rather than adding a parallel animation state, so `canFire` needed no new
clause — a weapon half-drawn is a weapon at `raise < 1`, which already cannot fire. A third
slot would be `weapons.push` and a new `Btn` bit.

**Equipment damage goes through the one door.** Every `EquipmentDef.damageProfile` is a
`WeaponDef`. A killstreak that wants to hurt somebody should do the same thing rather than
adding a second damage path — M3's note, still true, and now true of explosions too.

**`Perception` has two injection points and both default to null.** `occluder` and
`blindSource` are how smoke and flashes reach the AI. Anything else that should stop a bot
seeing — an M7 counter-UAV, a smokescreen killstreak — implements `SightOccluder` and assigns
it, and every M3 measurement remains a description of the same system with them null.

**The world is still per-match and `MatchEquipment` is new in that mirror.** It subscribes to
seven events and adds a group to the scene; `dispose` drops all of it and nulls the two
`Perception` hooks. The heap harness has not been re-run since it landed — see above.

**`PAUSED` sits beside `MATCH`, not inside it.** The world stays built and `Game.simulate`
returns early. Anything M6 adds that runs on the render pass will keep running while paused,
which is intended for the camera and the HUD and would be wrong for a progression timer.

**Housekeeping.** Twenty-two files are over S3's ~400-line guidance. This milestone split
`WeaponDefs` into six def files, `WeaponMesh` into `WeaponMesh` + `WeaponMeshParts`, `Match`
into `Match` + `MatchEquipment`, and `Hud` into `Hud` + `HudTactical` — but `Game.ts` (769),
`ArsenalHarness.ts` (688), `Match.ts` (681), `Hud.ts` (657) and `AudioGraph.ts` (653) are all
over, and `Game.ts` remains the one to split next along the world-lifecycle seam.
`public/verify/*.js` still ship in a production build — now six files.

### M5 Playtest Feedback (To be implemented DURING M6)
**Firing Range / Testing Map:** The user wants to test the 12 new weapons. 
Please re-enable the M2 grey-box firing range as a dedicated, 
selectable "Shooting Range" game mode in the main menu (with zero enemy bots and active DPS/damage dummies) 
so all weapons can be tested freely once the Loadout system is built.
**Bot Accuracy Scaling:** Although bot aim logic exists, they feel too accurate at long distances. 
Please verify that weapon-specific spread and distance-based accuracy falloff are effectively penalizing bot aim vectors at longer ranges.
**Debug Overlay (F1) UX Overhaul:** Remove the `F1` hotkey binding during active gameplay to prevent pointer lock and UI conflicts. 
The Tuning/Debug overlay should now *only* be accessible via a dedicated button inside the PAUSE menu. 
Add a clear "X" (Close) button to the overlay itself. 
Finally, fix the `ESC` stack: pressing `ESC` while the overlay is open should close the overlay and return to the PAUSE menu, not unpause the game entirely.

## What is playable right now

Drop into Foundry and there are twelve guns to pick from — press F1 and the *Arsenal* panel is
a row of names, and clicking one puts it in your hands with its own silhouette, its own rate,
its own sound and its own recoil. They are genuinely different: the WASP kills in an eighth of
a second inside seven metres and then falls off a cliff so hard it needs seven rounds at
twenty; the LONGBOW takes a quarter second to kill at *any* range up to forty and paints a
zig-zag if you hold the trigger; the KESTREL kills anything you can see with one round in the
chest and gives you 1.25 seconds to regret a miss, with a scope that sways until you hold Shift
and a glint every bot on the map can turn and find. Hang a suppressor on something and your
shots stop lighting up their minimap, at the cost of four metres of range; hang a foregrip on
it and the climb drops by a quarter, at the cost of twenty-four milliseconds of ADS — and the
panel prints the base and the resolved def side by side so you can see exactly what you traded.
Press Q and the pistol comes up in a quarter of a second, which is faster than reloading and is
the whole reason it exists. Hold G and a frag cooks in your hand with a bar under the crosshair
counting down; let go late and it goes off over their cover instead of at their feet, or hold
it too long and it goes off in your hand. Throw a smoke into a doorway and the bots on the
other side stop being able to see through it — actually stop, not visually — and start walking
to where they last heard you. Take a flashbang in the face and the screen goes white and the
world goes behind a wall of wool for three seconds; take one at ninety degrees and it is one
and a bit. Bots throw back, from Regular upward, and they check where their own grenade would
land before they let go. Press Esc and the match *pauses* now instead of ending, with the world
still there behind the glass and a button to open the overlay with a cursor that works. And
under F1 the whole arsenal is one screen: twelve recoil patterns overlaid on one plot, a real
shotgun shell drawn pellet by pellet and coloured by the zone each one found, a grenade arc
traced through the actual physics before you throw it, every sight line on the map drawn green
or red depending on whether smoke is stopping it — and a button that measures the entire
balance table and puts it on your clipboard.

---

# Milestone 6 — Progression and Loadouts

The reason to open the build twice. Mechanically the least interesting milestone and the
one with the most places to be quietly wrong: a number that is not the number gameplay
uses, a perk that reads as an effect and is a cosmetic, a schema bump that eats somebody's
unlocks.

Three ideas carry the whole milestone.

**There is one resolution function.** M5's `resolveWeaponDef(base, attachments)` grew a
third parameter for perk modifiers, and every consumer goes through it — the loadout
editor's stat panel, the debug modifier table, and `Game.buildWorld` on the way into a
match. S6.3's "never a hand-written marketing bar chart that can drift from the actual
values" is therefore not a discipline anybody has to keep; there is nowhere else for a
number to come from.

**There is one save object, and it is repaired rather than reset.** `migrateSave` handles a
*version* change; `normaliseSave` handles *damage* and runs on every load, not only on a
version bump. Both return a list of what they had to touch.

**Progression cannot reach into gameplay.** `MatchProgression` counts events and
`MatchMeta` sets four fields on systems that already existed. Nothing in `meta/` is
consulted by the sim, which is what makes "progression costs nothing in the hot path" a
measurement (0.1 ms p99) rather than a hope.

## What was built

**Meta (`src/meta/`)** — a new package.
`Levels` (the authored 54-row curve, prestige, the badge), `XpRules` (the award table and
the report shapes), `Loadouts` (the slot record, the five defaults, `resolveLoadout`),
`Unlocks` (three gates, the permanent token, `sanitiseLoadout`), `Challenges` (thirty
definitions across five rule kinds), `ChallengeTracker` (the counters and the awards),
`Camos` (six `CanvasTexture` generators, each a different construction), `FieldUpgrades`
(four, each one call into a system that already exists), `SaveData` (`SaveV1`, the
migration, the repair), `Profile` (the one owner of the save), `MatchProgression` (the
per-match tally and the `KillFact` assembler).

**Perks (`src/perks/`)** — a new package.
`PerkDefs` (twelve, three tiers, each declaring its hook by name), `PerkState` (the pure
fold into weapon modifiers plus a flags record), `PerksRuntime` (Scavenger's pickups and
Tracker's trail — the two perks that need a group in the scene), `FieldUpgrade` (the
charge, the key and the four effects).

**Modes (`src/modes/`)** `Range` — the Shooting Range from the M5 playtest notes. `ModeEntry`
grew `populatesRoster`, `unrestricted`, `banksProgress` and `forcedMapId`.

**UI (`src/ui/`)** `LoadoutEditor` (the `LOADOUT` state's screen), `LoadoutStats` (base
against resolved, per stat), `XpSummary` (the animated breakdown and the level-up
flourish), `styles/meta.css`. `Menus` grew a Create-a-Class button, the profile line and
the two-step reset; `PauseMenu` grew a Create-a-Class button; `HudTactical` grew the field
upgrade's charge.

**Root** `MatchMeta` (the composition root for progression and perks), `GameLoadout` (the
loadout-to-match bridge, pulled out of `Game.ts`).

**Debug (`src/debug/`)** `MetaPanel` (progression, the modifier table, challenges, the
EventBus tap, the simulator), `SaveInspector` (S7's four asks), `XpSimulator` (the
projection arithmetic). `public/verify/progression.js` is the acceptance suite.

**Extended, not rewritten** — `Attachments` (`resolveWeaponDef` takes modifiers;
`applyEffects` exported as the single writer of a `WeaponDef` field), `SaveStore` (`touch`,
`replace`, `readRaw`, and a write counter), `ScoreSystem` (assists, off a fixed damage
ledger), `PlayerController` (`speedScale`), `Health` (`overhealth`, `healFull`),
`BotDirector` (`silentFootsteps`), `FlashField` (`resistance`), `WeaponBase`
(`addReserve`), `Inventory` (`all`), `WeaponMesh` (camo material sets),
`DifficultyTiers` + `CombatBehaviour` (the range-error term), `Events` (eight M6 events,
all of them emitted).

## Deviations, and why

### 1. `SettingsV1` moved into the one save object — required by S6.6, and migrated

S6.6's schema puts settings inside `SaveV1`, which means the first launch after M6 would
otherwise reset everybody's FOV, sensitivity and volume. `readLegacySettings` reads the
M1-M5 `operator.settings` blob once, before the store loads, and carries it across. The old
key is never written, so a downgrade still works.

### 2. Bots no longer carry the player's weapon object — a real bug the perks exposed

M5 handed `BotDirector` the same `WeaponDef` the player held. That was harmless when the
object was a base def and stopped being harmless the moment a loadout could fold Quickdraw
into it: the enemy team would have been issued the player's perks. `Game` now owns a third
def, `botWeaponDef`, cloned from the same registry entry. Measured: player ADS 196 ms with
Quickdraw, bots 280 ms, same match.

M5 already leaked *attachments* this way through the arsenal panel; that is fixed by the
same change.

### 3. The account level is derived from XP, never trusted from the save

`normaliseSave` recomputes the level from the XP ledger and reports the disagreement. This
is what makes acceptance criterion 5 hold against the obvious attack: a hand-edited save
claiming level 55 is corrected to the level its XP supports *before* `sanitiseLoadout` uses
that level to decide what may be equipped.

### 4. The default classes are all the same weapon, and that is correct

Everything in the shipped five is legal on a fresh level-1 profile. At level 1 the arsenal
is the carbine and the sidearm and tier 2 is empty until level 5, so all five start with the
same gun and differ in equipment, perks and field upgrade. A default set showing a sniper
the player cannot equip would be silently rewritten by `sanitiseLoadout` on first load, and
a rewritten default is indistinguishable from a bug.

### 5. `meta/` and `perks/` are S3's; `MatchMeta` is not

S3 names both directories. `MatchMeta.ts` sits beside `MatchEquipment.ts` and
`MatchFeedback.ts` for the reason those exist: `Match` is wiring, and a subsystem's worth of
wiring belongs next to it rather than inside it.

### 6. Weapon stats needed more fields than S6.6's sketch

S6.6 gives `weapons: Record<WeaponId, { xp, kills, headshots, unlockedAttachments }>` and
S6.2 asks for "kills, headshots, **accuracy, longest shot, time used**". Accuracy is stored
as its two inputs (`shotsFired`, `shotsHit`) so it can never drift from them, and
`longestShot`, `timeUsed`, `longshots` and `multikills` are added — the last two because the
TIGER and FRACTAL camos measure them.

### 7. Prestige keeps weapon stats and camos

S6.1 says "reset level and unlocks". Weapon kills and earned camos are neither: a player who
ground a weapon to GOLD earned the camo, and taking a hundred kills back would make prestige
a punishment rather than a choice. What resets is the account level and everything gated on
it — verified: VANTAGE SR relocks, the carbine's 120 kills and all six camos survive.

### 8. Field upgrades are four, and each is one call into an existing system

S6.3 lists a field upgrade as part of a class and says nothing about what one does; S9 defers
killstreaks. Hard Rule 1 rules out a dropdown of names, so these four are the ones that could
be built honestly out of what exists: MUNITIONS (`Weapon.addReserve` plus
`EquipmentSystem.refill`), STIM (`Health.healFull`), ARMOUR PLATE (`Health.grantOverhealth`,
a pool absorbed before health and never regenerated), and SMOKE SCREEN (`SmokeField.spawn` —
the same field a thrown smoke uses, so bots stop seeing through it through the M3 perception
path with no new code). Charged by time rather than by score, because score charging needs
the streak plumbing S9 defers.

### 9. Interpretations worth recording

- **`Match.equip`'s camo argument distinguishes `undefined` from `null`.** `undefined` keeps
  the slot's current finish and `null` strips it. Without that, M5's debug weapon picker —
  which calls the method with two arguments and has no idea camos exist — silently returned a
  gold rifle to grey every time the overlay was built. Found by inspecting the material maps,
  not by looking at the screen.
- **Challenge progress is held in memory and banked with the match.** Quitting mid-match
  loses that match's progress, which is the same contract the XP has and what S6.6's "write on
  match end" asks for.
- **`ChallengeTracker` subscribes to nothing.** `MatchProgression` owns the subscriptions and
  builds one `KillFact` per kill; thirty predicates are tested against it. Thirty separate
  subscriptions each rebuilding "was the player sliding" is thirty places for that answer to
  differ.
- **Subscription order is load-bearing and documented.** `MatchFlow` subscribes to
  `entity.killed` before `MatchProgression` does, so the streak read out of `ScoreSystem`
  includes the kill being described. That is what keeps the streak one tally rather than a
  private copy.

## M5 playtest items, closed

**Shooting Range — built.** A real mode: grey-box map, eight dummies, zero enemies, a clock
and a scoreboard about the weapon (hits, shots, accuracy, damage). `unrestricted` lifts every
unlock gate so all twelve weapons are testable, and `banksProgress` is false so nothing done
there can move the account — a range that awarded XP would be the fastest way to level.

**Bot long-range accuracy — retuned.** The note was right and the reason is that a *constant
angular* cone gets easier to shoot inside as range grows. `rangeErrorStart` and
`rangeErrorPerTenM` per tier add degrees past a start range, so nothing inside a room changes
and everything across a yard opens up. Veteran, measured as cone / linear miss radius:

| Range | Before | After |
|---|---|---|
| 10 m | 1.35 deg / 0.24 m | 1.35 deg / 0.24 m |
| 20 m | 1.35 deg / 0.47 m | 1.35 deg / 0.47 m |
| 30 m | 1.35 deg / 0.71 m | 1.90 deg / 1.00 m |
| 40 m | 1.35 deg / 0.94 m | 2.45 deg / 1.71 m |
| 50 m | 1.35 deg / 1.18 m | 3.00 deg / 2.62 m |

**F1 / pause / Esc — done.** F1 no longer opens the overlay; the pause menu's button does.
The overlay has a close button in its header. Esc with the overlay open closes the overlay
and stops, handled in `Game.onEscape` because `Input`'s window listener runs first and
nothing the overlay does could stop it.

## Problems found in the brief

Deliverable 4 asks for these explicitly.

1. **The 200/objective XP row has no producer in any shipped mode.** S6.1's table pays for
   objectives; S9 puts every mode that has one out of scope, and TDM has none. The award path
   is real and driven by `MatchProgression.noteObjective`, which the XP simulator and the
   verification script call — but in normal play the row is always zero and the summary omits
   it. M7's Domination should call it from `onCapture`. This is the one line of S6.1 that
   cannot be exercised by playing the build.
2. **S6.6's `SaveV1` sketch is missing fields S6.2 requires.** See deviation 6.
3. **"Prestige resets unlocks" does not say whether weapon stats and camos are unlocks.**
   See deviation 7; the reading matters a great deal to whether anybody presses the button.
4. **S6.4 lists three perks whose effect is "hook ready for M7".** Their flags are real and
   queried by real functions, and the debug panel labels them inert — but "each one needs an
   actual effect hook in the systems that already exist" and "hook ready for M7" are in
   tension, and three of the twelve are on the wrong side of it. They are the three the brief
   names.
5. **"Field upgrade" is a loadout slot with no specification.** See deviation 8.
6. **Frame-time p99 still cannot be measured honestly in a non-compositing tab.** Same finding
   as M1-M5. The numbers that describe this build are the sim-side costs.

## Verification

`fetch('/verify/progression.js').then(r => r.text()).then(eval)` then
`await __verifyProgression.all()`; see DEBUG.md. Everything below was measured on this build.

| Criterion | Result |
|---|---|
| 1. XP per the table, animated, with a level-up | A full match with 22 kills banked **+3,565 XP** and took the profile from level 1 to **level 5**. The breakdown animated in six rows — Kills x22 +2,200, Headshots x9 +225, Longshots x8 +240, Challenges x1 +100, Weapon levels +250, Best streak x22 +550 — and the total matches the amount banked exactly. The flourish fired on the crossing and read **"LEVEL 5 · UNLOCKED · DEAD SILENCE"**. Every figure is the S6.1 rate times the count. |
| 2. Five slots, persistent, and what actually spawns | Slot 3 renamed PERSIST with smoke and Dead Silence, equipped, then the page reloaded: **level 5, 3,565 XP, equipped index 2, name PERSIST, lethal smoke, perks [-, dead_silence, quickdraw]** all survived. In the match that followed, the player's ADS was **196 ms** (Quickdraw) while the bots' was **280 ms** — the equipped class is what spawned, and only on the player. |
| 3. One resolution function | Fitting the foregrip moved **ADS 196 -> 213 ms** and **vertical recoil 1.000 -> 0.750** in the same resolve the match consumes, with the base def byte-identical afterwards. The editor's panel and the debug modifier table both read that one call; there is no second computation to disagree with it. |
| 4. Twelve perks, measured | All twelve change something, measured through the systems that carry them. **Lightweight** through the real `PlayerController` in the headless harness: walk **4.600 -> 4.922**, sprint **6.900 -> 7.383**, crouch **2.800 -> 2.996**, tac sprint **8.200 -> 8.774** — exactly **+7.00%** on every mode. **Quickdraw** ADS **280.0 -> 196.0 ms** (-30%). **Sleight of Hand** reload **2050.0 -> 1332.5 ms** (-35%). **Amped** swap-in **520 -> 312 ms** (-40%). **Battle Hardened** flash intensity **1.000 -> 0.400x**. Scavenger, Tracker and Overkill flip their state flags; Ghost, Cold-Blooded and Hardline flip theirs and are labelled inert. |
| 4. Dead Silence against bot perception | Driven through the *real* `player.footstep` event and the director's own subscription: ungated, the noise field's serial advances; with the perk's gate installed, **it does not advance at all**. The step still sounds for the player — it is the enemy's hearing that is cut. |
| 4. Scavenger and Tracker, live | Six bot deaths dropped **7 pickups**; standing on one granted exactly **one magazine (30 rounds)**, incremented the collected counter and emitted `perk.scavenged` at the body's position. Tracker accumulated **136 footstep points** from enemy steps only, with the point cloud visible. |
| 5. Unlock gates | A save edited to name a locked weapon **and** to claim level 55: the level was corrected to **1** ("profile.level 55 disagreed with 0 XP"), and the weapon was then refused — *"ASSAULT primary ar_vulcan is locked (LEVEL 6); reverted to ar_carbine"*. Both reported, neither silent. |
| 6. Challenges and camos | Thirteen challenges accrued from one match's real events across five rule paths. **Three different rule kinds completed**: `kill` (FIRST BLOOD, REACH OUT, FROM THE HIP), `weaponBest` (DIGITAL, SPLINTER, TIGER, FRACTAL, GOLD), and `camoSet` (OBSIDIAN, which requires the other five and cannot be reached any other way). **All six camos unlocked**, and the gold pattern is on the viewmodel's receiver and furniture (256 px camo maps in place of the 128 px base, glove unchanged). |
| 7. Migration | The hand-written V0 payload through the real `migrateSave`: **xp 42,000 -> 42,000 (level 15), prestige 1 -> 1, ar_carbine 312 -> 312 kills, fov 103 -> 103, class 2 primary smg_wasp -> smg_wasp**, and the retired `ar_retired_prototype` **dropped and reported**. Then a save damaged in eight ways at once recovered with **seven repair lines** and no data loss beyond what was broken — a non-numeric XP, a level that contradicted it, a null weapon record, an unknown weapon, an unknown camo, a retired challenge, an unknown weapon id in a loadout, and a perk in two wrong tiers. |
| 8. Save write frequency | **One write per match**, plus one at page load. Two full matches back to back took the counter **1 -> 2 -> 3**. Counted at the point of writing rather than at the calls that might cause one, so a coalesced burst is one write. |
| 9. Frame time | `MatchMeta.simulate` over 12 s of a live ten-bot firefight: **p50 0.0 ms, p95 0.1 ms, p99 0.1 ms, max 0.1 ms**. Sim total p99 **2.4 ms** against S4.7's 3.0 ms budget, mode peak 0.2 ms, HUD peak 1.1 ms. See the frame-time caveat below for why the frame percentiles are not this build's. |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`, zero TODOs. |
| 10. Console | Clean across two full matches and three reloads: Vite's own messages, the `[Profile]` info line, and the embedded pane's `WrongDocumentError` pointer-lock rejection that M5 already documented. No errors, no new warnings. |
| S7. Pacing | 3,120 XP a match at the simulator's average performance. **Level 10 at match 5, level 20 at match 24, level 30 at match 59, level 55 at match 217 (36.2 h)**. Every weapon unlock lands inside the first 99 matches; the stretch past 40 is the wall prestige exists to make meaningful. |

### The frame-time caveat, again

The Browser pane reports `visibilityState: "hidden"` and never composites, so
`requestAnimationFrame` never fires on its own. The measurements substitute the frame source
with a `MessageChannel` the way M4 and M5 do — which drives the real loop, sim, damage path,
mode and audio graph — but the resulting frame percentiles (p50 3.3, p95 37.4, p99 41.0 ms)
are mostly the source and the environment. The numbers that describe this build are the
sim-side costs above, and `Meta ms` in particular: **0.1 ms at p99 is a rounding error against
a 3.0 ms budget**, which is what criterion 9 is asking about.

### Bugs found by verification, and fixed

1. **The arsenal panel silently stripped camos.** `ArsenalPanel` calls `Match.equip` on
   construction to sync its picker, with no camo argument — so building the debug suite
   returned a gold rifle to grey. Found by reading the material maps off the viewmodel rather
   than by looking at it, which is the uncomfortable part: nothing on screen would have said
   so in a non-compositing pane. `equip`'s camo parameter now distinguishes "keep" from
   "clear".
2. **The XP breakdown printed "Challenges x100" for a single 100 XP completion.** The row's
   count held its XP. It now counts challenges and reads its total from the tracker — the one
   row in the table whose XP is data rather than a rate.
3. **`normaliseSave` dropped two classes of damage silently.** A non-numeric `profile.xp` and
   a weapon record that was not an object were both repaired without a loss line. Found by
   corrupting a save and counting the reported repairs against the damage done.

### Left for the human

The pane never composited, so **nothing below was seen**. These need eyes:

1. **The level-up moment.** It is the payoff S6.1 asks for weight and timing on: rows landing
   on a 0.34 s cadence with a blip that climbs a fifth, the bar filling at one level per 1.1 s,
   then the interrupt — bar to the edge, flourish scaling in, a three-layer sting with a low
   body an octave under the sweep. Every number is at the top of `XpSummary.ts`.
2. **Six camos as pictures.** They were authored as six different *constructions* rather than
   six recolourings — aligned digital blocks, straight-edged splinter shards, warped tiger
   stripes, posterised fractal noise, brushed gold with a specular sweep, and lit Voronoi
   facets for obsidian. Whether they read as six things at viewmodel distance is unverified.
3. **The loadout editor at a glance.** Three columns, eleven accordion rows, and a sticky stat
   panel. The layout has been exercised in code and never rendered.
4. **Scavenger's pickups and Tracker's trail.** Both draw into the scene — a bobbing amber
   magazine that blinks in its last three seconds, and a point cloud that cools from accent to
   ember over nine seconds. Legibility at speed is not something a DOM assertion can answer.
5. **Bot long-range accuracy, as felt.** The table above says the cone doubled by 45 m. Whether
   that is the difference between "punishing" and "fair" is Hard Rule 3, and it is four sliders
   under F1 (`rangeErrorStart` and `rangeErrorPerTenM`, per tier).
6. **`__operator.runMatches(10)`** with progression live. `MatchMeta` and `PerksRuntime` are
   new things in the per-match mirror and both could leak; the heap harness has not been re-run
   since they landed.

## What Milestone 7 needs to know

**The three inert hooks are ready and named.** `PerkState.visibleToUav`, `.targetedByStreaks`
and `.streakDiscount` are real fields, folded by `resolvePerkState`, reported in the F1 panel
and labelled inert. A UAV asks the first, a sentry's target selection asks the second, and a
streak's requirement subtracts the third. Nothing else needs to change for Ghost, Cold-Blooded
and Hardline to start working.

**Damage still has exactly one door, and now so does modification.** `applyEffects` in
`weapons/Attachments.ts` is the only function in the project that writes a `WeaponDef` field.
A killstreak that buffs a weapon should pass an `AttachmentEffects` to `resolveWeaponDef`
rather than reaching for the def — and if it does, the loadout editor and the debug panel
report it for free.

**The objective XP path is waiting for a caller.** `MatchProgression.noteObjective(count)`
exists, is exercised, and is called by nothing in a shipped mode. Domination's `onCapture` and
Kill Confirmed's tag pickup are its intended callers; S6.1 already prices an objective at 200.

**A mode declares four things about progression.** `ModeEntry` carries `populatesRoster`,
`unrestricted`, `banksProgress` and `forcedMapId`. A new mode that forgets them gets the
defaults it should — bots, gated content, progress banked, any map — and the Shooting Range is
the one entry that says otherwise.

**The profile is process-wide; everything else is per-match.** `Profile` outlives every match
and is a direct handle on the console API for that reason. `MatchMeta` and `PerksRuntime` are
in the per-match mirror and both dispose: `MatchMeta.dispose` clears the three system hooks it
installed, because a perk predicate that outlives its match is exactly the leak shape M4's heap
harness was built to catch.

**Write on an event, never on a tick.** Every mutator on `Profile` ends in one `store.touch()`
and `SaveStore` coalesces. If M7 adds something that changes the save, put it behind a method
on `Profile` rather than reaching for `store.value` — the write counter is what acceptance
criterion 8 is read from and it only means something if there is one door.

**Housekeeping.** `Game.ts` is **905 lines** and remains the project's largest file and its
outstanding architectural debt. M6 took the cheap half of the split — `GameLoadout.ts` — and
deliberately left the expensive half: the world lifecycle (`buildWorld` / `teardownWorld` and
the six per-match fields) is woven through `simulate`, `draw`, the state handlers and eight
getters, and moving it is a ~30-call-site refactor of the hot path that deserves its own pass
rather than the end of a milestone. **That is the M7 job, and it should be done first.**
`Match.ts` is 796. Twenty-five files are over S3's ~400-line guidance.
`public/verify/*.js` still ship in a production build — now seven files.

### Critical Hotfixes (Action Required IMMEDIATELY after the Game.ts Refactor)
**Global Loadout Bug:** Selecting a weapon in Create-a-Class currently equips it on all bots in the match. 
Bots must retain their own independent, randomized (or tier-based) weapon loadouts. 
Fix the combatant instantiation so loadouts are strictly isolated per-actor.
**ADS Visibility & Opaque Sights:** The SMG sight/optic is rendering opaque, blocking the target entirely. 
The pistol viewmodel is still sitting too high and obscuring the target. 
Fix the optic material transparency/clipping and adjust the pistol's `adsY`/`adsZ` again for clear line-of-sight.

### M6 Playtest Feedback (To be implemented DURING M7)
**Shooting Range Overhaul:** 
  1. Force all weapons and attachments to be temporarily UNLOCKED when in the Shooting Range mode.
  2. Add a new "Infinite Health" dummy specifically for continuous DPS testing without it dying.
  3. Add a dedicated spread-testing wall/target that clearly retains bullet decals for accuracy testing.
  4. Expand the greybox room into a proper firing range layout (lanes, moving/falling targets, infinite DPS dummy area).
**Weapon-Aware Bot AI:** Bots currently do not adjust their playstyle to their weapon. 
Update `CombatBehaviour` so bots actively try to close the distance if holding a Shotgun/SMG, or maintain distance if holding a Sniper/AR.

## What is playable right now

Press Play and the menu now tells you what level you are and how far the next one is. Create
a class and you get five slots that are yours: a weapon, the attachments that weapon's own
kill count has earned, a camo when you have earned one, a sidearm, a lethal, a tactical,
three perks one per tier, and a field upgrade — and on the right of the screen, the actual
resolved rifle, so fitting a foregrip shows you 196 to 213 milliseconds of ADS and a quarter
less climb, because that is the same object the gun will be built from. Most of it is locked,
struck through with what it costs, which is the point. Then you play, and the things you do
are counted: a kill, a headshot, a shot past thirty-eight metres, two kills on one magazine, a
five-streak. When the match ends the summary fills in a row at a time with a blip that climbs,
the bar walks along behind it, and if you cross a level the bar slams into the right edge and
the whole thing stops to tell you that dead silence is now yours. Take it: your footsteps stop
existing to every bot on the map. Or take lightweight and run seven percent faster at
everything, or quickdraw and get your sights up in under two hundred milliseconds, or
scavenger and watch magazines drop off the bodies you leave behind so you can walk over them
and keep going. Press X when the corner of the HUD fills up and you get your ammunition back,
or your health, or fifty points of armour, or a smoke cloud on your own position that the
enemy genuinely cannot see through. Grind one weapon and it goes digital, then splinter, then
tiger, then fractal, then gold — and when it has all five it goes obsidian, which you cannot
get any other way. All of it survives closing the tab, and if the save is ever damaged the
game tells you exactly what it had to repair instead of quietly starting you over. There is a
shooting range now too, where every weapon is unlocked, nothing counts, and nobody shoots
back. And under the pause menu the overlay will show you every perk as a before and after,
every challenge as a fraction, every event the match has fired, and a button that plays four
hundred matches in a millisecond and tells you it takes thirty-six hours to reach fifty-five.

---

# Milestone 7 — Killstreaks and Modes

Six killstreaks and four game modes, plus the refactor and the two hotfixes PLAN.md demanded
before any of it, and the M6 playtest items that were scheduled to land during it.

## What was built

**Root** — `MatchWorld.ts` (the per-match world lifecycle, lifted out of `Game.ts`),
`GameScreens.ts` (the front end), `MatchObjectives.ts` (flags, rings, tags and the bomb as
things in the world).

**Streaks (`src/streaks/`)** — a new package.
`KillstreakBase` (`onEarn`/`onActivate`/`onTick`/`onExpire` and the `StreakContext`),
`StreakDefs` (six definitions plus every tuning number), `StreakSystem` (earning, spending,
the three perk hooks, and the care-package objective provider), `Uav`, `CounterUav`,
`CarePackage`, `MortarStrike`, `SentryGun`, `ChopperGunner`, `StreakAudio` (the vocabulary,
composed from M2's two primitives), `StreakWeapons` (synthetic `WeaponDef`s so streak damage
goes through the one door).

**Modes (`src/modes/`)** — `Domination`, `KillConfirmed`, `FreeForAll`, `SearchAndDestroy`,
`ObjectiveZone` (the capture maths flags and bomb sites share).

**AI (`src/ai/`)** — `BotArsenal` (per-tier weapon draw), `WeaponProfile` (how a bot fights
with what it is holding), `ObjectiveIntent` (the seam that lets bots play objectives without
`ai/` importing a mode). `BotStates` gained `OBJECTIVE`; `BotBrain` gained `tryObjective` and
`tryFallBack`.

**UI (`src/ui/`)** — `HudStreaks` (the streak strip and the objective banner), `MortarOverlay`
(the targeting map). `Minimap` gained UAV contacts, the sweep beam, Counter-UAV interference
and flag ownership.

**Debug (`src/debug/`)** — `StreakPanel` (streak state, sentry targeting, care-package
contest, and a button per streak). `AiPanel` gained objective intent; `DebugOverlay` and
`FrameStats` gained streak ms and entity count; `BotHarness` gained a `mode` flag.

**Extended, not rewritten** — `ScoreSystem` (`captures`/`defends`/`plants`/`defuses`/`tags`
and `recordObjective`), `Renderer` (`renderThermal`), `Events` (fifteen M7 events, all
emitted), `Decals` (capacity 96 -> 192), `TargetDummy` (`infinite` and `faller`),
`TargetRange` (6 dummies -> 12), `greybox` (accuracy wall and lane stripes), `HitboxRig`
(`buildLayout` exported so a sentry can have its own rig).

## Deviations, and why

### 1. `Game.ts` was split twice, and the second half was not asked for

PLAN.md named the world lifecycle. Doing only that left 810 lines, so the front end went to
`GameScreens.ts` as well. 905 -> 770 + 280 + 144. The point was never line count: six fields
that were only ever all-present or all-absent became one `MatchWorld | null`, so the hot path
asks once instead of four times and `MatchWorld` itself has no optional members.

`game.map` and `game.player` became **public getters**. Six shipped `public/verify/*.js` read
those names, and TypeScript's `private` is compile-time only — the move would otherwise have
broken them silently.

### 2. `botWeaponDef` was renamed `playerBaseDef`, because the name was the bug

M6 fixed half of the loadout leak: it isolated attachments and perks but still handed bots
`loadout.primaryBase`, so equipping a sniper armed all nine. Bots now draw their own weapon
per tier from the director's seeded `Rng`, and the object M6 introduced is renamed for what it
actually is — the base of the *player's* primary, read only by the M6 modifier panel.

### 3. Iron sights are built relative to the sight line, not the rail

The rail-relative version used absolute box sizes authored against the AR's 0.082 m receiver.
On the pistol that put the sight line *inside* its own front and rear sight bases. Deriving
every block from `sightHeight` makes the aperture clear by construction on all twelve weapons.
The pistol's `sightHeight` went 0.042 -> 0.062, which also fixed the "sitting too high" pose:
ADS holds a weapon `sightHeight - 0.0915` lower, so a sight line 50 mm under the reference
lifted the whole gun up the screen.

### 4. A scoped weapon hands off to the scope overlay

A scope tube is a solid cylinder 0.17 m from the eye and was filling the clear centre of the
scope picture — the same defect as the red dot, unreported only because snipers unlock late.
Past `SCOPE_VIEWMODEL_HIDDEN` the viewmodel stops drawing and the overlay is the picture.

### 5. Free-for-All keeps the two-team substrate

`ScoreTeam` is `'A' | 'B'` and spawn safety, perception and the killfeed are all written
against it. FFA splits eight players across the two sides and makes the split *irrelevant*:
the win condition scans individual rows, the banner shows the best individual per side, and
there is no team-kill penalty. Rewriting the M4 foundation for one mode was the wrong trade,
and the brief says extend rather than rewrite.

### 6. The mortar is marked before it is spent

Pressing the key opens the overlay; the streak is consumed only on confirm. Cancelling keeps
it. A streak spent on a mis-click is a streak the player did not get to use.

### 7. Care packages ride a second objective-provider slot

A crate is contestable in *every* mode including Team Deathmatch, so it cannot be the mode's
business. `BotDirector` holds the mode's provider and the streak system's, and `BotBrain`
takes whichever offers the higher priority.

## Bugs found by running it

Three, and two had been latent since M3.

1. **`LOW_MAGAZINE` was an absolute 8.** Invisible while every bot carried the 30-round
   carbine; a hard lock the moment `BotArsenal` dealt a shotgun. A full 6-round magazine is
   already "low", so the bot asked for RELOAD on every decision — and `IDLE -> RELOAD` was not
   a legal edge, so it never left IDLE. Nine bots stood still for an entire match. Now
   `LOW_MAGAZINE_FRACTION = 0.28`, which reproduces the carbine's 8 exactly so no M3
   measurement moves, and the edge is legal.
2. **`OBJECTIVE` was not a firing state.** Bots crossed firefights with the trigger disabled.
   Found the first time S&D ran: defenders strolled past the attackers who had just planted
   and defused unopposed, five rounds out of five.
3. **The objective check sat after the target branch.** `hasTarget && !seeing` falls into
   SUPPRESS and returns, so a defender that had merely *heard* somebody never reached the
   check and never went for the bomb. Moved above the branch, with the priority gate deciding.

## Problems found in the brief

1. **"Best of 9 rounds, sides swap at 5" cannot always show the swap.** First to five ends a
   5-0 sweep *at* round five, so the swap after round five never runs. The rule is
   self-consistent; the swap is simply unreachable in a sweep. Verified directly instead —
   see below.
2. **Search & Destroy rounds are deterministic.** A fixed `AI_SEED` plus an identical round
   reset means rounds 2-5 replay round 1 almost exactly, so a bot-only best-of-nine is a sweep
   rather than a mixed match. Per-round spawn variation would fix it; it is not in this
   milestone.
3. **FFA's eight sides do not exist underneath.** See deviation 5.
4. **"The player body is out of play but not invulnerable to a lucky mortar"** is the clearest
   line in S6.1 and it is what forced the chopper's design: the body is left registered,
   visible and damageable, and only its *input* is taken away.
5. **The Shooting Range unlock note was already satisfied in M6** for both weapons and
   attachments — but the editor gates on the *currently selected mode*, so opening
   Create-a-Class while TDM is selected shows locks. Selecting the Range first works. Worth
   knowing before it is reported again.

## Verification

Everything below was measured on this build. The frame-time caveat from M1-M6 still applies
and is restated at the end.

| Criterion | Result |
|---|---|
| 1. Six streaks earn, activate, function, expire | All six activated and all six expired cleanly in one match. Care package **claimed by bot #102**. |
| 1. Hardline | Every requirement drops by exactly one: **4/5/5/7/8/12 -> 3/4/4/6/7/11**. |
| 1. Ghost | Player **absent** from an enemy UAV sweep while **4 other contacts still record** — the sweep is working, only the player is hidden. |
| 1. Cold-Blooded | Enemy sentry targeted the player **71 ticks / 6 shots** with the perk off; **0 ticks / 0 shots** with it on, nearest other combatant 21.5 m away in both runs. |
| 2. Chopper returns control | Three exits, all clean, no throws: **player killed mid-streak**, **match ended mid-streak**, **`endAll` during takeover**. Camera returned and 0 live streaks in every case, and the body stayed a registered damageable. |
| 3. Modes play to completion | DOM, KC, FFA and S&D all run; S&D plays a **full best-of-nine to SUMMARY**. |
| 4. Bots play the objective | **Domination: 13 bot captures**, roster split **4 capturing / 5 defending**. **Kill Confirmed: 51 tags dropped, 48 collected — 34 confirmed, 14 denied**. **S&D: plants and defuses both non-zero.** |
| 5. S&D one life | **Zero respawns during a live round** across a full best-of-nine; round transitions clean. |
| 6. Spawn safety after a swap | Spawn zones genuinely flip — team A mean spawn Z **+9.9 -> -8.3**, team B **-7.5 -> +9.3** — the round tally swaps, and afterwards **120 selections, minimum enemy distance 41.77 m, zero cone violations, zero visibility violations**. |
| 7. Sentries use the bot aim model | **2 hits / 29 shots = 6.9%**, 27 misses, against moving bots. At point-blank on a stationary target it lands 6/6, which is the same model behaving as it should. |
| 8. Heaviest scene | Chopper active + 2 sentries + 10 bots: **streak cost 1.10 ms peak**, mode 0.30 ms peak, HUD 1.50 ms peak, 3 streak entities. Frame p50/p95/p99 **3.1 / 22.9 / 27.6 ms** over 600 samples — see the caveat. |
| 9. Three matches, three modes, heap at each boundary | DOM -> KC -> SND: **29.04 -> 32.93 -> 37.95 -> 34.79 MB**, delta **+5.75 MB**, and the third boundary *fell* 3.16 MB. No monotonic growth. |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`. |
| 10. Console | Clean across TDM, DOM, KC, FFA and S&D — five modes built and torn down with zero errors and zero non-pointer-lock warnings. |
| Range overhaul | 12 dummies (3 movers, 2 fallers, 1 infinite). Infinite dummy **absorbed 2700 damage without dying** and tracked DPS. Unlock gate at a fresh level-1 account: a normal match locks **10/12 weapons and 5/5 carbine attachments**, the Range locks **none of either**. |
| Weapon-aware bots | Controlled single-class rosters: **shotgun median 9.0 m** (max 13.5), **sniper median 23.3 m** (max 51.5). Mixed roster: SMG 12.7 m, AR 20.4 m. |
| Bot loadout isolation | Player holding `sniper_vantage`, **0 of 9 bots** carrying it, five distinct bot weapons, tier-appropriate. |
| Sight lines | Ray-tested against the real viewmodel triangles at full ADS on all twelve weapons. Irons: centre ray hits the front blade, **clear at +/-5 and +/-6 mm**, notch posts at +/-10 mm. Red dots: **no opaque hit at any offset**. |

### Caveats worth stating plainly

**Frame percentiles are still not this build's.** The Browser pane reports
`visibilityState: "hidden"` and never composites, so `requestAnimationFrame` never fires and
the measurements substitute a `MessageChannel` frame source — the same workaround M4, M5 and
M6 used. That drives the real loop, sim, damage path, streaks and mode, but the resulting
frame numbers are mostly the source. **The numbers that describe this build are the sim-side
costs**: streak entities at 1.10 ms peak in the heaviest scene the brief could name, against
S4.7's 3.0 ms budget for all game logic.

**The heap run's matches were short.** Chrome throttles a tab that has been hidden for a
while, and the loop starved to about half a sim second per match. What the run therefore
measures is **build and teardown across three different modes**, which is what actually
leaks — the map, navmesh, collision hash, roster, HUD, streak entities and every subscription
are constructed and disposed three times. It is not a measurement of three *played* matches.

**Nothing here has been seen.** The pane does not composite, so no screenshot exists of the
thermal pass, the flag rings, the dog tags, the mortar overlay or the streak strip. Every
visual claim above is a DOM assertion or a geometric ray test, not a picture.

### Left for the human

1. **The thermal pass.** Whether a body reads as hot against cold terrain, and whether the
   depth ramp is legible at 40 m. `Renderer.renderThermal` is two small fragment shaders.
2. **The mortar overlay's feel.** `MORTAR_STEER_M_PER_RAD` is 42, tuned so a quarter-turn
   crosses Foundry. Whether that is precise enough to pick a doorway is a hands-on question.
3. **The streak strip and objective banner at a glance.** Both are built and driven by real
   state; neither has been looked at.
4. **The accuracy wall.** The whole point is comparing two groups by eye.
5. **Sentry feel.** 6.9% against moving targets is deliberately fallible. Whether it reads as
   "a turret I can push past" or "a turret that does nothing" is Hard Rule 3, and every number
   is in `DEFAULT_STREAK_CONFIG`.

## What Milestone 8 needs to know

**Streaks are entities with one exit.** `Killstreak.onExpire` is the only teardown, it is
idempotent, and `StreakSystem` guarantees it runs on the timer, on the owner's death, on
`MatchEnded`, on `RoundEnded` and on `dispose`. Anything M8 adds that takes over the camera
should copy that shape exactly — two things that can restore state are two things that can
disagree about whether it has been restored.

**`ObjectiveIntent` is the seam for bot behaviour.** A mode (or a streak) answers "where
should this combatant be and what should it do there"; `ai/` never imports either. A new mode
gets bots that play it by implementing two methods.

**The two-team substrate is load-bearing.** FFA works by making it irrelevant, not by removing
it. Anything that needs genuine N-way sides has to change `ScoreTeam`, `Combatant.team`,
`SpawnSelector`, `Perception` and the killfeed together.

**Determinism cuts both ways.** A fixed `AI_SEED` makes regressions reproducible and makes S&D
rounds repeat. If M8 wants varied rounds, vary the spawn selection per round rather than the
seed, so the *match* stays reproducible.

**Housekeeping.** `Game.ts` is 770 lines, `Match.ts` is 1050 and is now the largest file — the
same shape `Game.ts` had before this milestone, and the obvious next split is the per-frame
HUD filling. Thirty files are over S3's ~400-line guidance. `public/verify/*.js` still ship in
a production build.

### M7 Backlog & Polish (To be addressed alongside or before M8)
**Free For All (FFA):** Bot colors and minimap IFF need fixing. 
All bots must render as orange (enemies), and no friendly dots should appear on the radar.
**Search & Destroy (S&D):** Requires a stricter round loop. 
Change bomb interaction key to 'T'. 
Bomb must be manually picked up at spawn and manually planted. 
Rounds must end immediately upon defuse/explosion, followed by a hard reset where all players respawn at their bases.
**Chopper Gunner:** Fix the thermal shader to grayscale so the map is visible. 
Fix IFF so teammates appear dark and only enemies glow orange. Ensure the Chopper uses its own infinite ammo pool, not the player's weapon ammo.
**Shooting Range:** Spread the accuracy targets horizontally so they don't block each other. 
Ensure bullet decals render properly on these targets. Fix dummy placement clipping (e.g., Infinite DPS dummy spawning inside the ramp geometry).

## What is playable right now

Pick a mode and the game is a different game. Domination puts three flags on Foundry with a
ring on the floor around each one, and the bots genuinely fight over them — some rotate, some
stay home, and the flag you are standing on fills a bar over your crosshair while it changes
hands. Kill Confirmed litters the floor with dog tags that spin and bob and blink when they
are about to vanish, green ones you grab to deny and red ones you grab to score, and bots do
both. Search & Destroy gives you one life, two bomb sites and a best-of-nine, and a planted
bomb starts a light blinking faster and faster while a timer counts down over the crosshair.
Free-for-All is seven other operators and no friends. Underneath all of it, four consecutive
kills gets you a UAV and the minimap starts sweeping — a beam going round with enemies lighting
up as it crosses them and fading before it comes back — unless somebody drops a Counter-UAV and
your map dissolves into bands of interference. Five gets you a care package that falls out of
the sky on a beacon and can be stolen by anybody who stands on it for three seconds. Seven
opens a full map of Foundry you steer with your mouse to drop twelve shells in sequence.
Eight puts a sentry down that misses about as often as a Hardened bot does, which is the point,
and can be shot off its legs. Twelve takes the camera away entirely: you are in a gunship
orbiting the map looking through thermal optics with everything living glowing white, holding a
minigun that winds up before it reaches full rate — and your body is still standing where you
left it, still killable. Take Hardline and every one of those numbers drops by one. Take Ghost
and you stop appearing on their radar. Take Cold-Blooded and their sentries look straight
through you. And the shooting range is a real range now: twelve targets, a dummy that cannot
die so you can measure sustained damage, two that fall over when a burst kills them, a clean
wall at a measured twenty-five metres to shoot groups into, and every weapon and every
attachment unlocked while you are in there.

---

# Milestone 8 — Content and Polish

Two maps, a settings screen where everything does something, the polish pass, and the
hand-over tooling. The organising idea of this one is the brief's own line about settings —
*"a setting that does not do anything is worse than a missing setting"* — applied to the
whole milestone. Nothing here is a placeholder for something the next milestone would
finish, because there is no next milestone.

## What was built

**World (`src/world/`)** — `maps/dunes.ts` (desert village), `maps/depot.ts` (night cargo
yard), `Particulate.ts` (camera-following mote cloud, one draw call). `NavGrid` and
`NavBake` gained **climb links** and **drop links**, per-map layer counts and the
`climbFrom` / `dropFrom` queries behind them. `maps/types.ts` gained `LaneDef` (lifted out
of `foundry.ts`), `ParticulateDef`, `navLayers`, `navClimb`, and per-map shadow overrides on
`LightDef`. Six new materials and eight new prop shapes.

**Core (`src/core/`)** — `Keybinds.ts`: the bindable action table, the compiled
input-to-bits map, and the rebinding logic. `Input` now resolves *every* physical input —
keyboard, mouse buttons and the wheel — through it, including the movement axes, and gained
a separate ADS sensitivity multiplier blended by the sights' own animation fraction.

**Engine (`src/engine/`)** — `AudioMix.ts` (per-source levels and per-category distance
curves), `MotionBlur.ts` (optional two-target accumulation blur). `Renderer` gained live
shadow tiers; `AudioGraph` gained per-sound distance profiles and a third muffle
contributor for concussion.

**UI (`src/ui/`)** — `Settings.ts` (four tabs, every control wired), `Palette.ts` (the
gameplay colour vocabulary and its three colourblind variants), `FpsCounter.ts`. `Minimap`
and `MatchObjectives` read the palette instead of literals; `hud.css` gained the two
custom properties that let twenty existing rules follow it.

**Debug (`src/debug/`)** — `SnagHarness.ts` ("sprint every wall", derived from the collision
world), `Handover.ts` (the four exports S6.5 asks to hand over, plus the allocation probe).

**Meta** — `SettingsV1` grew eleven fields and the save went to **v2** with a real
`upgradeV1`.

## Deviations, and why

### 1. Climb links arrived with drop links, and both are opt-in per map

The brief asks to "revisit the M3 navmesh baking for the stacked-crate edges". The obvious
change is a link class for ledges a mantle can take. Shipping only that would have been a
worse bug than the one it fixes: a bot that mantles onto a container has an inbound edge and
no outbound one, so it patrols up there once and stands on it for the rest of the match.
`mantleHeight` and `dropHeight` are therefore one feature, enabled together by
`MapDef.navClimb`, and **only Depot sets it** — so Foundry, Dunes and the grey-box testbed
bake exactly the graph M3 baked and six shipped verification suites still mean what they
meant.

### 2. `SaveV1` became `SaveV2`, and the settings type did not get renamed

The save version is on the save. Renaming `SettingsV1` alongside it would have been a rename
with no migration behind it, and the block genuinely is "the settings of save v2".

### 3. Motion blur allocates render targets, which the renderer said it would not

`Renderer`'s own note says there is no post-processing stack, and with the setting off there
still is not — `MotionBlur` is constructed on the frame the player enables it and disposed on
the frame they turn it off. The alternative readings of S6.3 were a toggle that does nothing
(explicitly the worst outcome the brief names) or `preserveDrawingBuffer: true` on the
context, which is a construction-time cost paid by every player including the ones who never
touch it.

### 4. Dunes has one accessible rooftop, which is Depot's identity

Depot owns verticality and Dunes deliberately does not compete: it has exactly two perch
roofs, one per half, reached by one external stair each. A desert village with no roof at
all reads as a maze of monoliths, and two is few enough that the contrast with Depot's
four-height vocabulary survives.

### 5. The lane audit runs at module load and throws

`depot.ts` ends with `auditLanes()`, which throws with the offending stack's coordinates if
any container, stacked box or ladder foot intrudes on a lane corridor. This is not
defensive programming for its own sake — see the bugs below.

### 6. Own-weapon and own-footstep levels were cut

`MIX.ownWeapon` is 0.62 and `MIX.ownFootstep` is 0.5. Both are deliberate reductions to
sounds the player already has information about, and they are what buys the headroom an
enemy rifle needs. See the arithmetic in `engine/AudioMix.ts`.

## Bugs found by running it, and fixed

Six, and five were found by measurement rather than by reading.

1. **Depot's lanes measured a 109% spread.** Two containers and a gantry leg were sitting
   in lane corridors — one lane 27 m, another 57 m. The map was re-laid around three
   explicit 3.5 m corridors and the audit in deviation 5 was added so the same mistake
   throws at import time instead of costing four seconds of walk. Now 0.0%.
2. **Every upper navmesh layer on Depot was empty after the prune.** The upper box of a
   two-high stack sat squarely on the lower one, so the lower roof was covered along its
   whole length, had no standing headroom anywhere, and never became a node. Nine bots
   spent a fifty-eight second match on the ground and the map's entire reason for existing
   did not exist. The upper box is now offset 2.8 m along its own length, leaving a ledge.
3. **Dunes' perch stair ran underneath its own roof overhang.** A ramp that has to reach
   3.4 m under a 3.05 m ceiling has no headroom for its top third; the bake refused those
   cells and the perch was unreachable. Found by the cover-rejection count, which was
   throwing away the parapet points because nothing could stand on the roof to use them.
   The stair now climbs from the south, clear of the roof's z-span.
4. **`COVER_PROFILES.barrels` had understated its own footprint since M4.** The shape is a
   *pair* of drums 1.46 m across and the profile said 1.1, so the derived cover point sat
   0.44 m from a 0.35 m capsule and the navmesh — which asks collision rather than the table
   — correctly refused it. Foundry had been quietly losing two points to this since M4.
5. **Depot's climbing ladders were deriving cover.** A `crateTall` pressed against a
   container has one useful face and three pointing into solid steel; `deriveCoverPoints`
   emitted all four and the rejection count hit 67 of 270. Ladders are now a separate list
   that renders and collides but never reaches the cover pass. Rejections: 6 of 158.
6. **The naive allocation probe reported a confident zero for a path that allocates.** The
   first version read `usedJSHeapSize` before and after, and its canary — a loop allocating
   one small object per tick — also came back zero. Chrome updates that counter in very
   coarse steps: calibration showed no movement at all for 300,000 objects, then a 49 MB
   jump. The shipped probe measures a control loop first and reports a series rather than a
   delta.

## Problems found in the brief

1. **"Verify zero allocations in the per-tick sim path using an allocation profile" cannot
   be done from inside the page.** A page's only heap number is `performance.memory`, whose
   resolution is tens of megabytes (bug 6). The probe bounds the allocation and hands over
   the DevTools recipe; what it cannot do is print "zero" honestly. **And on this build the
   answer is not zero** — see the verification table.
2. **"Sprint every wall" needs a definition of a snag.** Being stopped by a wall in front of
   you is not one; being stopped with open space ahead is. Without that distinction the
   sweep reports thirty dead ends for every real finding. `SnagHarness` probes forward and
   classifies.
3. **Lane timings within ~15% and "the alleys must offer a real alternative route" pull in
   opposite directions.** An alley that is a genuinely different route is a longer one. Both
   are satisfiable only if the alleys run parallel to the streets rather than around them,
   which is what Dunes does — and it is worth saying that the constraint chose the layout.
4. **"Colorblind mode… not just a CSS filter" is right, and is not achievable in CSS at
   all** for a game whose flag rings, dog tags and bomb lights are world geometry. It needed
   a palette both the DOM and `THREE.Color` read from.
5. **Depot's third nav layer measured empty on the shipped layout.** A column that holds the
   yard, a container roof *and* the bridge does not occur, so `navLayers: 3` is currently
   paying for a layer that is never filled. It is kept because the bridge-over-roof case is
   one placement away and the cost is ~20 ms of bake; that is a judgement call and the human
   may want it at 2.

## Verification

Everything below was measured on this build. The frame-time caveat from M1-M7 still applies
and is restated at the end.

| Criterion | Result |
|---|---|
| 1. Five modes on both maps | **10/10 built and torn down** — TDM, DOM, KC, FFA, SND on Dunes and Depot — with **zero console errors and zero warnings**. Rosters 9 (7 in FFA), 5 objectives each. |
| 1. Depot navmesh coverage | **3 layers, 13,697 walkable nodes, 76.1% of columns inside `navBounds`**, 1,784 columns carrying more than one surface, 94 climb links, 103 patrol points. Layer 1 holds 452 nodes (the bridge and the stack ledges); layer 2 is empty — see brief problem 5. |
| 1. Bots use the verticality | A* solves ground → container roof and ground → bridge, both routing up the gantry stair (path heights 0 → 4.45 → 4.9 → 5.2). Bots were observed at **y = 5.14** (a two-high stack top) during an 87-second bot match. **They prefer the stairs to mantling**, which is what `CLIMB_COST_METRES` is for and is the correct outcome. |
| 2. Sprint every wall | Derived from the collision world, both directions, sprint held. **Foundry 142 passes / Dunes 260 / Depot 192 — zero snag findings and zero intersecting ticks on all three.** Depot reports 26 dead ends (containers parked against the perimeter), which are geometry, not faults. |
| 3. Lane timings | **Dunes 6.3% spread** (33.0–35.1 m, 4.78–5.08 s at 6.9 m/s). **Depot 0.0%** (27.0 m on all six). Foundry unchanged at 2.3%. |
| 4. Z-fighting and shadow acne | No coplanar visible faces by construction: floor slabs abut rather than overlap, stacked containers are sunk 0.06 m into each other, roof slabs are sunk into their walls, and every trim brush is raised clear and non-solid. Depot overrides `normalBias` to 0.055 (against Foundry's 0.035) because its key is a 0.55-intensity grazing light, which is the acne case. **Not seen** — see the caveat. |
| 5. Every setting works | 14 of 14 changed something observable. Full table below. |
| 5. Rebinding through `InputCommand` | Forward `KeyW` → `ArrowUp`: `cmd.moveZ` was **1 on W before, 0 on W after, 1 on ArrowUp**. Reload `KeyR` → `KeyB`: pressing B set **bit 32 (`Btn.Reload`) in `cmd.buttons`**. Both read off the command the sim consumes. |
| 6. Colourblind changes real colours | `--c-bad` **#e8604c → #ff9e2c**, `--c-hit-kill` likewise; the minimap's friendly/hostile/sweep strings and the objective materials are repainted from the same palette. |
| 7. Allocation profile | **Not zero.** Control loop exactly flat (10/10 identical samples). `player.step` alone: 4.4 bytes/tick, oscillating around zero. `match.simulate` alone: **29.4 bytes/tick, monotonically rising** over 300,000 ticks. Broken down: bots 7.2, weapons 3.8, equipment 1.9, everything else at or below the floor. |
| 8. Frame percentiles | Ran at all six render scales on Depot with a live Chopper Gunner. **The numbers are not this build's** — see the caveat. The numbers that *are*: mode peak 0.1 ms, HUD peak 1.1 ms, streak peak 0.5 ms, 0 starved frames, against S4.7's 3.0 ms budget for all game logic. |
| 9. README and DEBUG.md | Both complete. README has setup, controls and a tuning guide mapping thirty "I want to change X" rows to the file that owns it. DEBUG.md has the tool index, the URL-flag table, the export envelope and five worked examples. |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. **Zero `any`, zero `!`, zero `@ts-expect-error`.** |
| 10. Console | Clean on a cold load and across all ten map/mode builds. Only Vite's dev messages and one `[Profile]` info line. |

### Every setting, and what moved

| Setting | Changed to | What was observed |
|---|---|---|
| Mouse sensitivity | 1 → 2 | Same 100-count mouse delta: yaw **0.2200 → 0.4400 rad**, exactly 2.00× |
| ADS sensitivity | 0.5 | Same delta at `adsFraction` 0 vs 1: **0.2200 → 0.1100 rad**, exactly 0.50× |
| FOV | 90 → 110 | `cameraConfig.fov` 90 → 110 |
| Invert Y | on | Same downward delta: pitch **−0.2200 → +0.2200 rad** |
| Master volume | 0.6 | Master `GainNode.gain` |
| Effects volume | 0.25 | `sfx` bus `GainNode.gain` **0.90 → 0.25** |
| Music volume | 0.1 | `music` bus `GainNode.gain` 0.10 |
| Interface volume | 0.4 | `ui` bus `GainNode.gain` 0.40 |
| Render scale | 1 → 0.5 | `renderer.pixelRatio` **1.25 → 0.625** |
| Shadow quality | medium → high → off | Shadow map **2048 r=1.60 → 4096 r=2.56**; `off` gave `castShadow=false`, `shadowMap.enabled=false` |
| FPS counter | on | `.op-fps` element `hidden` → visible |
| Motion blur | on → off | `renderer.motionBlurEnabled` true → false; render targets built and disposed with it |
| Colourblind | deuteranopia | `--c-bad` #e8604c → #ff9e2c, `--c-hit-kill` with it |
| Key rebinding | two actions | See criterion 5 above |

### The migration

A hand-written v1 save through `migrateSave`: version → 2, prestige, XP, FOV 104,
sensitivity 2.4, invert Y, render scale 0.75 and the mode/map selection all preserved; level
recomputed from XP as it always has been. `sfxVolume` **inherited the old single
`masterVolume` of 0.3** and master was lifted to 1, so a player who had turned the game down
does not get a 0.9 effects bus. The eleven new fields took their defaults and all 21
bindings were restored. A v0 save passes through **both** upgrades and arrives at v2 with 21
bindings.

### Caveats worth stating plainly

**The frame percentiles are still not this build's.** The Browser pane in this environment
reports `visibilityState: "hidden"` and never composites, so `requestAnimationFrame` never
fires and the measurements substitute a `MessageChannel` frame source — the same workaround
M4 through M7 used. That drives the real loop, sim, damage path, streaks and mode, but the
resulting frame numbers are mostly the source: the render-scale sweep showed **no
correlation between backing-buffer pixels and p99** (1.44 M px → 18.0 ms, 0.36 M px →
19.9 ms), which is the signature of a measurement that is not measuring the GPU. The sweep
*tool* is correct and returns the right shape; the numbers need a compositing browser.

**Nothing here has been seen.** No screenshot exists of Dunes at midday, of Depot at night,
of the dust, of the settings screen or of any colourblind palette. Every visual claim above
is a DOM assertion, a shadow-parameter read-back or a geometric argument from the map
source.

**The allocation figure is a bound, not a profile.** 29.4 bytes/tick is what a
tens-of-megabytes-resolution counter can resolve over 300,000 ticks. It is enough to say
*something* allocates and roughly how much; it is not enough to say what.

## Left for the human

1. **The two maps, looked at.** Whether Dunes reads as a village at midday and Depot as a
   yard at night; whether the dust sells distance on a 72 m street; whether the mast pools
   on Depot are lighting or just bright discs.
2. **Depot's shadows.** Criterion 4's hard case. The bias overrides are argued from first
   principles and have never been seen against the geometry they were chosen for.
3. **Frame time with a real compositor**, and the render-scale sweep re-run there. The tool
   is one call: start a Depot match with ten bots and `await __operator.renderSweep()`.
4. **The 29 bytes/tick.** DevTools → Memory → *Allocation instrumentation on timeline*, ten
   seconds of a live match, will name the call site. It is spread across bots, weapons and
   equipment rather than being one object, so it is likely to be several small things.
5. **Feel, as always.** Whether ducking your own rifle to 0.62 makes a firefight legible or
   makes your gun feel weak; whether the concussion after a nearby frag reads as a
   concussion; whether motion blur at 0.55 is smooth or smeared. Every number is in
   `AudioMix.ts`, `MatchEquipment.ts` and `MotionBlur.ts` respectively.
6. **Ten matches, for memory.** `?harness=botmatch&map=mp_depot&mode=DOM&bots=10&speed=32&matches=10`.

## Survival — the scoped estimate the brief asked for

> **Decided after M8: Survival is not being built.** The recommendation below was accepted and
> the direction for M9/M10 is **multiplayer — networking and LAN** instead. The estimate is
> kept because its *reasoning* now applies to the replacement: the question "what does the
> existing structure already answer" is the same question, and for networking the answer is
> unusually good — `INetworkTransport`, `InputCommand` and the sampler seam have been carrying
> the local game since M1 precisely so that this milestone would not be a rewrite. See
> **What multiplayer needs to know** at the end of the post-M8 section.

**Recommendation: do not build it.**

The cost is not the waves. It is that Survival is the first mode that is not a variation on
"two teams, a score limit and a respawn rule", and almost none of the existing structure
answers its questions.

A realistic M9 scope:

| Piece | Why it is not free |
|---|---|
| Wave scaling and spawn director | `SpawnSelector` maximises distance from *enemies* for fairness. Survival wants the opposite: pressure from a chosen direction, at a chosen rate, from spawn points that open as the round escalates. That is a second spawn system, not a parameter. |
| Economy | Currency, per-kill and per-round awards, a balance curve across twenty-plus waves. Nothing in `meta/` is per-match spendable state; XP is banked at SUMMARY and deliberately cannot be spent. |
| Purchase UI | A between-rounds screen with a new state, plus wall-buys or a shop in the world. `LoadoutEditor` is the closest thing and it edits a *saved* class, not a live inventory. |
| Enemy variety | Twenty waves of the same four tiers is twenty waves of the same fight. Survival needs at least a rusher, a tank and something that changes your positioning — new behaviours in `ai/`, not new numbers. |
| Downed / revive, or a hard fail | Single-player Survival with instant death is a mode you lose to one mistake at wave 14. |
| Map support | The three maps are built for two-sided lanes with rotational symmetry. Survival wants a defensible core and a controllable approach count; all three would need survival-specific spawn and barrier authoring. |

That is **comparable in size to M7** — six killstreaks and four modes — and probably larger
in AI work, because M7 reused the bot brain and Survival needs to extend it.

Against that: the build already has five modes, four of them objective modes with bots that
play them, twelve weapons, twelve perks, six killstreaks and three maps. The marginal player
hour Survival adds is real but it is the *same* combat against the *same* bots with a
different scoreboard. The same effort spent on a fourth and fifth map, or on the bot
behaviours Survival would have needed anyway, buys more variety per unit of risk — and does
not put a second spawn system and a second progression currency into a codebase that is
currently one of each.

**If it is built anyway**, build the spawn director first and alone, on Depot, with a fixed
economy and no purchase UI. That is the piece most likely to be wrong and the only one that
cannot be evaluated on paper.

## What is playable right now

Pick Dunes and you are standing at the end of a street you can see all the way down —
seventy-two metres of sand and low walls, a palm every so often that hides you without
stopping anything, and somebody's spawn at the far end of it. Cross it and you are exposed
for four and a half seconds; take the alleys instead and you get four metres of shade
between mud-brick walls that a rifle will shoot straight through, arriving at the same
plaza at almost the same time. One building per half has a stair up the side to a flat roof
with a parapet, which is the best view of the street and the first place anybody looks.
Depot is the opposite map in the dark: a cargo yard lit by six floodlights, where the ground
is only the bottom third of the fight. Containers are 2.6 m and cannot be climbed from the
yard, so every stack that is meant to be climbable has a pallet and a crate at the foot of
it — pallet, crate, roof, and from a two-high stack a crate on the exposed ledge takes you
to five metres and a gantry bridge that runs the width of the map. The bots climb it too.
Underneath all of that, the settings screen finally does what it says: rebind anything
including the mouse wheel and it goes through the same command the default did, drag the
effects slider and the world quietens while the announcer does not, turn the shadows off and
watch the frame time, switch to deuteranopia and your team turns blue on the minimap, on the
scoreboard, on the hitmarker and on the flag rings — because they were never a filter, they
were a palette. Your own rifle sits a little under everyone else's now, which sounds wrong
for about ten seconds and then you realise you can hear where the shooting is.

---

# Post-M8 — Polish and Bugfix

A fix pass between M8 and M9, driven entirely by a playtest playbook rather than by a brief.
No new systems except two: a knife, and a QA spectator. Everything else is a defect.

Branch: `m8-hotfixes`.

## The through-line

Seven of the sixteen items turned out to be the *same class of bug*: **two things that are
supposed to describe one fact, disagreeing.** Worth stating up front, because it is the thing
to watch for in M9 — networking doubles the number of places a fact can live.

| Report | The two things that disagreed |
|---|---|
| ADS does not work until rebound | The binding table said `Mouse1`; the DOM says the right button is `Mouse2` |
| Respawn holding the pistol, firing the rifle | `Inventory.activeSlotIndex` reset; the visible mesh did not |
| Camera stuck zoomed after death | `adsFraction` frozen at 1; the weapon that would lower it had stopped stepping |
| Chopper drains primary ammo | The takeover consumed the command; the rifle consumed it too |
| ADS in the chopper hides the crosshair | Same cause — the scope overlay saw a "scoped" rifle nobody was holding |
| Bot colours mixed in FFA | The mode says there are no teams; the mesh and the minimap still read `team` |
| "HOLD P TO PLANT" | The prompt was a string literal; the binding was a table |

## What was built

**The QA spectator** (`debug/Spectator.ts`, `debug/SpectatorPanel.ts`). Three independent
switches, not one mode — god mode, invisibility and free-cam are wanted in different
combinations and the file argues the case. Reachable from F1 → *Spectator (QA)* and from
`__operator.spectate.*`. Invisibility implies god mode, because a grenade already in the air
does not care that nobody is aiming at you. Free-cam is a mode of `PlayerController` rather
than a second camera, so the rig, the viewmodel, the audio listener and the minimap keep
working with no knowledge that it is happening.

**Melee** (`weapons/Melee.ts`). Bound to `V`. Deliberately *not* an inventory slot: a slot is
something you swap to, with a put-away and a take-out, and a knife is something you do while
still holding the rifle. Windup → one-tick strike → recover, with the hitbox test on a single
tick rather than a window, because a swept test lets you knife somebody who walked behind you
mid-animation. Range 2.0 m, 190 damage flat across every zone, and a world segment check
behind the rig search so a knife cannot reach through a wall it is touching.

## Every item, and what it actually was

**1 · Settings scroll sticks.** `swapWeapon` is bound to `WheelUp`, and `Input.onWheel`
called `preventDefault` for anything that resolves to a bit — so the settings list scrolled
down and refused to scroll back up. Fixed at the level the bug lives at rather than with a
wheel special case: `Input.setBindingsActive(false)` while a front-end screen is up, driven
from the state machine. The sim already knew menus do not take input (`sampleNeutral`); this
is the same rule one layer earlier, where `preventDefault` lives.

**2 · Clicking a keybind jumps to the top.** `paint()` rebuilds the screen, so the element
holding `scrollTop` was being discarded. The offset is carried across the rebuild rather than
the rebuild being avoided — and restored *after* insertion, because `scrollTop` on a detached
element is silently ignored.

**3 · ADS dead until rebound.** `MouseEvent.button` is 0 left, **1 middle, 2 right**. M8
shipped ADS on `Mouse1` and labelled it "Right mouse", so the default never fired and
rebinding by right-clicking stored `Mouse2` and worked. Default corrected, `inputLabel`
corrected, and a **save migration v2 → v3** repairs stored tables. The migration is the
interesting part: `normaliseBindings` runs on every load, so a repair there would have
permanently prevented binding ADS to middle mouse. A migration runs once, which is the right
shape for "this stored value was written by a version that was wrong about what it meant".

**4 · Weapon desync on respawn.** `weapons.reset()` put the logic back on slot 0 correctly;
the mesh follows `weapon.swapped`, and a reset is not a swap. `Match.respawnPlayer` now
re-shows the active slot explicitly, asking the inventory which one that is rather than
hard-coding 0.

**5 · ADS stuck after death.** A dead player's weapon is not stepped, so `adsFraction` froze.
Nothing downstream could fix it because the thing that would have was the thing that stopped.
`WeaponSystem.clearAim()` on the tick of death, writing **both** snapshots — leaving `prev` at
full ADS would blend the camera out over a frame instead of cutting, which on a sniper reads
as the zoom sticking.

**6 · Grenades during reload.** Cancels the reload rather than blocking the throw: a blocked
throw is an input the game silently ate, and the magazine is not lost either way because
`Weapon` only banks ammunition on completion. Tested on the press edge, so it fires once.

**7 · Pre-match freeze.** Applied at the *sampler*, which is the only place it can be —
movement is integrated before the match sees the command. `sampleSpectating` is already
exactly the right command (zeroed axes and buttons, live view angles), so the countdown reuses
it. Bots freeze too, via `BotDirector.inputFrozen`: they keep *thinking* — perception,
tactical and pathing all run — and only the movement axes and action bits are stripped, so the
round going live reads as a starting gun rather than a room of statues booting up. Also covers
`ROUND_END`, so a decided S&D round stops producing deaths.

**8 · Bad spawns.** Two real bugs and one design gap:

- The least-bad fallback compared an *unpenalised* score against a *penalised* best — two
  scales either side of one `>`. Since a penalised best sits near -100, essentially every
  later candidate cleared it, so "best" collapsed to "nearly the last one examined". That is
  the tier that runs most often in FFA, and it was returning an arbitrary point.
- Proximity inside the 15 m rule was linear, so a 3 m spawn scored 3 against a 12 m spawn's
  12 — a gap the recency penalty could outvote. Now penalised at four points a metre.
- **FFA drew from half the map.** The two-team substrate confined eight independent hostiles
  to their own side's spawn zones. There are no sides in FFA, so there is no reason to hold
  half the candidates back.

Measured over 50 s of eight-way FFA on Foundry: **20 spawns, 0 least-bad, 0 visible to an
enemy, nearest enemy never closer than 18.7 m.**

**9 · FFA colours and minimap.** Bots draw from a palette-derived hostile material in FFA;
`MatchHud` draws no friendly chevrons and pings every shot but your own. TDM is untouched —
verified: two distinct team colours and four friendly dots.

**10 · S&D.**

- Interaction key `P` → `T`, and the HUD prompts now read the *live* binding instead of a
  hard-coded letter. The migration moves `KeyT` to the front of the pair so a migrated save
  is prompted with the key the playbook asked for.
- Auto-pickup off for the player, via `manualPickupId`. Bots keep walking onto the bomb, and
  not as a concession: a bot's entire interaction vocabulary is *arriving somewhere*, and
  giving it a synthetic key press would be inventing an input path for the one participant
  that does not have one.
- **The round already ended on the detonation tick** — `checkWinCondition` consults the
  outcome that `explode`/`stepDefuse` set, on the same tick. What read as a delay was the
  shared four-second round-end hold. `GameMode.roundEndSeconds` is now per mode and S&D
  holds for 1.5 s.
- Hard reset on `round.started`, gated on `ModeEntry.usesRoundReset`. Bypasses the respawn
  gate deliberately: with one life the gate's answer is permanently "no", which is correct
  for a death mid-round and exactly wrong for the round boundary. Living players are
  respawned too — a survivor left standing on a bomb site is a free plant.
- Defuse visuals: whoever is interacting is forced to crouch (`PlayerController.forceCrouch`,
  folded into `crouchHeld` so every existing crouch rule still applies), and a progress ring
  grows around the bomb — friendly green for a defuse, neutral amber for a plant. The
  "hold to defuse" prompt is replaced for everybody else by what is actually happening,
  because the mode would refuse a second defuser anyway.

**11 · Chopper Gunner.** `WeaponSystem.suspended` takes the trigger, the sights *and* the
reload away from the rifle standing on the ground — which fixes the ammo drain and the hidden
crosshair together, because they were one bug. ADS now zooms the gunship optic (55° → 22°).
The view is a three-pass render: grayscale world, then allies near-black, then enemies orange,
split by two scene-graph groups so the pass never learns what a team is. The world shader was
lifted substantially — ambient more than doubled, range falloff halved, and a second key added
because a single overhead key left every horizontal surface at one flat value and Depot read
as a sheet of grey.

**12 · Depot lighting.** The hemisphere goes 0.62 → 0.95 with a much lighter ground term. The
fix is in the *fill*, not the masts: the masts are `decay: 2` points, so raising them would
blow out the pools and leave the gaps between them just as dark. Lifting the hemisphere raises
the floor of the image and leaves the lit parts nearly untouched.

**13 · Shooting Range.** Three separate defects behind one report:

- The three bullseyes all sat at the same `z`, so from the firing line they were at 13.5°,
  7.6° and 5.5° — in a line. Re-fanned, with the laterals chosen so no board falls inside the
  shadow cone a nearer one casts, and each `x` solved so the straight-line range is exactly
  the number written on it. The measured dummies were re-fanned by the same rule (the 15 m
  dummy was standing in front of the 40 m one).
- **No decals appeared** because the ring plates were `solid: false`: rounds passed through
  every ring and stopped on the backing board, where the decal landed *behind* the plate that
  was supposed to be showing it. The rings are solid now. Static dummies also mark, via
  `Damageable.decals` — movers deliberately do not, because a decal is placed in world space
  and would slide off them.
- Dummies were **buried** — the near faller inside the 0.3 m step, the DPS dummy inside the
  1.5 m ledge. Fixed by probing the real collision world at construction rather than by
  hand-correcting two `y` values, because the range sits on a testbed whose geometry exists
  to be moved.

**14 · Step-up.** `stepHeight` 0.35 → 0.5, with `mantleMinHeight` moved to 0.55 so the two
ranges stay disjoint — an obstacle that is both silently stepped and vault-detected would give
you a different animation depending on your approach speed. The step-up gate also changed from
`rise > stepHeight * 0.5` to an absolute 4 cm: the old test scaled with the config, so raising
`stepHeight` also raised the *ceiling clearance* required before a step was attempted, and the
setting fought itself under a low soffit.

**15 · Z-fighting.** The authoring bug was in the range: 2 cm plates spaced 2 cm apart have
*precisely coincident* faces. Fixed there, and guarded generally — the two materials every map
uses for decorative overlays (`accent`, `hazard`) now carry a negative `polygonOffset`, so a
trim brush wins the depth test against whatever it decorates however flush the author left it.
Fixed-function, costs nothing, and moves no geometry — collision, AO and the navmesh are
untouched.

## Deviations, and why

**The round-end "30-second delay" was not found.** The decision has always been same-tick, and
the code path is short enough to state: `explode()` sets `roundOutcome`, `checkWinCondition`
returns it on the same tick, `MatchFlow.endRound` runs immediately. The only delay that
existed was the four-second hold, which is now 1.5 s for S&D. If a longer delay is still
observed in play, it is something this pass did not reproduce and it should come back with a
repro — that is a more useful bug report than a number.

**Melee is one damage value, not a front/back split.** The playbook asked for "lethal or
extremely high"; 190 flat across every zone is the former and is simpler than a directional
model nothing else in the project has.

**Bots do not knife.** Adding it means a new approach behaviour in `BotBrain`, which is
M9-sized work for a feature the playbook asked for as a player verb.

## Verification

Typecheck and production build clean. Driven in a real browser against the live sim
(`g.simulate(tick)` directly, because the pane was not compositing and rAF does not fire):

| Claim | Measured |
|---|---|
| Right mouse aims | `bitsFor('Mouse2')` = 8 (`Btn.Ads`); was 0 |
| Middle mouse is free | `bitsFor('Mouse1')` = 0 |
| Use is on T | `bitsFor('KeyT')` = 65536; `KeyP` = 0 |
| Melee is on V | `bitsFor('KeyV')` = 131072 |
| Migration repairs a v2 save | `ads: ['Mouse1'] → ['Mouse2']`, `use: ['KeyE','KeyP'] → ['KeyT','KeyE']` |
| Wheel reaches the settings list | `defaultPrevented` false both directions |
| Keybind click holds position | scrollTop 762 → 762, row armed |
| Countdown freezes | 0.00 m moved holding W during WARMUP; 3.43 m in the first second of LIVE |
| Bots freeze with you | `bots.inputFrozen` true in WARMUP, false in LIVE |
| Knife kills | 100 → 0 HP, `lethal: true`, at 1.2 m in the open |
| Knife respects walls | refused at 1.3 m with a collider at 0.75 m |
| Respawn resets the weapon | died on slot 1 (TALON 9, model 1) → slot 0, model 0, M4 CARBINE |
| Death drops the sights | ADS 1.0 → 0.0 in weapon, `prev`, `curr` and the interpolated visual |
| God mode | 12 lethal applications, 100 → 100 HP, not dead |
| Invisible | `active` false, `participating` false |
| Free-cam | rose exactly 10.0 m in 1 s on Space (`NOCLIP_SPEED`), not grounded |
| Spectator restores | all three flags back, `spectate.state()` = "off" |
| FFA is all-hostile | all 7 bots `#8f4138`; 0 friendly minimap dots |
| TDM is untouched | `#4a5a72` / `#6e5a44`; 4 friendly dots |
| FFA spawns | 50 s, 20 selections, **0 least-bad**, **0 visible**, min enemy 18.7 m |
| Candidate pool | 96 → 224 |

## Left for the human

1. **Look at the gunship.** The grey/black/orange split is argued from what a filter cannot
   do; whether allies actually read as *allies* at 60 m needs eyes. `__operator.giveStreak`.
2. **Depot at 0.95 hemisphere.** The number is chosen to lift the floor of the image without
   touching the pools. Whether it still reads as night is a judgement.
3. **The knife's reach and cooldown.** 2.0 m and 0.72 s are the two numbers that decide
   whether it is a panic button or a playstyle.
4. **Step height 0.5 m.** It should feel like nothing. If it feels like the player is
   floating up kerbs, it is 0.05 too high.
5. **Whether the S&D round-end still feels slow** at 1.5 s.

## What multiplayer needs to know

The seam is already real and has been since M1, which is the whole reason it was built that
way — this is the milestone that collects on it.

- **`InputCommand` is the wire format.** Fixed layout, no DOM types, edge detection computed
  in the sim from the bitfield. Every input added since — killstreaks, Use, and now Melee —
  went in as a bit rather than as a handler, so nothing bypasses it.
- **`INetworkTransport` is already in the path.** `LocalBotTransport` submits and drains every
  command in single player. A real transport replaces one object.
- **A bot already *is* a remote command source.** `Bot.advance` writes a command and hands it
  to the same `PlayerController` the human's goes to. There is no second movement code path to
  reconcile.
- **The sampler is the one place that decides what a player may send.** Neutral, spectating,
  frozen and live are four samplers behind one call site in `Game.simulate` — which is where a
  server's authority over a client's input belongs.
- **Two things are *not* ready and should be scoped honestly.** The spawn selector, the
  killstreak system and the mode flow all assume one local player (`PLAYER_ENTITY_ID`, and
  `Match` is built around a single `PlayerCombatant`). And nothing is currently
  server-authoritative: `Ballistics` applies damage directly on the shooter's machine.

---

# Post-M8, round 2 — the re-opened reports

A second QA pass on `m8-hotfixes`. Ten items: three bugs the first round was supposed to have
fixed and had not, three Search & Destroy flaws, three Chopper Gunner items, and the knife.

## The through-line

**Four of the ten were fixed in the wrong layer the first time.** Round one read each report
as a tuning problem and moved a number; in four cases the number was never what was wrong, and
moving it produced a build that looked identical to the one QA had already rejected. That is
worse than not fixing it, because it costs a whole playtest cycle to discover.

| Report | Round 1 changed | What it actually was |
|---|---|---|
| "Depot is pitch black" | hemisphere 0.62 -> 0.95 | The *colour* was near-black in linear space. Intensity was the wrong lever by a factor of five. |
| "Stuck on small stairs" | step height 0.35 -> 0.5 | The step-up sequence probed forward by one tick of walking instead of one capsule radius, and rejected every tread it tried. |
| "Structures jitter" | fixed the range's plates, added a polygon offset | Real, and not enough: coincident faces elsewhere, plus a depth buffer that may have been 16-bit. |
| "Gunship shows a black void" | rewrote the grey shader | The shader was fine. `scene.background` was force-clearing the colour and depth buffers between the three passes. |

The lesson is the same one round one drew about facts that disagree, one level up: **when a
fix does not take, the next move is to measure the thing, not to move the number further.**
Every claim in the verification table below is a measurement, and four of them are of things
that were never measured the first time.

## Every item, and what it was

**Depot lighting.** `0x323d50` looks like a usable slate blue in a swatch and is linear
`(0.032, 0.047, 0.078)` — fourteen times darker than Foundry's fill. A 53% intensity bump on
that moves nothing an eye can see. The colours come up and the intensity comes back down; the
darkest surface in the yard goes from an 8-bit value of 10 to 54. The fog moved with it,
because a fog left at `0x151a22` would have put the far half of the map back where it started.

> **Corrected at round 4, and only the last sentence of the diagnosis is wrong.** The linear-space
> re-derivation above is right, and I re-checked its arithmetic before touching Depot again: the
> fill really was fourteen times darker and really is about 42% of Foundry's now. What the "10 to
> 54" describes is the **light**, not the picture. The surface it lands on — the `asphalt` span
> that is the entire yard — returned 0.019 of it, so the ground itself measured a mean of **4.4
> out of 255** on this tree, before round 4 touched anything. That is why the report came back a
> third time, and it is why the paragraph's closing claim about the fog is the only part of this
> fix that reached the player. The lesson this section already draws — *when a fix does not take,
> measure the thing rather than moving the number further* — is exactly right and was applied one
> level too high: the thing to measure was the pixel, not the lamp. See "reading the fight" under
> round 4, and `npm run readability`, which exists so the next round starts from a number.

**Step offset.** Rise, advance, drop is the classic three-sweep step-up and it works on an
*axis-aligned box*, whose flat underside is over a tread the moment it nudges forward. A
capsule's underside is a hemisphere and is only over a tread once its centre has passed the
lip — a full radius, 0.35 m, against a walking tick of 0.075 m. So the drop clipped the
tread's top corner, whose contact normal is outside `maxSlopeDeg`, so de-penetration pushed
the capsule back off it. Net progress zero, `steppedUp` reported true, velocity restored:
silently, every tick, for as long as forward was held. Measured headless, the shipped 0.5 m
config cleared *nothing* — a 0.30 m step blocked a walking capsule for three seconds. The
probe is a radius now; the acceptance test also checks the landing actually got somewhere.

**Z-fighting.** Two causes, both addressed. Coincident faces were found by scanning all four
maps for same-facing coplanar pairs — 122 of them, of which the ones on surfaces a player can
see were: Depot's shed roof (2.75 m2 at `y = 6`, which is what the gantry and the gunship look
down at), the gantry deck against the container cap and the leg tops at `y = 5.20`, the
stacked containers' sides, Dunes' perch parapets, and the range's pit trim. Fixed at source.
The rest are undersides on the ground, faces outside the playable volume, or geometry buried
inside other solids. Separately, the depth buffer: `stencil: false` lets a driver hand back
`DEPTH_COMPONENT16`, which across a 0.05-400 m frustum cannot separate a 1 cm trim lip from
its wall at combat range. Stencil is requested and the near plane is 0.12 m; measured 24-bit,
0.05 mm of depth resolution at 10 m.

**Search & Destroy.** Three separate faults.

- *The sites were in the attackers' half.* `swapAfterRound` and `SpawnSelector`'s swap are
  driven from the same constant, so the attacking end never changes — it is always the `-Z`
  end. Sites therefore belong at `+Z`, always, and do not move with the swap. They did not
  move before either; they were simply at the wrong end, in both rounds.
- *The bomb spawned at the far end after half-time.* It averaged the spawn zones of the
  attacking *team*, and after the swap that team plays out of the other team's zones. It also
  averaged in the deep fallback zones past the centre line. Maps now author a `bombspawn`
  point; nearest attacker spawn to it, measured live, 0.7 m.
- *The score was inverted.* `MatchFlow.swapSides` called `score.swapTeams()`, so the round
  Team B won before half-time was showing against Team A after it. `'A'` and `'B'` name teams
  of players, not ends of a map — nothing else about a swap moves with the ends, and
  `PlayerScore.team` does not change either. Measured before the fix: a 1-1 match reported
  2-0 and ended a round early.

**Chopper Gunner.** The grey world and the invisible team-mates were one line. Three passes
share one colour and depth buffer, which needs no clear between them — but `scene.background`
holding a `Color` makes three's background stage set `forceClear` and call `renderer.clear`
*regardless* of `autoClear`. Every pass wiped the one before it, so the player saw the last
pass only: orange enemies on a flat background. The optic's sky is the renderer's clear colour
now and the scene background is nulled for the duration. Two more: the override material
ignored `instanceMatrix`, so every crate, container and pillar collapsed onto the origin — on
Depot the containers *are* the map; and the belt, 50 rounds with a 2.4 s feed, because at 900
rpm the only bound on the streak's damage was its own timer and there was no decision in it.

**The knife.** Round one shipped melee as a weapon bash and said a second viewmodel was a lot
of machinery for a half-second arc. It is not: a knife has no magazine, no charging handle, no
muzzle and no sights, so it is one static group and one three-pose arc. The strike keyframe
sits at 0.222 through the swing because that is where `Melee`'s wind-up ends — the blade is
extended on the one frame the hitbox test runs, which is the only contract an animation owes a
hit. The state machine is untouched.

## Deviations, and why

**The range's accuracy wall is removed, not relocated.** It is 7.2 m wide, which is 3.6 m of
half-width, and at 25 m in that room there is no lateral that does not shadow the penetration
bay, the 40 m dummy or the bullseyes. The report called it irrelevant and it is: the bullseyes
do the same job with scoring rings on them.

**The bullseye boards are narrower.** 2.0 m -> 1.4 m. Three boards at 10/16/22 m cannot be
fanned inside the free lateral band without shadowing each other, which is exactly how the
post-M8 pass ended up putting two of them inside the north wall. A smaller face is the price
of three that are all usable from the firing line.

**Two barriers and a crate moved on the testbed.** They were cover props standing between the
firing line and four targets. The range is measured from one spot; things in front of it are
not cover, they are the report.

## Verification

Typecheck and production build clean. The four headless harnesses below were driven through
`esbuild` against the real modules; the live figures came from `__operator` in the browser
(the pane does not composite in this environment, so there are no screenshots and rAF never
fires — the same constraint round one worked under).

| Claim | Measured |
|---|---|
| Step-up, before | 0.30 m step **blocked** a walking capsule for 3 s; `steppedUp` fired 115 times |
| Step-up, after | 0.30-0.70 m cleared in 1-2 ticks, walking and sprinting; 0.75 m correctly refused |
| Effective step ceiling | 0.70 m (corner climb above `stepHeight` 0.55) — stated, not assumed |
| Depot fill, sky | linear 0.044 -> 0.250 (x5.7), 42% of Foundry |
| Depot fill, ground | linear 0.021 -> 0.112 (x5.2) |
| Depot key | linear 0.279 -> 0.517 (x1.9) |
| Darkest yard surface | 10/255 -> 54/255 after ACES at 1.25 exposure |
| Depth buffer | 24-bit + 8 stencil, 4x MSAA, near 0.12 m |
| Depth resolution | 0.002 mm at 2 m, 0.050 mm at 10 m, 0.79 mm at 40 m |
| Coincident faces | 122 -> 86; every remaining pair is buried, underground or out of bounds |
| S&D score, before | B wins R1, A wins R2 -> reported **A 2 : B 0**, match ended a round early |
| S&D score, after | detonate / defuse / both eliminations, across the swap, all credited correctly |
| S&D bomb, R1 | (0, -28.33), attackers B — their own base |
| S&D bomb, R2 (swapped) | (0, -28.33), attackers A — **still** their own base |
| Nearest attacker spawn to bomb | 0.7 m |
| S&D sites | z = +20 and +16 on Depot; 5.4 m and 6.1 m from a defender spawn |
| Range targets | 15/15 clear of geometry; 13/15 fully visible from the firing line |
| Range, the two partials | ankles behind the 0.9 m bay divider; penetration dummies behind their panels, by design |
| Bullseye boards | were at z = -18.6 and -17.6 against a wall face at -18; now 0.6 m clear |
| Knife | builds and merges to three meshes, one per shared surface |

## Left for the human

1. **All of it, on a screen.** Nothing here was seen rendered — the pane does not composite in
   this environment. The lighting, the gunship and the knife are argued from numbers and
   source, and the numbers are the honest part; whether Depot still reads as *night* at 5.7x
   the fill, whether a team-mate at 0.05-0.20 luminance reads as a team-mate at 60 m, and
   whether the slash sells are three judgements no measurement makes.
2. **The gunship belt.** 50 rounds and 2.4 s is a first guess at "a decision without being an
   annoyance". `StreakConfig.chopperMagSize` and `chopperReloadSeconds`.
3. **Step height 0.55 m.** The sequence is fixed, so this is now genuinely a feel number.
4. **The S&D decider.** Sides swap once, after round one, so Team A attacks in rounds two and
   three. That matches the genre and it is still a one-sided decider; worth a look before M9.
5. **The narrower bullseyes.** 1.4 m is wide enough for a rifle group at 22 m. A shotgun
   pattern will overhang it, and the wall that used to catch that is gone.

---

# Post-M8, round 3 — the regression, and two things that were never measured

Three items. One is a regression round 2 introduced, and the other two are round-2 fixes that
were aimed at the wrong thing — which is the same failure round 2 itself diagnosed, so it is
worth being blunt about it: **round 2 fixed four things by measuring them and two things by
reasoning about them, and the two it reasoned about are the two that came back.**

## 1. Wall-strafing super speed — the regression

Round 2 changed the step-up's forward probe from one tick of walking to one capsule radius,
because a capsule is only over a tread once its centre has passed the lip. That is right. What
it got wrong is that **a probe is a query and round 2 let its answer become the move.**

The sequence was attempted whenever the horizontal pass lost a millimetre of the requested
distance, which sliding along a wall does on every tick forever. It was then accepted whenever
the drop found walkable ground no lower than the start — which the floor the player was already
standing on satisfies. So it fired every tick, and each time it advanced the capsule by the
full probe distance, 0.355 m, instead of the 0.077 m a walking tick asks for.

Measured, walking into a flat wall at 45°: **20.59 m/s against a walk speed of 4.6**, with the
step-up firing on 120 of 120 ticks. Up an 18° ramp: 7.25 m/s.

The two bad cases fail for different reasons and no single test catches both, so there are two
gates:

```
                     achieved / desired      climbed
  real step               0.00 - 0.39      0.25 - 0.51 m
  wall, 45° into it       0.77 - 0.97      0.005 m
  ramp, walking up        0.91 - 0.99      0.05 - 0.11 m
```

- `STEP_BLOCKED_FRACTION` at 0.5 — a step *stops* you, a wall or a ramp only shaves you. This
  is what excludes ramps, which genuinely gain height and pass any climb test.
- an actual climb, above `MIN_STEP_RISE` — this is what excludes walls, which block hard
  enough to pass the first gate when you run at them steeply but climb five millimetres.

`sim.blockedHorizontally` keeps its old looser meaning, because `PlayerController` reads it for
the sprint auto-vault and that is a question about touching something, not about being stopped.

## 2. The jitter, which was probably never z-fighting

Round 2 answered "structures jitter" with a 24-bit depth buffer, a raised near plane and a
coincident-face sweep. The report came back unchanged, so this round measured instead of
reasoning again, and the depth explanation does not survive it:

- the buffer **is** 24-bit on the reporting machine, resolving 0.002 mm at 2 m and 0.050 mm at
  10 m — two to three orders of magnitude finer than the 1-2 cm a trim lip stands proud;
- the round-2 face sweep had a large blind spot: it skipped every rotated brush and every
  rotated prop placement. Redone with oriented boxes and plane clipping, and then filtered by
  whether the space just outside each face is actually open, the count on the two maps QA plays
  is **zero on Foundry and zero on Depot**. The twenty survivors are the testbed's wall
  exteriors and Dunes' 11 m skyline trim, none of which a player can see;
- decals cannot fight: `depthWrite: false`.

What was left is the step-up above. Pressed against a wall it ran three sweeps and took their
result **every tick**, so the camera was being re-seated every tick from a de-penetration chain
that lands a few millimetres differently each time. That is a per-tick camera wobble, and a
camera wobble is *most* visible on whatever is closest — which is exactly the shape of the
report, "when the player gets right up close to them". Measured against a wall, a ramp and a
corner, the unrequested per-tick camera movement is now identical to the step-up-disabled
baseline to the last digit.

Two changes went in alongside it. The near plane goes 0.12 -> 0.20 m because QA asked for it
and it is free — but it is not what fixed anything, and the note in `CameraRig` says so. And
`normalBias` now scales with the shadow tier: the distance it has to cover is one shadow texel,
a texel is `2 * extent / size`, so the **low** tier was running half a texel of bias on every
map. That is the textbook acne case — a fine moving speckle over large surfaces, worst at
grazing angles — and it is the one remaining thing in the renderer that flickers. Now 1.05
texels at every tier, verified live.

## 3. The knife was drawn behind the camera

The three-pose arc was fine; the poses were in the wrong coordinate space. The bash they
replaced was an *offset* on the rifle's pose, so its numbers were small displacements about a
weapon already at `hipZ = -0.33`. The keyframes kept that scale and lost the base:

```
  READY   depth  0.02 m   frame ±0.02   fist at (0.30, -0.26)   13.2x the half-width off frame
  WINDUP  depth -0.12 m   -> behind the camera, never drawn
  STRIKE  depth  0.40 m   frame ±0.45   fist at (-0.11, -0.02)  on screen
```

Only the strike instant was ever rasterised. The new poses keep the fist between 0.24 m and
0.46 m deep, where the frame is 0.28-0.53 m wide either side of centre; the fist is in frame on
61 of 61 sampled frames of the swing and sits 10% of the way from centre to the edge at the
strike. The strike yaw is 40° rather than 0 because a blade pointing straight down -Z is seen
end-on, which is a bright line and nothing else.

The model is also scaled 1.3x — 31 cm of blade rather than 24. Life size is the wrong size in
the corner of a screen; the rifle only gets away with it by being 700 mm long.

One bug fell out of driving the swing live: `Melee.fraction` is exactly 0 on the first tick of
a wind-up while `Melee.busy` is already true, and `poseKnife` early-returned on 0 — so the
first frame of the first swing of a match drew the blade at the viewmodel origin, *inside the
camera*. The blend reduces to `KNIFE_READY` at 0, so the early-out is simply gone.

## Verification

Typecheck and production build clean. Headless harnesses against the real modules, plus live
`__operator` reads in a running match.

| Claim | Measured |
|---|---|
| Wall 45°, before | **20.59 m/s** at a 4.6 walk speed; step-up fired 120/120 ticks |
| Wall 45°, after | 4.33 m/s, 0 step-ups |
| Ramp up, before / after | 7.25 -> 4.11 m/s, 0 step-ups |
| Ramp diagonal, before / after | 7.21 -> 4.35 m/s, 0 step-ups |
| Step-up on vs off | identical to the last digit on every wall, ramp, corner and open-ground case |
| Tactical sprint | 6.53-7.95 m/s everywhere, under the 8.2 cap, on and off identical |
| Camera wobble vs baseline | identical to step-up-disabled on wall, diagonal wall, corner and ramp |
| Steps still climb | 0.30 / 0.45 / 0.55 / 0.70 m cleared at walk *and* tactical sprint; 0.75 refused |
| Coincident faces, oriented + exposure-filtered | Foundry **0**, Depot **0**; 20 survivors all outside the playable volume |
| Depth buffer | 24-bit + 8 stencil, near 0.20 m, 0.002 mm at 2 m / 0.050 mm at 10 m |
| Shadow bias across tiers | was 0.53 / 1.05 / 2.10 texels; now 1.05 / 1.05 / 1.05 |
| Knife keyframes, before | READY 13.2x off frame; WINDUP behind the camera |
| Knife keyframes, after | fist in frame 61/61 frames; 10% from centre at the strike; 31 cm blade |
| Knife lifecycle, live | idle: rifle shown, knife hidden. First tick: knife at `READY`, rifle hidden. After: rifle back |

## Left for the human

1. **The jitter, again, and this is the one that matters.** The step-up wobble is the only
   candidate left standing and it is gone, but it was never seen on a screen from here — the
   preview pane does not composite in this environment. If anything still flickers, the next
   question is *what kind*: a hard per-pixel flicker that changes with camera angle is depth,
   a fine speckle that crawls on large surfaces is shadow acne, and a whole-image judder is the
   camera. They are three different bugs and knowing which one halves the work.
2. **`STEP_BLOCKED_FRACTION` at 0.5.** The measured gap is 0.39 to 0.77, so there is room
   either side, but a map with a very shallow ramp into a wall is the case that would squeeze
   it.
3. **The knife's 1.3x scale and 40° strike yaw.** Both are looks, not logic.

---

# Post-M8, round 4 — the jitter, found

Four items: three regressions round 3 introduced, and the jitter that had survived three
rounds. They turn out to be two facts.

## The jitter was a five-millimetre bounce, and it was in the collision resolver

Rounds 2 and 3 answered "structures jitter when you get close" with a 24-bit depth buffer, two
near-plane changes, a coincident-face sweep across four maps and a step-up rewrite. None of it
touched the cause, because none of it asked the first question: **what does the camera do when
the player is standing perfectly still?**

Measured, on flat ground, no input:

```
  y: 5.00  0.00  5.00  0.00  0.00  0.00  5.00  0.00   mm
```

A five-millimetre vertical limit cycle at twenty-odd hertz — exactly `collisionSkin`. Gravity
was applied on every tick regardless of being grounded, driving the capsule 2.7 mm into the
floor; `resolve` pushed it back out by `depth + skin`, which overshoots to 5 mm *above* the
floor; from there nothing is touching, so the next tick finds no contact and `groundSnap` pulls
it back down. Forever.

Five millimetres is nothing at arm's length and 0.82° of pitch against a wall 0.35 m away —
about ten pixels of judder at this FOV. **That is why the report always said "up close"**: the
bounce is everywhere, and you can only see it when something is near enough to reference it
against. Every previous round went looking for a rendering bug because the symptom looked like
one.

The same accumulation was the ice-slide. `projectVelocity` removes the component of velocity
going *into* a surface and correctly leaves the tangential part, so on a slope gravity's
downhill component built up every tick until friction balanced it: 292 mm of creep in three
seconds on 18°, 766 mm on 44°. And it was the missing 5% on ramp ascent.

One wrong assumption behind all three: that a player standing on the floor is falling. Gravity
now resumes the moment the ground stops being there, and `groundSnapDist` keeps the player
attached over crests and down slopes, which is the job it already had.

## The near plane was geometry, not taste

Round 3 raised it to a constant 0.20 m and put a grey wedge through the world at the edge of
the screen. The mistake: the capsule radius bounds how close the eye gets to a wall **along the
wall's normal**, and the near plane clips on **view-space depth**. A point on that wall at the
corner of the screen sits at `clearance · cos(halfHorizontalFov)`, which is much less:

```
                                    hFOV    min view depth
  90 FOV, 16:9 (the default)        121°       0.159 m     <- 0.20 clipped
  90 + tac sprint + slide           140°       0.111 m     <- 0.12 clips too
  FOV 120, 16:9                     144°       0.100 m
  FOV 120 + adds, 21:9              164°       0.045 m
```

So reverting to 0.12 fixes the screenshot and leaves the same bug latent for anyone who slides,
tac-sprints or plays wide — which is not a fix, it is the fix that has now come back twice. It
is derived instead, from the FOV, the aspect and the capsule radius, and recomputed wherever
any of them changes. At the shipped defaults it evaluates to 0.118, which is the 0.12 the
report asked for; it only ever goes down from there.

## The knife had no arm, and then had one aimed backwards

Moving the poses into frame in round 3 made the *stump* visible: at the old `READY` the fist
had been sitting on the camera, so nobody ever saw where the wrist ended.

A forearm cannot be a child of the knife — the knife yaws through 100° across the swing and a
rigidly attached arm would swing with it. An arm connects two points, so it is built one unit
long down -Z and then aimed and stretched between a fixed shoulder and the fist each frame. The
shoulder is *behind the camera*, so the elbow end is always outside the near plane and the arm
runs off the bottom-right of frame with no visible end.

The first implementation used `Object3D.lookAt`, and the measurement caught it: `lookAt`
resolves against `matrixWorld` and treats its argument as a **world** position, while these are
viewmodel-local coordinates on an object parented to a moving camera. It aimed the arm at
exactly 180° from the fist — the wrist landed twice the arm's length from the hand.
`setFromUnitVectors` asks the question in the space the numbers are actually in, and the wrist
now lands on the fist to within 0 mm at every point of the swing.

## Verification

Typecheck and production build clean. Headless harness against the real modules, plus live
`__operator` reads in a running match.

| Claim | Measured |
|---|---|
| Standing still, flat floor | y peak-to-peak **5.00 mm -> 0.00 mm** |
| Standing still, against a wall | 5.00 mm -> 0.00 mm |
| Standing still, on an 18° ramp | 31.1 mm -> 0.00 mm, horizontal drift 95.9 -> 0.0 mm/s |
| Ice-slide, 10 / 18 / 30 / 44° | 159 / 292 / 520 / 766 mm in 3 s -> **0 mm at every angle** |
| Ramp ascent | 4.38 -> **4.66 m/s** surface speed (flat reference 4.60) |
| Jump apex | 0.902 m against `jumpHeight` 0.95 — unchanged, the jump tick is guarded |
| Fall from 6 m | 0.82 s against a free-fall ideal of 0.82 s; `justLanded` fires |
| Walking off a 0.3 m ledge | 0 airborne ticks, stays glued |
| Steps | 0.30 / 0.55 / 0.70 m clear, 0.75 refused — unchanged |
| Unwalkable 60° slope | still slides 2041 mm — steep ground is still not standable |
| Near plane, derived | 4:3 0.120, 16:9 0.118, 21:9 0.094; 12-106 mm of margin in every case |
| Near plane vs the limit | safe at 90, 101, 114, 120 and 144 vertical FOV, 16:9 and 21:9 |
| Knife arm | wrist lands on the fist to **0 mm** across the swing; arm 64.5-89.7 cm; elbow at z +0.28, always behind the camera |

## Left for the human

1. **The jitter, on a screen.** It is a measured zero now rather than an argument, but the
   pane still does not composite here so it has not been *seen* still.
2. **Whether zero slide is right.** The player no longer slides on any walkable slope, up to
   `maxSlopeDeg` 46°. That is the usual choice for a shooter and it is a choice; if a steep
   ramp should shed you, it wants an explicit slide-above-N-degrees rule rather than a return
   to accumulating gravity.
3. **The shoulder anchor.** `KNIFE_SHOULDER` at (0.30, -0.45, 0.28) is where the arm appears
   to come from. It is a look, and it is one number to move.

---

## Roadmap update — post-M8

**Survival mode is cancelled.** It was flagged in the M8 brief for a scoped estimate and a
recommendation. The decision is not to build it. It is removed permanently — not deferred, not
backlogged. Nothing in M1–M8 depends on it. Do not scope, estimate or reference it again.

**The game moves to a dedicated external server.** No listen server, no host player, nobody's
desktop load-bearing. This makes NAT traversal, port forwarding and host migration non-problems: they
are not solved, they cease to exist. It also imposes a structural change that is the dominant cost of
the whole transition — the simulation must run with no renderer, which means the codebase splits by
target before any socket is opened.

The project extends from eight milestones to eleven.

---

## Milestone 9 — Headless Server Split

**Goal**: the authoritative simulation runs in Node with no browser. **No networking whatsoever.**

**Gate**: a full 10-bot TDM match runs to completion in Node with no browser open, *and* the browser
build still plays exactly as it did at M8. Both, or the milestone is not done.

**Phases**

1. **Audit.** Inventory every browser dependency in what will become `shared/` — non-math Three.js
   imports, `window`, `document`, `localStorage`, `performance.now()`, `AudioContext`,
   `CanvasTexture`, and anywhere simulation state and render state are the same object. Report before
   moving code. This inventory is the real scope of the milestone.
2. **Partition** into `shared/` / `client/` / `server/`. Known split points: `MapLoader` (collision
   and nav shared, mesh building client), entity transforms holding `THREE.Object3D`, `SaveStore`
   (client) versus progression rules (shared), bots (shared).
3. **Boundary enforcement in CI.** A dependency check that fails the build on a `shared/ -> client/`
   import. Demonstrated by deliberately breaking it.
4. **Server process.** Drift-corrected fixed 60 Hz loop — Node timers drift and `setInterval(fn,16)`
   is not 60 Hz. Match instance, `npm run server`, structured logging.
5. **Client unchanged in feel.** It becomes a presentation layer over shared code. Config numbers
   live in `shared/` and are never duplicated client-side.
6. **Cross-runtime determinism.** The same fixed command sequence produces identical per-tick state
   hashes in Node and in the browser. Apply per-event RNG seeding here, not in M10.

---

## Milestone 10 — Netcode Foundation

**Goal**: two humans connected to the **deployed external server**, on Foundry, in TDM, moving and
shooting with hit registration that feels the way single-player feels. No front end for joining, no
other modes, no
other maps, no killstreaks.

**Phases**

1. **Architecture reckoning.** Read `INetworkTransport` — it has only ever been a pass-through and
   probably will not survive contact. Report before writing replication code. Use the code's actual
   class names, not the briefs'.
2. **Protocol and session.** WebSocket, `wss://`, handshake, protocol version check, entity
   assignment, full snapshot then deltas, clean and unclean disconnect. Hardening from the first line.
3. **Server-side match.** Full `InputCommand` structs, buffered and applied in `seq` order, with gaps
   filled by repeating the last command. Boundary validation — clamps and rate limits, not heuristics.
4. **Client prediction and reconciliation.** `PlayerController.step` pure. Unacked ring buffer, ack by
   `seq`, replay on mismatch, corrections smoothed over several ticks.
5. **Hit registration with rewind.** 60-tick hitbox history, rewind to shooter view time, capped at
   200 ms, resolving through the existing shared `DamageSystem`. Lag compensation belongs here, with
   hit registration — they are one system.
6. **Snapshots and remote players.** Binary delta at 20–30 Hz, decoupled from the 60 Hz sim. Remotes
   interpolated ~100 ms in the past. Remote humans reuse the M3 bot visual representation.
7. **Deployment.** The server actually runs on the external host, under a process manager, with TLS
   and environment configuration. Real measured RTT reported — it is the baseline for every later
   number.
8. **Instrumentation.** Network condition simulator first, layered on top of real RTT. Then network,
   prediction and rewind panels, and server metrics.

**Gate**: two humans and eight bots play TDM to completion against the deployed server at +150 ms
simulated latency. TTK measured single-player and networked is identical. The headless harness runs.

---

## Milestone 11 — Multiplayer Completion

**Goal**: everything else, on a proven foundation.

**Phases**

1. **~~Lobby.~~ Superseded — see "Milestone 11 — Skirmish Multiplayer Flow" below.** The V1 draft
   specified a lobby with a server-side roster, team select and a map/mode chooser. It is
   discarded in full: the shipped flow has no lobby, no queue and no ready-up, because a static
   screen between the menu and the match is the thing the design exists to remove. A player
   clicking Play Multiplayer is shooting in a permanent warmup arena within one round trip, and
   votes on what to play next while already playing.
2. **All five modes.** Every timer and every piece of objective state server-owned. S&D is the hard
   one: round state, bomb timer, interruptible plant/defuse, networked spectator flow, side swap.
3. **All six killstreaks.** Ghost filtered server-side — a Ghost player's position never enters an
   enemy client's snapshot. Chopper Gunner tested against disconnect, death, match end and server
   restart.
4. **Projectiles.** Grenades predicted by the thrower, authoritative on the server, reconciled without
   visible teleporting. Smoke occludes server-side bot perception.
5. **Effects, audio, progression.** Cosmetics audited out of every snapshot. Audio resolved
   per-listener. XP awarded server-side, persisted client-side — with the client-side-save caveat
   documented in `README.md` rather than left as a surprise.
6. **Lifecycle.** Server restart handling, 30 s reconnect window, input timeout, cheap idle with zero
   clients. Everything degrades toward "the match continues."
7. **Soak and hardening.** 12-hour run under the multi-client harness. Hardening probes re-run
   against every new message type.

**Gate**: every mode plays to completion against the deployed server at 100 ms ± 30 ms jitter with 2%
loss, the divergence checker reports zero mismatches in all five modes, and the 12-hour soak is clean.

---

## Locked decisions — carried verbatim in all three briefs

- **Dedicated headless Node server.** No host player, no listen server. Every player is a client.
  NAT traversal, port forwarding and host migration are out of the problem space.
- **One match instance per server process, 10 clients.** The instance is a class so more become
  possible later; do not build that now.
- **Code partitioned by target**, boundary enforced in CI. `shared/` may import Three.js math classes
  only — rewriting the vector maths across eight milestones of working code is a large refactor with
  real regression risk and no benefit.
- **Config is shared and singular.** The client never holds its own copy of a gameplay number.
- **Drift-corrected server loop.** Node timers are not 60 Hz on their own.
- **Server tick is the clock.** Clients derive tick number from a synced clock and never increment
  locally — §4.1's "discard the remainder" rule would desync them permanently.
- **Client prediction is mandatory.** Local player predicted, remotes interpolated. Two code paths.
- **Snapshot rate decoupled from tick rate** — 60 Hz sim, 20–30 Hz binary delta snapshots.
- **Rewind capped at 200 ms.** Peeker's advantage is a *consequence* of lag compensation, not a
  defect. Bound it; do not eliminate it. Rubberbanding is a reconciliation artifact, fixed by
  smoothing how corrections apply.
- **Per-event RNG seeding**, so replayed ticks reproduce exactly.
- **Authority split**: position, health, ammo, objectives, scores and streaks server-owned. Decals,
  tracers, particles, viewmodel, camera shake, screen effects, HUD and audio playback client-only,
  driven by replicated events.
- **Bots stay, on the server**, producing `InputCommand`s into the same pipeline as remote humans.
- **The client is fully untrusted.** Boundary validation and authority are the whole defence. No
  heuristic anti-cheat. Malformed input must never crash the process — that is now a DoS vector.
- **No accounts, no server database.** Progression stays client-side, with the consequence documented.

---

# Milestone 9 — Headless Server Split

**Status: complete.** All six phases. Phase 5 ("the client keeps working") is not a separate
body of work — it is the thing verified after every one of the others, and its results are
reported in each section below.

**The gate is met, on both halves.** A full ten-bot TDM runs to its win condition in Node with
no browser open and no DOM shim; and the browser build still plays all five modes on all three
maps, confirmed by playtest on a real display (see "Verification").

The milestone's one surprise is worth carrying forward on its own: `Math.sin` and `Math.cos`
are **not bit-identical across V8 versions**, which the cross-runtime hash caught at tick 149
of 3600. Everything the simulation does with angles now goes through
[`shared/core/SimMath.ts`](src/shared/core/SimMath.ts), and the boundary check enforces it.
Had this reached M10 it would have presented as unreproducible reconciliation errors with two
plausible homes.

## Phase 1 — the audit

Full inventory in [`docs/M9-AUDIT.md`](docs/M9-AUDIT.md). The headline was that the codebase
was in far better shape than the brief anticipated: **106 of 135 shared-bound files were
already clean**, and the twenty-nine that were not clustered in four places rather than
spreading thin.

Three findings changed how the rest of the milestone was planned:

1. **`performance.now()` was never used for gameplay timing.** All fourteen occurrences in
   shared-bound code were instrumentation — AI budget, navmesh bake duration, map build
   stats, a debug damage timestamp. Gameplay time was already `tickIndex * DT` everywhere.
   The shared clock abstraction was therefore needed for *measurement*, not for correctness,
   which removed the largest risk the brief had predicted.
2. **The simulation carries poses as loose numbers.** `PlayerSim`, `Combatant`, `Contact`,
   `RayHit` and every map def are plain scalars. §3 permits Three's math classes in `shared/`
   on the grounds that rewriting the vector maths would be a large refactor — the allowance
   turned out to be unnecessary, and `shared/` now imports `three` nowhere at all.
3. **`Math.random()` is genuinely absent** from gameplay. The only textual match was a comment
   stating the ban.

## Phase 2 — the partition

`src/` is now `shared/` (121 files), `client/` (99) and `server/` (1). 210 files moved with
`git mv`; 401 relative import specifiers were rewritten mechanically by a one-shot script, and
the tree typechecked clean immediately after the move with no hand-editing.

### What split rather than moved

| Was | Shared half | Client half |
|---|---|---|
| `core/Loop.ts` | `TickAccumulator`, `DT`, the step cap and the discard rule | `client/engine/FrameLoop.ts` — `requestAnimationFrame`, `performance.now` |
| `world/MapLoader.ts` | colliders, spatial hash, spawns, nav bounds | `client/world/MapRender.ts` — merged geometry, instanced props, materials, lights, fog |
| `meta/Camos.ts` | ids, names, unlock prerequisites | `client/meta/CamoTextures.ts` — the `CanvasTexture` generators |
| `perks/PerksRuntime.ts` | pickup pool, collection, the Tracker reveal *rule* | `client/perks/PerksRenderer.ts` — pickup meshes, the footstep trail |
| `streaks/SentryGun.ts` | targeting, tracking, firing, turret angles | `client/streaks/StreakMeshes.ts` — legs, body, barrel |
| `streaks/CarePackage.ts` | drop physics, capture timer, contents roll | crate and beacon meshes |
| `streaks/ChopperGunner.ts` | flight, gun, damage, `ChopperView` | `client/streaks/ChopperCamera.ts` — the `PerspectiveCamera` |
| `meta/SaveData.ts` | the schema, migrations, `Versioned` | the `localStorage` read behind `readLegacySettings` |

### The three seams that made it possible

Every place `shared/` genuinely needed something the client had became an interface in
`shared/`, implemented on both sides:

- **`StreakPresentation`** replaced the `THREE.Scene`, `Fx` pool, `CameraRig` and audio graph
  that `StreakContext` used to hand every killstreak. Fifteen methods, all plain numbers. The
  browser supplies `ClientStreakPresentation`; a headless process supplies
  `SILENT_PRESENTATION`, whose no-ops are the *complete* correct behaviour for a runtime with
  no output rather than an unfinished implementation.
- **`ProgressionStore`** replaced the concrete `Profile` that `MatchProgression` and
  `ChallengeTracker` held. Six methods. Every type in its signatures already lived in
  `shared/meta/SaveData.ts`, which is the sign the seam was always there and merely undeclared.
- **`Clock`** and **`LogSink`** (`shared/core/`) — installed by whichever runtime is booting.

### `Bot` no longer owns a `BotMesh`

The offender §6.1 predicted, and the only one. The coupling was one-way — `apply(x, y, z, yaw,
heightScale)` wrote sim state into the mesh and nothing read back — so the field was deleted
rather than untangled. In its place `Bot` carries **`BotVisualState`**: a serial counter per
event (death, spawn, flinch) plus the data each needs. `client/ai/BotRenderer` reconciles its
mesh set against the roster every frame and starts an animation when a serial moves.

A counter rather than a callback because a frame that never rendered cannot then swallow a
death, and because it is the shape a replicated event will arrive in at M10.

**One determinism bug fell out of this.** `Bot.onKilled` drew `rng.int(0, DEATH_VARIANTS)`
from the bot's simulation RNG purely to pick a fall animation. A headless server has no
animation but would still have had to make that draw or diverge from the browser — and under
M10 reconciliation, a cosmetic draw sitting in a gameplay stream shifts every subsequent
spread and aim-error value on a replayed tick. The variant is now derived from
`(entityId, deathSerial)` via an integer hash, which is the §4.14 per-event seeding discipline
applied a milestone early, to the one place that needed it.

## Phase 3 — boundary enforcement

### The check is hand-written, and that was not the plan

§6.3 names `dependency-cruiser`, an ESLint boundaries rule, "or an equivalent". It was
installed first. This project is on **TypeScript 7**, which dependency-cruiser refuses to load
— it reported `0 modules, 0 dependencies cruised` and **exited zero**. A check that passes
because it read nothing is worse than no check, because it is trusted. Pinning TypeScript
backwards to satisfy a linter was not worth it.

`scripts/check-boundaries.mjs` reads the source directly. It does one thing the off-the-shelf
tools do not, which turns out to matter: **it checks identifiers as well as imports.**
`shared/` never importing `client/` is only half the boundary — a bare `window.innerWidth`
crosses it just as completely, and no import graph can see that. Comments and string literals
are blanked (offsets preserved, so line numbers stay honest) before the identifier scan; the
naive version produced two false positives on prose about a "multikill window" and a "save
document" on its first run.

Rules: `shared → client`, `shared → server`, `client → server`, `server → client`,
`shared → three`, `server → three`, all forbidden. Exit 1 on any violation.

**Demonstrated by breaking it.** A `three` import, a `client/ui/Palette` import and a
`window.innerWidth` were added to `shared/player/Movement.ts`; all three fired with the file
and line, exit code 1, and were removed.

### Per-target tsconfigs — the other half

`tsconfig.json` declared `"lib": ["ES2022", "DOM", "DOM.Iterable"]` for the entire tree, which
meant **the type system could never have caught a DOM reference in simulation code** —
`window.innerWidth` in the middle of a tick was a perfectly well-typed expression. That is why
the audit had to be done by grep.

Now: `tsconfig.shared.json` (ES2022 only, no DOM, no Node types), `tsconfig.client.json` (DOM +
`vite/client`), `tsconfig.server.json` (Node types, no DOM). The root `tsconfig.json` survives
for editors and Vite and is explicitly *not* a gate — it extends the client target, so an
editor using it will not flag `document` inside `src/shared`. `npm run check` will.

`tsconfig.server.json` keeps `moduleResolution: "bundler"`. `nodenext` was tried and rejected:
it demands an explicit `.js` extension on every relative import, which would mean rewriting
~400 specifiers across `shared/` — a change the browser build would carry for the server's
benefit, and exactly the coupling this milestone exists to remove.

### `console` is neither DOM nor Node

The first run of `tsconfig.shared.json` found eight `console.*` calls in simulation code that
nobody had noticed, because `console` is a *host* global belonging to neither library. That
turned out to be the right question rather than a compiler technicality: §6.4 wants structured
logging with levels on the server, and a bare `console.warn` in `PlayerController` cannot carry
a level, a tick number or a timestamp, and cannot be turned off in a ten-minute soak.
`shared/core/Log.ts` is the seam. The default sink writes to the console, which is what M1–M8
did and what "console clean" is measured against.

### CI

There was none before this milestone. `.github/workflows/ci.yml` runs the boundary check
first and alone — if `shared/` has grown an import of `client/`, every type error after it is
noise about a symbol that should not have been reachable, and a wall of noise is how a real
failure gets scrolled past — then the three typechecks, then the production build.

## A pre-M9 bug, found while verifying

`mapId` and `modeId` are stored in the save as bare strings and **have never been validated
against the registry**, though `normaliseSave` has validated every other field since M6. A save
written before the map ids were prefixed (`foundry` rather than `mp_foundry`) therefore
survives migration intact and then throws out of `findMap` on the first paint of the main
menu. The failure presents as a front end permanently stuck on "Loading…" **with a clean
console**, because the throw happens inside a state-enter handler.

This is older than M9 and unrelated to the split; it surfaced because the browser profile used
for verification held an old save. Fixed with `resolveMapId` / `resolveModeId`, which fall back
to the default and log. `findMap` still throws — a *code* path asking for a map that does not
exist is a bug and should say so.

## Verification

Typecheck clean on all three targets, boundary check clean, production build clean, browser
console free of errors.

The browser pane in this environment does not composite, so `requestAnimationFrame` never
fires and the loop cannot be driven normally. The simulation was therefore stepped directly —
which is, conveniently, exactly what phase 4 will do in Node.

| Map | Mode | Sim seconds to win condition | Sim ms p50 / p95 / p99 | Bot deaths |
|---|---|---|---|---|
| Foundry | TDM | 317 | 0.1 / 0.7 / 1.4 | 136 |
| Foundry | FFA | 408 | 0.1 / 0.8 / 1.9 | 132 |
| Foundry | S&D | 122 (best of 3, 2–0, sides swapped) | 0.1 / 0.4 / 1.1 | 11 |
| Dunes | DOM | 509 | 0.1 / 0.4 / 1.0 | 187 |
| Dunes | TDM | 269 | 0.1 / 0.7 / 1.2 | 111 |
| Depot | KC | 361 | 0.1 / 0.7 / 1.3 | 149 |
| Depot | DOM | 589 | 0.1 / 0.5 / 1.1 | 272 |

Every one reached `MATCH_END` and transitioned to SUMMARY. Sim cost is comfortably inside the
3.0 ms budget of §4.7. **Render frame time was not measured** and the M8 comparison in
criterion 4 is therefore outstanding: with the tab not compositing, every WebGL call stalls and
any number taken here would be fiction.

Other checks:

- **All six killstreaks activate and expire.** `StreakRenderer` built one mesh for a live
  sentry, two with a care package alongside it, and dropped back to one when the package was
  claimed — the reconcile-and-retire path works in both directions.
- **The chopper camera takeover survives the split.** `ChopperGunner.activeView` fills a pose
  and a lens; `ChopperCamera` reproduces the position to 2 dp and the FOV exactly.
- **Scene graph returns to zero children after teardown**, on three consecutive matches across
  three different maps, with the child count stable at 11 during each. Nothing the two new
  renderers create outlives the match.
- **`BotVisualState` is live**: 13 deaths / 21 respawns observed in a 30 s sample, with derived
  death variants stable across bots.

## What Milestone 10 needs to know

- **`server/` contains one file.** `NodeClock.ts` implements the shared `Clock` with
  `process.hrtime.bigint()`. `Loop.ts`, `Match.ts`, the entry point and structured logging are
  phase 4 and are not written.
- **The clock and log seams exist and are installed at boot.** `client/main.ts` calls
  `installClock(browserClock)`. A server entry point must call `installClock(nodeClock)` and
  `installLogSink(...)` before anything simulates — `nowMs()` throws rather than falling back,
  deliberately.
- **`SILENT_PRESENTATION` is the server's killstreak presentation.** Already written, already
  typed, nothing to implement.
- **`ProgressionStore` is what a server-side XP implementation must satisfy.** Six methods.
- **The one Three.js dependency left in shared is none.** The §3 allowance for math classes is
  unused and the boundary check bans the import outright. If M10 or M11 genuinely needs
  `Vector3` in shared code, relax `BAN_THREE_IN_SHARED` to a named-export whitelist rather
  than deleting the rule.
- **`INetworkTransport` survived the move untouched** and now lives at `shared/net/Transport.ts`.
  M10's phase 1 is to decide whether it survives contact with a real socket; nothing about M9
  changed its shape.
- **Per-event RNG seeding is applied in exactly one place** — the bot death variant. The four
  free-running streams §4.14 cares about (`WeaponSystem` spread, per-bot `Bot.rng`,
  `BotDirector`, `MatchEquipment`) are untouched and are phase 6 work.

## Phase 4 — the server process

`npm run server` boots, loads Foundry, runs a ten-bot Team Deathmatch to its win condition in
Node with no browser open and no DOM shim installed, logs the result, and exits 0.

```
INF 0.013s Match   FOUNDRY: 102 colliders, 1162 hash entries across 1728 cells.
INF 0.093s Match   TEAM DEATHMATCH on FOUNDRY: 5 vs 5 bots, seed 1.
INF 248.6s server  TDM on mp_foundry: A wins 75-47 (Score limit) in 248.5s of simulation
                   across 14911 ticks.
```

### The loop is not the client's loop, and that is the point

`server/Loop.ts` deliberately does **not** use `TickAccumulator`. The client banks elapsed
frame time and **discards** the backlog past five steps rather than spiralling, which is right
for a renderer whose frame rate is not its own business. It is wrong for a server: S4.11 makes
the server tick the clock every client derives its own tick number from, so a server that
quietly dropped a tick would run its match slower than its clients believe and nothing would
report it.

So the two share `DT` and the meaning of a tick, and nothing else:

- **Absolute timetable.** Tick *n* is due at `startMs + n * 16.667ms`, forever. A timer that
  fires 4 ms late costs one 4 ms excursion instead of shifting the whole remaining run — which
  is precisely the accumulating error S4.10 warns `setInterval(fn, 16)` produces.
- **Catch-up, not discard**, bounded at 15 ticks (250 ms). Past the cap the schedule is
  *rebased* to now and the skipped ticks are counted and logged, because a loop that spends
  the next minute repaying a two-second stall delivers nothing on time while it does.
- **No busy-wait.** The timer is asked to wake 1 ms early, because Node's timers round up and
  are readily late; the loop then runs whatever is due. S4.10 says not to burn a core and a
  sub-millisecond scheduling error is not worth one.

### What the server match is, and is not

`server/Match.ts` is about a tenth the size of `client/ClientMatch.ts`, and it is not that file
with the drawing removed — it is the authoritative half and nothing else. Absent deliberately:
no local player (a `Spectator` that never participates fills the roster's player seat, the same
mechanism the M3 AFK harness used), no viewmodel, no melee, no equipment thrower, no
killstreaks (`SILENT_PRESENTATION` is ready but bots earning streaks is M11's business), no
progression (S4.16: there is no server database).

### Running TypeScript in Node

Node cannot load the source directly: its native type stripping demands an explicit `.js`
extension on every relative import, and adding ~400 of them across `shared/` would be a change
the *browser* build carries for the server's benefit — the exact coupling this milestone
removes. So the server is bundled with the bundler already in the stack. `vite.server.config.ts`
is an SSR build to `dist-server/`, resolving specifiers the same way the client build does, so
the two targets cannot disagree about what a path means. No new dependency.

## Phase 6 — cross-runtime determinism, and the bug it found

**The hashes did not match.** That is what this phase was for, and it justified itself
immediately.

### The finding

Node 24 and Chrome 148 diverged at **tick 149 of 3600**, on `vz`, by one unit in the last
place — `0.10470673752261139` against `0.10470673752261117`. The differ named the tick and the
field, which ruled out logic and pointed at arithmetic.

Probing the maths surface with 20,000 arguments per function isolated it exactly:

| `hypot` | `sqrt` | `exp` | `pow` | `atan2` | `log` | **`sin`** | **`cos`** |
|---|---|---|---|---|---|---|---|
| agree | agree | agree | agree | agree | agree | **differ** | **differ** |

`Math.sin` and `Math.cos` are not bit-identical between V8 13.6 (Node 24) and V8 14.x
(Chrome 148). They are not required to be: ECMA-262 leaves the trigonometric functions
*implementation-approximated*, and V8 has changed its kernels between versions.

### Why it could not be left

S4.11 makes client prediction mandatory, and reconciliation replays unacked commands through
the same `PlayerController.step` the server ran. Yaw-to-direction is `sin`/`cos` **on every
tick**. A client whose Chrome disagrees with the server's Node drifts continuously, produces
corrections it did not earn, and the symptom reads as packet loss. Pinning versions is not
available — players run whatever browser they have — so at M10 this would have been a bug with
no reproduction and two plausible homes.

### The fix

`shared/core/SimMath.ts`: Cody-Waite argument reduction onto [-π/4, π/4] and the fdlibm
minimax kernels, built **only** from `+`, `-`, `*` and `Math.round`, all of which IEEE 754
specifies exactly and every conformant engine must round identically.

- **Accuracy: 1.00 ULP** against each runtime's own natives, over 200,000 samples spanning
  ±64 radians — measured in both runtimes, not asserted.
- **119 call sites across 27 shared files** now use `simSin`/`simCos`/`simTan`, including the
  map authoring files: a brush placed one ULP differently is a different collision world.
- The boundary check bans `Math.sin`/`cos`/`tan` in `shared/` and `server/`. **`client/` keeps
  them** — a camera angle, a muzzle flash or a bob curve is not simulation state and nobody
  replays it.

### The result

| | Node 24 (V8 13.6) | Chrome 148 (V8 14.x) |
|---|---|---|
| State fingerprint, 3600 ticks | `9768816b` | `9768816b` |
| State fingerprint, 7200 ticks | `99a3605a` | `99a3605a` |
| `Math.sin` digest | `a8989045` | **differs** |
| `Math.cos` digest | `ad924dab` | **differs** |
| `simSin` digest | `2d6021b7` | **identical** |
| `simCos` digest | `d0ae42c0` | **identical** |

The same run reports the natives still disagreeing while the replacements agree, which shows
the causal chain end to end rather than asserting it.

**Hash method**: FNV-1a 32-bit over the **raw IEEE 754 bytes** of every field, little-endian.
Not quantised, deliberately — a divergence starts in the last bits and takes hundreds of ticks
to grow past a millimetre, so a rounded hash would notice long after the first divergent tick
and point at the wrong code. The scenario covers movement **and** the weapon, because
`WeaponSystem` is where the simulation consumes randomness and S4.14 names a free-running
stream as the likeliest divergence; the RNG's four words are hashed alongside the pose.

## Instrumentation added (S7)

- **Headless harness** — `npm run harness`: the M3 AFK bot-match harness in Node. Map, mode,
  bot count, tier, seed and match count as CLI arguments; one JSON record per match boundary
  with result, sim ms, tick jitter, heap and per-tier hit rate. `--asap` runs unpaced, because
  a five-match run at real time costs half an hour and S7 wants this used unattended in CI.
- **Tick jitter** — p50/p99/min/max, delivered rate, ticks late and ticks dropped, from the
  server loop and in every match record.
- **Cross-runtime hash differ** — `scripts/diff-hashes.mjs`. Reports the first divergent tick
  and the field, and reports a maths disagreement *first* when there is one, because that
  causes the state divergence and fixing the symptom would be chasing it.
- **Debug overlay panel** — a `Simulation` section reporting `LOCAL shared sim (authoritative
  here)` or `REMOTE server (this client is presentation only)`, read from the transport's own
  `kind` so it cannot drift from the truth, plus pending commands, RTT and the tick.
- **Structured logging** — levels, text or JSON (JSON automatically when stdout is not a TTY),
  warnings and errors to stderr so a redirected run still shows failures.

## Verification — phases 4 and 6

### 2. A complete match in Node, no browser, no DOM shim

```
INF   0.013s Match   FOUNDRY: 102 colliders, 1162 hash entries across 1728 cells.
INF   0.093s Match   TEAM DEATHMATCH on FOUNDRY: 5 vs 5 bots, seed 1.
INF 248.602s server  TDM on mp_foundry: A wins 75-47 (Score limit) in 248.5s of simulation
                     across 14911 ticks.
```

248.5 s of simulation in 248.7 s of wall clock — real-time pacing held to within 200 ms over
four minutes. Exit code 0.

### 5. Cross-runtime hashes

| | Node 24 (V8 13.6.233.17) | Chrome 148.0.7778.280 |
|---|---|---|
| 3600 ticks (60 s) | `9768816b` | `9768816b` |
| **7200 ticks (120 s)** | **`99a3605a`** | **`99a3605a`** |

Method: FNV-1a 32-bit over the raw little-endian IEEE 754 bytes of pose, velocity, stance,
ground normal, eye and capsule height, bob phase, magazine, reserve, ADS fraction, spread, and
the weapon RNG's four state words — per tick, unquantised. Verified at 7200 ticks, twice the
3600 the criterion asks for.

### 6. Server tick jitter over a ten-minute headless run

36,000 ticks in 600.086 s, Domination on Depot, ten bots:

| | |
|---|---|
| **Delivered rate** | **60.001 Hz** |
| Jitter p50 | **16.614 ms** (ideal 16.667) |
| Jitter p99 | **24.259 ms** |
| Jitter min / max | 2.662 / 31.613 ms |
| Ticks late | 297 of 36,000 (**0.83%**) |
| **Ticks dropped** | **0** |
| Mean sim cost | 0.285 ms/tick against S4.7's 3.0 ms |
| Heap | 6.9 → 10.1 MB across the ten minutes |

**The p99 is a Windows number, and it should be re-measured on the deployment host.** The
default timer resolution on Windows is ~15.6 ms, which is most of a tick: `setTimeout` cannot
reliably wake inside one, so a deadline is occasionally missed and the loop delivers the
backlog immediately after — which is exactly the min of 2.662 ms sitting under a max of 31.613.

The drift correction is doing its job regardless, and that is the number that matters: the
*rate* is 60.001 Hz over ten minutes and **nothing was dropped**, so the tick count and the
match clock are exact even where the instantaneous spacing is not. An accumulating error would
have shown here as a rate below 60 and did not.

For M10: this is a per-host property, not a property of the loop. Measure it again on the Linux
box before attributing any snapshot-cadence jitter to the network.

### 7. Heap across five consecutive headless matches

Boot 6.2 MB, then after each match: **8.9 → 9.0 → 9.1 → 9.2 → 9.3 MB**. 1,360 seconds of
simulation across five full matches for 0.4 MB of growth after the first — flat, with the
`--expose-gc` collection taken before each sample. Wall clock for the whole run: 7.8 s.

### 8. Bot hit rate by tier, headless versus M3

| Tier | M3 (live 8v8, browser) | M9 (headless, 5 matches aggregated) |
|---|---|---|
| Recruit | 9.0% | **9.7%** (228/2362) |
| Regular | 13.2% | **17.7%** (1086/6127) |
| Hardened | 10.4% | **16.9%** (1210/7143) |
| Veteran | 11.9% | **17.2%** (238/1386) |

The same shape: Recruit clearly lowest, the upper three flat and bunched. That flatness is not
a regression — M3 measured and explained it at the time (*"flat, because each tier is also
fighting itself and higher tiers strafe and peek far more"*), and reported the fixed-target
figures separately for the monotonic ladder. Recruit, the tier least affected by that
confound, lands within 0.7 points of its browser number.

### 9. Types, `any`, consoles

`tsc --noEmit` clean on all three targets. **Zero `any`**, zero `@ts-expect-error`, zero
non-null assertions in the M9 files. Browser console clean of errors across the full sweep.
**Server stderr: 0 bytes** across the five-match run.

### 4 / phase 5. The browser build after the split

All five modes across all three maps, each run to `MATCH_END` and through to SUMMARY, after the
`SimMath` swap had touched movement:

| Map | Mode | Sim seconds | Sim ms p50 / p95 / p99 |
|---|---|---|---|
| Foundry | TDM | 314 | 0.0 / 0.2 / 0.4 |
| Foundry | FFA | 509 | 0.0 / 0.2 / 0.4 |
| Foundry | S&D | 122 (best of 3, 2-0, sides swapped) | 0.0 / 0.1 / 0.2 |
| Dunes | DOM | 479 | 0.0 / 0.1 / 0.3 |
| Depot | KC | 380 | 0.0 / 0.2 / 0.4 |

All six killstreaks activate and expire; `StreakRenderer` builds one mesh for a live sentry,
two with a care package, and retires them on expiry. The Chopper Gunner takeover reproduces its
pose to 2 dp and its FOV exactly through `ChopperCamera`. The scene graph returns to **zero**
children after teardown on three consecutive matches across three maps. Progression persists
across matches.

**Render frame time was not measured in this environment.** The pane does not composite, so
`requestAnimationFrame` never fires and every WebGL call stalls; any p50/p95/p99 taken here
would have been fiction, so none was reported.

**Closed by playtest on a real display**, not by measurement here. The human ran `npm run dev`
against the finished milestone and confirmed: movement feel identical, TTK unchanged,
hitmarkers and audio still mapping to the simulation, console clean, no visual or mechanical
regression. Criterion 4 is satisfied on that basis and the distinction is recorded rather than
smoothed over — the numeric frame-time comparison against the M8 table was never taken, and
if M10 needs a frame-time baseline it will have to be measured fresh.

### A bug in the harness, found by running it

The ten-minute jitter run exited 1. That was the tool, not the server: `--minutes` is a
deliberate cap, and a run that stops because it was told to has not failed. Hitting the cap is
now a normal end with exit 0 and a `cappedAtMinutes` field in the run record; a match that ends
with no winner and *no* cap still exits 1, because that means the mode never terminated.

## What Milestone 10 needs to know

- **`server/` is seven files**: `Loop`, `Match`, `Spectator`, `NodeClock`, `log`, `main`,
  `hashRun`. No transport, no session, no protocol — M9 built none, by instruction.
- **The determinism floor is `shared/core/SimMath.ts`.** Anything added to `shared/` that
  reaches for `Math.sin`/`cos`/`tan` will fail the boundary check. If a future need arises for
  another transcendental in the sim path, probe it with `mathDigest()` across both runtimes
  *before* using it — `exp`, `pow`, `sqrt`, `atan2`, `log` and `hypot` were checked and agree,
  and nothing else has been.
- **Run the hash check after any sim change.** `npm run hashes`, then the browser half, then
  `scripts/diff-hashes.mjs`. It is cheap (60 ms in Node, ~100 ms in the browser) and it is the
  only thing that will catch a divergence before it becomes a reconciliation mystery.
- **The server loop never drops ticks and must keep that property.** Its catch-up is bounded
  and it rebases with a warning past the cap; if `ticksDropped` is ever non-zero in a run
  record, the tick count has diverged from the clock and every client is now wrong.
- **`SILENT_PRESENTATION` and `ProgressionStore` are the two seams already waiting.** Streaks
  and server-side XP need no further inversion — they need implementations.
- **`INetworkTransport` is at `shared/net/Transport.ts`, untouched by M9.** M10 phase 1 is to
  decide whether it survives contact with a real socket; nothing here pre-judged that.
- **The debug overlay reports the simulation source** from the transport's own `kind`. When
  the remote transport lands, that readout changes with no further work.

---

# Milestone 10 — Netcode Foundation

**Status: built and verified against a local dedicated server. Not verified against a
deployed external host** — see "What is not done" below, which is the honest scope statement
for this milestone and the first thing M11 should read.

## Phase 1 — the `INetworkTransport` reckoning (S5.1, S8.1)

**It did not survive.** It was a command queue with a network-sounding name:

1. **One-directional.** `submit`/`drain` carried `InputCommand` client-to-sim and had nowhere
   to put a snapshot, an ack, a handshake or an event.
2. **On the wrong side of prediction.** `drain()` returned "commands ready to simulate" — a
   queue the local player would have to *wait in*. S4.11 makes prediction mandatory precisely
   so the local player never waits, so the shape encoded the round trip the milestone exists
   to remove.
3. **No connection state.** No connecting/open/closed, no error path, no protocol version, no
   entity assignment, no close reason.
4. **Moved object references, not bytes.** `drain` handed out live ring slots.

What it got right is why this milestone was tractable at all: it forced the simulation to only
ever see command data. That is why a bot, the headless harness and a remote human all feed one
pipeline. **The interface went; the discipline stayed.**

**Replacement**: `INetLink` in `shared/net/Transport.ts` — bidirectional, byte-oriented,
connection-stateful (`send` / `poll` / `state` / `close` / `lastRecvMs` / byte counters). The
queueing job moved to `server/net/InputBuffer.ts`, which is where it always belonged, because
only the authority has a reason to buffer and reorder by `seq`.

`LocalBotTransport` survives untouched under `ICommandQueue`, the name describing what it
always was. Single-player runs the M8 code path exactly.

### Class-name mapping (S5.1: use the code's names)

| Brief | Code |
|---|---|
| `Match` (client) | `ClientMatch.ts`, class `Match` |
| `Match` (server) | `server/Match.ts`, class `ServerMatch` |
| `Session.ts` | `server/net/Session.ts` |
| `Loop.ts` (server) | `server/Loop.ts`, class `ServerLoop` |
| Input sampler | `client/input/Input.ts`, class `Input` |
| Roster owner | `shared/ai/BotDirector` |
| Match state/clock | `shared/modes/MatchFlow` |
| Step-count rule | `shared/core/Loop.ts`, `TickAccumulator` |

Entity ids: `PLAYER_ENTITY_ID = 0` (the server's empty spectator seat), humans `1..99`,
`BOT_ID_BASE = 100`.

## Phase 1b — `PlayerController.step` purity audit (S6.3, S8.4)

The sim-state half was **already pure**: it reads only `cmd`, `sim`, `cfg` and the static
`world`. No clock, no DOM, no key map, no RNG. M9's `SimMath` work had removed the last
cross-engine hazard.

Three impurities were found, all outside that function:

1. **`WeaponSystem.rng` was a free-running stream** — the S4.14 hazard, still open at M9.
   Replay advanced it differently and every replayed shot diverged. Now reseeded per shot from
   `eventSeed(salt, tickIndex, sourceId, shotIndex)`. `reseed()` sets a *salt* rather than
   re-keying a stream, so each bot still gets its own pattern and every existing caller keeps
   its meaning.
2. **`bus.emit` fires on replay.** Handled by not replaying anything that emits presentation
   events other than movement, and by `Prediction.replaying`.
3. **`log.warn` on an illegal stance transition** — cosmetic, left alone.

**The weapon is deliberately not replayed.** It consumes ammunition, advances reloads and
fires rounds, none of which are in `PlayerSimState`; replaying eight commands through it would
empty a magazine eight times over. This does not cause divergence, because recoil's residual
is folded into *view angles* which are sampled into the next command as absolute values — a
replayed command already carries its post-recoil aim.

## The five bugs that stood between "connected" and "correct"

Worth recording in full, because every one was invisible in normal play and only the S8.4
"mispredictions must be zero" criterion surfaced them.

**1. The ack was the newest command received, not the one simulated.** A client runs ahead by
`RTT/2 + jitter`, so when the server simulated tick N it had already buffered commands for
N+1..N+4. Acking `input.lastSeq` told the client "I processed seq S+4" while the state was the
result of S. Measured: **135 mispredictions in 200 comparisons at zero added latency, p50
5.3 cm** — almost exactly four ticks of walking.

**2. `ackSeq` was a `u32` and its "nothing yet" sentinel is `-1`.** It arrived as 4,294,967,295,
the client set `lastAckedSeq` to four billion, and every real ack for the rest of the match was
discarded as "older than one already applied". Reconciliation ran **once, at join, and never
again**. It only appeared with two clients, because with one the join completed before the
first snapshot went out. Now `i32`.

**3. The client predicted with full-precision commands; the server received quantised ones.**
Yaw is 16 bits on the wire, the move axes a byte each. The per-tick error is ~1e-5 m — but it
does not cancel: a player turning steadily accumulates the same-signed error every tick.
Measured: **p50 14 cm** at zero latency, with the count refusing to drop below a few dozen no
matter what else was fixed. Commands are now rounded through `quantiseCommandInPlace` at
sample time, so both sides simulate byte-identical commands.

**4. Match phase was not replicated.** The server zeroes movement during WARMUP and ROUND_END
and applies no command at all while a player is dead; the client kept predicting ordinary
movement through all of it. ~68 mispredictions per twenty-second run. Now `SFlag.InputFrozen`
plus the replicated alive bit, applied client-side in `NetClient.neutralise`.

**5. A respawn was counted as a misprediction.** The server teleports a dead player to a spawn
point no client could predict. p99 was 30 m — the length of Foundry. Now detected from the
replicated `spawnSerial` and handled by `Prediction.adopt`, which takes the state without
judging a prediction against it.

**Result: 0 mispredictions in 1129 comparisons at +100 ms simulated latency, in the browser.**

## What was built

- **`shared/net/`** — `Protocol` (version, ids, limits, quantisation), `Wire` (a reader that
  never throws past the end), `Snapshot` (entity delta + the owner's full-precision state),
  `Messages` (every frame, encoder and decoder adjacent), `NetSim` (the S7 condition
  simulator), `ClockSync`, `Prediction`, `Interpolation`, `NetClient`, `Transport`.
- **`server/`** — `GameServer` (loop, sessions, snapshot dispatch), `NetPlayer` (a `Bot` with a
  socket where the brain would be), `Config` (everything from the environment), `serve.ts`.
- **`server/net/`** — `WsServer`, `Session`, `InputBuffer`, `SnapshotEncoder`, `Validation`,
  `Rewind`, `RigHistory`, `EventCollector`.
- **`server/debug/`** — `HeadlessClient`, `NodeLink`, `Hardening`, `HitTest`.
- **`client/net/`** — `BrowserLink`, `NetSession`, `RemoteActor`, `JoinOptions`.
- **`client/debug/NetPanel.ts`** — the S7 network, prediction and rewind sections.
- **`deploy/`** — systemd unit and env template.

### The event bridge is the reason the client half is small

S3 requires a networked event and a local one to be indistinguishable. `NetSession` takes
replicated events off the wire and re-emits them onto the client's own `GameBus` with the M1-M8
payload shapes. The hitmarker, damage numbers, killfeed, decals, tracers, positional gunfire
and footsteps all keep working with no networking code in them. The seam M1 built was cashed in.

### Remote players reuse the bot representation, structurally

`RenderableActor` in `shared/ai/BotVisualState.ts`. `Bot` satisfied it already; `RemoteActor`
satisfies it too, and `BotRenderer` iterates a supplier instead of `director.bots`. There is no
branch in the renderer that could tell them apart, which is how S6.5's "do not author a second
player model" is enforced rather than merely intended.

## Deviations, and why

- **Snapshot rate defaults to 20 Hz**, the bottom of S4.12's 20-30 range. At 20 Hz an interval
  is 50 ms, so the specified 100 ms interpolation delay is exactly two intervals — the minimum
  that survives one dropped snapshot. `SNAPSHOT_HZ` is configuration.
- **The yaw-delta check was implemented, measured to be unreachable, and removed.** See below.
- **Fire-rate limiting is not a boundary check.** The server's own `WeaponSystem` produces
  `pendingShots` from the weapon's RPM, which is authority and strictly stronger. What needed
  bounding was messages per second, and that is what `RateLimiter` does.
- **Command redundancy is 4, not 16.** Sixteen was measured at 17.4 KB/s upstream against
  4.8 KB/s down — a client uploading 3.5x what it downloads. Four covers 67 ms of total
  blackout and brought upstream to ~1.6 KB/s.
- **A background tab keeps its connection alive on a timer.** `requestAnimationFrame` is
  *suspended*, not throttled, in a hidden tab: the frame loop stops, no pings go out, and the
  10 s inactivity timeout drops the player. Alt-tabbing for fifteen seconds would disconnect
  you. The network now has a `setInterval` fallback while hidden; the simulation deliberately
  does not run on it, because the tick number is derived from the server clock and resyncs.

## Problems found in the brief

1. **"Reject impossible yaw deltas" (S4.16) is not expressible for this input model.**
   `InputCommand.yaw` is *absolute* and angles wrap, so the shortest distance between any two
   yaws is at most pi by construction — no threshold at or below pi can ever reject anything,
   and a threshold below pi would be an aim-speed limit, which the same section forbids two
   bullets later. Implemented, measured unreachable, removed, documented in `Validation.ts`.
2. **"Rate-limit fire against the weapon's RPM" (S4.16) is redundant with authority.** The
   server simulates the weapon; a client holding the fire bit every tick gets exactly the
   weapon's rate of fire because the server is the thing deciding.
3. **S8.4's "misprediction count must be zero" needs a definition of zero.** Over a real
   socket there is always residual host-timer jitter, and a command that arrives after its
   tick produces a correction that is *correct behaviour*, not a prediction failure. Measured
   0 in the browser at +100 ms; the headless harness on Windows shows 1-8 per 600 comparisons
   attributable to `setInterval` granularity, and reports `cmdsRepeated` alongside so the two
   causes are distinguishable.
4. **The brief does not say what happens to a leaver's scoreboard row.** Kept, deliberately:
   their kills already counted toward the team score and TDM is won on team score, so
   retracting the row would rewrite a match still being played.

## Verification

Everything below was measured against a **local** dedicated server (`ws://127.0.0.1`), with
the stated simulated conditions layered on top per HARD RULE 9. See "What is not done".

### Prediction and reconciliation

| Condition | Mispredictions | p50 | p99 | Max replay | Lead |
|---|---|---|---|---|---|
| Browser, +100 ms | **0 / 1129** | 0 cm | 0 cm | 0 | 10 ticks |
| Headless, none | 1-8 / ~600 | 7.7 cm | 15 cm | 3 | 2 ticks |
| Headless, +50 ms | 6 / ~400 | 48 cm | 48 cm | 5 | 4 ticks |
| Headless, +100 ms | 10 / ~400 | 11 cm | 59 cm | 11 | 6 ticks |
| Headless, +150 ms | 8 / ~400 | 5.5 cm | 55 cm | 13 | 8 ticks |
| Headless, `bad` | 16 / ~400 | 5.4 cm | 75 cm | 10 | 8 ticks |

Lead scales with latency exactly as S4.11 requires, and it is *measured*, not hardcoded: the
server reports command starvation and `ClockSync.adaptiveMs` converts it into buffer. The
browser run showed `buffer 49 ms (+35 earned)`.

**Correction smoothing: 6 ticks (100 ms)**, with a hard snap past 2 m. Chosen against the two
failure modes — under ~4 ticks any correction reads as a snap, over ~10 the camera visibly
lags the simulation during loss, which feels like input lag. 100 ms also matches the
interpolation delay, so a correction and the world it corrects toward settle together.

### Bandwidth (S8.10), 10 entities

`147-243 B` per snapshot depending on how much is moving, `~20/sec`. **1.6 KB/s up, 3.2 KB/s
down** per client in the browser at +100 ms.

### Hardening (S8.12) — all ten probes, server survived every one

`serverAlive=true`, `allClosed=true`. Garbage bytes, empty frame, magic-only, unknown message
id, truncated command batch, bad protocol version, 64 KB frame against the 1 KB cap, commands
before handshake, a 3000-ping flood, and a 4 KB display name. Every one closed the connection
(codes 1000 and 1009); a normal client connected immediately afterwards.

### Disconnect (S8.11) — both kinds

Clean `Bye` and a hard socket termination. In both cases the other client's remote count went
**10 to 9**, no ghost entity remained, and the server logged zero stalls with `ticksDropped: 0`
throughout.

### Server loop under load

`hz 59.98-59.99`, `jitterP50 15.9-16.0 ms`, `jitterP99 31.3-32.7 ms`, `ticksDropped: 0`,
`simMsMean 0.43-1.82 ms` with 2 clients and 8 bots. The p99 of ~32 ms is one doubled tick
interval — Windows timer granularity on the dev box; the loop never drops a tick and rebases
correctly.

### Bots (S8.13)

`npm run harness` runs unchanged and produces the M9 numbers: match 1 `A wins 75-46` in 13705
ticks, `simMsMean 0.086`, per-tier hit rates `RECRUIT 0.079 / REGULAR 0.109 / HARDENED 0.191 /
VETERAN 0.254` — the same ordering and band as M9. A browser client joined a live server with
4 bots and saw all of them, correctly teamed, with per-bot weapons and live death/spawn serials.

### Remote player state (S8.8)

Read live from a browser client against the server: names, teams, health, alive/dead, stance,
aim pitch and yaw, per-bot weapon ids (`ar_vulcan`, `smg_meridian`, `ar_carbine`), firing,
reloading and ADS flags, and death/spawn serials advancing. Dead bots correctly reported
`hp 0, alive false`.

## What is not done

Stated plainly rather than buried.

1. **No deployed external host.** S6.6 and every number in S8 ask for measurements against a
   deployed server over the internet. Provisioning one needs credentials and an account, which
   is the operator's to authorise. Everything needed to deploy is written and committed —
   systemd unit, env template, both TLS paths documented, `wss://` scheme upgrade handled in
   `resolveServerUrl` — but **the real-RTT baseline (S8.3) has not been taken** and every
   number above is local-plus-simulated.
2. **S8.2 (two humans) and the feel sign-off are not done.** They are a human playtest by
   standing arrangement.
3. **S8.6's hit-rate table is incomplete.** The controlled experiment is built
   (`--hittest`, plus `REWIND_DISABLED=1` for the comparison) and produces numbers, but the
   sweep script died partway on Windows and the with/without-rewind table was not completed.
   One clean result exists: 8/66 = 12.1% at no added latency with rewind on. **The comparison
   that would make rewind's value measurable rather than asserted has not been run.**
4. **S8.7 (TTK identical single-player vs networked) not measured.** The mechanism is right by
   construction — there is one `WeaponSystem` and one `DamageSystem` and the server runs both —
   but "right by construction" is not a measurement.
5. **The rewind panel shows the client's inputs to the calculation, not the server's
   per-shot record.** `?rewinddebug=1` is plumbed to the session and the server tracks
   `RewindRecord` per shot, but the debug event carrying it back is not implemented, so S7's
   "visualisation of the rewound hitbox against the present one" is absent.
6. **Cross-runtime hashes not re-run.** The per-event RNG change alters the M9 fingerprints by
   design. `npm run hashes` plus the browser half and `diff-hashes.mjs` should be re-run and
   the new fingerprint recorded before M11 relies on it.

## Playtest round 1 — the two bugs, and the one cause

Found by human playtest against the dedicated server. Both are the same mistake stated twice:
**M10 switched off the client's local match authority and never connected the replicated
replacement.** The client kept reading state that nothing was writing any more.

### 1. The HUD sat on "GET READY - 3" and 10:00 for the whole match

`MatchHud` reads phase, round and both clocks straight off the client's own `MatchFlow`, and
in a networked match that object never ticks — `simulate` skips it, deliberately, because the
server is running the real one. So it displayed its construction values forever. Measured in
the browser: banner `WARMUP / 600 s / 3 s` while the replicated truth was `523 s` and the
score was 6-14.

Only a `frozen` bit was being replicated, which was enough for input suppression and useless
for a HUD. The snapshot header now carries **phase, phase seconds and round** alongside the
time and score, and `MatchFlow.applyReplicated` adopts them. Score goes out as the
`ScoreChanged` event the HUD already subscribes to, so it travels the identical path a local
score change does (S3).

**`PROTOCOL_VERSION` is now 2.** The header layout changed.

### 2. Frozen after respawn — look worked, movement did not

The client had **three separate notions of "am I dead"**: `NetClient.localAlive`,
`ClientMatch.playerDead`, and the local `Health` object. Only the first was driven by the
server, and the other two were unreachable:

- `onPlayerKilled` keys on `PLAYER_ENTITY_ID`, which is entity **0** — the server's empty
  spectator seat — while a connected human is entity 1 or above. The death path never fired.
- `stepPlayerRespawn`, the only thing that clears `playerDead`, is skipped when networked.

So the state that suppressed movement and the state that would have lifted it were different
facts that never spoke to each other. That is why the symptom was so specific: mouse look is
applied at render rate straight into `Input`, entirely outside the command pipeline, so it
kept working while every movement axis was being zeroed.

`ClientMatch.applyReplicatedSelf` now takes the replicated health and alive bit off this
client's own entity and drives all of it — death on the falling edge, `respawnNetworked` on
the rising one. That reset does everything `respawnPlayer` does **except choose a position**:
the server picked the spawn, the snapshot carried it, and prediction has already adopted it,
so re-spawning locally would fight the authoritative position and yank the camera. Local
health regeneration is also off when networked, because running a second regen curve against
the authoritative one made the bar disagree with the damage being taken.

### Two things closed alongside

- **`spawnPlayer` now falls back** to the map's first authored spawn if the scored selector
  ever fails, instead of returning early. The old path left the player dead *forever*, and a
  permanently dead player is not visibly broken — they can look around and cannot walk, which
  is indistinguishable from a movement bug and would be debugged as one. The selector never
  failed in any run; that is precisely why the failure mode was worth closing.
- **The headless client reports `metresSinceRespawn`**, so this class of bug is catchable
  unattended. A client frozen after respawn looks healthy on every other number — connected,
  good RTT, receiving snapshots, mispredicting nothing — because standing still is something
  a client does correctly. Distance is the only figure that goes to zero and stays there.

### Verification

| | |
|---|---|
| 90 s runner, 8 bots | 1 death, **173 m travelled after respawn** |
| Browser, death cycle | `dead:true hp:0` -> server respawn -> `dead:false hp:100 alive:true` |
| Browser, HUD | `MATCH OVER / 247 s / 40-75` against a match that had just ended |
| 2 clients, +100 ms | 6-7 mispredictions per ~350 comparisons, 231 B snapshots, 4.8 KB/s up, 5.0 down |
| Hardening on v2 | ten probes, all closed, server alive |
| Single-player | no session, `networked:false`, nine local bots, console clean |

### The lesson for M11

**Turning off a client-side system is half a change.** Every `if (!this.isNetworked)` added in
M10 is a place where something authoritative has to arrive instead, and the compiler cannot
tell you when it does not — the field still exists, still has a plausible value, and still
renders. Grep for that guard before adding another one, and for each, name what replicates in
its place.

## Playtest round 2 — the integration audit

Reported after a full real-browser playtest: spawning outside the map and clipping through
walls, state from a previous match surviving into the next one, a dedicated server stuck on
"MATCH OVER" forever, no hit markers or audio feedback for anything the player shot, and a HUD
that ignored the server. Five symptoms.

**They were four structural gaps, and every one of them is the same shape as the two found in
round 1: a fact the client used to own, that the server now owns, still being read from where
it used to live.** Round 1 found that for the match clock and for death. This round found the
remaining four.

### 1. The client chose the world; the server merely mentioned it

`Welcome` has carried `mapId` and `modeId` since the protocol was written. `NetClient` decoded
both into two public fields, and **nothing in the client ever read either one.** The map came
from `Game.selection` — the *local menu choice, saved in the player's own profile* — and
`MatchWorld`'s constructor loaded it, spawned the player into it and built the match **before
anything was dialled**, because the connection was opened at the end of that same constructor.

So the two halves disagreed silently, and every consequence pointed somewhere else:

- The server picked a spawn against its map; on the client's map that is somewhere outside the
  geometry.
- Movement predicted against the client's colliders and was corrected against the server's, so
  every step produced a misprediction and a rubber-band.
- Walls the client could see were not in the server's world, so the player walked through them.

All three read as netcode faults. None of them is. **The netcode was doing exactly what it was
told, with two different worlds.**

The dependency ran in a circle: prediction needs a `PlayerController`, which needs the map's
`CollisionWorld`, which needs to know which map — which only the server can say, over a
connection `NetClient` owns. `client/net/Handshake.ts` cuts it by doing the exchange on a bare
link with nothing built yet, and handing the open link plus the decoded `Welcome` to a
`NetClient` afterwards through `NetClient.adopt`. **The protocol is unchanged**: one `Hello`
out, one `Welcome` back, thirty lines earlier. `Game.mapEntry()` and `Game.modeEntry()` now
return the server's answer whenever there is one.

### 2. The client's identity was hardcoded to zero

`PLAYER_ENTITY_ID` is 0 and has been since M2. A connected human is entity **1..99**; entity 0
is the server's empty spectator seat and never appears on the wire.

Round 1 found this in the death path and fixed *that one site*. It was in eleven others, all in
the presentation layer, and the result was the reported "no feedback bridges to the UI": no
hitmarker, no hitmarker sound, no damage numbers, no hit puff, no hurt vignette, no
hit-direction chevron, no camera shake on firing, no own-weapon audio mix, no own-footstep
mix, no kill sound, `ScoreSystem.isLocal`, `Killfeed.involvesLocal`.

**None of it failed loudly.** The events arrived over the wire, the bridge re-emitted them
faithfully onto the bus, the subscriptions fired, and each handler returned one line in. The
bridge was never the problem and was where it was going to be looked for.

`shared/combat/LocalIdentity.ts` is now the single answer, injected rather than imported: the
id is not known when the objects that need it are constructed, so a shared mutable holder is
handed out at construction and `adopt`ed from the `Welcome`. Single-player never calls `adopt`
and reads 0 throughout, so every M1-M8 path is bit-identical (HARD RULE 8).

### 3. `applyReplicated` adopted state but announced nothing

Round 1 made the client adopt the replicated phase, which fixed the HUD *reading* correctly
and nothing else. Every consumer downstream of a match ending is wired to an **event**:
`Game.pendingSummary` comes from `EV.MatchEnded`, the announcer from `EV.AnnouncerCue`, the
S&D round reset from `EV.RoundStarted`. A client that silently arrived in `MATCH_END` fired
none of them — so it never entered SUMMARY, never tore its world down, and sat on the final
banner while the server moved on, **with the old score, the old killfeed and the old
scoreboard still on screen.** That is the reported state leakage, and it was this method's
fault rather than a teardown that ran and missed something.

`MatchFlow` now names its two drive modes instead of leaving the difference implicit in which
methods a caller remembers not to invoke: `authoritative: true` simulates, `false` replicates.
`applyReplicated` is edge-triggered against the previous phase and emits the same events the
simulated path does, at the same transitions.

The same flag fixed the killfeed, which had been **blank all milestone**: the kill subscription
inside `MatchFlow` resolved killer and victim against `bots.roster`, which on a networked
client is empty, and returned before ever reaching the feed. `Killfeed` now takes a
`CombatantDirectory` — two questions, `nameOf` and `teamOf` — which `NetSession` satisfies from
the snapshot's replicated display names. Per-player kills, deaths and assists are counted from
the replicated events; **team score stays replicated** and the mode never scores twice.

### 4. The dedicated server had no lifecycle at all

`GameServer` never asked `match.isOver`. The flow reached `MATCH_END`, every snapshot carried
`SFlag.MatchOver`, and the process stayed there until somebody restarted it by hand.

There is now a post-match hold (`MATCH_END_HOLD_SECONDS`, default 12) and then a rotation:
`MAP_ROTATION` and `MODE_ROTATION`, walked in step, defaulting to `MAP`/`MODE` so the
out-of-the-box behaviour is "restart the same map" rather than a map the operator did not ask
for. The whole rotation is resolved through `findMap`/`findMode` **at boot**, because a typo in
it would otherwise take down a running server twenty minutes into its first match and take
every connected player with it.

A rotation is **not a disconnect**. Sockets stay up, sessions stay seated, and each client is
told what changed with a second `Welcome` — the same message it joined with, so there is no
separate "new match" path on either side to keep in step with the join path. The client
rebuilds its world from it exactly as it built the first one, which is what makes a mid-match
map change work at all. `MatchWorld.dispose({keepConnection:true})` and `NetSession.detach()`
are how the world goes and the link stays.

### Two bugs the audit itself introduced, both found by measuring

Worth recording because both were in the *fix for the state leak* and both reproduced the leak.

**1. The rotation was serviced from a pass that does not always run.** It sat in `draw()`, next
to `pendingSummary`. **`requestAnimationFrame` is suspended in a hidden tab** — which M10
already knew, it is why the network has its own `setInterval` heartbeat — so a client told the
server had rotated would acknowledge it and then sit on the previous map's world indefinitely.
Alt-tab through the post-match hold and you come back playing Foundry against a server running
Depot: gap 1 again, by a different route. Caught because the verification browser pane was not
compositing, which made the hidden-tab path the *default* rather than an edge case somebody has
to remember to test. Both transitions now go through `Game.servicePendingTransitions()`, called
from the render pass **and** from the heartbeat.

**2. `SUMMARY -> MATCH` was not a legal transition, and the throw was invisible.** A rotation
almost always arrives while the client is on the summary screen — that is what the post-match
hold is *for*. `applyRotation` called `transitionTo('MATCH')`, `isLegalGameTransition` said no,
and the `Error` was raised inside a `setInterval` callback where nothing was catching it. The
pending rotation had already been cleared, so it was gone: the client kept the old map for the
whole of the next match while its *identity* had already been updated by the same welcome —
strictly worse than either half alone.

Measured before the fix: `mapsSeen: ["mp_depot"]` with the server on `mp_foundry`, `rebuilds: 0`,
`localId` updated 2 -> 1 anyway. The state machine now declares the edge, because on a
dedicated server it is real: the server rotates on its own clock and does not wait for
anybody's summary screen.

The general point: **a state machine that throws on an illegal transition needs its illegal
transitions to be unreachable, not merely wrong.** This one was reachable from a timer, where
a throw is a silent no-op.

### Verification

Against a real dedicated server (14 bots, `MAP_ROTATION=mp_foundry,mp_depot`, 6 s hold) driven
from a real browser client. The client's saved profile was **deliberately set to S&D on Depot**
while the server ran TDM on Foundry, which is the reported desync exactly.

| | |
|---|---|
| Handshake wins | client saved `mp_depot`/`SND`, **loaded `mp_foundry`/`TDM`** |
| Identity adopted | `localId` **1**, and **2** on a later join — not 0 |
| Spawn | grounded at y=0 inside the map, 0% loss, lead 5 ticks, RTT 51 ms |
| Hit feedback | hitmarkers **7**, of which **2 lethal**, against `damageOut` 7 |
| Incoming | `damageIn` 3 = hurt vignette 3 = hit-direction chevron 3 |
| Killfeed | 94 lines with real names and teams, `involvesLocal` correct |
| Scoreboard | all **15** rows, per-player K/D/A, local row named `AUDIT` and flagged |
| Match end | `EV.MatchEnded` fired on the client: `A 75-48 localWon=true` |
| Server rotation | `match over — A 75-48 on FOUNDRY` → 6 s → `starting match 2: TDM on mp_depot with 1 connected` |
| Join mid-rotation | client joined match 2 and loaded **`mp_depot`**, the server's current map |

**Rotation with a client connected through it**, which is the case both self-inflicted bugs
above were hiding in:

| | |
|---|---|
| Client followed the server | `mapsSeen: ["mp_foundry", "mp_depot"]`, `rebuilds: 1` |
| Identity reassigned | `localIds: [2, 1]` — adopted, not stale |
| Previous result announced | `EV.MatchEnded` `B 64-75`, client reached SUMMARY |
| Uncaught errors | **0** |
| Spawned into the *new* map | grounded, y=0, 14 remote actors |
| **No state survived** | killfeed 10 lines, scoreboard 10 kills, both from the new match only |
| Score agreed exactly | replicated `4-6` against a board summing to A 4 / B 6 |
| Post-rotation wiring | with `localId` now 1: hitmarker, hurt vignette and chevron all fire; feed reads `AUDIT[A] -> KESTREL[B] involvesLocal=true` |

**Single-player, same build** (HARD RULE 8): `networked:false`, no session, `localId` **0**, the
client's *own* `mp_depot`/`SND` selection honoured, 9 local bots, 10 scoreboard rows, local row
`OPERATOR` flagged, **console clean**.

**The existing gates, unchanged.** `npm run check` passes: boundaries ok (263 files), all three
typecheck targets clean.

`npm run harness` is **bit-identical to the M10 record** — match 1 `A wins 75-46` in 13705
ticks, per-tier hit rates `RECRUIT 0.079 / REGULAR 0.109 / HARDENED 0.191 / VETERAN 0.254`,
5/5 matches completed, heap 6.6 → 9.8 MB. The `LocalIdentity` and `authoritative` changes
touch no simulation state, and this is the measurement that says so.

`npm run netharness`, 2 clients, 30 s, no added conditions, against an 8-bot server:

| | HEADLESS1 | HEADLESS2 | M10 record |
|---|---|---|---|
| Mispredictions | 11 / 576 | **3 / 599** | 1-8 / ~600 |
| p50 | 5.4 cm | 4.5 cm | 7.7 cm |
| p99 | 10.8 cm | 7.7 cm | 15 cm |
| Max replay | 3 | 1 | 3 |
| Snapshot bytes | 229 | 229 | 231 |
| Snapshots lost | 0 | 0 | 0 |
| `metresSinceRespawn` | 90.2 | 128.8 | (the round-1 freeze detector) |

Same band as the record, slightly better on both percentiles.

**A note on how to read that harness, because it misled this session first.** Run against the
*rotating* verification server — 14 bots, a browser client connected and firing, 17 replicated
entities — the same harness reported **166/597 and 175/509, p50 27-42 cm**, which looks
exactly like a prediction regression and is not one. It is contention: more entities, more
simulation per tick, and a second real client. Always re-run against a clean server at the
recorded configuration before believing a netcode number has moved.

**Caveat on the hit-feedback numbers.** The engagement above was driven by a scripted aimbot
wired into the command sampler, because the verification browser pane does not composite and
the real input path needs pointer lock. Every damage, kill, killfeed and score figure came off
the wire from the real server through the real client. The final post-rotation row is the one
exception and is marked as such: those three payloads were re-emitted onto the bus by hand,
replaying exactly what `NetSession` synthesises, to assert the *reassigned* identity reaches
the presentation layer without waiting on marksmanship at 48 m.

### The lesson, which is round 1's lesson with the scope corrected

Round 1 said: *turning off a client-side system is half a change.* That was right and too
narrow. The general form is:

**When the server takes ownership of a fact, every reader of that fact is a call site, and the
compiler cannot find them for you.** The map, the entity id, the phase, the roster and the
match lifecycle were each one fact that moved, and each one had between one and twelve readers
still reading the local copy — which still existed, still held a plausible value, and still
rendered. Four of the five reported symptoms were *silent early returns*, not errors.

So: when something becomes authoritative, grep for every reader of the local version before
writing the replication, and make the local version impossible to read by accident — a
`LocalIdentity` that must be injected, a `CombatantDirectory` that must be supplied, an
`authoritative` flag that must be set. A constant anyone can import is a call site you will not
find until a playtest.

## What Milestone 11 needs to know

- **Read "What is not done" first.** Items 1, 3 and 6 are the ones that will bite.
- **`buildEntities` is where the Ghost perk goes.** It builds one entity list shared by every
  client, which is correct for TDM and is exactly the assumption Ghost breaks. It will need a
  per-client filter, and that is the only place a "who can see whom" rule belongs.
- **The owner block is full `f32` on purpose.** It is compared against a prediction, not
  drawn, and quantisation error in a comparison is indistinguishable from a misprediction. Do
  not "optimise" it to match the remote entity encoding.
- **`PROTOCOL_VERSION` must be bumped on any layout change.** The handshake refuses a mismatch
  before decoding a single gameplay byte, which is the only thing standing between a skewed
  build and a week of bugs that look like physics.
- **Everything replicated is in one table**: `EntitySnapshot` in `shared/net/Snapshot.ts`. If
  M11 wants to replicate killstreak entities or objective state, that struct and its field
  mask are the whole change.
- **`Rewind` owns the histories, not the entities.** A `Bot` runs in the browser too and has no
  business carrying a 60-tick buffer for a server-only feature.
- **There is now exactly one authoritative source for local death**: the replicated
  `EFlag.Alive` on this client's own entity, routed through `ClientMatch.applyReplicatedSelf`.
  Do not add a second. M11's killstreaks and S&D round resets should go through the same
  method rather than reaching for `playerDead` directly.
- **`MatchFlow.applyReplicated` is how any match state reaches a client.** S&D's round state,
  side swaps and the bomb timer are the same problem M10 hit with the clock, and they will
  present the same way: a HUD that renders confidently and is completely wrong.
- **The adaptive jitter buffer is a delta, not a level.** `InputBuffer.takeStarvation` returns
  repeats since the last read; the smoothing lives on the client. A level decayed per read at
  20 Hz was measured to be back at zero before the client ever saw it.

---

# M10.5 — Tier 1 fixes carried back from M11

`M10-fixes-handover.md` carried 21 fixes out of the discarded M11 matchmaking work. All 21 are
applied on top of `m10-complete` (`afe7399`). Tier 2 and Tier 3 are deliberately untouched.

## The harness baseline moved, and this records it deliberately

Fix #2 (bots ignore the pre-match freeze) alters the server sim from tick 180 onward. This is a
**deliberate** baseline change bringing the server into parity with the client, which has
assigned `bots.inputFrozen` since M7. It was isolated before being recorded: the other six
server-sim fixes were applied first and measured **bit-identical** to `m10-complete` across all
five matches, so everything below is attributable to #2 alone.

`npm run harness` — 5 matches, TDM on mp_foundry, 10 bots, tier MIX, seeds 1-5:

| | match 1 | RECRUIT hit rate | completed |
|---|---|---|---|
| `m10-complete` | A wins 75-46, 13705 ticks | 0.079 | 5/5 |
| fixes 1,3,11,12,13,20 | A wins 75-46, 13705 ticks | 0.079 | 5/5 |
| **+ fix #2 (M10.5)** | **A wins 75-53, 16144 ticks** | **0.066** | **5/5** |

The M10.5 row is *identical* to M11's post-fix record, which the handover expected to differ.
It does not: the sim is deterministic and the rollback is clean, so the same change on the same
seeds produces the same match. That is a stronger result than the handover predicted and is
worth keeping as a determinism check — if a future M10-lineage change makes seed 1 stop landing
on `75-53 / 16144 / 0.066`, something in the shared simulation moved.

Groups 3-5 (server net, shared, client) were measured after application and are also
bit-identical to the M10.5 row: none of them touch the bot-only sim.

## Verified, not asserted

- **#9, the pulled cable.** `netHarness --disconnect hard` against a live `serve.js`. With the
  fix the server logs `connection from 127.0.0.1 closed: connection lost` — `close()` ran, so
  `onLeave` ran. With `Session.ts` reverted to `m10-complete` and everything else in place, that
  line is **absent**: the entity still disappears, but via `GameServer.reap()`, which salvages
  the seat without ever calling `onLeave`. That is why M10 and Gate A passed — the *entity*
  consequence was covered by a second path, and every other consequence of a disconnect was not.
  The probe was watched going red before being believed.
- **#11, `smallerTeam`.** Two headless clients now seat as entity 1 on **A** and entity 2 on
  **B**. Before the fix both went to A.
- **#20's log line** is live: `HEADLESS1 seated as entity 1 on team A — ar_carbine/pistol_talon,
  perks none (no loadout sent; server defaults)`.
- `npm run check` is clean: boundaries ok (263 files), all three typecheck targets.

## Known gaps, carried forward deliberately

1. **#20 has no transport at M10 and the divergence is therefore still open.** The server-side
   half is in — `NetPlayerDeps.perks`, `controller.speedScale`, the `loadouts` map, `perksOf`,
   `loadoutOf`, and the Dead Silence hook — and `addPlayer(name, loadout?)` accepts a class.
   **Nothing sends one.** M11 carried it over `MsgC.Loadout`, a master-scoped message that died
   with the rollback. Until the Skirmish flow gives the client's class a path to the server
   before `addPlayer`, a browser client running the shipped ASSAULT class still predicts 7%
   faster than the server simulates. The three rules in the handover (send ids not resolved
   numbers, validate at the boundary and never throw, defer mid-match class changes) apply to
   whatever transport replaces it.
2. **#12, #13 and `replacePlayerWithBot` have no callers.** They are forward-looking by design —
   the handover says so — but `BotDirector.removeOne` did not exist at `m10-complete` and had to
   be written for `removeBotForSeat` to compile. It releases the roster slot, the id map, the
   `DamageSystem` registration and the cover reservation; `ServerMatch.removeBotForSeat` adds
   the `Rewind` unregister that `shared/` cannot do. **Route all bot removal through
   `removeBotForSeat`, never `bots.removeOne`.**
3. **`Range.ts` was left on the old two-clock seed.** The handover names five modes for #19 and
   the range is not one of them, but `Range.checkWinCondition` decides on its own `ticksLeft`
   exactly as the other five do — so a `roundSecondsOverride` would shorten `MatchFlow`'s clock
   and not the range's. One line, and the same fix, if a harness ever runs the range.
4. **`MatchEquipment` still throws with `PLAYER_ENTITY_ID`.** Line 148 passes the constant as
   the thrower's source id. That is the *identity* bug (M10's `LocalIdentity`), not the *team*
   bug this pass audited, and it is out of scope here — but a networked player's grenades are
   attributed to entity 0.

## The `PLAYER_TEAM` audit found eight more

The handover's red callout — "fixes 5, 15 and 16 are one bug in three places" — asks for a grep
of `PLAYER_TEAM` across `src/client/` afterwards, with every remaining hit justified. Eight
could not be justified, all of them the same constant standing in for a server assignment:

| Site | What was backwards for a team-B player |
|---|---|
| `ClientMatch` → `MatchHud.localTeam` | the friendlies list and hit attribution |
| `ClientMatch` → `MatchEquipment.localTeam` | whose grenades are friendly |
| `ClientMatch` → `MatchMeta.localTeam` | streak ownership |
| `ClientMatch` → `MatchObjectives.localTeam` | capture-ring and dog-tag colours |
| `ClientMatch.fillObjectiveBanner` | the Domination HELD / CAPTURING prompt |
| `ClientMatch.fillMinimapStreaks` | whose UAV sweeps, whose minimap is scrambled |
| `Game.bankProgression` | whether the match counted as a win, for XP |
| `GameScreens.showSummary` | victory or defeat on the summary screen |

All eight now go through `Match.localTeam`, which is a no-op in single-player. The remaining
hits are the constant's own declaration, the `deps.localTeam ?? PLAYER_TEAM` fallbacks that
define it, and `respawnPlayer`'s `selectSpawn` — a single-player-only path, since the server
owns respawn over the network.

## Still needs a human

Nothing headless can see the rest. The handover's playtest checklist stands unchanged: the
respawn timer counting down, respawned bodies not stuck flat, respawns cutting rather than
sliding, the weapon-swap model, the FFA banner, the S&D alive counter, Domination colours and
the thermal pass **as a team-B player**, and a real single-click test on any periodically
rebuilt UI.

---

# Milestone 11 — Skirmish Multiplayer Flow

**Gate A is complete. Gate B is not started.** Everything below is Gate A.

The flow, in one sentence: click Play Multiplayer, be shooting in a permanent warmup arena
within one round trip, vote on what to play next while already playing, and slide into the real
match without a loading screen.

## What replaced what

`GameServer` — a match, a loop, a socket listener and a rotation policy in one class — is gone.
`Server` is a scheduler over two instances: a permanent `WarmupMatch` that exists from boot to
shutdown, and at most one `LiveMatch` allocated when a vote resolves and destroyed when it ends.

```
server/
  Server.ts          process entry, capacity, boot bake, the tick
  Router.ts          the single answer to "which instance is this player in"
  Migration.ts       the named-tick move
  MatchAllocator.ts  IMatchAllocator, in-process, and the faulty wrapper
  MapBakery.ts       all four maps baked once, before the listener opens
  instance/
    MatchInstance.ts base: lifecycle, seats, snapshots, teardown
    WarmupMatch.ts   the permanent arena — greybox room, FFA, dummies, 3 bots
    LiveMatch.ts     ALLOCATING -> LOADING -> READY_WAIT -> RUNNING -> ENDED -> DESTROYED
    VoteCycle.ts     the 60 s cycle
    InstanceClock.ts per-instance tick index and snapshot phase offset
```

Protocol is **v3**: `Loadout`, `Vote` and `Ready` client-side; `Migrate`, `Vote`, `Prepare`,
`Summary` and `Notice` server-side. `Welcome` gained an instance id and the named migration tick.

## The four binding handover items

| Item | Where it landed |
|---|---|
| **Tier 1 #20** — the Lightweight misprediction | The class rides the `Hello`. See below. |
| **Tier 2 §A** — forced snapshot when stepping stops | `MatchInstance.step` |
| **Tier 2 §C** — "playing" is not "live" | `SessionState` renamed; see `Session` |
| **Tier 2 §D** — `afterIdentity` ordering | `JoinResult.afterIdentity`, called last |

### #20 needed the transport to be the handshake, not a message after it

The handover said the fix needed *"some path for the client's class to reach the server before
`addPlayer`"*. The first attempt used a `MsgC.Loadout` sent immediately after joining, and it was
measured at **178 mispredictions in 1277 comparisons** — because the seat is created *inside* the
handshake, so a class arriving one frame later arrives after the entity it was meant to
configure. Moving it into `Hello` took that to **0**.

`MsgC.Loadout` still exists, for a class edited mid-session (§6.6). That path defers to the
player's next spawn on both sides, which is the one moment client and server already agree is a
discontinuity.

## Deviations, and why

1. **S&D best-of-5 is longer than what shipped, not shorter.** §6.4 asks for *"a shortened
   best-of-5, not best-of-9"*. There has been no best-of-9 since M7's playtest cut `SND_CONFIG`
   to a best of three. Built to the brief — `SND_SKIRMISH_CONFIG`, swap after round 2 so round 3
   is the first from the other side — but it *lengthens* the mode by one round per side.
2. **The warmup arena is FFA with both limits switched off, not `RANGE`.** §6.3 asks for
   free-for-all rules with damage live; `RANGE` sets `populatesRoster: false`, which is right for
   a testbed and wrong for an arena two people are meant to duel in. The M2 dummies survive
   because they are *map* data, not mode data. See `FFA_WARMUP_CONFIG`.
3. **A `VotePhase.IDLE` that is not in the brief's table.** §4.20 requires the cycle to cancel
   when every human leaves; an arena with nobody in it is not in a phase of a countdown.
4. **The instance panel is split across two places.** §7 wants both instances side by side with
   per-instance and total tick ms. A client can see exactly one instance and cannot observe the
   server's event loop at all, so the server reports that pair in its metrics and the client
   panel reports what a player's machine can actually see. See `SkirmishPanel`.

## Bugs found by running it

Six, none of which a typecheck could have caught.

1. **An `ENDED` instance stops being stepped**, so a summary hold measured against its own clock
   could never elapse. Every player sat on the summary forever. Held against the master tick.
2. **The vote cycle counted humans in the arena**, so a successful migration was
   indistinguishable from a mass disconnect: the cycle cancelled the moment everybody entered the
   match and no further ballot ever opened. Counts humans *connected to the server* now.
3. **`ByteWriter.bytes()` returns a view, and `Server` held one writer for every send.** The
   `Prepare` that starts each client's background build was overwritten by the vote broadcast
   behind it. Every readiness handshake hit its eight-second timeout and every transition fell
   back to a synchronous build, with nothing in either log saying why. Encoding moved onto the
   session, which owns its own writer.
4. **A migration fired `onNewMatch` and `onMigrated`**, so the client rebuilt its world twice —
   and the second rebuild found the background build already consumed by the first.
5. **A relocation past 5 m was counted as a failed prediction.** One spawn gave a p99 of
   **30.26 m** — the width of Foundry, and the same signature M10 recorded before the respawn
   case was handled. `Prediction.reconcile` now treats a large jump as a relocation.
6. **A cancelled background build leaked its geometries and materials.** `buildMapChunked` wraps
   its body in `try/finally` and `cancel()` calls `.return()`.

## Verified — Gate A

Loopback unless stated. Structural claims only; see HARD RULE 9.

| # | Criterion | Result |
|---|---|---|
| 1 | Click to first accepted input | **43-70 ms** loopback, **165 ms** at +100 ms simulated latency — one round trip |
| 2 | Play Solo | Works, unchanged. The M9 split held: the local path needed no repair, only a button. |
| 3 | Warmup arena | Greybox room, FFA, instant respawn, 3 bots, M2 dummies present |
| 4 | Full vote cycle | Phase boundaries exact against config on every cycle. Tie and empty ballot both broken randomly with seed, draw index and candidate set logged |
| 6 | Vote tally server-only | Tally exists in exactly one place (`VoteCycle.votes`); out-of-window votes rejected and logged |
| 9 | **Post-migration mispredictions entering a live match** | **0 for every client on every cycle**, at full timings under 100ms +/-30ms, 2% loss |
| 13 | Allocate/destroy cycles | 20 cycles: `EventBus` subscriptions **flat at 21**, heap +0.3 MiB |
| 14 | `FaultyMatchAllocator` | All three: latency allocates late and everybody migrates; failure and capacity leave every player in the arena with a message, nothing orphaned |
| 15 | Routing | A message addressed to another instance is rejected and counted (`Router.misroutedMessages`) |
| 28 | Total tick ms, both instances live | **~1.3 ms mean** (arena ~0.3, live ~0.95) against a 3.0 ms per-instance budget |
| 29 | Boot bake | **93.9 ms** for four maps, **1.90 MiB** resident |

Verified in a real browser against a live server: the menu, one click to the arena, the world
built from the server's map, the overlay drawing the announced mode above the map ballot with a
server-derived countdown over live gameplay, allocation at **6.1 ms**, migration at
**0.9-1.2 ms**, and the joining browser logged server-side as `perks LIGHTWEIGHT · QUICKDRAW` —
the shipped ASSAULT class, applied to the seat created during its handshake.

## Not verified, and why

- **Client background build time per map (§8.7)** and **a single click landing on a vote button
  (§8.18)**. Both need a browser that composites. The preview pane never fires
  `requestAnimationFrame` — confirmed directly, the callback does not run — so `draw()` never
  runs, the build is never pumped and the overlay's clock never ticks. The readiness timeouts
  observed there are that, not the flow. **These two numbers are open.**
- **Anything against a deployed external server.** Every number above is loopback.
- The 100-cycle leak run and the 12-hour soak. The 20-cycle run is a proxy for the first.

## The residual this leaves

Migrations **into** a live match are clean. Migrations **back to the arena** carry 1-3
mispredictions in their 60-tick window, all sub-25 cm, at roughly M10's shipped residual rate
(~1% of comparisons). It is not Tier 1 #20's signature — that is a sustained, every-tick,
perk-driven divergence measured at 407/559 — and it survives with the perk removed, so it is not
loadout-related. The gate distinguishes the two rather than summing them, because folding two
different claims into one number is how a real regression gets waved through on the grounds that
the number was never zero anyway.

## What Gate B needs to know

- **`MatchInstance.buildEntities` is where Ghost goes.** It builds one entity list shared by
  every client in the instance, which is correct for TDM and is exactly the assumption Ghost
  breaks. Note that removing a Ghost player from the snapshot outright would make their *body*
  invisible, which is not what Ghost does — it hides you from UAV intel. The per-recipient filter
  belongs there and needs to be an intel filter, not an entity filter.
- **The divergence checker compares two independent paths** — score from replicated events
  against score from the snapshot header — and deliberately not `MatchFlow` against the header,
  which is assigned from it and could never fail.
- **`variant: 'SKIRMISH'`** is how a live match differs from a menu match. S&D reads it today.
- **The arena must never reach `MATCH_END`.** `WarmupMatch.step` has a latched error for it.
- **The loadout is locked at migration**, captured into `MatchRequest` from `Session.loadout`.
  Anything Gate B adds that changes a player's class must go through `setPendingLoadout`, which
  defers to the next spawn — never applied to a standing body.

---

## M11 playtest round 1 — three bugs from a real browser

The headless harness passed every one of these. All three needed a human, a real
`requestAnimationFrame` and a real keyboard.

### 1. Severe rubberbanding at spawn — two independent causes

**(a) The clock was seeded with a fabricated zero-RTT sample.** `NetClient.adopt` called
`clock.sample(receivedAtMs, receivedAtMs, ...)`, which claims the `Welcome` arrived with no
network delay. That is poisonous in this estimator specifically: `ClockSync.recompute` elects
the offset belonging to the **lowest-RTT** sample in its window, and a fabricated zero always
wins. One made-up sample therefore owned the clock offset for the whole sixteen-sample window —
about four seconds at 4 Hz — and held it half a real round trip too low. The client ran behind
where it should, its commands arrived for ticks already simulated, the input buffer starved and
repeated, and prediction pulled apart from simulation on every tick.

`ClockSync.seed` now sets a provisional offset **outside** the sample window, and the first real
ping replaces it outright rather than being averaged with it.

Measured with a new spawn-window probe (mispredictions in the first four seconds after joining),
three clients at `100ms ±30ms, 2% loss`:

| | OP1 | OP2 | OP3 |
|---|---|---|---|
| Before | 1 | 2 | 3 |
| After | **0** | **0** | **0** |

The probe was watched going red before being believed green, per standing lesson 4.

**(b) The client resolved a different class than it sent.** Two separate paths:

- `Game.applyLoadout` passed `this.selection.modeId` — the *local menu* selection — into
  `applyEquippedLoadout`. The mode's `unrestricted` flag decides whether unlock gates are lifted,
  and the Shooting Range lifts them *and resolves a different slot entirely*. A player whose menu
  was last left on the range would send their equipped class and locally resolve the range class.
- `resolveEquipped` sanitises the slot against unlocks **in place, at resolve time**;
  `toNetLoadout` read the same slot at *handshake* time, which is earlier. So the raw slot went
  over the wire and the stripped slot was resolved locally.

Either one produces a different `perkState.moveSpeedMult` on the two sides, which is Tier 1 #20
arriving from the client's side rather than the server's, and presents identically. The mode is
now the server's when there is one, and the slot is sanitised before it is copied to the wire.

### 2. Number keys did not register, and clicking fought pointer lock

`VoteOverlay.handleDigit` was written and **never called** — the exact "implemented but not
verified usually means unreachable" trap from the handover's standing lessons. `Input` had no
digit hook at all.

`Input.onDigit` now offers digit keys to a listener *before* the binding bits are set, and a
listener that takes the key stops it reaching its normal binding. That matters because the digits
are already bound: 1-2 are weapon slots and 3-5 are killstreaks. A ballot is open for twenty
seconds in sixty and only in the arena, so the cost is bounded and the keys behave normally the
rest of the time.

Two further findings while verifying it:

- **Synthetic key events carry an empty `e.code`.** Automation dispatches `key` without a
  physical position, and so do some on-screen and IME keyboards. `digitFor` now falls back to
  `e.key` when `code` is absent.
- **Mouse voting is removed entirely**, at the playtest's request and for a good reason: the game
  holds pointer lock, so a click on the overlay is a click the browser has already delivered to
  the canvas as a *shot*. The whole surface is now `pointer-events: none` including the options,
  which are rendered as `disabled` buttons — still the live tally and still the accessible name,
  but not operable by pointer.

Verified end to end in a browser against a live server: `map vote: option 2 won outright with 1`.

### 3. The transition aborted silently and looped

Three defects, and the first is a design error rather than a wiring bug.

**(a) The background-build budget could never meet the readiness deadline.** `DEFAULT_BUDGET_MS`
was 2 ms per frame, chosen so the arena could not judder — without checking it against the
deadline it has to meet. 2 ms at 60 FPS is **120 ms of build per second of wall clock**, so a map
costing a second or two of work needs 8-17 s to finish, against an 8 s timeout. The handshake was
destined to time out on a *healthy* machine, and every transition fell through to the §4.18
loading-screen path that exists for the exceptional case.

The budget is now 5 ms (300 ms/s at 60 FPS, 150 ms/s at 30) and the timeout 20 s. They are one
decision and are documented as one. **The measured build time per map is what validates the pair
and still needs a real browser.**

**(b) `stepFlow` was not wrapped.** §4.18 requires each *instance's* step to be guarded so one
world cannot take down the process; the **scheduler** around them was not, and it is the newest
code in the milestone — allocation continuations, the readiness handshake, the named-tick
migration and teardown all run there. An exception escaping it reached `serve.ts`'s
`uncaughtException` handler, which logs and keeps the process alive, leaving `this.live` set with
no instance able to reach `ENDED`. Every cycle after that hit the one-live-match cap and returned
everybody to the arena — a server that votes, counts down and then silently does nothing, for
ever. It is now caught and **recovered**: the half-built match is destroyed, everybody goes back
to the arena and is told, and the cycle resumes.

The same hole existed in the per-session `receive()` loop. §4.16 requires malformed input never to
crash the server, and the decode paths honour that — but the *handlers* above them can throw
(`onLoadout` runs `resolveLoadout` over a class a client chose). Each session's drain is now
wrapped, and a session that throws is dropped rather than taking the tick with it.

**(c) Every abort was invisible.** `VoteOverlay.apply` hid the surface whenever the phase was not
a ballot — and the phase during a failed allocation is `ALLOCATING`, so the next 4 Hz broadcast
wiped the notice explaining what had happened. §4.17 requires every player to be left in the arena
*with a message*, and a message shown for 250 ms is not one. A live notice now keeps the surface
up, `ALLOCATING` renders a heading of its own, and **every** abort path notifies — not only the
allocator's: nobody-left-to-migrate, a vote resolving onto an existing match, an unresolvable
ballot, and the new flow-fault recovery.

### Still not reproduced

The exact browser sequence behind (3) was **not** reproduced headlessly — two full cycles at
shipped timings ran clean. So (b) is a structural hole that produces precisely the reported
symptom and makes it permanent, not a confirmed root cause. If it recurs, the new logging names
it: `the skirmish flow threw`, `session N threw while receiving`, or `a vote resolved while a
match was already present (state X)`.

---

# M11 Gate B — in progress

**Gate A is sealed. Gate B is part-done.** Six commits on
`gate-b/objective-replication` beyond the objective-replication groundwork:
`2064b32` mode state · `0b8a4b7` bot replacement · `1740c6c` streaks server-side ·
`f33d7d1` streaks on the wire and Ghost · `65c8adb` Chopper case 4 · `9ac32a6` server-side
equipment · `b778e76` grenades on the wire · `a596ed7` the divergence checker ·
`b38202c` the cosmetic audit · `7546671` the networked spectator. Everything below is measured, not asserted; where
something is unverified it says so.

## The one root cause behind most of it

`MatchFlow.simulate` is skipped on a networked client (`ClientMatch` guards it with
`!isNetworked`), and **every piece of mode state is advanced from it** — `mode.onTick`,
`mode.onKill`, the plant timer, the fuse, the capture recount. The v4 objective channel fixed
the symptom for Domination's flags and left the identical hole open everywhere else.

The three modes failed differently, and the difference is the useful part:

| Mode | What a networked client actually had |
|---|---|
| Domination | Flags **stale** — replicated at v4 |
| Kill Confirmed | Tag list permanently **empty**; nothing dropped, collected or expired |
| Search & Destroy | Fuse **stopped**, holding its constructed value all round |

A stale value looks like a bug. An empty list and a frozen number look like a feature nobody
has got to yet, which is why neither was ever reported.

## What was built

**Protocol v5** — `MsgS.Tags` and `MsgS.Bomb`, alongside v4's `Objectives`.

**The seam is on `GameMode`**, beside `objectiveZones`, so the server asks any mode for its
state without importing the concrete classes:

- `dogTags: readonly TagInfo[] | null` — **`null` and `[]` differ deliberately.** `null` is
  "this mode has no such thing" and sends nothing; `[]` is "none right now" and must still be
  sent, or a client never learns the last tag was collected. Zones may skip on empty because a
  zone list is fixed at construction; a tag list is not.
- `bombInfo: BombInfo | null` — returns **one object the mode mutates**, never a literal. It is
  read on the snapshot cadence from inside the tick and §4.7 allows no allocation there.

## Three pieces of wiring that never crossed to the server at M9

This is the milestone's real finding, and all three have one shape: the fact moved to the
server, the code around it stayed in `ClientMatch`, where it kept working for single-player and
proved nothing about the half that had moved. It is the standing authority-migration failure,
three times over.

1. **`ServerMatch` never set `bots.objectives`.** `ClientMatch` has since M7. So
   `BotDirector.objectives` was null in every networked match and `ObjectiveIntent` had nothing
   to ask: server-side bots pursued no flag, chased no dog tag and never walked onto the bomb.
   Since a bot's whole interaction vocabulary is `onArrived`, **no S&D round played over the
   network could be decided by a plant.** Rounds still ended, on elimination and the clock, so
   nothing crashed and nothing logged.
2. **The Use key had no server-side reader.** Pick up, plant, defuse and cancel lived only in
   `ClientMatch.stepBombInteraction`. Between this and (1), *nobody* in a networked S&D could
   touch the bomb. `ServerMatch.stepBombInteractions` is the authoritative port, run before the
   flow so a plant that starts and completes on one tick resolves identically on both runtimes;
   the client's copy is now behind `!isNetworked` so it is not a second authority.
3. **No round reset for humans.** `ClientMatch` respawns everybody on `EV.RoundStarted`;
   `ServerMatch` did not, and there is no other route home because `maybeRespawn` gates on
   `respawnAllowed`, which in a one-life mode is false by construction (`0 < 0`). **A human who
   died in round one of a networked S&D was dead for the rest of the match** — able to look
   around, unable to move. Bots were unaffected, which is why nothing logged.

## Two single-player assumptions that do not survive N players

- `SearchAndDestroy.manualPickupId` (one id) became `manualPickup(id)` (a predicate). One id is
  exactly right for a browser and silently wrong on a server, where every human past the first
  would have collected the bomb by walking over it.
- `StreakSystem.localId` became `reportProgressTo(id)`, and `simulate(tick, cmd)` became a
  per-streak `commandFor(id)`. The old signature flew whichever chopper matched `localId` off
  the single command it was handed — on a server, two gunners would have shared one stick.

Both are the same shape and worth looking for elsewhere.

## Bot replacement (§6.7, §8.27)

`removeBotForSeat` and `replacePlayerWithBot` existed with **no call sites** — the handover's
own "implemented but not verified usually means unreachable" trap. A live match spawns the
mode's full authored roster before anybody migrates in, so every seat granted afterwards has to
take a bot with it; it did not, and three humans in a ten-bot TDM made it thirteen bodies.

`unseat` gained a **cause**, because only the caller can tell a departure from a migration:

- `'disconnected'` from a RUNNING match leaves a bot behind (in S&D the last human on a side
  dropping out ends the round for everybody, scored as an elimination nobody achieved).
- `'migrated'` does not — same player, one instance over, same synchronous call. Treating it as
  a departure would add a bot every cycle and turn §8.13's flat hundred into a staircase.

Mid-round joins are blocked while the flow is `LIVE` and deliberately **not** during `WARMUP`,
which is the 3-2-1 every migrating player arrives during; blocking there would hold the whole
lobby out of round one.

## Measured

Loopback, shortened timings where noted. Every probe was watched red first, and in three cases
the red state was the real shipped bug rather than a synthetic one.

| Probe | Before | After |
|---|---|---|
| KC tags | channel did not exist | **1260 upd / 29 distinct / 10 on the floor at peak**, match to completion |
| S&D bomb | `867 upd / fuse ticked 0 / 0 interact` — replicated and constant | **1590 upd / fuse ticked 899 / 100 interact / planted+exploded** |
| TDM roster | 3H+10B=13 | **3H+7B=10**, the mode's authored count |
| FFA roster | — | **3H+5B=8**, tracks the mode rather than a constant |
| S&D deaths per client | at most 1 for the whole match | **2** — impossible in a one-life mode without the reset |
| Leak, 12 cycles | — | subscriptions **26 to 26 (+0)**, heap +0.26 MiB |
| Regression, 5 matches | — | 5/5 complete, **scores identical on the same seeds** |
| Mispredictions into live | 0 | **0**, every run |

The subscription baseline moved 21 to 26 because the permanent arena now holds a `StreakSystem`
too. The number that matters is the **delta across cycles**, which is 0.

## Killstreaks, end to end (protocol v6)

Commits `1740c6c` (server-side system), `f33d7d1` (the wire and Ghost), `65c8adb`
(Chopper case 4).

**`MsgC.Streak`** is a request, not an instruction. §4.16 makes the client untrusted, so all
three things it could lie about are answered from server state: *which instance* (the router),
*whether they hold it* (`activate` returns null otherwise), and *where it lands* (the server's
copy of the player's position). The only client-chosen coordinates are the mortar's mark.

**`MsgS.Streaks`** is the first genuinely **per-recipient** message in the protocol, and it has
to be:

| Part | Scope | Why |
|---|---|---|
| Entity list | Common | A sentry is a physical object both teams see and shoot |
| Earn state | Per player | What you have earned is yours |
| UAV contacts | Per team | Broadcasting them puts a UAV's value in the untrusted half |

**Ghost is inside the intel filter, not beside it.** §8.22 says *"show a Ghost player's position
absent from the snapshot sent to enemy clients"*, and the obvious implementation of that
sentence is wrong: removing the entity makes the **body** invisible, which is not what Ghost
does. `Uav.onTick` already declines to record a contact for anyone failing `visibleToUav`, so
the perk works by never entering the intel list — and `buildEntities` is untouched, so the
player still renders and still dies.

Client side: a networked match **no longer simulates its own `StreakSystem`**. That would put a
second sentry, with its own aim and its own damage, on top of the one the server resolves shots
against — the Domination flag bug with a trigger. `ReplicatedStreaks` holds the server's answer;
the HUD, minimap and renderer each read it through one accessor. Cleared on migration.

Two single-player shapes had to be generalised: `localId: number` became
`reportProgressTo(id)`, and `simulate(tick, cmd)` became a per-streak `commandFor(id)` — the old
signature flew whichever chopper matched `localId` off the one command it was handed, so two
gunners on a server would have shared one stick.

### Chopper Gunner, §8.23's four cases

| Case | Covered by | Status |
|---|---|---|
| Gunner killed | `EV.EntityKilled` → `onDeath` | Pre-existing (M7) |
| Match ends mid-streak | `EV.MatchEnded` → `endAll` | Pre-existing (M7) |
| Instance destroyed mid-streak | `dispose` → `endAll` | Measured by the leak run |
| **Gunner disconnects** | **nothing** | **Fixed here** |

The fourth was a real hole: no death is emitted, the match is still running and the instance is
still alive, so a gunner who pulled their cable left a gunship flying on a command that would
never arrive again, owned by an entity that had stopped existing. Measured at **31.9 seconds** of
orphaned flight. `StreakSystem.onOwnerRemoved` deliberately reuses the death rules — the chopper
ends, pending streaks are lost, and a placed sentry or crate stays.

### Measured, red before green

| Probe | Red | Green |
|---|---|---|
| Streak loop | channel did not exist | granted → 3 pending → 3 requests → 3 grants → 1254 frames / 3 entities / 312 sweep frames |
| Ghost | `OP1[108,105,**2**,106,107]` — 2 leaks, CHECK FAILED | `OP1[108,105,106,107]` — entity 2 gone, bots remain |
| Chopper case 4 | entity 3's chopper sent to both survivors **31928 ms** after they left | last seen **0 ms** relative to the drop |
| Leak | — | 12 cycles, subscriptions **26 → 26 (+0)**, heap +0.3 MiB |
| Regression | — | 5/5 matches, scores identical on the same seeds |

### Three probes were wrong before they were right

Worth recording, because all three would have shipped as false greens:

1. **`--ghost --no-perks` gave `--ghost` precedence**, so the control run that was supposed to
   strip the perk equipped it anyway and passed. A probe that could not go red.
2. **It compared entity ids from two different instances.** The ghost's id was read at *report*
   time (entity 5, in the arena) against contacts recorded during the *match* (entity 2). Ids
   are per-instance — the reason `Session.playerId` exists — so it could never have found a leak
   however broken Ghost was.
3. **The chopper probe asked "was any chopper present"**, and all three clients had called one
   in, so the survivors' own gunships kept the answer true. It reported a failure that was really
   two players flying normally. Keyed by owner now.

The standing lesson — *watch every probe go red before believing it green* — earned its place
three more times in one sitting.

## Grenades on the wire (protocol v7)

`MsgS.Projectiles` — grenades in flight and smoke on the ground. **Broadcast**, unlike the streak
view: a grenade has no secrets. But consumed **two different ways**, which is what §6.8's one
sentence about prediction actually requires:

| Whose | How | Why |
|---|---|---|
| Somebody else's | Replicated, drawn from the record | Never simulated locally; nothing to reconcile. §4.12 applied to a thrown object |
| Your own | Predicted, already in the local pool | The authoritative record is a **correction**, and it is excluded from render adoption — drawing it beside the predicted one is the double-render |

Replicated **into** the pool `EquipmentFx` already walks, so the renderer is untouched by the
whole feature. `Projectile.replicated` marks an adopted slot and `EquipmentSystem` steps none of
them — no flight, no fuse, no trigger, no detonation. A client integrating a decided trajectory
parts company with the server the first time one of them clips a corner the other missed.

Smoke is replicated rather than left to the client's own field, and not for symmetry: **smoke
occludes bot LOS on the server**, so where the cloud is decides who can see whom. A client
drawing one a metre off is showing cover that does not exist.

### The double-damage was real

`BotDirector` pushes the local player onto its roster and `EquipmentSystem.detonate` walks that
roster, so a networked client's own blast applied damage to its own player through its own
`DamageSystem` while the server applied the authoritative copy. Health is overwritten by the next
snapshot, so the symptom was never a lastingly wrong bar — it was a flicker, a false low-health
vignette, and a heartbeat for a wound nobody inflicted. `EquipmentDeps.authoritative` is the fix,
the same shape as `MatchFlow`'s and for the same reason.

## The divergence checker (protocol v8), and what it caught

§7 asks literally for a hash. `MsgS.StateHash` carries one, `hashModeState` is the single function
both sides run, and `DivergenceChecker` moved to `shared/debug` so the browser and the harness
cannot drift apart about what agreement means.

**Sent last in the tick, and that is the whole correctness argument.** Every other channel
describes tick N; the hash asks what tick N looked like, and a client can only answer once it has
applied all of them.

### It failed on its first real run

Domination and Kill Confirmed: **3 confirmed divergences each, identically on all three clients,
first at tick 4281.** The return migration was tick 4270 — eleven ticks, the first snapshot after
it.

**Replicated mode state was never discarded on migration.** §4.18's list is flush, discard,
resync, clear; it had been applied to the streaks and projectiles when those were built and not to
the three mode-state channels that came before them. The failure is silent in the worst way: the
arena has no zones and no tags, so it **sends neither channel at all**, and a stale Domination flag
list or KC tag list is never overwritten. It persists, entirely plausible-looking, for the session.

TDM and FFA passed throughout — they have no such state to go stale, which is exactly why this
survived every earlier run.

### Results, all five modes, one full match each

| Mode | Divergences / samples |
|---|---|
| TDM | **0 / 1155** |
| Domination | **0 / 1155** |
| Kill Confirmed | **0 / 1157** |
| FFA | **0 / 1155** |
| S&D | **0 / 2502** (full best-of-5, B 2-3, summaries to all three) |

Red control: corrupting the server's hash by one produced **239 confirmed divergences per client,
first at tick 12**, and failed the run.

**Limits, stated rather than assumed.** This compares the server's view against what a client
ended up holding, so it catches dropped channels, truncation, mis-quantisation, a frame applied to
the wrong mode, and two channels describing different ticks. It does **not** catch the server being
wrong about its own game: if `Domination.onTick` miscounts a zone, both sides agree on the wrong
number and this stays silent. That is what `DivergenceChecker`'s score-versus-events comparison is
for; the two are complementary.

## The cosmetic audit, as a check that fails

`scripts/check-cosmetics.mjs`, wired into `npm run check`. An **allowlist, not a banned-word
search** — a keyword scan only catches a cosmetic somebody was honest enough to name `decal`, and
the failure that happens is a field called `impactX` or `shakeAmount`. The snapshot's field set is
pinned; adding one fails until it is listed with the §4.15 row it belongs to.

**Result: 19 snapshot fields, all §4.15 gameplay state.** Watched red — adding
`muzzleFlashIntensity` fails by name.

Two judgement calls, both written down rather than glossed:

- **`FiredEvent.tracer`** rides an *event*, which is the channel §4.15 says cosmetics are driven
  by, and carries one bit meaning "this shot was a tracer round" — which round in the magazine
  this was, a fact the firing side knows and a receiving client cannot recover across loss without
  counting shots it never saw. §8.25's requirement is about **snapshots**, and the snapshot is
  clean. `Messages.ts` previously *claimed* there was no tracer anywhere in it, which was simply
  false; the comment is corrected.
- **The four visual serials** carry no position, lifetime, count or material. A serial means "this
  entity died for the Nth time"; an angle means "the round came from there". They ride the snapshot
  because an event can be dropped and a dropped death leaves a body standing for ever, where a
  counter that jumps by three still plays exactly one death.

## The networked S&D spectator

M7's reached into a `BotDirector`; a networked client has no roster. **The rule is a pure
function** (`shared/modes/SpectatorTarget.ts`) because that is the half that can be wrong
invisibly: never yourself, never an enemy, only the living, lowest id, sticky on the current
target. Only in a one-life mode — in TDM a corpse waits four seconds and moving the camera is
worse than the wait.

Cleared on `EV.RoundStarted`: §4.18's discard rule at a round boundary. Without it a spectator
returns from the round they died in still pointed at a body that has respawned elsewhere.

Measured over an S&D best-of-5: **292 selections while dead — 0 self, 0 enemy, 0 dead.**

Red control, and the first attempt was not good enough: merely *removing* the team rule still
reported 0 enemy picks, because the lowest-id candidate was often a teammate anyway. **Inverting**
it to enemies-only produced 280 enemy picks and failed the run.

## What Gate B still needs

In rough dependency order. The first item unblocks the most.

1. **Per-listener audio on Depot** (§8.26) — occlusion and the per-map reverb IR. Needs a
   browser; grouped with the other browser-only claims below.
2. **The verification battery**: every mode on every map to completion, a full S&D best-of-5
   with the round-3 swap, the 100-cycle leak, hardening probes against `Tags` and `Bomb`, the
   12-hour soak, and every §7-conditions claim against a **deployed** server rather than
   loopback.

## Open, and all of one kind: they need a real browser

The preview pane never fires `requestAnimationFrame`, so none of these can be measured here.
Grouped deliberately — this is now the whole of what Gate B has not verified, and it is a single
session at a keyboard rather than a list of unrelated gaps.

- **Client background build time per map** (§8.7), which is what validates the 5 ms / 20 s pair.
- **A single click landing on a vote button** (§8.18).
- **Grenade reconciliation is visually seamless** (§8.24). The easing rate is sized against the
  snapshot interval — about 78% of the gap closed per 50 ms — and own-grenade exclusion from
  render adoption is one `continue`, but "no visible teleport" is a claim about pixels.
- **The spectator camera framing** (§6.8). The *rule* is measured at 292 selections, 0 invalid;
  what it looks like through a teammate's eyes is not.
- **Per-listener audio with occlusion on Depot** (§8.26).

Unchanged from Gate A: the arena-return residual of 1-3 sub-25 cm mispredictions. Not touched by
any of this work, and still distinguished from the into-live number rather than summed with it.

---

# M11 Gate B — playtest round 2

A browser session against a deployed server produced eleven reports and one feature request.
Everything below is what they turned out to be; where a number is quoted it was measured, and
where something is reasoned rather than measured it says so.

## One entity id was behind three of them

`PlayerCombatant.entityId` was `PLAYER_ENTITY_ID` — the constant zero — hard-coded, since M2.
Over the network the local player is entity 1 or above, and that id is what
`Ballistics.nearestTarget` compares its `excludeId` against. So **the shooter's own rig was a
legal target for the shooter's own bullets**, and `raySlab` opens its interval at `tmin = 0`: a
ray that starts inside a box hits it at zero distance. Every shot fired on a networked client
terminated on the player who fired it, before it had travelled a millimetre.

Three reports, one line:

| Reported as | What it was |
|---|---|
| "the very first shot registers a hit/kill marker on nothing" | The self-hit. A head-box hit at 0 m is lethal, so it produced a *kill* marker |
| "screen stays red at 0 HP, no regen until damaged again" | Self-damage drove the local `Health` to zero. A networked client does not step its own health, and `setReplicated` only ran when the **server's** value changed — which it does not while the server thinks you are unhurt |
| "bullets pass through lobby bots and dummies" | The round never got past the shooter's own chest |

The reason it stopped after the first burst rather than continuing is the same mechanism: once
the local health reached zero, `health.alive` went false, `DamageSystem.apply` began returning 0
for a dead target, and the self-hits stopped — leaving the bar at zero.

The `PLAYER_ENTITY_ID` audit that followed found **seven more** in client code, all the same
shape and all silently wrong the moment a server assigned a seat:

- `Melee.sourceId` — the knife stabbed its own swinger.
- `ThrowController.step`'s thrower id — your own grenade crossed the wire stamped as entity 0,
  so the server's authoritative copy of it did not match and was adopted as somebody else's:
  §8.24's own-grenade exclusion could not fire.
- `MatchEquipment.onFlashed` — a flashbang addressed to you was ignored.
- `MatchEquipment.onSpawned` — the per-life grenade refill.
- `MatchMeta`'s two perk predicates — Dead Silence made nobody quiet, Battle Hardened protected
  nobody.
- `MatchMeta.isMvp`'s score lookup — always undefined, so nobody was ever MVP.
- `Game`'s chopper camera lookup — **the Chopper Gunner never took the camera over the network**.
  The gunship flew and its owner watched it from the ground.

This is the standing authority-migration failure again, and the useful generalisation is
narrower than "audit the constant": *a constant that names an entity is a constant that was
right when there was only one of them.*

## The dummies had a second, independent cause

`DUMMY_IDS` were 1..12, chosen in M2 when the id space held the player at 0 and bots from 100.
**1..99 is the connected-human range.** The warmup arena is the greybox room, so the moment it
seated a human beside the dummies the two collided in `DamageSystem`, whose table is keyed by
entity id and whose `register` evicts whatever is already at one. The third player to connect
*was* the 25 m dummy: one silently replaced the other, and shots at the survivor were then
rejected as self-hits.

Both causes had to be fixed for the range to work in the arena, and either alone is enough to
break it. Dummies now sit at 10_000+, clear of humans (1-99), bots (100+) and streak entities
(900+).

## FFA scored roughly three kills in seven

`ScoreSystem.recordKill` drops a kill whose victim shares the killer's `ScoreTeam`. Free-for-All
keeps the two-team substrate — that is deliberate and documented — so half of every FFA lobby
shares a side with any given player. `FreeForAll.onKill`'s own comment says *"every kill counts,
including one on somebody who happens to share your substrate side"*; it was the only half of
that sentence the code did not implement.

**Measured, same seed, same match**: the 30-kill limit was reached at **476.9 s** before and
**242.8 s** after. The ladder was running at roughly half speed, which is why a match nominally
decided on kills was in practice always decided by the clock.

`ScoreSystem.freeForAll` is set beside `DamageSystem.friendlyFire`, from the same registry flag,
in both runtimes. They are the same fact — *there are no teammates here* — and setting one
without the other is what produced a mode where you could shoot someone but not score them.

The HUD half was separate and worse: the FFA banner read `row.score`, and the replicated path
records kills with **zero points on purpose** (what a kill is worth is a mode decision, and the
mode is not running on a client). So the banner showed `0` against a leader of `0` for the whole
match. It reads `row.kills` now, which is also what `checkWinCondition` decides on — the bar and
the limit it counts toward are finally the same quantity.

## The bomb existed and was never visible

Two facts, and neither is a rendering bug:

1. `bombX/Y/Z` was written in exactly two places — the round reset and the carrier's death — so
   while the bomb was **held** it reported the point where it was last dropped. Stale everywhere
   it is read: the renderer hid the mesh rather than draw a lie, bots were sent to a place the
   bomb had left, and `BombInfo` replicated the same lie to every client.
2. The bomb spawns **inside the attackers' central spawn zone** (Foundry authors it at
   `z = -21.17`; the spawn there has radius 3). Bots take it by walking over it, humans must
   press Use — the post-M8 playtest's rule — so on the first tick of every round an attacking
   bot was already standing on it and took it before a human saw the round start.

Together: a carried bomb was not an object in the world at all, it was a boolean on an entity,
and the human never held it. `followCarrier` keeps the position true every tick, the renderer
draws it at hip height on its carrier, and a four-second `pickupGraceSeconds` at round start
gives the key press first refusal. S&D still completes on three seeds (65.2 s, 86.2 s, 97.8 s),
so the grace does not strand a round nobody claims.

## Empty matches held the only live slot

§4.20 refuses to *start* a match for zero humans in two places. Nothing covered the case after
`RUNNING`, so a match whose last player disconnected kept simulating ten bots to a win condition
and held the process's single live-match slot for the whole of it. Every ballot that resolved
meanwhile hit the one-match cap and sent the arena back to free play with a notice — **one
disconnect could cost the next lobby its match.**

`--abandon` is the probe: every client leaves a running match, and the harness reports how long
the server took to release the slot.

| | Slot released after |
|---|---|
| Red control (`RUNNING` case removed) | **132 978 ms** — the match ran to its win condition |
| Fixed | **30 ms** |

`LiveMatch.everSeated` latches on the first seat, which is what separates *emptied* from *not
yet filled* — the second is also true between allocation and migration, and of the instance the
leak harness builds deliberately empty.

## The summary screen was a dead end with a stuck clock

Three complaints, three causes:

- The timer sat at 14 because the number was written once from `holdSeconds` and never touched
  again. It ticks from the render pass now. Display only — the server still migrates everybody
  back on its own clock, and a client that decided for itself would leave early and stand in a
  torn-down world.
- The button read "Continue" and went to `MENU`, whose exit handler tears the world down and
  clears `this.server` — so pressing it **left the server**. It returns to the game now when
  connected: the seat, the socket and the world all survive, and the migration to the arena
  lands normally. Single-player is unchanged.
- The SUMMARY exit handler tore the world down unconditionally; it now returns early for
  `to === 'MATCH'`, which also removes a double teardown on the rotation path.

**Corrected at round 4, and the correction is about all three of them.** Every fix above is in the
tree and every one of them is right about the thing it names. None of them ever ran, because the
client stopped servicing its socket the moment this screen appeared and the server closed the
connection ten seconds into a fourteen-second hold. So: the button did go back to the game, and
the game it went back to had no connection left, which put the player on the main menu one frame
later — indistinguishable from the bug this bullet claims to have fixed. The countdown did tick,
against a migration the client could no longer receive, and was cut off before it reached zero.
The local `dt` is gone entirely now; the number is the server's own deadline. See "the summary
screen was a screen that stopped listening" below. The reading to take from it is that a fix to
the thing that was reported can be complete, correct and still never execute — and that this
section's confidence came from reading the code rather than from watching the path run.

## Create-a-Class was a state where it should have been an overlay

**Superseded at round 4. The diagnosis below stands; the fix it describes has been removed.**
Round four's report asks for the opposite design — the editor is a front-end screen and inside a
match the only way to change class is keys 1-5 — so there is no overlay any more and no route
into the editor from `MATCH` or `PAUSED` at all. The paragraph about the deferral, two below,
is the half that survived and it now protects the 1-5 path alone. See "the loadout doctrine"
under round 4 for what replaced this and why. Kept rather than deleted because the *diagnosis*
is still the record of what was wrong with the M11 §6.6 edge.

The editor is two different things sharing one screen. From the front end it is a state: no
world, nothing running, `LOADOUT` is honest. From inside a match it is an overlay — and it was
the state in both cases, so every route out went somewhere costly. Back went to `loadoutReturn`;
Escape went to `PAUSED`; and the editor's own **"Start match"** button calls `onLaunch`, which
clears `multiplayerJoin` and starts a solo game. That is the reported *"kicks the player out to
a Solo game"*, exactly.

Opened over a live world it became an overlay: the state never left `MATCH` or `PAUSED`, the
socket was untouched, the match ran underneath (there is no pausing a dedicated server), the
body stood still through `ClientMatch.uiFocus`, and "Start match" was not offered because there
is no match to start from inside one. All of that is gone at round 4, `uiFocus` included — with
the overlay removed it was a boolean with no writer.

**The class change itself had to be deferred locally as well**, and this is Tier 1 #20 arriving
from the client's side: `meta.setLoadout` re-runs the perk hooks and one of them writes
`PlayerController.speedScale`, so a class swapped on a standing body changed how fast this client
predicted itself moving while the server deferred to the next spawn. A constant per-tick
disagreement about speed, which is what rubberbanding is. It mattered little when the editor was
behind a pause screen; the quick selector puts it one keypress away. Both sides now follow the
same rule.

## Killstreak keys followed the wrong list

Keys 3/4/5 indexed the *earned* streaks, packed from zero — so which key fired a given streak
depended on how many others happened to be in hand. A player holding only their Chopper Gunner
found it on key 3, and key 5, the key the loadout editor labels "Killstreak · key 5", did
nothing. They index the class's three slots now, and the earned list only decides whether the
press is honoured. The HUD paints the same rule in three states: empty, owned-but-unearned (the
name is worth reading — it says what key 5 is *for*), and ready.

The mortar had a separate hole: its overlay's confirm called `streaks.activate` directly, which
on a networked client fires into the copy of `StreakSystem` that is deliberately never
simulated. The mark was confirmed, the streak left the pending list, and no shell ever fell. It
goes through `spendStreak` now, which is the one door that knows which kind of match this is.

## Smoke: the mechanic worked, the picture did not

Measured on the server over a 45 s match: **6 clouds at peak, 31 sight lines blocked**. §6.8's
requirement was being met all along.

What was wrong was that the player could see through a cloud the bots could not — eleven
billboards at a peak alpha of 0.42, which is worse than no smoke at all, because the two sides
of the same cloud disagreed about what it was for. Eighteen puffs, peak alpha 0.72, a third of
them clustered near the middle so the cloud has a core, and a texture that stays solid to 55% of
its radius instead of 45%.

`equipmentStats` now reports `smokeLive` and `smokeBlocked`, and the harness prints them. The
claim had been wired since the equipment commit and never measured, and a wired occluder that is
never consulted is indistinguishable from a working one.

## The quick class selector (the feature)

Five classes, five keys, no menu. A HUD panel down the left, `pointer-events: none`, bound to
the digits — offered in exactly two windows and nowhere else:

- **The pre-match freeze**, lengthened from 3 s to **10 s**. Round one only: a ten-second hold
  between every S&D round would add a minute to a best-of-five for a decision nobody is making
  at that point. `MatchFlow.warmupSeconds` is one accessor read by the countdown, the phase
  machine and the replicated path, so the three cannot disagree about which limit applies.
- **The respawn wait**, where the next body is seconds away.

Deliberately not offered while alive and playing: there the answer is Create-a-Class and the
change lands on the next death, which is CoD's rule.

**Corrected at round 4.** Create-a-Class is no longer reachable from inside a match, so these
two windows are not one route among several — they are the *only* way to change class in a
match. The sentence above described a fallback that no longer exists; the rule it states is
unchanged, and the panel it describes now carries more weight than it did. See "the loadout
doctrine" below.

The digit listener is registered *after* the vote overlay's, so a ballot keeps first refusal,
and it consumes the key — picking class 2 does not also pull out the pistol, and picking class 5
does not call in a Chopper Gunner.

**The server applies a pre-match pick immediately** rather than on the next spawn
(`ServerMatch.applyPendingLoadoutNow`), because otherwise "the class you press during the
countdown" would arrive after the player's first death. The freeze is the one window where that
is free: the movement axes are stripped before they reach the controller, so a `speedScale` that
changes there cannot produce a misprediction, and the spawn-serial bump is the same
discontinuity a death already produces — which is exactly how the client is told to adopt the
new pose without charging itself for the difference.

## What is measured, and what is not

Measured headlessly, this session:

| Probe | Result |
|---|---|
| FFA kill limit, same seed | 476.9 s → **242.8 s** |
| Empty-match teardown | **132 978 ms → 30 ms**, red control watched first |
| Smoke on the server | **6 clouds peak / 31 LOS rejections** |
| S&D completion, 3 seeds, with the pickup grace | 65.2 s / 86.2 s / 97.8 s, all complete |
| `npm run check` | boundaries, cosmetic audit and all three typecheck targets pass |

Repeated twice more on the same tree, because this harness is wall-clock paced and one run of it
is a sample rather than a fact:

| Run | Quick loadout | Alive (must be 0) | Tab while dead | Into live |
|---|---|---|---|---|
| 1 | 10 851 tk / 34 win | **0** | 3 639 / 7 278 | 1 |
| 2 | 10 634 tk / 32 win | **0** | 3 432 / 7 057 | 0 |
| 3 | 10 848 tk / 33 win | **0** | 3 697 / 7 274 | 0 |

**Not measured here, and it needs a browser.** Every client-side fix above is reasoned from the
code and compiles, but the preview pane never fires `requestAnimationFrame`, so none of it has
been *seen*: the self-hit's absence, the bomb on its carrier, the summary countdown, the loadout
overlay staying connected, the streak keys, the grenade refill, the smoke's new density and the
quick selector itself. That is one session at a keyboard, and it is the same list §8's
browser-only claims were already waiting on.

The `HeadlessClient` cannot stand in for it: it drives `NetClient` and `Prediction` directly and
builds no `ClientMatch`, which is precisely why a bug that made every networked client shoot
itself survived every harness run in the milestone.

## Playtest round 3 — the ballot that followed you into the match

Three reports, and two of them were the same bug wearing different hats.

**The vote overlay is the arena's, and nothing told it when you left.** `Server.broadcastVoteState`
sends to `warmup.sessions` only — correct, the cycle belongs to the arena — so a migrated player
simply stops being told anything. `VoteOverlay.apply` is the only writer of `root.hidden` and of
`info`, so whatever phase that client last heard is what it keeps, on screen, for the whole match.

It is a **race**, which is why it was "sometimes": the ballot resolves, the server broadcasts
`ALLOCATING` at 4 Hz, and the migration happens once every client reports its background build
ready. A client that had already built that map reports in milliseconds and can be migrated
before the broadcast that would have taken the overlay down.

The second hat is the one that reads as a different bug entirely. `handleDigit` consumes 1-5
whenever `info.phase` is a ballot — so a stale `MAP_VOTE` ate keys 1-3 and a stale `MODE_VOTE`
ate all five, *before* they reached the quick class selector. Reported as **"sometimes I can't
switch class"**, and the two symptoms never looked related because one is a panel and the other
is a keypress.

Two changes, and the second is the one that generalises:

- `Game.skirmishSink().onMigrated` calls `voteOverlay.hide()`, beside the streak and projectile
  discards that were already there. Same §4.18 rule, applied to the channel that had been missed:
  state from an instance you have left.
- **A hidden surface never consumes a key.** `handleDigit` returns false on `root.hidden` before
  it looks at anything else. `root.hidden` was explicitly rejected as the test when this was
  written — correctly, because the overlay is also visible during `PLAY` and 1-5 must behave
  normally then — but the converse is absolute and was missing.

Verified in a browser against a real server: with the ballot genuinely open, `handleDigit(1)`
still returns true and the vote is cast (the harness reports 2 votes per client, unchanged);
after `hide()`, digits 1 and 3 both fall through.

### The class panel's own window, measured

The round-2 fix — track the respawn countdown rather than `isPlayerDead` — was already correct.
Traced end to end over a real connection, one line per transition:

| t | where | phase | dead | window |
|---|---|---|---|---|
| 25 | arena | LIVE | no | closed |
| 39 | arena | LIVE | yes, 4.4 s left | **open** |
| 44 | arena | LIVE | no | closed |
| 47 | dunes | WARMUP | no | **open** |
| 57 | dunes | LIVE | no | closed |

Which is the requested behaviour exactly: the ten-second pre-match window and the 4.5 s respawn
window, and nothing in between.

**Corrected at round 4.** The last column originally read "panel", and it did not describe a
panel — it described the *window*, which is what `updateQuickLoadout` computes. The two were the
same thing everywhere except on screen: `.ql` sets `display: flex` and had no `[hidden]`
companion rule, so the attribute this table was reading went on and off all match without hiding
anything. Every row above is still true of the derivation and none of them was ever true of the
pixels. See "Three surfaces, and the panel that was never hidden" below; the reading to take from
it is that a trace of a predicate is not a trace of a picture, and the column heading should say
which one it is.

## Playtest round 4 — three surfaces, and the panel that was never hidden

B1, B6 and B13. The brief's hypothesis was that all three are one shape — *a visible surface
whose visibility is written in two different places, or is not written at all at the moment it
needed to change* — and two of the three are exactly that. The third turned out to be a shape
one layer further down, and it is the interesting one, because every measurement anybody has
ever taken of it was green.

### The invariant, first, because it is what the three fixes have in common

**Every HUD surface has exactly one writer, and its visibility is a pure function of state that
outlives the surface, evaluated once per frame from one place.**

`shared/ui/HudSurfaces.ts` holds the rules — `scoreboardOpen`, `quickLoadoutWindow`,
`debugOverlayVisible` and the death-screen countdown they read — and `Game.updateHudSurfaces` is
the one place that evaluates them, beside the vote overlay's tick in the render pass. They are in
`shared/` for the reason `pickSpectatorTarget` is: this process can run them, and a claim about a
panel is otherwise a browser claim for ever.

Round three established half a rule — *a hidden surface never consumes a key*. This is the other
half, and the sharper statement of it is that **a tick is not a frame**. Anything written from
`simulate` stops being written the moment the screen leaves `MATCH`, and a surface drawn every
frame from a value updated only on ticks is a latch waiting for somebody to pause.

### B13 — the derivation was right, the panel was never hidden

*"The class-select square does not disappear after respawn."*

Round two fixed this by tracking the respawn countdown rather than `isPlayerDead`. Round three
traced it over a real connection and published the transitions. This session ran the extracted
predicate against three headless clients over a full cycle: **0 violations across 34 windows and
10 851 ticks**, where a violation is the window open while the client is alive and outside the
pre-match freeze. Every one of those greens is honest. None of them was about the screen.

`.ql` sets `display: flex` and had **no `.ql[hidden]` companion rule.** The `hidden` attribute
hides an element only because the UA stylesheet says `[hidden] { display: none }`, at the lowest
specificity there is, and any author-level `display` outranks it. So `QuickLoadout.hide()` set the
attribute, `shown` went false, `handleDigit` correctly stopped consuming digits — and the panel
stayed painted from the first `show()` of the session to the end of it. What the player reported
is not really that it failed to disappear after a respawn; it is that a respawn is the first time
most players see it appear at all.

The trap is documented twice in this codebase already — `.op-screen[hidden]` in `app.css`, and
`.hud-mortar[hidden]` ninety lines above `.ql` in the same file, whose comment says *"Required,
not defensive"* and names the exact failure. The quick selector's block was written afterwards
without it. `.ql__row` had the same hole, which would have painted the rows of class slots nobody
has authored.

Every surface that hides through the attribute was audited in the same pass. Two gaps, both in
that block; `.hud`, `.dbg-root`, `.op-screen`, `.op-vote`, `.op-loading`, `.eom`, `.eom__xp`,
`.hud-mortar`, `.dbg-botlabels` and `.sb__row` all carry theirs, and the scoreboard hides through
an explicit `.sb--on` class rather than the attribute at all.

**The lesson is about the measurement, not the CSS.** Round three's table has a column headed
"panel" that was really the window, and no probe in this project can tell those apart, because
none of them renders. That is what the "needs a browser" list is for, and it is why round three's
section has been amended rather than left standing.

### B1 — two copies of "is the debug overlay open", and the × wrote one of them

*"The × closes it, but coming back to the game reopens it."*

`Game.overlayWasOpenBeforePause` was a second copy of `DebugOverlay.visible`, kept so that
resuming from a pause could put the panel back where it was. The × called `setVisible(false)` on
the overlay itself and never touched the copy, so opening the overlay from the pause menu, closing
it with the ×, and resuming ran `restoreOverlayAfterPause()` against a `true` the player had
already cancelled. The panel came back on the way into the game, exactly as reported.

The fix is one value instead of two booleans, and it is a **tri-state** rather than a flag because
the two booleans were carrying more than one bit between them:

| `debugRequest` | Written by | Visible in `MATCH` | Visible in `PAUSED` |
|---|---|---|---|
| `'none'` | the ×, Escape, the pause button when it is up | no | no |
| `'inMatch'` | the demotion on resume | yes | **no** — M5's rule about two modal panels |
| `'onPause'` | the pause menu's button | yes | yes — the tuning sliders need a cursor |

Every documented behaviour survives, including the two that pull in opposite directions: the
overlay goes off screen for the duration of a pause it did not ask for, and it stays up over one
it did. `hideOverlayForPause` and `restoreOverlayAfterPause` are gone, and nothing is written on
entering `PAUSED` at all, because the predicate already answers differently there. The request
lives on `Game` rather than on the overlay because it has to **outlive the surface** — the panel
belongs to the world and a rotation throws the world away — so `buildWorld` re-binds `onDismiss`
and seeds the new overlay from the predicate, and a request survives a map change.

`DebugOverlay.setVisible` is idempotent now, which is what makes calling it every frame
affordable: showing refreshes every tuning panel, and doing that sixty times a second would put
the overlay squarely inside the frame times it exists to report.

### B6 — a rule moved to the netcode and left its exception behind

*"Tab sticks in multiplayer while you are dead."*

`Input.sampleSpectating` keeps `Btn.Scoreboard` through a death **on purpose**, and has since M4:
*"the death screen is exactly when you want to look at the board."* `NetClient.neutralise` is the
netcode's restatement of that same rule, written so both halves of a networked match read it from
one place — and it zeroed the whole bitfield. The standing authority-migration failure in
miniature: the rule crossed to the wire and the exception did not. Over the network the one fact
the scoreboard is derived from was forced to nothing the moment the server said you were dead.

Measured through the browser's own seam — `applyNonReplayed`, where `MatchWorld` hands the
neutralised command to `ClientMatch`, and therefore the only place the loss is visible. Red first:
the "before" column is a run of this tree with the one line reverted and everything else, the
probe included, left alone.

| Probe | Red (the bug restored) | Green |
|---|---|---|
| Tab held on commands reaching the sim | 28 415 ticks | 33 231 ticks |
| ...of them **while dead** | **0** of 5 296 dead ticks | **3 639** of 7 278 dead ticks |
| Scoreboard open while dead | **0** ticks | **3 639** ticks |
| The run | **FLOW CHECK FAILED** | passed |

Half, because the harness holds Tab on a 50% duty cycle — two seconds down, two up, so the probe
sees both edges either side of a 4.5 s death rather than sampling one level. The hold sits
**outside** the `alive` gate in `HeadlessClient.sample`, deliberately: a client that only pressed
Tab while alive could never have found a bug whose whole content is that the bit is discarded
while dead.

Keeping it costs no divergence and cannot. Nothing in `PlayerController.step` or `Weapons.step`
reads bit 6; `NetPlayer.step` does not consume a dead player's command at all; and the frozen
path's `lastButtons` is only ever asked whether the trigger was down.

**The second half of B6 is the latch, and it is why the write moved.** The scoreboard's only
writer was the last line of `ClientMatch.simulate`, and `simulate` is reached from `net.update()`,
which `Game.simulate` calls only while the screen is `MATCH`. Pausing stops the tick;
`Input.clearHeld` then drops the Tab bit into a loop that is no longer running; the board stays up
over the pause screen holding a key nobody is pressing. It is derived once per frame now, from
`scoreboardHeld` — itself derived from the `prevButtons` the match already keeps for edge
detection, not a new copy of it — and from the screen, which outlives the tick.

### The HUD surface table

The artefact, and the thing that is meant to stop this class of bug coming back. Read the last
column with B13 in mind: it is where the failure was.

| Surface | Single writer | Derived from | Consumes from input | Hides by |
|---|---|---|---|---|
| Scoreboard | `Game.updateHudSurfaces` → `Match.setScoreboardOpen` | `scoreboardOpen` — screen, editor, held Tab | `Btn.Scoreboard`, a level read from the command (S4.2). Consumes nothing | `.sb--on` class |
| Quick loadout | `Game.updateHudSurfaces` → `show`/`hide` | `quickLoadoutWindow` — respawn countdown, or round-one `WARMUP` | digits 1-5; **consumed** while shown, refused while hidden | `[hidden]` + `.ql[hidden]` |
| Debug overlay | `Game.updateHudSurfaces` → `setVisible` | `debugOverlayVisible` — `debugRequest` and the screen | Escape closes it and stops there. The × asks through `onDismiss` | `[hidden]` + `.dbg-root[hidden]` |
| Vote overlay | `VoteOverlay.apply`; `hide()` on migration (round 3) | the server's broadcast vote phase | digits 1-5, first refusal, only while not hidden | `[hidden]` + `.op-vote[hidden]` |
| Pause | the `PAUSED` state's enter/exit | `Game.state` | Escape; its buttons take DOM focus, which is why `hide()` blurs | `[hidden]` + `.op-screen[hidden]` |
| Summary | the `SUMMARY` state's enter/exit | `Game.state` | its own buttons | `[hidden]` + `.eom[hidden]` |
| Mortar overlay | `MortarOverlay.open`/`cancel`/`confirm` | whether a mortar mark is being placed | Fire confirms, Escape cancels above the pause branches | `[hidden]` + `.hud-mortar[hidden]` |

One honest footnote on the first row: `MatchHud.setVisible(false)` and `resetForMatch()` also
force the board shut. They are teardown rather than a second opinion — both only ever write
`false`, and only in states where the predicate already answers `false` — but they are the shape
that becomes a second writer the day somebody makes one of them write `true`.

Three of the seven moved into the one per-frame pass this session. The other four are each already
a single writer driven by an event that cannot stop arriving, and moving them would be churn; what
the table buys is that the next surface has somewhere to be added and a last column somebody has
to fill in.

### Measured, and what a probe now blocks on

`npm run skirmish`, three headless clients, full timings, one complete cycle through a vote, a
migration and a TDM to the clock.

| Probe | Result |
|---|---|
| Quick loadout window | 10 851 ticks over **34 windows** (7 269 respawn / 3 582 pre-match) |
| ...open while alive and out of the freeze | **0** — the B13 assertion, and it blocks |
| Tab surviving `neutralise` while dead | **3 639** of 7 278 dead ticks — the B6 assertion, and it blocks |
| Spectator invariants (unchanged) | 7 806 selections while dead, 0 self / 0 enemy / 0 dead |
| Divergence checker (unchanged) | 0 / 7 372 per client |
| `npm run check` | boundaries, cosmetic audit and all three typecheck targets pass |

Both new assertions are written to go **red against the bug rather than green against the
feature**, and the B6 one was watched red: reverting the single line in `neutralise` and changing
nothing else drops it to 0 of 5 296 dead ticks and fails the run. Both carry their denominators,
so a zero that means *"never looked"* fails as loudly as a zero that means *"never violated"* —
the same property the divergence checker's `hashSamples === 0` branch exists for.

The B13 assertion has **not** been watched red, and that is the honest statement of its limits
rather than an omission: the bug was in a stylesheet, and no red control available to this process
can make a predicate fail that was never failing. Its value is prospective — it is the thing that
will notice the day somebody makes the window itself wrong.

**One number moved, and was isolated before it was believed.** The first run with the probe in
reported 1 misprediction entering a live match, against a documented 0, which fails §8.9. Isolated
one variable at a time rather than rebaselined: clean tree **0**; this tree with Tab held **1**;
this tree with the hold removed **0**; then the same tree with the hold back in, twice, **0** and
**0**. So it is neither the fixes nor the probe's input — it is noise, which is also what the code
says it must be, because `Btn.Scoreboard` reaches no branch in `PlayerController.step`. This
harness is wall-clock paced rather than seeded and no two runs agree about anything else either:
deaths and spectator picks move ten per cent between runs of the same tree. The earlier
*"mispredictions into live: 0, every run"* should be read as 0 on four runs in five, not as a
constant.

### Needs a browser

Nothing above was seen. `HeadlessClient` drives `NetClient` and `Prediction` and builds no
`ClientMatch`, and the preview pane never fires `requestAnimationFrame`, so every claim here is
about a rule and none is about a pixel — which is precisely the gap B13 lived in for two rounds.

- **B13.** Start a match, die, wait out the respawn. The class panel must **go away** when the body
  comes back, and again when the pre-match ten seconds expire. Then press 3, 4 and 5 while alive: a
  killstreak must fire, which is the panel proving it is not merely invisible.
- **B1.** Pause, open the debug overlay from the pause menu, click the ×, resume — it must stay
  closed. Then: pause, open it, resume with it up (it should follow you in), pause again (it should
  go off screen), resume (it should come back). Then press Escape with it open in a match: it
  closes, and you are **not** dropped onto the pause screen.
- **B6.** In multiplayer, hold Tab across the moment of death: the board must stay up through the
  death screen and close on release. Press Tab while dead: it must open. Then pause while holding
  Tab and let go — the board must not be up behind the pause menu.
- **The `.ql[hidden]` fix, and one pass over the surfaces that share the trap's shape.** Cycle the
  class panel and the mortar map both up and down, because the audit was a grep and a grep cannot
  see specificity.

Unchanged from the earlier list: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything in "Open, and all of one kind" above.

### Found while here

- `PLAYER_RESPAWN_SECONDS` in `ClientMatch` was a literal `4.5` beside `BotDirector`'s
  `RESPAWN_SECONDS`, also `4.5` — the same fact written twice, and the death-screen countdown is
  what the class panel's window is derived from, so the day the two drifted the panel would have
  closed early or late with nothing to point at. It reads the shared one now, which is also what
  lets the harness step the same display timer the client does.
- `Game.updateHudSurfaces` briefly declared a local named `window`. `scripts/check-boundaries.mjs`
  catches that in `server/` and cannot catch it in `client/`, where this very file legitimately
  names the global in `onResize`. Renamed. Not a defect; recorded because the check found it in one
  partition and could not have found it in the other.

## Playtest round 4 — the summary screen was a screen that stopped listening

B4, and it is one mechanism wearing three hats. The brief's first instruction was not to fix but
to explain why round two's fix does not arrive, and the answer is that all of round two's fix is
present, correct, and unreachable: by the time the player presses the button they have already
been disconnected.

### The mechanism, in one line

`Game.simulate` serviced the socket only while the screen was `MATCH` — `if (inMatch)
net.update()` — so from the frame the post-match board went up the client stopped pinging,
stopped reading, and stopped noticing anything. `SUMMARY_HOLD_SECONDS` is **14** and
`CLIENT_TIMEOUT_MS` is **10 000**, so the server reaped every player who watched the board **four
seconds before it would have migrated them home**, with the return `Welcome` sitting unread in a
queue nobody was draining.

That one gate produces every symptom in the report:

| Reported | What it was |
|---|---|
| "the button throws you to the main menu instead of the lobby" | `leaveSummary` does transition to `MATCH` — round two's fix, intact. `MATCH` is the first screen that pumps the socket again, so the very next tick runs `net.update()`, which is the **only** place `NetClient.state` becomes `'disconnected'`, and the disconnect branch sends the player to `MENU`. The fix and the bug are one frame apart |
| "you have to click twice" | Not a focus guard and not pointer lock. `GameScreens`' `onContinue` swallowed the first press to finish the XP animation and left only on the second — a deliberate M6 decision, and one a button labelled "Return to lobby" cannot honestly keep |
| "the timer is stuck at 14" | The render pass does reach `EndOfMatch.tick`; what was wrong is upstream of the arithmetic. The number was seeded once, from a **duration** sent at match end, and integrated locally against a clock the client had stopped reading — so it counted toward a migration it could not receive, and never once reached zero in a real session, because the screen it was on was torn down at ten seconds |

The shape is the milestone's own recurring one, arriving from a new direction. Two decisions had
been fused into one `if`: *what the player's command contains* — nothing, off the match screen —
and *whether this client is still talking to the server at all*. **Going silent is not a neutral
command.** The neutral command is now `MatchWorld.sampleCommand`'s first branch, where it says
what it means, and `net.update()` runs on every screen that still holds a world.

The comment above that line had claimed for a milestone that `sampleForNet` *"applies the same
three-way choice made below"*. It applied two of the three. The missing branch was being
implemented by not calling the netcode at all.

### Why no harness run could ever have seen it, and the probe that now can

`HeadlessClient` has no screen, so it pumps unconditionally — the one difference from the browser
that mattered. `--summary-gate` gives it the browser's gate: silent from `MsgS.Summary` until the
deadline that message carries. It is a red control and nothing else, and it was watched red
first.

The gate's deadline is wall-clock rather than ticks, deliberately: a gated client is not calling
`NetClient.update`, so `stats.clientTick` is frozen for exactly as long as the gate lasts, and a
gate waiting for a tick it was itself preventing would never lift. That is the same frozen-clock
trap `LiveMatch.summaryElapsed` documents on the server side, met a second time from the client's.

| Probe | Red (`--summary-gate`) | Green |
|---|---|---|
| Server closed the session | **all 3, `timeout`, 10.02 s after the summary** | none |
| Clients migrated back to the arena | **0 of 3** | **3 of 3** |
| Migrations over the run | 3 (into the match only) | **6** — the return leg finally happens |
| What the screen said the hold was | 13.9 s | **14.0 s** |
| Actual summary to arena | never arrived | **13 997 ms** |
| The run | **FLOW CHECK FAILED**, three ways | passed |

Both numbers are printed side by side on purpose. They are two independent answers to one
question — what the screen claims and what the server does — and the whole of B4's timer is that
the first was a guess.

### The countdown is the server's remainder now (protocol v9)

`MsgS.Summary` carries `endsTick`, the master tick the hold expires on, instead of `holdSeconds`.
A **deadline, not a duration**, and the same shape as `VoteInfo.phaseEndsTick`: the client derives
`(endsTick - currentTick) * DT` against the synced server clock, which is the expression
`VoteOverlay.tick` has used for the ballot since M11. The two countdowns on this client can no
longer mean different things.

A duration is only true at the instant it is sent. It could not be right for a player who reached
the screen a frame after the message that opened it, or reconnected into it, and it kept counting
perfectly happily on a link that had gone away. The new number cannot: it is a pure function of a
tick the server sent and a tick the clock sync maintains, so **a client that stops hearing the
server stops counting** — which is the honest failure, and the one a local `dt` could not produce.

`LiveMatch.summaryEndsTick` is the same expression `summaryElapsed` decides on rather than a
second copy of it, so the screen and the migration cannot disagree about when the hold ends.
Measured agreement: **14.0 s displayed against 13 997 ms actual.**

`EndOfMatch.setNetworked` is derived from the connection now rather than from `holdSeconds > 0`.
Those are different facts, and taking the second for the first made this screen describe itself
as single-player whenever the number was missing — the brief's third candidate. It cost only the
wording before, because `leaveSummary` reads `this.server` and always did; it would have cost the
exit button too, now that the same flag decides whether there is one.

### Two buttons, and the one that could not honestly be a rematch

The report asked for an exit and a rematch. Against a dedicated server there is no client-side
rematch to give: the server migrates everybody back to the arena on its own clock and **the vote
cycle running there is the rematch**. So the honest pair is:

- **Return to lobby — Ns** (primary): the seat, the socket and the world all survive. This is
  what round two built; what it needed was a connection still alive when it ran.
- **Exit to main menu** (secondary): transitions to `MENU`, which tears the world down, clears
  `this.server` and closes the socket — freeing the seat immediately rather than after a
  ten-second timeout.

**Single-player gets one button, not two.** There the two collapse into the same action, and two
buttons that do the same thing are worse than one: the exit is hidden and the primary reads
"Continue", exactly as before.

The first press acts. XP is banked when `SUMMARY` is *entered*, not when the bar finishes, so
skipping the animation costs nothing but the animation — pressing either button finishes it and
goes. Single-player loses the press-once-to-skip behaviour too, deliberately: it is the same lie
with only one button to tell it.

### Measured

Shortened round (`MATCH_ROUND_SECONDS=25`, `PLAY_SECONDS=8`, votes 4 s), because at shipped
timings no match ends inside the harness budget — see below. **The two constants under test are
untouched by those knobs**: the hold is the shipped 14 s and the timeout the shipped 10 s, and the
gap between them is the entire finding. Shortening a round moves when the summary happens, not
what happens during it.

Three green runs, because this harness is wall-clock paced and one run of it is a sample rather
than a fact:

| Run | Screen said | Actual summary to arena | Migrated back | Dropped |
|---|---|---|---|---|
| 1 | 14.0 s | **13 997 / 13 997 / 13 997 ms** | 3 of 3 | 0 |
| 2 | 13.9 s | **14 015 / 14 014 / 14 014 ms** | 3 of 3 | 0 |
| 3 | 14.0 s | **14 021 / 14 020 / 14 020 ms** | 3 of 3 | 0 |
| Red control | 13.9 s | —, never arrived | **0 of 3** | **3 of 3, at 10.02 s** |

The screen's number and the hold it describes agree to within about 25 ms across all three, which
is the point of printing them side by side: they are computed from different things and now say
the same thing.

And the rest of the gate, unchanged by any of this:

| Probe | Result |
|---|---|
| Standing `npm run skirmish`, shipped timings | FLOW CHECK PASSED — divergence **0 / 7373** per client, spectator **0 self / 0 enemy / 0 dead** over 8007 picks, quick loadout **0** while alive over 11 041 ticks, Tab **3595** of 7465 dead ticks |
| Mispredictions entering a live match | **0**, every run |
| `npm run leak`, 100 cycles | subscriptions **26 → 26 (+0)**, heap 12.64 → 13.28 MiB (+0.64). LEAK CHECK PASSED |
| `npm run netharness` at v9 | 2 clients, 30 s, **1800 ticks each, 0 snapshots lost, both still `joined`** — the handshake accepts the bumped version on both sides, which is the half of a protocol bump that can silently reject everybody |
| `npm run check` | boundaries, cosmetic audit and all three typecheck targets pass |

### Needs a browser

Nothing here was seen, and the split is sharper in this session than usual: the harness proves the
*connection* survives the summary screen, and every claim about the screen itself is a browser
claim. `HeadlessClient` builds no `ClientMatch` and no `Game`, so it has no summary screen at all —
what it has is the socket behaviour the screen was breaking.

- **The two buttons.** Finish a networked match. The board must offer **two**. Press "Return to
  lobby" **once**: it must act on that press — you land back in the world, and the NetPanel must
  show the *same* socket with no reconnect. Wait the hold out instead and the server must migrate
  you to the arena on its own, with the board coming down as it lands.
- **The countdown.** It must run 14 to 0 and reach zero *before* anything happens, rather than
  being cut off part-way. Kill the network at 7 s: the number must **stop** rather than keep
  counting, which is the visible form of the new derivation.
- **The exit.** "Exit to main menu" must close the socket — the server log should free the seat
  immediately rather than ten seconds later.
- **Single-player.** Finish an offline match: **one** button, reading "Continue", no number, and
  one press leaves.
- **The pause screen.** Pause a networked match for more than fifteen seconds and resume. You must
  still be connected; before this session you were not.

### Found while here

- **`npm run skirmish` has never reached the last leg of the flow it is named for.** The budget
  allows `matchRoundSeconds || 90` seconds for the match, and TDM's authored `timeLimitSeconds` is
  **600**. At shipped timings the run is therefore cut off mid-match: `summaries received: 0`, no
  hold, no return migration — and FLOW CHECK PASSED. That is why nothing in this milestone caught
  B4, and it is a probe that could not go red for the whole of §6.9. The budget is not changed
  here, because a correct one makes every default run several times longer; what changed is that
  the silence is no longer silent. A run in which no match ended now says **"post-match hold: NOT
  EXERCISED"**, the same shape as the divergence checker's `hashSamples === 0` branch.
- **The pause screen had the same hole**, with no fixed clock to make it fire reliably:
  `simulate` returned on `PAUSED` before it reached the network at all, so a networked client
  paused for ten seconds was reaped exactly like one watching a summary. Same cause, so fixed
  here: the `PAUSED` early return now sits *below* the networked branch, where it belongs — a
  pause is a local decision about a local simulation, and there is no pausing a dedicated server.
- A **backgrounded** tab survived the summary screen that a visible one did not.
  `pumpNetworkWhileHidden` has always called `net.update()` unconditionally, which is both the
  shape this fix follows and a small proof that it is safe.

## Playtest round 4 — the loadout doctrine, and a picker that never showed the weapon

B5, B8, B11, B7 and F15. Two of them are one design decision and it **reverses round two**, one
is a screen that rebuilt itself on every click, one is a gate whose number never reached the
screen, and one is a picker of twelve names for objects nobody could see.

### The decision, first, because two of the reports are it

**The editor is a front-end screen. Inside a match the only way to change class is keys 1-5.**

That is not a bug fix. M11 §6.6 put `MATCH -> LOADOUT` in the transition table for the warmup
arena; round two found that every route out of the editor went somewhere costly and fixed it by
making the editor an *overlay* over the live world, so there was no transition left to route
wrongly. The report now asks for the opposite, so the overlay is **removed** rather than
repaired, and the record above has been rewritten rather than left standing: "Create-a-Class was
a state where it should have been an overlay" now says what it was and what happened to it.

Three things went with it — the pause menu's button, `Game.openLoadout`/`closeLoadout`, and the
`MATCH`, `PAUSED` and `SUMMARY` edges into `LOADOUT` — and the third is the one that matters,
because it turns the doctrine from a habit into a rule. `LEGAL_TRANSITIONS` now reads
`LOADOUT: ['MENU']` and no other row names it as a target, so a route added by accident throws
`Illegal game transition` on the frame it is taken. That is stronger than the grep the brief
asked for, and the grep agrees with it: one `transitionTo('LOADOUT')` in the tree, wired to the
main menu's button, and one caller of `loadoutEditor.show()`.

**What survived is the half that protects the path that is left.** The deferral of
`meta.setLoadout` (Tier 1 #20) was built for the overlay and matters more without it: a class
applied to a standing body re-runs the perk hooks, one of which writes
`PlayerController.speedScale`, so the client predicts a speed the server — which defers to the
next spawn — is not simulating. `pickQuickClass` is now the **only** caller of that pair, so
`ClientMatch.applyLoadout` and `ServerMatch.setPendingLoadout` are load-bearing for 1-5 alone.

Two things did not survive, and both are the same shape as the `editorOpen` field: code whose
only reason to exist was the route that has gone.

- `ClientMatch.uiFocus` — *"a front-end surface has the keyboard and the cursor"* — had **no
  writer left**. A boolean in the input path that nothing sets is indistinguishable from one
  somebody forgot to set. `inputSuppressed` is `inputFrozen` now.
- `HudSurfaceState.editorOpen` was tested by both `scoreboardOpen` and `quickLoadoutWindow`, and
  both already required `screen === 'MATCH'`, where it can no longer be true. Round four's own
  surface table exists to say what each surface is derived from; a condition that cannot fire is
  a row that has stopped describing the code.

**The cost, stated rather than glossed:** a player connected to a server cannot now *build* a
class without leaving it. They can pick among the five they have, on 1-5, in the two windows the
quick selector offers — and to edit the sixth perk they quit to the menu. That is what the
report asks for and it is the right trade for a game with no lobby screen, but it is a real
loss compared to the overlay and it is the thing to watch for in the next round.

### B5 — one button, and the save is on the way out

*"Replace the exit-to-match button with save-and-exit, going to the main menu."* The button the
report names is the editor's own **"Start match"**, which called `onLaunch` — the same call the
main menu's Start uses, which clears `multiplayerJoin` and launches a solo game. With the editor
reachable only from the menu there is exactly one destination, so there is exactly one button:
**Save and exit**. Two buttons that both land on MENU would be the pair P2 refused to ship.

The flush is in the `LOADOUT` state's **exit handler**, not on the button. Every route out passes
through it — the button, Escape, and anything added later — which is what makes "no route leaves
without saving" a property of the state rather than of one listener. `Profile.editLoadout`
already persisted each edit, but through `SaveStore.touch`, which debounces; leaving the screen
is exactly the moment a debounce stops being a kindness.

### B11 — the list that jumped, and why saving `scrollTop` would have been the wrong fix

*"Selecting a weapon scrolls the list back to the top."*

`edit()` called `paint()` called `screen.replaceChildren(...)`. The `.lo-options` element the
player had scrolled — `max-height: 320px; overflow-y: auto` — was **thrown away on every click**,
and its replacement was a fresh node, and a fresh node's `scrollTop` is 0. The brief was right
that saving and restoring the offset is the plaster: it removes the symptom and leaves the whole
screen rebuilt twelve times a minute.

So `paint()` runs once per `show()` and nothing else calls it. Every mutable piece of the screen
registers a closure in `refreshers` and `refresh()` runs them; every argument of an option past
its label is a **predicate rather than a value**, so the element is built once and decides what
it says each time it is asked. Changing slot, equipping a class and renaming one are all
refreshes now, not repaints. Opening a row appends its options and closing one removes them,
truncating `refreshers` back to the length it had before — a closure still holding a detached
node is work done on nothing, and the quiet kind of accumulation that becomes a leak.

The reason the in-place refresh is *complete* rather than approximate is worth writing down,
because it is what makes the rebuild unnecessary: **an edit inside the open row can never change
which options that row offers.** Overkill changes the secondary weapon list and lives in a perk
row; a primary change re-lists the attachments row; only one row is open at a time. Each of
those closed rows is rebuilt when it is next opened. Preserved scroll is then the test rather
than the mechanism — nothing is preserved, because nothing was destroyed.

### B7 — the brief's hypothesis was wrong, and the real one is worse

*"The gas grenade shows no unlock level in the picker."*

The suggested mechanism was a missing table row. It is not: there is no gas grenade — the
tacticals are FLASHBANG and SMOKE, `רימון גז` is the smoke, and `EQUIPMENT_UNLOCK_LEVEL.smoke`
has said **3** since M6. The gate was reading it correctly the whole time.

**The editor passed the string literal `'LOCKED'`.** Weapons asked `unlocks.weaponRequirement`,
attachments asked `unlocks.attachmentRequirement`, perks and field upgrades read `unlockLevel`
off their own def, and equipment — the one category whose level lives in a side table rather
than on the def — had nothing to ask, because `UnlockState` had no `equipmentRequirement`. Three
ways of answering one question, one of which answered nothing. SEMTEX (8) and CLAYMORE (16) had
the identical hole; smoke is simply the first one a low-level player meets.

All six requirements come from `UnlockState` now, beside the predicates they are the explanation
for, so a gate and its caption cannot say different things. Two smaller things fell out:

- `EQUIPMENT_UNLOCK_LEVEL[id] ?? 1` was what both readers said. `noUncheckedIndexedAccess`
  forces *something* there, and `?? 1` on a table of gates means a missing row silently unlocks
  the item at level one — the quietest possible failure for a progression system.
  `equipmentUnlockLevel` throws instead, in the same shape as `requireWeapon`.
- Camos are gated by a challenge rather than by a level, and their chip said `LOCKED` too. It
  quotes `CamoDef.requirement` now, which is the same sentence `Challenges.ts` awards against.

**And the class of bug is a check that fails.** `scripts/check-unlocks.mjs`, wired into
`npm run check`, tests both halves of a gate, because either alone is silent: every gated item
has an unlock record, **and** every gated category has a requirement accessor that the editor
actually calls. The second half is the one that was broken and no amount of table-checking would
have found it. A literal requirement string in the picker fails it by name.

Watched red three ways, because a check nobody has seen fail is a check that has not been
written yet:

| Red control | What it said |
|---|---|
| `smoke: 3` deleted from the table | `equipment "smoke" has no row in EQUIPMENT_UNLOCK_LEVEL` |
| the picker's `'LOCKED'` literal restored — **the bug as it shipped** | *does not call unlocks.equipmentRequirement*, and *passes the literal requirement "LOCKED"* |
| `equipmentRequirement` removed from `UnlockState` | `UnlockState has no equipmentRequirement` |

Its limits are the cosmetic audit's: it reads sources with regular expressions, so it knows the
editor *names* the accessor and not that the string reaches a DOM node. What is on the screen is
a browser claim.

### F15 — the picker shows the weapon, from the builder that makes the weapon

The editor printed twelve names and thirteen numbers and never once showed the object.
`LoadoutStats` has been the point of that screen since M6 precisely because it is repainted from
`resolveLoadout` — *the same call the match makes* — so the numbers cannot be a marketing chart.
`WeaponPreview` is that argument applied to the picture: the model is `buildWeaponModel`, the
viewmodel's own builder, from the same `WeaponModelSpec`, with the same three shared materials
and the same procedurally generated camo. There is no second description of a rifle in it.

Three decisions inside that are not obvious:

- **It has a renderer of its own.** `Renderer`'s canvas is full-screen and *behind* the DOM
  front end, and `.op-screen` paints a near-opaque gradient with a backdrop blur over all of it,
  so scissoring the preview into a corner of the main canvas would put it behind the screen it
  belongs to. The context is created on the first `show()` rather than at boot — most sessions
  never open the editor.
- **The framing comes from the geometry, not from a per-weapon number.** The pistol is genuinely
  a different size (`WeaponModelSpec.scale` says so) and a fixed camera distance would draw one
  as a speck and clip the other. The bounding box is taken from what was just built, so a spec
  change moves the framing with it.
- **A hovered weapon is drawn bare.** The camo belongs to the equipped weapon in that slot; a
  weapon under the cursor has not been equipped, and painting the class's finish onto it would
  show a combination that does not exist. Choosing a camo repaints the equipped model with it,
  which is the point of putting the two on one screen. Attachments are **not** modelled — the
  builder has no notion of them, and inventing one here would be the second source this feature
  exists to remove.

The spin is ticked from `Game.draw`, not from a timer of its own: same reasoning as the summary
countdown's, and a weapon spinning in a background tab is a GPU nobody asked for.

### `WeaponIcons` was the second source, and the brief said to decide about it

It was one hand-typed 48-coordinate `AR` outline keyed by weapon **class**, with `iconFor`
returning null for the eight classes nobody had drawn — so eleven of the twelve shipped weapons
printed their name in the killfeed instead of a shape.

The decision is that it stops being a source. `weaponSilhouettePath` projects the same
`WeaponModelSpec` orthographically down +X — the side view the specs were authored to read at,
which is what "the LMG reads as heavier than the SMG at a glance" means — and every part becomes
one quad in the union. `rx` is honoured because it rotates in exactly the plane being drawn (the
grip's rake, the stock's drop, the magazine's curve); `ry` and `rz` are ignored, because they
turn a part out of this plane and an ejection-port sliver seen edge-on is not part of a 16-pixel
silhouette. The glass and the red dot are skipped: they are what you see *through*.

Measured over the shipped roster: **12 weapons, 12 distinct silhouettes, 19-25 quads each, every
coordinate inside the 48 × 16 box with its 0.5 margin honoured.** The fit is uniform-scale, and
both constraints bind for different weapons — the pistol is height-limited and 19 units wide,
the snipers are width-limited and span the full 47 — which is the proportion difference the icon
exists to carry. The name fallback is gone: an id with no spec of its own gets `AR_BASE` from
`modelSpecFor`, which is exactly what the *viewmodel* would draw for it, so the feed and the
hands still agree.

### Measured

Nothing in this session changes a number the harness reports, which is the honest description of
what was verified: the work is a screen, a doctrine and a check, and the harness's job here was
to show that removing `editorOpen` from two HUD predicates and `uiFocus` from the input path did
not move anything. `npm run skirmish`, three headless clients, shipped timings, one full cycle
through a vote and a migration:

| Probe | Result |
|---|---|
| Quick loadout window | 9 800 ticks over **29 windows** (6 206 respawn / 3 594 pre-match) |
| ...open while alive and out of the freeze | **0** — the B13 assertion, and it blocks |
| Tab surviving `neutralise` while dead | **3 184** of 6 216 dead ticks; board open 3 184 |
| Spectator invariants | 6 238 selections while dead, **0 self / 0 enemy / 0 dead** |
| Divergence checker | **0 / 7 372** per client |
| Mispredictions into a live match | **0** (§8.9 requires 0); to the arena 0; spawn window 0 |
| Live roster | 3H + 7B = 10, the mode's authored count |
| The run | **FLOW CHECK PASSED** |

Unchanged and expected: `post-match hold: NOT EXERCISED`, at shipped timings, for the reason the
B4 session recorded.

| Probe | Result |
|---|---|
| `npm run leak`, 100 cycles | subscriptions **26 → 26 (+0)**, heap 12.65 → 13.29 MiB (+0.64). LEAK CHECK PASSED |
| `npm run check` | boundaries, cosmetic audit, **unlock audit** and all three typecheck targets pass |
| Unlock audit red controls | 3 of 3 went red; see the table above |
| Weapon silhouettes | 12 weapons, **12 distinct**, 19-25 quads each, 0 coordinates outside the box |

And the grep the brief asked for, which is now the weaker of the two proofs:

| Question | Answer |
|---|---|
| `transitionTo('LOADOUT')` | **one**, `Game.ts`, wired to the main menu's button |
| callers of `loadoutEditor.show()` | **one**, the `LOADOUT` state's `enter` |
| rows of `LEGAL_TRANSITIONS` naming `LOADOUT` as a target | **one**, `MENU` |

### Needs a browser

Every claim in this session is about a screen, and `HeadlessClient` builds no `ClientMatch`, no
`Game` and no DOM. The harness proves the rules around the editor did not move; it cannot see
the editor. The silhouettes were rendered to a standalone SVG page and looked at — twelve
distinct, recognisable shapes — but **not at 42 × 14 in the killfeed**, which is the size that
decides whether they read.

- **B11, and it is the one to check first.** Open Create-a-Class, open the Primary row, scroll to
  the bottom of the weapon list and pick something. The list must **not** move. Then: change
  class on the left, rename one, equip one, fit an attachment — none of those may scroll either
  the option list or the page.
- **B5.** The editor must offer **one** button, reading "Save and exit", landing on the main
  menu. Edit a class, leave with the button, reload the page: the edit is there. Do it again
  leaving with **Escape**: the edit is there too.
- **B8.** Pause a match: there must be no "Create a class" button. Escape out, press 1-5: the
  class still changes in the two windows and nowhere else. There is no route into the editor
  from a match — if one is left, it throws `Illegal game transition` rather than opening.
- **B7.** At a low level, open Lethal and Tactical. SMOKE must read `LEVEL 3`, SEMTEX `LEVEL 8`,
  CLAYMORE `LEVEL 16` — and the camo rows must name their challenge rather than saying LOCKED.
- **F15.** The weapon must be visible, centred, spinning on the spot rather than wobbling, and
  it must change as the cursor moves down the weapon list. Choose a camo: the model must take
  it. Open the Sidearm rows: the pistol must be the one on show. Then check the frame cost with
  the editor open — it is a second WebGL context and the first one anybody has measured.
- **The killfeed.** Get killed by several different weapons and look at the icons at their real
  size. This is the claim the SVG page cannot make.

### Found while here

- **`ClientMatch.uiFocus` and `HudSurfaceState.editorOpen` both lost their last writer** with the
  overlay, and both are removed rather than left. Recorded here rather than under a report
  because the pattern is worth the line: this milestone's standing failure is a fact that moved
  and left its readers behind, and this is the mirror image — a *route* that went away and left
  its guards behind. A guard for a case that can no longer arise reads exactly like a guard
  somebody forgot to trigger.
- **`EQUIPMENT_UNLOCK_LEVEL` is the only gated category whose level lives in a side table**
  rather than on its def, which is half of why B7 was easy to write. It stays where it is —
  `Unlocks.ts` is the file about gates — but it now has exactly one reader
  (`equipmentUnlockLevel`) instead of two ad-hoc lookups with `?? 1` on the end.
- **The editor's "Start match" is gone and the main menu's is not.** Nothing else offered it, so
  no flow lost a step; a player who wants to play now presses Start on the screen that has
  always had one.

## Playtest round 4 — killstreaks became a currency, and B10 is what keeps it one

Covers **B9** ("activating an ability must cost kills: twelve earned, spend six, six left, and
an eight cannot then be afforded") and **B10** ("once a streak has been used it cannot be used
again until death resets it").

### They are one report, and the second is what makes the first survive

Neither of these was a defect. `StreakSystem` did exactly what it was written to do, and the
comment at the top of it said so in plain words: someone who reached twelve kills held six
things and could spend three of them. Streaks were **thresholds** on `PlayerScore.streak` —
`checkEarned` asked whether the consecutive-kill count had *crossed* a requirement, pushed an
entitlement into a `pending` list when it had, and `activate` spliced one back out again without
the counter moving. Crossing twelve opened everything priced at twelve or under, all at once,
and spending was free.

What the report describes is a **balance**. That is a different economy, not a corrected one,
and the interesting part is what it does to B10. Under a threshold, "once per life" was very
nearly free: `awardedUpTo` stopped a streak being re-granted at the same requirement, so the
only way to hold two UAVs in one life was to have a care package drop you one. Under a balance
it is load-bearing — without it, twelve kills buys the same four-kill UAV three times, and the
optimal play is to spam the cheapest thing in the class. **B10 is not a second fix; it is the
rule that stops B9's model degenerating**, and the two were built as one change for that reason.

### The economy, and where each piece of it lives

`src/shared/streaks/StreakLedger.ts` is new and holds the whole of it: kills banked, kills spent,
what has been bought this life, and the audit. It replaces two maps on `StreakSystem` (`pending`,
`awardedUpTo`), neither of which was a price.

- **The balance is credited from the score and is not the score.** `foldKills` takes
  `PlayerScore.kills` — cumulative, the server's, the thing match results are made of — and banks
  the *difference* since the last fold. So the score stays the single authority on whether a kill
  counted at all (a suicide and a friendly-fire kill never move it, so they never pay for
  anything) and `streaks/` never re-decides the friendly-fire rule. The brief asked for the
  separation to be explicit in the code because F14's `MO951357` has to add thirty kills of
  purchasing power without touching the scoreboard: `credit` is that second door, and it exists
  precisely because the balance is not a read of `PlayerScore.kills`.
- **The debit is the entitlement check.** `activate` no longer asks "do you hold it" — holding is
  not a thing any more — it asks `ledger.charge`, which refuses what the balance cannot cover and
  what has already been bought this life, and is the only place a refusal is counted. Asking
  `canAfford` first and charging afterwards would be two questions, and two questions is how a
  refusal goes unrecorded.
- **`requirementFor` is `priceOf`.** The number is the same one `StreakDef.requirement` always
  carried. A name that says "requirement" over code that debits it is a name that hides the
  model.
- **`nextFor` is measured against the balance, not the streak.** That is the whole difference in
  one line: after a purchase the HUD's "6 / 8 · SENTRY" goes back *up*, because the money is
  gone.

### The care package pays in kills

The brief asked for an explicit decision. A crate credits **the price of what it rolled** rather
than handing the streak over.

Handing the streak over is the one shape that breaks both new rules at once. A crate drops a
random `fromCarePackage` streak, which need not be one of the claimant's three — and since round
two, keys 3/4/5 index the *class's* slots, so an unequipped drop had no key to be pressed from
and no price on screen: a dead gift. It also laundered B10, because a second copy of a streak
already spent this life would arrive as a fresh entitlement. Paying out the roll's value keeps
one currency, one once-per-life rule and no dead drops, and the gamble survives intact — a crate
is worth between five and twelve kills depending on what it rolls.

### Two credits that had to be refused, both found by measurement

Both are the same mechanism — **a wallet belongs to a life** — and neither was visible until the
probe below started counting life-starts.

1. **A kill that lands after your own death.** A mutual kill is two `EntityKilled` events in one
   tick, and in one of the two orders the loser's death is processed first: `onDeath` zeroes the
   wallet, and then the kill they landed on the way down credits it again. The balance survives
   into the next life, which is exactly what B10 forbids. `checkEarned` now drops the credit for
   a combatant whose `health.alive` is false — but still **advances the anchor**, because the
   score has counted that kill and always will, and leaving the anchor behind would bank the same
   kill one life later instead, where nothing would be looking.
2. **A credit aimed at a corpse.** `credit` had no such rule, so the harness's repeating top-up
   paid dead seats. `creditKills` is now the single door for every unearned credit — crate, cheat,
   harness — and applies the same test.

### `PlayerController.spawn` is the one door a new life comes through

Worth writing down because P5 is looking for exactly this signal. The audit first subscribed to
both `EV.PlayerSpawned` and `EV.BotSpawned` and counted **304 life-starts against 154 actual
ones**. They are not two spawns: `Bot.spawn` calls `this.controller.spawn` at line 285 and
`NetPlayer.spawn` calls it at line 240, and `PlayerController.spawn` is what emits
`EV.PlayerSpawned`. `EV.BotSpawned` is a *second announcement of the same spawn*, carrying tier
and nearest-enemy detail for the director. One subscription covers every combatant in the game.

### The wire is a price list now (protocol v10)

`MsgS.Streaks` carried `pending`, a list of kind indices the player had earned. A currency cannot
be replicated that way: a client needs to know what a press will **cost** before making it, and
why a key that did nothing did nothing. Both facts are the server's — the price carries Hardline's
discount, the used set is per life and per entity — so `StreakView` now carries
`offers: {kind, price, used}[]` and `balance` in place of `pending` and `streakCount`.

Offers are keyed by kind rather than sent in slot order. The server drops empty slots when it
resolves a class, so position does not survive a class with a gap in it; the client already knows
its own three keys and looks each one up.

Three bytes per offer against one per held streak is bigger, and has to be. `MAX_PENDING_STREAKS`
is `MAX_STREAK_OFFERS`, still three.

### "Is it in your class" moved to the untrusted boundary

It used to be answered implicitly: the pending list could only hold what had been earned, and
earning was filtered by the class. With no list, the question needed a home, and the right one is
`Server.onStreakRequest` — beside the three untrusted questions §4.16 already answers there
(which instance, where it lands, and now: whether they can pay). Putting it back inside
`activate` as well would have cost the debug panel its "buy and use" buttons for the three
streaks a class does not carry, which is acceptance criterion 1's only instrument.

### The HUD has four states, and the fourth is why the key did nothing

`HudStreaks` painted three: empty, owned-but-unearned, ready. There are four now, and the price
is on screen, because a player cannot plan a purchase whose cost they cannot see. Unaffordable
and already-spent both leave the key doing nothing, which is exactly why they must not look the
same: an unaffordable slot shows its price in kills, a spent one reads `USED` and is struck
through. That is the report's *"a used streak's key doing nothing while saying why"* — said
persistently by the slot itself rather than by a toast, because round four's own HUD-surface
invariant is that surfaces have one writer and this needed no new surface.

Keys 3/4/5 still index the class's three slots, unchanged from round two. The earned list decided
whether a press was honoured; the balance and the used set decide it now.

### Measured

Every number below came out of a run in this session, named with the probe that produced it.
`ServerMatch.streakEconomy` is the probe; it folds the still-open lives in, so it can be taken
mid-match and taken twice.

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.** The five scores are byte-identical
to the pre-change baseline (75-61, 66-75, 44-75, 69-75, 75-64), which is the regression control
and is expected: nothing in a bot-only match spends a streak.

| | Total over 5 matches |
|---|---|
| Lives closed / life-starts observed | 705 / 718 |
| Life-starts inheriting a balance (must be 0) | **0** |
| Kills banked, against 679 scored in the five matches | 678 |
| Negative balances observed (must be 0) | **0** |
| Kill-anchor resyncs inside a match (must be 0) | **0** |
| Post-mortem kills dropped | 1 |
| Streaks a life is entitled to — **threshold model** | **75** |
| Streaks a life is entitled to — **balance model** | **38** |

The last two rows are the pacing answer the brief asked for, and both come out of the same run
on the same seeds: the threshold model handed out 75 streaks across those 705 lives, the balance
affords 38. **A 49% cut in what a life's kills entitle a player to.** That is the intended
direction — twelve kills is now a chopper *or* a UAV and a sentry — and it is the human's call
whether it is the intended size.

**Red before green.** `dirtyLifeStarts` was **1 in 152 life-starts** on seed 4 before the
post-mortem guard and **0 in 152** after, with `postMortemKills` going 0 → 1 on the same match.
One fix, one moved number, and the other four matches unchanged.

**`npm run skirmish -- --grant-streak uav` — 3 headless clients, real server, real wire.** The
grant was one-shot before this session, which is the right shape for an entitlement and the
wrong one for a currency: a single grant is spent once and proves only that the debit runs. It
tops the wallet up every 15 s now, so every client is permanently able to afford the UAV and the
only thing that can stop them buying it again is B10.

| | |
|---|---|
| Wallet top-ups × 3 clients | 21 × 3 = 63 payments, **240 kills credited** (12 dropped to dead seats) |
| Spent | **68** = 17 × the UAV's price of 4 |
| Activations | **17**, across 24 lives (7 + 5 + 9 deaths, plus the life each ended in) |
| **Most streaks bought in any one life** | **1** |
| Peak balance held | 32 |
| Life-starts inheriting a balance | **0** |
| Negative balances / resyncs | **0 / 0** |

That fourth row is B10, measured rather than asserted: a permanently funded wallet, a peak
balance of 32 against a price of 4, 17 purchases — and **no life ever bought the UAV twice**.
Each of those 63 payments would have been a separate entitlement under the threshold model, and
the clients ask for one every 30 ticks when they have one.

The streak still works end to end over the wire in the same run: 17 live streak entities seen per
client, 3 at once at peak, 2429 / 1337 / 2429 sweep frames and 5 UAV contacts. `spent` is exactly
`activations × price` in every run measured.

**`npm run leak` — 100 cycles.** Subscriptions **27 → 27 (+0)**, heap 12.7 → 13.34 MiB. The
audit's spawn subscription replaced the two it started with and the count did not move.

**`npm run check`** and **`npm run build`** green.

### What was not verified

`npm run harness` reports **0 activations**, and that is not a probe failing to fire — see "Found
while here". The activation numbers above all come from the skirmish harness, where the headless
clients are the only things in the project that spend.

`balance = earned − spent` is not measured, because it is not measurable: the balance is computed
from the other two rather than stored, so there is no third number that could disagree. What is
measured is the pair that *can* go wrong — a balance below zero, and a life that started with one.

### Needs a browser

Nothing below is testable headlessly. `HeadlessClient` drives `NetClient` and `Prediction` and
builds no `ClientMatch`, so it has no streak strip, no keys and no loadout editor; and the preview
pane never fires `requestAnimationFrame`, so it cannot stand in for one either.

- **B9, the balance going down.** Get to four kills in a class carrying a UAV. The strip's UAV
  slot must light and read `4`; the progress line must read `4 / 5 · COUNTER-UAV` or whatever the
  class's next-cheapest is. Press 3. The UAV must go up **and the progress line must go back up
  too** — the balance is now 0, so the line should read `0 / 4`-something. That is the entire
  report in one keypress.
- **B9, the case the report names exactly.** Reach twelve kills with a class carrying something
  priced at 6 and something at 8. Spend the 6. The 8 must go dark and show `8`, and pressing its
  key must do nothing.
- **B10.** After spending the UAV, keep killing past four again. The UAV slot must stay `USED`
  and struck through — not re-light — and its key must stay dead. Then die. On respawn the slot
  must clear back to its price and the balance must be 0.
- **The price on an unaffordable slot.** At zero kills all three slots must show their prices,
  dimmed. This is what makes a class readable before the match starts.
- **The care package.** Claim one and watch the balance jump by the price of whatever it rolled,
  rather than a streak appearing in hand. The pickup still names its contents.
- **Create-a-Class.** The killstreak rows must read `Costs 12 kills · …` rather than `12 kills`.
- **Hardline.** With the perk on, every price on the strip must be one lower, and the debit must
  match what is shown.
- **The mortar.** Open the overlay with a marked balance, cancel with the same key: the balance
  must be untouched. Confirm: it must drop by the mortar's price exactly once.

### Found while here

- **No bot has ever spent a killstreak.** There is no call site: `StreakSystem.activate` is
  reached from `ClientMatch` (the local player's keys), `Server.onStreakRequest` (a human's
  request), and the two debug surfaces. Bots earn a balance — the harness measures 678 kills
  banked over 705 lives — and never spend a kill of it. That is why `activations` is 0 in every
  bot-only run, on both sides of this change, and it is why the pacing comparison above is
  computed as *entitlement per life* rather than as activations. It is not this session's item —
  nobody reported it and building bot streak AI is a feature, not a fix — but it means the human
  currently plays against ten opponents who will never call anything in, and F16's three new
  streaks would inherit the same silence.
- **`EV.StreakProgress` and `EV.StreakEarned` have no gameplay subscriber.** Only the debug
  panel's log listens. Both are still emitted and both now carry balance-model numbers, but a
  streak becoming affordable is currently announced to nobody — no audio cue, no HUD flash. That
  is a gap an announcer would fill and is worth knowing before F16 adds three more streaks to
  not announce.
- **A round start is not a death, and the ledger treats it that way.** `dirtyLifeStarts` is the
  count of lives that began holding a balance from the life before, and it is 0 in every TDM run
  measured here because every TDM life starts with a death. A Search & Destroy survivor's next
  round starts without one, and will carry both the balance and the used set across. That is a
  policy question rather than a bug under B10's literal wording ("until death resets it"), and it
  is P5's row to decide. **Decided in P5, below: the carry-over stays** — surviving a round keeps
  the wallet and keeps the used set — and `dirtyLifeStarts` gained a second number to be checked
  against rather than an assertion it could no longer make.

*Two numbers in this section were overtaken by the session below and are left as they were
measured. The five `npm run harness` scores are no longer a byte-identical control against the
pre-change baseline, because P5 armed the bots with grenades for the whole match instead of one
each, which changes the fight; and `postMortemKills`, `thresholdGrants` and `balancePurchases`
all move with it. The model numbers — 0 negative balances, 0 dirty life-starts, 1 streak bought
per life at most — are unchanged.*

## Playtest round 4 — a life can start without a death, and only one signal knows it

Covers **B3** ("grenade stock is not refilled after death or elimination; it happens in certain
modes").

### Why round two's fix was right and still did not reach them

Round two already found this once and fixed it: `MatchEquipment.refillForLife` exists, and its
comment explains that a networked respawn emits no `player.spawned`, so the refill was split out
of the event handler and called explicitly. That call is correct. What was wrong was **what
reaches it** — the trigger, not the fix.

The client asked *"has a dead player stopped being dead"*: `applyReplicatedSelf` ran the per-life
reset on `alive && this.playerDead`. That is true of a respawn and of nothing else. The server's
life boundary is not the alive bit at all — it is `PlayerController.spawn` — and there are new
lives that go through it without the alive bit ever moving:

- **A Search & Destroy survivor at a round start.** The server's `RoundStarted` handler spawns
  *every* player, living ones included, because a survivor left standing where the last round
  ended is a free plant. It refills its own copy of their hand, picks them a new spawn point and
  bumps their spawn serial. The client sees a player who was alive and is still alive, decides
  nothing has happened, and leaves the hand at whatever the last round ended on.
- **A class change cashed during the pre-match freeze**, `applyPendingLoadoutNow`, which
  respawns a standing player on purpose so the class they pressed is the class they start with.

That is the report's *"in certain modes"*, exactly: the modes where a life can begin without a
death. Round two's own note that *"the spawn-serial bump is the same discontinuity a death
already produces"* had already named the right signal; nothing outside prediction could see it.

### The bots had it worse, and nobody could have reported it

`BotThrower.respawn` — the function that gives a bot its grenades back — had **exactly one caller
in the project, and it was on the client**: `MatchEquipment.onSpawned`. `ServerMatch` constructs a
`BotThrower`, calls `consider` on it every tick, and never once called `respawn`. `stateFor`
hands a bot that has never thrown a lazily-created `{lethal: 1, tactical: 1}`; `consider`
decrements it; `pickEquipment` skips a slot at zero. So over a dedicated server **every bot threw
one lethal and one tactical per match and was unarmed for the rest of it**, in every mode, from
M9 onward.

Nobody reported it because there is no way to see it. A bot that stops throwing grenades looks
like a bot that decided not to. This is the standing authority-migration failure in its purest
form — the simulation moved to the server and the reset stayed behind on the client — and it is
why B3's fix had to be measured across the whole roster rather than on the reporter's own hand.

### One signal, and what it actually is

The brief asked for one signal rather than a third call site. The honest answer is that it is one
fact with two transports, because the client that needs it is not running the simulation that
produces it:

| Where the sim runs | The signal | Why it is the only one |
|---|---|---|
| Server, and a single-player client | `EV.PlayerSpawned` | `PlayerController.spawn` emits it, and `NetPlayer.spawn` and `Bot.spawn` are the only two places in the project that put a body back to `alive` — both call it. One door **by construction**, not by inspection |
| A networked client | the replicated `spawnSerial` | `NetPlayer.spawn` bumps it on the same line, and it crosses the wire already, in the snapshot delta |

`EV.BotSpawned` is deliberately not also subscribed anywhere: round four's streak audit measured
what happens when it is — 304 life-starts against 154 real ones — because it is a second
announcement of the same spawn carrying tier detail for the director, not a second spawn.

So `ServerMatch.beginLife` is one `EV.PlayerSpawned` subscription that refills a human's hand or
a bot's thrower, replacing the refill that used to sit inside `spawnPlayer` — a door that was the
only one *by inspection*, which is to say a door a second caller would have had to remember to
copy. On the client, `NetClient` exposes `localSpawnSerial`, `NetSession` sends it beside health
and liveness, and `ClientMatch.applyReplicatedSelf` compares it against the last one it acted on.
`respawnNetworked` was renamed `beginLife` for the reason the bug happened: naming it after the
death it no longer needs is what let the round start be forgotten.

The serial is deliberately read as **state, not as an edge**. `NetClient.respawned` is the edge
and stays private — the reconciler consumes and clears it on the very next owner block, so a
second reader would race it and one of the two would silently see nothing. A serial is still true
on the tenth snapshot after the spawn, so a reader comparing it with its own last-seen value
cannot miss a life by being late.

No protocol bump. The serial has been on the wire since M10 and nothing about its encoding
changed; what changed is that something other than the reconciler is allowed to look at it.

### The client was also re-spawning itself over the network, and it hid this bug

`ClientMatch`'s `RoundStarted` subscription ran in both runtimes, and `hardResetRound` calls
`respawnPlayer`, which runs `selectSpawn` and teleports the local controller to a point **the
client chose** while the server was putting the body somewhere else. A guaranteed misprediction
of up to the width of the map, every round, corrected a snapshot later by a camera lurch.

It also concealed B3 by accident: that local `player.spawn` emits `player.spawned`, so a
networked S&D survivor's grenades *did* sometimes come back — as a side effect of an illegal
teleport rather than because anything had decided a life had started. Removing the second writer
without the serial would have turned an intermittent bug into a certain one, which is why the two
are one change. `hardResetRound` is single-player only now.

### Every per-life fact, and the signal it resets from

The table the brief asked for. "The spawn" means `EV.PlayerSpawned` where the simulation is local
and the replicated spawn serial where it is not — one fact, two transports, as above.

| Per-life fact | Who resets it | From which signal |
|---|---|---|
| Grenades, lethal + tactical (human) | `ServerMatch.beginLife` · `MatchEquipment.refillForLife` | the spawn |
| Grenades (bot) | `ServerMatch.beginLife` → `BotThrower.respawn` · `MatchEquipment.onSpawned` | the spawn |
| Cook timer / throw state | `ThrowController.reset`, from those same callers | the spawn |
| Bot throw cooldown | `BotThrower.respawn`, with the stock | the spawn |
| Flash blindness | `MatchEquipment.refillForLife` | the spawn |
| Health | `NetPlayer.spawn` · `Bot.spawn` · `ClientMatch.beginLife` | the spawn |
| Weapons, magazines, reserve, sights | `NetPlayer.spawn` · `ClientMatch.beginLife` | the spawn |
| Knife | `ClientMatch.beginLife` | the spawn |
| Viewmodel slot | `ClientMatch.beginLife` → `showSlot` | the spawn |
| Queued class change | `ServerMatch.spawnPlayer` · `ClientMatch.applyPendingLoadout` | the spawn |
| Prediction history | `NetClient.applyOwnerBlock` → `prediction.reset` | the spawn serial |
| Rewind history | `ServerMatch.spawnPlayer` → `rewind.resetAt` | the spawn |
| Death screen, respawn clock | `ClientMatch.beginLife` | the spawn |
| **Streak balance, spent, used set** | `StreakLedger.resetLife` | **death only** — decided below |
| Streak "already announced" set | `StreakLedger.resetLife`, with the balance | death only |
| Field-upgrade charge | — | **not per life, by design** |
| `MatchProgression.killsThisMag` | `EV.PlayerSpawned`, filtered on `PLAYER_ENTITY_ID` | the spawn — **but see "Found while here"** |
| `PerksRenderer` footstep trail | `EV.PlayerSpawned`, filtered on `PLAYER_ENTITY_ID` | the spawn — **same** |

Two rows deserve their own sentence. The **field-upgrade charge** is not a per-life fact and
never was: `FieldUpgradeRuntime` charges on sim ticks and pauses while dead, precisely so dying
does not hand you a free activation. Its `reset()` has no caller anywhere in the project, which
reads like an oversight and is the opposite of one — but a method with no caller is
indistinguishable from a signal somebody forgot to wire, which is how this session started, so it
is written down rather than left to be rediscovered.

The **streak balance** is the row P4 handed over, and it is now a decision rather than a default.

### A round start is not a death, and that is the decision

A Search & Destroy survivor keeps the kills they banked and stays blocked from re-buying a streak
they already spent. Only dying clears either. That is B10's wording taken literally — *"until
death resets it"* — and it makes surviving a round worth something, which is what a
one-life-per-round mode is for.

The consequence is that `dirtyLifeStarts` could no longer be asserted at zero, and a counter
whose failure case has been quietly excused is a counter that cannot fail. So the ledger counts
the same thing from the other end: `noteRoundBoundary` counts, at each round turn, the wallets
that are about to survive it, and **`dirtyLifeStarts === roundCarryOvers`** is the invariant. It
fails in both directions — a wallet that survived a *death* appears on the left with nothing to
match it, and a survivor whose wallet was wrongly cleared appears on the right — and the skirmish
harness blocks on it. Ordering against the spawns the round causes does not matter, because
spawning does not touch a ledger row.

### The probe, and why it samples at the end of the tick

`LifeStockAudit` counts, for every life that starts, whether it started holding a full slot.
`ServerMatch.equipmentAudit` is the reading; both harnesses take it.

It samples at the **end of the tick the spawn happened on**, not inside the spawn event, and that
is what makes it honest: the refill is another subscriber to the same event, so a probe reading
during the emit would be measuring subscription order rather than the game. At the end of the
tick the life has been through every system that could have handed it anything, which is the
state the player actually wakes up in.

`partialStock` is the number, and `lifeStarts` is reported beside it every time, because "0
partial" out of no lives at all is what a probe that never fired looks like — and this milestone
has already shipped three of those.

### Measured

Every number below came out of a run in this session. The red control is the probe with the fix
removed — `beginLife` restored to the pre-fix body, which refilled a human's hand if one had been
created and did nothing at all for a bot — rebuilt and run against the same seeds, then reverted.

**All five modes, `--matches 2 --asap`, seeds 1-2 on Foundry, bots only.** The claim the brief
asked for, with its control:

| Mode | Life-starts | Partial stock — **red** | Partial stock — **green** | Empty — red | Grenades held / expected — red |
|---|---|---|---|---|---|
| TDM | 291 → 288 | 169 | **0** | 123 | 290 / 582 |
| Domination | 619 → 660 | 409 | **0** | 323 | 506 / 1238 |
| Kill Confirmed | 310 → 322 | 202 | **0** | 138 | 280 / 620 |
| Free-for-All | 228 → 246 | 96 | **0** | 62 | 298 / 456 |
| Search & Destroy | 80 → 80 | 12 | **0** | 3 | 145 / 160 |
| **All five** | **1528 → 1596** | **888** | **0** | **649** | **1519 / 3056** |

**888 of 1528 life-starts began holding less than a full slot, and 649 began holding nothing at
all. After: 0 of 1596**, and `observedStock` equals `expectedStock` exactly in every one of the
ten runs — 3192 grenades against 3192, which is the stronger statement, because a fix that
refilled the wrong slot would clear `partialStock` and not that.

The life-start counts are close but not identical on either side, and that is the change reaching
the simulation rather than a probe wobbling: armed bots kill differently, so the same seed is a
different fight. It is also why P4's byte-identical score control no longer holds — see below.

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.**

| | |
|---|---|
| Life-starts examined / with partial stock | 722 / **0** |
| Grenades held against expected | 1444 / 1444 |
| Streak life-starts inheriting a balance / round carry-overs | 0 / 0 |
| Negative balances / kill-anchor resyncs | **0 / 0** |
| Kills banked, against 683 scored | 683 |

Scores: **75-59, 75-66, 62-75, 75-66, 60-75**, against P4's 75-61, 66-75, 44-75, 69-75, 75-64 on
the same seeds. **The regression control is deliberately broken and that is the result.** P4 could
claim byte-identical scores because nothing it changed touched the simulation; this session put
grenades back in ten bots' hands for the whole match instead of one each, and a fight in which
grenades keep arriving is a different fight. Every match still completes, still reaches a score
limit, and the four model invariants above are unchanged. `postMortemKills` moved 1 → 5 and
entitlement per life 75 → 93 threshold / 38 → 43 balance, all in the direction more lethal bots
predict.

**`npm run server -- --mode SND --matches 5`, for the decision.** `dirtyLifeStarts` against
`roundCarryOvers`, per match: **5/5, 3/3, 1/1, 3/3, 4/4** — equal in all five, over 190
life-starts, with 0 partial stock. Every wallet that survived into a new life survived a *round
boundary*; none survived a death. That is the S&D policy measured rather than asserted, and it is
the invariant the skirmish harness now blocks on.

**`npm run skirmish` — 3 headless clients, real server, real wire, TDM.** This is the only place a
**connected human's** grenades are measured, because the local harness seats no humans.

| | Red | Green |
|---|---|---|
| Life-starts examined | 100 (22 human, 78 bot) | 110 (23 human, 87 bot) |
| With partial stock | **48** | **0** |
| Started empty | 33 | **0** |
| Grenades held / expected | 163 / 244 | **266 / 266** |
| Flow check | **FAILED** on the new assertion | PASSED |
| Streak life-starts inheriting a balance / round carry-overs | 0 / 0 | 0 / 0 |

**`npm run skirmish -- --vote 4` — the same three clients, in Search & Destroy.** The mode the
report named, over a real wire, with humans in it:

| | |
|---|---|
| Life-starts examined | **53** (12 human, 41 bot) |
| With partial stock / empty | **0 / 0** |
| Grenades held / expected | **130 / 130** |
| Streak life-starts inheriting a balance | **4** |
| Round-boundary carry-overs | **4** |
| Flow check | PASSED |

Those last three rows are the decision, and this is the only run in the session where the
invariant is exercised at a value other than zero: four wallets crossed a round boundary, and
four wallets were counted crossing it — two different signals, one read at the spawn and one at
the round turn, agreeing. Every other run has both at 0 because a Team Deathmatch life always
begins with a death. A wallet that had crossed a *death* would have moved the first number and
not the second, and the harness would have failed.

The red run's 48 failures are not split by owner, and the split was not measured. What can be
said: 48 out of 78 bot life-starts is 62%, against the 58% the bot-only harness measured on the
same code, and the pre-fix server refilled a human's hand on every spawn after the first — so the
red is consistent with the human half of it being zero **on the server**. The human's own hand
lives in `ClientMatch`, which no headless run builds at all. See "Needs a browser".

**`npm run leak` — 100 allocate/destroy cycles.** Subscriptions **29 → 29 (+0)**, heap 12.73 →
13.41 MiB. The baseline is two higher than P4's 27 because this session adds exactly two
subscriptions — `ServerMatch`'s spawn door and the ledger's round-boundary count — and both are
released by the `dispose` they were registered through. Flat is the property; the level is not.

**`npm run check` and `npm run build`** green.

### What was not verified

The **local player's own hand** is not measured anywhere in this session, and cannot be.
`HeadlessClient` drives `NetClient` and `Prediction` and builds no `ClientMatch`, so there is no
`MatchEquipment`, no inventory and no HUD counter to read; every number above that concerns a
human is the *server's* copy of their hand. The client change — the spawn serial driving
`beginLife` — is therefore verified by reading and by the server agreeing with itself, not by a
run. It is the whole of the "needs a browser" list below.

The **misprediction the round reset was causing** is likewise unmeasured. `npm run skirmish`
votes TDM by default and the `--vote 4` run exercises Search & Destroy over the wire, but the
harness's mispredict counters are reported per migration window rather than per round boundary,
so a round-start teleport would not have shown up as a number even before it was removed.

### Needs a browser

Every item is a networked match. Single-player is unaffected by the client half of this change —
`hardResetRound` still runs there, unchanged.

- **B3, the report itself.** Join a networked Team Deathmatch, throw both grenades, die. On
  respawn the HUD's lethal and tactical counters must both be back to the class's full count.
  This is the case round two fixed and it must still work.
- **B3 in the mode it was reported from.** A networked Search & Destroy. **Survive a round**
  after throwing a grenade — do not die. When the next round starts the counters must be full.
  Before this session they stayed at whatever the last round ended on, unless the client's own
  illegal round-reset happened to fire first.
- **The round start no longer teleports you.** Same S&D match, watch the moment the round turns
  over: the camera must arrive at the server's spawn point once, cleanly. Before this there was
  a second placement a snapshot later — the client's guess being corrected — which reads as a
  lurch or a brief double-take at round start.
- **The pre-match class change.** Press a class key during the ten-second freeze of round one.
  The grenades that arrive must be the ones the *new* class carries, at its count.
- **The S&D wallet, which is the decision.** Reach four kills in round one with a UAV in the
  class and spend it. Survive the round. In round two the UAV must still read `USED` and its key
  must still do nothing, and any balance left over must still be there. Then die: on the next
  spawn it must clear back to its price with the balance at 0.
- **The bots throwing.** Not a HUD check — play a full networked match and notice that grenades
  keep coming in after the first minute. Before this every bot threw one lethal and one tactical
  in the whole match, which is the difference between an opponent who uses equipment and one who
  ran out of it before you met them. This is a **feel** change and the largest one in the
  session; if the match now feels grenade-heavy, that is the number to bring back.

### Found while here

- **Two more per-life resets are still filtered on `PLAYER_ENTITY_ID`**, which is entity 0 — the
  server's empty spectator seat — so neither fires for a connected human. `MatchProgression`'s
  `killsThisMag` never resets on a new life, and `PerksRenderer`'s footstep trail is never
  cleared, so the ghost of a previous life's path stays drawn. Both are the round-2 entity-id
  class of bug and both were missed by that audit, which walked client code looking for combat
  and cosmetic uses and did not treat a per-life reset as one. Not this session's mechanism —
  their *signal* is right and their *filter* is wrong — and neither was reported. Left.
- **`ServerMatch`'s hand keeps the grenades of the class it was created with.** `handOf` reads
  the loadout once, and `NetPlayer.applyLoadout` sets the weapons and the perks and never touches
  `hand.inventory.lethal`/`tactical`. So after a class change the server refills the *previous*
  class's grenade, at the previous class's count, for the rest of the match — while the client's
  `swapClass` sets the new one. It is the same family as B3 (a per-life reset restoring the wrong
  thing) but a different mechanism (the payload, not the signal), and it belongs with the loadout
  doctrine P3 owns rather than here. **This is the next bug**, and it is the row the table above
  would have caught if the table had a "what does it reset it *to*" column.
- **`FieldUpgradeRuntime.reset()` has no caller.** Deliberate — the charge is not per life — but
  a method with no caller looks exactly like a wire somebody forgot, which is how this session
  started. Recorded in the table so the next reader does not have to re-derive it.

---

## Playtest round 4 — reading the fight, and an optic with no hole in it

Covers **B2** (the crosshair on one AR), **B12** (team colours), **F9** (Depot is dark), **F2**
(an arrow to the bomb) and **F3** (the dog tag). Four of the five are about what the player can
*see*, which makes this the session where the split between what a harness can prove and what
needs eyes is at its widest — so two of the things built here are instruments rather than fixes.

### Two of the five had already been reported and fixed, and the interesting part is why they came back

B2 and F9 are both second and third reports of something the record says was dealt with. Neither
was a regression. In both cases the earlier fix was correct about the thing it named and was not
the thing that was wrong, and in both cases nobody could tell, because the quantity in question
lived where no process in this project could read it. That is the shape of the whole session:

- The crosshair's projection lived inside `Hud.updateCrosshair`, next to the `style.transform`
  writes it feeds. Asking "how wide is the M4's crosshair at rest" meant opening a browser.
- A map's brightness lived in a painter in `client/engine/ProceduralTextures`, three files away
  from the `lights` array two rounds of "Depot is too dark" had edited.

So `shared/ui/Crosshair.ts` and `shared/world/MapLuminance.ts` exist now for the same reason
`HudSurfaces` and `pickSpectatorTarget` do — the half that can be wrong invisibly belongs where
it can be measured — and `npm run readability` is the entry point that reads them. It is a
one-shot probe over the shipped tables rather than a run, so unlike every other harness here one
execution of it is a fact rather than a sample.

### B2 — the model had a scope and the def did not

*"The crosshair is closed on a particular AR-type rifle."*

The brief offered two hypotheses and both are dead, the first of them decisively:

| Hypothesis | What the measurement says |
|---|---|
| The spread cone collapses and draws a closed cross | `LONGBOW MK3` has the **widest** crosshair of the four ARs — 26 px standing against the M4's 18. The tightest cone in the game is the shotgun's, at 8 px. **0 of 48 hip-fire states** reach the 3 px floor |
| An optic misclassified as *scoped* takes the reticle away | Nothing misclassifies anything. `hasScope` is `def.scope !== undefined`, no AR carries a `scope` block, and no attachment adds one |

The real mechanism is the exact converse of the second, and it is one sentence: **`ar_longbow`
is the only weapon whose *model* carries a scope and whose *def* does not.**

Three weapons are modelled with `optic: 'scope'` — the two snipers and the LONGBOW, whose spec
comment says "long, thin, scoped: reads as a marksman rifle from across the screen". Two of them
have a `scope` block in `WeaponDefs`, so above `SCOPE_VIEWMODEL_HIDDEN` the viewmodel hands off
to `HudTactical`'s scope overlay and the metal is never seen. The LONGBOW has no such block, so:

- no overlay is drawn, because `hasScope` is false;
- the viewmodel is never hidden, because `scoped` tests the same field;
- and the crosshair fades to zero opacity at an ADS fraction of 0.74 like every other weapon,
  which is S6.5's rule and is correct.

That leaves the player aiming at `bodyTubes`' scope geometry: a 12-sided cylinder of radius
0.016 centred exactly on `spec.sightHeight` — the line `ViewmodelAnim.adsY` puts on the screen
centre — built by `CylinderGeometry` with its **end caps on**, because `openEnded` defaults to
false and nothing had ever needed otherwise. Aiming the LONGBOW is aiming into the flat back of
a gunmetal disc. "כוונת סגורה" is a precise description of it.

This is the third time this codebase has shipped the same defect, and both previous ones are
commented in the file it happened in again: the M6 playtest's *"pistol viewmodel obscuring the
target"* (sight bases straddling the sight line) and *"the SMG optic rendering opaque, blocking
the target entirely"* (a solid box where the window should be). M7 rebuilt `irons` and `reddot`
around `sightHeight` and wrote down the rule — *"the aperture is clear on all twelve weapons by
construction"*. It was clear on ten. `scope` was exempted on the reasoning that its owners hand
off to the overlay, which is a statement about `WeaponDef.scope` made in a switch on
`WeaponModelSpec.optic`, and those two disagree on exactly one weapon.

**The fix makes the mesh honest rather than giving the rifle a `def.scope`.** A scope block is
scope-in time, an FOV pull, breath and sway; inventing those to unblock a sight picture would be
a simulation change made for a picture, and the LONGBOW was balanced without them. So the tube
and its objective bell are open-ended, and the ocular end gets what the red dot has had since
M7 — glass with `depthWrite: false`, and an emissive speck on the sight line. Both derive from
`scopeOcularZ`, which `bodyTubes` and `opticBoxes` now share, because a lens placed from a
re-typed copy of the tube's own expression is a lens four millimetres behind the eyepiece that
nobody can explain. For the two snipers the change is invisible — their viewmodel is gone before
the overlay arrives — and the cost of making the rule uniform is two quads.

**The floor, since the brief asked for one.** `MIN_GAP` already existed at 3 px and is now named
`CROSSHAIR_MIN_GAP` and documented as a legibility floor rather than a tuning constant. Measured:
**0 of 48 hip-fire states across all twelve weapons reach it**, so it is a guard against a future
weapon rather than a number the game is sitting on. The ADS column is reported and deliberately
excluded from that count, because `crosshairOpacity(1)` is `0.00` — a collapsed gap there is
invisible by design.

### B12 — the palette was right and three surfaces chose from it wrongly

*"In multiplayer I can end up on the red side, which is confusing because red normally means
enemy."*

`ui/Palette.ts` has been right since M8. It exposes `friendly` and `hostile` and has no concept
of a team A colour in any of its three colourblind modes; there is no absolute team colour in it
to leak. The leak is one level up, in the surfaces that decide *which of the two to ask for*, and
it is the same expression written three times:

| Surface | What it said |
|---|---|
| `Scoreboard` | `team === 'A' ? 'friendly' : 'hostile'`, and `'ALLIES' : 'AXIS'` |
| `Killfeed` | `team === 'A' ? '…--friendly' : '…--hostile'` |
| `HudBanner` | slot A built with `--friendly` and slot B with `--hostile`, at construction |

Each is correct for the seat the game was built from. `Match.smallerTeam` sends the **second
human to join** to team B, and from there the scoreboard paints your own side hostile red and
labels it AXIS on the right, the killfeed paints your team-mates as enemies for the whole match,
and the banner shows your score in the enemy's colour. `EndOfMatch` reuses `Scoreboard`, so the
summary screen was absolute too — at the one moment the player looks hardest at it.

Already relative and needing nothing: the minimap (*"resolved by the caller against the local
team, so the minimap needs no team logic"*), the objective meshes, zone ownership, and the alive
counter. The vote overlay carries no team colour, and there are no nameplates in the tree.

**The rule is enforced by types, which the brief asked for over a comment.** `shared/ui/
TeamColour.ts` holds `relationTo(viewer, subject)`, and `relationClass` — the only door from a
relation to a stylesheet suffix — accepts only a `TeamRelation`. A raw `ScoreTeam` no longer
type-checks anywhere a colour is chosen, so the broken expression cannot be written: there is
nothing for `team === 'A' ? …` to return that a caller can use. The audit agrees with the type
after the change — `grep` finds no `=== 'A'` left in `client/ui` at all.

Three decisions inside it that are not just a rename:

- **Order is part of the bug.** A team-B player was reading their own score on the right. Both
  two-slot surfaces put the viewer's own side on the left now, via `teamsInViewOrder`.
- **`ALLIES` / `AXIS` were absolute too**, and carried the same defect in words: a player seated
  into B was told they were the Axis. They follow the relation.
- **Free-for-All is inside the same function rather than beside it.** FFA keeps the two-team
  substrate deliberately, so half of every lobby shares the viewer's `ScoreTeam` without being a
  team-mate — the seam post-M8 closed in the minimap and the gunfire ping and left open in the
  killfeed, where four opponents were drawn green. `relationTo` takes `freeForAll` and answers
  `HOSTILE` for everybody, so the killfeed is fixed by the same change rather than by a second one.

The viewer is assembled once, in `MatchHud`, and handed to all three surfaces; `ClientMatch
.viewer` is the getter it comes from, beside `localTeam`, which already carries a comment about
this class of bug. The summary board takes it from `GameScreens.showSummary`, because that screen
is built at boot and outlives every match it shows.

### F9 — the fill was not the small number either, and this time the small number was not a light

*"The third map is very dark."* Reported after M8, again at round 2, and now a third time.

Round 2's work is right and I checked its arithmetic before touching anything: it found that
intensity was the wrong lever, re-derived Depot's hemisphere colours in linear space, and landed
the fill at about 42% of Foundry's sky term with a ground term that is actually *brighter* than
Foundry's. There is nothing left to find in `depot.ts`. So the analysis the brief asked for —
*"the problem was not the key light, it was the fill"*, applied to Depot — has an answer one
level further down, and it is not a light at all:

**Depot's yard is one `asphalt` span from wall to wall, and `asphalt` was `0x24262b` — a linear
luminance of 0.019, against Foundry's floor at 0.101.** A surface that returns two per cent of
what falls on it. Two rounds multiplied the light reaching it by 1.5 and 1.9; two per cent of
1.9 is still two per cent. That is why each pass looked partial, and why the third report says
what the first one said.

The number was in a painter in `client/engine`, where the word "lighting" does not appear and
where no Node process could read it. It is in `shared/world/maps/albedo.ts` now, one table, and
`ProceduralTextures` takes its fill from it — so the grain, aggregate, cracks and bay lines stay
exactly where they were and the number they are laid over can be measured.

Measured, and the red control is one flag rather than an edit-and-revert:
`npm run readability -- --ground 0x24262b` re-reads Depot with its shipped asphalt.

| Map | Ground | Albedo (linear) | Floor, as the screen shows it (0-255) |
|---|---|---|---|
| Foundry | `floor` | 0.1014 | 61 / **61.7** / 96 |
| Dunes | `sand` | 0.3818 | 185 / **185.0** / 185 |
| Depot — **before** | `asphalt` 0x24262b | 0.0194 | 3 / **4.4** / 10 |
| Depot — **after** | `asphalt` 0x474b53 | 0.0700 | 15 / **21.3** / 39 |

1188 samples across the nav grid, up-facing, sRGB decode through irradiance, Lambert, ACES and
exposure 1.25 — the same five multiplications the renderer performs. **The yard was a mean of
4.4 out of 255.** Four counts off black. The post-M8 note recording that the report came back
saying *"STILL pitch black"* was not an exaggeration; it was a reading.

**And the reason given for keeping it there is wrong**, which is worth writing down because it
survived two fixes. The old comment said a brighter ground would "flatten the pools into a
uniform grey". Albedo is a *multiplier*, so it cannot change the ratio between a mast pool and
the gap between two masts. Measured across the playable grid, that ratio is **2.60x on Depot**
before and after this change — against Foundry's 1.86x and Dunes' 1.00x, so Depot remains the
most pooled map in the game and by some distance the darkest. What flattens pools is *fill*,
which is added rather than multiplied, and fill is exactly what the two previous passes raised.

The first version of that ratio in the probe was wrong too, and it is a useful mistake: it
sampled "under a mast" against the world origin and reported 1.05x. The origin on Depot is six
metres from a mast. A ratio is only as good as the two places it was measured, so the probe takes
the extremes of the whole grid, which has no opinion.

**What this does not settle.** `MapLuminance` states its limits and they all point one way — no
shadowing, no baked vertex AO (whose floor is 0.32, so an enclosed corner is up to three times
darker than reported), no fog, no texture detail. Every number above is therefore an **upper
bound**, which is the direction that makes the *before* conclusive: a mean of 4.4 with the
sunniest possible assumptions is unarguable. It cannot be read backwards. Whether 21.3 is now
enough is a browser claim and it is on the list below with a screenshot, along with the honest
statement that if it is still dark the next lever is the irradiance floor — Depot's darkest floor
samples receive 0.705 against Foundry's 2.148, and at those samples the masts contribute nothing
at all.

### F2 — the bomb arrow, and where its boundary is

`MatchObjectives` opens by ruling out exactly this: objective markers are **world geometry, not
HUD markers**, because "a capture ring drawn on the HUD tells you a number, and a capture ring
drawn on the floor tells you where to stand". That argument is decisive for a capture ring and it
is not decisive here. For a bomb lying somewhere in a sixty-metre map that the round cannot start
without, *which way is it* is the entire question, and the world object answering it is a 0.3 m
box behind a container — which this same file already records as having been reported as
*"there is no physical bomb entity"*.

So route (a), an off-screen HUD indicator, and the rule in `MatchObjectives` is amended where it
was departed from rather than left contradicting the code.

**The intel filter is satisfied by construction, not by a check**, and the report's own wording
is what draws the line — *"the bomb **to pick up**"*:

| Bomb state | Arrow |
|---|---|
| `CARRIED`, `carrierId === -1` — on the floor, claimable | **yes.** A fixed public point that both sides already see blinking |
| `CARRIED`, `carrierId >= 0` | **no.** The bomb's position *is* a living player's position — `followCarrier` makes it true every tick so the mesh can ride its carrier, which is exactly what would make a HUD version a wallhack on whoever picked it up |
| `PLANTED` | **no.** The site is a world object with a ring and an accelerating light |

`readBombBearing` is the only source, it is written in the same pass that decides where the mesh
goes, and it is cleared every frame and re-asserted — so a pickup takes the arrow down on the
frame it happens rather than leaving it latched. There is no code path that can hand the HUD a
carried bomb's coordinates.

**One component, not two.** The brief named `showHitDirection`, which is the *transient* member
of this family — a chevron that fades over 1.1 s. The persistent member is `HudTactical`'s
grenade-threat arrow, which takes a world position, the player's position and yaw, and rotates a
ring-mounted element for as long as a condition holds. That is what a bomb marker is. Both are
`BearingIndicator` now, two instances rather than one element with two writers, because a grenade
can land beside the bomb you are running for. The bomb's arrow is deliberately calmer and further
out than the grenade's: one says *you are about to die* and the other says *the objective is that
way*, and a HUD that shouts both at the same volume has said nothing. It reads `--c-neutral`,
which is what an unclaimed objective is everywhere else in this game.

### F3 — the tag was a hologram because of its material

What made the dog tag read as a hologram was not its shape. It was one `MeshBasicMaterial` with
`toneMapped: false` shared by the plate and the chain, so the whole object was a flat fill of the
team colour that no light in the scene touched. A thing that does not respond to the light around
it is not in the world.

The plate and chain are lit steel now — one `MeshLambertMaterial` shared by all 24 pooled tags,
since none of them changes colour — with bevel strips that give a 16 mm plate visible thickness
at three metres, a 16-segment chain ring in place of the old 4-segment one that was a visible
square, and a bead at the clasp. It hangs off the chain on its own group and swings slightly out
of phase with the spin, which also fixes something the old one did: a flat card rotating about
its own axis presents zero area twice per revolution and flickered out of existence at those
angles.

**The colour moves to an emissive edge behind the plate**, and that is the part that needed
thinking about rather than re-skinning. Making the whole tag lit would have been the
honest-but-useless version: on Depot, at 21 counts out of 255, a steel plate on asphalt cannot be
seen, and Kill Confirmed is a mode built entirely on noticing these from across a room. The edge
keeps `toneMapped: false`, so the tag is exactly as findable as it was while the object in front
of it is solid, and friendly-to-deny stays one glance from enemy-to-confirm. Cosmetic only:
`check:cosmetics` is green, the snapshot is untouched, and nothing here goes near
`KillConfirmedConfig.pickupRadius`.

### Measured

Every number came out of a run in this session. **No protocol change** — nothing in P9 touches
the wire, so there is no version to bump and `netharness` has nothing new to exercise.

**`npm run readability`** — the new probe, and the source of every content number above.

| Probe | Result |
|---|---|
| Crosshair gaps, 12 weapons × 4 hip-fire states | **0 of 48** at the 3 px floor; AR family 18 / 22 / 16 / **26** px standing |
| Reticle opacity | hip **1.00**, half-ADS 0.32, full ADS **0.00** |
| Weapons offered the scope overlay | **2 of 12**; the other 10 must show a sight picture from their own geometry |
| Team colour, every (viewer, subject) pair | **0 violations of 12 pairs**, both seats, team modes and FFA |
| Depot's yard, before → after | **4.4 → 21.3** mean of 255, over 1188 samples |
| Depot pool-to-gap irradiance | **2.60x**, unchanged by the albedo (Foundry 1.86x, Dunes 1.00x) |

The team-colour half **exits non-zero on a violation**; the crosshair and lighting halves are
readings, because there is no threshold a human has agreed to and inventing one here would be the
magic number P0 bans.

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.** The regression control, and this
session is the one where it should be exact: everything above is presentation.

| | |
|---|---|
| Scores | **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5's baseline on the same seeds |
| Life-starts with partial grenade stock | **0** across all five (observed stock equals expected in every match) |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |
| Negative balances / kill-anchor resyncs | **0 / 0** |

**`npm run skirmish` — 3 headless clients, a real server, a real wire, shipped timings.** Also
presentation-only, so this is a control too: nothing here should have moved and nothing did.

| Probe | Result |
|---|---|
| The run | **FLOW CHECK PASSED** |
| Migrations | 3 of 3, **0 failed**; live roster 3H + 7B = 10, the mode's authored count |
| Mispredictions entering a live match | **0** (S8.9 requires 0); to the arena 0; spawn window 0 |
| Divergence checker | **0 / 7373** per client |
| Spectator invariants | 6620 selections while dead, **0 self / 0 enemy / 0 dead** |
| Quick loadout window | 10 079 ticks over 30 windows, **0 while alive** |
| Tab surviving `neutralise` while dead | 3280 of 6507 dead ticks; board open 3280 |
| Per-life grenade stock | 113 life-starts (24 human, 89 bot), **0 partial / 0 empty**, 274 held against 274 expected |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |

And one incidental confirmation that B12 was reachable exactly as reported: the server seated
**OP1 on team A, OP2 on team B, OP3 on team A**. The second human into a match is on the red
side, every time, which is `Match.smallerTeam` doing what it was written to do.

Unchanged and expected: `post-match hold: NOT EXERCISED` at shipped timings, for the reason the
B4 session recorded.

**`npm run leak` — 100 allocate/destroy cycles.** Subscriptions **29 -> 29 (+0)**, heap 12.73 ->
13.42 MiB (+0.69). **LEAK CHECK PASSED.** The baseline is P5's 29 unchanged: the two arrows are
pooled DOM owned by `HudTactical`, the tag pool is 24 groups built once per match, and nothing in
this session subscribes to anything.

**`npm run check`** and **`npm run build`** green — boundaries (294 files), the cosmetic audit
(19 snapshot fields) and the unlock audit all pass, and all three typecheck targets.

### What was not verified

Everything about how any of this looks. `HeadlessClient` builds no `ClientMatch`, no `Game` and
no DOM, and the preview pane never fires `requestAnimationFrame` — so of the five items here,
**four produce no harness number at all** and the fifth (F9) produces a number about arithmetic
rather than about a rendered frame.

That gap is the reason two of this session's five deliverables are instruments. What `readability`
buys is not a substitute for looking: it is that the next person to be told "the third map is
dark" can say by how much, in the units the eye uses, before touching a light.

Specifically unverified, and each was reasoned from the code:

- That the LONGBOW's sight picture is now clear. The geometry says the caps are gone and the
  glass is on the sight line; whether the aperture *reads* at ADS is pixels.
- That an open-ended tube looks right from outside at hip. Backface culling makes the interior
  invisible, which is the intent, but it is a claim about a rasteriser.
- That 21.3 / 255 is enough. See F9 above.
- That the dog tag is legible on Depot now that its body is lit.

### Needs a browser

- **B2, and it is the one to check first.** Equip `LONGBOW MK3` and aim. You must see *through*
  the scope — a clear tube with a small red dot on the sight line — rather than at a flat metal
  disc. Then aim a `KESTREL .338` and a `VANTAGE SR`: both must be exactly as they were, because
  their viewmodel is hidden before the overlay arrives and this change must be invisible on them.
  Then the M4 and the HALCYON, whose irons and red dot must be untouched.
- **B12, from the seat that has it.** You need to be the **second** human into a match, which is
  what puts you on team B. Your side must be on the **left**, in green, labelled ALLIES — on the
  scoreboard, on the score banner and on the end-of-match board. Your team-mates must be green in
  the killfeed and the enemy red. Then play an FFA: every other name in the feed must be hostile,
  including the half of the lobby that shares your substrate side, and the banner must read
  LEADER on the left and YOU on the right with your own number the friendly one.
- **F9, with a screenshot.** Vote Depot. Stand in the yard between two mast pools and photograph
  it; stand under a mast and photograph that. The pools must still read as pools — that is the
  claim the 2.60x ratio makes and the thing the previous fix was afraid of losing. If it is still
  too dark, the number to bring back is whether you can see a body against the asphalt at twenty
  metres, because that is what the next lever gets chosen against.
- **F2.** Play Search & Destroy as an attacker. At round start the arrow must point at the bomb
  and must go away the moment somebody picks it up — **watch for that specifically**, because an
  arrow that keeps tracking a carrier is the wallhack this design exists to avoid. It must not
  come back after a plant. Then get an enemy grenade thrown at you while the bomb is loose: two
  arrows, and they must be distinguishable at a glance.
- **F3.** Kill Confirmed. The tag must read as a solid object that catches the map's light and
  swings on its chain, and it must still be findable across a room — check that on Depot rather
  than Foundry, which is where it is hard.
- **The killfeed at its real size**, unchanged from P3's list and now also carrying B12's colours.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **`asphalt` is used by exactly one map**, which is what made raising it safe and local. It is
  also the only ground in the game whose base colour was chosen to be "correct for the material"
  rather than against the light it would sit under, and the comment that defended it was reasoning
  about a multiplier as though it were an addend. Worth keeping in mind for the next map: the
  question a ground colour has to answer is not *what colour is asphalt*, it is *what does this
  return under this map's light*.
- **`BotMesh` keys its bodies on the team letter too** — slate for A, sand for B — so which
  silhouette your side wears flips between matches. It is deliberate and documented as such
  ("neither team reading as the enemy by colour alone"), so it is *not* the B12 defect: those two
  colours are not the palette's friendly and hostile, and neither means "shoot this". Left,
  recorded, because it is the one remaining absolute team→appearance mapping in the client and
  the next person grepping for one will find it.
- **`WeaponModelSpec.optic` and `WeaponDef.scope` are two answers to "does this weapon have a
  scope"**, and B2 is what one disagreement between them cost. They are not merged here: one is a
  client-side model description and the other is shared simulation data, and merging them would
  put a rendering detail in `shared/` or a balance number in `client/`. What changed is that the
  disagreement is no longer *fatal* — every optic kind now builds a clear aperture, so a spec that
  says "scope" on a weapon the simulation does not scope is a cosmetic mismatch rather than a
  blind rifle. The next weapon to want a real scope still has to add both.
- **`DUNES` reads 185 / 185 / 185** — a perfectly flat floor, because it has no point lights at
  all. Not a defect (it is midday sun on open sand) and not this session's item, but it is the one
  map where the lighting has no spatial structure whatsoever, and it is worth knowing before
  anybody asks why it feels flat.
