<!-- Moved verbatim from PLAN.md lines 3132–3381 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# Post-M8, round 4 — the jitter, found

Four items: three regressions round 3 introduced, and the jitter that had survived three
rounds. They turn out to be two facts.

## The jitter was a five-millimetre bounce, and it was in the collision resolver

Rounds 2 and 3 answered "structures jitter when you get close" with a 24-bit depth buffer, two
near-plane changes, a coincident-face sweep across four maps and a step-up rewrite. None of it
touched the cause, because none of it asked the first question: **what does the camera do when
the player is standing perfectly still?**

Measured, on flat ground, no input:

```
  y: 5.00  0.00  5.00  0.00  0.00  0.00  5.00  0.00   mm
```

A five-millimetre vertical limit cycle at twenty-odd hertz — exactly `collisionSkin`. Gravity
was applied on every tick regardless of being grounded, driving the capsule 2.7 mm into the
floor; `resolve` pushed it back out by `depth + skin`, which overshoots to 5 mm *above* the
floor; from there nothing is touching, so the next tick finds no contact and `groundSnap` pulls
it back down. Forever.

Five millimetres is nothing at arm's length and 0.82° of pitch against a wall 0.35 m away —
about ten pixels of judder at this FOV. **That is why the report always said "up close"**: the
bounce is everywhere, and you can only see it when something is near enough to reference it
against. Every previous round went looking for a rendering bug because the symptom looked like
one.

The same accumulation was the ice-slide. `projectVelocity` removes the component of velocity
going *into* a surface and correctly leaves the tangential part, so on a slope gravity's
downhill component built up every tick until friction balanced it: 292 mm of creep in three
seconds on 18°, 766 mm on 44°. And it was the missing 5% on ramp ascent.

One wrong assumption behind all three: that a player standing on the floor is falling. Gravity
now resumes the moment the ground stops being there, and `groundSnapDist` keeps the player
attached over crests and down slopes, which is the job it already had.

## The near plane was geometry, not taste

Round 3 raised it to a constant 0.20 m and put a grey wedge through the world at the edge of
the screen. The mistake: the capsule radius bounds how close the eye gets to a wall **along the
wall's normal**, and the near plane clips on **view-space depth**. A point on that wall at the
corner of the screen sits at `clearance · cos(halfHorizontalFov)`, which is much less:

```
                                    hFOV    min view depth
  90 FOV, 16:9 (the default)        121°       0.159 m     <- 0.20 clipped
  90 + tac sprint + slide           140°       0.111 m     <- 0.12 clips too
  FOV 120, 16:9                     144°       0.100 m
  FOV 120 + adds, 21:9              164°       0.045 m
```

So reverting to 0.12 fixes the screenshot and leaves the same bug latent for anyone who slides,
tac-sprints or plays wide — which is not a fix, it is the fix that has now come back twice. It
is derived instead, from the FOV, the aspect and the capsule radius, and recomputed wherever
any of them changes. At the shipped defaults it evaluates to 0.118, which is the 0.12 the
report asked for; it only ever goes down from there.

## The knife had no arm, and then had one aimed backwards

Moving the poses into frame in round 3 made the *stump* visible: at the old `READY` the fist
had been sitting on the camera, so nobody ever saw where the wrist ended.

A forearm cannot be a child of the knife — the knife yaws through 100° across the swing and a
rigidly attached arm would swing with it. An arm connects two points, so it is built one unit
long down -Z and then aimed and stretched between a fixed shoulder and the fist each frame. The
shoulder is *behind the camera*, so the elbow end is always outside the near plane and the arm
runs off the bottom-right of frame with no visible end.

The first implementation used `Object3D.lookAt`, and the measurement caught it: `lookAt`
resolves against `matrixWorld` and treats its argument as a **world** position, while these are
viewmodel-local coordinates on an object parented to a moving camera. It aimed the arm at
exactly 180° from the fist — the wrist landed twice the arm's length from the hand.
`setFromUnitVectors` asks the question in the space the numbers are actually in, and the wrist
now lands on the fist to within 0 mm at every point of the swing.

## Verification

Typecheck and production build clean. Headless harness against the real modules, plus live
`__operator` reads in a running match.

| Claim | Measured |
|---|---|
| Standing still, flat floor | y peak-to-peak **5.00 mm -> 0.00 mm** |
| Standing still, against a wall | 5.00 mm -> 0.00 mm |
| Standing still, on an 18° ramp | 31.1 mm -> 0.00 mm, horizontal drift 95.9 -> 0.0 mm/s |
| Ice-slide, 10 / 18 / 30 / 44° | 159 / 292 / 520 / 766 mm in 3 s -> **0 mm at every angle** |
| Ramp ascent | 4.38 -> **4.66 m/s** surface speed (flat reference 4.60) |
| Jump apex | 0.902 m against `jumpHeight` 0.95 — unchanged, the jump tick is guarded |
| Fall from 6 m | 0.82 s against a free-fall ideal of 0.82 s; `justLanded` fires |
| Walking off a 0.3 m ledge | 0 airborne ticks, stays glued |
| Steps | 0.30 / 0.55 / 0.70 m clear, 0.75 refused — unchanged |
| Unwalkable 60° slope | still slides 2041 mm — steep ground is still not standable |
| Near plane, derived | 4:3 0.120, 16:9 0.118, 21:9 0.094; 12-106 mm of margin in every case |
| Near plane vs the limit | safe at 90, 101, 114, 120 and 144 vertical FOV, 16:9 and 21:9 |
| Knife arm | wrist lands on the fist to **0 mm** across the swing; arm 64.5-89.7 cm; elbow at z +0.28, always behind the camera |

## Left for the human

1. **The jitter, on a screen.** It is a measured zero now rather than an argument, but the
   pane still does not composite here so it has not been *seen* still.
2. **Whether zero slide is right.** The player no longer slides on any walkable slope, up to
   `maxSlopeDeg` 46°. That is the usual choice for a shooter and it is a choice; if a steep
   ramp should shed you, it wants an explicit slide-above-N-degrees rule rather than a return
   to accumulating gravity.
3. **The shoulder anchor.** `KNIFE_SHOULDER` at (0.30, -0.45, 0.28) is where the arm appears
   to come from. It is a look, and it is one number to move.

---

## Roadmap update — post-M8

**Survival mode is cancelled.** It was flagged in the M8 brief for a scoped estimate and a
recommendation. The decision is not to build it. It is removed permanently — not deferred, not
backlogged. Nothing in M1–M8 depends on it. Do not scope, estimate or reference it again.

**The game moves to a dedicated external server.** No listen server, no host player, nobody's
desktop load-bearing. This makes NAT traversal, port forwarding and host migration non-problems: they
are not solved, they cease to exist. It also imposes a structural change that is the dominant cost of
the whole transition — the simulation must run with no renderer, which means the codebase splits by
target before any socket is opened.

The project extends from eight milestones to eleven.

---

## Milestone 9 — Headless Server Split

**Goal**: the authoritative simulation runs in Node with no browser. **No networking whatsoever.**

**Gate**: a full 10-bot TDM match runs to completion in Node with no browser open, *and* the browser
build still plays exactly as it did at M8. Both, or the milestone is not done.

**Phases**

1. **Audit.** Inventory every browser dependency in what will become `shared/` — non-math Three.js
   imports, `window`, `document`, `localStorage`, `performance.now()`, `AudioContext`,
   `CanvasTexture`, and anywhere simulation state and render state are the same object. Report before
   moving code. This inventory is the real scope of the milestone.
2. **Partition** into `shared/` / `client/` / `server/`. Known split points: `MapLoader` (collision
   and nav shared, mesh building client), entity transforms holding `THREE.Object3D`, `SaveStore`
   (client) versus progression rules (shared), bots (shared).
3. **Boundary enforcement in CI.** A dependency check that fails the build on a `shared/ -> client/`
   import. Demonstrated by deliberately breaking it.
4. **Server process.** Drift-corrected fixed 60 Hz loop — Node timers drift and `setInterval(fn,16)`
   is not 60 Hz. Match instance, `npm run server`, structured logging.
5. **Client unchanged in feel.** It becomes a presentation layer over shared code. Config numbers
   live in `shared/` and are never duplicated client-side.
6. **Cross-runtime determinism.** The same fixed command sequence produces identical per-tick state
   hashes in Node and in the browser. Apply per-event RNG seeding here, not in M10.

---

## Milestone 10 — Netcode Foundation

**Goal**: two humans connected to the **deployed external server**, on Foundry, in TDM, moving and
shooting with hit registration that feels the way single-player feels. No front end for joining, no
other modes, no
other maps, no killstreaks.

**Phases**

1. **Architecture reckoning.** Read `INetworkTransport` — it has only ever been a pass-through and
   probably will not survive contact. Report before writing replication code. Use the code's actual
   class names, not the briefs'.
2. **Protocol and session.** WebSocket, `wss://`, handshake, protocol version check, entity
   assignment, full snapshot then deltas, clean and unclean disconnect. Hardening from the first line.
3. **Server-side match.** Full `InputCommand` structs, buffered and applied in `seq` order, with gaps
   filled by repeating the last command. Boundary validation — clamps and rate limits, not heuristics.
4. **Client prediction and reconciliation.** `PlayerController.step` pure. Unacked ring buffer, ack by
   `seq`, replay on mismatch, corrections smoothed over several ticks.
5. **Hit registration with rewind.** 60-tick hitbox history, rewind to shooter view time, capped at
   200 ms, resolving through the existing shared `DamageSystem`. Lag compensation belongs here, with
   hit registration — they are one system.
6. **Snapshots and remote players.** Binary delta at 20–30 Hz, decoupled from the 60 Hz sim. Remotes
   interpolated ~100 ms in the past. Remote humans reuse the M3 bot visual representation.
7. **Deployment.** The server actually runs on the external host, under a process manager, with TLS
   and environment configuration. Real measured RTT reported — it is the baseline for every later
   number.
8. **Instrumentation.** Network condition simulator first, layered on top of real RTT. Then network,
   prediction and rewind panels, and server metrics.

**Gate**: two humans and eight bots play TDM to completion against the deployed server at +150 ms
simulated latency. TTK measured single-player and networked is identical. The headless harness runs.

---

## Milestone 11 — Multiplayer Completion

**Goal**: everything else, on a proven foundation.

**Phases**

1. **~~Lobby.~~ Superseded — see "Milestone 11 — Skirmish Multiplayer Flow" below.** The V1 draft
   specified a lobby with a server-side roster, team select and a map/mode chooser. It is
   discarded in full: the shipped flow has no lobby, no queue and no ready-up, because a static
   screen between the menu and the match is the thing the design exists to remove. A player
   clicking Play Multiplayer is shooting in a permanent warmup arena within one round trip, and
   votes on what to play next while already playing.
2. **All five modes.** Every timer and every piece of objective state server-owned. S&D is the hard
   one: round state, bomb timer, interruptible plant/defuse, networked spectator flow, side swap.
3. **All six killstreaks.** Ghost filtered server-side — a Ghost player's position never enters an
   enemy client's snapshot. Chopper Gunner tested against disconnect, death, match end and server
   restart.
4. **Projectiles.** Grenades predicted by the thrower, authoritative on the server, reconciled without
   visible teleporting. Smoke occludes server-side bot perception.
5. **Effects, audio, progression.** Cosmetics audited out of every snapshot. Audio resolved
   per-listener. XP awarded server-side, persisted client-side — with the client-side-save caveat
   documented in `README.md` rather than left as a surprise.
6. **Lifecycle.** Server restart handling, 30 s reconnect window, input timeout, cheap idle with zero
   clients. Everything degrades toward "the match continues."
7. **Soak and hardening.** 12-hour run under the multi-client harness. Hardening probes re-run
   against every new message type.

**Gate**: every mode plays to completion against the deployed server at 100 ms ± 30 ms jitter with 2%
loss, the divergence checker reports zero mismatches in all five modes, and the 12-hour soak is clean.

---

## Locked decisions — carried verbatim in all three briefs

- **Dedicated headless Node server.** No host player, no listen server. Every player is a client.
  NAT traversal, port forwarding and host migration are out of the problem space.
- **One match instance per server process, 10 clients.** The instance is a class so more become
  possible later; do not build that now.
- **Code partitioned by target**, boundary enforced in CI. `shared/` may import Three.js math classes
  only — rewriting the vector maths across eight milestones of working code is a large refactor with
  real regression risk and no benefit.
- **Config is shared and singular.** The client never holds its own copy of a gameplay number.
- **Drift-corrected server loop.** Node timers are not 60 Hz on their own.
- **Server tick is the clock.** Clients derive tick number from a synced clock and never increment
  locally — §4.1's "discard the remainder" rule would desync them permanently.
- **Client prediction is mandatory.** Local player predicted, remotes interpolated. Two code paths.
- **Snapshot rate decoupled from tick rate** — 60 Hz sim, 20–30 Hz binary delta snapshots.
- **Rewind capped at 200 ms.** Peeker's advantage is a *consequence* of lag compensation, not a
  defect. Bound it; do not eliminate it. Rubberbanding is a reconciliation artifact, fixed by
  smoothing how corrections apply.
- **Per-event RNG seeding**, so replayed ticks reproduce exactly.
- **Authority split**: position, health, ammo, objectives, scores and streaks server-owned. Decals,
  tracers, particles, viewmodel, camera shake, screen effects, HUD and audio playback client-only,
  driven by replicated events.
- **Bots stay, on the server**, producing `InputCommand`s into the same pipeline as remote humans.
- **The client is fully untrusted.** Boundary validation and authority are the whole defence. No
  heuristic anti-cheat. Malformed input must never crash the process — that is now a DoS vector.
- **No accounts, no server database.** Progression stays client-side, with the consequence documented.

---

