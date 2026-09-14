<!-- Moved verbatim from PLAN.md lines 898–1250 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
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

