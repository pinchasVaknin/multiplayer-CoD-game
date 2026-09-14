<!-- Moved verbatim from PLAN.md lines 645–897 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
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

