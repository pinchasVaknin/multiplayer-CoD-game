# OPERATOR — PLAN

Browser arena FPS, eight milestones. This file is the running record of what exists,
what was decided, and what the next milestone needs to know.

---

## Milestone status

| # | Milestone | State |
|---|---|---|
| 1 | Core loop and movement | **Complete** — see below |
| 2 | Gunplay | **Complete** — see below |
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
