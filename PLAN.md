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
