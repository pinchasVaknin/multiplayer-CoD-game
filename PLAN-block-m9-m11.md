# PLAN.md — block to append after M8

> Paste this into `PLAN.md` in the Claude Code session once `m8-hotfixes` is merged.
> Phase definition only; the full briefs are `M9-headless-server-split.md`,
> `M10-netcode-foundation.md` and `M11-multiplayer-completion.md`.

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
shooting with hit registration that feels the way single-player feels. No lobby, no other modes, no
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

1. **Lobby.** Server-side roster, team select and balance, map and mode selection with a documented
   chooser, bot fill with difficulty, late-join rules per mode, return-to-lobby after summary.
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
