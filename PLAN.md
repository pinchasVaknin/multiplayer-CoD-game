# PROTOCOL SEVEN — PLAN

Browser arena FPS. This file is the handover: what exists, what was decided, and what the next
milestone needs to know. A fresh session inherits the repository and this file, nothing else.

M1–M8 built a complete single-player browser game. M9–M11 moved it onto a dedicated external
server: the split first, then the netcode, then everything else on top of it. M12 is the scoped
content backlog, M13 (archived) put skinned bodies on the bots and moved the board and the XP
award to the server, M14 (archived) put vitest in the gate and legacy decorators behind a fence,
and Milestone 15 is the milestone in progress; the backlog and M15 are below, in full.

**Survival mode is cancelled** — permanently, not deferred. See "Roadmap update — post-M8" in
[12-post-m8-round-4.md](docs/archive/plan/12-post-m8-round-4.md).

---

## Where the record is

The closed sections of this file were moved to `docs/archive/plan/` on 2026-09-14 (baseline
`29533b2`), one file per section, verbatim, in the order they were written. Each file opens
with the line range it came from. A code comment that says "see PLAN.md, M5 notes" resolves
here: find the row, open the file.

This index makes no claim about what is complete. The honest answer to that question is the
"What Gate B still needs" list in [17-m11-gate-b-in-progress.md](docs/archive/plan/17-m11-gate-b-in-progress.md), as the Milestone 12 section below says.

| # | Section, title as written | Lines | File |
|---|---|---|---|
| 1 | Milestone 1 — Core Loop and Movement | 281 | [01-m01-core-loop-and-movement.md](docs/archive/plan/01-m01-core-loop-and-movement.md) |
| 2 | Milestone 2 — Gunplay | 332 | [02-m02-gunplay.md](docs/archive/plan/02-m02-gunplay.md) |
| 3 | Milestone 3 — Bots | 253 | [03-m03-bots.md](docs/archive/plan/03-m03-bots.md) |
| 4 | Milestone 4 — Map and Team Deathmatch | 353 | [04-m04-map-and-team-deathmatch.md](docs/archive/plan/04-m04-map-and-team-deathmatch.md) |
| 5 | Milestone 5 — Arsenal | 422 | [05-m05-arsenal.md](docs/archive/plan/05-m05-arsenal.md) |
| 6 | Milestone 6 — Progression and Loadouts | 361 | [06-m06-progression-and-loadouts.md](docs/archive/plan/06-m06-progression-and-loadouts.md) |
| 7 | Milestone 7 — Killstreaks and Modes | 255 | [07-m07-killstreaks-and-modes.md](docs/archive/plan/07-m07-killstreaks-and-modes.md) |
| 8 | Milestone 8 — Content and Polish | 296 | [08-m08-content-and-polish.md](docs/archive/plan/08-m08-content-and-polish.md) |
| 9 | Post-M8 — Polish and Bugfix | 252 | [09-post-m8-polish-and-bugfix.md](docs/archive/plan/09-post-m8-polish-and-bugfix.md) |
| 10 | Post-M8, round 2 — the re-opened reports | 161 | [10-post-m8-round-2.md](docs/archive/plan/10-post-m8-round-2.md) |
| 11 | Post-M8, round 3 — the regression, and two things that were never measured | 134 | [11-post-m8-round-3.md](docs/archive/plan/11-post-m8-round-3.md) |
| 12 | Post-M8, round 4 — the jitter, found | 250 | [12-post-m8-round-4.md](docs/archive/plan/12-post-m8-round-4.md) |
| 13 | Milestone 9 — Headless Server Split | 499 | [13-m09-headless-server-split.md](docs/archive/plan/13-m09-headless-server-split.md) |
| 14 | Milestone 10 — Netcode Foundation | 595 | [14-m10-netcode-foundation.md](docs/archive/plan/14-m10-netcode-foundation.md) |
| 15 | M10.5 — Tier 1 fixes carried back from M11 | 103 | [15-m10.5-tier-1-fixes.md](docs/archive/plan/15-m10.5-tier-1-fixes.md) |
| 16 | Milestone 11 — Skirmish Multiplayer Flow | 295 | [16-m11-skirmish-multiplayer-flow.md](docs/archive/plan/16-m11-skirmish-multiplayer-flow.md) |
| 17 | M11 Gate B — in progress | 337 | [17-m11-gate-b-in-progress.md](docs/archive/plan/17-m11-gate-b-in-progress.md) |
| 18 | M11 Gate B — playtest round 2 | 3,494 | [18-m11-gate-b-playtest-round-2.md](docs/archive/plan/18-m11-gate-b-playtest-round-2.md) |
| 19 | Milestone 12 — the playtest round 4 and round 5 fix records | 4,120 | [19-m12-playtest-rounds-4-5-fixes.md](docs/archive/plan/19-m12-playtest-rounds-4-5-fixes.md) |
| 20 | Milestone 13 — proposed: bodies that read, and one answer to "is this an enemy" | 1,207 | [20-m13-bodies-that-read.md](docs/archive/plan/20-m13-bodies-that-read.md) |
| 21 | Milestone 14 — decorators where a concern is written by hand, and a unit-test runner that shares the gate | 339 | [21-m14-decorators-and-vitest.md](docs/archive/plan/21-m14-decorators-and-vitest.md) |

What stays in this file: **Milestone 12 — proposed** (the content backlog) and **Milestone 15**
(the front end, rebuilt to fit one screen — proposed; one "done" subsection per phase as each
closes).

## How this file stays short

This file holds exactly three things: the index above, the content backlog, and the one
milestone in progress. Nothing else. When a milestone closes — in the session that closes it,
before the summary — its whole section moves, verbatim, to `docs/archive/plan/NN-slug.md` with
the provenance line the other files carry, and gets a row in the index; the `## Playtest round`
sections that accumulated under it go with it. Lines move; nothing is rewritten. `npm run
check:plan` refuses a third `# ` section here and an index that disagrees with the folder, so this
is a gate rather than a habit — the same reason the boundary check exists.

---

# Milestone 12 — proposed: the large content

Playtest round 4's remaining five items — **F4** (character skins and 3D models), **F5** (a
story), **F6** (more maps), **F16** (minigun, flamethrower, riot shield) and **F17** (a detailed
grenade-throw animation). None of them is a defect and none of them is small. This section is a
scoped estimate in the shape of the one that cancelled Survival: what the existing structure
already answers, what it does not, what each item breaks, and the decisions that are the human's
rather than mine. **No product code was written in this session.**

## The constraint that decides nearly everything

**This project has no asset files.** Not "few" — none. Measured this session: `src/`, `public/`
and `index.html` hold **296 `.ts` files, 5 `.css` files and 0 files of any image, model, audio,
font or environment format**. The only thing under `public/` is eight verification scripts.
Everything the player sees and hears is generated at runtime by code, and the code that does it
is **5 118 lines across sixteen files** — `ProceduralTextures`, `ProceduralAudio`, `AudioSpecs`,
`FxAssets`, `CamoTextures`, `BotMesh`, `StreakMeshes`, `WeaponMesh`, `WeaponMeshParts`,
`WeaponModelSpecs`, `WeaponSilhouette`, `KnifeMesh`, `MapMesher`, and the three map data tables.
Five per cent of the tree, standing in for an entire discipline.

That is not a stylistic preference, and its consequences are already load-bearing in three
places this milestone has touched:

- **`ProceduralAudio.playAnnouncer` says it outright**: *"Speech synthesis of actual lines is out
  of reach without assets and worse than nothing when it lands badly."* Ten announcer cues are
  formant-shaped noise bursts, not words. **F5 has to be read, not heard.**
- **`BotMesh`: "The mesh IS the rig: same boxes, same offsets, nothing to drift out of sync."**
  `buildZoneGeometry` walks `HUMANOID_RIG.boxes` — the same boxes `Ballistics` tests a round
  against. What you shoot is what you see, by construction rather than by discipline. **F4 is a
  proposal to break that identity**, and that is the whole of F4.

  **Round 5 executed F4 and broke it, in one direction and by a measured amount.** The paragraph
  above stands as the statement of what was at stake; what actually happened is in *"bodies, and
  the identity that had to be broken in exactly one direction"* below. The short version: the
  head and the torso are still exactly the rig and diverge by zero, the legs swing and the arms
  are posed onto the weapon, and the worst divergence is 0.412 m on a leg and 0.257 m on an arm
  — both on the two zones carrying the lowest multipliers in the game. It is measured every run
  by `npm run readability` rather than promised here. The identity is now a rule about *which*
  boxes rather than about all of them, and that is the thing a later session must not quietly
  widen.
- **F9, one session ago**, found the darkest map in the game was dark because a number in a
  *painter* was 0.019 where it should have been 0.07. With no assets there is no texture to
  inspect in an image editor; the only way to know what a surface looks like is to compute it,
  which is why `npm run readability` exists at all.

Today's client build, measured this session: **1 370.06 kB raw, 391.06 kB gzip**, plus 43.01 kB
of CSS. There is no loading screen for content because there is no content to load — §6.5's
background map build exists to hide *mesh construction*, not downloads.

## F4 — the fork in the road, and it is not a feature

"Skins and 3D models" is two different milestones wearing one sentence.

### (a) Stay procedural — skins as parameters

`CamoTextures` is the working precedent: six weapon camos, 333 lines, six *different
constructions* rather than six recolourings, each a seeded `Rng` drawing into a 256px canvas,
cached once per process. A character skin in the same idiom is a small parameter set — body,
head and gear tint, a pattern generator, maybe a silhouette accent — applied to geometry that
does not change.

| | |
|---|---|
| **Cost** | Days, not weeks. One new generator file, a `SkinId` beside `CamoId`, a picker row in the loadout editor, six or so unlock records |
| **Load time** | **Zero change.** Six 256px canvases is roughly 1.5 MiB of GPU texture, built once per process |
| **Risk** | Low, with one real edge: the hostile-body colour is taken from `ui/Palette` so it moves with colourblind mode, and a skin that painted its own colours would be a **second writer of the same fact** — the exact shape P0 bans. A skin must tint *within* the palette's answer, not around it |
| **Ceiling** | Genuinely low. Nobody will mistake it for a character model |

### (b) Build an asset pipeline — glTF, loading, caching, versioning

| | |
|---|---|
| **Cost** | A milestone in itself, and the loader is the smallest part of it: a cache with eviction, an asset manifest with content hashes, a CDN or a served directory, a licence audit for every model, and a build step that does not exist |
| **Load time** | This is the number that should decide it. The whole client is **391 kB gzipped** today. One rigged character with a 1k texture set is typically 2-10 MB. That is not a percentage on the download, it is a **multiplier**, and it arrives before the first frame unless a streaming path is built too |
| **What it breaks** | Everything above about the rig. A skinned mesh is not a stack of oriented boxes, so either the visual stops matching the hitboxes — which is a fairness defect, not a cosmetic one — or a second rig-to-mesh binding is built and kept honest by something that does not exist yet |
| **What else it breaks** | `npm run leak` watches heap and live subscriptions across 100 cycles. GPU resources behind an asset cache are a new class of leak it does not currently see. §8.7's 5 ms build budget is sized against *mesh construction*; a decode-and-upload pass is a different cost with a different shape |

**Recommendation: (a).** Not because (b) is wrong in principle but because of the order: (b)
spends a milestone on infrastructure whose first visible output is one character model, while
(a) reaches the same player-facing sentence — *"my operator looks different from yours"* — in
days and leaves (b) available afterwards. Route (b) also has to be taken *before* F6 rather than
after, because a map authored as data and a map authored as meshes are not the same file, and
authoring a map twice is the expensive mistake.

**Start neither until the human picks.** The two paths diverge at the first line of code.

## F16 — three new killstreaks

P4 made streaks a **currency**: `StreakLedger` holds a balance in kills, `charge` refuses what
the balance cannot cover and what has already been bought this life, and P4's measurement was
that the balance model affords **38 streaks across 705 lives where the threshold model handed out
75**. Nine streaks against three class slots is therefore a *choice* problem, not an inflation
one — the wallet still buys about one thing per life. *(Written before the cooldown pivot. The
wallet is still what bounds a purchase; what has changed is that a long life can now buy the
same thing twice, so a fourth streak competes for repeats as well as for slots.)*

Two facts from P4 that all three inherit: **no bot has ever spent a killstreak** (there is no
call site — bots bank a balance and never spend it), and **`EV.StreakEarned` has no gameplay
subscriber**, so a streak becoming affordable is announced to nobody. Three more streaks is
three more things the ten opponents will never call in and three more things nothing will
announce.

### What all three have in common, and it is new

Every shipped streak is either an **entity in the world** (sentry, care package), an **effect**
(UAV, counter-UAV, mortar) or a **camera takeover** (chopper). None of them puts a weapon in the
player's own hands while the player keeps playing. All three of F16's do, and that is the
mechanism the estimate turns on:

- **`WeaponSystem` has exactly two slots**, `primary` and `secondary`, and `equip(slotIndex,
  def)` sets one. So a streak weapon replaces the class's primary on activation and is put back
  on expiry — and the Chopper Gunner's rule applies verbatim and for the same reason: *"there is
  exactly one exit path… two things that can restore state are two things that can disagree
  about whether it has been restored."* `onExpire` is idempotent and `StreakSystem` already
  guarantees it runs on the timer, on death, on `MatchEnded`, on `dispose` and — since S8.23's
  case 4 — on the owner disconnecting.
- **`weaponIndexOf` returns 255 for anything not in `ALL_WEAPONS`.** The three synthetic streak
  weapons in `StreakWeapons.ts` are built by cloning the carbine and are not registered, which is
  correct today because nobody carries them. The moment a *player* carries one, that 255 is what
  remote clients receive in `EntitySnapshot.weaponIndex` — see "Found while here" for what it
  already costs.
- **A weapon swap the server owns has to reach the client's prediction.** P3 established the
  shape: `meta.setLoadout` re-runs the perk hooks and one of them writes
  `PlayerController.speedScale`, so a class swapped on a standing body made the client predict a
  different speed than the server — *"a constant per-tick disagreement about speed, which is what
  rubberbanding is."* A minigun that slows its carrier is exactly that, arriving mid-life with no
  spawn to hide behind.

### Minigun

| | |
|---|---|
| **Price** | 9 kills — between the sentry (8) and the chopper (12) |
| **Simulated by** | The server, through `WeaponSystem` like any other weapon. Nothing new in the damage path |
| **Wire** | `weaponIndex` only, *if* the def is registered. `MsgS.Streaks` needs no new field — `kind` is already a `u8` index into `STREAK_DEFS` and `MAX_STREAK_OFFERS` stays 3 |
| **Owner disconnects** | `onOwnerRemoved` already fires; the exit path restores the class primary to a body that is being removed anyway. **No new case** |
| **Without assets** | Cheapest of the three. `WeaponModelSpecs` builds guns from boxes and tubes; a minigun is a barrel cluster on a spin. `WeaponSilhouette` projects its killfeed glyph from the same spec for free, which is F15's payoff arriving early |
| **The real cost** | Spin-up and a movement penalty are both `speedScale`-shaped, which is the misprediction above. The chopper's belt (`chopperMagSize` / `chopperReloadSeconds`) is the precedent for bounding a held trigger without bounding the streak's length |

### Flamethrower

This is the one that does not fit the combat model, and it should be built as though it does.

`Ballistics` is hitscan with a penetration budget; `projectileSpeed` marks the only exceptions
(*"absent = hitscan. Only launchers and thrown equipment set this"*). A flame is neither.
Continuous damage has no representation anywhere: `DamageSystem.apply` is one request and one
answer, so a burn would be N small applies per tick flooding the damage-event channel, the
hitmarker and the damage numbers — and would want a `Burning` bit on an entity flags byte that
has none left (below).

**The cheap correct model is the shotgun's.** `pellets` and `pelletSpread` already resolve
several rays per trigger pull against the rig separately, and `damageFalloff` already collapses
damage with distance. A very short range, a very high rate, a wide cone and a brutal falloff is a
flamethrower's *behaviour*; the fire is presentation, which is exactly where §4.15 puts it — `Fx`
draws an additive cone with no texture, and `check:cosmetics` stays green because nothing about
it is in a snapshot.

| | |
|---|---|
| **Price** | 7 kills — the mortar's, and for the same reason: it buys a short decisive window rather than a presence |
| **Simulated by** | The server. No new damage kind if the pellet model is taken |
| **Wire** | `weaponIndex` only |
| **Owner disconnects** | The same door as the minigun |
| **Without assets** | The item that looks *best* without assets, because a flame is light rather than surface |
| **What a real burn costs instead** | A damage-over-time source, an entity flag bit that does not exist, a per-tick damage channel it would flood, and a bot question nothing answers today — `BotDirector` has no notion of "standing somewhere that hurts". Smoke blocks LOS; it does not injure |

### Riot shield and pistol — the heaviest of the three, and it is not close

The shield is **not a weapon**. The pistol half is nearly free: `equip(0, classPistol)`. The
shield half changes the hitbox model, and three facts make it the expensive one:

1. **`HitboxRig.layout` is `readonly`**, fixed at construction, and every one of the six
   construction sites passes `HUMANOID_RIG` — `Bot`, `NetPlayer`, `RemoteActor`, `Spectator`,
   `TargetDummy` and the default argument. `buildLayout` exists, so a second layout is
   anticipated; nothing swaps one.
2. **`RigHistory` stores five numbers per tick** — x, y, z, yaw, `heightScale` — and its own
   comment explains why: *"A rig is fully described by five numbers… store its history, do not
   invent a second representation."* It does **not** store which layout the rig had. A body whose
   *shape* changes during a life is therefore invisible to S4.13's lag compensation: a shot
   rewound 150 ms resolves against the shape the body has **now**, not the shape it had then.
   That is a silent hit-registration bug in the exact system M10 was spent getting right.
3. **`ColliderSet` is baked at boot and shared read-only across instances** (`MapBakery`,
   S4.19). A shield modelled as a moving world collider does not fit that structure at all.

Three ways to do it, and they are not equivalent:

| Route | What it costs | Verdict |
|---|---|---|
| **A second `RigLayout` with a shield box**, plus one `Uint8Array` of layout ids in `RigHistory` | `layout` stops being `readonly`; `push` / `fill` / rewind gain one field; `BotMesh` builds the shield from the same boxes, so *"the mesh is the rig"* survives intact | **Recommended.** The only route where what you shoot stays what you see |
| **A damage-side predicate** — "did this ray arrive in the front hemisphere of a shielded entity" | No geometry and no history change. But `Ballistics` has already resolved the hit by the time `DamageSystem` is asked, so the shooter gets a hitmarker for a round that did nothing — and it is a second place that decides a hit outcome | Rejected: the second-writer shape, and it lies to the shooter |
| **A moving world collider** | Honest physics, and it does not fit `ColliderSet`'s immutable shared bake | Rejected on structure |

| | |
|---|---|
| **Price** | 8 kills — the sentry's. It buys survival rather than damage |
| **Simulated by** | The server. The raise/lower state is per-entity and needs a wire bit (below) |
| **Wire** | The shape has to reach clients, or a remote shielded body both draws and rewinds wrong |
| **Owner disconnects** | The same door, and the rig must be put back to `HUMANOID_RIG` on the way out — the one restore path again |
| **Without assets** | A box. A riot shield is genuinely a slab, which is the one place this art style is not a compromise |

### The wire has no spare bits, and this is the finding to act on first

Both flag bytes are **full**, read directly:

- **`EFlag`** — `Alive`, `Firing`, `Reloading`, `Ads`, `Sprinting`, `Bot`, `Grounded`, `TeamB`.
  Eight of eight, written as `w.u8v(e.flags & 0xff)`.
- **`OF`**, the owner-state byte — `Grounded`, `WasGrounded`, `SprintActive`, `TacSprintActive`,
  `SlideActive`, `MantleActive`, `JumpedThisTick`, `JustLanded`. Eight of eight.

So *every* new per-entity boolean in this milestone — a shield raised, a grenade being cooked —
needs a field widened, and that is a protocol bump. Current version is **12**; the first wire
change in M12 is **v13**. Widen once, deliberately, rather than three times.

## F17 — the grenade animation, and where the line runs

Today there is no grenade in hand at all. `ViewmodelDrive.throwing` is one boolean derived from
`ThrowController.busy`, and `ViewmodelAnim` uses it to **lower the weapon off screen** through a
damped `throwPose`. The comment is honest about it: the throw *"used to read as the grenade
appearing from nowhere"*, and lowering the gun was the fix available at the time.

**The first-person half is free, and it is free because the simulation already holds the whole
sequence.** `ThrowController` runs on sim ticks off the input bitfield and exposes `phase`
(`IDLE` / `COOKING`), `cook` in seconds, `slot`, `followThrough` and `remainingFuse`. Pin pull,
arm cock, release and recovery are four poses keyed off values that already exist and that both
runtimes compute identically. The animation reads them; it must never write them, and it must
never keep its own clock — the fuse starts when the button goes **down**, and an animation that
decided when the hand opened would be a second authority on a timing the server owns.

That is the line, stated once: **`ThrowController` decides when the grenade leaves the hand;
`ViewmodelAnim` decides what that looks like.** Nothing new is replicated, nothing new is
recorded, and `check:cosmetics` is untouched because the snapshot is untouched.

**The third-person half splits in two, and the split is the decision:**

| What | Derivable today? |
|---|---|
| **The release**, on somebody else's body | **Yes, free.** `ProjectileState` carries `ownerId` and a `serial` that is *"already unique per throw and already stable for a projectile's whole life"*. The frame a new serial appears owned by entity N, entity N threw something. No wire change |
| **The wind-up** — pin, cock, hold | **No.** It happens entirely before the projectile exists. Nothing in the snapshot says a grenade is being cooked, and `EFlag` has no bit left to say it |

**Recommendation: take the release for nothing now**, and take the wind-up only if `EFlag` is
being widened for the riot shield anyway — one bump, two features. A wind-up also has a gameplay
consequence worth naming before it is built: seeing an enemy cook is *information*, and adding it
changes fights, which makes it a balance decision rather than an animation one.

## F6 — what a map actually costs, measured

The only item here whose cost is fully known, because three of them exist. Measured this session
— the counts from the built map defs, the bake times from a real server boot (`npm run
skirmish`), the ground luminance from `npm run readability`:

| | Foundry | Dunes | Depot | (Testbed) |
|---|---|---|---|---|
| Brushes | 48 | 109 | 50 | 71 |
| Prop placements | 76 | 60 | 84 | 34 |
| Spawn zones | 16 | 18 | 18 | 13 |
| Lights | 4 | 2 | 8 | 2 |
| Objectives | 6 — `flag×3 bombsite×2 bombspawn×1` | 6, identical | 6, identical | 0 |
| Lanes | 3 | 3 | 3 | 0 |
| Cover points | 220 | 164 | 172 | 72 |
| Nav layers | 2 | 2 | **3** | 2 |
| Playable area | 3 348 m² | 5 440 m² | 4 480 m² | 2 080 m² |
| Collision bake | 2.45 ms | 0.45 ms | 0.34 ms | 0.23 ms |
| **Navmesh bake** | **55.28 ms** | 19.71 ms | 26.17 ms | 7.09 ms |
| Resident | 0.37 MiB | 0.59 MiB | 0.71 MiB | 0.24 MiB |
| Source | 514 lines | 601 | 899 | 499 |
| Ground, as the screen shows it | 61.7 / 255 | 185.0 | 21.3 | — |

Four maps bake in **112.87 ms for 1.90 MiB** at boot. A fifth adds one of those rows and nothing
else on the server: `MapBakery` bakes every map in `MAPS` before the listener opens, so the cost
lands at boot rather than in a transition, by design.

**What is free and what is not:**

- **Cover points are free.** `cover.ts` derives them from prop placements and the shape's own
  profile — *"a 1 m cube is cover from every side; a container is a wall and only its long faces
  are"*. The 164-220 above were authored as 60-84 props. `navStats.coverRejected` is the data-bug
  signal on a new map and should be read before anybody plays it.
- **The navmesh is free.** *"A map therefore needs no nav authoring at all — only honest
  `navBounds`."*
- **Objectives are not free and are not optional.** `modesForMap` filters the ballot by authored
  objective kinds, so a map that skips them silently offers three modes instead of five. All
  three real maps author the identical six, and the flag positions have to be balanced *before*
  the lanes are — `types.ts` says why: moving three flags after the lanes are balanced means
  re-balancing the lanes.
- **The ballot has a ceiling of five and it is nearly reached.** `MAP_BALLOT` holds three; digits
  1-5 cast votes and are shared with the quick class selector, which takes them only while the
  ballot is hidden (round 3). A fourth map fits. A **sixth has no key**, and at five maps the
  class selector is unreachable for the whole map-vote phase.
- **The lighting bar is measurable before it is played.** `npm run readability` reports the ground
  as the screen shows it: Foundry 61.7, Dunes 185.0, Depot 21.3 — a spread of nine to one. A new
  map lands somewhere on that line, and F9's lesson is that the number to check is the **albedo in
  `albedo.ts`**, not the light intensity.
- **The client build time is the one unknown, and it is the one that matters.**
  `MapBuildQueue`'s 5 ms budget and the 20 s readiness timeout are *"one decision, not two"*,
  sized against an assumed two-second build, and the file says plainly that the measured build
  time per map *"needs a real browser"*. It has never been measured for **any** map. A fourth map
  is precisely the thing that would break that pair, and this session cannot say by how much.
  **Measure the three existing maps in a browser before authoring a fourth**, or the fourth will
  be the first data point and a timeout will be the first symptom.

Weight, from the Survival estimate this file already accepted: *"The same effort spent on a fourth
and fifth map… buys more variety per unit of risk."* That reasoning has not changed, and F6 is the
only item here with no architectural unknown in it.

## F5 — a story, honestly

**Do not assume the answer is a campaign.** Three different things hide behind the word and they
differ by two orders of magnitude.

### (a) A frame — a faction, a place, names

Nearly free, and the surfaces already exist and are already read: `ModeEntry.blurb` (six),
`GameMode.brief` (six, and F10 built the window they appear in one session ago), four map names
and blurbs, the loading screen, the summary, and the player's own default callsign — `OPERATOR`,
which is also the game's name. A frame is written into strings that are already on screen.
**Zero engineering.**

### (b) An order of battle — the opposition as characters

Bots have tiers (`RECRUIT` / `REGULAR` / `HARDENED` / `VETERAN`), a per-map authored `tierMix`,
and names already resolved through the directory the killfeed and scoreboard share. Giving the
opposing side a persistent identity across a session — a named unit, ranks that match tiers, a
roster that recurs — is small work on top of structure that exists. Medium cost, and it is the
item that would make the *existing* content feel authored rather than generated.

### (c) A campaign

The Survival estimate's argument applies without modification: a campaign is *"the first mode
that is not a variation on two teams, a score limit and a respawn rule"*. It needs mission flow
as a state, scripted triggers, objectives that are not the five modes, per-mission authoring and
a fail-and-retry loop. And then it needs dialogue — and this build **cannot speak**. Ten
announcer cues are formant-shaped noise, and the file that makes them says speech is out of reach
without assets. **A campaign in this build is a silent, text-delivered campaign**, which is a
different product from what the word suggests to whoever asked for it.

**Recommendation: (a) now, (b) with F6, not (c).** A new map that arrives with a name, a place
and an opposing unit is most of the story at a fraction of the cost, and it is the half that
survives however the F4 fork is decided.

## Dependency order

The first item unblocks the most, which is the ordering rule this file has used since Gate B.

1. **The F4 fork** — decided, not built. It gates F6: a map authored as data and a map authored
   as meshes are not the same file, and route (b) taken after F6 means authoring the map twice.
2. **F5 (a), the frame** — costs nothing and decides the names F6 and F4 then use.
3. **Measure the client map build in a browser** — the §8.7 number open since M11, and the one
   F6 cannot be sized without.
4. **F6, map four** — the highest player-hours per unit of risk, and the only item with no
   architectural unknown.
5. **The `EFlag` widening (protocol v13)** — one bump, taken deliberately, because F16 and F17
   both need bits and neither can have one.
6. **F17** — release-only third person costs nothing; the wind-up rides v13.
7. **F16, in this order: minigun → flamethrower → riot shield.** The minigun establishes the
   streak-carries-a-weapon path — equip, restore, the one exit, the prediction question. The
   flamethrower reuses it plus the shotgun's pellet model. The shield goes last because it is the
   only one that touches lag compensation, and it should not be built on a path that is still
   moving.
8. **F4, as (a)** — genuinely last, and the only item that can be deferred indefinitely with no
   loss to anything else.

## What each item breaks

| Item | What it puts at risk |
|---|---|
| F4 (a) | The palette's single authority over team colour — a skin that paints its own is a second writer, and `npm run readability`'s 12-pair colour invariant is the probe that would have to grow to cover it |
| F4 (b) | *"The mesh is the rig."* Hit registration stops being verifiable by looking. Plus a leak class the 100-cycle harness does not watch, and a download budget currently at 391 kB gzip |
| F16 minigun | Prediction: a server-owned weapon swap mid-life, with a movement penalty, is P3's `speedScale` rubberband with no spawn to hide behind |
| F16 flamethrower | The damage path, if a real burn is chosen over the pellet cone |
| F16 riot shield | S4.13 lag compensation. A body whose shape changes during a life rewinds to the wrong shape, silently |
| F17 | Nothing, if the animation reads `ThrowController` and never writes it. A second clock over the fuse would be the banned shape exactly |
| F6 | The §8.7 budget/timeout pair, and the ballot's five-key ceiling |
| F5 (a)/(b) | Nothing |
| F5 (c) | Everything Survival would have broken, and it ships mute |

## Decisions waiting on the human

Each with a recommendation, and none of them started.

| # | Decision | Recommendation |
|---|---|---|
| 1 | **F4: procedural parameters, or an asset pipeline?** | **Procedural.** (b) spends a milestone on infrastructure to ship one model, and breaks the mesh-is-the-rig identity |
| 2 | **Are the three streak weapons registered in `ALL_WEAPONS`?** | **Yes**, with an unreachable `unlockLevel`. It is what makes `weaponIndex`, the killfeed glyph and the silhouette work with no parallel table. It moves `check:unlocks`'s count off 12 weapons and will want unlock records |
| 3 | **`EFlag` is full. Widen to 16 bits, or go without?** | **Widen, once, as v13.** The shield's raise state and the throw wind-up both need a bit and neither can be derived |
| 4 | **Flamethrower: pellet cone, or a real burn?** | **Pellet cone.** It reuses the shotgun's machinery and adds no damage kind, no flag bit and no bot question |
| 5 | **Riot shield hitbox: second `RigLayout`, damage predicate, or moving collider?** | **Second layout**, plus one array in `RigHistory`. The only route where what you shoot stays what you see |
| 6 | **Are the new streaks unlock-gated?** | **No.** All six shipped ones are ungated; gating three of nine makes the picker inconsistent for no gain |
| 7 | **Prices: minigun / flamethrower / shield** | **9 / 7 / 8.** P4 measured the balance model at 38 streaks per 705 lives, so nine streaks over three slots is a choice problem rather than inflation. These are a starting point for the human to feel, not a result |
| 8 | **F17 third person: release only, or wind-up too?** | **Release now** — free, off `ProjectileState.ownerId`. Wind-up only alongside #3, and note that it is a balance change rather than an animation |
| 9 | **Does map four author all six objectives?** | **Yes.** Otherwise `modesForMap` silently offers three modes instead of five, and flags moved later mean lanes re-balanced later |
| 10 | **F5 scope** | **Frame now, order of battle with F6, no campaign.** A campaign here ships mute |

## Measured, this session

Every number in this section came out of a run in this session, named with the probe that
produced it. No product code was written, so there is nothing here to regress; the gate was run
to confirm the tree was clean before the documentation commit.

| Probe | Result |
|---|---|
| Asset-file census — `find src public index.html` over 17 image/model/audio/font extensions | **0 files.** 296 `.ts`, 5 `.css`, 101 369 lines |
| Procedural generators, `wc -l` over the sixteen files | **5 118 lines** — 5.0% of the tree |
| `npm run build` — client bundle | **1 370.06 kB raw / 391.06 kB gzip**, CSS 43.01 kB |
| `npm run skirmish` — boot bake, four maps | **112.87 ms / 1.90 MiB**; Foundry navmesh **55.28 ms**, Dunes 19.71, Depot 26.17, Testbed 7.09 |
| Map defs at runtime — brushes / props / spawns / cover / objectives / lanes | the F6 table above |
| `npm run readability` — ground as the screen shows it | Foundry **61.7**, Dunes **185.0**, Depot **21.3** of 255 |
| `npm run check` | boundaries, cosmetics (**19 snapshot fields**), unlocks (**12 weapons, 12 perks, 4 field upgrades, 5 equipment, 6 camos, 6 requirement accessors**), cheats (**6 codes, 5 entitlement bits**) and all three typecheck targets pass |

Read by inspection rather than measured, and named as such because they are the load-bearing
claims above: `EFlag` and `OF` each assign 8 of 8 bits; `HitboxRig.layout` is `readonly` and
`RigHistory` stores five per-tick fields with no layout among them; `WeaponSystem` has two slots;
`weaponIndexOf` returns 255 for any id outside `ALL_WEAPONS`; `PROTOCOL_VERSION` is 12.

## Needs a browser

This session drew no pixels and claims none. Two items below are prerequisites rather than
checks — they are inputs to decisions above, not verifications of them:

- **The client map build time, per map** (§8.7, open since M11). Load each of Foundry, Dunes and
  Depot from the arena and read `BuildReport` — `elapsedMs`, `workMs`, `chunks`, `worstChunkMs`,
  `frames`. **F6 cannot be sized without this**, and if any map costs materially more than two
  seconds of work then `DEFAULT_BUDGET_MS` (5) and `READY_TIMEOUT_MS` (20 s) both move, together.
- **Depot at 21.3 counts**, still on P9's list. If the yard still reads as black after the albedo
  change, the next lever is the irradiance floor rather than the albedo — and that answer changes
  how a fourth map should be lit before it is authored.

Everything else on the earlier browser lists is unchanged; this session neither added to them nor
removed from them.

## Found while here

- **Killstreak kills have no icon of their own, in either runtime, and F16 would add three more.**
  `DamageSystem` emits `EV.EntityKilled` with `weaponId = def.id`, so a sentry kill carries
  `streak_sentry`. Solo, `iconFor('streak_sentry')` reaches `modelSpecFor`, which returns
  `WEAPON_MODEL_SPECS[id] ?? AR_BASE` — so the feed draws a **carbine** for a kill by a turret.
  Over the network it is worse in a way that matters for the fix: `EventCollector` writes
  `weaponIndexOf('streak_sentry')`, which is **255** because the synthetic defs are deliberately
  not in `ALL_WEAPONS`, and `NetSession` decodes it back as `weaponIdAt(255) ?? ''` — so the
  client is handed an empty string and the id is gone. The two runtimes therefore need different
  fixes: solo has the information and lacks a spec, networked lacks the information. Not this
  session's item and nobody reported it, but decision #2 above is exactly the lever that would
  close both halves at once.
- **The milestone status table at the top of this file is stale** — it lists milestones 10 and 11
  as "Planned" while M11 Gate B is part-done and four playtest rounds have landed on top of it.
  Left alone deliberately: correcting it is a claim about what is complete, and Gate B's own
  "What Gate B still needs" list is the honest answer to that question rather than a table row. (2026-09-14: the table is gone — the header now carries an index of the archived sections and makes no completion claim, for this reason.)

*The playtest round 4 and round 5 fix records that followed this section are in [19-m12-playtest-rounds-4-5-fixes.md](docs/archive/plan/19-m12-playtest-rounds-4-5-fixes.md).*

---

# Milestone 15 — proposed: the front end, rebuilt to fit one screen

Planned by the human on 2026-09-15 from five requirements and five reference images — a main
menu, a Create-a-Class screen, a match intro, an end-of-match screen, and one rule over all of
them: **nothing scrolls, anywhere, at any window size.** The references are the look (an
asymmetric menu over a cinematic left half, nav buttons that are smeared rather than boxed, a
character on a lit platform, a right-hand loadout column of six boxes that each show only what
is equipped); the numbers below are what this tree already has and what each item costs
against it. The four decisions the brief turned on were taken the same day, on the
recommendation: **the menu backdrop is a live render of the game, not a video** (no video file
exists, and none is wanted at 5–20 MB against a 391 kB client); **the skin picker ships
local-first**, the wire field after; **1280×720 is the floor** the no-scroll rule is measured
at; and **Milestone 14 was archived** to make room for this section — its record is
[21-m14-decorators-and-vitest.md](docs/archive/plan/21-m14-decorators-and-vitest.md).

Five phases, in dependency order: **A** the frame (one scale, no scroll), the menu with its
backdrop dolly, and the controls card moved into Settings; **B** Create-a-Class — the stage,
six boxes, the strips, the skin picker; **C** the match intro, a camera the round-one freeze
already pays for; **D** the end of the match — the lineup and the accordion; **E** combat
behind the menu — the solo simulation running under the backdrop, last, because it is the one
piece whose cost has to be measured by `npm run leak`-shaped instruments before it ships.
Zero gameplay change throughout: nothing in `shared/` moves before B6, the server is not
touched by any phase but B6, and the seeded harness and the content probe are byte-identical
after every commit. **No product code was written in this session.**

## The rule that decides the layout: nothing scrolls

Today the opposite is policy, and it was a fix. Playtest round 5's B1/B2 found the main menu
at 879 px of content in a 626 px window with half of it at a negative offset; the answer was
`justify-content: safe center` and `overflow: auto` on the `.op-screen` layer
(`styles/app.css`, the comment at the layer's `overflow`), so *"a screen taller than the
window scrolls from its own top, and no individual screen has to know how tall it is."* B11
then rebuilt the loadout editor so that its option list is never destroyed, *because* it
scrolls. The layout probe (`scripts/layout-probe.mjs`, `probes/layout.ts`) asserts two rules
at six viewports: every element is **reachable** by some scroll, and nothing scrolls
**sideways**. Vertical scrolling is, in that probe's own words, *"a legitimate answer to a
long screen."*

This milestone withdraws that answer. The mechanism is one thing rather than a decision per
screen:

- **A design frame.** The front end is authored at 1920×1080 and the UI root carries
  `zoom: var(--ui-scale)` with `--ui-scale = min(vw / 1920, vh / 1080)`, set from the same
  `resize` listener that calls `Renderer.setSize`. `zoom` rather than `transform: scale()`
  because it re-lays out at the scaled size — text is rasterised at its final size and
  `getBoundingClientRect()` reports what is on screen, so the probe measures the truth. Chrome
  has always had it; Firefox since 126. The frame is centred; the backdrop layer is full-bleed,
  so a 16:10 or an ultrawide window gets more sky, not black bars.
- **A third probe rule, and the first rewritten.** *No overflow*: for every element in a
  mounted screen, `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth`, and no
  element's rect leaves the viewport — which is *reachable* with the scroll taken away, so it
  subsumes it; *sideways* stays as the named special case. Viewports: the six in
  `Viewports.ts` plus **1920×1080** and **1280×720**, the floor. Below the floor the frame
  still fits — the formula has no lower clamp and the rule holds at 375×812 too — but nothing
  is promised about legibility there; that width is the device gate's territory already.
- **Where the length goes.** The things that are long today become tabs, paged strips or
  collapsibles, screen by screen: the menu's key card (13 actions and Esc) → a Settings tab;
  the editor's 14 rows → six boxes, each opening one strip, paged where a list outruns the
  strip; the 22 rebindable actions → the BINDINGS tab that already exists, in two columns;
  the ten-player board on the summary → a toggle over the lineup. Nothing gets an
  `overflow: auto`, and the probe is what refuses one.
- **`html, body { overflow: hidden }`** stays; it is what keeps the canvas still.

## What exists, measured this session

| What | Number |
|---|---|
| Front end | `client/ui/`: 23 files, **8 000 lines** of TS; 5 stylesheets, **3 604 lines** of CSS; `tokens.css` holds the palette, the 4 px grid and the type ramp every value resolves to |
| `Menus.ts` | 464 lines; one centred column — title, status, profile line, Play Multiplayer, callsign, Play Solo, Create a class, Settings, the key card, the fullscreen hint, reset — then a mode/map/difficulty page |
| `LoadoutEditor.ts` | 864 lines; 5 slots, **14 rows** (primary, attachments, camo, secondary, sidearm attachments, lethal, tactical, perk ×3, field upgrade, streak ×3), one open at a time, `WeaponPreview` + `LoadoutStats` on the right; `.lo-options` scrolls (B11) |
| `Settings.ts` | 590 lines, four tabs already (CONTROLS, BINDINGS, AUDIO, VIDEO); **22** rebindable actions |
| `EndOfMatch.ts` + `XpSummary.ts` | 264 + 352 lines; the XP rows land on a 0.34 s cadence with a bar and a level-up flourish (S6.1, *"the payoff moment of the whole loop"*); the board is the match's own `Scoreboard`, embedded, 8 rows a side |
| Layout probe | 2 rules × 6 viewports (1366×626 … 375×812), headless Chrome over CDP, an instrument (`npm run layout`), not a gate — the deploy host has no browser |
| Video and image assets | **0** of either. The only assets are M13's: 7 skins in `public/models/bots/skins/` — **Apex 4.4 MB, Pulse 4.5, Rhino 4.9, Sentry 5.2, Viper 24.3, Echo 28.2, Hazard 37.6; 109 MB** — and 8.5 MB of animation clips. One skin preloads at boot (`echo`, the default, 28 MB); the rest load when an actor is dealt them |
| A character stage's precedent | `WeaponPreview` builds its own `THREE.Scene` and `WebGLRenderer` on the editor's first tick; `CharacterAssetService.avatarProvider(def).create()` hands back a posed `CharacterSkin` with a weapon socket and an animator |
| The freeze | `MATCH_START_SECONDS = 10`, round one only, every roster mode; the quick class selector (keys 1–5) is a HUD panel that lives in exactly this window |
| A camera that is not the player's | `ChopperCamera.cameraFor(chopper, aspect)`: `Game` *asks* once per render frame and renders through the answer or through the rig — *"nothing for Game to undo"* |
| Routes | `Pathfinder` over `NavGrid`, resumable and budgeted; `ModePanel.measureLanes` already solves spawn → centre synchronously with a large budget on the match's own instance; `LaneDef.center` is authored on all three real maps, three lanes each, *"where the two teams meet"* |
| Objectives | Foundry, Dunes and Depot each author **3 flags + 2 bombsites** (`MapDef.objectives`: kind, position, radius, label); Greybox authors none |
| Movement, for the camera | sprint 6.9 m/s (`MovementConfig`), eye 1.65 m (`PlayerState`); `CollisionWorld.overlapCapsule` is the one test movement uses |
| Save | `SAVE_VERSION = 3`; a `LoadoutSlot` has a `name`; nothing on the profile names a character skin |
| Wire | `MAX_PLAYERS = 10`; `EntitySnapshot` carries `weaponIndex` and `heightScale` and no character index; a body's skin is dealt client-side by `RandomCharacterSelector` from the entity id and a per-match salt |
| Client build | 1 370 kB raw / 391 kB gzip (M12's measurement; re-taken at Phase A) |

## Phase A — the frame, the menu, and the controls card moved

**A1, the scale.** `--ui-scale` on `#ui-root`, the 1920×1080 frame, the resize hook, the
third probe rule and the two new viewports, and the comment at `.op-screen`'s `overflow`
rewritten to say what replaced the rule and why — the B1/B2 reasoning is history now, and a
comment that argues for a rule the file no longer has is worse than none. Every existing
screen is run through the probe at the eight viewports **before** any screen is redesigned,
so the list of what overflows is measured rather than guessed; those screens are then fixed
in the phase that owns them, and the probe stays red on them until then — a red probe is a
finding, which is S8's rule for tests applied to an instrument.

**A2, the menu.** Two halves. **Right:** the navigation — PLAY (multiplayer, primary, one
click to the arena as §6.1 requires), PLAY SOLO (the mode/map/difficulty page, which becomes a
panel sliding over the same frame rather than a second page), CREATE A CLASS, SETTINGS — four,
not the reference's six: no ZOMBIES or STORE exists here, and QUIT is out (decision 7: a
browser tab closes itself). Each button is a `clip-path` polygon with a skewed leading edge, a `mask-image`
gradient that frays its trailing edge into the backdrop, and a hover sweep along the skew —
the "smeared" reading is three declarations and a pseudo-element, no image. The callsign
field, the profile line (level, class, record) and the status line move to a header strip at
the top right, where the references put the player card. **Left:** the backdrop, and the fade
between the halves is a `mask-image` on the backdrop layer — a canvas whose right and top
edges dissolve into `--c-void`, so the picture has no edge to read as a box.

**A3, the backdrop dolly.** The backdrop is the game's own renderer drawing a real map: the
map mesh, the sky dome and the particulate, with the camera on a slow dolly along one of the
map's authored lanes at eye height — the bots' own route, smoothed the way Phase C smooths (C
lands after A, so A ships with a straight dolly along `lane.a → lane.center` and takes C's
spline when it exists). **No simulation runs**: no `Match`, no bots, no bus subscriptions — the
world is `MapRender` + `SkyDome` + a camera, built through `MapBuildQueue` at its 5 ms budget
while the boot screen is up, which is what the queue was built for (§6.5). Which map: the one
the player last played (`save.mapId`), so the menu shows where they are going. This is the
whole of "the backdrop" for Phase A; the bodies and the shooting are Phase E, and the reason
they are separate is stated there.

**A4, the controls card.** `CONTROL_ROWS` and `FULLSCREEN_HINT` move from `Menus.ts` to a
fifth Settings tab, **INFO**, built from the live bindings exactly as they are today — M8's
reasoning (a card that says W A S D to a player on the arrow keys is worse than none) does
not change with the address. The reset control goes with them, keeping its two-step arm.
`Menus.ts` loses `resetArmed`, the card and the hint; `paintMain` becomes the two halves.

**Gate A.** `npm run layout` green at eight viewports on the menu, the play panel and the
settings; `npm run check` green; seeded harness and content probe byte-identical (nothing in
`shared/` moves); the client bundle re-measured and recorded. **Pane:** the menu at 1920×1080,
1366×626 and 1280×720, screenshots in the record; the dolly stepped by hand (`loop.frame`) and
its edge measured — a pixel column at the mask's boundary reads `--c-void` on the menu side.

### A1 — done (session of 2026-09-15): the frame, the rule, and the first measurement

**The frame.** `ui/Frame.ts`: `FRAME_WIDTH/HEIGHT = 1920/1080`, `frameScale(vw, vh) =
min(vw / 1920, vh / 1080)` (three vitest cases, no lower clamp), `applyFrameScale(root, vw,
vh)` writing `--ui-scale` onto `#ui-root`, and `createScreen(layerClass)` returning a
full-bleed **layer** and the 1920×1080 **frame** inside it. `.op-screen` is the layer now —
the backdrop, the blur, the z-order, `hidden`, and a flex centre for its one child; `.op-frame`
is the box: `zoom: var(--ui-scale)`, `overflow: hidden`, `justify-content: safe center`, the
padding. The five screens create theirs through it and append to the frame (`Menus`,
`LoadoutEditor`, `Settings`, `PauseMenu`, `EndOfMatch` — eight mount sites); `.eom`'s and
`.lo`'s `gap` moved to their frames. `Game` calls `applyFrameScale` beside `Renderer.setSize`
in the constructor and in `onResize`. The B1/B2 comment at `.op-screen`'s `overflow` is
rewritten to say what the rule was, why it is gone, and not to bring it back. `LoadingScreen`
(`.op-loading`, three elements on its own layer, the §4.18 fallback) and `VoteOverlay` (HUD)
are not in a frame: neither is a front-end screen, and neither has anything to overflow with.

**One departure from the brief, and why.** The brief put the zoom on `#ui-root`. It is on the
frame instead: `MatchFeedback` and `ClientMatch` place the HUD's hit markers and direction
indicators from `window.innerWidth` / `innerHeight`, in window pixels, and a zoomed `#ui-root`
would have moved every one of them by `1 / scale`. The HUD stays in window pixels and outside
the frame; the variable is still written on `#ui-root`, so a later phase can read it there.

**The rule.** `probes/layout.ts` asserts one thing now — *outside* (no laid-out element's rect
leaves the window; no scroll is tried first, and an element larger than the window is a
violation rather than a thing to skip) and *overflow* (any element whose `overflow` is not
`visible` on an axis has `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth`;
a single-line ellipsis is exempt, being a designed truncation of one string). One finding per
cause: an element an ancestor clips is not also reported as outside — the first run of this
version reported one binding list as thirty-eight lines. Content sizes are reported in
**frame** pixels. `Viewports.ts` gains 1920×1080 (the frame, scale 1) and 1280×720 (the
floor) at the head of the list; the driver prints the scale beside each viewport and says
`fits its frame` where it said `fits or scrolls`.

**Measured — the tree as it was, under the frame, at eight viewports. The red list:**

| Screen | Frame px at 1920×1080 | Verdict |
|---|---|---|
| menu | 497 × 879 | fits |
| unsupported | 322 × 195 | fits |
| solo-setup | 840 × 568 | fits |
| settings/CONTROLS · AUDIO · VIDEO | 780 × 362 · 371 · 544 | fit |
| **settings/BINDINGS** | 780 × 1336 | **`.op-settings` scrolls — 1184 px of rows in a 605 px box** (`max-height: 56vh; overflow-y: auto`). A4's |
| pause | 431 × 496 | fits |
| summary · summary/ffa | 1040 × 476 · 644 | fit |
| create-a-class | 1240 × 931 | fits |
| **create-a-class/open-row** | 1240 × 1021 | **`.lo-options` scrolls — 606 px in a 319 px box** (B11's list) **and the frame clips the screen by 5 px** (1085 in 1080). B's |

`FAIL — 24 violations` over 96 screen × viewport cells: the same three causes on the same two
screens at each of the eight sizes, nothing else red at any. The probe stays red until A4 and
B close them; a red instrument is a finding (S8).

**Two things the frame found that the brief did not predict:**

- **A media query folds on the window, not the frame.** `meta.css` carried `@media (max-width:
  1080px) { .lo-columns { grid-template-columns: 1fr } }`; at 1024×640 the editor — still
  1920 frame px wide — folded to one column and ran to 1970 frame px, 81 violations at that
  one size in the first run. Deleted, with the reason in its place: nothing inside the frame
  may vary with the window.
- **`vh` and `vw` inside the frame are not the window's.** Chrome resolves a viewport unit
  inside a zoomed element in the element's own pixels: `56vh` on `.op-settings` is 605 frame
  px at 1920×1080 and 455 at 375×812 — the window's height, in frame units. Every `vh`/`vw` in
  front-end CSS (`.op-settings`' 56vh; `.sb`'s 94vw where the board is embedded) becomes a
  frame-pixel value in the phase that owns the screen, and none may be added.

**Uniformity, measured.** With the fold gone, a screen's frame-px height drifts under 1 %
across the viewports down to the floor (menu 879 at 1920×1080, 875 at 1280×720, 863 at
1366×626) and up to 10 % at 375×812 (965): text zoomed to two or three pixels rasterises to
whole ones. Below the floor the rule holds and the drift is the price of it; at and above the
floor the frame is uniform.

**Pane:** the real client at 1024×768 — `--ui-scale 0.533`, the frame 1024×576 at y = 96 with
equal bands, `scrollHeight = clientHeight = 1080`, no console error; resized to 1280×720 —
scale 0.667, the frame exactly the window; Create-a-Class opened, `WeaponPreview` rendering
inside the frame. **Gate:** `npm run check` green (**119** tests in 14 files; boundaries 350
files). Eleven files changed, all under `client/`, `client/probes/` and `scripts/`; nothing in
`shared/` or `server/`, so the seeded harness and the content probe — built from those two
partitions alone — are byte-identical by construction.

### A2 — done (session of 2026-09-15): the menu on the frame — and A4 with it

**A4 came with A2, not after it.** The brief ordered the menu before the controls card, and
the first thing the menu's layout showed was that it cannot be drawn *around* the card: a
fourteen-row key list has no place in a header, a stage and a footer. So the card, the
fullscreen hint and the reset control moved first (`KeyCard.ts` — `CONTROL_ROWS`,
`FULLSCREEN_HINT`, `buildKeyCard(bindings)`, built from the live bindings exactly as M8 built
it), into a fifth Settings tab, **INFO**; `MenuDeps` lost `bindings` and `onResetProgress`,
`SettingsDeps` gained `onResetProgress`, and the two-step arm went with it, cleared on `show`
and on every tab change. Gate A also names the settings screen, so the A1 red list's first
row was closed here too: `.op-settings` is no longer a `56vh` scroller — the 22 actions stand
in **three columns** (Movement · Combat · Equipment with Interface beneath), the tallest
eight rows, and the post-M8 `scrollTop` carry-over (`body`, `rememberScroll`) is deleted with
the scroller, there being no offset left to keep.

**The menu** (`Menus.ts`, 464 → 459 lines with the card gone). The frame is a grid — `head`,
`stage`, `foot` — under a layer that *fades* the backdrop rather than dimming it: left to
right, transparent over the canvas to `--c-void` under the navigation, with a second gradient
bringing the top edge down, and no blur (`.op-screen--menu`). **Header:** the wordmark, a
rule and `ARENA FPS` on the left; the player card on the right — the callsign as a name (no
box, a rule beneath, the accent while it is being written; still written to the profile on
every keystroke, still never a gate) with the profile line under it. **Stage:** the left half
holds nothing, because the canvas under it is the backdrop (A3's); the right holds the
navigation in a 600 px column, four buttons — PLAY (primary, disabled with its reason when no
server is configured), PLAY SOLO, CREATE A CLASS, SETTINGS — and no fifth: no ZOMBIES or
STORE exists here and QUIT is out (decision 7). **Footer:** the status line, bottom right.
`showBoot` and `showUnsupported` keep the plain centred frame: a one-line status has nothing
to navigate.

**The buttons are cut, not boxed**, and it is CSS alone: a `clip-path` polygon skews the
leading edge 26 px and pulls the trailing corner in 10; on the primary a `mask-image`
dissolves the leading 11 % into the backdrop instead of ending it on a line, with the
accent as a rule beneath; a skewed `::after` band sweeps the length on hover and on keyboard
focus. Four glyphs — play, a crosshair, a loadout list, sliders — are one `path` each in
`Menus.ts`, drawn through `makeIconSvg` for the reason `WeaponIcons` draws the rifles (no
image assets), filled with `currentColor` so they take the button's state. Chevron the same.

**Play Solo is a panel, not a page.** The three pickers and Back / Start match are a
`section.op-setup` (1000 px, accent rule on the left) that spans the stage and right-aligns,
so opening it moves neither the header nor the footer; it slides 16 px and fades over
`--dur-med`, and the frame's side padding is 64, so even the first keyframe is inside the
window — which is what lets the probe measure the panel on the frame it was inserted into
without waiting. `prefers-reduced-motion` turns the slide and the sweep off.

**Measured.** `npm run layout`, 13 surfaces × 8 viewports (INFO is the thirteenth):

| Screen | Frame px at 1920×1080 | Verdict |
|---|---|---|
| menu | 1792 × 1004 | fits — the header, stage and footer fill the frame less its padding |
| solo-setup | 1808 × 1004 | fits — 16 wider is the panel's first keyframe |
| settings/BINDINGS | 1240 × 701 | **fits** — was 1336 with a 1184-in-605 scroller |
| settings/INFO | 780 × 655 | fits — the card, the hint and the reset |
| settings/CONTROLS · AUDIO · VIDEO, pause, both summaries, create-a-class | unchanged | fit |
| create-a-class/open-row | 1240 × 1021 | the same two violations — B's |

`FAIL — 16 violations`, all sixteen the editor's open row at each of the eight viewports;
the menu, the play panel and every settings tab are green at every size, which is the layout
half of Gate A. **Pane**, the real client at 1024×768: the frame 1024×576, header 956 wide at
y = 117, the nav column at x 670–990, the player card at 841–990; PLAY SOLO opened — header
rect identical before and after, the panel at 465–998, three 264 px picker columns, *Start
match* focused; BINDINGS in three columns with Back on screen; INFO with the card, the hint
and *Reset progress*; no console error on any of them. (The pane's screenshot crops to
800 device pixels wide, so the right of the frame was verified by rect and by
`elementFromPoint`, not by picture; a red fixed-position probe at `right: 0` confirmed the
crop is the capture's, not the layout's.) **Gate:** `npm run check` green (119 tests;
boundaries 351 files). Six files, all `client/`; `shared/` and `server/` untouched.

**Needs a browser (the human's):** whether the leading dissolve and the sweep read as a
smear rather than a fade, on a real display at play distance; and the fade against a bright
map, which does not exist until A3.

### A3 — done (session of 2026-09-15): a world that is not a match, and Gate A closed

**`client/world/MenuBackdrop.ts`** (284 lines, 45 of them code the rest says why). A
`LoadedMap` plus `applyAmbient` plus the map's `Particulate` plus a camera this class moves —
the three things `MatchWorld` puts in the scene before it builds a player into them, and
nothing else: no `Match`, no bots, no `PlayerController`, no bus subscription, no navmesh
bake. Built through its own `MapBuildQueue` at the 5 ms budget, pumped from the render pass;
its `onComplete` takes the map and adopts it. Its own queue rather than `Game`'s, because that
one's `onComplete` reports readiness to a server for a match being prepared, and the arena is
`MATCH`, where this is already gone. `Game`: `MENU`'s `enter` calls `prepare(selection.mapId)`
— the map the solo picker names, so the menu shows where the player is going; idempotent for
the map already up — and `buildWorld` calls `dispose()` before it constructs a `MatchWorld`,
which is the whole of the rule that keeps the scene at **one map, ever**: the backdrop exists
only while `Game.world` is null. `draw`'s no-world branch renders the scene through the
backdrop's camera with no viewmodel, or clears the canvas while the map is still building,
exactly as it did before.

**The dolly.** The middle lane by index — the spine on all three shipped maps — from `a` to
`center` at 1.65 m (the player's eye), FOV 62°, a cosine push-and-pull at 0.55 m/s, a ±2.5°
sway over 14 s, pitch −2°. The straight line is checked before it is ridden: the segment is
sampled every 25 cm with a standing capsule against the map's own `CollisionWorld`, and the
dolly runs over the free prefix; under 4 m it holds at `a` and sways. A map with no lanes
(the greybox, the range) rides `spawns[0] → navBounds' centre`, `measureLanes`' fallback.
Phase C's spline replaces the line; the check stays.

**Measured, in the pane.** Dunes behind the menu: **34 chunks, 79 ms of work**, landing in
5–7 frames of 5 ms pumping once the texture cache is warm (11 on the cold first build). The
canvas at 15 % of the width reads **(111, 89, 64)** — the souk's sandstone, not the clear
colour (12, 14, 17) — and the menu layer's computed gradient is `rgb(7, 8, 10)` from 78 %
with `backdrop-filter: none`: the map on the left, the void on the right, no edge. The dolly
moves — two screenshots five seconds apart show the wall's end and the far beams closer.
The header sat on a sunlit wall, so the top fade went from 0.78 → 0 at 26 % to 0.9 → 0 at
34 % and the header text carries a shadow; whether that is enough on a display is below.

**GPU, with a new instrument.** `__p7.gpu()` reads `renderer.info.memory` (one console
entry, in DEBUG.md's list). Frames stepped by hand in the hidden pane (`loop.frame`, the
pane suspends rAF):

| Cycle | Result |
|---|---|
| Backdrop prepare → dispose × 10, Dunes | **32 geometries / 12 textures with the map, 0 / 10 without, every cycle identical**; the map ready after 7 frames each time |
| MENU ↔ MATCH × 6, backdrop *disabled* (the isolation run) | geometries flat, 15 at the menu and 67 in a match; **textures +7 per cycle**, 113 → 146 |
| MENU ↔ MATCH × 8, backdrop on, after the fix below | geometries flat, 35 / 55; textures **+2 per cycle**, 27 → 45 |

**Found while here — a leak in every map build since M4, not the backdrop's.** The
isolation run is the attribution: with the backdrop off, the match cycle alone grew the
texture count. The map's shadow-casting `DirectionalLight` was never disposed — `root.clear()`
takes it out of the scene, and `DirectionalLight.dispose` is what frees the render target the
first shadow pass allocates — so every build left a shadow map on the GPU. Fixed in
`MapRender` by pushing the light onto the map's own disposables (`d7482ff`, its own commit).
The +2 per cycle that remain are in the match path and unattributed; the recipe and the
suspects (`EquipmentFx`'s canvas texture, `WeaponMesh`'s, the indicators' dispose being
reached for every actor) are handed to a bug session rather than chased here.

**Bundle, re-measured.** **1 522.38 kB raw / 437.83 kB gzip, 49.63 kB CSS** (M12 recorded
1 370 / 391 / 43; M13's glTF and animation code sits between the two measurements, so the
frame, the menu and the backdrop are a small part of the difference and the 6.6 kB of CSS is
theirs).

**Gate A, closed.** `npm run layout` green on the menu, the play panel and every settings tab
at eight viewports (the sixteen violations left are the editor's open row, B's); `npm run
check` green (119 tests; boundaries 352 files); nothing in `shared/` or `server/` touched by
A1–A3, so the seeded harness and the content probe are byte-identical by construction.

**Needs a browser (the human's):** the fade against a sunlit wall at play distance, and
whether the wordmark holds on it; the dolly's speed and sway; which lane reads best per map —
Foundry's CENTRE is the hall, Dunes' the covered street, Depot's the night yard — a
`lanes[Math.floor(n / 2)]` today, a per-map choice if one of them is wrong.

### Playtest report (2026-09-15), fixed the same day: the frame's ramp

*"Everything except the main menu is too small — it strains the eyes."* Three screenshots at
1920 wide: Settings, the Play Solo panel, Paused. Correct, and the frame is why. The type
ramp in `tokens.css` — 10 / 11 / 13 / 16 / 22 / 40 — was tuned for a HUD and a responsive
front end, in *window* pixels; under the frame a token is a *frame* pixel, and at 1920×1080 a
13 px body and 10 px labels are the same numbers they always were, except that every screen
now sits inside a 1920-wide layout designed to be read from further away, and on a
1366-wide laptop the same tokens are 0.71 of that. The main menu escaped only because A2 had
sized its wordmark (40) and its buttons (20) for the frame by hand.

**The fix is a second ramp, scoped to the frame.** Custom properties inherit and every
front-end rule already resolves to a token, so `.op-frame { --t-*, --s-* }` in `tokens.css`
rescales every screen inside a frame and nothing outside — the HUD, the scoreboard overlay,
the killfeed and the debug layer keep the ramp they had. Type ×1.4 (**14 / 16 / 18 / 22 / 30 /
56**), spacing ×1.5 (a 6 px grid: 6 / 12 / 18 / 24 / 30 / 36 / 48 / 72). The fixed widths of
frame content scaled where they stand: `.op-settings` 780 → 1080, the binding tab 1240 →
1560, `.op-pickers` 840 → 1180 (three columns of ~370, `minmax(320px, 1fr)`), the Play Solo
panel 1000 → 1380, the pause stack and the code row 240 → 336, the slider track 220 → 320 with
a 90 px readout, the binding caps 96 → 132, inputs 180 → 250, the callsign 220 → 300, the
range thumbs 12 → 16. **Two screens are pinned to the old ramp** with the values restated on
their own frames — the editor (`.lo`, B rebuilds it; 931 tall at 13 px would not fit at 18)
and the summary (`.eom`, D's; the sixteen-row FFA board) — each with a comment saying which
phase deletes the pin.

**Measured.** At 1920×1080 the settings title is 56 px, tabs 16, labels and buttons 18, help
16, the settings column 1080 wide. `npm run layout` on the first run: BINDINGS **1021** tall
in the 1016-px box — one violation, the frame clipping it. The binding rows went one step
tighter (column gap `--s-2`, key caps padded `--s-1` vertically — a key cap, not a button):
**871**, green. The probe now reads menu 1792 × 1004, unsupported 446 × 277, CONTROLS 1080 ×
524, BINDINGS 1560 × 871, AUDIO 538, VIDEO 788, INFO 935, pause 626 × 723 — all green at
eight viewports; `FAIL — 16 violations`, still only the editor's open row. "Reset all
bindings" had stretched to the 1560 px column and is label-wide now. `npm run check` green.

**Needs a browser:** whether 18 / 16 / 14 is enough at the distance the human plays from —
it is a 40 % step and the smallest text is now 14 — or whether the ramp wants one more step
(20 / 17 / 15), which the INFO tab's fourteen-row card would then need two columns for.

## Phase B — Create-a-Class: the stage, six boxes, the strips, the skins

### B0 — done (session of 2026-09-15): the skins at a twentieth of their weight

**What the weight was.** Read from the GLBs without a parser package (`scripts/glb-images.mjs`
— a `.glb` is a header, a JSON chunk and a binary chunk the images sit in): Viper, Echo and
Hazard carried two or three material sets each with a **2048×2048 PNG normal map and a
2048×2048 PNG diffuse, 6–8 MB apiece**; the four light skins carried the same maps at 1024
(1–1.6 MB). Geometry was never the cost — 24–32 k vertices is 1.5–1.9 MB. Every material in
the library is `OPAQUE` metallic-roughness with `KHR_materials_specular`, so nothing reads an
alpha channel.

**The pass.** `scripts/skin-compress.mjs`: `gltf-transform resize` to at most 1024 on a side
(Lanczos3, never enlarging) and `gltf-transform jpeg` at quality 88 over the PNGs, through
`npx` at a pinned `@gltf-transform/cli@4.5.0` — run once, not a build dependency (S2 holds).
It replaces a file only if `rigSignature` — node names in order, joint counts, animation
names and channel counts — is byte-for-byte the same before and after; all seven were.
**109.0 MB → 17.3 MB**: Apex 4.38 → 1.62, Echo 28.24 → 3.95, Hazard 37.56 → 3.85, Pulse
4.45 → 1.49, Rhino 4.93 → 1.52, Sentry 5.15 → 1.65, Viper 24.26 → 3.21. The default skin
stays `echo`, now 3.95 MB — decision 5's "a 4 MB skin as the default" is met by the skin
that was there. `CHARACTER_VERSION` moved to `2026-09-15-skins-jpeg` so a client holding the
old bytes fetches the new ones.

**The gate.** `scripts/check-skins.mjs`, `check:skins` in `check` after `check:animations`:
every catalogued skin exists and every shipped one is catalogued; none over **5 MB**; no
texture over 1024 on a side or a PNG — the last two so the message names the cause and the
script to run. Proved red on the shipped tree before the pass (65 problems: three skins over
the limit, every 2048 map, every PNG) and green after: `7 skins, 17.3 MB in all, 47 textures`.

**Measured in the pane:** a solo match on Foundry loads all seven re-encoded skins (`GLB
character template … is ready` × 7), nine actors drawn, no console error. `npm run check`
green (119 tests). **Needs a browser:** JPEG at 88 on a normal map — whether a seam or a
block shows on a body at play distance is a display question; the quality constant is one
number in the script.

**B1, the stage.** Left half: the selected skin on a lit disc, `idleWeaponReady` looping,
holding the class's primary through the weapon socket (`CharacterSkin.setWeapon`, the call
the match makes), turning at 0.1 rad/s with the two arrows below it to grab. Rendered
exactly as `WeaponPreview` renders the gun — its own scene, its own renderer, built on the
first tick, disposed on exit. The skin loads through `CharacterAssetService.preload` on
selection; until it resolves the disc holds the skin the stage last showed, and the default
is preloaded at boot, so the first paint is never empty (decision 5 is about how long that
first paint waits). The stat panel does not leave the screen — M6 called `LoadoutStats`
*"the point of the screen"*, and that has not changed — it becomes a compact strip under the
weapon strip's tabs, visible while a weapon box is open.

**B2, six boxes.** The right column: **PRIMARY** (silhouette, name, camo swatch),
**SECONDARY**, **EQUIPMENT** (lethal + tactical), **PERKS** (three icons), **KILLSTREAKS**
(three icons, each labelled with its key), **FIELD UPGRADE**. Each shows only what is
equipped. Six boxes under the header in a 1080 frame is 120 px each — room for an icon and
two lines; fourteen would have been 60. The five class slots are tabs across the top right,
where the reference puts them, and the slot's `name` is edited in place beneath them.

**B3, the strips.** Clicking a box opens one strip beneath it — the in-place model B11 built
(`refreshers`, one `openRow`) kept, the elements re-shaped — with the boxes above staying
put. A weapon box's strip has three tabs: **WEAPON** (the list, paged at the strip's width),
**ATTACHMENTS** (per slot, the fit rules unchanged), **SKIN** — the reference's word for what
this project has called camo since M5; the label changes, `CamoId` does not. Equipment's
strip has LETHAL / TACTICAL tabs; Perks' has 1 / 2 / 3; Killstreaks' has 3 / 4 / 5. A strip
longer than its width is **paged**, never scrolled — the arrows at each end are the
reference's, and the probe is what holds it to that. Locked items keep M5's rule: drawn with
their requirement, never hidden.

**B4, tooltips.** One tooltip element on the screen, positioned by the hovered item, filled
from the def's existing `blurb` (perks, equipment, field upgrades, streaks and attachments all
carry one). It never leaves the frame: it flips above when below would overflow, which is a
rect test, not a guess.

**B5, the skin picker.** CHANGE A SKIN at the bottom left, opening a horizontal strip of the
seven skins with a thumbnail each. **The thumbnails are generated, not loaded:** rendering
seven live models to fill a strip means fetching 109 MB to open a menu, so
`scripts/skin-thumbs.mjs` drives the headless Chrome that `layout-probe` already knows how to
find, renders each skin once to a 160 px canvas and writes
`public/models/bots/skins/thumbs/*.png` — committed, ~15 kB each, regenerated when a skin
changes, and `check:animations`' folder rule extends to them: a skin without a thumbnail
fails the gate. Picking writes `skinId` to the profile — `SAVE_VERSION` 4, a migration in
`SaveData.ts` with its test — and the stage reloads. **Local-first (decision 2):** the picked
skin is what the stage and Phase D's lineup show; other players still see the dealt body. The
wire step is **B6**: a `characterIndex: u8` on `EntitySnapshot` and on the join,
`RandomCharacterSelector` becoming the fallback for a body that declared none — a
`shared/net` change with `check:authority` and the netharness over it — taken in this
milestone if B1–B5 land with room, else the first item of the next.

**Gate B.** `npm run layout` green on the editor at eight viewports with every box's strip
open in turn — the probe mounts the editor and opens each box, because a probe that measures
only the closed state measures the easy state; `check:unlocks` and `check:cosmetics` green;
`progression` byte-identical (the editor's gating is a courtesy over `sanitiseLoadout`, and
this phase must not have moved it); the pane, 50 cycles of MENU → LOADOUT → MENU with
`renderer.info.memory.geometries`, `.textures` and the bus's live count flat.

### B1–B4 — done (session of 2026-09-15): the stage, six boxes, the docked zone, the tooltip

**The stage** (`ui/CharacterStage.ts`, 307 lines). The figure is an `ActorAvatar` from
`CharacterAssetService.avatarProvider(def).create()` — the object `BotRenderer` makes for a
body in a match — driven each tick by `update` with a standing, armed, idle
`ActorAnimationInput`, which the selector answers with `idleWeaponReady`; the weapon in its
hands is `buildHeldWeapon` with the shared gunmetal, a bot's own asset. So the operator on
this screen is the one other players see, by construction. It stands on a plinth with an
accent ring (two primitives, no texture), turns at 0.1 rad/s, can be dragged, and the two
arrows nudge it an eighth of a turn with an ease. Its own `WebGLRenderer` on its own
860×800 canvas, built on the first tick as `WeaponPreview`'s is, its backing store sized
from the on-screen rect so a frame at 0.58 does not rasterise 860×800 to show 500×464. The
first paint faced the camera at its back — a body at yaw 0 faces −Z — so the turntable starts
at a half turn. `LOADING OPERATOR…` is written from `tick`, because the body arrives between
edits and a refresher only runs on one.

**Six boxes** (`LoadoutEditor.ts`, 864 → 1 173 lines with the zone, the pager and the tooltip
in it): PRIMARY and SECONDARY (the weapon's own silhouette from `iconFor`, its name, its
finish, its attachments as chips), EQUIPMENT (lethal + tactical), PERKS (three chips, `—`
for an empty tier), KILLSTREAKS (three, the box's tab labels carry the keys), FIELD UPGRADE.
70 px each: six of them, the 16 px gap and the 430 px zone are 916 of the column's 928. The
five class slots are tabs across the header with the equipped one marked, the name field
and Equip beside them, the level and *Save and exit* at the right; the frame's padding is
32/48 here rather than 48/72 because this screen has the most on it.

**The zone is docked, not dropped.** A box's options open in one place, under the column,
with tabs where a box holds more than one list — WEAPON / ATTACHMENTS / SKIN, LETHAL /
TACTICAL, PERK 1 / 2 / 3, KEY 3 / 4 / 5. The reference drops the strip directly under the box;
under a rule that nothing may leave the frame, a strip under KILLSTREAKS would push FIELD
UPGRADE off the bottom or cover it, and one that flips above its box for the last two rows is
a strip in two places. So opening PERKS does not move KILLSTREAKS, and the frame never grows.
Tiles are four across, two rows over the stat band or three without, and a longer list is
**paged** — the pager shares the tabs' row, because a row of its own was 28 px the zone did
not have. The **stat band** is `LoadoutStats` restyled to five columns of four lines (the
reference has no stat panel; M6 called this one *"the point of the screen"*, and it stays);
the **SKIN** tab shows the finish on the `WeaponPreview` in the band, because a held weapon
is one shared material and does not carry a camo. B11's mechanism is kept whole — one
`paint()` per `show()`, refreshers, truncation on close — and its test is now that the open
zone's *page* survives an edit: picking VULCAN 74 on page 1 of 2 changed the box, the
profile and the operator's hands and left the pager at 1 / 2.

**The tooltip** (B4): one `.lo-tip` on the frame, moved to whichever chip is hovered or
focused, filled from the def's `blurb`, positioned in frame pixels (window rects divided by
the frame's scale) and flipped above when below would leave the frame. `+7% movement speed`
under LIGHTWEIGHT, measured at (1058, 429).

**Measured.** `npm run layout`, now 21 surfaces × 8 viewports — the editor closed, every box
open, the weapon box on each of its three tabs: **`PASS — every surface fits its frame`**,
the first green run under the no-scroll rule. Getting there was four probe runs: the first
zone at 400 px held 575 of content (the pager on its own row, the stats in four columns, and
`openBox` not refreshing so twelve tiles showed instead of eight); the third fit by one pixel
at 1920×1080 and was over by 4–15 at every smaller viewport — text zoomed to a fraction
rasterises to whole pixels, so a screen that fits by a pixel at scale 1 does not fit at 0.6,
and the zone now carries **5 % of slack** by design. Two tile-level findings on the way: the
heavy capitals overran their line box by two pixels under `overflow: hidden` (`line-height:
1.45`, `flex: none`), and the probe learned that a `-webkit-line-clamp` is a designed
truncation like an ellipsis. `npm run check` green (119 tests; `check:unlocks` still finds
all six requirement accessors in the picker). **Pane**, 1920×1080: the operator on the disc
holding the M4, the six boxes with their chips, the zone with eight weapon tiles and the
band; SKIN with seven camo tiles and the preview; no console error.

**Found while here — the +2 textures per match cycle, closed.** The stage's show/hide cycle
grew *its* renderer's texture count by two per cycle (15 → 73 over 30). `SkeletonUtils.clone`
gives every skinned mesh its own `Skeleton`, a `Skeleton` uploads its bone matrices as a
`DataTexture`, and `CharacterSkin.dispose` never disposed them — which is also where A3's
unattributed +2 per MATCH ↔ MENU cycle came from, every retired body leaving two behind.
Fixed in `CharacterSkin.dispose` (`cb4399a`, its own commit): stage **5 g / 11 t flat over
30 cycles**, MATCH ↔ MENU **35 g / 25 t flat over 6**. Two GPU leaks in one milestone, both
found by an instrument that did not exist a day ago.

**Needs a browser:** the stage's key light on the darker skins; whether 0.1 rad/s is the
right idle turn; the tile blurbs at two lines on a real display.

### B5 — done (session of 2026-09-15): the skin picker, and the thumbnails rendered once

**The save.** `settings.skin: string` — a setting beside the callsign rather than a profile
fact, because it is the same kind of thing (who the player looks like) and a progress reset
keeps settings: a wiped level should not also change a face. `shared/` holds the name only;
`Profile.skinId` is the one reader that checks it against `BOT_CHARACTER_IDS` and falls back
to the default for a name the catalogue does not carry. **`SAVE_VERSION` 3 → 4**, `upgradeV3`
dressing an older save in `DEFAULT_SKIN_ID` — the M8 kind of bump, where `normaliseSave`
would have defaulted the field anyway and the migration exists so that *"a v3 save loads
wearing the skin it was always shown"* is a tested sentence: two new cases in
`SaveData.test.ts` (v3 → v4 with everything else intact; a v4 naming `viper` keeps it, a
blank falls to the default). `DEFAULT_SKIN_ID` lives in `shared/` and the client's
`DEFAULT_CHARACTER_ID` is that name asserted against the catalogue at module load — one
fact, checked at the seam rather than restated.

**The thumbnails are rendered, not loaded.** `probes/skin-thumb.html` +
`client/probes/skinThumb.ts` put one skin on the editor's own `CharacterStage` — same
lights, same disc, same lens — held at a three-quarter pose (`hold(angle, distance)`, the
stage's one concession to a script) and read back as a PNG (`snapshot`, in the same task as
the draw); `scripts/skin-thumbs.mjs` drives it through the headless Chrome the layout probe
uses and writes `public/models/bots/skins/thumbs/<File>.png`. Software WebGL on purpose, so
the bytes are the same on every machine that regenerates them. **Seven renders, 50–71 kB
each, 335–647 ms each**, committed. The Chrome plumbing — `findChrome`, `Cdp`, `evaluate`,
the dev server, the launch, `withPage` — moved out of `layout-probe.mjs` into
`scripts/headless-chrome.mjs` for both to share; the probe driver is 95 lines now (was 310)
and does what it did. `check:skins` gained rule 4: every skin has its thumbnail.

**The picker.** CHANGE A SKIN over the foot of the stage's canvas — the strip opens *upward
over the picture*, so the column's height is the same open and closed and the frame never
grows — seven tiles of thumbnail and name, the chosen one in the accent. Picking writes the
profile, puts the new body on the disc and marks the tile; the canvas's arrow bar is pinned to
the column's foot (`margin-top: auto`) so the toggle stands in the room between it and the
canvas rather than on it. `CharacterDefinition` gained `name` and `thumbUrl`, both versioned
with the skin. **Local-first (decision 2):** the stage and, in D, the lineup show the pick;
other players see the dealt body until B6.

**Measured.** `npm run layout`: **22 surfaces × 8 viewports, PASS** (the strip open is the
twenty-second). `npm run check` green — **121 tests**, `check:skins` reporting every skin
with a thumbnail, `check:flags` with the probe's `?skin` declared undocumented. **Pane**,
1920×1080: the strip's seven `<img>`s at 320×400, ECHO marked; VIPER picked — `settings.skin
= "viper"`, the save at v4, the stage on `viper`, the bar at y 992–1048 under the strip's
980; ECHO restored. No console error on a fresh load.

**B6 — the wire — is not taken.** B1–B5 landed with the phase's budget spent on two GPU
leaks and a probe that is green for the first time; B6 is `shared/net` (`characterIndex: u8`
on `EntitySnapshot` and the join, `RandomCharacterSelector` becoming the fallback for a body
that declared none) with `check:authority` and the netharness over it, and it opens the
milestone's only `shared/` change. It is the first item of whatever comes next, per the
brief.

**Needs a browser:** the thumbnails against the strip's dark tiles on a real display; whether
a portrait at a third of its size still reads which skin is which (Apex and Sentry are the
close pair).

## Phase C — the match intro: a camera the freeze already pays for

**Where it plays, and what it hides.** The brief calls this a hidden loading screen. In this
project there is nothing to hide: the connected path builds the next map during the previous
match's summary and warmup (§6.5) and adopts it at the transition, and the solo path builds
it before `MATCH`. What there *is* is the round-one freeze — ten seconds in which the player
stands at spawn unable to move, ten rather than three (`MatchFlow.ts`) so there is time to
read the quick class selector. The intro plays over that: **client-only presentation over a
built world during a freeze the server already runs.** Conditions: `flow.currentPhase ===
'WARMUP'`, `flow.round <= 1`, not the warmup arena (§6.1's lobby), not the Shooting Range, and
the world built — if the fallback `LoadingScreen` is up, there is no intro. Nothing goes on
the wire; the server does not know it happened.

**The timeline** is driven by `flow.phaseSecondsRemaining`, not a local clock, so a client
that joined with four seconds left gets four seconds of intro and the FIGHT cue lands on the
player's own eyes regardless. Budget, of the 10 s: **Phase 1 ≤ 4.0 s, Phase 2 1.5 s, Phase 3
≤ 3.0 s, return blend 0.5 s, and 1.0 s of the player's own view before the freeze lifts** —
the last is not negotiable; a player looking through a cinematic camera when the round goes
live has been ambushed by their own UI. TDM, FFA and Kill Confirmed have no Phase 3 and hold
the overview instead.

**Phase 1, the approach.** The route is the bots' route: a second `Pathfinder` over the
match's `NavGrid` (its own arrays, so the bots' queue is untouched; disposed after), solved
synchronously with `measureLanes`' budget from `nav.nearestCell(spawn)` to the **map centre —
the `navBounds` centre snapped to its nearest walkable cell**. The waypoints become a
Catmull-Rom spline; the eye rides it at 1.65 m over the cell surface; yaw follows the tangent
with a 0.3 s lag and pitch holds −6°; speed is a distance/time profile with an ease at each
end and a ceiling of 9 m/s against a 6.9 m/s sprint. A route longer than 4 s at the ceiling
is trimmed from the spawn end, not sped up — the approach reads as a person moving, or it
does not read.

**Phase 2, the overview.** From the centre, a pull-back along a 45° elevation ray whose
azimuth points from the centre toward the player's spawn — so the player's own side lands at
the bottom of the frame, which is the reading "this is where I am" — to the distance at which
the `navBounds` half-diagonal fits the vertical FOV. Computed from the bounds and the lens,
not tuned per map.

**Phase 3, the objectives.** Domination: the flags in label order, A → B → C; Search &
Destroy: the two bombsites, A → B. From the overview the camera drops to 3 m over the first
objective in 0.6 s with an ease-out (the snap), holds 0.4 s with the objective's label in the
HUD, then travels to the next along a nav route at eye height with the speed profile
inverted — ease-in, up to 40 m/s in the middle, ease-out into the hold — which is what a whip
is when it is not allowed through walls. Routes here are solved the way Phase 1's is; a route
the grid cannot find (two sites on disconnected surfaces) falls back to an arc *above* the
map, never through it.

**The return.** 0.5 s from the last pose to the rig's eye — position lerped, yaw and pitch
the short way round — ending exactly at the 1.0 s mark. Any bound action or mouse button
skips to the return blend; keys 1–5 do not, because the quick selector is the reason the
window exists and a class pick must not cost the player the overview.

**The seam.** `IntroCamera.cameraFor(intro, aspect)` in `client/`, asked in `Game`'s render
pass before the chopper, the same shape and for the same reason (there can be no chopper in a
freeze, but the order is a fact rather than an assumption). While it answers: no viewmodel,
no crosshair, no compass; the mode title, the objective labels and the quick selector stay.
`MotionBlur` is left as it is.

**Gate C.** A harness, `npm run intro`, beside `readability`: for every map × mode, bake the
navmesh, solve the three phases, sample the whole camera path at 0.25 m and assert **zero
samples inside a collider** (`overlapCapsule` at 0.3 m) and **total time within budget**;
prints the route lengths and the trims. Pure `shared/` geometry, so it runs on the server
build with no browser. The timeline arithmetic is a vitest test. `npm run check` green;
seeded harness byte-identical (the harness never renders, so the intro never runs there).
**Needs a browser:** whether the whip reads as a whip and whether −6° is the right pitch are
display questions.

### Between phases — a report from the chopper (2026-09-15), fixed the same day

*"When I activate the Chopper Gunner and look through its thermal camera, the character
bodies are completely invisible. I can only see their weapons floating in the air."* Correct,
and the suspicion in the report was right: the three thermal override materials share
`GUNSHIP_VERT`, which round 2 taught to apply `instanceMatrix` by hand and nobody taught to
skin. three sets `USE_SKINNING` from the object, not the material, and a vertex stage that
reads `position` raw draws a `SkinnedMesh` unposed, in rig space — nowhere the optic looks.
The held weapons are plain meshes in the hand bone's frame and were right all along, which is
what made the report read the way it did. **Measured on Dunes from the chopper, the same
frame, the shader swapped in place:** the one enemy in the open reads **50/81 hot pixels at
its torso with the fix and 9/81 (the weapon) without**; 81 hot pixels on screen against 9.
Bodies under the covered street stay occluded, as the depth pass intends. `723630a`, on its
own. The instrument was `gl.readPixels` on the game's own canvas from the pane, projecting
each body's torso through the chopper's camera — no screenshot was needed, which is as well,
since the pane could not take one.

### C — done (session of 2026-09-15): the intro, planned, proved, and played

**The plan** (`shared/cinematic/IntroPlan.ts`, 885 lines): pure geometry — loose numbers,
`simSin`/`simCos`, no `three`, no clock — so the same function runs in the client on the
freeze's first frame and in the harness on the server build. Three phases in one budget:
of the ten seconds, **1.0 is the player's own view** and **0.5 the blend back to it**; the
plan's segments fill the 8.5 that remain. **Approach** ≤ 3.5 s: the bots' route (a second
`Pathfinder` over the match's `NavGrid`, solved synchronously with `measureLanes`' budget)
from where the player *stands* — the spawn de-penetrated with the player's own capsule, the
way the sim does it on tick one — to the nav bounds' centre on its nearest walkable cell, at
1.65 m, a smoothstep profile whose peak is 9 m/s, **trimmed from the spawn end** past
21 m rather than sped up. **Overview** 1.5 s: a pull-back from the centre to the distance
at which the map's half-diagonal fits a 60° lens, along the clearest of a fan of rays — the
spawn's azimuth at 45° when it reaches 80 % of the way, else twelve azimuths at three
elevations, each *marched with the eye's own sphere* rather than cast as a line, because the
first line ray passed the edge of Foundry's bridge deck by a centimetre and the eye did not.
**Objectives** ≤ 3.5 s: the pull-back *reversed* (0.5 s, clear because the pull-back was),
then a whip along the nav route at eye height to each objective's stand-off (4 m back along
the arrival, 3 m up, the first of five stand-offs the eye finds clear), a 0.3 s hold with
the label, on to the next; the speed profile inverted, peak 40 m/s, a whip capped at 1.0 s;
a route the grid cannot find falls back to an arc above the map (**none did**); an
objective that would overrun the budget is left out. Domination visits **A → B** — the
third flag does not fit 3.5 s at 40 m/s on any shipped map, and the plan says which it
visited; Search & Destroy visits both sites. The deathmatch modes hold the overview.

**Three things the geometry taught, all found by the harness before a frame was drawn:**

- **A Catmull-Rom cuts corners into crates.** The first spline's first bad sample was 0.95 m
  from the nearest waypoint, inside the crate the route was string-pulled around. The route
  is a polyline with 12 cm fillets now; the *heading* is what the eye smooths (a 0.3 s lag on
  the approach), not the position.
- **The bots' route mantles.** Two waypoints a ledge apart are joined by a line the capsule
  is carried through; the camera on that line went through Foundry's box 31 at head height.
  Where the rise exceeds a step the camera goes *up first*, over the lower waypoint, then
  across — and the mirror for a drop.
- **The route hugs corners at the capsule's clearance, and the eye is in the capsule's top
  cap.** At 1.65 m a 0.35 capsule is 0.287 wide, so an eye sphere of 0.3 flagged the route
  the bots walk by millimetres. `EYE_RADIUS` is **0.25** — twice the lens's 0.12 near plane —
  and a `relax` pass pushes any tabulated point the sphere still touches off it with the
  movement system's own `resolveAt`, up to four rounds and 30 cm, then retakes the table;
  a plan reports how many it nudged (one to three, typically).

**`npm run intro`** (`server/intro.ts`, 166 lines; `intro` in `vite.server.config.ts`):
every map × every roster mode × every spawn zone — **299 plans** — collision and navmesh
baked as `MapBakery` bakes them, sampled every 25 cm, asserting zero samples inside a
collider and every phase inside its budget; `--debug` names the collider the first bad
sample is in. The first run failed **106 of 299**; four fixes later, **`INTRO CHECK PASSED —
299 plans`**, 104 of them with objectives (52 A → B, 52 the two sites), 283 approaches
trimmed, 0 arcs. The timeline arithmetic and the Foundry plan are four vitest cases
(`IntroPlan.test.ts`): the budgets phase by phase, the deathmatch hold and S&D's two sites,
the eye clear of every collider from the first spawn, `poseAt` continuous across every seam.

**The client** (`client/cinematic/IntroCamera.ts`, 250 lines). `Game` asks
`introCamera.cameraFor(world, rig, aspect)` once per render frame, before the chopper — the
same asked-not-pushed shape — and while it answers renders the scene through it with no
viewmodel and `hud.setIntro(true)` (`hud--intro` takes down the crosshair, ammo, health,
the tactical strip, the compass and the minimap; the header, the banner and the quick
selector stay). Eligible only for `WARMUP` in round one, not the arena, not the range; the
timeline is `flow.phaseSecondsTotal − phaseSecondsRemaining` (the getter is new on
`MatchFlow`), so a late joiner gets the tail; planned on the first eligible frame and
played once per world. Three blends the plan does not know about: 0.35 s from the rig's eye
into the plan (a push, not a cut — the trim can start it 20 m up the route), 0.5 s back, and
the lens with it, 90° → 60° → 90°. Any key or button skips to the return blend; the digits
that pick a class and `Escape` do not.

**Measured in the pane** — Dunes, Domination, from spawn A, frames stepped by hand: the plan
`approach 3.30 · pullback 1.50 · snap 0.50 · whip[A] 1.00 · hold 0.30 · whip[B] 1.00 · hold
0.30 · hold 0.60 = 8.50 s`, objectives A → B, overview 95 m. The camera at t = 0.05 in the
rig's eye at (−25, 1.7, 32.6) and 88°; t = 2.7 at the centre at 1.6 m; t = 4.7 at
(−41, 69, 53), the overview; t = 5.4 back at the centre with the label A; t = 6.05 at A's
stand-off; t = 8.05 at B's; t = 8.73 blending back at 74°; **t = 9.40 `active = false`,
90°, at the eye, `hud--intro` off** — a second before the freeze lifts, as the budget says.
**Seeded harness normalised-identical** before and after (stash → build → run; pop → build →
run; 142 lines, `t`/`pid`/`simMsMean`/`heapMb` stripped): the harness never renders, and the
one `shared/` seam it can see, `MatchFlow.phaseSecondsTotal`, is a getter. Content probe:
not re-run; nothing under `modes/` or `maps/` changed. `npm run check` green, **125 tests**.

**Found while here — two spawn zones authored against a crate.** Foundry B (−27, 2) and
Depot B (−28, −19): the eye at the zone's position is inside a rotated 6 × 2.6 m crate,
half a metre deep on Depot. The sim de-penetrates the body on its first tick, so nobody has
noticed; the plan starts from the de-penetrated point for the same reason. The zones should
move; a map-data fix, not this phase's.

**Needs a browser:** whether the whip reads as a whip; whether −6° on the approach and the
60° lens are right; the overview's azimuth on Foundry (the fan picked a 75 m ray — which
one, a display will say); and the push out of the eyes at 0.35 s. The pane could not take a
screenshot this session, so the record is poses and pixels, not pictures.

**Gate C is where this stops**, as asked. Phase D — the end of the match — and B6 are the
open items; E after D.

### Between phases — the spawn zones (2026-09-15): seven, not two

The brief named two — Foundry B (−27, 2) and Depot B (−28, −19), the intro harness's first
bad sample on each map. Measured before moving anything, with the standing capsule (r 0.35,
h 1.8) at every zone's authored centre on every map: **seven zones in a solid**, from four
authored positions. Both maps author team A's half and rotate it; the props are
rotationally symmetric and the zones were written mirror-symmetric, so the east flank of
each carries a container where its west twin has open floor. Foundry `put(26.5, −2)` was
10 cm inside the container at (25, −4), `put(26.5, 14)` 10 cm into the corner of the one at
(25, 17); Depot `put(28, 19)` 0.6 m inside the stack at (27, 20); Testbed A (−22, −10) 15 cm
into the west end of the bay divider, under a comment that says every zone is open floor.
The sim's first-tick de-penetration had hidden all seven; the selector snaps every jittered
sample to a nav cell, so only sample 0 — the authored point — ever stood there.

**Two `B:` commits** (`68e8bfd` the brief's two, `966307a` the other three), each placed
by a horizontal clearance sweep against the west twin's number: Foundry's flip zone into
the back alley behind the spine at **(27.6, −2)**, 1.05 m each side — the alley is the
lane's designed feature and it keeps the author's 12 m spacing from B's flank; the flank
to **(26.5, 11.5)**, 2.2 m to the wall like its twin; Depot to **(28, 14)**, the stack's
foot, 1.7 m like its twin; Testbed to **(−22, −11.5)**, 1.4 m. The capsule test reads
**0 hits** after.

**The one place in M15 where byte-identical is not the claim, measured both ways.**
`npm run content` (stash → build → run; pop → build → run): exactly the moved zones and
their rotated twins — four lines, then three. Seeded harness (5 TDM on Foundry, 141
lines): lines 1–92 identical — mode briefs, roster deals, XP shapes, the bake — and the
35 line-pairs after are the match outcomes, **structure identical with every numeral
stripped**. `npm run intro`: **299 PASSED** both times, the diff only the moved zones'
rows (Foundry's alley plan is the same 21 m route; Depot's approach 5 m nearer, trimmed
12 m not 18). `npm run check` green, 125 tests.

## Phase D — the end of the match: the lineup and the accordion

**D1, the lineup.** Top half: the winning team — in Free-for-All the top three — on a stage,
MVP centre and a step forward, each a `CharacterSkin` wearing the body the match dealt them
(`characterSelector.characterIdFor(entityId)` from the world's own selector, so the body on
the podium is the body you shot; the local player's is their picked skin once B5 lands),
holding their last weapon, `idleWeaponReady`, nameplates in team colour beneath. A full lobby
puts five on the stage; the frame has room for five at 1920. The scoreboard does not leave: a
SCOREBOARD toggle flips the top half between the lineup and the board the player has held Tab
on all match — the same `Scoreboard` instance, as S6.5 insists.

**D2, the accordion.** Bottom band, fixed height, bottom-anchored. Collapsed: the total XP,
the level bar and the level number — and the existing `XpSummary` animation plays *there*:
rows land, the bar fills behind them, a level-up interrupts, exactly as S6.1 built it; only
the rows are hidden until asked for. Expanded — on click, or on its own when the cadence
finishes — the row list grows **upward** inside the band (`max-height` animated on a
bottom-anchored list) to a ceiling the frame sets, so the page never moves and the probe never
sees an overflow. The unlock list (weapon levels, challenges, camos) is the accordion's last
rows. The buttons — CONTINUE, and EXIT where there is a server, as round 4's B4 settled — sit
in the band's right end and never move.

**Gate D.** `npm run layout` green on the summary at eight viewports, collapsed and expanded,
with 2, 6 and 10 players (the probe already mounts it with fixed rows); `progression`
byte-identical (the numbers the accordion shows are `XpReport`'s, and this phase does not
touch `XpRules`); the pane, the S6.1 cadence timed against its constants.

### D — done (session of 2026-09-15): the lineup, the toggle, the accordion

**The stage is B1's, with a list on it.** `CharacterStage` (327 → 475 lines) takes `StageOptions`
— the editor's disc and turntable are the default, so `LoadoutEditor` and the thumbnail
script are untouched — and a list of `StageFigure`s: `show(id)` is a lineup of one, and
`showLineup(figures)` the same list with five. `LINEUP_STAGE` is an 1824×560 canvas, a
6.8 × 2.6 m platform with the ring's accent as a frame round its edge, a lens 5.3 m back
(6.2 left the bodies a quarter of the height, measured in the pane), and no turning. Every
figure is the same `ActorAvatar` a match draws, `idleWeaponReady`, holding `buildHeldWeapon`.

**Who stands where** is `ui/Lineup.ts` (97 lines, nine vitest cases): `lineupOf` — the
winning side in ladder order, Free-for-All's top three with the crowned winner pinned first
for `personalOutcome`'s reason, a draw's best five — and `slotPositions`: the MVP centre and
0.45 m forward, the rest fanning out by rank at 1.25 m, the flanks turned in. **What each
wears and holds** is `LineupSource`, answered by `Game`: the world's own
`RandomCharacterSelector` (kept on `Game` for the world's life), `profile.skinId` for the
local player, and the weapon in each entity's hands from `Match.actorsForRender` — the
renderer's own supplier, exposed once — or `weapons.definition.id` for the local player.
**Nameplates** are DOM, in viewer-relative team colour (`relationTo`, the board's rule),
placed under the feet by `projectToCanvas` through the stage's lens — pure arithmetic, so
the probe measures them on a page that never draws. **The toggle** is two tabs over the
same `Scoreboard` instance; `.eom .sb--embedded` is 1600 wide so the blocks stand side by
side at the frame's ramp.

**The accordion.** `XpSummary` (352 → 446) is a bottom-anchored column: the strip — one
`<button>`, LEVEL · bar and label · total · chevron — and the list above it, `hidden` until
it opens. The cadence is the constant it was: rows land on `ROW_INTERVAL` into the hidden
list, the bar fills behind them, a level-up interrupts with the flourish now absolute over
the strip. `open()` un-hides, reflows at `max-height: 0` and transitions to
`--xp-list-ceiling` (196 px in a 300 px band); `open(true)` is the probe's instant path;
DONE opens it on its own. The rows are three across, so twelve lines are four rows under
the ceiling with the tail beneath. CONTINUE / EXIT are the band's right cell, `align-items:
end`, on the strip's line. The `.eom .op-frame` old-ramp pin is gone, as it said.

**Gate D.** `npm run layout`: **28 surfaces × 8 viewports, PASS** — `summary/2`, `/6`, `/10`
folded and open (`/xp`) on the fullest report the accordion can be handed (twelve lines,
two of each unlock kind), `summary/board`, and `summary/ffa` on both tabs, the sixteen-row
ladder. The first green run measured the easy state — the probe had never un-hidden
`xpSlot`, which `GameScreens` does — and the picture caught it before the number did.
`progression` byte-identical (stash → build → run, pop → build → run; 50 lines, `cmp`).
`npm run check` green, **134 tests** (boundaries 360 files). **Pane**, a real solo match at
1920×1080 ended by the clock: five bodies on the platform — `hazard` with the sniper as
MVP, `echo` with the shotgun, `sentry` with the SMG, `sentry` with the Vulcan, `apex` — the
plates at 21 / 36 / 50 / 64 / 79 % under the feet, the MVP's lower for its step; a second
match VICTORY with OPERATOR at the end in the picked skin. **The cadence:** rows at +0,
+334, +346 ms — 0.34 s, frame-quantised; the bar 15 → 1,025 through a level-up; the list
opened on its own with `.xp__strip` at y 960 before and after, CONTINUE at 968 unmoved. The
LEVEL 3 flourish caught over the strip (217 × 95 at the accordion's centre). SCOREBOARD tab:
the board at 1600 wide, two 776-px blocks; the strip clicked shut and open again, y 960
throughout. **GPU:** the stage's own renderer at **17 geometries / 44 textures, flat over
20 lineup → release cycles**, every lineup ready within four ticks on the warm cache.
**Bundle:** 1 551.83 kB raw / 447.57 gzip / 60.22 CSS (C left it at 1 545.22 / 445.66 /
57.18). Nothing in `shared/` or `server/`.

**Needs a browser:** whether 5.3 m is the right distance with five bodies at play distance;
the flanks' 0.11 rad/m turn-in; the plates' size against the bodies; whether the list should
open on its own or wait for the click.

## Phase E — combat behind the menu, last

Decision 1 chose a live render over a video, and the reference asks for *combat*. Phase A's
dolly is the map; this is the fight: a solo `Match` on the backdrop map with a full roster of
bots and **no player entity**, the sim stepped by the frame loop in `MENU` as it is in
`MATCH`, the camera on the dolly. What it costs, and why it is last: a `Match` in `MENU` is a
world outside the state the state machine builds worlds for (`Game.buildWorld` is `MATCH`'s);
its bus subscriptions, its bots' `Pathfinder` arrays and its GPU resources are a new thing for
a 100-cycle leak instrument to see — and the menu is entered and left more often than any
match; and ten bots thinking at 60 Hz behind a menu is CPU a laptop on battery notices. So it
ships with three numbers or not at all: the leak count flat over 100 MENU ↔ MATCH cycles, the
sim's ms per frame in the pane, and the bundle delta. If the numbers are wrong, A3's dolly is
the menu — and that is a menu that already meets the brief's *"edges blend and fade"* clause
in full.

### E — done (session of 2026-09-15): the fight, on its three numbers

**What it is** (`client/world/MenuSkirmish.ts`, 275 lines). The shape `server/Match.ts` has
for a match with nobody at the keyboard: the map's own `CollisionWorld`, a `BotDirector`
over a navmesh, `DamageSystem`, `ScoreSystem`, Team Deathmatch, `MatchFlow`, and an empty
seat in the player's place — thirty lines restating the server's `Spectator`, the boundary's
price — with a full roster (the map's team size a side, nobody's seat held back). On top, the
two things a fight needs to be seen: `BotRenderer` with its indicators off (one new switch)
and `Fx` for the muzzle light, tracers and impacts, on a **`GameBus` of its own**, so no HUD,
announcer or audio hears a shot fired behind the menu. `Game.simulate`'s no-world branch
hands the loop's fixed step to `MenuBackdrop.simulate`; `frame` gets the loop's `alpha` and
poses the bodies between steps through the dolly's camera. The round-one freeze is taken at
eight sim steps per loop step — the bots are frozen in it, so nothing is seen to hurry — and
a finished match is replaced by the next seed on the step that found it over. **The navmesh
is baked in `prepare`**, once per map per page, before the map's first frame: in the frame
the map landed it was a 475 ms hitch (bake 228 of it; the second build on a cached grid is
5.5 ms). `backdrop.combat = false` is Phase A's dolly alone, and it is the switch the phase
ships behind. `__p7.leaks()` (DEBUG.md) reads live bus subscriptions, the GPU counts
and the JS heap in one call.

**The three numbers, in the pane** (Foundry, 5 v 5, 1920×1080):

| Number | Measured |
|---|---|
| Leak, **100 MENU ↔ MATCH cycles** | 19 under rAF and 81 with `loop.frame` driven by hand once the pane hid rAF. Bus subscriptions **12 at the menu, 124 in the match, on every cycle**; match geometries **66 every cycle**; textures in an 80–86 band once the first cycle had cached the seven skins (56 → 82). Then, sampled *quietly* — the skirmish disposed at the menu after those cycles — **51 geometries / 63 textures / 0 subscriptions, identical across nine samples**; heap 100–154 MB, GC noise, no trend. Nothing the fight allocates outlives its `dispose` |
| Sim, ms per frame | **0.269 mean, 1.0 max** with the fight on, 0.011 off (300 frames each, the pane at its 30 Hz — two steps a frame, so ~0.13 ms a step); render 2.93 ms against 0.97 for the bodies and their shadows |
| Bundle | **1 555.81 kB raw / 449.42 gzip** (D left it at 1 551.83 / 447.57): **+3.98 / +1.85 kB**, CSS unchanged at 60.22 |

The picture, through the sink: a body in the hall firing with the tracer crossing the lens,
another in the yard, the impacts on the crate — the map the menu's picker names, fighting.
Sixteen kills in the first 45 s of sim.

**Found while measuring — two one-time hitches on the page's first menu.** Hand-driven
frames, which are honest for CPU work: the map's adopt frame **153 ms** (A3's, the mesh
uploads — unchanged by E), and, some seconds later, a **~500 ms frame as the seven skins
land** — the same parse-and-upload the first match has always paid under its intro, now paid
where the menu can show it, once per page. The bake was the third and is gone from the
frame. Whether half a second on the first menu is acceptable is the human's; the alternative
is to preload the skins the way `echo` is preloaded at boot, which is a line, or to hold
the skirmish until the first match has warmed them, which is a rule.

`npm run check` green (134 tests; boundaries 361 files); `npm run layout` PASS, `npm run
intro` 299 PASSED; nothing in `shared/` or `server/`.

**Needs a browser:** whether bodies crossing the dolly's lane at eye height read as a fight or
as a collision; the tracers' brightness against the fade; whether the fight should be
silent — it is — or carry the gunshots at the menu's mix; the first-menu hitch on a real
machine.

## What each item breaks

- **B1/B2's fix is replaced, not removed.** The `safe center` + `overflow: auto` reasoning in
  `app.css` was right for the rule it served; the comment is rewritten to say the rule changed
  and where the length went, so the next reader does not restore it.
- **B11's test becomes moot.** Preserved scroll was the test that the editor's DOM is not
  rebuilt; with paging there is no scroll to preserve. The in-place refresh stays, for the
  reason it was built — a rebuilt tree is a lost tooltip and a jumped strip — and the test
  becomes "the open strip's page survives an edit".
- **`Menus.ts` and `LoadoutEditor.ts` are rewritten**, 1 328 lines between them; `Settings`
  gains a tab; `EndOfMatch` and `XpSummary` are restructured with S6.1's timing kept to the
  constant.
- **`probes/layout.ts`** gains a rule and loses the premise of one; `Viewports.ts` gains two
  rows.
- **`SaveData`** goes to v4 (B5); **`EntitySnapshot`** gains a byte (B6, if taken).
- **`Game`** gains a world that is not a match (A3), a camera that is not the player's (C) —
  both asked-for rather than pushed — and a state (`MENU`) in which the frame loop renders.
- **Nothing in `shared/` changes before B6**, which is why the harnesses are byte-identical
  through A–D and why B6 is the one step with a netharness bill.

## Decisions waiting on the human

| # | Decision | Recommendation |
|---|---|---|
| 1 | ~~Menu backdrop: live render or a supplied video?~~ **Taken (2026-09-15): live render.** No video asset exists; 5–20 MB against 391 kB is a multiplier, not a percentage | — |
| 2 | ~~Skin picker: local-first, or the wire field in the same milestone?~~ **Taken: local-first**; B6 is the wire step if B1–B5 land with room | — |
| 3 | ~~The floor viewport?~~ **Taken: 1280×720.** The rule still holds below it; legibility is not promised | — |
| 4 | ~~Archive M14 to open this section?~~ **Taken**, this session | — |
| 5 | ~~Three skins are 24–38 MB (Viper, Echo, Hazard) against 4–5 MB for the other four, and the 28 MB one is the default that preloads at boot. Recompress, and change the default?~~ **Taken (2026-09-15): yes, before B1** — a `B0` step: recompress the three to the four's size and make a 4 MB skin the default. A `gltf-transform` pass run once, not a build dependency | — |
| 6 | ~~Phase E: run the fight behind the menu, or stop at the dolly?~~ **Taken: proceed**, provided the three numbers hold — the leak count flat, the sim's ms per frame, the bundle delta. E ships on them or not at all | — |
| 7 | ~~QUIT in a browser: a `MENU → BOOT` edge, or leave the button out?~~ **Taken: no QUIT button.** A tab closes itself; the menu has four entries | — |
| 8 | ~~The intro on Search & Destroy rounds two onward?~~ **Taken: round one only.** The freeze is round one only and exists for the class pick | — |

## Dependency order

1. **A1** first and alone — the scale and the probe rule, run against every screen as it is,
   so the overflow list is a measurement before anything is redesigned.
2. **A2–A4**, then **B**, then **D** — three screens, each behind the probe; B before D
   because D's lineup is B1's stage with five bodies on it.
3. **C** independent of B and D; after A1 only because its HUD labels live in the frame.
4. **B6** after B5, if room.
5. **E** last, on its numbers.
6. **M12's content**, in M12's order — unchanged by anything here. F4(a)'s "skins as
   parameters" is answered by M13's glTF skins and B5's picker; the F4 row should say so when
   M12 is next touched.

## Needs a browser

Everything about *feel*, and nothing about *fit*: whether the nav buttons read as smeared
rather than broken, the backdrop's fade against a bright map, the stage's key light on a dark
skin, the whip, the pitch, the accordion's rise. Fit is the probe's, at eight viewports, and a
report that a screen "looks cut off" is answered by running it.

## How to start — the next brief

**Every phase of Milestone 15 is done** — A, B, C, D and E, each recorded above with its
gate's numbers, plus the seven spawn zones between C and D. E shipped on its three numbers
(the leak flat over 100 cycles, 0.27 ms of sim a frame, +4 kB) and stopped at its gate, as
asked, with one thing for the human: the page's first menu now pays the skins' ~500 ms
parse once, where the first match used to pay it under the intro. **B6 is deferred past
this milestone** (the human's call, 2026-09-15). What is left is the close: the human's
verdict on E's numbers and its hitch, then this section moves verbatim to
`docs/archive/plan/22-m15-front-end.md` with the provenance line the other files carry and
a row in the index, the way M13 and M14 closed — `npm run check:plan` holds the file to it.
The milestone after opens on B6: `characterIndex: u8` on `EntitySnapshot` and the join,
`RandomCharacterSelector` as the fallback for a body that declared none, `check:authority`
and the netharness over it — the one `shared/net` change M15 deliberately did not make.
