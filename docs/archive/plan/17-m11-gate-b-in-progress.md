<!-- Moved verbatim from PLAN.md lines 4874–5210 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# M11 Gate B — in progress

**Gate A is sealed. Gate B is part-done.** Six commits on
`gate-b/objective-replication` beyond the objective-replication groundwork:
`2064b32` mode state · `0b8a4b7` bot replacement · `1740c6c` streaks server-side ·
`f33d7d1` streaks on the wire and Ghost · `65c8adb` Chopper case 4 · `9ac32a6` server-side
equipment · `b778e76` grenades on the wire · `a596ed7` the divergence checker ·
`b38202c` the cosmetic audit · `7546671` the networked spectator. Everything below is measured, not asserted; where
something is unverified it says so.

## The one root cause behind most of it

`MatchFlow.simulate` is skipped on a networked client (`ClientMatch` guards it with
`!isNetworked`), and **every piece of mode state is advanced from it** — `mode.onTick`,
`mode.onKill`, the plant timer, the fuse, the capture recount. The v4 objective channel fixed
the symptom for Domination's flags and left the identical hole open everywhere else.

The three modes failed differently, and the difference is the useful part:

| Mode | What a networked client actually had |
|---|---|
| Domination | Flags **stale** — replicated at v4 |
| Kill Confirmed | Tag list permanently **empty**; nothing dropped, collected or expired |
| Search & Destroy | Fuse **stopped**, holding its constructed value all round |

A stale value looks like a bug. An empty list and a frozen number look like a feature nobody
has got to yet, which is why neither was ever reported.

## What was built

**Protocol v5** — `MsgS.Tags` and `MsgS.Bomb`, alongside v4's `Objectives`.

**The seam is on `GameMode`**, beside `objectiveZones`, so the server asks any mode for its
state without importing the concrete classes:

- `dogTags: readonly TagInfo[] | null` — **`null` and `[]` differ deliberately.** `null` is
  "this mode has no such thing" and sends nothing; `[]` is "none right now" and must still be
  sent, or a client never learns the last tag was collected. Zones may skip on empty because a
  zone list is fixed at construction; a tag list is not.
- `bombInfo: BombInfo | null` — returns **one object the mode mutates**, never a literal. It is
  read on the snapshot cadence from inside the tick and §4.7 allows no allocation there.

## Three pieces of wiring that never crossed to the server at M9

This is the milestone's real finding, and all three have one shape: the fact moved to the
server, the code around it stayed in `ClientMatch`, where it kept working for single-player and
proved nothing about the half that had moved. It is the standing authority-migration failure,
three times over.

1. **`ServerMatch` never set `bots.objectives`.** `ClientMatch` has since M7. So
   `BotDirector.objectives` was null in every networked match and `ObjectiveIntent` had nothing
   to ask: server-side bots pursued no flag, chased no dog tag and never walked onto the bomb.
   Since a bot's whole interaction vocabulary is `onArrived`, **no S&D round played over the
   network could be decided by a plant.** Rounds still ended, on elimination and the clock, so
   nothing crashed and nothing logged.
2. **The Use key had no server-side reader.** Pick up, plant, defuse and cancel lived only in
   `ClientMatch.stepBombInteraction`. Between this and (1), *nobody* in a networked S&D could
   touch the bomb. `ServerMatch.stepBombInteractions` is the authoritative port, run before the
   flow so a plant that starts and completes on one tick resolves identically on both runtimes;
   the client's copy is now behind `!isNetworked` so it is not a second authority.
3. **No round reset for humans.** `ClientMatch` respawns everybody on `EV.RoundStarted`;
   `ServerMatch` did not, and there is no other route home because `maybeRespawn` gates on
   `respawnAllowed`, which in a one-life mode is false by construction (`0 < 0`). **A human who
   died in round one of a networked S&D was dead for the rest of the match** — able to look
   around, unable to move. Bots were unaffected, which is why nothing logged.

## Two single-player assumptions that do not survive N players

- `SearchAndDestroy.manualPickupId` (one id) became `manualPickup(id)` (a predicate). One id is
  exactly right for a browser and silently wrong on a server, where every human past the first
  would have collected the bomb by walking over it.
- `StreakSystem.localId` became `reportProgressTo(id)`, and `simulate(tick, cmd)` became a
  per-streak `commandFor(id)`. The old signature flew whichever chopper matched `localId` off
  the single command it was handed — on a server, two gunners would have shared one stick.

Both are the same shape and worth looking for elsewhere.

## Bot replacement (§6.7, §8.27)

`removeBotForSeat` and `replacePlayerWithBot` existed with **no call sites** — the handover's
own "implemented but not verified usually means unreachable" trap. A live match spawns the
mode's full authored roster before anybody migrates in, so every seat granted afterwards has to
take a bot with it; it did not, and three humans in a ten-bot TDM made it thirteen bodies.

`unseat` gained a **cause**, because only the caller can tell a departure from a migration:

- `'disconnected'` from a RUNNING match leaves a bot behind (in S&D the last human on a side
  dropping out ends the round for everybody, scored as an elimination nobody achieved).
- `'migrated'` does not — same player, one instance over, same synchronous call. Treating it as
  a departure would add a bot every cycle and turn §8.13's flat hundred into a staircase.

Mid-round joins are blocked while the flow is `LIVE` and deliberately **not** during `WARMUP`,
which is the 3-2-1 every migrating player arrives during; blocking there would hold the whole
lobby out of round one.

## Measured

Loopback, shortened timings where noted. Every probe was watched red first, and in three cases
the red state was the real shipped bug rather than a synthetic one.

| Probe | Before | After |
|---|---|---|
| KC tags | channel did not exist | **1260 upd / 29 distinct / 10 on the floor at peak**, match to completion |
| S&D bomb | `867 upd / fuse ticked 0 / 0 interact` — replicated and constant | **1590 upd / fuse ticked 899 / 100 interact / planted+exploded** |
| TDM roster | 3H+10B=13 | **3H+7B=10**, the mode's authored count |
| FFA roster | — | **3H+5B=8**, tracks the mode rather than a constant |
| S&D deaths per client | at most 1 for the whole match | **2** — impossible in a one-life mode without the reset |
| Leak, 12 cycles | — | subscriptions **26 to 26 (+0)**, heap +0.26 MiB |
| Regression, 5 matches | — | 5/5 complete, **scores identical on the same seeds** |
| Mispredictions into live | 0 | **0**, every run |

The subscription baseline moved 21 to 26 because the permanent arena now holds a `StreakSystem`
too. The number that matters is the **delta across cycles**, which is 0.

## Killstreaks, end to end (protocol v6)

Commits `1740c6c` (server-side system), `f33d7d1` (the wire and Ghost), `65c8adb`
(Chopper case 4).

**`MsgC.Streak`** is a request, not an instruction. §4.16 makes the client untrusted, so all
three things it could lie about are answered from server state: *which instance* (the router),
*whether they hold it* (`activate` returns null otherwise), and *where it lands* (the server's
copy of the player's position). The only client-chosen coordinates are the mortar's mark.

**`MsgS.Streaks`** is the first genuinely **per-recipient** message in the protocol, and it has
to be:

| Part | Scope | Why |
|---|---|---|
| Entity list | Common | A sentry is a physical object both teams see and shoot |
| Earn state | Per player | What you have earned is yours |
| UAV contacts | Per team | Broadcasting them puts a UAV's value in the untrusted half |

**Ghost is inside the intel filter, not beside it.** §8.22 says *"show a Ghost player's position
absent from the snapshot sent to enemy clients"*, and the obvious implementation of that
sentence is wrong: removing the entity makes the **body** invisible, which is not what Ghost
does. `Uav.onTick` already declines to record a contact for anyone failing `visibleToUav`, so
the perk works by never entering the intel list — and `buildEntities` is untouched, so the
player still renders and still dies.

Client side: a networked match **no longer simulates its own `StreakSystem`**. That would put a
second sentry, with its own aim and its own damage, on top of the one the server resolves shots
against — the Domination flag bug with a trigger. `ReplicatedStreaks` holds the server's answer;
the HUD, minimap and renderer each read it through one accessor. Cleared on migration.

Two single-player shapes had to be generalised: `localId: number` became
`reportProgressTo(id)`, and `simulate(tick, cmd)` became a per-streak `commandFor(id)` — the old
signature flew whichever chopper matched `localId` off the one command it was handed, so two
gunners on a server would have shared one stick.

### Chopper Gunner, §8.23's four cases

| Case | Covered by | Status |
|---|---|---|
| Gunner killed | `EV.EntityKilled` → `onDeath` | Pre-existing (M7) |
| Match ends mid-streak | `EV.MatchEnded` → `endAll` | Pre-existing (M7) |
| Instance destroyed mid-streak | `dispose` → `endAll` | Measured by the leak run |
| **Gunner disconnects** | **nothing** | **Fixed here** |

The fourth was a real hole: no death is emitted, the match is still running and the instance is
still alive, so a gunner who pulled their cable left a gunship flying on a command that would
never arrive again, owned by an entity that had stopped existing. Measured at **31.9 seconds** of
orphaned flight. `StreakSystem.onOwnerRemoved` deliberately reuses the death rules — the chopper
ends, pending streaks are lost, and a placed sentry or crate stays.

### Measured, red before green

| Probe | Red | Green |
|---|---|---|
| Streak loop | channel did not exist | granted → 3 pending → 3 requests → 3 grants → 1254 frames / 3 entities / 312 sweep frames |
| Ghost | `OP1[108,105,**2**,106,107]` — 2 leaks, CHECK FAILED | `OP1[108,105,106,107]` — entity 2 gone, bots remain |
| Chopper case 4 | entity 3's chopper sent to both survivors **31928 ms** after they left | last seen **0 ms** relative to the drop |
| Leak | — | 12 cycles, subscriptions **26 → 26 (+0)**, heap +0.3 MiB |
| Regression | — | 5/5 matches, scores identical on the same seeds |

### Three probes were wrong before they were right

Worth recording, because all three would have shipped as false greens:

1. **`--ghost --no-perks` gave `--ghost` precedence**, so the control run that was supposed to
   strip the perk equipped it anyway and passed. A probe that could not go red.
2. **It compared entity ids from two different instances.** The ghost's id was read at *report*
   time (entity 5, in the arena) against contacts recorded during the *match* (entity 2). Ids
   are per-instance — the reason `Session.playerId` exists — so it could never have found a leak
   however broken Ghost was.
3. **The chopper probe asked "was any chopper present"**, and all three clients had called one
   in, so the survivors' own gunships kept the answer true. It reported a failure that was really
   two players flying normally. Keyed by owner now.

The standing lesson — *watch every probe go red before believing it green* — earned its place
three more times in one sitting.

## Grenades on the wire (protocol v7)

`MsgS.Projectiles` — grenades in flight and smoke on the ground. **Broadcast**, unlike the streak
view: a grenade has no secrets. But consumed **two different ways**, which is what §6.8's one
sentence about prediction actually requires:

| Whose | How | Why |
|---|---|---|
| Somebody else's | Replicated, drawn from the record | Never simulated locally; nothing to reconcile. §4.12 applied to a thrown object |
| Your own | Predicted, already in the local pool | The authoritative record is a **correction**, and it is excluded from render adoption — drawing it beside the predicted one is the double-render |

Replicated **into** the pool `EquipmentFx` already walks, so the renderer is untouched by the
whole feature. `Projectile.replicated` marks an adopted slot and `EquipmentSystem` steps none of
them — no flight, no fuse, no trigger, no detonation. A client integrating a decided trajectory
parts company with the server the first time one of them clips a corner the other missed.

Smoke is replicated rather than left to the client's own field, and not for symmetry: **smoke
occludes bot LOS on the server**, so where the cloud is decides who can see whom. A client
drawing one a metre off is showing cover that does not exist.

### The double-damage was real

`BotDirector` pushes the local player onto its roster and `EquipmentSystem.detonate` walks that
roster, so a networked client's own blast applied damage to its own player through its own
`DamageSystem` while the server applied the authoritative copy. Health is overwritten by the next
snapshot, so the symptom was never a lastingly wrong bar — it was a flicker, a false low-health
vignette, and a heartbeat for a wound nobody inflicted. `EquipmentDeps.authoritative` is the fix,
the same shape as `MatchFlow`'s and for the same reason.

## The divergence checker (protocol v8), and what it caught

§7 asks literally for a hash. `MsgS.StateHash` carries one, `hashModeState` is the single function
both sides run, and `DivergenceChecker` moved to `shared/debug` so the browser and the harness
cannot drift apart about what agreement means.

**Sent last in the tick, and that is the whole correctness argument.** Every other channel
describes tick N; the hash asks what tick N looked like, and a client can only answer once it has
applied all of them.

### It failed on its first real run

Domination and Kill Confirmed: **3 confirmed divergences each, identically on all three clients,
first at tick 4281.** The return migration was tick 4270 — eleven ticks, the first snapshot after
it.

**Replicated mode state was never discarded on migration.** §4.18's list is flush, discard,
resync, clear; it had been applied to the streaks and projectiles when those were built and not to
the three mode-state channels that came before them. The failure is silent in the worst way: the
arena has no zones and no tags, so it **sends neither channel at all**, and a stale Domination flag
list or KC tag list is never overwritten. It persists, entirely plausible-looking, for the session.

TDM and FFA passed throughout — they have no such state to go stale, which is exactly why this
survived every earlier run.

### Results, all five modes, one full match each

| Mode | Divergences / samples |
|---|---|
| TDM | **0 / 1155** |
| Domination | **0 / 1155** |
| Kill Confirmed | **0 / 1157** |
| FFA | **0 / 1155** |
| S&D | **0 / 2502** (full best-of-5, B 2-3, summaries to all three) |

Red control: corrupting the server's hash by one produced **239 confirmed divergences per client,
first at tick 12**, and failed the run.

**Limits, stated rather than assumed.** This compares the server's view against what a client
ended up holding, so it catches dropped channels, truncation, mis-quantisation, a frame applied to
the wrong mode, and two channels describing different ticks. It does **not** catch the server being
wrong about its own game: if `Domination.onTick` miscounts a zone, both sides agree on the wrong
number and this stays silent. That is what `DivergenceChecker`'s score-versus-events comparison is
for; the two are complementary.

## The cosmetic audit, as a check that fails

`scripts/check-cosmetics.mjs`, wired into `npm run check`. An **allowlist, not a banned-word
search** — a keyword scan only catches a cosmetic somebody was honest enough to name `decal`, and
the failure that happens is a field called `impactX` or `shakeAmount`. The snapshot's field set is
pinned; adding one fails until it is listed with the §4.15 row it belongs to.

**Result: 19 snapshot fields, all §4.15 gameplay state.** Watched red — adding
`muzzleFlashIntensity` fails by name.

Two judgement calls, both written down rather than glossed:

- **`FiredEvent.tracer`** rides an *event*, which is the channel §4.15 says cosmetics are driven
  by, and carries one bit meaning "this shot was a tracer round" — which round in the magazine
  this was, a fact the firing side knows and a receiving client cannot recover across loss without
  counting shots it never saw. §8.25's requirement is about **snapshots**, and the snapshot is
  clean. `Messages.ts` previously *claimed* there was no tracer anywhere in it, which was simply
  false; the comment is corrected.
- **The four visual serials** carry no position, lifetime, count or material. A serial means "this
  entity died for the Nth time"; an angle means "the round came from there". They ride the snapshot
  because an event can be dropped and a dropped death leaves a body standing for ever, where a
  counter that jumps by three still plays exactly one death.

## The networked S&D spectator

M7's reached into a `BotDirector`; a networked client has no roster. **The rule is a pure
function** (`shared/modes/SpectatorTarget.ts`) because that is the half that can be wrong
invisibly: never yourself, never an enemy, only the living, lowest id, sticky on the current
target. Only in a one-life mode — in TDM a corpse waits four seconds and moving the camera is
worse than the wait.

Cleared on `EV.RoundStarted`: §4.18's discard rule at a round boundary. Without it a spectator
returns from the round they died in still pointed at a body that has respawned elsewhere.

Measured over an S&D best-of-5: **292 selections while dead — 0 self, 0 enemy, 0 dead.**

Red control, and the first attempt was not good enough: merely *removing* the team rule still
reported 0 enemy picks, because the lowest-id candidate was often a teammate anyway. **Inverting**
it to enemies-only produced 280 enemy picks and failed the run.

## What Gate B still needs

In rough dependency order. The first item unblocks the most.

1. **Per-listener audio on Depot** (§8.26) — occlusion and the per-map reverb IR. Needs a
   browser; grouped with the other browser-only claims below.
2. **The verification battery**: every mode on every map to completion, a full S&D best-of-5
   with the round-3 swap, the 100-cycle leak, hardening probes against `Tags` and `Bomb`, the
   12-hour soak, and every §7-conditions claim against a **deployed** server rather than
   loopback.

## Open, and all of one kind: they need a real browser

The preview pane never fires `requestAnimationFrame`, so none of these can be measured here.
Grouped deliberately — this is now the whole of what Gate B has not verified, and it is a single
session at a keyboard rather than a list of unrelated gaps.

- **Client background build time per map** (§8.7), which is what validates the 5 ms / 20 s pair.
- **A single click landing on a vote button** (§8.18).
- **Grenade reconciliation is visually seamless** (§8.24). The easing rate is sized against the
  snapshot interval — about 78% of the gap closed per 50 ms — and own-grenade exclusion from
  render adoption is one `continue`, but "no visible teleport" is a claim about pixels.
- **The spectator camera framing** (§6.8). The *rule* is measured at 292 selections, 0 invalid;
  what it looks like through a teammate's eyes is not.
- **Per-listener audio with occlusion on Depot** (§8.26).

Unchanged from Gate A: the arena-return residual of 1-3 sub-25 cm mispredictions. Not touched by
any of this work, and still distinguished from the into-live number rather than summed with it.

---

