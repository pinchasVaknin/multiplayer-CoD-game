<!-- Moved verbatim from PLAN.md lines 4579–4873 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
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

   **§6.3 is amended at playtest round 4 (F7), and this is the amendment.** The clause read
   *"free-for-all rules with damage live and instant respawn ... killing and being killed
   carries no consequence beyond the respawn"*. It now reads: **free-for-all rules with damage
   live; no score, no win condition, no match timer; nobody in the room can be killed; and the
   room records nothing.** The respawn is gone from the clause because there is nothing left to
   respawn from. What is *not* amended is "damage live": the range's boards still take damage,
   still drop and still time a kill, and the bots still shoot at you. See "the waiting room, and
   two facts that were one flag" below for the implementation and for why the two limits in
   `FFA_WARMUP_CONFIG` were never what enforced any of it.
3. **§6.7's "warmup is always the entry point" is amended at playtest round 4 (F8), and this is
   the amendment.** The clause read *"a player who joins the server while a live match is
   running goes to the warmup arena, not into the match, and joins at the next cycle. Warmup is
   always the entry point."* It now reads: **a connection is seated in the live match when one
   is `RUNNING` and has room, and in the warmup arena otherwise — which is every other moment of
   the cycle, and is still where a refused seat lands.** A returning player with a live
   reservation goes back to the seat they left, in the instance they left it in.

   What the old rule bought was a single seating path. What it cost is the whole of F8: a player
   who dropped out of a five-minute match spent the rest of it watching a ballot, and so did
   anybody who arrived while a match was on. The piece that made the arena the safe entry
   point — §6.5's background map build — turns out to be about *migration* rather than about
   joining: a fresh connection has built nothing either way, and `handshake` already learns the
   map before a world exists, so a direct join is the arena's own path with a different `mapId`.
   `READY_WAIT` is deliberately excluded; see "the seat a disconnect used to take with it" below.
4. **A `VotePhase.IDLE` that is not in the brief's table.** §4.20 requires the cycle to cancel
   when every human leaves; an arena with nobody in it is not in a phase of a countdown.
5. **The instance panel is split across two places.** §7 wants both instances side by side with
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

