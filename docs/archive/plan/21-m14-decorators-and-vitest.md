<!-- Moved verbatim from PLAN.md lines 517–855 at 6b1299e (2026-09-15). Part of the OPERATOR plan record; PLAN.md holds the index. -->

# Milestone 14 — decorators where a concern is written by hand, and a unit-test runner that shares the gate

Planned by the human on 2026-09-14 from two measured facts about the toolchain (TypeScript 7,
Vite 8 on rolldown + oxc, Node 24): **standard TC39 decorators do not run here** — oxc leaves
the `@name` line verbatim in the bundle at every `build.target` tried and Node rejects the
syntax — and **legacy decorators do** (`experimentalDecorators` plus `oxc.decorator.legacy`, a
proof build ran `step(21) = 42` through a method decorator). So this milestone is legacy
decorators, **class and method only, never a field** (a [[Define]] field shadows the
prototype under `useDefineForClassFields`), **never on the simulation tick** (S3: nothing
reached from `simulate`/`step`/`onTick`/`tick` in `shared/`, nor `shared/net` encode/decode,
`shared/player`, `shared/combat`, `shared/ai`), and only for a concern with three or more
hand-written sites that change together (S4). Tables stay tables (S5); the boundary check is
not edited (S6). Vitest is the one new devDependency (S2, amended); tests are co-located and
obey their partition (S7); the harnesses stay the integration instruments and a red test is a
finding, not something to fix in a harness (S8). Zero behaviour change throughout (S1): the
seeded harness and the content probe are byte-identical after every commit.

Four phases: **A** the runner and a first wave of characterisation tests; **B** the transform
seam proved in vitest, in `dist-server/` and in `dist/`, with one `@timed` on one debug method;
**C** the concerns, one commit each, evidence first (C1 timing, C2 subscription lifetime with
`npm run leak` as the gate, C3 the human's decision, C4 and C5 rejected with reasons); **D**
`check:decorators` in the gate, a Tests section in DEBUG.md, and this record. The human closed
Milestone 13 after Phase A and cancelled its Phase E outright; its record is
[20-m13-bodies-that-read.md](docs/archive/plan/20-m13-bodies-that-read.md).

## Phase A — done (session of 2026-09-14): vitest, and 109 characterisation tests

**The runner.** `vitest@5.0.0` (released 2026-09-03; peer range `^6 || ^7 || ^8`, so 4.1.11
would also have served — the human's call if the fresh major misbehaves). `vitest.config.ts`
stands alone and does not import `vite.config.ts`, whose `define.__SERVER_URL__`,
`optimizeDeps` and dev `server` blocks a test never wants; it already carries
`oxc: { decorator: { legacy: true } }` for Phase B. `test.include = ['src/**/*.test.ts']`,
`environment: 'node'`, `globals: false` — `describe/it/expect` are imported in every file, so
a `shared/` test typechecks under `tsconfig.shared.json` with no DOM lib and no globals, which
was verified rather than assumed. `npm test` is `vitest run`; `npm run test` sits in `check`
between `check:plan` and `typecheck` (decision 4, default taken). `vitest.config.ts` is
typechecked in the client partition beside `vite.config.ts`.

**The first wave.** Eleven files, one per module, all in `src/shared/`, green against the tree
as it is with no product code touched: `core/SimMath` (textbook values, the symmetries, the
one-ULP claim through `verifyAgainstNative`), `core/Rng` (same seed same sequence, adjacent
seeds diverge, seed 0 works, the state round-trip, `eventSeed`), `core/StateHash` (the FNV
offset basis, a known one-byte hash, `+0` and `-0` hash differently), `core/EventBus`
(dispatch order, unsubscribe-from-inside, subscribe-mid-dispatch, nested emit, `clear()`
inside a dispatch throws, and the process-wide live count returning to where it started),
`net/Wire` (every primitive round-trips, little-endian, clamping, UTF-8 outside ASCII, the
255-byte string cap, overflow and overrun without throwing, `raw()` copies), `net/Protocol`
(each quantiser an identity within half a step, `quantiseCommandInPlace` idempotent,
`rejectText` for every code), `meta/SaveData` (a hand-written v1 and v2 save reach
`SAVE_VERSION` with level and XP intact, the v1 audio-bus derivation, the v2 → v3 binding
repair applied exactly once, the synthetic v0 `verify/progression.js` uses), `modes/GameMode`
(`teamScoreWinCondition` over the same nine-pair grid `content.ts` prints, the six `COL_*`
over the same three fixed rows — the expected strings are the probe's own output),
`modes/MatchOutcome` (`wonBy`, places with the winner pinned, the ordinals, `isMvp`),
`world/maps/build` (the three `rotateHalf*` on two-element inputs, the pitched-brush refusal),
`core/Keybinds` (a `BindingMap` round-trips, every default resolves to its bit, ADS is
`Mouse2`, rebind steals, `normaliseBindings` restores a missing action's defaults).

**S7 worked on the first file.** `check-boundaries` refused `Math.sin` in `SimMath.test.ts`
— a test is a file in `shared/` like any other — so the comparison against the natives goes
through the `verifyAgainstNative` the module already exports. No exemption was added.

**One finding, characterised rather than fixed:** `simSin(-0)` returns `+0` where
`Math.sin(-0)` keeps `-0`. Harmless — `-0 === 0`, and nothing in the simulation branches on
the sign of a zero — so the test pins the current answer and the note is here.

**Measured:** `npm test` **109 cases in 11 files, 0.66 s** inside the runner (2.1 s wall with
start-up); `npm run check` green in **8.6 s** wall, ten audits + test + typecheck ×3. Seeded
harness normalised-identical to the run taken before Phase A (`t`, `pid`, `simMsMean`,
`heapMb` are wall-clock and differ between two runs on one tree; everything else is the seeded
outcome and did not). Content probe byte-identical. Commit `f064449`.

## Phase B — done (session of 2026-09-14): the seam, proved in four pipelines

**The switch.** `"experimentalDecorators": true` in `tsconfig.base.json`, with the comment
stating why the standard form is not an option here and what to revisit;
`oxc: { decorator: { legacy: true } }` in `vite.config.ts` and `vite.server.config.ts`
(`vitest.config.ts` had it since Phase A).

**The decorator.** `src/shared/core/Decorators.ts` exports `timed(label)`: a legacy method
decorator that reads `nowMs()` from `shared/core/Clock` before and after the call and reports
`"<label> <ms>ms"` at `info` through `logger('timed')` — after the call returns *or throws*,
with the value and the exception passing through untouched. Synchronous methods only; an
`async` method would be timed to its promise, not its work, and nothing needed that shape.
The file comment carries the three rules (methods and classes only, never the tick path, a
decorator replaces repetition and never adds behaviour).

**The one use, and a departure from the brief.** The brief asked for a method in
`src/server/debug/` or `src/client/debug/` "that today does the `const t = nowMs()` …
`nowMs() - t` dance by hand", exercised by `node dist-server/main.js --matches 1 --asap`.
Neither half exists in this tree: every hand-written pair in the debug folders either feeds a
report field (`SnagHarness.run`'s `wallSeconds`, `BotHarness`, `MatchHarness`) or times a
span inside a method (`HeadlessClient`'s build and reconnect windows), so a decorator that
logs would either change a report's fields or duplicate a measurement; and `main.ts` reaches
no `server/debug/` module at all — it imports the `shared/debug/` audits, which are functions.
So the use is **`ModePanel.measureLanes`** (`client/debug/ModePanel.ts`): private, one-shot,
not hot, behind the F1 overlay's *Measure lane timings* button and `__operator.laneReport()`,
with no timing of its own before — the decorator **adds one debug log line** there, which is
the smallest deviation available and is stated here so nobody reads it as a replacement. The
brief's counts for C1 are re-taken in Phase C with this in mind.

**Proved, four pipelines, one decorated method each:**

| Pipeline | Evidence |
|---|---|
| vitest (Vite transform, Node 24) | `Decorators.test.ts`: `step(21) = 42` through `@timed`, one `info` line `worker.step 21.00ms` on a fake clock; the method sits on the prototype, not the instance; a throw still logs. 4 cases |
| `vite build` (rolldown + oxc, client) | `dist/assets/index-*.js` carries `Ej([_j("ModePanel.measureLanes")],Dj.prototype,"measureLanes",null)` — `__decorate`, minified. **0** lines starting with `@identifier` across `dist/assets/*.js` |
| `vite build --config vite.server.config.ts` (SSR) | The repo's server config imported verbatim into a scratch config with only the entry and `outDir` swapped, over a scratch class decorated with the real `timed`: `__decorate([timed("proof.step")], Proof.prototype, "step", null)` in the output; `node` prints `[timed] proof.step 0.01ms` then `step(21) = 42`. **0** `@` lines across `dist-server/*.js` (which carry no decorator yet — C1/C2 will be the first) |
| `vite` dev server (oxc per-module transform, `vite.config.ts`) | `GET /src/client/debug/ModePanel.ts` returns `_decorate([timed("ModePanel.measureLanes")], ModePanel.prototype, "measureLanes", null)`, 0 `@` lines; in the pane (rAF suspended, `loop.frame` stepped by hand into a match) `__operator.laneReport()` printed **`[timed] ModePanel.measureLanes 2.70ms`** and returned six lane timings, no console error |

`node dist-server/main.js --matches 1 --asap` ran clean on the rebuilt bundle (seed 1: B wins
68-75, 16 777 ticks — the same outcome as the baseline's match 1).

**Gate:** `npm run check` green in 9.3 s (**113** tests); seeded harness normalised-identical
to the pre-Phase-A baseline; content probe byte-identical.

**Needs a browser (the human's):** the same button on a real display — F1, *Measure lane
timings*, `[timed] ModePanel.measureLanes …ms` in the console and nothing red beside it.

## Phase C — done (session of 2026-09-14): one concern built, four declined, each on a count

Every candidate was re-counted in this tree before anything was written, per S4. The counts
the brief carried (taken the same day) were a floor and are corrected below where they differ.

### C1 — `@timed`, generalised: **rejected, 0 replaceable sites**

The tree holds **34 elapsed-time subtractions in 24 files** (`nowMs() - t` or
`performance.now() - t`, tests and the clock modules excluded). Sorted by shape:

| Shape | Count | Where |
|---|---|---|
| Whole method, on the tick or frame path (S3) | 5 | `MatchInstance.step`, `StreakSystem.simulate`, `MatchEquipment.simulate`, `MatchMeta.simulate`, `Hud.update` — each writes `this.lastMs`/`lastStepMs` for `FrameStats` |
| Whole method, result feeds a report or a metric | 3 | `SnagHarness.run` → `report.wallSeconds`; `MapBakery.bakeAll` → `report.totalMs`; `Migration.move` → `MigrationRecord.durationMs` |
| Whole *function* (no class to decorate) | 3 | `buildMapChunked` (a generator), `bakeNavmesh` → `stats.bakeMs`, `hashRun`'s `main` |
| A span inside a method, or across two methods | 23 | `FrameLoop` (sim and render halves), `MapBuildQueue` (chunk, frame budget), `MapBakery` (collision, nav), `HeadlessClient` (build, summary hold, resync), `Server` (allocate, ready wait), `ServerLoop`, `main`'s pump, `skirmishHarness`'s first input, `MatchHarness`'s per-match loop, `BotHarness`'s start/report pair, `AiScheduler`'s begin/end, `LiveMatch`'s ready wait, `Hud`'s hit latency, `MapRender`'s AO |

A `@timed` that logs replaces a pair only where the method's whole body is the span *and* the
number goes nowhere but a log line. That count is **zero**: the five whole-method pairs that
could take it are the five the contract froze, and the three off the tick path put the number
into a report a harness prints and `__operator` returns. Replacing any of them changes the
fields a harness prints, which C1's own gate forbids. So `@timed` stays at its one Phase B use
and the twenty-odd spans stay hand-written — they are not repetition of one concern, they are
twenty different measurements. The brief's "20 pairs in 7 files, all in harness and debug
code" was an undercount of the pairs and an overcount of the ones a decorator can reach.

### C2 — subscription lifetime: **built, as a base class, 17 classes**

**The count.** 83 `bus.on(` calls and 75 `dispose()` methods in the tree; **17 classes** with
the exact shape — `private readonly unsubscribe: Array<() => void> = []`, filled by
`this.unsubscribe.push(bus.on(...))` in the constructor or a `subscribe()`, drained by the
two lines `for (const off of this.unsubscribe) off(); this.unsubscribe.length = 0;` in
`dispose()` — ten in `client/` (`DebugOverlay`, `MetaPanel`, `ModePanel`, `StreakPanel`,
`WeaponDebug`, `MatchEquipment`, `MatchFeedback`, `MatchObjectives`, `PerksRenderer`,
`MatchHud`), one in `server/` (`ServerMatch`), six in `shared/` (`BotDirector`,
`ScoreSystem`, `MatchLedger`, `MatchFlow`, `PerksRuntime`, `StreakSystem`). Sixteen drain
first and tear the rest down after; `StreakSystem` calls `endAll()` *before* draining. The
other holders of an unsubscriber keep one in a nullable field, and `EventCollector`
(`server/net`) returns its list to `ServerMatch` — different shapes, left alone.

**Decorator against mixin, both designed.** A `@disposable` class decorator would have to
wrap `dispose()` in one fixed order (so `StreakSystem` is out, or reordered — S1 says no),
could not type an `own()` without an interface merge on every class (so the list would be
reached through a field *name*), and is refused under `shared/combat` and `shared/ai` by
Phase D's check (so `ScoreSystem` and `BotDirector` are out): fourteen of seventeen at best,
none of them typed. **`abstract class Disposable`** in `shared/core/Disposable.ts` takes all
seventeen: a private `subscriptions` list, `protected own(...offs)` (variadic because `push`
was — `MatchLedger` takes its seven in one call), and `dispose()` that drains in order; a
subclass overrides `dispose()` with `override` (the compiler insists) and calls
`super.dispose()` exactly where its two drain lines were. Nothing on any tick changes: a
subclass's methods stay on its own prototype, `super()` runs once per instance, `own()` runs
at subscribe time. Neither form needs a flag or a field decorator; the mixin won on the three
counts above, and the milestone's decorator count therefore stays at one — which is the
brief's own rule working (*"choose the one that needs no flag and no field decorator"*, and
then the one that serves every site).

**The change.** 17 files: 17 `extends Disposable`, 17 `super()` calls, 17 field declarations
gone, 34 drain lines gone, 55 `push(` sites now `own(`, 10 `override dispose()` keeping their
own teardown, and 7 `dispose()` methods that were *only* the drain deleted outright (the
inherited one is identical). Net **−28 lines** across the seventeen; `Disposable.ts` is 60
lines, of which 45 are the comment that says why, and its test is three cases.

**Gate, all five instruments:** `npm run check` green (**116** tests); seeded harness
normalised-identical; content probe byte-identical; **`npm run leak`: 29 → 29 (+0) over 100
cycles, and the count at every sampled cycle (10, 20, … 100) identical to the pre-C2 run,
LEAK CHECK PASSED**; skirmish: the twelve invariant lines identical (migrations 3/0 failed,
worst mispredictions after migration 0, misrouted 0, WAITING-in-live 0, result surfaces in
the room 0, spectator self/enemy/dead 0/0/0, quick-loadout-while-alive 0, sentries on own
side 0, FLOW CHECK PASSED), and the flow event's `subscriptions: 79` the same in both runs.

### C3 — console commands by decorator: **not built (decision 3, default taken)**

`installConsoleApi` builds **one object literal with 83 top-level entries** (the brief's 72
undercounted the nested groups) and DEBUG.md's "Console API" documents it as a table. S5 is
explicit that a table stays a table, and a `@command('name', 'help')` that registered
entries by decoration would hide this one behind class scans. The human's default was to
leave it; left.

### C4 — per-module loggers: **rejected, wrong level**

**32 files** open with `const log = logger('tag')` at module scope; **zero** classes hold a
logger as a field. A decorator attaches to a class or a method and cannot reach a module-level
constant, so there is nothing for one to replace here. Recorded so nobody re-derives it.

### C5 — wire validation: **rejected, frozen path**

`server/net/Validation.ts` (one exported function, `validateCommand`) and `Session.ts` sit on
the receive path the contract froze (S3: `shared/net`, and the server's decode of it); a
wrapper per message is an allocation per message. Rejected without a count, because the count
does not matter there.

## Between phases — two reports from the multiplayer playtest (2026-09-15)

Raised by the human between Phases C and D, both from a networked session; both reproduced in
the pane against a local dedicated server on the unfixed tree, fixed, and measured again.

**The ballot outlived the socket** (`5bc40ac`). *"Quit a multiplayer match, start a solo one:
NEXT VOTE IN stays up with a clock of 447.4 s."* `VoteOverlay` is app-lifetime — one instance
on the UI host — and the arena's 4 Hz broadcast is its only writer; `onMigrated` hid it on a
move between instances, but `teardownWorld`, the session boundary, did not. So the last
`PLAY` broadcast stayed applied, and every frame `tick()` computed `(phaseEndsTick −
syncedServerTick()) × DT` with no session behind `syncedServerTick()`, which is zero: the
clock showed `phaseEndsTick / 60`, and 26 844 ticks is 447.4 s. **Measured before:** joined
the arena at `phaseEndsTick 3701`, quit, started solo — overlay visible, `NEXT VOTE IN 61.7`
(= 3701 / 60), `syncedTick 0`. **After:** `teardownWorld` calls `voteOverlay.hide()` under
`!keep` (a rotation or a reconnect is not a session exit, and a notice up during one must
survive it) — overlay hidden, `info: null`, in a solo match on Foundry and on Dunes.
`VoteOverlay` holds no bus subscription, so C2's `Disposable` has nothing to own there; the
session hook is the teardown, and it is the same rule `onMigrated` already applied.

**The pad that was never red** (`c03a37e`). *"Enemy markers on the server appear yellow
instead of red."* First suspected a team-state desync; it was not one — in the pane the
viewer context, every actor's team and the palette lookup were right (hostile `#e8604c`; a
first reading that said otherwise was a seat the vote cycle had already migrated into an SND
match, where team A *is* the viewer's). The pad was a `MeshStandardMaterial` at
`emissiveIntensity 3.0` with `toneMapped: false`: without tone mapping there is no headroom
above 1.0 per channel, so three times (0.80, 0.12, 0.07) linear clips red at 1.0 while green
and blue keep theirs, and the sun's diffuse adds on top. **Measured at the pad's centre,
before:** (255, 163, 132) on Foundry, (255, 178, 142) on Dunes — salmon, paler under the
brighter sun, for a palette of (232, 96, 76); the server's maps are the bright ones, which is
where it was noticed. The 3.0 had been chosen because 1.5 "read as paint on the sleeve", but
brighter than the palette's red is not a colour this pipeline can show — only a less red one.
**After:** an unlit `MeshBasicMaterial` at the hostile hex, `toneMapped: false` — nothing to
add, nothing to clip — (232, 96, 76) on Foundry and on three pads on Dunes. The halo is
still the glow, and a patch that holds one colour on a lit shoulder reads as a device rather
than as paint, which is what the 3.0 was reaching for.

Both fixes are client-only: `npm run check` green (116 tests), seeded harness
normalised-identical, content probe byte-identical. **Needs a browser:** the pad at the exact
palette red on a real display — decision 10 (too much at night?) is now a question about the
halo alone.

## Phase D — done (session of 2026-09-15): the fence, the two documents, and this record

**`scripts/check-decorators.mjs`, in the chain after `check:plan`.** Text over `src/` with
comments and string bodies blanked (the same stripper `check-boundaries` uses), a decorator
being `@name` with or without arguments at the start of a statement, and its target whatever
follows the stack — `class`, a method (an identifier before `(` or `<`), a field (an
identifier before `:`, `=`, `;`, `!`, `?` or a line end), or `accessor`. Three rules: a
decorated method named `simulate`, `step`, `onTick` or `tick` anywhere is refused; any
decorator under `shared/net`, `shared/player`, `shared/combat` or `shared/ai` is refused; a
decorated field or `accessor` is refused (the [[Define]] field shadows the prototype and the
decorator silently does nothing). Parameter decorators are not looked for and the header says
so. **Proved red before it joined:** three plants — `@timed` on `MatchInstance.step`, on the
field `ModePanel.laneCache`, and on `ScoreSystem.dispose` under `shared/combat` — produced
exactly three violations, each under its own rule, and the tree went green again on revert.
**Proved not to over-count:** `@param` and `@returns` in a doc comment, `'@notADecorator'` in
a string and `// @alsoNotOne` in a line comment planted together left the count at three
(the tree has no `@tag` doc comments of its own, so this had to be planted to be tested). On
the tree as it is: **3 decorator uses across 348 files** — `ModePanel.measureLanes` and the
two in `Decorators.test.ts`.

**S7 again.** The Phase B test decorated a toy `step(n)`, and the check refuses a decorated
`step` anywhere in `src/`, tests included. The method is now `double`; the rule has no
exemption. Same shape as `Math.sin` in `SimMath.test.ts` in Phase A.

**The documents.** DEBUG.md has a "Tests" section under a new `# M14` heading: `npm test`,
where tests live, the partition rule and the finding rule, in the two sentences the brief
asked for. README.md's "Debugging" points at it in one line, and its stale description of
`check` ("the target-boundary check, then a typecheck") now names the audits and the tests.
`check:flags` and `check:plan` green.

## Measured, this session

| What | Number |
|---|---|
| `npm test` | **116 cases, 13 files**, 0.76 s in the runner, 2.4 s wall with start-up |
| `npm run check` | green, **11 audits + test + typecheck ×3, 10.5 s** wall (8.6 s at Phase A) |
| Decorator uses in the tree | **3** across 348 files: one product (`ModePanel.measureLanes`), two in its test |
| C1, elapsed-time pairs | 34 subtractions in 24 files; **0** replaceable by a logging `@timed` (5 on the tick path, 3 feeding reports, 3 functions, 23 spans) |
| C2, the subscription shape | **17 classes** (10 client, 1 server, 6 shared) onto `Disposable`; 55 `push(` → `own(`; **−28 lines net** across the 17; 7 `dispose()` methods deleted outright |
| C3 / C4 / C5 | 83 console entries in one literal (table stays); 32 module-level loggers, 0 class-level; the receive path — all declined |
| Sites left hand-written, and why | every C1 span (a report field or a span inside a method, not one concern); `EventCollector`'s returned list and the single-unsubscriber fields (a different shape); the 32 loggers (module level) |
| `npm run leak`, C2 | 29 → 29 (+0) over 100 cycles, every sampled cycle identical to the pre-C2 run |
| Skirmish, C2 | 12 invariant lines identical; flow event `subscriptions: 79` in both |
| Seeded harness | normalised-identical to the pre-Phase-A baseline after every commit (`t`, `pid`, `simMsMean`, `heapMb` are wall-clock and stripped; everything else is the seeded outcome) |
| Content probe | byte-identical after every commit |
| Whole milestone, `src/` | 34 files, +1 655 / −165 (the +1 655 is 13 test files, `Decorators.ts` at 64 lines, `Disposable.ts` at 58) |
| Between phases | vote overlay: 61.7 s on the unfixed tree (= 3 701 / 60) → hidden, `info: null`; pad centre: (255, 163, 132) Foundry / (255, 178, 142) Dunes → **(232, 96, 76)** on both |

## Needs a browser

Two things, both the human's, both one action on a real display:

- **Phase B's button.** F1 → *Measure lane timings* → `[timed] ModePanel.measureLanes …ms` in
  the console and nothing red beside it. Seen in the pane (`2.70ms`); not yet on a display.
- **The pad at the palette's red.** It is now exactly `#e8604c` in every light, unlit, with the
  halo as the glow. Whether that reads as a device on a sunlit shoulder at play speed, and
  whether the halo alone is "too much at night" (decision 10, which is now about the halo
  only), is a display question.

## Decisions waiting on the human

| # | Decision | Recommendation |
|---|---|---|
| 1 | ~~Accept legacy decorators, fields excluded?~~ **Taken (Phase B):** `experimentalDecorators` + `oxc.decorator.legacy`, proved in four pipelines; the TC39 form ships verbatim and Node rejects it. Revisit when oxc's `DecoratorOptions` grows past `legacy` and `emitDecoratorMetadata` | — |
| 2 | ~~S2 amended for vitest only; no jsdom?~~ **Taken (Phase A):** `vitest@5.0.0` is the one addition; client tests cover pure functions only. 4.1.11 carries the same peer range if the fresh major misbehaves | — |
| 3 | ~~C3, console commands by decorator?~~ **Default taken (Phase C):** the table stays; 83 entries in one literal that DEBUG.md documents as a table (S5) | — |
| 4 | ~~`npm test` inside `check`?~~ **Default taken (Phase A):** yes, before the typechecks; the deploy host runs 116 tests on every build | — |
| 5 | **The milestone ends with one decorator.** C2, the primary target, went to a base class on the brief's own tie-breaker, and C1 fell to zero on the count. Keep `@timed` as the seam's proof of life (its one use adds a debug log line), or remove it and keep only the transform switch and the fence for the next concern that qualifies? | Keep it. It is the working example the fence is written against, its test is the seam's regression test, and the human already said so at Phase B |
| 6 | `simSin(-0)` returns `+0` where `Math.sin(-0)` keeps `-0` (Phase A finding). Match the native, or leave it? | Leave it. `-0 === 0`, nothing in the simulation branches on the sign of a zero, and a change moves a value the cross-runtime hash covers for no gameplay reason |
| 7 | Decision 10 of M13, restated: the pad is now the palette's red exactly; is the **halo** (14 cm, alpha 0.55, additive) right by day and by night? | Playtest; one constant each in `ActorIndicator` |

## Dependency order

1. **Phase A** — the runner. Nothing depends on the tree; everything after depends on it.
2. **Phase B** — the seam, proved before any concern was built on it.
3. **Phase C** — C2 first (the primary target, and `leak` was already the instrument for it); C1 on its count; C3–C5 on theirs.
4. **Phase D** — the fence last, because its rules were written against what C actually did.
5. **M12's content**, in M12's order — unchanged by anything here.

## How to start — the next brief

Milestone 14 is at its gate; the human closes it. The tree a fresh session inherits: vitest in
`check` (116 tests, co-located, partitioned), legacy decorators lowered in every pipeline with
`check:decorators` fencing the tick path and fields, one `@timed`, one `Disposable` base under
seventeen classes, and the two playtest reports above fixed. The next concern that qualifies
under S4 — three hand-written sites that change together, off the tick path, no flag — gets a
decorator or a base class on the same comparison C2 recorded, and the fence already knows
where it may not go.
