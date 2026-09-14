<!-- Moved verbatim from PLAN.md lines 3382–3880 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
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
[`shared/core/SimMath.ts`](../../../src/shared/core/SimMath.ts), and the boundary check enforces it.
Had this reached M10 it would have presented as unreproducible reconciliation errors with two
plausible homes.

## Phase 1 — the audit

Full inventory in [`docs/M9-AUDIT.md`](../../M9-AUDIT.md). The headline was that the codebase
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

