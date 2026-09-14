<!-- Moved verbatim from PLAN.md lines 2289–2584 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
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

