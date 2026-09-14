<!-- Moved verbatim from PLAN.md lines 515–1753 at f064449 (2026-09-14). Less Phase E — its section, its brief and its two table rows — which the human cancelled that day rather than carry it forward; nothing else rewritten. Part of the OPERATOR plan record; PLAN.md holds the index. -->

# Milestone 13 — proposed: bodies that read, and one answer to "is this an enemy"

Planned in the session of 2026-09-13, from the human's own list: the enemy markers, the crouch,
an animation library, six bugs from the multiplayer playtest and three feature requests. The
mechanism behind every bug was read in the tree before it was written down here; the ones that
turned out to be one mechanism wearing three reports are grouped that way. **No product code was
written for this section.** The review that preceded it — commit `8309b86` — is summarised first,
because it is the tree a fresh session inherits.

## The tree a new session inherits (what changed since round 5)

- **Bodies are skinned GLBs.** `client/characters/` is the pipeline (`docs/CHARACTER-ASSETS.md`
  has the ownership diagram): a catalogue of seven skins, an app-lifetime asset service, a
  match-scoped provider per actor, `SkeletonUtils.clone` per body, a mixer per body, and a
  CCD constraint that puts the left palm on the weapon's support grip. The procedural `BotMesh`
  is the fallback while a template loads. Animations are eleven Mixamo clips, one file each,
  fetched once per URL and prepared per skin.
- **The rig identity of round 5 is loosened one step further.** The GLB avatar ignores
  `heightScale` entirely and plays a crouch clip instead (`CharacterAvatar.update`). The hitbox rig still scales uniformly. That gap
  is Phase C, and it is measured before it is decided. *(Phase C, 2026-09-14: measured, and
  closed — the rig wears one of four layouts chosen by the same rule that chooses the clip;
  see "Phase C — done".)*
- **IFF is a separate layer, not a body tint.** `ActorIndicator` draws a nameplate, a continuous
  segmented health bar and — today — four emissive spheres on hostile arms and knees. Every
  colour comes from `ui/Palette` and repaints on a palette serial; friendly is blue in the base
  palette as of `8309b86`, chosen there so the nameplate, the minimap and the killfeed agree.
- **Bots face where they walk because the simulation says so.** `OBJECTIVE` is a travelling
  state in `isTravellingState`; the render-side yaw override that briefly stood in for that is
  gone, and the reason it had to go is recorded on the predicate: the hitbox rig, the spectator
  camera and `Mantle.detectMantle` all read `sim.yaw`, and a `RemoteActor` never saw the
  override at all.
- **The animation library is a folder of slots** *(Phase D, 2026-09-14)*:
  `public/models/bots/animations/{locomotion/{stand,crouch,slide},transitions,actions,deaths,hits,incoming}/`
  with its own README; the catalogue's `CharacterAnimationId` is a slot holding variants, dealt
  by `variantFor` from `(entityId, spawnSerial)` and deaths by the simulation's `deathVariant`;
  `npm run animations` reads any GLB in Node, `scripts/animation-import.mjs` moves a file out of
  `incoming/` as one named clip (every shipped file is on that contract; the eleven originals
  were rewritten in place under decision 13), and `check:animations` is in the gate. See
  "Phase D — done".
- **Skins are dealt from a seeded `Rng`** (`RandomCharacterSelector`), keyed by the save's
  lifetime match count and the session's build count. Client-local: two clients do not agree on
  a bot's skin. The end state is a server-chosen `characterId` in the snapshot (Phase B's shape,
  not its scope).

## Phase A — one hostility predicate

Three of the six reported bugs are one defect. "Is `b` an enemy of `a`" is answered in five
places, and only some of them know the mode is Free-for-All:

| Site | Knows FFA? |
|---|---|
| `shared/ai/Perception.ts:239` | yes — `freeForAll` |
| `shared/ai/SpawnSelector.ts:425` | yes |
| `shared/combat/ScoreSystem.ts:285` | yes |
| `shared/combat/DamageSystem.ts:267` | via `friendlyFire = true`, set by `Match` and `ClientMatch` for FFA |
| `shared/streaks/SentryGun.ts:224` | **no** — `c.team === this.team` |
| `shared/streaks/Uav.ts:60` | **no** |
| `shared/streaks/ChopperGunner.ts` and `Game.draw`'s hot/cold split | **no** — cold is "the gunner's side", which in FFA is half the lobby |

That is the sentry that will not fire at half the room, the UAV that does not show them, and
the Chopper that draws them near-black (the "black hit indicator" report is the thermal pass
drawing a same-substrate body cold). `FreeForAll.ts` keeps the two-team substrate on purpose and
says so at length; the substrate is fine, the predicate is scattered.

**Do:** one function, `isHostile(viewerTeam, subjectTeam, freeForAll)` beside `relationTo` in
`shared/ui/TeamColour.ts` or its own `shared/combat/Hostility.ts`, and every site above calls it.
`freeForAll` reaches the streaks through `StreakSystem` the way it reaches `BotDirector`. The
gunship pass in FFA is handed *both* body groups as hot and nothing as cold.

**Also in this phase, because it is the same predicate on the client:**
- **Bug 4.4** — `MatchResult.winner` is a `ScoreTeam`, so in FFA everybody on the winner's
  substrate side reads VICTORY. Add `winnerEntityId?: number` to `MatchResult` (set by
  `FreeForAll.checkWinCondition`, which already knows the leader), carry it in `SummaryInfo`,
  and let `EndOfMatch`/`XpSummary` decide VICTORY / 2ND / 3RD per recipient when it is present.
  `Scoreboard` and `HudBanner` in FFA: one ladder sorted by score, no columns, no team totals.
- **Bug 4.1** — the body, the nameplate, the minimap and the Chopper are already
  viewer-relative. The one absolute site left is `client/streaks/StreakMeshes.ts:39` — the
  sentry body coloured by `team === 'A'`. Route it through `relationTo`. **Verify the report
  still reproduces before spending more than that:** the description ("friends red, enemies
  grey") predates `8309b86` and may be the thermal pass in FFA, which is the row above.

**Gate:** `npm run skirmish` with `--vote` targeting FFA and the wallet cheat `MO951357` typed
by a headless client (it already types cheats and counts streak entities) so it can afford and
place a sentry — sentry kills against same-substrate players **> 0** (today 0 by construction); the FFA summary names one winner and
everybody else a place; `grep -rn "=== 'A'" src/client` returns only `BotRenderer.groupFor`,
`Game.draw`'s enemy-group choice and the debug panels. Size **S–M**.

## Phase A — done (session of 2026-09-13/14): one predicate, ten sites, and a place instead of a side

Built to the brief above. Three departures from it, each stated where it happened; the gate ran
red on the tree before the fix and green after, and every number is below under "Measured".

### The predicate, and where it lives

`shared/combat/Hostility.ts` — `isHostile(viewerTeam, subjectTeam, freeForAll)`. In `combat/`
rather than beside `relationTo` in `ui/`, because `ai/`, `streaks/` and `equipment/` are
simulation and `combat/` is the layer they already sit on (`Damageable.team` says the same about
the direction of that dependency). `relationTo` is now that function plus the `NEUTRAL` answer,
so there is still one test; the `readability` probe over `(viewer, subject)` is unchanged and
still 12 pairs, 0 violations.

**It decides sides, not identity.** In Free-for-All everybody is hostile — the viewer's own
substrate side included, and therefore the viewer — because the substrate cannot tell the two
apart. Every caller skips the self case by entity id, which four already did and which the
sentry, the UAV and the danger arrow had to learn: a sentry with the predicate alone shoots
its owner.

### The sites — seven in the table, ten in the tree

| Site | What changed |
|---|---|
| `Perception`, `SpawnSelector`, `ScoreSystem` (kill and assist) | the `!ffa && same` guard became the call; truth table identical, and the TDM harness proves it (below) |
| `DamageSystem` | **`friendlyFire` is renamed `freeForAll`.** Nothing had ever set it for any other reason; it was the FFA flag wearing the name of a ruleset that does not exist. `Ballistics.nearestTarget`, which read it to pass rounds through teammates, goes through the same call |
| `SentryGun.acquire` | `isHostile` plus an owner skip; `StreakContext.freeForAll` is a required field both roots supply |
| `Uav.onTick` | same pair |
| `Game.draw` | the gunship pass takes **lists** — `renderGunship(scene, cam, hot[], cold[])` — and the groups are dealt by `isHostile` over `match.viewer`. FFA: both groups hot, nothing cold. The gunner's own body is never in either group (`NetSession.syncActors`), so that is exactly right |
| `EquipmentSystem.stepTrigger` | **not in the table.** A claymore compared `c.team === p.team` and would not fire on the half of an FFA lobby sharing its owner's side — the sentry bug wearing a different body. `EquipmentDeps.freeForAll`, required, both roots and `AccuracyAudit` |
| `EquipmentSystem.noteThreat` | **not in the table.** The danger arrow stayed down for that half's grenades. Needed a `localId` on `simulate` so the player's own grenade is not a threat to them once the side test says everything is |
| `BotThrower.isSafe` | **not in the table.** A bot would not throw where a same-side body stood. Reads `system.freeForAll` |

The table's seventh row (`ChopperGunner.ts`) needed nothing: the gun's target selection is
`Ballistics.nearestTarget`, which `damage.freeForAll` already let through in FFA; only the render
pass was wrong. The three extra sites came from the audit the brief asked for, widened —
`grep -rn "\.team === \|\.team !== " src/shared` — and were done here because they are the same
defect and each was three lines. What that grep still returns and why it is left: `MatchFlow:631`
sets `KillEvent.friendly` by side, read only by TDM and Domination, so FFA never sees it;
`SpectatorTarget.isWatchable` lets a dead player spectate same-side bodies only, which in FFA is
half the lobby — a design question (decision 7 below), not a bug report.

### Bug 4.4 — a winner is an entity, and everybody else has a place

- `MatchResult.winnerEntityId?` and `SummaryInfo.winnerEntityId?` (**protocol v16**, an `i16`,
  `-1` absent). `FreeForAll.checkWinCondition` sets it from the row it already decided on.
- `shared/modes/MatchOutcome.ts` — `wonBy`, `personalOutcome`, `placeOf`, `ordinal`. **The one
  reader.** The four places that compared `winner === localTeam` — `EndOfMatch.show`,
  `MatchFlow.endMatch` (the announcer cue), `Game`'s `won` (the WIN BONUS line and the profile's
  win tally) and the layout probe — all ask it.
- A fifth reader was found on the way: `MatchFlow.adoptReplicatedEnd`, which *reconstructs* the
  result on a networked client from the two side scores before the summary lands, and announces
  from it. `GameMode.individualWinner()` (FFA: the same kills scan `checkWinCondition` uses, over
  the client's replicated rows) feeds it. The summary screen itself uses the server's answer.
- **Places.** `personalOutcome` ranks the reader on the ladder with `compareRows` — lifted out of
  `Scoreboard.refresh` into `ScoreSystem` so the board and the place cannot disagree — with the
  winner pinned to first whatever the ladder says (the mode decides on kills, the ladder ranks on
  score first, and in single-player a headshot is half a kill in points). Ties share an ordinal:
  two players at 0/5/0 both read **7TH**, which is what competition ranking means and what the
  final run produced.
- **The board.** In FFA `Scoreboard` hides its second block, moves that block's row slots under
  the first, heads the one column `OPERATORS` with no side colour, and fills it from one sort;
  the move is reversed on the next team match because the summary's board outlives every match
  it shows (checked on one instance: FFA show → team show leaves 8 + 8 under ALLIES / AXIS).
  `EndOfMatch`'s detail line names the winner where there is one — `PENNANT wins · Kill limit
  · 11 — 8`. `HudBanner` needed nothing: it has drawn leader / you in FFA since Gate B.
- **A summary row that never played.** The first green run placed the three clients **11TH, 9TH
  and 9TH in an eight-body match.** `ScoreSystem` never removes a row (4.3), every live match
  spawns its full roster before anybody migrates in, and each human seated leaves the replaced
  bot's `0/0/0` row behind — eleven rows on the wire, and a place counted over them.
  `LiveMatch.buildSummary` now drops a row that is blank *and* whose body is neither seated nor
  on the roster; a leaver's record stays, as `removePlayer` intends. **Phase B replaces this rule
  with rows that follow seats** — it is the one place the stopgap lives, and it says so.

### Bug 4.1

The human tested a two-window match from team B before this session: team-mates read as
team-mates. The one absolute site left was the sentry body, and it is a `TeamRelation` now:
`SentryMesh` takes the relation, paints from the palette (friendly or hostile at half
brightness — under the base palette within a few units of the two hex literals it replaces) and
repaints on a palette change; `StreakRenderer` decides the relation from `viewer` and the owner
id, so your own sentry is friendly in FFA too. Both `grep -rn "=== 'A'" src/client` and the
palette rule are satisfied; the audit's actual residue is `BotRenderer.groupFor`, the debug
panels, `HudBanner`'s two slot picks, `ClientMatch`'s S&D alive count, `MatchObjectives`' capture
count and the layout probe's fixture names — every one a "which side is the other side" in a
mode that has two, none a hostility test.

### The instrument

`npm run skirmish -- --wallet-streak <id>`: every client fields `[id, null, null]` and types
`MO951357` once seated in the live match — a purchase that crosses the wire the way a player's
does, with `cheatsEnabled` implied and `--cheats` refused beside it. The server folds every
sentry, live and retired, into `StreakSystem.sentryReport()` (`SentryTally`: placed, shots, hits,
kills, **`killsOnOwnSubstrate`**); the harness samples it while the match runs, prints it, and
under `--wallet-streak sentry` on FFA fails on `killsOnOwnSubstrate === 0` once any kill has
landed, and on any team mode fails on it being anything but 0. Each headless client records what
its summary said to *it* — `personalOutcome` over the wire's rows with its live seat — and the
harness requires one named winner across clients, at most one VICTORY, and a place for everybody
else in FFA.

One latent gap fixed on the way: `streakHarnessClass` now fields the granted or wallet-bought
streak. Since the wallet pivot (`0a2038a`, 2026-09-01) `--grant-streak chopper` had credited a
wallet against a class that could only buy a UAV, so `--drop-gunner` waited for a chopper nobody
could call in.

### Found while here, not fixed

- `MatchHud.ts:282` and `:347` compare `entityId === 0` — the single-player constant, in the
  friendly-chevron loop and the gunfire-ping filter. Over the network the local player is entity
  1 or above, so in FFA their own shots ping their own minimap. Identity, not hostility;
  `MatchHudDeps` has no `localId` to route it through. Two lines once it does.
- The skirmish harness prints *"background build: the return to the arena was NOT EXERCISED —
  no match ended in this run"* on runs where three summaries arrived and three clients migrated
  back. The F13 line keys on something other than the summaries; stale, and worth one look.
- Every headless client's XP line reads `WIN BONUS 250, TOP OPERATOR 100` at 0 kills — Phase B's
  4.2, visible in every run.

### Human playtest, when Phase A is closed

None of this can be seen headless: the thermal pass in a networked FFA (everybody orange, nobody
near-black — the "black hit indicator"); the sentry body's tint from a team-B seat and from an
FFA seat; a claymore triggering on a same-side body in FFA; the danger arrow for a same-side
grenade; and the announcer at the end of a networked FFA saying "victory" to one player.

## Phase B — the scoreboard and the XP award become replicated facts

Two more reports, one shape — the one `scripts/check-authority.mjs` exists for: a fact the
server owns, read off a local copy.

**Bug 4.3, the duplicate row.** A client's scoreboard is built *only* from replicated events
(`Messages.ts:139` says so), rows are keyed by `entityId` and never removed
(`ScoreSystem.register`). So: a return inside `RECONNECT_GRACE_MS` (30 s) reclaims the same
entity and there is one row — the skirmish harness's reconnect case proves exactly this. A return
*after* the grace seats a new entity: a second row with the same name, the old one still
standing with its kills. And in either case the returning client itself sees zeros for everyone,
because it was not there for the events. Both halves of the report are true.

**Do:** the scoreboard becomes state. A `scoreboard` message — the full row set, sent on every
seat assignment and on change, delta-compressed like the snapshot — and the set *is* the
authority: a row absent from it is removed. Phase A left one stopgap for this to retire:
`LiveMatch.buildSummary` drops a row that is blank and whose body is neither seated nor on the
roster, because the summary's rows were placing FFA players 11th in an eight-body match. With
rows that follow seats, the summary carries the same rows and the rule goes. On the server, a row outlives its seat for the match
and is keyed by the reconnect token as well as the entity, so a post-grace return **adopts** the
row rather than opening a second one. One line in `check-cosmetics.mjs`'s allowlist for the new
message, with the §4.15 row it sits in ("scores"). Extend `skirmishHarness --reconnect` with the
after-grace case; the invariant is *rows on every client === rows on the server*, counted.

**Bug 4.2, the XP award.** `LiveMatch.buildXpLines` builds **one** list for the whole match and
`SummaryInfo.xp` broadcasts it: WIN BONUS and TOP OPERATOR go to every player, and there is no
kills, assists, objective or streak line at all — the dedicated server pays nothing for a kill.
The function's own comment says as much ("awarded to every player in the match rather than to
the ones who earned them") and defers it to a networked-economy change. This is that change.

**Do:** `shared/meta/MatchProgression` is already the event-driven ledger the single-player
summary uses, keyed to `PLAYER_ENTITY_ID`. Instantiate one per seated human on the server keyed
to that seat's `entityId`, and make `SummaryInfo` per recipient (unicast) with `xp` from the
recipient's own ledger; `win` is `wonBy(result, row.team, entityId)` — the one reader Phase A
built in `modes/MatchOutcome` — and `mvp` is `rows[0].entityId === recipient`. `shared/debug/MatchXpAudit` grows a second
half: the same event sequence through a server ledger and a solo ledger must produce the same
lines. Size **M–L** for the pair; the scoreboard first, because the XP lines want its rows.

## Phase B — done (session of 2026-09-14): the board is state, and the XP is the seat's own

Built to the brief above and to Phase A's hand-off. Two facts moved to the server; each one's
readers were found by the grep the standing lesson names; the reconnect harness ran red before
the adoption landed and green after; the numbers are under "Measured".

### Bug 4.3 — the scoreboard as replicated state

- **`MsgS.Scoreboard` (protocol v17).** The whole row set with `ScoreSystem.serial`, every
  column the modes can draw (`ReplicatedScoreRow`, pinned in `check-cosmetics` under §4.15's
  "scores" row beside the snapshot's fields). **Not delta-encoded**, and that is a departure from
  the plan's "like the snapshot", stated: the set is bounded at 24 rows of ~30 bytes, which is
  smaller than one full snapshot, and a delta scheme needs the ack ring the snapshot has. Instead
  `MatchInstance.sendScoreboard` sends a seat the board when the serial differs from the one that
  seat last received, no more than four times a second, and every two seconds regardless — so a
  frame lost under `--net bad` is corrected without an ack. A fresh seat starts at serial −1 and
  gets the whole board on its first snapshot tick, which is the "returning client reads zeros for
  everybody" half of 4.3. Measured: ~500 boards per client over a 150 s match, i.e. the rate
  limit, not the snapshot cadence.
- **The set is the authority.** `ScoreSystem.applyReplicated` upserts what the wire carries and
  removes what it does not, in place — the row object a `Scoreboard` slot bound stays the object
  it updates. A networked `ScoreSystem` is constructed `authoritative: false` and makes none of
  its bus subscriptions, and `MatchFlow`'s replicated branch no longer records kills at zero
  points: a replica that also counted for itself would hold two answers and flicker between
  them. `NetSession.onRosterEntry` — the per-frame registration from snapshot bodies — is gone.
- **Rows follow seats.** `ServerMatch.removeBotForSeat` removes the replaced bot's row
  (`ScoreSystem.remove`); a leaver's row is kept, as `removePlayer` always intended. Phase A's
  blank-row stopgap in `LiveMatch.buildSummary` is retired — the summary rows are the board.
- **A return adopts its row.** Inside the grace nothing changed: the same entity, the same row.
  Past it, `LiveMatch.rowOwners` maps the reconnect token a lost seat carried to that seat's
  entity, and a join-in-progress presenting an expired claim (`Server.onJoin` now passes the
  claim into `seat`) has the old row re-keyed onto the new entity by `ScoreSystem.adopt` —
  counters and name kept, id and side the new seat's, team totals untouched because they were
  credited when the kills happened. `adopt` replaces the blank row `addPlayer` just registered
  and keeps any non-blank one. F8's post-grace semantics are unchanged: the seat is *not*
  reclaimed, the player is told, and the harness still asserts both.

### Bug 4.2 — XP per seat, from the seat's own ledger

- **`shared/meta/MatchLedger`** is the counting half of `MatchProgression`, lifted out and keyed
  to any entity: the six subscriptions, the per-tick sample, the described `KillFact`, the
  per-weapon tallies, and `lines(won, isMvp, seconds, extras)`. `MatchProgression` composes one
  for entity 0 with the two things only a client has — the challenge tracker (fed through
  `onKill` / `onFlash`) and the profile — and banks as before. One counting, two runtimes.
- **`LiveMatch` keeps one ledger per human ever seated**, created with the seat, kept for the
  match (a reclaim finds it; a post-grace adoption re-keys it beside the row), disposed with the
  instance — `npm run leak` stays at 29 → 29 subscriptions. `buildSummaryFor(seat)` is the common
  summary plus that seat's lines, with `won` from `wonBy` (Phase A's reader; `WinnerFacts` so the
  server's result fits) and `mvp` from `isMvp` — lifted from `MatchMeta` into `MatchOutcome`,
  strict top score, ties to nobody, and the client now calls the same function. `Server` sends
  the summary per seat. The old `buildXpLines` — WIN BONUS and TOP OPERATOR to everybody — is
  gone.
- **The wire names a row by its `XP_SOURCES` index** (`SummaryXpLine { source, count, amount }`)
  rather than by a label: both sides compile the table, the client rebuilds a full `XpLine`
  from one byte, and the summary panel can draw `x7`. A byte outside the table is dropped rather
  than drawn as something it is not.
- **Objectives pay now, in both runtimes.** `noteObjective` had no caller since M6, so
  Domination's 200 per capture was a row in the table nothing ever produced. `lines` reads the
  seat's five objective columns off its score row — the same row the modes credit through
  `recordObjective` — beside assists and the best streak, which it always read there.
- **`MatchXpAudit`'s second half.** One scripted fight — a longshot headshot, a damaged victim a
  team-mate finishes, a death — through a solo `MatchProgression` (entity 0, sampled for four
  minutes) and through a server-shaped `MatchLedger` (entity 7, nothing sampled, the match's
  length passed in). Nine rows, identical: `Match complete 500, Time played x4 100, Kills x1 100,
  Headshots x1 25, Assists x1 50, Longshots x1 30, Match win x1 500, MVP x1 300, Best streak x1
  25`. The solo side also completed a challenge (100 XP); it is excluded by id and printed as
  such. `ReplicatedScoreAudit` grew a replica half for the same reason — `applyReplicated` has
  one caller, in the browser, which no harness runs: a board of four, six replicated kills that
  must not move a row, a board of three with one row gone and one row's kills up, applied in
  place.

### The instrument

`skirmishHarness` samples the live match's rows once it is `ENDED` — frozen, through the hold —
and compares every client's last board received *in the live match* (the arena's board is empty
by design, F7, and the first version of this compared against it and read 30 mismatches out of
30) against them: same ids, same kills, deaths, assists, score, name, side, per client, counted.
Each return cycle records the first board the returning client was handed — rows against the
instance's, kills on its own row against the row it left with — and counts rows carrying its
name on the instance; `keptScore` is asserted in **both** grace cases now, on whichever entity
the player came back as. `HeadlessClient` reads `MsgS.Scoreboard` and derives its XP labels from
the table.

One Phase A assertion was wrong and this phase's `--net bad` run found it: "at most one VICTORY
per summary" is a Free-for-All rule, and two team-mates on the winning side of a TDM both read
VICTORY correctly. Scoped to FFA.

### Found while here, not fixed

- **A sentry's kills are credited to nobody.** `SentryGun` fires as its own entity (900+) so it
  can be shot down and never shoots itself; the chopper and the mortar fire as their owner.
  `ScoreSystem.recordKill` finds no row for 900 and the kill is on the feed and nowhere else — the
  FFA run's 13 sentry kills moved no row and paid no XP. A design question rather than a bug in
  this phase's scope (decision 8 below).
- `MatchHud.ts:282` and `:347` still compare `entityId === 0` (Phase A's finding).
- The skirmish harness's *"background build: the return to the arena was NOT EXERCISED"* line
  still prints on runs where every client migrated back (Phase A's finding).

### Human playtest, when Phase B is closed

Seen in the pane against a local dedicated server (below): the live board with the server's
rows, and the summary. What needs a display: the board's rows *not* jumping between two answers
during a firefight (the flicker a self-counting replica would have shown); a friend dropping past
thirty seconds and returning to find their own name once, with their kills; and the XP panel
drawing `Kills x7` rather than one flat line.

## Phase C — the body: the hitbox against the animation, then the markers

### C1 — measure before deciding (S)

`crouchHeight` 1.1 over `standHeight` 1.8 is a `heightScale` of **0.61**; `slideHeight` 0.55
is **0.31** (`MovementConfig.ts:148`). `HUMANOID_RIG`'s head box tops out at 1.77 m standing, so
the rig's head is at **~1.08 m crouched and ~0.54 m sliding**. The Mixamo crouch clips are a
half-squat; their head is plausibly at 1.2–1.3 m, and the slide uses those same clips. If so, a
round aimed at a crouching body's visible head passes over the rig, and a sliding body is drawn
about twice as tall as it can be hit. That is a claim, not a number, and the number comes first:

- A browser probe in the shape of this session's verification (drive `game.loop.frame`, place
  the camera with `__operator.sim()`, sample `mixamorigHead` and `mixamorigSpine1` world Y
  through each crouch/slide clip) producing one table: **clip × (visual head Y, rig head Y,
  delta)**, plus the same for crouch-walk against crouch-idle — which answers the "crouch-walk
  looks taller" question directly.
- The procedural `BotMesh` still squashes to `heightScale` (`BotMesh.apply`). It is on screen
  for the second or two before a template lands. Stop scaling it; it is a placeholder.
- Stand → crouch has no authored transition and cross-fades in 0.14 s; crouch → stand plays
  `crouchToStand`. `AnimationAction.timeScale = -1` on the same clip gives the missing half for
  nothing. This may be the whole of the "the body shrinks" report; do it in C1 and look.

### C2 — decide from the table (M, `shared/`)

- **Delta over ~0.10 m:** replace the uniform `heightScale` with a **crouch `RigLayout`** —
  `buildLayout(id, boxes)` already exists — whose boxes sit where the pose puts them (head
  forward and down, torso pitched), and a **slide layout** if a slide clip arrives in Phase D.
  This is simulation code: both runtimes change together, `npm run hashes` must still agree,
  and `scripts/hit-sweep.sh` is run before and after against a crouching target so the hit rate
  is a measured move rather than a hope. `RigHistory` (lag compensation) gets a layout id per
  frame — the same widening M12 sized for the riot shield.
- **Delta under 0.10 m:** leave the rig, and let the delta be the recorded reason.
- **Slide with no clip:** either the slide layout above with a crouch clip, or `slideHeight`
  raised toward what the clip shows. The first is right; the second is cheap; the human picks.

### C3 — the markers become shoulder pads (S–M)

The four emissive spheres read as a rash — geometry floating at the centre of a bone, the same
from every angle, on the knees. The reference the human supplied is Call of Duty Mobile's enemy
dress: **two small flat red pads on the outer upper arm, flush with the sleeve, lit, with a soft
halo**, and red goggles. Small, on the body, equipment rather than a marker.

The one structural change: `ActorAvatar.getIndicatorAnchor` returns a **point**; a pad on a
surface needs a **frame**. So:

1. `getIndicatorFrame(anchor, position, quaternion)` on `ActorAvatar`. `CharacterSkin` answers
   with the world transform of `mixamorigLeftArm` / `RightArm`; `BotMesh` with its arm box's
   frame. The renderer still learns no bone names.
2. Calibration lives in `CharacterIndicatorProfile` — per shoulder: `bone`, `offset` in bone-local
   centimetres (the deltoid surface is ~6–7 cm out from the joint), `rotation`. Apex's ×10 units
   ride the same mechanism that already scales `palmOffset`. One Mixamo calibration serves six
   skins.
3. The pad: a 5 × 3 × 0.8 cm rounded box, `MeshStandardMaterial`, `emissive = palette.hostile`
   at intensity ~1.5 (the spheres run 3.2), `toneMapped: false`; behind it an **additive sprite**
   of ~8 cm radius at alpha ~0.3 in the same colour. There is no bloom pass, and the sprite is
   what makes the reference's glow for one draw call.
4. `MARKER_ANCHORS` becomes `['leftShoulder', 'rightShoulder']`. The knee anchors leave the
   profile, the skin and `BotMesh`.
5. **Pixel arithmetic, stated so nobody is surprised:** at 90° and 1920 px a 5 cm pad is
   **~5 px at 10 m, ~2 px at 25 m, ~1 px at 50 m**. The pads are a close-to-mid tell; at range
   the nameplate (1.28 m wide, ~25 px at 50 m) is the tell, which is also how the reference
   works. A screen-space floor — `scale = max(1, minPx / pxPerMetre(distance))` — is one line
   if the human wants the pads to hold ~4 px; start without it.
6. **Goggles** — an emissive lens in front of `mixamorigHead` at eye height — are a second
   step and per-skin calibration (seven helmets). Only after the pads are accepted.

**If the pads read badly**, in order of distance from the reference: pads plus a thin strap
line on `mixamorigSpine1` (front readability while aiming); goggles alone; a thin emissive band
around the helmet (360°, per-skin); a rim light on the head only; a full inverted-hull outline
(declined by the human for now — kept last). Every one of them is a catalogue entry and one
geometry on top of the same frame mechanism, so switching is not a redesign.

**Gate for C3:** the probe from this session — screenshots at 5/10/25 m in `off` and
`deuteranopia`; the pad must not cut the sleeve in idle, run and crouch on both sides; hostile
pixel count around the silhouette per distance, recorded.

## Phase C — done (session of 2026-09-14): three layouts for three poses, and pads instead of a rash

Built to the brief above in two sessions on one day: C1 as the measurement alone, then C2 and C3
from its table. The number came first, and it was not the number the plan guessed: the crouch
*idle* was fine and everything that moves was not. The measurements are under "Measured".

One detour, recorded so nobody wonders: C3 was first built as the inverted-hull outline (a
stencil silhouette; it worked) on a misread brief. The human said no — the plan's C3 is the
pads, and the outline stays where the plan keeps it, last on the fallback list — and it was
taken out the same day. Nothing of it remains in the tree.

### C1 — the instrument, and what it read

`scripts/measure-crouch.mjs` is a Node script, not the browser probe the brief described: it
parses a catalogued skin with the client's own `GLTFLoader` (a parser plugin declines every
texture — `assignTexture` already treats a null as "no map"), wraps it in the real
`CharacterSkin`, prepares each clip with the real `importClip` and plays it through an
`AnimationMixer` frame by frame, reading the crown (`mixamorigHeadTop_End`), the skull base
(`mixamorigHead`), the spine chain, the hips and — with `--pose` — the limb joints, in the actor
frame with the feet at the origin. The game's TypeScript reaches it through Vite's
`ssrLoadModule`, `layout-probe.mjs`'s trick, so `HUMANOID_RIG` and the catalogue are read live
rather than copied. Under a second per run; the layouts below are its `--pose` table, and its
comparison table is now against the layout the game wears, so re-running it after a clip
changes says whether the layout still fits.

What it read, Echo, shipped clips, crown height against the old uniform rig (0.611 crouched,
0.306 sliding): **crouch idle 1.11 m vs 1.08 (+0.03 — a kneel, right knee on the floor);
crouch walk 1.26 vs 1.08 (+0.18); crouch run 1.38 vs 1.08 (+0.30); any crouch loop drawn in a
slide vs 0.54 (+0.57 to +0.84).** Standing: the aiming idle's crown is at **1.61 m against a
rig head top of 1.77 (−0.16)** — the T-pose bind is 1.74, so `modelScale` was calibrated to the
bind and the aiming pose is 13 cm lower. Five of the seven skins agree to the millimetre (a
Mixamo clip's position tracks impose its skeleton's proportions on every bone); Apex is 6 cm
taller everywhere, Sentry 3 cm. The `incoming/` crouch files are on a 69-bone skeleton with a
`mixamorigNeck1` the skins lack: played on a skin the head lands 3.4–3.8 cm lower than
authored, and `importClip` passes the four unbound tracks through to a bind warning per clip.
`incoming/` also has two crouch depths — the "Aiming" family settles at 1.08 m, the "Pistol"
family at 1.23 — and no slide clip.

### C2 — one layout per drawn pose

- **`HitboxRig` has no `heightScale`.** It has a `layout`, set from the stance and velocity by
  `rigLayoutFor(stance, vx, vz)` on the tick the shot resolves, in all three runtimes' sites
  (`Bot.advance`, `PlayerCombatant.syncRig`, `NetPlayer.step`) and on the client's mirror
  (`RemoteActor`, from the replicated stance and the latest velocity — its rig is what the
  hitbox overlay draws). Squared speeds against the thresholds, so no `Math.hypot` in the sim.
- **Three low layouts, built from joints.** `HUMANOID_CROUCH_RIG` (the kneel),
  `HUMANOID_CROUCH_WALK_RIG` and `HUMANOID_CROUCH_RUN_RIG` are `poseLayout(id, joints)`: the
  measured joint positions of the clip, and a padded axis-aligned box per body segment —
  head, neck, chest, abdomen, two per arm, two per leg, twelve boxes where the standing layout
  has eight. The pads are chosen so a segment box around the *standing* joints reproduces the
  standing box it replaces, so zone sizes are comparable. Yaw-only is the rig's own rule, so a
  pitched torso is the bounding box of its segment; splitting the limbs keeps that cheap. The
  standing layout is untouched: every hit-rate number in this file was taken against it.
- **The selection rule is the animation selector's.** `isLowStance`, `LOCOMOTION_IDLE_SPEED`
  (0.12) and `LOCOMOTION_RUN_SPEED` (5.4) moved to `shared/player/Stance.ts`;
  `client/characters/AnimationSelector` imports them. A crouching body never reaches the run
  speed; a **slide** does, so the slide wears the crouch-run layout while it is fast and the
  crouch-walk layout once it has bled off — which is exactly the clip it is drawn with.
  Decision 2 is therefore answered by the mechanism: no slide clip exists, and the slide wears
  the layout of the clip it draws.
- **Bots aim at the layout.** `RigLayout.aimY` is the chest box centre (1.26 standing; 0.765,
  0.97 and 1.11 in the low layouts); `aimHeight` on all three combatants returns it, and the
  harness shooter (`HeadlessClient.aimAtNearest`) aims at the target's layout rather than at a
  standing 1.26. The sentry's one-box rig falls back to its torso box.
- **Lag compensation stores the layout.** `RigHistory` holds four `Float32Array`s and one array
  of `RigLayout` references; `RigSnapshot.layout` replaces `.scale`. A rewound shot is resolved
  against the pose the body was drawn in on that tick.
- **The wire is untouched.** `EntitySnapshot.heightScale` is still sent (capsule height over
  stand height, from `capsuleScale` on `NetPlayer` and `Bot`) and still squashes the procedural
  placeholder; it is redundant with `stance` since this phase and leaves with the v13 widening
  rather than on a version bump of its own. `PlayerCombatant` lost the `MovementConfig` it only
  read for the scale.

### C3 — the pads

Built to the six points above, in order.

1. **A frame, not a point.** `ActorAvatar.getIndicatorFrame(anchor, position, quaternion)`
   for the two frame anchors (`INDICATOR_FRAME_ANCHORS`); `getIndicatorAnchor` keeps the head
   and answers false for a shoulder. The pad convention is the avatar's to satisfy: **+Z out of
   the sleeve, +X down the arm, +Y across it.** `CharacterSkin` answers with the world frame of
   a node it parents under each upper-arm bone (`padNode`, the palm marker's construction);
   `BotMesh` with a static node on the outer face of each arm box, after the arms' baked pitch.
   The renderer learns no bone names.
2. **Calibration in the rig profile, measured.** `CharacterIndicatorProfile` carries
   `leftShoulder` / `rightShoulder`, each `{ bone, offset, rotation }` in the bone's own units
   (cm; Apex ×10 through the same override its `palmOffset` uses). The bone frame was measured
   on Echo and Apex with the C1 script's loader: **+Y runs down the arm to the elbow, −Z is the
   lateral surface of the deltoid** (world +Y in the T-pose), and the rotation that maps it onto
   the pad convention is `[−π, 0, −π/2]`. The lateral distance was *probed in the running game*
   — the skinned sleeve vertices under a 6 × 4 cm footprint at the pad, their height along the
   pad normal, per skin, in idle, run and crouch (identical to a millimetre: the footprint is
   rigid to the bone) — and set 3 mm above the highest of them. The plan's "one Mixamo
   calibration serves six skins" is four: **Viper 7.9, Hazard 8.0, Pulse 8.1, Sentry 7.5 share
   the 8 cm base; Echo needs 9.6 and Rhino 12.3** (bulkier sleeves — at 8 cm the pad was 1.3 cm
   and 4 cm inside them) and get rig ids of their own (`withShoulderPads`); Apex is 8.7 in its
   units. The deltoid is not "6–7 cm out" on these skins; the guess would have buried every pad.
3. **The pad and its halo**, in `ActorIndicator`: a `RoundedBoxGeometry`,
   `MeshStandardMaterial` with `emissive = palette.hostile`, `toneMapped: false`, half its
   thickness out along +Z so its back face is on the sleeve; and behind it an **additive sprite**,
   a radial canvas gradient tinted by the palette. One geometry and two materials are shared by
   every body and repainted once in the palette callback; the halo is what makes the glow, since
   there is no bloom pass. **Built first at the plan's numbers — 5 × 3 × 0.8 cm, emissive 1.5,
   an 8 cm halo at alpha 0.3 — and read by the human on a real display as part of the skin at
   1.5 m** (Pulse has red details of its own on that shoulder). Now **10 × 6 × 1 cm, emissive
   3.0 (the spheres' figure), a 14 cm halo at alpha 0.55**, and the floor in point 5.
4. `MARKER_ANCHORS = ['leftShoulder', 'rightShoulder']`. The knee anchors are gone from the
   profile, the skin and `BotMesh`; so are the spheres.
5. **The pixel arithmetic, measured** (2000-px buffer, 90°, one pad facing, same-frame
   `readPixels` after the game's draw, hostile hue ±15° at s ≥ 0.45 / v ≥ 0.6, nameplates
   hidden, background subtracted). At the plan's size: **24 px at 5 m, 6 px at 10 m, 1 px at
   25 m** in `off`, 29 / 3 / 2 in `deuteranopia` — the plan's "~5 px across at 10 m, ~2 at 25",
   and on a display that was nothing. So the plan's one line is in: `padFloorScale` grows the
   pad's frame so its long side never covers less than **6 / 1080 of the frame height**
   (`PAD_MIN_SCREEN_FRACTION`), from the camera's vertical FOV and the distance, so no buffer
   size is needed; `ClientMatch` hands the player camera to `BotRenderer.update`, the thermal
   optic hands none. With the bigger pad and the floor: **44 / 14 / 15 px** at 5 / 10 / 25 m in
   `off` — a red dot on each shoulder at 25 m rather than nothing, with the nameplate still the
   tell at range. (Deuteranopia's orange shares a hue with the hazard stripes, so its
   background subtraction is not reliable at those bearings and is not quoted.)
6. Goggles: not started; only after the pads are accepted.

**The C1 leftovers, done here:** `BotMesh` no longer squashes to the wire's `heightScale` (a
placeholder stands at its own height; the rig wears a layout, not a squash), and the **stand →
crouch transition is `crouchToStand` played backwards** — `timeScale −1` from the last frame,
finishing at 0 and handing to the crouch loop. One trap, recorded in the code: the cross-fade's
time warp divides by the action's time scale and so flips a negative one, running the clip
forward from its end to an instant finish; a reversed play fades without warping. Watched in the
pane: 1.1 s from standing to the kneel, the pads riding the shoulders through it.

### The instrument, and what it found

`scripts/hit-sweep.sh` takes `CROUCH=1` (the strafing target holds crouch; `netHarness
--crouch`, `HitTest` prints `target: crouch`), and **it now starts and stops its own server by
PID and refuses a mode whose server did not report `listening`.** The first sweep of this
session ran as the script was: `pkill -f "dist-server/serve"` from Git Bash never reaches a
native `node.exe`, so the first server started — the HEAD worktree's, rewind on — held port 8120
for forty minutes while every later server died with `EADDRINUSE`, and every later row, the
"after" rows included, was measured against the old rig with rewind on. That is M10's *"the
sweep script died partway on Windows"*, and it is why S8.6's with/without-rewind table was
never completed. The rows under "Measured" are from the fixed script, with a server of its own
per mode.

### Found while here, not fixed

- **The standing rig is 16 cm taller than the standing body.** `Idle_Aiming`'s crown is at
  1.61 m; `HUMANOID_RIG`'s head box runs 1.52–1.77. Above the drawn head there is 15 cm of
  head-zone hitbox, and the drawn skull base (1.42) sits in the neck box. A round that misses
  over a standing head is a headshot. Left alone on purpose: every hit-rate and TTK figure in
  this file was taken against it, and moving it is a balance change the human should make
  knowingly — the same `poseLayout` from `Idle_Aiming`'s joints is one table away.
- **`incoming/`'s `Neck1`**: Phase D's manifest should report a clip whose tracks target bones
  the skins lack, and the export contract should say which skeleton.
- **`EntitySnapshot.heightScale` is a pure function of `stance`** now; drop it at v13.
- The determinism scenario (`hashRun`) runs one player and a weapon system against the map with
  no hitbox rig, so `npm run hashes` cannot see a layout change; the fingerprint agreeing is
  necessary and not sufficient for the rig.

### Human playtest, when Phase C is closed

On a real display: the pads at play speed — the first cut read as part of the skin at 1.5 m
and was doubled with a floor; do the new ones read as *the enemy* at 5, 10 and 25 m, in `off`
and `deuteranopia`, or are the strap line / goggles from the fallback list wanted; the halo's
0.55 alpha in daylight maps;
a crouch-walking enemy taking a chest hit where the chest is drawn; a slide being hittable at
all; the reversed transition at play speed; and whether the standing "phantom head" above is
felt as a headshot that should not have been.

## Phase D — the animation library

The human has more clips to add and wants the folder to explain itself, overlapping clips to
vary, and the catalogue to stay explicit ("files in `public/` are deliberately not discovered at
runtime" is a rule, and it stays).

**Folder:**

```
public/models/bots/animations/
  locomotion/stand/    locomotion/crouch/    locomotion/slide/
  transitions/         deaths/               hits/            actions/
  incoming/            ← dropped here, never loaded
  README.md            ← what each folder means and which slot each file fills
```

**Catalogue:** `CharacterAnimationId` becomes a **slot** holding
`readonly CharacterAnimationDefinition[]` — variants — and `AnimationSelector` keeps returning a
slot, which is why it never had to know about files.

**Variants are dealt deterministically, never with `Math.random`:**
- **Deaths:** the simulation already picks `deathVariant` with
  `deathVariantFor(entityId, deathSerial, DEATH_VARIANTS)` and replicates it; the GLB path
  ignores it today. `clips[deathVariant % clips.length]` and every client and the server agree
  for free. `DEATH_VARIANTS` stays 4 in `shared/`; the client maps.
- **Idle / walk variants:** the same hash on `(entityId, spawnSerial)` — fixed for a life.
- **Flinches:** on `(entityId, flinchSerial)`.
- One `variantFor(slot, entityId, serial, count)` in `client/characters/` for all three.

**Tools, in the project's own idiom (a rule a human has to remember is a rule that will be
broken):**
- `scripts/animation-manifest.mjs` — reads each GLB's JSON chunk **in Node, without three**:
  clip names, duration from the sampler input accessor's `max`, targeted bones. Run over
  `incoming/` to decide slots from a table rather than from the file name.
- `scripts/check-animations.mjs` in the gate as `check:animations` — every catalogue URL exists;
  every file outside `incoming/` is in the catalogue; every slot the selector can return is
  non-empty.
- **Export contract enforced on the new files:** one named semantic clip per file and the
  `name` selector. `LegacyClipSelector` (last clip + expected duration) remains for the eleven
  old files until they are re-exported, and the check reports how many are left.

**New slots are not free:** `reload`, `throw` and `melee` need triggers in
`ActorAnimationInput`. `reloading` and `firing` exist; `throwing` and `melee` do not, and each is
a snapshot flag — an `EFlag` bit, which M12 already found full, and a line in `check-cosmetics`.
Do the library with the slots the inputs already support; take the new bits together with M12's
v13 widening, once.

Size **S** for the manifest and the check, **M** for slots and variants.

## Phase D — done (session of 2026-09-14): a folder that explains itself, and a table before a name

Built to the brief above, in its order: the manifest first, then the slots from its table, then
the folder, the catalogue, the check and the browser. Two departures, both forced by what the
manifest read and stated where they happened; the gate ran red on three planted defects before
it was trusted green; every number is under "Measured".

### The manifest, and what it read

`scripts/animation-manifest.mjs` (`npm run animations`) reads a GLB's 12-byte header, its JSON
chunk and — for one track — its BIN chunk, in Node with no three: clip names, the duration as
the largest sampler-input `max`, channels and the bones they target, and the motion bone's
world height through the clip (the hips' translation track taken up the armature chain, in the
file's own metres), plus the bones the file's skeleton has that each skin lacks. Node names are
sanitised as `GLTFLoader` sanitises them (`mixamorig:Hips` → `mixamorigHips`), so the report
speaks the catalogue's names. Under 200 ms for the whole tree; `check-animations.mjs` and
`animation-import.mjs` import its reader rather than carrying a second one.

Three things it read that the file names did not say:

1. **Every delivered file is a session export — 0 of 24 met the contract.** The brief's "the
   `name` selector for the new files" assumed the `incoming/` thirteen were one named clip each.
   They are cumulative `mixamo.com.NNN` exports like the original eleven, 1 to 13 clips per
   file, only the last of them the one wanted (`Walk_Reload.glb` carries the whole session:
   twelve other animations, 1.5 MiB, for a 4.1 s clip). So the contract needed a tool, not a
   sentence — the first departure, below.
2. **Two skeletons, and which skins lack what.** The original eleven are on the skins' 65-bone
   rig. The thirteen are on a 69-bone rig whose `Neck1` and `Jaw` six of the seven skins lack
   (Sentry has both) and whose eye bones five lack. A track for a bone a skin does not have
   binds to nothing on that skin and the pose it carried is gone — C1's 3.4–3.8 cm at the head.
3. **Two crouch depths, as a hips number.** The kneel family sits at 0.40–0.44 m at the hips
   (`Crouch_Idle_Aiming` 0.420, `Crouch_Idle_Reload` 0.402, `Transition_Stand_To_Crouch_Aiming`
   ending at 0.438); the "Pistol" family at 0.49 (`Crouch_Idle_Aiming_Pistol` 0.494, both pistol
   transitions ending or starting there). `measure-crouch.mjs` confirms it at the crown: 1.07–
   1.11 m against 1.23.

### The slots, decided from the table

| Incoming file | What the table says | Slot |
|---|---|---|
| `Death_Stand_01` | one-shot, 2.62 s, ends face-down at 0.09 m | `deathStand` **variant 2**, indexed by the simulation's `deathVariant` |
| `Sprint_Relaxed` | 0.517 s loop, crown 1.52 m — `Run_Relaxed` is 0.517 s and 1.52 m; a standing body only reaches the run threshold while sprinting | `runRelaxed` **variant 2**, dealt per life |
| `Transition_Stand_To_Crouch_Aiming` | 1.52 s, hips 0.927 → 0.438, last-frame crown 1.080 (kneel family) | **`standToCrouch`** — the authored way down; `crouchToStand` is no longer played backwards |
| `Idle_Reload` / `Walk_Reload` / `Crouch_Idle_Reload` | 3.3 / 4.1 / 4.15 s one-shots; standing crowns 1.65 / 1.62; the kneeling one 1.07 | **`reloadStand` / `reloadWalk` / `reloadCrouch`**, keyed on `reloading` — S6.5's *"a remote player mid-reload must look mid-reload"*, which the skinned body had never honoured |
| `Idle_Aiming_Pistol`, `Walk_Aiming_Pistol`, `Run_Aiming_Pistol`, `Sprint_Aiming_Pistol`, `Crouch_Idle_Aiming_Pistol`, both `*_Pistol` transitions | a family: the pistol crouch is a half-squat **+0.109 / +0.115 / +0.097 m** (crown / skull base / chest) above `humanoid-crouch`; the standing loops sit where the rifle ones do | **stay in `incoming/`** — decision 11 |

The pistol family is the second departure: the brief said "only the slots the inputs already
support", and the inputs do support a weapon class (the renderer has `weaponId`), but the
*hitbox* does not — a slot whose variants need different layouts is not a slot, and a pistol
body that stood in its own clips and knelt in the rifle's would pop 12 cm at the crouch edge.
Half a family is worse than none. `Crouch_Idle_Reload` is admitted with its delta on record:
**−0.050 / −0.022 / −0.034** against `humanoid-crouch`, outside the 1 cm pad — a one-shot of at
most four seconds under a box that is 5 cm too tall, in the direction of the standing rig's
16 cm; decision 12, not padded away.

### The import tool

`scripts/animation-import.mjs incoming/<File>.glb <folder>` writes `<folder>/<File>.glb` with
exactly one clip, named `<File>`, and removes the source. It rewrites at the JSON level — keep
one animation, walk every accessor reference (samplers, inverse bind matrices, meshes if any),
keep those accessors and their buffer views, repack the BIN, renumber — and decodes no float,
so it can change none. Verified under the real `GLTFLoader` on all six imported files and two
of the originals: **one clip, same track count, same duration, same skeleton, 0 differing
values** out of every time and value in every track. Sizes: 508 → 128, 978 → 80, 1152 → 121,
793 → 234, 1533 → 273, 402 → 275 KiB. The six are in their folders; the seven pistol files
wait in `incoming/`.

### The library

```
public/models/bots/animations/
  locomotion/stand/    Idle_Relaxed  Idle_Aiming  Walk_Relaxed  Walk_Aiming  Run_Relaxed  Sprint_Relaxed*
  locomotion/crouch/   Crouch_Idle_Aiming  Crouch_Walk_Aiming  Crouch_Run_Aiming
  locomotion/slide/    (empty — a slide draws the crouch loops)
  transitions/         Transition_Crouch_To_Stand  Transition_Stand_To_Crouch_Aiming*
  actions/             Idle_Reload*  Walk_Reload*  Crouch_Idle_Reload*
  deaths/              Death_Stand  Death_Stand_01*  Death_Crouch
  hits/                (empty — a flinch clip goes here, dealt per (entityId, flinchSerial))
  incoming/            the seven pistol files
  README.md            what each folder means, the five steps for adding a clip, the skeletons
```
`*` was imported from `incoming/` this phase; the eleven others were moved by `git mv` with
their LFS pointers and, as of the addendum below, rewritten in place by the same tool. Every
file is on the contract. `CHARACTER_VERSION` is `2026-09-14-library-v2`.

**The catalogue.** `CharacterAnimationId` is a slot; `CharacterDefinition.animations` maps each
to a `CharacterAnimationSlot`, a non-empty tuple of `CharacterAnimationDefinition`. The table is
one line per slot — `runRelaxed: slot('runRelaxed', 'loop', 'locomotion/stand/Run_Relaxed',
'locomotion/stand/Sprint_Relaxed')` — each path naming a file whose one clip is named after it
(`clipName`, the whole of the selector since the addendum), and every variant of a slot sharing
its kind (loop / weapon-ready / one-shot), because two clips that disagree about that are two
slots. `AnimationSelector`
still returns a slot and learned nothing; it gained `selectAction`, the one-shot that stands in
for locomotion while the input says so (a reload in the kneel, standing still, or walking —
not running, sliding or crouch-walking, which have no clip and keep their loop).

**Variants are dealt, never drawn.** `client/characters/AnimationVariant.variantFor(slot,
entityId, serial, count)` is the splitmix hash behind `deathVariantFor` (now exposed from
`shared/ai/BotVisualState` as `cosmeticVariantFor`) with the slot id folded into the seed, so an
actor's idle and walk are dealt independently. Locomotion is dealt on `(entityId, spawnSerial)`
through a new `ActorAvatar.setLife(entityId, spawnSerial)`, which `BotRenderer` calls when it
makes a body, when it swaps a placeholder for a skin, and whenever the spawn serial moves; the
procedural body ignores it. Deaths index the slot by the simulation's `deathVariant` modulo the
count — `DEATH_VARIANTS` stays 4 in `shared/`, and the check keeps it a multiple of every death
slot's size. Flinches: the rule is written on `variantFor`, and no code, because no clip exists.

**The animator** plays four kinds of thing in priority order — a death, a transition at the
crouch edge (`standToCrouch` down, `crouchToStand` up, both forward), an action one-shot, the
locomotion loop — and caches an action per `slot/variant`. C1's reversed play of
`crouchToStand` is gone with its `reversed` parameter: the check guarantees the slot it stood
in for is never empty, so it was a branch nothing could reach (its trap — the cross-fade's time
warp flipping a negative time scale — stays on record under Phase C3). A reload one-shot is **fitted to the weapon**: `ActorAnimationInput`
gained `reloadSeconds` (a bot's exact `reloadDuration`; a remote body's weapon def
`reloadTime`, which is what the wire supports) and the clip's time scale is `duration /
reloadSeconds`, clamped to [⅓, 3], so a 3.3 s clip on a 2.4 s shotgun runs at ×1.38 and ends
when the magazine does. The support-hand constraint is released for it (the left hand is on
the magazine). When `reloading` drops, the loop cross-fades back from wherever the clip was.

**`importClip` prepares per skin now**, not only per rig: `validateSkin` returns a
`SkinBinding` (the bind position it always returned, plus the skin's bone set) and a track for a
bone the skin lacks is dropped on that skin. Sentry keeps `Neck1`; the other six lose it, which
is the same pose they drew before minus a `THREE.PropertyBinding` warning per track per body
(four per clip, six clips, every skinned actor — the console is clean now). Nothing is
retargeted; the 3–4 cm is on record, not hidden.

### The check

`scripts/check-animations.mjs`, in the gate as `check:animations`. Six rules: every catalogued
file exists; every shipped file outside `incoming/` is catalogued; every slot the selector can
return has a file, and every catalogued slot is asked for by the selector or the animator;
every file has one clip named after itself (until the addendum: a `named` file did, and a
`legacy` file's last clip was the length the catalogue said); `DEATH_VARIANTS` divides evenly
over every death slot; every folder is named in the README. It reads the catalogue and the
selector by regex and the GLBs through the manifest's reader. **Red before green:** a stray `.glb` in `actions/`
(caught: "shipped but no slot names it"); `Death_Crouch` under the `name` selector plus a slot
naming an `incoming/` file (caught: "13 clip(s) named mixamo.com…", "nothing in incoming/ is
loaded"); `DEATH_VARIANTS = 3` (caught: "indexed modulo 2, not dealt evenly"). Then green:
**15 slots, 13 the selector returns, 2 with variants, 17 shipped files, 6 on the contract, 11
legacy, 7 waiting.**

### Found while here, not fixed

- ~~**The eleven originals are one command from the contract.**~~ Done the same day at the
  human's word — see the addendum below.
- `ActorAvatar.update` still carries `heightScale`, now read by nobody but the wire's
  `EntitySnapshot.heightScale`; both leave with v13.
- `docs/CHARACTER-ASSETS.md` still said the IFF layer was "emissive points on upper arms/knees"
  — stale since C3; fixed here in passing.
- The README in the animations folder ships with `dist/` (Vite copies `public/` whole). A few
  kilobytes; left.

### Addendum (same day): the eleven, imported, and the legacy selector gone

The human took decision 13. `animation-import.mjs` gained an in-place mode (a file already in
its slot folder, no destination: written beside itself, read back, then renamed over the
source) and was run over the eleven. Verified under the real `GLTFLoader` **before** the
rewrite, on every one: the source's last clip against the rewritten file's only clip — same
track count (195), same duration, same 65-bone skeleton, **0 differing values** in every time
and value of every track, all eleven. Sizes: `Idle_Relaxed` 537 → 226, `Idle_Aiming` 727 → 106,
`Walk_Relaxed` 210 → 94, `Walk_Aiming` 137 → 95, `Run_Relaxed` 333 → 77, `Crouch_Idle_Aiming`
644 → 109, `Crouch_Walk_Aiming` 277 → 88, `Crouch_Run_Aiming` 998 → 101,
`Transition_Crouch_To_Stand` 1 074 → 98, `Death_Stand` 919 → 214, `Death_Crouch` 1 231 → 179
KiB. **The shipped library is 17 files, 2 498 KiB, where it was 8 199** — 5.6 MiB less on every
first load.

With every file on the contract the legacy selector left the tree: `LegacyClipSelector`,
`NamedClipSelector` and the `selector` union are gone, `CharacterAnimationDefinition.clipName`
is the whole of it, `selectSourceClip` asks by name and names what it found when it fails
("expected a clip named `Idle_Reload` and found `mixamo.com`, `mixamo.com.001`… — run
`scripts/animation-import.mjs` on the file"), and the catalogue's slot lines are plain paths.
`check-animations` rule 4 is one rule for every file, and it ran red on a session export copied
over `actions/Idle_Reload.glb` ("has 4 clip(s) named `mixamo.com`… the contract is one clip
named `Idle_Reload`") before it ran green. `measure-crouch.mjs` builds its definitions with
`clipName: source.clip.name` and still measures a raw `incoming/` file. `CHARACTER_VERSION`
`2026-09-14-library-v2`.

Re-measured after the rewrite, every row identical (bit-identical tracks must be):
`Crouch_Idle_Aiming` −0.008 / +0.014 / +0.006, `Crouch_Walk_Aiming` −0.006 / +0.015 / +0.012,
`Crouch_Run_Aiming` −0.012 / +0.008 / +0.012, `Idle_Aiming` −0.156 / −0.097 / −0.029. `npm run
hashes` **de376f8c**. In the pane (hidden; stepped by hand, 280 frames, nine skinned bodies):
every one of the seventeen files playing under its own name — `Idle_Aiming` 117 samples,
`Walk_Aiming` 204, `Run_Relaxed` 42 + `Sprint_Relaxed` 25, `Death_Stand` 43 + `Death_Stand_01`
77, `Death_Crouch` 61, both transitions, three reloads, the three crouch loops — 17 fetches of
the v2 URLs once each, seven skins ready, no console error, no bind warning.

### Human playtest, when Phase D is closed

On a real display, at play speed: an enemy reloading standing, walking and kneeling — whether
the fitted clip reads as one reload (×1.38 on a shotgun, ×1.73 kneeling on the same gun, ×0.75
on an LMG) or as a body fast-forwarding; a reload cut short by a swap; the walk-reload's feet
against a 4.6 m/s walk; the authored stand → crouch against last session's reversed one; two
sprint gaits in one roster and whether they read as variety or as one bot running wrong; the
second standing fall; and the kneeling reload's head 5 cm under its box (decision 12).

## Content backlog — already scoped in Milestone 12

Minigun, flamethrower, riot shield (F16) and the grenade animation (F17) are sized, ordered and
decided above under M12; nothing in this milestone changes those answers, and one thing helps:
`handBoxes` is now a separate part group, so F17's second hand entering the frame is a part the
viewmodel already owns rather than a new one.

## Dependency order

1. **Phase A** — three bugs, one predicate, a harness that already exists. Half a day.
2. **Phase B** — scoreboard first, then XP; both "a fact moved to the server".
3. **Phase C1** — the measurement. Cheap, and it decides C2.
4. **Phase C3** — the pads. Independent of C2; depends only on the frame API.
5. **Phase C2** — if the table says so.
6. **Phase D** — after C, because the slide slot and any transition slot depend on C1's answer.
7. **M12's content**, in M12's order.

## What each phase breaks

| Phase | What it puts at risk |
|---|---|
| A | Bot behaviour in FFA: perception and spawn already treat everyone as hostile; a predicate that disagrees with them in one site changes who shoots whom. The FFA skirmish is the watch |
| B | The wire: a new message type and a per-recipient summary. `check-cosmetics` is the audit; `--leak` must stay flat with rows outliving seats |
| C2 | Hit registration for crouched and sliding bodies, in both directions. `hit-sweep.sh` before and after, and `npm run hashes` |
| C3 | Nothing in gameplay. The readability of an enemy at 25 m+ rests on the nameplate |
| D | `DEATH_VARIANTS` and the catalogue disagreeing on how many deaths exist — the check is what catches it. *(Built; the check ran red on exactly that before it ran green.)* |

## Decisions waiting on the human

| # | Decision | Recommendation |
|---|---|---|
| 1 | ~~Does bug 4.1 still reproduce after `8309b86`?~~ **Answered by the human (2026-09-13): no.** A two-window match from team B read correctly; Phase A spent only the sentry-body line on it | — |
| 2 | ~~Slide: a layout with a crouch clip, or raise `slideHeight`?~~ **Answered by C2 (2026-09-14): the layout.** No slide clip exists; a slide draws the crouch loops and now wears their layouts (crouch-run while fast, crouch-walk once slow). `slideHeight` is untouched — it is the capsule, not the rig | — |
| 9 | The standing rig: leave the 1.77 m head top over a 1.61 m drawn crown, or rebuild `HUMANOID_RIG` from `Idle_Aiming`'s joints as the low layouts were built? | Rebuild, in its own phase, with `hit-sweep.sh` and the TTK figures re-taken against it — it moves every balance number in this file, so not quietly |
| 10 | Pads: 10 × 6 cm at emissive 3.0 with a 14 cm halo at alpha 0.55 — right on a daylight map, too much at night? | Playtest; each is one constant in `ActorIndicator` |
| 3 | ~~Pads: screen-space minimum size?~~ **In, after the human's read (2026-09-14): 6 px of 1080** (`PAD_MIN_SCREEN_FRACTION`). Raise it if 25 m still reads as nothing | — |
| 4 | Goggles after the pads? | Yes, once the pads are accepted — per-skin work, and the sleeve probe says the skins differ by centimetres |
| 5 | ~~Which of the new clips exist — slide, throw, reload, melee, flinch, more deaths?~~ **Answered by the manifest (Phase D, 2026-09-14):** three reloads, one more standing death, a sprint, the authored stand → crouch, and a seven-file pistol family. No slide, throw, melee or flinch, so v13 is not needed for the library; `heightScale` and the `throw`/`melee` bits still wait for it | — |
| 11 | **The pistol family** — `Idle/Walk/Run/Sprint_Aiming_Pistol`, `Crouch_Idle_Aiming_Pistol`, both `*_Pistol` transitions, in `incoming/`. Their crouch is a half-squat **11 cm above the kneel layout's head box**, so admitting them means a fourth low layout keyed on the weapon class in `rigLayoutFor` (the sim knows the weapon), a class on `HeldWeaponAsset` for the selector, and a hit-sweep against it. Admit as a family, or leave them? | A phase of its own, after decision 9: both move the rig, and the pistol is a class the game already has. Not half of it — a pistol body that stands in its own clips and kneels in the rifle's pops 12 cm at the crouch edge |
| 12 | **`Crouch_Idle_Reload`** sits −0.050 / −0.022 / −0.034 (crown / skull base / chest) under `humanoid-crouch` — outside C2's 1 cm pad, for a one-shot of at most four seconds, in the direction of the standing rig's own 16 cm. Accept it, or add a reload layout keyed on `reloading` (which the sim and the wire both have)? | Accept for now, and re-measure with decision 9's rebuild; a layout for a transient pose is a fifth layout for 5 cm |
| 13 | ~~The eleven original files through `animation-import.mjs`?~~ **Answered by the human (2026-09-14): yes.** Done the same day, bit-identical under `GLTFLoader` on all eleven, 7 088 → 1 387 KiB, the legacy selector gone from the tree — see the Phase D addendum | — |
| 6 | Scoreboard rows: keep a departed player's row for the match, or drop it at unseat? | Keep it for the match, keyed by reconnect token; drop only when the match ends |
| 7 | Free-for-All spectating: `SpectatorTarget.isWatchable` shows a dead player same-side bodies only, which in FFA is half the lobby. Anyone, or leave it? | Anyone — there are no team-mates to protect, and the reference games spectate the killer. One `isHostile`-shaped change in `shared/modes/SpectatorTarget.ts` plus its harness invariant ("never an enemy") rewritten for FFA |
| 8 | A sentry's kills: credited to its owner (as the chopper's and the mortar's are), or to nobody (as today)? | The owner. `SentryGun` fires as its own entity so it can be shot down; the credit is a second question. `ScoreSystem.recordKill` could resolve a streak entity to its owner through `StreakSystem`, or the sentry's `DamageRequest.sourceId` could be the owner with the rig excluded from its own trace by id. The first keeps "who shot" honest on the feed; the human picks |

## Measured, this session

- **OBJECTIVE facing, live match, 1 800 ticks:** bots in `OBJECTIVE` with no known target face
  their velocity at a **median of 0°, p90 24°** (path turns), max 132°. With a target: median
  46° — aiming while moving, by design. Before the fix the same bots kept their last aim.
- **DOM headless, seed 7, two matches:** before 197–159 / 201–137; after **201–142 / 201–124**,
  both on the score limit.
- **Animation fetches:** six additional skins loaded with **zero** re-fetches of the eleven
  animation files (was 66 requests).
- **Pixel arithmetic for the pads** (90°, 1920 px): 5 cm = 5.0 / 2.0 / 1.0 px at 10 / 25 / 50 m;
  the 1.28 m nameplate = 25 px at 50 m.
- **Rig heights, from the constants:** head top 1.77 m standing → 1.08 m at `heightScale` 0.61
  (crouch) → 0.54 m at 0.31 (slide). The visual head in the crouch clips is **not measured** —
  that is C1's first job.

### Phase A (2026-09-13/14)

Every skirmish line below is `MATCH_ROUND_SECONDS=150 npm run skirmish -- --vote 3
--wallet-streak sentry --cycles 1` — three clients, one cycle, Foundry, shipped 40/10/10 cycle,
**timings shortened** on the round so the summary is reached; structural results only.

- **Red control** (the tree with `SentryGun.acquire` ignoring the mode and `FreeForAll` naming
  no entity): sentries **3 placed, 32/123 (26.0 %), 5 kills, 0 on the sentry's own side**;
  summary `OP1 DEFEAT, OP2 VICTORY, OP3 DEFEAT — winner named B`. **FLOW CHECK FAILED** on both
  lines — the probe is red on the defect.
- **Green, first run:** 3 placed, 58/208 (27.9 %), 7 kills, **3 on own side**; places **11TH /
  9TH / 9TH over 11 rows** in an eight-body match — the blank-row finding above.
- **Green, after the summary drops blank absent rows:** 3 placed, 41/166 (24.7 %), 7 kills, 3
  on own side; **6TH / 7TH / 8TH of 8**, winner `PENNANT` on every client.
- **Final tree** (the equipment sites in): 3 placed, 58/162 (35.8 %), 9 kills, **2 on own
  side**; **7TH / 6TH / 7TH of 8** (OP1 and OP3 tied at 0/5/0), winner `PENNANT` on every
  client. FLOW CHECK PASSED.
- **TDM control** (`--vote 0`, same flags): 4 placed, 8/40 (20.0 %), 0 kills, **0 on own side**;
  `DEFEAT / VICTORY / DEFEAT` by seat, winner named `B`, 10 rows. PASSED.
- **Determinism, team modes:** `npm run harness` (TDM, 5 matches, seeds 1–5) on the clean tree
  and on this one — every per-match line identical (75–66 / 16 582 t, 75–66 / 17 659 t, 62–75 /
  19 485 t, 44–75 / 14 935 t, 75–63 / 18 612 t) and every metric event identical but `pid`, wall
  ms and heap. The four rewritten guards are the same truth table.
- **Determinism, FFA, three runs** (`main.js --mode FFA --matches 3 --seed 7 --asap`): clean
  **30–24 / 19 486 t, 30–23 / 20 542 t, 30–26 / 23 274 t**; everything in but the equipment
  predicate pinned to the old rule — **identical to clean**; final tree **30–19 / 17 793 t,
  30–28 / 20 622 t, 30–28 / 28 551 t**. The move is the claymore trigger and the bot's throw
  safety alone: in those three matches **44** bot throws had a same-side body inside 0.7 × the
  safe radius of the landing spot that the old rule refused. Bots never place a sentry, so the
  sentry half moves nothing headless.
- **Readability:** 12 `(viewer, subject)` pairs, 0 violations. **Layout:** a new `summary/ffa`
  surface — sixteen rows in one ladder, the local player on the winner's substrate side, headline
  **15TH** — fits at all six viewports (content 753×644 at 1366; 343×717 at 375). **`npm run
  check`** green; 330 files, 19 snapshot fields.

### Phase B (2026-09-14)

Every skirmish line is at `MATCH_ROUND_SECONDS=150`, three clients, one cycle, Foundry —
**timings shortened** on the round so the summary is reached; structural results only.

- **The board, TDM, two in-grace returns** (`--vote 0 --drop-return 2`): server ended with 10
  rows; **30 rows compared across 3 clients, 0 mismatches**; boards received 521 / 528 / 528
  over the match (≈3.5 Hz — the rate limit, not the 20 Hz snapshot cadence). Return:
  `e1 0k/1d → e1 0k/1d`, board on return 10 rows against 10 on the instance, one row with the
  client's name. XP per seat: OP2 on the winning side `MATCH COMPLETE 500, TIME PLAYED x2 50,
  MATCH WIN 500` = 1050; OP1 and OP3 `550`. Nobody was paid a `TOP OPERATOR`.
- **Past the grace** (`--drop-return 1 --drop-hold 40000`): `OP1 (player 1) came back for entity
  1 after the grace had expired — they join as a new player` … `entity 1's row and ledger now
  belong to entity 4`. Cycle: `e1 0k/1d → e4 0k/1d`, **seat lost (as required), told, joined the
  running match, 1 row with my name, board on return 10/10**. 30 rows, 0 mismatches. PASSED.
- **Red control** (the adoption call disabled): server ended with **11** rows; `e1 0k/1d → e4
  0k/0d SCORE LOST`, **2 rows with my name — DUPLICATE ROW**. FLOW CHECK FAILED on both lines;
  the replica still agreed with the server (33/33), as it should. Restored.
- **Loss on every link** (`--net bad`, +100 ms ±30 ms, 2 % loss, one in-grace return): 30 rows,
  0 mismatches; boards received 481 / 494 / 494 (the keepalive filling in behind the drops);
  resync 217 ms. This run is what found the Phase A assertion that two team-mates cannot both
  read VICTORY.
- **FFA with sentries** (`--vote 3 --wallet-streak sentry`): **8 rows, no stopgap** — the
  replaced bots' rows are gone at replacement; places **6TH / 7TH / 8TH of 8**, winner `PENNANT`
  on every client; sentries 3 placed, 79/216 (36.6 %), 13 kills, **7 on own side**. 24 rows, 0
  mismatches. PASSED.
- **`MatchXpAudit`, second half:** nine rows identical between the solo progression and the
  server ledger (`Match complete 500, Time played x4 100, Kills x1 100, Headshots x1 25, Assists
  x1 50, Longshots x1 30, Match win x1 500, MVP x1 300, Best streak x1 25`); one save-only row
  (`Challenges x1 100`) excluded and printed. `ReplicatedScoreAudit` replica half: 4 rows → 4
  rows after six replicated kills (OP1 still `3k/9sh`) → 3 rows, `BOT-B removed, OP1 7k, row
  object kept`.
- **The browser, against a local dedicated server** (`?server=127.0.0.1:8181`, the pane's rAF
  suspended, the game's own hidden-tab pump armed): joined the live match with **10 rows** in a
  replica constructed `authoritative: false`; mid-match the Tab board read the server's rows —
  `VULTURE A 1/2/100 acc 5/9 dmg 170` drawn as `56%` — with the local row flagged; at the end the
  summary read `DEFEAT · Time limit · 12 — 25` over 10 rows and the XP panel `Match complete
  +500, Time played x2 +50, +550 XP`, decoded from the table by index.
- **Determinism:** `npm run harness` (TDM ×5) and FFA headless (seed 7 ×3) **bit-identical to
  the Phase A tree** — no headless match seats a human, so nothing here reaches the sim.
  `npm run leak`: 29 → 29 subscriptions over 100 cycles, heap +0.69 MiB. `npm run check` green:
  19 snapshot fields and 18 scoreboard-row fields pinned.

### Phase C (2026-09-14)

**C1, the body** (`scripts/measure-crouch.mjs`, Echo, 30 fps, crown = `mixamorigHeadTop_End`,
world Y with the feet at the origin; the old rig's head top was 1.77 × 0.611 = 1.082 m crouched
and 1.77 × 0.306 = 0.541 m sliding):

| Clip | Crown | Skull base | Spine2 | Hips | vs old crouch rig | vs old slide rig |
|---|---|---|---|---|---|---|
| bind pose (T) | 1.737 | 1.505 | 1.287 | 0.916 | — | — |
| `Idle_Aiming` (standing) | 1.614 | 1.423 | 1.231 | 0.868 | **−0.156 vs 1.770** | — |
| `Crouch_Idle_Aiming` (a kneel) | 1.112 | 0.934 | 0.771 | 0.409 | **+0.030** | +0.571 |
| `Crouch_Walk_Aiming` | 1.264 | 1.095 | 0.982 | 0.650 | **+0.182** | +0.723 |
| `Crouch_Run_Aiming` | 1.378 | 1.218 | 1.122 | 0.816 | **+0.297** | +0.837 |
| `incoming/Crouch_Idle_Aiming_Pistol` | 1.229 | 1.035 | 0.862 | 0.481 | +0.147 | +0.688 |
| `incoming/Crouch_Idle_Reload` | 1.070 | 0.898 | 0.731 | 0.392 | −0.011 | +0.529 |
| `incoming/Transition_Stand_To_Crouch_Aiming` (last frame) | 1.080 | 0.907 | 0.769 | 0.427 | −0.001 | — |
| `incoming/Transition_Stand_To_Crouch_Pistol` (last frame) | 1.234 | 1.035 | 0.863 | 0.481 | +0.152 | — |

Crown by skin, `Crouch_Idle_Aiming`: apex 1.169, echo / hazard / pulse / rhino / viper 1.112,
sentry 1.139. `incoming/` clips on their own 69-bone skeleton vs on a skin: head **3.4–3.8 cm
lower** on the skin (`Neck1`), spine identical.

**C2, the layouts against the clips** (the same script, now against the layout `rigLayoutFor`
wears for the clip; head boxes are padded 1 cm above the crown and below the skull base):
`Crouch_Idle_Aiming` vs `humanoid-crouch` **−0.008 / +0.014 / +0.006** (crown / skull base /
Spine2 vs chest centre); `Crouch_Walk_Aiming` vs `humanoid-crouch-walk` **−0.006 / +0.015 /
+0.012**; `Crouch_Run_Aiming` vs `humanoid-crouch-run` **−0.012 / +0.008 / +0.012**;
`Idle_Aiming` vs `humanoid` −0.156 / −0.097 / −0.029 (untouched, decision 9). Layout head tops:
1.770 / 1.120 / 1.270 / 1.390; chest centres 1.260 / 0.765 / 0.970 / 1.110.

**C2, hit registration** (`scripts/hit-sweep.sh`, fixed to own its server — see "The
instrument"; 40 s per cell, Foundry, one strafing target, one seeker; the "before" is a HEAD
worktree with only the harness's `--crouch` patched in, its shooter aiming at the old rig's
0.77 m chest; the "after" shooter aims at the layout's chest):

| Target, tree | Rewind | none | 50 ms | 100 ms | 150 ms |
|---|---|---|---|---|---|
| crouching, before (old rig) | on | 65/120 = 54.2 % | 18/132 = 13.6 % | 41/131 = 31.3 % | 43/131 = 32.8 % |
| crouching, before (old rig) | off | 66/120 = 55.0 % | 22/132 = 16.7 % | 41/130 = 31.5 % | 39/132 = 29.5 % |
| **crouching, after (layouts)** | **on** | **73/120 = 60.8 %** | **47/132 = 35.6 %** | **58/138 = 42.0 %** | **45/130 = 34.6 %** |
| crouching, after (layouts) | off | 56/120 = 46.7 % | 34/130 = 26.2 % | 23/130 = 17.7 % | 0/130 † |
| standing, after | on | 59/120 = 49.2 % | 0/131 † | 38/130 = 29.2 % | 0/136 † |
| standing, after | off | 70/120 = 58.3 % | 40/134 = 29.9 % | 49/132 = 37.1 % | 53/130 = 40.8 % |

† **A dead cell is the instrument, not the rig.** Five of forty cells read exactly 0/N, in five
different (mode, preset) cells, never twice in the same one; re-running the two standing ones
in isolation gave **39.4 % and 8.4 %** at (on, 150) and **53.1 %** at (on, 50). The seeker walks
straight at the target with no pathing and fires whenever it is within 25 m, so a run where it
is stuck on geometry inside 25 m without line of sight is exactly zero. Run-to-run variance at
one cell is therefore ±20 points, and the crouch before/after — higher at all four presets
with rewind on — is four for four on a noisy instrument, not a measured delta. What the table
does say without noise: the client's aim (layout chest, interpolated view) and the server's
ruling (rewound rig with the layout of that tick) agree well enough to score 35–61 % on a
crouching strafer, where the old rig scored 14–54 % — and that the hittest's `target` field is
the provenance mark that the "after" rows came from the new build.

**C3, the pads** (composited pane, 1600 × 1000 emulated, a bot held in place by a wrapped
`controller.step` and healed every frame; the camera placed by a collision raycast so every
distance had line of sight — the first 10 m and 25 m frames were taken from inside a wall and
thrown away):

- **Sleeve height under the pad footprint, per skin** (cm along the pad normal, positive =
  sleeve above the pad's back face; at the 8 cm base, idle = run = crouch): Viper −0.4/−0.4,
  Hazard −0.8/−0.3, Pulse −0.8/−0.2, Sentry −1.3/−0.8, **Echo +1.3/+1.2, Rhino +3.6/+4.0**,
  Apex −0.6/+0.4 (its units). With the per-skin offsets: every skin between −0.1 and −1.4 (the
  pad's back face 1–14 mm off the sleeve), Echo −0.3/−0.3.
- **Hostile pixels** (2000-px buffer, one pad facing): at the plan's 5 × 3 cm, `off`
  **24 / 6 / 1** at 5 / 10 / 25 m and `deuteranopia` 29 / 3 / 2; after the human's read on a
  real display ("very small, part of the skin"), at 10 × 6 cm with the 6-px floor: `off`
  **44 / 14 / 15**. The halo's pixels cannot be counted the same way — its hue band is the
  bricks' and the hazard stripes' — so its number is not recorded rather than invented.
- **Seen:** a kneeling Rhino at 1.2 m from both sides, pads flush, halo visible; the same in
  idle from both sides and running from the left; a second enemy's pad readable at ~6 m in the
  background; Rhino at 5 m in `deuteranopia` with orange pads; at 10 and 25 m the nameplate.
  Crouch layouts over a kneeling body in the overlay (from the outline detour, same tree).
  Console: no errors. Layouts seen worn by bots over ~4 000 frames of play: `humanoid` 98.9 %,
  `humanoid-crouch-walk` 0.7 %, `humanoid-crouch` 0.15 %.
- **Reversed transition:** `crouchToStand` at −1 runs 0.97 → 0.13 over 900 ms and hands to
  `crouchIdleAiming` at 1.0 s.

**Determinism:** `npm run hashes` **de376f8c** at 3600 ticks, identical to the HEAD worktree's
Node run (all 10 maths digests agree, state matches across all 3600 ticks) and to the browser's
`__operator.determinism.fingerprint()` in the same tree. Necessary, not sufficient: the
scenario has no rig in it. `npm run check` green.

### Phase D (2026-09-14)

**The manifest** (`npm run animations`, all 24 delivered files; hips in the file's own metres,
mean over the clip or first → last for a one-shot; "off-skin" is a bone the last clip animates
that some skins lack, with how many of the seven):

| File | Clips | Last clip | Length | Off-skin tracks | Hips |
|---|---|---|---|---|---|
| `Idle_Relaxed` / `Idle_Aiming` / `Walk_Relaxed` / `Walk_Aiming` / `Run_Relaxed` | 6 / 9 / 3 / 2 / 5 | `mixamo.com.NNN` | 7.717 / 2.117 / 1.317 / 1.383 / 0.517 s | none (65-bone) | 0.933 / 0.890 / 0.911 / 0.882 / 0.825 |
| `Crouch_Idle_Aiming` / `Crouch_Walk_Aiming` / `Crouch_Run_Aiming` | 8 / 4 / 11 | `mixamo.com.NNN` | 2.117 / 1.017 / 0.783 s | none | **0.420** / 0.666 / 0.838 |
| `Transition_Crouch_To_Stand` | 12 | `mixamo.com.011` | 1.100 s | none | 0.424 → 0.914 |
| `Death_Stand` / `Death_Crouch` | 10 / 13 | `mixamo.com.NNN` | 3.033 / 2.367 s | none | 0.914 → 0.145 / 0.424 → 0.156 |
| `incoming/Death_Stand_01` | 3 | `mixamo.com.002` | 2.617 s | Jaw (6/7), Neck1 (6/7), eyes (5/7) | 0.949 → 0.138 |
| `incoming/Sprint_Relaxed` | 8 | `mixamo.com.007` | 0.517 s | same | 0.855 |
| `incoming/Transition_Stand_To_Crouch_Aiming` | 10 | `mixamo.com.009` | 1.517 s | same | 0.927 → **0.438** |
| `incoming/Idle_Reload` / `Walk_Reload` / `Crouch_Idle_Reload` | 5 / 13 / 2 | `mixamo.com.NNN` | 3.317 / 4.100 / 4.150 s | same | 0.926 / 0.900 / **0.402** |
| `incoming/Idle_Aiming_Pistol` / `Walk_Aiming_Pistol` / `Run_Aiming_Pistol` / `Sprint_Aiming_Pistol` | 4 / 12 / 6 / 7 | `mixamo.com.NNN` | 1.350 / 0.800 / 0.733 / 0.517 s | same | 0.916 / 0.915 / 0.824 / 0.898 |
| `incoming/Crouch_Idle_Aiming_Pistol` | 1 | `mixamo.com` | 3.817 s | same | **0.494** |
| `incoming/Transition_Stand_To_Crouch_Pistol` / `Transition_Crouch_To_Stand_Pistol` | 11 / 9 | `mixamo.com.NNN` | 1.017 / 1.367 s | same | 0.918 → **0.494** / 0.494 → 0.918 |

0 of 24 met the contract. Hips × `modelScale` 0.975 reproduces C1's hips column to the
millimetre (0.420 → 0.409, 0.494 → 0.481), so the manifest's number and the instrument's are
one number.

**`measure-crouch.mjs`, Echo, every incoming clip against the layout `rigLayoutFor` wears**
(Δ = drawn − layout, crown / skull base vs head-box bottom / Spine2 vs chest centre; the
shipped three are the C2 rows, unchanged, as a control):

| Clip | Layout | Δ crown | Δ skull base | Δ chest | Admitted |
|---|---|---|---|---|---|
| `Crouch_Idle_Aiming` (control) | `humanoid-crouch` | −0.008 | +0.014 | +0.006 | — |
| `Crouch_Walk_Aiming` / `Crouch_Run_Aiming` (control) | walk / run | −0.006 / −0.012 | +0.015 / +0.008 | +0.012 / +0.012 | — |
| `Transition_Stand_To_Crouch_Aiming` (last frame) | `humanoid-crouch` | **−0.040** | −0.013 | +0.004 | yes — 3.4 cm of it is `Neck1` on the skin |
| `Crouch_Idle_Reload` | `humanoid-crouch` | **−0.050** | −0.022 | −0.034 | yes, on record — decision 12 |
| `Crouch_Idle_Aiming_Pistol` | `humanoid-crouch` | **+0.109** | +0.115 | +0.097 | no — decision 11 |
| `Transition_Stand_To_Crouch_Pistol` (last frame) | `humanoid-crouch` | **+0.114** | +0.115 | +0.098 | no |
| `Idle_Reload` / `Walk_Reload` | `humanoid` | −0.125 / −0.154 | −0.069 / −0.089 | +0.019 / −0.002 | yes — the standing rig's own 16 cm (decision 9) |
| `Sprint_Relaxed` | `humanoid` | −0.246 | −0.194 | −0.087 | yes — `Run_Relaxed` is −0.254 / −0.187 / −0.102 |
| `Idle_Aiming_Pistol` / `Walk_Aiming_Pistol` / `Run_Aiming_Pistol` / `Sprint_Aiming_Pistol` | `humanoid` | −0.131 / −0.143 / −0.221 / −0.160 | −0.073 / −0.077 / −0.177 / −0.112 | +0.014 / +0.010 / −0.088 / −0.023 | no (family) |

Re-run after the import, from the slot folders: every row identical, as bit-identical tracks
must be. The `--pose` table for `Crouch_Idle_Reload` and `Crouch_Idle_Aiming_Pistol` (joints in
the actor frame) is one `measure-crouch.mjs --dir … --pose` away and was not copied here; the
kneel's joints are what `HUMANOID_CROUCH_RIG` was built from and the reload's differ by the
numbers above.

**The import**, under the real `GLTFLoader`, source's last clip against the written file's only
clip: `Death_Stand_01` 3 → 1 clips, 207/207 tracks, 2.6167 s, 69/69 bones, **0 differing
values**, 508 → 128 KiB; `Sprint_Relaxed` 8 → 1, 978 → 80; `Transition_Stand_To_Crouch_Aiming`
10 → 1, 1152 → 121; `Idle_Reload` 5 → 1, 793 → 234; `Walk_Reload` 13 → 1, 1533 → 273;
`Crouch_Idle_Reload` 2 → 1, 402 → 275; and as a test of the originals, `Idle_Aiming` 9 → 1
(195 tracks, 65 bones) 727 → 106 and `Death_Crouch` 13 → 1, 1231 → 179 — all identical. The
eleven originals together: 7 088 KiB now, 1 387 if imported (decision 13). Shipped library:
17 files, 8.0 MiB; `incoming/`: 7 files, 5.9 MiB.

**The check**, red on three planted defects (a stray `.glb` in `actions/`; `Death_Crouch` moved
under the `name` selector plus a slot naming an `incoming/` file; `DEATH_VARIANTS = 3`), each
caught by name; green on the tree: 15 slots, 13 the selector returns, 2 with variants, 17
shipped files, 6 on the contract, 11 legacy, 7 waiting. `npm run check` green with it in the
chain, 332 files.

**In the pane, a solo TDM on Foundry, all seven skins ready, 17 animation fetches, every one
once, no `THREE.PropertyBinding` warning, no console error.** Over 6 s of a live match the
slots seen on nine skinned bodies (samples at 50 ms): `walkWeaponReady` 426,
`idleWeaponReady` 102, `runRelaxed` 70 legacy + 3 `Sprint_Relaxed`, `deathStand` 180 legacy +
116 `Death_Stand_01`, `standToCrouch` 108, `crouchToStand` 15, `reloadStand` 30, `reloadWalk`
26, `reloadCrouch` 3. Held bot (MARLOW, hostile), followed at 2.6 m: a reload on a 2.4 s
shotgun played `reloadStand` at **×1.382** (3.317 s clip), support grip released, pads on both
shoulders; crouch held: `standToCrouch` **0 → 1.38 s forward**, then `crouchIdleAiming`;
`reloadCrouch` at **×1.729** (4.15 s clip) in the kneel; crouch released: `crouchToStand`
forward at ×1. **Twelve deaths across the roster, clip index = `deathVariant % 2` on all
twelve** (variants 0 and 2 → `Death_Stand`, 1 and 3 → `Death_Stand_01`). **Fourteen lives,
one run clip per life on all fourteen**, 7 legacy / 7 `Sprint_Relaxed`; bot 106 dealt legacy
on spawn 8 and `Sprint_Relaxed` on spawn 9. After the animator's last edit, the pane went
hidden and the same match was stepped by hand (`loop.frame`, 1 500 frames): 9 skinned,
`standToCrouch` 97 / `crouchToStand` 14 / `reloadWalk` 13 / `reloadCrouch` 1 samples, live.

**Determinism:** `npm run hashes` **de376f8c** at 3600 ticks — identical to Phase C's;
`node-hashes.json` unchanged. Expected: nothing here is read by the simulation (`Bot.animation`
is a getter the renderer calls), and the scenario has no renderer.

**Addendum, the eleven imported** (decision 13): `GLTFLoader` identity on all eleven, 0
differing values; library **8 199 → 2 498 KiB**; the check red on a session export planted
over `actions/Idle_Reload.glb`, then green — "17 shipped files, every one on the export
contract"; `measure-crouch.mjs` rows identical; `npm run hashes` de376f8c; in the pane all
seventeen files playing under their own names, no console error.

## Needs a browser

The Browser pane in this session ran with `requestAnimationFrame` suspended; everything above
was driven by stepping `game.loop.frame` by hand and posting canvas captures to a local sink.
What that cannot show, and a human on a real display must: the cross-fade between locomotion
clips; the support hand tracking the weapon during a run; whether the blue nameplate and the
red pads (once built) read as *equipment* rather than *markers* at play speed; and the crouch
transition once `timeScale = -1` is in.

**From Phase A**, the same split: the thermal pass in a networked FFA (everybody orange, nobody
near-black); the sentry body's tint from a team-B seat and from an FFA seat, own sentry blue;
a claymore triggering on a same-side body in FFA; the danger arrow for a same-side grenade; and
the announcer saying "victory" to exactly one player at the end of a networked FFA. The FFA
summary screen *was* seen — `/probes/layout.html?show=summary/ffa` — and reads **15TH · ALLY-003
WINS · KILL LIMIT · 30 — 27** over one sixteen-row ladder headed OPERATORS.

**From Phase B:** the live board and the summary *were* seen in the pane against a local
dedicated server (Measured, above). What needs a display and a second human: the board holding
still during a firefight rather than flickering between a counted and a replicated answer; a
friend dropping past thirty seconds and coming back to one row with their name and their kills
on it; and `Kills x7` on the XP panel after a match where you actually killed seven.

**From Phase C:** the pane composited this time (the follow loop teleported the player around
a held bot every frame and set the view through `game.input.setView`), so the pads, the plates
and the hitbox overlay over a kneeling enemy *were* seen at 1.2, 5, 10 and 25 m in both
palettes, in a running match. What needs a display: the pads at play speed, and whether they
read as equipment — see "Human playtest, when Phase C is closed".

**From Phase D:** the pane composited for the first half (a held hostile bot followed at 2.6 m
through a standing reload, the authored crouch, a kneeling reload and the stand-up; the pads on
its shoulders throughout) and went hidden for the last check, which was stepped by hand. What
needs a display is feel, not existence: whether a reload fitted to the weapon at ×1.4 or ×1.7
reads as a reload or as a body on fast-forward; the walk-reload's feet at a 4.6 m/s walk; the
authored stand → crouch beside last session's reversed one; two sprint gaits in one roster; the
second fall; and the kneeling reload's head 5 cm under its box — see "Human playtest, when
Phase D is closed".

## Between phases — the firing audio followed the viewer's weapon (2026-09-14)

Reported by the human between D and E: *every* shot in the match sounded like whatever the
local player was holding — hold a sniper and the lobby fires snipers; swap, and it swaps with
you. One line, in `MatchFeedback`'s `EV.WeaponFired` handler since M9's partition (`939e7d4`):
`const def = weapons.definition` — the local inventory's active weapon — where the event has
carried the shooter's `weaponId` all along (a bot's `WeaponSystem`, the local one and
`NetSession` all write the firing def's id into it). The muzzle-flash scale came off the same
wrong def. Now `WEAPON_DEFS[p.weaponId]`, and an unknown id throws rather than falling back to
the viewer's weapon, which was the bug; `FeedbackDeps.weapons` had no other reader and is gone.

**Measured in the pane** (solo TDM, the viewer's slot set to `sniper_kestrel` through
`WeaponSystem.setDefinition`, `playGunshot` wrapped to record which def's `voice` it was handed,
paired with the `weapon.fired` events in order): broken tree, 50 bot shots over six weapons
(`ar_halcyon` 20, `smg_meridian` 18, …) — **50 of 50 played the viewer's Kestrel voice**, the 2
that "matched" being a bot that carried a Kestrel itself. Fixed tree, 96 bot shots over six
weapons, the viewer swapped from the Kestrel to the Talon halfway — **96 of 96 played the
shooter's own weapon's voice, 0 the viewer's.** `npm run check` green.
