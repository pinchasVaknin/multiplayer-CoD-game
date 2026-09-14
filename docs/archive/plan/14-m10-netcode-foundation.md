<!-- Moved verbatim from PLAN.md lines 3881–4475 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
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

