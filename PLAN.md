# OPERATOR — PLAN

Browser arena FPS, eight milestones. This file is the running record of what exists,
what was decided, and what the next milestone needs to know.

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
