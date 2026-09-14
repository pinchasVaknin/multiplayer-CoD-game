<!-- Moved verbatim from PLAN.md lines 5211–8704 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# M11 Gate B — playtest round 2

A browser session against a deployed server produced eleven reports and one feature request.
Everything below is what they turned out to be; where a number is quoted it was measured, and
where something is reasoned rather than measured it says so.

## One entity id was behind three of them

`PlayerCombatant.entityId` was `PLAYER_ENTITY_ID` — the constant zero — hard-coded, since M2.
Over the network the local player is entity 1 or above, and that id is what
`Ballistics.nearestTarget` compares its `excludeId` against. So **the shooter's own rig was a
legal target for the shooter's own bullets**, and `raySlab` opens its interval at `tmin = 0`: a
ray that starts inside a box hits it at zero distance. Every shot fired on a networked client
terminated on the player who fired it, before it had travelled a millimetre.

Three reports, one line:

| Reported as | What it was |
|---|---|
| "the very first shot registers a hit/kill marker on nothing" | The self-hit. A head-box hit at 0 m is lethal, so it produced a *kill* marker |
| "screen stays red at 0 HP, no regen until damaged again" | Self-damage drove the local `Health` to zero. A networked client does not step its own health, and `setReplicated` only ran when the **server's** value changed — which it does not while the server thinks you are unhurt |
| "bullets pass through lobby bots and dummies" | The round never got past the shooter's own chest |

The reason it stopped after the first burst rather than continuing is the same mechanism: once
the local health reached zero, `health.alive` went false, `DamageSystem.apply` began returning 0
for a dead target, and the self-hits stopped — leaving the bar at zero.

The `PLAYER_ENTITY_ID` audit that followed found **seven more** in client code, all the same
shape and all silently wrong the moment a server assigned a seat:

- `Melee.sourceId` — the knife stabbed its own swinger.
- `ThrowController.step`'s thrower id — your own grenade crossed the wire stamped as entity 0,
  so the server's authoritative copy of it did not match and was adopted as somebody else's:
  §8.24's own-grenade exclusion could not fire.
- `MatchEquipment.onFlashed` — a flashbang addressed to you was ignored.
- `MatchEquipment.onSpawned` — the per-life grenade refill.
- `MatchMeta`'s two perk predicates — Dead Silence made nobody quiet, Battle Hardened protected
  nobody.
- `MatchMeta.isMvp`'s score lookup — always undefined, so nobody was ever MVP.
- `Game`'s chopper camera lookup — **the Chopper Gunner never took the camera over the network**.
  The gunship flew and its owner watched it from the ground.

This is the standing authority-migration failure again, and the useful generalisation is
narrower than "audit the constant": *a constant that names an entity is a constant that was
right when there was only one of them.*

## The dummies had a second, independent cause

`DUMMY_IDS` were 1..12, chosen in M2 when the id space held the player at 0 and bots from 100.
**1..99 is the connected-human range.** The warmup arena is the greybox room, so the moment it
seated a human beside the dummies the two collided in `DamageSystem`, whose table is keyed by
entity id and whose `register` evicts whatever is already at one. The third player to connect
*was* the 25 m dummy: one silently replaced the other, and shots at the survivor were then
rejected as self-hits.

Both causes had to be fixed for the range to work in the arena, and either alone is enough to
break it. Dummies now sit at 10_000+, clear of humans (1-99), bots (100+) and streak entities
(900+).

## FFA scored roughly three kills in seven

`ScoreSystem.recordKill` drops a kill whose victim shares the killer's `ScoreTeam`. Free-for-All
keeps the two-team substrate — that is deliberate and documented — so half of every FFA lobby
shares a side with any given player. `FreeForAll.onKill`'s own comment says *"every kill counts,
including one on somebody who happens to share your substrate side"*; it was the only half of
that sentence the code did not implement.

**Measured, same seed, same match**: the 30-kill limit was reached at **476.9 s** before and
**242.8 s** after. The ladder was running at roughly half speed, which is why a match nominally
decided on kills was in practice always decided by the clock.

`ScoreSystem.freeForAll` is set beside `DamageSystem.friendlyFire`, from the same registry flag,
in both runtimes. They are the same fact — *there are no teammates here* — and setting one
without the other is what produced a mode where you could shoot someone but not score them.

The HUD half was separate and worse: the FFA banner read `row.score`, and the replicated path
records kills with **zero points on purpose** (what a kill is worth is a mode decision, and the
mode is not running on a client). So the banner showed `0` against a leader of `0` for the whole
match. It reads `row.kills` now, which is also what `checkWinCondition` decides on — the bar and
the limit it counts toward are finally the same quantity.

## The bomb existed and was never visible

Two facts, and neither is a rendering bug:

1. `bombX/Y/Z` was written in exactly two places — the round reset and the carrier's death — so
   while the bomb was **held** it reported the point where it was last dropped. Stale everywhere
   it is read: the renderer hid the mesh rather than draw a lie, bots were sent to a place the
   bomb had left, and `BombInfo` replicated the same lie to every client.
2. The bomb spawns **inside the attackers' central spawn zone** (Foundry authors it at
   `z = -21.17`; the spawn there has radius 3). Bots take it by walking over it, humans must
   press Use — the post-M8 playtest's rule — so on the first tick of every round an attacking
   bot was already standing on it and took it before a human saw the round start.

Together: a carried bomb was not an object in the world at all, it was a boolean on an entity,
and the human never held it. `followCarrier` keeps the position true every tick, the renderer
draws it at hip height on its carrier, and a four-second `pickupGraceSeconds` at round start
gives the key press first refusal. S&D still completes on three seeds (65.2 s, 86.2 s, 97.8 s),
so the grace does not strand a round nobody claims.

## Empty matches held the only live slot

§4.20 refuses to *start* a match for zero humans in two places. Nothing covered the case after
`RUNNING`, so a match whose last player disconnected kept simulating ten bots to a win condition
and held the process's single live-match slot for the whole of it. Every ballot that resolved
meanwhile hit the one-match cap and sent the arena back to free play with a notice — **one
disconnect could cost the next lobby its match.**

`--abandon` is the probe: every client leaves a running match, and the harness reports how long
the server took to release the slot.

| | Slot released after |
|---|---|
| Red control (`RUNNING` case removed) | **132 978 ms** — the match ran to its win condition |
| Fixed | **30 ms** |

`LiveMatch.everSeated` latches on the first seat, which is what separates *emptied* from *not
yet filled* — the second is also true between allocation and migration, and of the instance the
leak harness builds deliberately empty.

## The summary screen was a dead end with a stuck clock

Three complaints, three causes:

- The timer sat at 14 because the number was written once from `holdSeconds` and never touched
  again. It ticks from the render pass now. Display only — the server still migrates everybody
  back on its own clock, and a client that decided for itself would leave early and stand in a
  torn-down world.
- The button read "Continue" and went to `MENU`, whose exit handler tears the world down and
  clears `this.server` — so pressing it **left the server**. It returns to the game now when
  connected: the seat, the socket and the world all survive, and the migration to the arena
  lands normally. Single-player is unchanged.
- The SUMMARY exit handler tore the world down unconditionally; it now returns early for
  `to === 'MATCH'`, which also removes a double teardown on the rotation path.

**Corrected at round 4, and the correction is about all three of them.** Every fix above is in the
tree and every one of them is right about the thing it names. None of them ever ran, because the
client stopped servicing its socket the moment this screen appeared and the server closed the
connection ten seconds into a fourteen-second hold. So: the button did go back to the game, and
the game it went back to had no connection left, which put the player on the main menu one frame
later — indistinguishable from the bug this bullet claims to have fixed. The countdown did tick,
against a migration the client could no longer receive, and was cut off before it reached zero.
The local `dt` is gone entirely now; the number is the server's own deadline. See "the summary
screen was a screen that stopped listening" below. The reading to take from it is that a fix to
the thing that was reported can be complete, correct and still never execute — and that this
section's confidence came from reading the code rather than from watching the path run.

## Create-a-Class was a state where it should have been an overlay

**Superseded at round 4. The diagnosis below stands; the fix it describes has been removed.**
Round four's report asks for the opposite design — the editor is a front-end screen and inside a
match the only way to change class is keys 1-5 — so there is no overlay any more and no route
into the editor from `MATCH` or `PAUSED` at all. The paragraph about the deferral, two below,
is the half that survived and it now protects the 1-5 path alone. See "the loadout doctrine"
under round 4 for what replaced this and why. Kept rather than deleted because the *diagnosis*
is still the record of what was wrong with the M11 §6.6 edge.

The editor is two different things sharing one screen. From the front end it is a state: no
world, nothing running, `LOADOUT` is honest. From inside a match it is an overlay — and it was
the state in both cases, so every route out went somewhere costly. Back went to `loadoutReturn`;
Escape went to `PAUSED`; and the editor's own **"Start match"** button calls `onLaunch`, which
clears `multiplayerJoin` and starts a solo game. That is the reported *"kicks the player out to
a Solo game"*, exactly.

Opened over a live world it became an overlay: the state never left `MATCH` or `PAUSED`, the
socket was untouched, the match ran underneath (there is no pausing a dedicated server), the
body stood still through `ClientMatch.uiFocus`, and "Start match" was not offered because there
is no match to start from inside one. All of that is gone at round 4, `uiFocus` included — with
the overlay removed it was a boolean with no writer.

**The class change itself had to be deferred locally as well**, and this is Tier 1 #20 arriving
from the client's side: `meta.setLoadout` re-runs the perk hooks and one of them writes
`PlayerController.speedScale`, so a class swapped on a standing body changed how fast this client
predicted itself moving while the server deferred to the next spawn. A constant per-tick
disagreement about speed, which is what rubberbanding is. It mattered little when the editor was
behind a pause screen; the quick selector puts it one keypress away. Both sides now follow the
same rule.

## Killstreak keys followed the wrong list

Keys 3/4/5 indexed the *earned* streaks, packed from zero — so which key fired a given streak
depended on how many others happened to be in hand. A player holding only their Chopper Gunner
found it on key 3, and key 5, the key the loadout editor labels "Killstreak · key 5", did
nothing. They index the class's three slots now, and the earned list only decides whether the
press is honoured. The HUD paints the same rule in three states: empty, owned-but-unearned (the
name is worth reading — it says what key 5 is *for*), and ready.

The mortar had a separate hole: its overlay's confirm called `streaks.activate` directly, which
on a networked client fires into the copy of `StreakSystem` that is deliberately never
simulated. The mark was confirmed, the streak left the pending list, and no shell ever fell. It
goes through `spendStreak` now, which is the one door that knows which kind of match this is.

## Smoke: the mechanic worked, the picture did not

Measured on the server over a 45 s match: **6 clouds at peak, 31 sight lines blocked**. §6.8's
requirement was being met all along.

What was wrong was that the player could see through a cloud the bots could not — eleven
billboards at a peak alpha of 0.42, which is worse than no smoke at all, because the two sides
of the same cloud disagreed about what it was for. Eighteen puffs, peak alpha 0.72, a third of
them clustered near the middle so the cloud has a core, and a texture that stays solid to 55% of
its radius instead of 45%.

`equipmentStats` now reports `smokeLive` and `smokeBlocked`, and the harness prints them. The
claim had been wired since the equipment commit and never measured, and a wired occluder that is
never consulted is indistinguishable from a working one.

## The quick class selector (the feature)

Five classes, five keys, no menu. A HUD panel down the left, `pointer-events: none`, bound to
the digits — offered in exactly two windows and nowhere else:

- **The pre-match freeze**, lengthened from 3 s to **10 s**. Round one only: a ten-second hold
  between every S&D round would add a minute to a best-of-five for a decision nobody is making
  at that point. `MatchFlow.warmupSeconds` is one accessor read by the countdown, the phase
  machine and the replicated path, so the three cannot disagree about which limit applies.
- **The respawn wait**, where the next body is seconds away.

Deliberately not offered while alive and playing: there the answer is Create-a-Class and the
change lands on the next death, which is CoD's rule.

**Corrected at round 4.** Create-a-Class is no longer reachable from inside a match, so these
two windows are not one route among several — they are the *only* way to change class in a
match. The sentence above described a fallback that no longer exists; the rule it states is
unchanged, and the panel it describes now carries more weight than it did. See "the loadout
doctrine" below.

The digit listener is registered *after* the vote overlay's, so a ballot keeps first refusal,
and it consumes the key — picking class 2 does not also pull out the pistol, and picking class 5
does not call in a Chopper Gunner.

**The server applies a pre-match pick immediately** rather than on the next spawn
(`ServerMatch.applyPendingLoadoutNow`), because otherwise "the class you press during the
countdown" would arrive after the player's first death. The freeze is the one window where that
is free: the movement axes are stripped before they reach the controller, so a `speedScale` that
changes there cannot produce a misprediction, and the spawn-serial bump is the same
discontinuity a death already produces — which is exactly how the client is told to adopt the
new pose without charging itself for the difference.

## What is measured, and what is not

Measured headlessly, this session:

| Probe | Result |
|---|---|
| FFA kill limit, same seed | 476.9 s → **242.8 s** |
| Empty-match teardown | **132 978 ms → 30 ms**, red control watched first |
| Smoke on the server | **6 clouds peak / 31 LOS rejections** |
| S&D completion, 3 seeds, with the pickup grace | 65.2 s / 86.2 s / 97.8 s, all complete |
| `npm run check` | boundaries, cosmetic audit and all three typecheck targets pass |

Repeated twice more on the same tree, because this harness is wall-clock paced and one run of it
is a sample rather than a fact:

| Run | Quick loadout | Alive (must be 0) | Tab while dead | Into live |
|---|---|---|---|---|
| 1 | 10 851 tk / 34 win | **0** | 3 639 / 7 278 | 1 |
| 2 | 10 634 tk / 32 win | **0** | 3 432 / 7 057 | 0 |
| 3 | 10 848 tk / 33 win | **0** | 3 697 / 7 274 | 0 |

**Not measured here, and it needs a browser.** Every client-side fix above is reasoned from the
code and compiles, but the preview pane never fires `requestAnimationFrame`, so none of it has
been *seen*: the self-hit's absence, the bomb on its carrier, the summary countdown, the loadout
overlay staying connected, the streak keys, the grenade refill, the smoke's new density and the
quick selector itself. That is one session at a keyboard, and it is the same list §8's
browser-only claims were already waiting on.

The `HeadlessClient` cannot stand in for it: it drives `NetClient` and `Prediction` directly and
builds no `ClientMatch`, which is precisely why a bug that made every networked client shoot
itself survived every harness run in the milestone.

## Playtest round 3 — the ballot that followed you into the match

Three reports, and two of them were the same bug wearing different hats.

**The vote overlay is the arena's, and nothing told it when you left.** `Server.broadcastVoteState`
sends to `warmup.sessions` only — correct, the cycle belongs to the arena — so a migrated player
simply stops being told anything. `VoteOverlay.apply` is the only writer of `root.hidden` and of
`info`, so whatever phase that client last heard is what it keeps, on screen, for the whole match.

It is a **race**, which is why it was "sometimes": the ballot resolves, the server broadcasts
`ALLOCATING` at 4 Hz, and the migration happens once every client reports its background build
ready. A client that had already built that map reports in milliseconds and can be migrated
before the broadcast that would have taken the overlay down.

The second hat is the one that reads as a different bug entirely. `handleDigit` consumes 1-5
whenever `info.phase` is a ballot — so a stale `MAP_VOTE` ate keys 1-3 and a stale `MODE_VOTE`
ate all five, *before* they reached the quick class selector. Reported as **"sometimes I can't
switch class"**, and the two symptoms never looked related because one is a panel and the other
is a keypress.

Two changes, and the second is the one that generalises:

- `Game.skirmishSink().onMigrated` calls `voteOverlay.hide()`, beside the streak and projectile
  discards that were already there. Same §4.18 rule, applied to the channel that had been missed:
  state from an instance you have left.
- **A hidden surface never consumes a key.** `handleDigit` returns false on `root.hidden` before
  it looks at anything else. `root.hidden` was explicitly rejected as the test when this was
  written — correctly, because the overlay is also visible during `PLAY` and 1-5 must behave
  normally then — but the converse is absolute and was missing.

Verified in a browser against a real server: with the ballot genuinely open, `handleDigit(1)`
still returns true and the vote is cast (the harness reports 2 votes per client, unchanged);
after `hide()`, digits 1 and 3 both fall through.

### The class panel's own window, measured

The round-2 fix — track the respawn countdown rather than `isPlayerDead` — was already correct.
Traced end to end over a real connection, one line per transition:

| t | where | phase | dead | window |
|---|---|---|---|---|
| 25 | arena | LIVE | no | closed |
| 39 | arena | LIVE | yes, 4.4 s left | **open** |
| 44 | arena | LIVE | no | closed |
| 47 | dunes | WARMUP | no | **open** |
| 57 | dunes | LIVE | no | closed |

Which is the requested behaviour exactly: the ten-second pre-match window and the 4.5 s respawn
window, and nothing in between.

**Corrected at round 4.** The last column originally read "panel", and it did not describe a
panel — it described the *window*, which is what `updateQuickLoadout` computes. The two were the
same thing everywhere except on screen: `.ql` sets `display: flex` and had no `[hidden]`
companion rule, so the attribute this table was reading went on and off all match without hiding
anything. Every row above is still true of the derivation and none of them was ever true of the
pixels. See "Three surfaces, and the panel that was never hidden" below; the reading to take from
it is that a trace of a predicate is not a trace of a picture, and the column heading should say
which one it is.

## Playtest round 4 — three surfaces, and the panel that was never hidden

B1, B6 and B13. The brief's hypothesis was that all three are one shape — *a visible surface
whose visibility is written in two different places, or is not written at all at the moment it
needed to change* — and two of the three are exactly that. The third turned out to be a shape
one layer further down, and it is the interesting one, because every measurement anybody has
ever taken of it was green.

### The invariant, first, because it is what the three fixes have in common

**Every HUD surface has exactly one writer, and its visibility is a pure function of state that
outlives the surface, evaluated once per frame from one place.**

`shared/ui/HudSurfaces.ts` holds the rules — `scoreboardOpen`, `quickLoadoutWindow`,
`debugOverlayVisible` and the death-screen countdown they read — and `Game.updateHudSurfaces` is
the one place that evaluates them, beside the vote overlay's tick in the render pass. They are in
`shared/` for the reason `pickSpectatorTarget` is: this process can run them, and a claim about a
panel is otherwise a browser claim for ever.

Round three established half a rule — *a hidden surface never consumes a key*. This is the other
half, and the sharper statement of it is that **a tick is not a frame**. Anything written from
`simulate` stops being written the moment the screen leaves `MATCH`, and a surface drawn every
frame from a value updated only on ticks is a latch waiting for somebody to pause.

### B13 — the derivation was right, the panel was never hidden

*"The class-select square does not disappear after respawn."*

Round two fixed this by tracking the respawn countdown rather than `isPlayerDead`. Round three
traced it over a real connection and published the transitions. This session ran the extracted
predicate against three headless clients over a full cycle: **0 violations across 34 windows and
10 851 ticks**, where a violation is the window open while the client is alive and outside the
pre-match freeze. Every one of those greens is honest. None of them was about the screen.

`.ql` sets `display: flex` and had **no `.ql[hidden]` companion rule.** The `hidden` attribute
hides an element only because the UA stylesheet says `[hidden] { display: none }`, at the lowest
specificity there is, and any author-level `display` outranks it. So `QuickLoadout.hide()` set the
attribute, `shown` went false, `handleDigit` correctly stopped consuming digits — and the panel
stayed painted from the first `show()` of the session to the end of it. What the player reported
is not really that it failed to disappear after a respawn; it is that a respawn is the first time
most players see it appear at all.

The trap is documented twice in this codebase already — `.op-screen[hidden]` in `app.css`, and
`.hud-mortar[hidden]` ninety lines above `.ql` in the same file, whose comment says *"Required,
not defensive"* and names the exact failure. The quick selector's block was written afterwards
without it. `.ql__row` had the same hole, which would have painted the rows of class slots nobody
has authored.

Every surface that hides through the attribute was audited in the same pass. Two gaps, both in
that block; `.hud`, `.dbg-root`, `.op-screen`, `.op-vote`, `.op-loading`, `.eom`, `.eom__xp`,
`.hud-mortar`, `.dbg-botlabels` and `.sb__row` all carry theirs, and the scoreboard hides through
an explicit `.sb--on` class rather than the attribute at all.

**The lesson is about the measurement, not the CSS.** Round three's table has a column headed
"panel" that was really the window, and no probe in this project can tell those apart, because
none of them renders. That is what the "needs a browser" list is for, and it is why round three's
section has been amended rather than left standing.

### B1 — two copies of "is the debug overlay open", and the × wrote one of them

*"The × closes it, but coming back to the game reopens it."*

`Game.overlayWasOpenBeforePause` was a second copy of `DebugOverlay.visible`, kept so that
resuming from a pause could put the panel back where it was. The × called `setVisible(false)` on
the overlay itself and never touched the copy, so opening the overlay from the pause menu, closing
it with the ×, and resuming ran `restoreOverlayAfterPause()` against a `true` the player had
already cancelled. The panel came back on the way into the game, exactly as reported.

The fix is one value instead of two booleans, and it is a **tri-state** rather than a flag because
the two booleans were carrying more than one bit between them:

| `debugRequest` | Written by | Visible in `MATCH` | Visible in `PAUSED` |
|---|---|---|---|
| `'none'` | the ×, Escape, the pause button when it is up | no | no |
| `'inMatch'` | the demotion on resume | yes | **no** — M5's rule about two modal panels |
| `'onPause'` | the pause menu's button | yes | yes — the tuning sliders need a cursor |

Every documented behaviour survives, including the two that pull in opposite directions: the
overlay goes off screen for the duration of a pause it did not ask for, and it stays up over one
it did. `hideOverlayForPause` and `restoreOverlayAfterPause` are gone, and nothing is written on
entering `PAUSED` at all, because the predicate already answers differently there. The request
lives on `Game` rather than on the overlay because it has to **outlive the surface** — the panel
belongs to the world and a rotation throws the world away — so `buildWorld` re-binds `onDismiss`
and seeds the new overlay from the predicate, and a request survives a map change.

`DebugOverlay.setVisible` is idempotent now, which is what makes calling it every frame
affordable: showing refreshes every tuning panel, and doing that sixty times a second would put
the overlay squarely inside the frame times it exists to report.

### B6 — a rule moved to the netcode and left its exception behind

*"Tab sticks in multiplayer while you are dead."*

`Input.sampleSpectating` keeps `Btn.Scoreboard` through a death **on purpose**, and has since M4:
*"the death screen is exactly when you want to look at the board."* `NetClient.neutralise` is the
netcode's restatement of that same rule, written so both halves of a networked match read it from
one place — and it zeroed the whole bitfield. The standing authority-migration failure in
miniature: the rule crossed to the wire and the exception did not. Over the network the one fact
the scoreboard is derived from was forced to nothing the moment the server said you were dead.

Measured through the browser's own seam — `applyNonReplayed`, where `MatchWorld` hands the
neutralised command to `ClientMatch`, and therefore the only place the loss is visible. Red first:
the "before" column is a run of this tree with the one line reverted and everything else, the
probe included, left alone.

| Probe | Red (the bug restored) | Green |
|---|---|---|
| Tab held on commands reaching the sim | 28 415 ticks | 33 231 ticks |
| ...of them **while dead** | **0** of 5 296 dead ticks | **3 639** of 7 278 dead ticks |
| Scoreboard open while dead | **0** ticks | **3 639** ticks |
| The run | **FLOW CHECK FAILED** | passed |

Half, because the harness holds Tab on a 50% duty cycle — two seconds down, two up, so the probe
sees both edges either side of a 4.5 s death rather than sampling one level. The hold sits
**outside** the `alive` gate in `HeadlessClient.sample`, deliberately: a client that only pressed
Tab while alive could never have found a bug whose whole content is that the bit is discarded
while dead.

Keeping it costs no divergence and cannot. Nothing in `PlayerController.step` or `Weapons.step`
reads bit 6; `NetPlayer.step` does not consume a dead player's command at all; and the frozen
path's `lastButtons` is only ever asked whether the trigger was down.

**The second half of B6 is the latch, and it is why the write moved.** The scoreboard's only
writer was the last line of `ClientMatch.simulate`, and `simulate` is reached from `net.update()`,
which `Game.simulate` calls only while the screen is `MATCH`. Pausing stops the tick;
`Input.clearHeld` then drops the Tab bit into a loop that is no longer running; the board stays up
over the pause screen holding a key nobody is pressing. It is derived once per frame now, from
`scoreboardHeld` — itself derived from the `prevButtons` the match already keeps for edge
detection, not a new copy of it — and from the screen, which outlives the tick.

### The HUD surface table

The artefact, and the thing that is meant to stop this class of bug coming back. Read the last
column with B13 in mind: it is where the failure was.

| Surface | Single writer | Derived from | Consumes from input | Hides by |
|---|---|---|---|---|
| Scoreboard | `Game.updateHudSurfaces` → `Match.setScoreboardOpen` | `scoreboardOpen` — screen, editor, held Tab | `Btn.Scoreboard`, a level read from the command (S4.2). Consumes nothing | `.sb--on` class |
| Quick loadout | `Game.updateHudSurfaces` → `show`/`hide` | `quickLoadoutWindow` — respawn countdown, or round-one `WARMUP` | digits 1-5; **consumed** while shown, refused while hidden | `[hidden]` + `.ql[hidden]` |
| Debug overlay | `Game.updateHudSurfaces` → `setVisible` | `debugOverlayVisible` — `debugRequest`, the screen, and **`Cheat.Debug`** (round 4, F14) | Escape closes it and stops there. The × asks through `onDismiss` | `[hidden]` + `.dbg-root[hidden]` |
| Vote overlay | `VoteOverlay.apply`; `hide()` on migration (round 3) | the server's broadcast vote phase | digits 1-5, first refusal, only while not hidden | `[hidden]` + `.op-vote[hidden]` |
| Pause | the `PAUSED` state's enter/exit | `Game.state` | Escape; its buttons take DOM focus, which is why `hide()` blurs | `[hidden]` + `.op-screen[hidden]` |
| Summary | the `SUMMARY` state's enter/exit | `Game.state` | its own buttons | `[hidden]` + `.eom[hidden]` |
| Mortar overlay | `MortarOverlay.open`/`cancel`/`confirm` | whether a mortar mark is being placed | Fire confirms, Escape cancels above the pause branches | `[hidden]` + `.hud-mortar[hidden]` |

**Amended at F14.** The debug overlay's middle column gained a third term: the overlay is behind
the `DEBUG666` entitlement now, and the pause menu's button exists only for a session that has
typed it. `debugRequest` still means exactly what it meant — *do they want it, and from where* —
and the entitlement is the separate fact *may they*. Both are needed, and the reason is the × in
this row's fourth column: it closes the panel without revoking the code, so a single fact could
not have carried both without making the × a one-way door. See "cheat codes, and the two
authorities one store had to have" below.

One honest footnote on the first row: `MatchHud.setVisible(false)` and `resetForMatch()` also
force the board shut. They are teardown rather than a second opinion — both only ever write
`false`, and only in states where the predicate already answers `false` — but they are the shape
that becomes a second writer the day somebody makes one of them write `true`.

Three of the seven moved into the one per-frame pass this session. The other four are each already
a single writer driven by an event that cannot stop arriving, and moving them would be churn; what
the table buys is that the next surface has somewhere to be added and a last column somebody has
to fill in.

### Measured, and what a probe now blocks on

`npm run skirmish`, three headless clients, full timings, one complete cycle through a vote, a
migration and a TDM to the clock.

| Probe | Result |
|---|---|
| Quick loadout window | 10 851 ticks over **34 windows** (7 269 respawn / 3 582 pre-match) |
| ...open while alive and out of the freeze | **0** — the B13 assertion, and it blocks |
| Tab surviving `neutralise` while dead | **3 639** of 7 278 dead ticks — the B6 assertion, and it blocks |
| Spectator invariants (unchanged) | 7 806 selections while dead, 0 self / 0 enemy / 0 dead |
| Divergence checker (unchanged) | 0 / 7 372 per client |
| `npm run check` | boundaries, cosmetic audit and all three typecheck targets pass |

Both new assertions are written to go **red against the bug rather than green against the
feature**, and the B6 one was watched red: reverting the single line in `neutralise` and changing
nothing else drops it to 0 of 5 296 dead ticks and fails the run. Both carry their denominators,
so a zero that means *"never looked"* fails as loudly as a zero that means *"never violated"* —
the same property the divergence checker's `hashSamples === 0` branch exists for.

The B13 assertion has **not** been watched red, and that is the honest statement of its limits
rather than an omission: the bug was in a stylesheet, and no red control available to this process
can make a predicate fail that was never failing. Its value is prospective — it is the thing that
will notice the day somebody makes the window itself wrong.

**One number moved, and was isolated before it was believed.** The first run with the probe in
reported 1 misprediction entering a live match, against a documented 0, which fails §8.9. Isolated
one variable at a time rather than rebaselined: clean tree **0**; this tree with Tab held **1**;
this tree with the hold removed **0**; then the same tree with the hold back in, twice, **0** and
**0**. So it is neither the fixes nor the probe's input — it is noise, which is also what the code
says it must be, because `Btn.Scoreboard` reaches no branch in `PlayerController.step`. This
harness is wall-clock paced rather than seeded and no two runs agree about anything else either:
deaths and spectator picks move ten per cent between runs of the same tree. The earlier
*"mispredictions into live: 0, every run"* should be read as 0 on four runs in five, not as a
constant.

### Needs a browser

Nothing above was seen. `HeadlessClient` drives `NetClient` and `Prediction` and builds no
`ClientMatch`, and the preview pane never fires `requestAnimationFrame`, so every claim here is
about a rule and none is about a pixel — which is precisely the gap B13 lived in for two rounds.

- **B13.** Start a match, die, wait out the respawn. The class panel must **go away** when the body
  comes back, and again when the pre-match ten seconds expire. Then press 3, 4 and 5 while alive: a
  killstreak must fire, which is the panel proving it is not merely invisible.
- **B1.** Pause, open the debug overlay from the pause menu, click the ×, resume — it must stay
  closed. Then: pause, open it, resume with it up (it should follow you in), pause again (it should
  go off screen), resume (it should come back). Then press Escape with it open in a match: it
  closes, and you are **not** dropped onto the pause screen.
- **B6.** In multiplayer, hold Tab across the moment of death: the board must stay up through the
  death screen and close on release. Press Tab while dead: it must open. Then pause while holding
  Tab and let go — the board must not be up behind the pause menu.
- **The `.ql[hidden]` fix, and one pass over the surfaces that share the trap's shape.** Cycle the
  class panel and the mortar map both up and down, because the audit was a grep and a grep cannot
  see specificity.

Unchanged from the earlier list: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything in "Open, and all of one kind" above.

### Found while here

- `PLAYER_RESPAWN_SECONDS` in `ClientMatch` was a literal `4.5` beside `BotDirector`'s
  `RESPAWN_SECONDS`, also `4.5` — the same fact written twice, and the death-screen countdown is
  what the class panel's window is derived from, so the day the two drifted the panel would have
  closed early or late with nothing to point at. It reads the shared one now, which is also what
  lets the harness step the same display timer the client does.
- `Game.updateHudSurfaces` briefly declared a local named `window`. `scripts/check-boundaries.mjs`
  catches that in `server/` and cannot catch it in `client/`, where this very file legitimately
  names the global in `onResize`. Renamed. Not a defect; recorded because the check found it in one
  partition and could not have found it in the other.

## Playtest round 4 — the summary screen was a screen that stopped listening

B4, and it is one mechanism wearing three hats. The brief's first instruction was not to fix but
to explain why round two's fix does not arrive, and the answer is that all of round two's fix is
present, correct, and unreachable: by the time the player presses the button they have already
been disconnected.

### The mechanism, in one line

`Game.simulate` serviced the socket only while the screen was `MATCH` — `if (inMatch)
net.update()` — so from the frame the post-match board went up the client stopped pinging,
stopped reading, and stopped noticing anything. `SUMMARY_HOLD_SECONDS` is **14** and
`CLIENT_TIMEOUT_MS` is **10 000**, so the server reaped every player who watched the board **four
seconds before it would have migrated them home**, with the return `Welcome` sitting unread in a
queue nobody was draining.

That one gate produces every symptom in the report:

| Reported | What it was |
|---|---|
| "the button throws you to the main menu instead of the lobby" | `leaveSummary` does transition to `MATCH` — round two's fix, intact. `MATCH` is the first screen that pumps the socket again, so the very next tick runs `net.update()`, which is the **only** place `NetClient.state` becomes `'disconnected'`, and the disconnect branch sends the player to `MENU`. The fix and the bug are one frame apart |
| "you have to click twice" | Not a focus guard and not pointer lock. `GameScreens`' `onContinue` swallowed the first press to finish the XP animation and left only on the second — a deliberate M6 decision, and one a button labelled "Return to lobby" cannot honestly keep |
| "the timer is stuck at 14" | The render pass does reach `EndOfMatch.tick`; what was wrong is upstream of the arithmetic. The number was seeded once, from a **duration** sent at match end, and integrated locally against a clock the client had stopped reading — so it counted toward a migration it could not receive, and never once reached zero in a real session, because the screen it was on was torn down at ten seconds |

The shape is the milestone's own recurring one, arriving from a new direction. Two decisions had
been fused into one `if`: *what the player's command contains* — nothing, off the match screen —
and *whether this client is still talking to the server at all*. **Going silent is not a neutral
command.** The neutral command is now `MatchWorld.sampleCommand`'s first branch, where it says
what it means, and `net.update()` runs on every screen that still holds a world.

The comment above that line had claimed for a milestone that `sampleForNet` *"applies the same
three-way choice made below"*. It applied two of the three. The missing branch was being
implemented by not calling the netcode at all.

### Why no harness run could ever have seen it, and the probe that now can

`HeadlessClient` has no screen, so it pumps unconditionally — the one difference from the browser
that mattered. `--summary-gate` gives it the browser's gate: silent from `MsgS.Summary` until the
deadline that message carries. It is a red control and nothing else, and it was watched red
first.

The gate's deadline is wall-clock rather than ticks, deliberately: a gated client is not calling
`NetClient.update`, so `stats.clientTick` is frozen for exactly as long as the gate lasts, and a
gate waiting for a tick it was itself preventing would never lift. That is the same frozen-clock
trap `LiveMatch.summaryElapsed` documents on the server side, met a second time from the client's.

| Probe | Red (`--summary-gate`) | Green |
|---|---|---|
| Server closed the session | **all 3, `timeout`, 10.02 s after the summary** | none |
| Clients migrated back to the arena | **0 of 3** | **3 of 3** |
| Migrations over the run | 3 (into the match only) | **6** — the return leg finally happens |
| What the screen said the hold was | 13.9 s | **14.0 s** |
| Actual summary to arena | never arrived | **13 997 ms** |
| The run | **FLOW CHECK FAILED**, three ways | passed |

Both numbers are printed side by side on purpose. They are two independent answers to one
question — what the screen claims and what the server does — and the whole of B4's timer is that
the first was a guess.

### The countdown is the server's remainder now (protocol v9)

`MsgS.Summary` carries `endsTick`, the master tick the hold expires on, instead of `holdSeconds`.
A **deadline, not a duration**, and the same shape as `VoteInfo.phaseEndsTick`: the client derives
`(endsTick - currentTick) * DT` against the synced server clock, which is the expression
`VoteOverlay.tick` has used for the ballot since M11. The two countdowns on this client can no
longer mean different things.

A duration is only true at the instant it is sent. It could not be right for a player who reached
the screen a frame after the message that opened it, or reconnected into it, and it kept counting
perfectly happily on a link that had gone away. The new number cannot: it is a pure function of a
tick the server sent and a tick the clock sync maintains, so **a client that stops hearing the
server stops counting** — which is the honest failure, and the one a local `dt` could not produce.

`LiveMatch.summaryEndsTick` is the same expression `summaryElapsed` decides on rather than a
second copy of it, so the screen and the migration cannot disagree about when the hold ends.
Measured agreement: **14.0 s displayed against 13 997 ms actual.**

`EndOfMatch.setNetworked` is derived from the connection now rather than from `holdSeconds > 0`.
Those are different facts, and taking the second for the first made this screen describe itself
as single-player whenever the number was missing — the brief's third candidate. It cost only the
wording before, because `leaveSummary` reads `this.server` and always did; it would have cost the
exit button too, now that the same flag decides whether there is one.

### Two buttons, and the one that could not honestly be a rematch

The report asked for an exit and a rematch. Against a dedicated server there is no client-side
rematch to give: the server migrates everybody back to the arena on its own clock and **the vote
cycle running there is the rematch**. So the honest pair is:

- **Return to lobby — Ns** (primary): the seat, the socket and the world all survive. This is
  what round two built; what it needed was a connection still alive when it ran.
- **Exit to main menu** (secondary): transitions to `MENU`, which tears the world down, clears
  `this.server` and closes the socket — freeing the seat immediately rather than after a
  ten-second timeout.

**Single-player gets one button, not two.** There the two collapse into the same action, and two
buttons that do the same thing are worse than one: the exit is hidden and the primary reads
"Continue", exactly as before.

The first press acts. XP is banked when `SUMMARY` is *entered*, not when the bar finishes, so
skipping the animation costs nothing but the animation — pressing either button finishes it and
goes. Single-player loses the press-once-to-skip behaviour too, deliberately: it is the same lie
with only one button to tell it.

### Measured

Shortened round (`MATCH_ROUND_SECONDS=25`, `PLAY_SECONDS=8`, votes 4 s), because at shipped
timings no match ends inside the harness budget — see below. **The two constants under test are
untouched by those knobs**: the hold is the shipped 14 s and the timeout the shipped 10 s, and the
gap between them is the entire finding. Shortening a round moves when the summary happens, not
what happens during it.

Three green runs, because this harness is wall-clock paced and one run of it is a sample rather
than a fact:

| Run | Screen said | Actual summary to arena | Migrated back | Dropped |
|---|---|---|---|---|
| 1 | 14.0 s | **13 997 / 13 997 / 13 997 ms** | 3 of 3 | 0 |
| 2 | 13.9 s | **14 015 / 14 014 / 14 014 ms** | 3 of 3 | 0 |
| 3 | 14.0 s | **14 021 / 14 020 / 14 020 ms** | 3 of 3 | 0 |
| Red control | 13.9 s | —, never arrived | **0 of 3** | **3 of 3, at 10.02 s** |

The screen's number and the hold it describes agree to within about 25 ms across all three, which
is the point of printing them side by side: they are computed from different things and now say
the same thing.

And the rest of the gate, unchanged by any of this:

| Probe | Result |
|---|---|
| Standing `npm run skirmish`, shipped timings | FLOW CHECK PASSED — divergence **0 / 7373** per client, spectator **0 self / 0 enemy / 0 dead** over 8007 picks, quick loadout **0** while alive over 11 041 ticks, Tab **3595** of 7465 dead ticks |
| Mispredictions entering a live match | **0**, every run |
| `npm run leak`, 100 cycles | subscriptions **26 → 26 (+0)**, heap 12.64 → 13.28 MiB (+0.64). LEAK CHECK PASSED |
| `npm run netharness` at v9 | 2 clients, 30 s, **1800 ticks each, 0 snapshots lost, both still `joined`** — the handshake accepts the bumped version on both sides, which is the half of a protocol bump that can silently reject everybody |
| `npm run check` | boundaries, cosmetic audit and all three typecheck targets pass |

### Needs a browser

Nothing here was seen, and the split is sharper in this session than usual: the harness proves the
*connection* survives the summary screen, and every claim about the screen itself is a browser
claim. `HeadlessClient` builds no `ClientMatch` and no `Game`, so it has no summary screen at all —
what it has is the socket behaviour the screen was breaking.

- **The two buttons.** Finish a networked match. The board must offer **two**. Press "Return to
  lobby" **once**: it must act on that press — you land back in the world, and the NetPanel must
  show the *same* socket with no reconnect. Wait the hold out instead and the server must migrate
  you to the arena on its own, with the board coming down as it lands.
- **The countdown.** It must run 14 to 0 and reach zero *before* anything happens, rather than
  being cut off part-way. Kill the network at 7 s: the number must **stop** rather than keep
  counting, which is the visible form of the new derivation.
- **The exit.** "Exit to main menu" must close the socket — the server log should free the seat
  immediately rather than ten seconds later.
- **Single-player.** Finish an offline match: **one** button, reading "Continue", no number, and
  one press leaves.
- **The pause screen.** Pause a networked match for more than fifteen seconds and resume. You must
  still be connected; before this session you were not.

### Found while here

- **`npm run skirmish` has never reached the last leg of the flow it is named for.** The budget
  allows `matchRoundSeconds || 90` seconds for the match, and TDM's authored `timeLimitSeconds` is
  **600**. At shipped timings the run is therefore cut off mid-match: `summaries received: 0`, no
  hold, no return migration — and FLOW CHECK PASSED. That is why nothing in this milestone caught
  B4, and it is a probe that could not go red for the whole of §6.9. The budget is not changed
  here, because a correct one makes every default run several times longer; what changed is that
  the silence is no longer silent. A run in which no match ended now says **"post-match hold: NOT
  EXERCISED"**, the same shape as the divergence checker's `hashSamples === 0` branch.
- **The pause screen had the same hole**, with no fixed clock to make it fire reliably:
  `simulate` returned on `PAUSED` before it reached the network at all, so a networked client
  paused for ten seconds was reaped exactly like one watching a summary. Same cause, so fixed
  here: the `PAUSED` early return now sits *below* the networked branch, where it belongs — a
  pause is a local decision about a local simulation, and there is no pausing a dedicated server.
- A **backgrounded** tab survived the summary screen that a visible one did not.
  `pumpNetworkWhileHidden` has always called `net.update()` unconditionally, which is both the
  shape this fix follows and a small proof that it is safe.

## Playtest round 4 — the loadout doctrine, and a picker that never showed the weapon

B5, B8, B11, B7 and F15. Two of them are one design decision and it **reverses round two**, one
is a screen that rebuilt itself on every click, one is a gate whose number never reached the
screen, and one is a picker of twelve names for objects nobody could see.

### The decision, first, because two of the reports are it

**The editor is a front-end screen. Inside a match the only way to change class is keys 1-5.**

That is not a bug fix. M11 §6.6 put `MATCH -> LOADOUT` in the transition table for the warmup
arena; round two found that every route out of the editor went somewhere costly and fixed it by
making the editor an *overlay* over the live world, so there was no transition left to route
wrongly. The report now asks for the opposite, so the overlay is **removed** rather than
repaired, and the record above has been rewritten rather than left standing: "Create-a-Class was
a state where it should have been an overlay" now says what it was and what happened to it.

Three things went with it — the pause menu's button, `Game.openLoadout`/`closeLoadout`, and the
`MATCH`, `PAUSED` and `SUMMARY` edges into `LOADOUT` — and the third is the one that matters,
because it turns the doctrine from a habit into a rule. `LEGAL_TRANSITIONS` now reads
`LOADOUT: ['MENU']` and no other row names it as a target, so a route added by accident throws
`Illegal game transition` on the frame it is taken. That is stronger than the grep the brief
asked for, and the grep agrees with it: one `transitionTo('LOADOUT')` in the tree, wired to the
main menu's button, and one caller of `loadoutEditor.show()`.

**What survived is the half that protects the path that is left.** The deferral of
`meta.setLoadout` (Tier 1 #20) was built for the overlay and matters more without it: a class
applied to a standing body re-runs the perk hooks, one of which writes
`PlayerController.speedScale`, so the client predicts a speed the server — which defers to the
next spawn — is not simulating. `pickQuickClass` is now the **only** caller of that pair, so
`ClientMatch.applyLoadout` and `ServerMatch.setPendingLoadout` are load-bearing for 1-5 alone.

Two things did not survive, and both are the same shape as the `editorOpen` field: code whose
only reason to exist was the route that has gone.

- `ClientMatch.uiFocus` — *"a front-end surface has the keyboard and the cursor"* — had **no
  writer left**. A boolean in the input path that nothing sets is indistinguishable from one
  somebody forgot to set. `inputSuppressed` is `inputFrozen` now.
- `HudSurfaceState.editorOpen` was tested by both `scoreboardOpen` and `quickLoadoutWindow`, and
  both already required `screen === 'MATCH'`, where it can no longer be true. Round four's own
  surface table exists to say what each surface is derived from; a condition that cannot fire is
  a row that has stopped describing the code.

**The cost, stated rather than glossed:** a player connected to a server cannot now *build* a
class without leaving it. They can pick among the five they have, on 1-5, in the two windows the
quick selector offers — and to edit the sixth perk they quit to the menu. That is what the
report asks for and it is the right trade for a game with no lobby screen, but it is a real
loss compared to the overlay and it is the thing to watch for in the next round.

### B5 — one button, and the save is on the way out

*"Replace the exit-to-match button with save-and-exit, going to the main menu."* The button the
report names is the editor's own **"Start match"**, which called `onLaunch` — the same call the
main menu's Start uses, which clears `multiplayerJoin` and launches a solo game. With the editor
reachable only from the menu there is exactly one destination, so there is exactly one button:
**Save and exit**. Two buttons that both land on MENU would be the pair P2 refused to ship.

The flush is in the `LOADOUT` state's **exit handler**, not on the button. Every route out passes
through it — the button, Escape, and anything added later — which is what makes "no route leaves
without saving" a property of the state rather than of one listener. `Profile.editLoadout`
already persisted each edit, but through `SaveStore.touch`, which debounces; leaving the screen
is exactly the moment a debounce stops being a kindness.

### B11 — the list that jumped, and why saving `scrollTop` would have been the wrong fix

*"Selecting a weapon scrolls the list back to the top."*

`edit()` called `paint()` called `screen.replaceChildren(...)`. The `.lo-options` element the
player had scrolled — `max-height: 320px; overflow-y: auto` — was **thrown away on every click**,
and its replacement was a fresh node, and a fresh node's `scrollTop` is 0. The brief was right
that saving and restoring the offset is the plaster: it removes the symptom and leaves the whole
screen rebuilt twelve times a minute.

So `paint()` runs once per `show()` and nothing else calls it. Every mutable piece of the screen
registers a closure in `refreshers` and `refresh()` runs them; every argument of an option past
its label is a **predicate rather than a value**, so the element is built once and decides what
it says each time it is asked. Changing slot, equipping a class and renaming one are all
refreshes now, not repaints. Opening a row appends its options and closing one removes them,
truncating `refreshers` back to the length it had before — a closure still holding a detached
node is work done on nothing, and the quiet kind of accumulation that becomes a leak.

The reason the in-place refresh is *complete* rather than approximate is worth writing down,
because it is what makes the rebuild unnecessary: **an edit inside the open row can never change
which options that row offers.** Overkill changes the secondary weapon list and lives in a perk
row; a primary change re-lists the attachments row; only one row is open at a time. Each of
those closed rows is rebuilt when it is next opened. Preserved scroll is then the test rather
than the mechanism — nothing is preserved, because nothing was destroyed.

### B7 — the brief's hypothesis was wrong, and the real one is worse

*"The gas grenade shows no unlock level in the picker."*

The suggested mechanism was a missing table row. It is not: there is no gas grenade — the
tacticals are FLASHBANG and SMOKE, `רימון גז` is the smoke, and `EQUIPMENT_UNLOCK_LEVEL.smoke`
has said **3** since M6. The gate was reading it correctly the whole time.

**The editor passed the string literal `'LOCKED'`.** Weapons asked `unlocks.weaponRequirement`,
attachments asked `unlocks.attachmentRequirement`, perks and field upgrades read `unlockLevel`
off their own def, and equipment — the one category whose level lives in a side table rather
than on the def — had nothing to ask, because `UnlockState` had no `equipmentRequirement`. Three
ways of answering one question, one of which answered nothing. SEMTEX (8) and CLAYMORE (16) had
the identical hole; smoke is simply the first one a low-level player meets.

All six requirements come from `UnlockState` now, beside the predicates they are the explanation
for, so a gate and its caption cannot say different things. Two smaller things fell out:

- `EQUIPMENT_UNLOCK_LEVEL[id] ?? 1` was what both readers said. `noUncheckedIndexedAccess`
  forces *something* there, and `?? 1` on a table of gates means a missing row silently unlocks
  the item at level one — the quietest possible failure for a progression system.
  `equipmentUnlockLevel` throws instead, in the same shape as `requireWeapon`.
- Camos are gated by a challenge rather than by a level, and their chip said `LOCKED` too. It
  quotes `CamoDef.requirement` now, which is the same sentence `Challenges.ts` awards against.

**And the class of bug is a check that fails.** `scripts/check-unlocks.mjs`, wired into
`npm run check`, tests both halves of a gate, because either alone is silent: every gated item
has an unlock record, **and** every gated category has a requirement accessor that the editor
actually calls. The second half is the one that was broken and no amount of table-checking would
have found it. A literal requirement string in the picker fails it by name.

Watched red three ways, because a check nobody has seen fail is a check that has not been
written yet:

| Red control | What it said |
|---|---|
| `smoke: 3` deleted from the table | `equipment "smoke" has no row in EQUIPMENT_UNLOCK_LEVEL` |
| the picker's `'LOCKED'` literal restored — **the bug as it shipped** | *does not call unlocks.equipmentRequirement*, and *passes the literal requirement "LOCKED"* |
| `equipmentRequirement` removed from `UnlockState` | `UnlockState has no equipmentRequirement` |

Its limits are the cosmetic audit's: it reads sources with regular expressions, so it knows the
editor *names* the accessor and not that the string reaches a DOM node. What is on the screen is
a browser claim.

### F15 — the picker shows the weapon, from the builder that makes the weapon

The editor printed twelve names and thirteen numbers and never once showed the object.
`LoadoutStats` has been the point of that screen since M6 precisely because it is repainted from
`resolveLoadout` — *the same call the match makes* — so the numbers cannot be a marketing chart.
`WeaponPreview` is that argument applied to the picture: the model is `buildWeaponModel`, the
viewmodel's own builder, from the same `WeaponModelSpec`, with the same three shared materials
and the same procedurally generated camo. There is no second description of a rifle in it.

Three decisions inside that are not obvious:

- **It has a renderer of its own.** `Renderer`'s canvas is full-screen and *behind* the DOM
  front end, and `.op-screen` paints a near-opaque gradient with a backdrop blur over all of it,
  so scissoring the preview into a corner of the main canvas would put it behind the screen it
  belongs to. The context is created on the first `show()` rather than at boot — most sessions
  never open the editor.
- **The framing comes from the geometry, not from a per-weapon number.** The pistol is genuinely
  a different size (`WeaponModelSpec.scale` says so) and a fixed camera distance would draw one
  as a speck and clip the other. The bounding box is taken from what was just built, so a spec
  change moves the framing with it.
- **A hovered weapon is drawn bare.** The camo belongs to the equipped weapon in that slot; a
  weapon under the cursor has not been equipped, and painting the class's finish onto it would
  show a combination that does not exist. Choosing a camo repaints the equipped model with it,
  which is the point of putting the two on one screen. Attachments are **not** modelled — the
  builder has no notion of them, and inventing one here would be the second source this feature
  exists to remove.

The spin is ticked from `Game.draw`, not from a timer of its own: same reasoning as the summary
countdown's, and a weapon spinning in a background tab is a GPU nobody asked for.

### `WeaponIcons` was the second source, and the brief said to decide about it

It was one hand-typed 48-coordinate `AR` outline keyed by weapon **class**, with `iconFor`
returning null for the eight classes nobody had drawn — so eleven of the twelve shipped weapons
printed their name in the killfeed instead of a shape.

The decision is that it stops being a source. `weaponSilhouettePath` projects the same
`WeaponModelSpec` orthographically down +X — the side view the specs were authored to read at,
which is what "the LMG reads as heavier than the SMG at a glance" means — and every part becomes
one quad in the union. `rx` is honoured because it rotates in exactly the plane being drawn (the
grip's rake, the stock's drop, the magazine's curve); `ry` and `rz` are ignored, because they
turn a part out of this plane and an ejection-port sliver seen edge-on is not part of a 16-pixel
silhouette. The glass and the red dot are skipped: they are what you see *through*.

Measured over the shipped roster: **12 weapons, 12 distinct silhouettes, 19-25 quads each, every
coordinate inside the 48 × 16 box with its 0.5 margin honoured.** The fit is uniform-scale, and
both constraints bind for different weapons — the pistol is height-limited and 19 units wide,
the snipers are width-limited and span the full 47 — which is the proportion difference the icon
exists to carry. The name fallback is gone: an id with no spec of its own gets `AR_BASE` from
`modelSpecFor`, which is exactly what the *viewmodel* would draw for it, so the feed and the
hands still agree.

### Measured

Nothing in this session changes a number the harness reports, which is the honest description of
what was verified: the work is a screen, a doctrine and a check, and the harness's job here was
to show that removing `editorOpen` from two HUD predicates and `uiFocus` from the input path did
not move anything. `npm run skirmish`, three headless clients, shipped timings, one full cycle
through a vote and a migration:

| Probe | Result |
|---|---|
| Quick loadout window | 9 800 ticks over **29 windows** (6 206 respawn / 3 594 pre-match) |
| ...open while alive and out of the freeze | **0** — the B13 assertion, and it blocks |
| Tab surviving `neutralise` while dead | **3 184** of 6 216 dead ticks; board open 3 184 |
| Spectator invariants | 6 238 selections while dead, **0 self / 0 enemy / 0 dead** |
| Divergence checker | **0 / 7 372** per client |
| Mispredictions into a live match | **0** (§8.9 requires 0); to the arena 0; spawn window 0 |
| Live roster | 3H + 7B = 10, the mode's authored count |
| The run | **FLOW CHECK PASSED** |

Unchanged and expected: `post-match hold: NOT EXERCISED`, at shipped timings, for the reason the
B4 session recorded.

| Probe | Result |
|---|---|
| `npm run leak`, 100 cycles | subscriptions **26 → 26 (+0)**, heap 12.65 → 13.29 MiB (+0.64). LEAK CHECK PASSED |
| `npm run check` | boundaries, cosmetic audit, **unlock audit** and all three typecheck targets pass |
| Unlock audit red controls | 3 of 3 went red; see the table above |
| Weapon silhouettes | 12 weapons, **12 distinct**, 19-25 quads each, 0 coordinates outside the box |

And the grep the brief asked for, which is now the weaker of the two proofs:

| Question | Answer |
|---|---|
| `transitionTo('LOADOUT')` | **one**, `Game.ts`, wired to the main menu's button |
| callers of `loadoutEditor.show()` | **one**, the `LOADOUT` state's `enter` |
| rows of `LEGAL_TRANSITIONS` naming `LOADOUT` as a target | **one**, `MENU` |

### Needs a browser

Every claim in this session is about a screen, and `HeadlessClient` builds no `ClientMatch`, no
`Game` and no DOM. The harness proves the rules around the editor did not move; it cannot see
the editor. The silhouettes were rendered to a standalone SVG page and looked at — twelve
distinct, recognisable shapes — but **not at 42 × 14 in the killfeed**, which is the size that
decides whether they read.

- **B11, and it is the one to check first.** Open Create-a-Class, open the Primary row, scroll to
  the bottom of the weapon list and pick something. The list must **not** move. Then: change
  class on the left, rename one, equip one, fit an attachment — none of those may scroll either
  the option list or the page.
- **B5.** The editor must offer **one** button, reading "Save and exit", landing on the main
  menu. Edit a class, leave with the button, reload the page: the edit is there. Do it again
  leaving with **Escape**: the edit is there too.
- **B8.** Pause a match: there must be no "Create a class" button. Escape out, press 1-5: the
  class still changes in the two windows and nowhere else. There is no route into the editor
  from a match — if one is left, it throws `Illegal game transition` rather than opening.
- **B7.** At a low level, open Lethal and Tactical. SMOKE must read `LEVEL 3`, SEMTEX `LEVEL 8`,
  CLAYMORE `LEVEL 16` — and the camo rows must name their challenge rather than saying LOCKED.
- **F15.** The weapon must be visible, centred, spinning on the spot rather than wobbling, and
  it must change as the cursor moves down the weapon list. Choose a camo: the model must take
  it. Open the Sidearm rows: the pistol must be the one on show. Then check the frame cost with
  the editor open — it is a second WebGL context and the first one anybody has measured.
- **The killfeed.** Get killed by several different weapons and look at the icons at their real
  size. This is the claim the SVG page cannot make.

### Found while here

- **`ClientMatch.uiFocus` and `HudSurfaceState.editorOpen` both lost their last writer** with the
  overlay, and both are removed rather than left. Recorded here rather than under a report
  because the pattern is worth the line: this milestone's standing failure is a fact that moved
  and left its readers behind, and this is the mirror image — a *route* that went away and left
  its guards behind. A guard for a case that can no longer arise reads exactly like a guard
  somebody forgot to trigger.
- **`EQUIPMENT_UNLOCK_LEVEL` is the only gated category whose level lives in a side table**
  rather than on its def, which is half of why B7 was easy to write. It stays where it is —
  `Unlocks.ts` is the file about gates — but it now has exactly one reader
  (`equipmentUnlockLevel`) instead of two ad-hoc lookups with `?? 1` on the end.
- **The editor's "Start match" is gone and the main menu's is not.** Nothing else offered it, so
  no flow lost a step; a player who wants to play now presses Start on the screen that has
  always had one.

## Playtest round 4 — killstreaks became a currency, and the first rule that bounded it

Covers **B9** ("activating an ability must cost kills: twelve earned, spend six, six left, and
an eight cannot then be afforded") and **B10** ("once a streak has been used it cannot be used
again until death resets it").

**Half of this section has been reversed on purpose.** B9's currency stands and everything
below about it is current. B10's once-per-life rule does not: a later session replaced it with a
per-streak cooldown and a no-two-at-once rule, deliberately, as a design change rather than a
fix — see *"one rule about a life, replaced by two about time"* at the end of this file. The
paragraphs that argue for once-per-life are left standing because the argument was sound for the
model as it was and the reasoning is what the later session had to answer; every claim that
would now read as a live rule is marked where it sits. Two numbers in *Measured* count a rule
that no longer exists, and they say so.

### They were one report, and the second is what made the first survive — at the time

Neither of these was a defect. `StreakSystem` did exactly what it was written to do, and the
comment at the top of it said so in plain words: someone who reached twelve kills held six
things and could spend three of them. Streaks were **thresholds** on `PlayerScore.streak` —
`checkEarned` asked whether the consecutive-kill count had *crossed* a requirement, pushed an
entitlement into a `pending` list when it had, and `activate` spliced one back out again without
the counter moving. Crossing twelve opened everything priced at twelve or under, all at once,
and spending was free.

What the report describes is a **balance**. That is a different economy, not a corrected one,
and the interesting part is what it does to B10. Under a threshold, "once per life" was very
nearly free: `awardedUpTo` stopped a streak being re-granted at the same requirement, so the
only way to hold two UAVs in one life was to have a care package drop you one. Under a balance
it is load-bearing — without it, twelve kills buys the same four-kill UAV three times, and the
optimal play is to spam the cheapest thing in the class. **B10 was not a second fix; it was the
rule that stopped B9's model degenerating**, and the two were built as one change for that
reason.

That reasoning is right about the danger and wrong about the remedy, which is the whole of what
the later session found. "Twelve kills buys three UAVs" is a complaint about *pace*, and a
per-life cap answers it by removing the possibility instead of spacing it out: a player who goes
on to earn the price a second time over the next two minutes is refused for a reason that has
nothing to do with the two minutes. A cooldown answers the same danger at the axis it is
actually on. See the later section.

### The economy, and where each piece of it lives

`src/shared/streaks/StreakLedger.ts` is new and holds the whole of it: kills banked, kills spent,
what has been bought this life, and the audit. It replaces two maps on `StreakSystem` (`pending`,
`awardedUpTo`), neither of which was a price.

- **The balance is credited from the score and is not the score.** `foldKills` takes
  `PlayerScore.kills` — cumulative, the server's, the thing match results are made of — and banks
  the *difference* since the last fold. So the score stays the single authority on whether a kill
  counted at all (a suicide and a friendly-fire kill never move it, so they never pay for
  anything) and `streaks/` never re-decides the friendly-fire rule. The brief asked for the
  separation to be explicit in the code because F14's `MO951357` has to add thirty kills of
  purchasing power without touching the scoreboard: `credit` is that second door, and it exists
  precisely because the balance is not a read of `PlayerScore.kills`. **Used at F14, and it held:**
  `MO951357` pays thirty kills into a wallet through `creditKills` with no compensating deduction
  anywhere, measured at 30 credited against 0 added to any scoreboard row.
- **The debit is the entitlement check.** `activate` no longer asks "do you hold it" — holding is
  not a thing any more — it asks `ledger.charge`, which refuses what the balance cannot cover
  and (then: what had already been bought this life; now: what is still cooling down or still in
  the world), and is the only place a refusal is counted. Asking `canAfford` first and charging
  afterwards would be two questions, and two questions is how a refusal goes unrecorded. That
  the refusals all sit behind one door is what made the later pivot a change to the ledger and
  to nothing else.
- **`requirementFor` is `priceOf`.** The number is the same one `StreakDef.requirement` always
  carried. A name that says "requirement" over code that debits it is a name that hides the
  model.
- **`nextFor` is measured against the balance, not the streak.** That is the whole difference in
  one line: after a purchase the HUD's "6 / 8 · SENTRY" goes back *up*, because the money is
  gone.

### The care package pays in kills

The brief asked for an explicit decision. A crate credits **the price of what it rolled** rather
than handing the streak over.

Handing the streak over is the one shape that breaks both new rules at once. A crate drops a
random `fromCarePackage` streak, which need not be one of the claimant's three — and since round
two, keys 3/4/5 index the *class's* slots, so an unequipped drop had no key to be pressed from
and no price on screen: a dead gift. It also laundered the once-per-life rule, because a second
copy of a streak already spent this life would arrive as a fresh entitlement. Paying out the
roll's value keeps one currency and no dead drops, and the gamble survives intact — a crate is
worth between five and twelve kills depending on what it rolls.

The decision outlived the rule half of its justification was about. Under the cooldown a handed
-over streak is worse, not better: it would arrive having paid no price and started no clock, a
second door into an economy with one.

### Two credits that had to be refused, both found by measurement

Both are the same mechanism — **a wallet belongs to a life** — and neither was visible until the
probe below started counting life-starts.

1. **A kill that lands after your own death.** A mutual kill is two `EntityKilled` events in one
   tick, and in one of the two orders the loser's death is processed first: `onDeath` zeroes the
   wallet, and then the kill they landed on the way down credits it again. The balance survives
   into the next life, which is exactly what B10 forbids. `checkEarned` now drops the credit for
   a combatant whose `health.alive` is false — but still **advances the anchor**, because the
   score has counted that kill and always will, and leaving the anchor behind would bank the same
   kill one life later instead, where nothing would be looking.
2. **A credit aimed at a corpse.** `credit` had no such rule, so the harness's repeating top-up
   paid dead seats. `creditKills` is now the single door for every unearned credit — crate, cheat,
   harness — and applies the same test.

### `PlayerController.spawn` is the one door a new life comes through

Worth writing down because P5 is looking for exactly this signal. The audit first subscribed to
both `EV.PlayerSpawned` and `EV.BotSpawned` and counted **304 life-starts against 154 actual
ones**. They are not two spawns: `Bot.spawn` calls `this.controller.spawn` at line 285 and
`NetPlayer.spawn` calls it at line 240, and `PlayerController.spawn` is what emits
`EV.PlayerSpawned`. `EV.BotSpawned` is a *second announcement of the same spawn*, carrying tier
and nearest-enemy detail for the director. One subscription covers every combatant in the game.

### The wire is a price list now (protocol v10)

`MsgS.Streaks` carried `pending`, a list of kind indices the player had earned. A currency cannot
be replicated that way: a client needs to know what a press will **cost** before making it, and
why a key that did nothing did nothing. Both facts are the server's — the price carries Hardline's
discount, the used set is per life and per entity — so `StreakView` carried
`offers: {kind, price, used}[]` and `balance` in place of `pending` and `streakCount`.

*(v13 replaced the `used` bit with a lockout in centiseconds. The shape of the message and the
argument for it are unchanged; what changed is that the second fact about a key is a duration
rather than a bit.)*

Offers are keyed by kind rather than sent in slot order. The server drops empty slots when it
resolves a class, so position does not survive a class with a gap in it; the client already knows
its own three keys and looks each one up.

Three bytes per offer against one per held streak is bigger, and has to be. `MAX_PENDING_STREAKS`
is `MAX_STREAK_OFFERS`, still three.

### "Is it in your class" moved to the untrusted boundary

It used to be answered implicitly: the pending list could only hold what had been earned, and
earning was filtered by the class. With no list, the question needed a home, and the right one is
`Server.onStreakRequest` — beside the three untrusted questions §4.16 already answers there
(which instance, where it lands, and now: whether they can pay). Putting it back inside
`activate` as well would have cost the debug panel its "buy and use" buttons for the three
streaks a class does not carry, which is acceptance criterion 1's only instrument.

### The HUD has four states, and the fourth is why the key did nothing

`HudStreaks` painted three: empty, owned-but-unearned, ready. There are four now, and the price
is on screen, because a player cannot plan a purchase whose cost they cannot see. Unaffordable
and unavailable both leave the key doing nothing, which is exactly why they must not look the
same: an unaffordable slot shows its price in kills, an unavailable one is marked. That is the
report's *"a used streak's key doing nothing while saying why"* — said persistently by the slot
itself rather than by a toast, because round four's own HUD-surface invariant is that surfaces
have one writer and this needed no new surface.

*(The fourth state was `USED`, struck through. It is a draining fill now and carries no text at
all, because what it says is no longer "not again this life" but "not for another n seconds" —
see the later section.)*

Keys 3/4/5 still index the class's three slots, unchanged from round two. The earned list decided
whether a press was honoured; the balance decides it now, with the lockout the later session
added.

### Measured

Every number below came out of a run in this session, named with the probe that produced it.
`ServerMatch.streakEconomy` is the probe; it folds the still-open lives in, so it can be taken
mid-match and taken twice.

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.** The five scores are byte-identical
to the pre-change baseline (75-61, 66-75, 44-75, 69-75, 75-64), which is the regression control
and is expected: nothing in a bot-only match spends a streak.

| | Total over 5 matches |
|---|---|
| Lives closed / life-starts observed | 705 / 718 |
| Life-starts inheriting a balance (must be 0) | **0** |
| Kills banked, against 679 scored in the five matches | 678 |
| Negative balances observed (must be 0) | **0** |
| Kill-anchor resyncs inside a match (must be 0) | **0** |
| Post-mortem kills dropped | 1 |
| Streaks a life is entitled to — **threshold model** | **75** |
| Streaks a life is entitled to — **balance model** | **38** |

The last two rows are the pacing answer the brief asked for, and both come out of the same run
on the same seeds: the threshold model handed out 75 streaks across those 705 lives, the balance
affords 38. **A 49% cut in what a life's kills entitle a player to.** That is the intended
direction — twelve kills is now a chopper *or* a UAV and a sentry — and it is the human's call
whether it is the intended size.

*Both rows price a life's kills under a rule of one purchase per streak per life, which is the
rule that was later removed. A third column, computed the same way with repeats allowed, is in
the later section; the report carries all three now so the comparison never has to be made
across two runs.*

**Red before green.** `dirtyLifeStarts` — since renamed `walletsAtLifeStart`, because it counts
wallets and never counted anything else — was **1 in 152 life-starts** on seed 4 before the
post-mortem guard and **0 in 152** after, with `postMortemKills` going 0 → 1 on the same match.
One fix, one moved number, and the other four matches unchanged.

**`npm run skirmish -- --grant-streak uav` — 3 headless clients, real server, real wire.** The
grant was one-shot before this session, which is the right shape for an entitlement and the
wrong one for a currency: a single grant is spent once and proves only that the debit runs. It
tops the wallet up every 15 s now, so every client is permanently able to afford the UAV and the
only thing that can stop them buying it again is B10.

| | |
|---|---|
| Wallet top-ups × 3 clients | 21 × 3 = 63 payments, **240 kills credited** (12 dropped to dead seats) |
| Spent | **68** = 17 × the UAV's price of 4 |
| Activations | **17**, across 24 lives (7 + 5 + 9 deaths, plus the life each ended in) |
| **Most streaks bought in any one life** | **1** |
| Peak balance held | 32 |
| Life-starts inheriting a balance | **0** |
| Negative balances / resyncs | **0 / 0** |

That fourth row is B10, measured rather than asserted: a permanently funded wallet, a peak
balance of 32 against a price of 4, 17 purchases — and **no life ever bought the UAV twice**.
Each of those 63 payments would have been a separate entitlement under the threshold model, and
the clients ask for one every 30 ticks when they have one.

*That row measures the rule the later session removed, and it is the number that run exists to
be compared against: the same harness with the same flag is re-run there, and a life buying the
UAV twice is what the change looks like from outside.*

The streak still works end to end over the wire in the same run: 17 live streak entities seen per
client, 3 at once at peak, 2429 / 1337 / 2429 sweep frames and 5 UAV contacts. `spent` is exactly
`activations × price` in every run measured.

**`npm run leak` — 100 cycles.** Subscriptions **27 → 27 (+0)**, heap 12.7 → 13.34 MiB. The
audit's spawn subscription replaced the two it started with and the count did not move.

**`npm run check`** and **`npm run build`** green.

### What was not verified

`npm run harness` reports **0 activations**, and that is not a probe failing to fire — see "Found
while here". The activation numbers above all come from the skirmish harness, where the headless
clients are the only things in the project that spend.

`balance = earned − spent` is not measured, because it is not measurable: the balance is computed
from the other two rather than stored, so there is no third number that could disagree. What is
measured is the pair that *can* go wrong — a balance below zero, and a life that started with one.

### Needs a browser

Nothing below is testable headlessly. `HeadlessClient` drives `NetClient` and `Prediction` and
builds no `ClientMatch`, so it has no streak strip, no keys and no loadout editor; and the preview
pane never fires `requestAnimationFrame`, so it cannot stand in for one either.

- **B9, the balance going down.** Get to four kills in a class carrying a UAV. The strip's UAV
  slot must light and read `4`; the progress line must read `4 / 5 · COUNTER-UAV` or whatever the
  class's next-cheapest is. Press 3. The UAV must go up **and the progress line must go back up
  too** — the balance is now 0, so the line should read `0 / 4`-something. That is the entire
  report in one keypress.
- **B9, the case the report names exactly.** Reach twelve kills with a class carrying something
  priced at 6 and something at 8. Spend the 6. The 8 must go dark and show `8`, and pressing its
  key must do nothing.
- **B10.** *(Superseded — do not test this. The later session's list replaces it: after
  spending the UAV the slot darkens with a draining fill, and once the fill is gone and four
  more kills are banked the key works again, in the same life.)*
- **The price on an unaffordable slot.** At zero kills all three slots must show their prices,
  dimmed. This is what makes a class readable before the match starts.
- **The care package.** Claim one and watch the balance jump by the price of whatever it rolled,
  rather than a streak appearing in hand. The pickup still names its contents.
- **Create-a-Class.** The killstreak rows must read `Costs 12 kills · …` rather than `12 kills`.
- **Hardline.** With the perk on, every price on the strip must be one lower, and the debit must
  match what is shown.
- **The mortar.** Open the overlay with a marked balance, cancel with the same key: the balance
  must be untouched. Confirm: it must drop by the mortar's price exactly once.

### Found while here

- **No bot has ever spent a killstreak.** There is no call site: `StreakSystem.activate` is
  reached from `ClientMatch` (the local player's keys), `Server.onStreakRequest` (a human's
  request), and the two debug surfaces. Bots earn a balance — the harness measures 678 kills
  banked over 705 lives — and never spend a kill of it. That is why `activations` is 0 in every
  bot-only run, on both sides of this change, and it is why the pacing comparison above is
  computed as *entitlement per life* rather than as activations. It is not this session's item —
  nobody reported it and building bot streak AI is a feature, not a fix — but it means the human
  currently plays against ten opponents who will never call anything in, and F16's three new
  streaks would inherit the same silence.
- **`EV.StreakProgress` and `EV.StreakEarned` have no gameplay subscriber.** Only the debug
  panel's log listens. Both are still emitted and both now carry balance-model numbers, but a
  streak becoming affordable is currently announced to nobody — no audio cue, no HUD flash. That
  is a gap an announcer would fill and is worth knowing before F16 adds three more streaks to
  not announce.
- **A round start is not a death, and the ledger treats it that way.** `dirtyLifeStarts` — now
  `walletsAtLifeStart` — is the count of lives that began holding a balance from the life before,
  and it is 0 in every TDM run measured here because every TDM life starts with a death. A Search
  & Destroy survivor's next round starts without one, and will carry both the balance and the
  used set across. That is a policy question rather than a bug under B10's literal wording
  ("until death resets it"), and it is P5's row to decide. **Decided in P5, below: the carry-over
  stays** — surviving a round keeps the wallet — and the counter gained a second number to be
  checked against rather than an assertion it could no longer make. *(The used-set half of that
  sentence went away with the rule; the wallet half is unchanged and is still what the invariant
  tests.)*

*Two numbers in this section were overtaken by the session below and are left as they were
measured. The five `npm run harness` scores are no longer a byte-identical control against the
pre-change baseline, because P5 armed the bots with grenades for the whole match instead of one
each, which changes the fight; and `postMortemKills`, `thresholdGrants` and `balancePurchases`
all move with it. The model numbers — 0 negative balances, 0 dirty life-starts, 1 streak bought
per life at most — are unchanged.*

## Playtest round 4 — a life can start without a death, and only one signal knows it

Covers **B3** ("grenade stock is not refilled after death or elimination; it happens in certain
modes").

### Why round two's fix was right and still did not reach them

Round two already found this once and fixed it: `MatchEquipment.refillForLife` exists, and its
comment explains that a networked respawn emits no `player.spawned`, so the refill was split out
of the event handler and called explicitly. That call is correct. What was wrong was **what
reaches it** — the trigger, not the fix.

The client asked *"has a dead player stopped being dead"*: `applyReplicatedSelf` ran the per-life
reset on `alive && this.playerDead`. That is true of a respawn and of nothing else. The server's
life boundary is not the alive bit at all — it is `PlayerController.spawn` — and there are new
lives that go through it without the alive bit ever moving:

- **A Search & Destroy survivor at a round start.** The server's `RoundStarted` handler spawns
  *every* player, living ones included, because a survivor left standing where the last round
  ended is a free plant. It refills its own copy of their hand, picks them a new spawn point and
  bumps their spawn serial. The client sees a player who was alive and is still alive, decides
  nothing has happened, and leaves the hand at whatever the last round ended on.
- **A class change cashed during the pre-match freeze**, `applyPendingLoadoutNow`, which
  respawns a standing player on purpose so the class they pressed is the class they start with.

That is the report's *"in certain modes"*, exactly: the modes where a life can begin without a
death. Round two's own note that *"the spawn-serial bump is the same discontinuity a death
already produces"* had already named the right signal; nothing outside prediction could see it.

### The bots had it worse, and nobody could have reported it

`BotThrower.respawn` — the function that gives a bot its grenades back — had **exactly one caller
in the project, and it was on the client**: `MatchEquipment.onSpawned`. `ServerMatch` constructs a
`BotThrower`, calls `consider` on it every tick, and never once called `respawn`. `stateFor`
hands a bot that has never thrown a lazily-created `{lethal: 1, tactical: 1}`; `consider`
decrements it; `pickEquipment` skips a slot at zero. So over a dedicated server **every bot threw
one lethal and one tactical per match and was unarmed for the rest of it**, in every mode, from
M9 onward.

Nobody reported it because there is no way to see it. A bot that stops throwing grenades looks
like a bot that decided not to. This is the standing authority-migration failure in its purest
form — the simulation moved to the server and the reset stayed behind on the client — and it is
why B3's fix had to be measured across the whole roster rather than on the reporter's own hand.

### One signal, and what it actually is

The brief asked for one signal rather than a third call site. The honest answer is that it is one
fact with two transports, because the client that needs it is not running the simulation that
produces it:

| Where the sim runs | The signal | Why it is the only one |
|---|---|---|
| Server, and a single-player client | `EV.PlayerSpawned` | `PlayerController.spawn` emits it, and `NetPlayer.spawn` and `Bot.spawn` are the only two places in the project that put a body back to `alive` — both call it. One door **by construction**, not by inspection |
| A networked client | the replicated `spawnSerial` | `NetPlayer.spawn` bumps it on the same line, and it crosses the wire already, in the snapshot delta |

`EV.BotSpawned` is deliberately not also subscribed anywhere: round four's streak audit measured
what happens when it is — 304 life-starts against 154 real ones — because it is a second
announcement of the same spawn carrying tier detail for the director, not a second spawn.

So `ServerMatch.beginLife` is one `EV.PlayerSpawned` subscription that refills a human's hand or
a bot's thrower, replacing the refill that used to sit inside `spawnPlayer` — a door that was the
only one *by inspection*, which is to say a door a second caller would have had to remember to
copy. On the client, `NetClient` exposes `localSpawnSerial`, `NetSession` sends it beside health
and liveness, and `ClientMatch.applyReplicatedSelf` compares it against the last one it acted on.
`respawnNetworked` was renamed `beginLife` for the reason the bug happened: naming it after the
death it no longer needs is what let the round start be forgotten.

The serial is deliberately read as **state, not as an edge**. `NetClient.respawned` is the edge
and stays private — the reconciler consumes and clears it on the very next owner block, so a
second reader would race it and one of the two would silently see nothing. A serial is still true
on the tenth snapshot after the spawn, so a reader comparing it with its own last-seen value
cannot miss a life by being late.

No protocol bump. The serial has been on the wire since M10 and nothing about its encoding
changed; what changed is that something other than the reconciler is allowed to look at it.

### The client was also re-spawning itself over the network, and it hid this bug

`ClientMatch`'s `RoundStarted` subscription ran in both runtimes, and `hardResetRound` calls
`respawnPlayer`, which runs `selectSpawn` and teleports the local controller to a point **the
client chose** while the server was putting the body somewhere else. A guaranteed misprediction
of up to the width of the map, every round, corrected a snapshot later by a camera lurch.

It also concealed B3 by accident: that local `player.spawn` emits `player.spawned`, so a
networked S&D survivor's grenades *did* sometimes come back — as a side effect of an illegal
teleport rather than because anything had decided a life had started. Removing the second writer
without the serial would have turned an intermittent bug into a certain one, which is why the two
are one change. `hardResetRound` is single-player only now.

### Every per-life fact, and the signal it resets from

The table the brief asked for. "The spawn" means `EV.PlayerSpawned` where the simulation is local
and the replicated spawn serial where it is not — one fact, two transports, as above.

| Per-life fact | Who resets it | From which signal |
|---|---|---|
| Grenades, lethal + tactical (human) | `ServerMatch.beginLife` · `MatchEquipment.refillForLife` | the spawn |
| Grenades (bot) | `ServerMatch.beginLife` → `BotThrower.respawn` · `MatchEquipment.onSpawned` | the spawn |
| Cook timer / throw state | `ThrowController.reset`, from those same callers | the spawn |
| Bot throw cooldown | `BotThrower.respawn`, with the stock | the spawn |
| Flash blindness | `MatchEquipment.refillForLife` | the spawn |
| Health | `NetPlayer.spawn` · `Bot.spawn` · `ClientMatch.beginLife` | the spawn |
| Weapons, magazines, reserve, sights | `NetPlayer.spawn` · `ClientMatch.beginLife` | the spawn |
| Knife | `ClientMatch.beginLife` | the spawn |
| Viewmodel slot | `ClientMatch.beginLife` → `showSlot` | the spawn |
| Queued class change | `ServerMatch.spawnPlayer` · `ClientMatch.applyPendingLoadout` | the spawn |
| Prediction history | `NetClient.applyOwnerBlock` → `prediction.reset` | the spawn serial |
| Rewind history | `ServerMatch.spawnPlayer` → `rewind.resetAt` | the spawn |
| Death screen, respawn clock | `ClientMatch.beginLife` | the spawn |
| **Streak balance and spend** | `StreakLedger.resetLife` | **death only** — decided below |
| Streak "already announced" set | `StreakLedger.resetLife`, and `charge` when it takes the money | death, or the purchase that consumed it |
| **Streak cooldowns** | nothing — they run on the sim clock | **not per life, by decision** — see the last section of this file |
| Field-upgrade charge | — | **not per life, by design** |
| `MatchProgression.killsThisMag` | `EV.PlayerSpawned`, filtered on `PLAYER_ENTITY_ID` | the spawn — **but see "Found while here"** |
| `PerksRenderer` footstep trail | `EV.PlayerSpawned`, filtered on `PLAYER_ENTITY_ID` | the spawn — **same** |

Three rows deserve their own sentence. The **streak cooldowns** row is the newest and the only
one in the table with no resetter at all: they are measured from the moment a streak's effect
ended and a death is not that moment, so nothing per-life touches them. It is the same *shape*
as the field-upgrade row below it and a different reason — that one is not per life because
charging through a death would hand out a free activation; this one is not per life because
clearing it on death would make dying the fast way back to a chopper.

The **field-upgrade charge** is not a per-life fact and never was: `FieldUpgradeRuntime` charges on sim ticks and pauses while dead, precisely so dying
does not hand you a free activation. Its `reset()` has no caller anywhere in the project, which
reads like an oversight and is the opposite of one — but a method with no caller is
indistinguishable from a signal somebody forgot to wire, which is how this session started, so it
is written down rather than left to be rediscovered.

The **streak balance** is the row P4 handed over, and it is now a decision rather than a default.

### A round start is not a death, and that is the decision

A Search & Destroy survivor keeps the kills they banked and stays blocked from re-buying a streak
they already spent. Only dying clears either. That is B10's wording taken literally — *"until
death resets it"* — and it makes surviving a round worth something, which is what a
one-life-per-round mode is for.

*(The second half of that sentence went with B10. A survivor keeps their banked kills, which is
the decision and is unchanged; what they are blocked from re-buying is now decided by a cooldown
that does not care about rounds or lives at all. The invariant below is about the wallet and is
untouched.)*

The consequence is that `walletsAtLifeStart` — then called `dirtyLifeStarts` — could no longer be
asserted at zero, and a counter whose failure case has been quietly excused is a counter that
cannot fail. So the ledger counts the same thing from the other end: `noteRoundBoundary` counts,
at each round turn, the wallets that are about to survive it, and
**`walletsAtLifeStart === walletsAtRoundBoundary`** is the invariant. It
fails in both directions — a wallet that survived a *death* appears on the left with nothing to
match it, and a survivor whose wallet was wrongly cleared appears on the right — and the skirmish
harness blocks on it. Ordering against the spawns the round causes does not matter, because
spawning does not touch a ledger row.

### The probe, and why it samples at the end of the tick

`LifeStockAudit` counts, for every life that starts, whether it started holding a full slot.
`ServerMatch.equipmentAudit` is the reading; both harnesses take it.

It samples at the **end of the tick the spawn happened on**, not inside the spawn event, and that
is what makes it honest: the refill is another subscriber to the same event, so a probe reading
during the emit would be measuring subscription order rather than the game. At the end of the
tick the life has been through every system that could have handed it anything, which is the
state the player actually wakes up in.

`partialStock` is the number, and `lifeStarts` is reported beside it every time, because "0
partial" out of no lives at all is what a probe that never fired looks like — and this milestone
has already shipped three of those.

### Measured

Every number below came out of a run in this session. The red control is the probe with the fix
removed — `beginLife` restored to the pre-fix body, which refilled a human's hand if one had been
created and did nothing at all for a bot — rebuilt and run against the same seeds, then reverted.

**All five modes, `--matches 2 --asap`, seeds 1-2 on Foundry, bots only.** The claim the brief
asked for, with its control:

| Mode | Life-starts | Partial stock — **red** | Partial stock — **green** | Empty — red | Grenades held / expected — red |
|---|---|---|---|---|---|
| TDM | 291 → 288 | 169 | **0** | 123 | 290 / 582 |
| Domination | 619 → 660 | 409 | **0** | 323 | 506 / 1238 |
| Kill Confirmed | 310 → 322 | 202 | **0** | 138 | 280 / 620 |
| Free-for-All | 228 → 246 | 96 | **0** | 62 | 298 / 456 |
| Search & Destroy | 80 → 80 | 12 | **0** | 3 | 145 / 160 |
| **All five** | **1528 → 1596** | **888** | **0** | **649** | **1519 / 3056** |

**888 of 1528 life-starts began holding less than a full slot, and 649 began holding nothing at
all. After: 0 of 1596**, and `observedStock` equals `expectedStock` exactly in every one of the
ten runs — 3192 grenades against 3192, which is the stronger statement, because a fix that
refilled the wrong slot would clear `partialStock` and not that.

The life-start counts are close but not identical on either side, and that is the change reaching
the simulation rather than a probe wobbling: armed bots kill differently, so the same seed is a
different fight. It is also why P4's byte-identical score control no longer holds — see below.

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.**

| | |
|---|---|
| Life-starts examined / with partial stock | 722 / **0** |
| Grenades held against expected | 1444 / 1444 |
| Streak life-starts inheriting a balance / round carry-overs | 0 / 0 |
| Negative balances / kill-anchor resyncs | **0 / 0** |
| Kills banked, against 683 scored | 683 |

Scores: **75-59, 75-66, 62-75, 75-66, 60-75**, against P4's 75-61, 66-75, 44-75, 69-75, 75-64 on
the same seeds. **The regression control is deliberately broken and that is the result.** P4 could
claim byte-identical scores because nothing it changed touched the simulation; this session put
grenades back in ten bots' hands for the whole match instead of one each, and a fight in which
grenades keep arriving is a different fight. Every match still completes, still reaches a score
limit, and the four model invariants above are unchanged. `postMortemKills` moved 1 → 5 and
entitlement per life 75 → 93 threshold / 38 → 43 balance, all in the direction more lethal bots
predict.

**`npm run server -- --mode SND --matches 5`, for the decision.** `walletsAtLifeStart` against
`walletsAtRoundBoundary` (both then carrying their older names), per match: **5/5, 3/3, 1/1, 3/3, 4/4** — equal in all five, over 190
life-starts, with 0 partial stock. Every wallet that survived into a new life survived a *round
boundary*; none survived a death. That is the S&D policy measured rather than asserted, and it is
the invariant the skirmish harness now blocks on.

**`npm run skirmish` — 3 headless clients, real server, real wire, TDM.** This is the only place a
**connected human's** grenades are measured, because the local harness seats no humans.

| | Red | Green |
|---|---|---|
| Life-starts examined | 100 (22 human, 78 bot) | 110 (23 human, 87 bot) |
| With partial stock | **48** | **0** |
| Started empty | 33 | **0** |
| Grenades held / expected | 163 / 244 | **266 / 266** |
| Flow check | **FAILED** on the new assertion | PASSED |
| Streak life-starts inheriting a balance / round carry-overs | 0 / 0 | 0 / 0 |

**`npm run skirmish -- --vote 4` — the same three clients, in Search & Destroy.** The mode the
report named, over a real wire, with humans in it:

| | |
|---|---|
| Life-starts examined | **53** (12 human, 41 bot) |
| With partial stock / empty | **0 / 0** |
| Grenades held / expected | **130 / 130** |
| Streak life-starts inheriting a balance | **4** |
| Round-boundary carry-overs | **4** |
| Flow check | PASSED |

Those last three rows are the decision, and this is the only run in the session where the
invariant is exercised at a value other than zero: four wallets crossed a round boundary, and
four wallets were counted crossing it — two different signals, one read at the spawn and one at
the round turn, agreeing. Every other run has both at 0 because a Team Deathmatch life always
begins with a death. A wallet that had crossed a *death* would have moved the first number and
not the second, and the harness would have failed.

The red run's 48 failures are not split by owner, and the split was not measured. What can be
said: 48 out of 78 bot life-starts is 62%, against the 58% the bot-only harness measured on the
same code, and the pre-fix server refilled a human's hand on every spawn after the first — so the
red is consistent with the human half of it being zero **on the server**. The human's own hand
lives in `ClientMatch`, which no headless run builds at all. See "Needs a browser".

**`npm run leak` — 100 allocate/destroy cycles.** Subscriptions **29 → 29 (+0)**, heap 12.73 →
13.41 MiB. The baseline is two higher than P4's 27 because this session adds exactly two
subscriptions — `ServerMatch`'s spawn door and the ledger's round-boundary count — and both are
released by the `dispose` they were registered through. Flat is the property; the level is not.

**`npm run check` and `npm run build`** green.

### What was not verified

The **local player's own hand** is not measured anywhere in this session, and cannot be.
`HeadlessClient` drives `NetClient` and `Prediction` and builds no `ClientMatch`, so there is no
`MatchEquipment`, no inventory and no HUD counter to read; every number above that concerns a
human is the *server's* copy of their hand. The client change — the spawn serial driving
`beginLife` — is therefore verified by reading and by the server agreeing with itself, not by a
run. It is the whole of the "needs a browser" list below.

The **misprediction the round reset was causing** is likewise unmeasured. `npm run skirmish`
votes TDM by default and the `--vote 4` run exercises Search & Destroy over the wire, but the
harness's mispredict counters are reported per migration window rather than per round boundary,
so a round-start teleport would not have shown up as a number even before it was removed.

### Needs a browser

Every item is a networked match. Single-player is unaffected by the client half of this change —
`hardResetRound` still runs there, unchanged.

- **B3, the report itself.** Join a networked Team Deathmatch, throw both grenades, die. On
  respawn the HUD's lethal and tactical counters must both be back to the class's full count.
  This is the case round two fixed and it must still work.
- **B3 in the mode it was reported from.** A networked Search & Destroy. **Survive a round**
  after throwing a grenade — do not die. When the next round starts the counters must be full.
  Before this session they stayed at whatever the last round ended on, unless the client's own
  illegal round-reset happened to fire first.
- **The round start no longer teleports you.** Same S&D match, watch the moment the round turns
  over: the camera must arrive at the server's spawn point once, cleanly. Before this there was
  a second placement a snapshot later — the client's guess being corrected — which reads as a
  lurch or a brief double-take at round start.
- **The pre-match class change.** Press a class key during the ten-second freeze of round one.
  The grenades that arrive must be the ones the *new* class carries, at its count.
- **The S&D wallet, which is the decision.** Reach four kills in round one with a UAV in the
  class and spend it. Survive the round. In round two any balance left over must still be there.
  Then die: on the next spawn the balance must be 0. *(This item originally also asked that the
  UAV still read `USED` in round two. It will not: the once-per-life rule is gone, and what
  carries across the round boundary now is the wallet and the cooldown — the cooldown having
  almost certainly run out by then.)*
- **The bots throwing.** Not a HUD check — play a full networked match and notice that grenades
  keep coming in after the first minute. Before this every bot threw one lethal and one tactical
  in the whole match, which is the difference between an opponent who uses equipment and one who
  ran out of it before you met them. This is a **feel** change and the largest one in the
  session; if the match now feels grenade-heavy, that is the number to bring back.

### Found while here

- **Two more per-life resets are still filtered on `PLAYER_ENTITY_ID`**, which is entity 0 — the
  server's empty spectator seat — so neither fires for a connected human. `MatchProgression`'s
  `killsThisMag` never resets on a new life, and `PerksRenderer`'s footstep trail is never
  cleared, so the ghost of a previous life's path stays drawn. Both are the round-2 entity-id
  class of bug and both were missed by that audit, which walked client code looking for combat
  and cosmetic uses and did not treat a per-life reset as one. Not this session's mechanism —
  their *signal* is right and their *filter* is wrong — and neither was reported. Left.
- **`ServerMatch`'s hand keeps the grenades of the class it was created with.** `handOf` reads
  the loadout once, and `NetPlayer.applyLoadout` sets the weapons and the perks and never touches
  `hand.inventory.lethal`/`tactical`. So after a class change the server refills the *previous*
  class's grenade, at the previous class's count, for the rest of the match — while the client's
  `swapClass` sets the new one. It is the same family as B3 (a per-life reset restoring the wrong
  thing) but a different mechanism (the payload, not the signal), and it belongs with the loadout
  doctrine P3 owns rather than here. **This is the next bug**, and it is the row the table above
  would have caught if the table had a "what does it reset it *to*" column.
- **`FieldUpgradeRuntime.reset()` has no caller.** Deliberate — the charge is not per life — but
  a method with no caller looks exactly like a wire somebody forgot, which is how this session
  started. Recorded in the table so the next reader does not have to re-derive it.

---

## Playtest round 4 — reading the fight, and an optic with no hole in it

Covers **B2** (the crosshair on one AR), **B12** (team colours), **F9** (Depot is dark), **F2**
(an arrow to the bomb) and **F3** (the dog tag). Four of the five are about what the player can
*see*, which makes this the session where the split between what a harness can prove and what
needs eyes is at its widest — so two of the things built here are instruments rather than fixes.

### Two of the five had already been reported and fixed, and the interesting part is why they came back

B2 and F9 are both second and third reports of something the record says was dealt with. Neither
was a regression. In both cases the earlier fix was correct about the thing it named and was not
the thing that was wrong, and in both cases nobody could tell, because the quantity in question
lived where no process in this project could read it. That is the shape of the whole session:

- The crosshair's projection lived inside `Hud.updateCrosshair`, next to the `style.transform`
  writes it feeds. Asking "how wide is the M4's crosshair at rest" meant opening a browser.
- A map's brightness lived in a painter in `client/engine/ProceduralTextures`, three files away
  from the `lights` array two rounds of "Depot is too dark" had edited.

So `shared/ui/Crosshair.ts` and `shared/world/MapLuminance.ts` exist now for the same reason
`HudSurfaces` and `pickSpectatorTarget` do — the half that can be wrong invisibly belongs where
it can be measured — and `npm run readability` is the entry point that reads them. It is a
one-shot probe over the shipped tables rather than a run, so unlike every other harness here one
execution of it is a fact rather than a sample.

### B2 — the model had a scope and the def did not

*"The crosshair is closed on a particular AR-type rifle."*

The brief offered two hypotheses and both are dead, the first of them decisively:

| Hypothesis | What the measurement says |
|---|---|
| The spread cone collapses and draws a closed cross | `LONGBOW MK3` has the **widest** crosshair of the four ARs — 26 px standing against the M4's 18. The tightest cone in the game is the shotgun's, at 8 px. **0 of 48 hip-fire states** reach the 3 px floor |
| An optic misclassified as *scoped* takes the reticle away | Nothing misclassifies anything. `hasScope` is `def.scope !== undefined`, no AR carries a `scope` block, and no attachment adds one |

The real mechanism is the exact converse of the second, and it is one sentence: **`ar_longbow`
is the only weapon whose *model* carries a scope and whose *def* does not.**

Three weapons are modelled with `optic: 'scope'` — the two snipers and the LONGBOW, whose spec
comment says "long, thin, scoped: reads as a marksman rifle from across the screen". Two of them
have a `scope` block in `WeaponDefs`, so above `SCOPE_VIEWMODEL_HIDDEN` the viewmodel hands off
to `HudTactical`'s scope overlay and the metal is never seen. The LONGBOW has no such block, so:

- no overlay is drawn, because `hasScope` is false;
- the viewmodel is never hidden, because `scoped` tests the same field;
- and the crosshair fades to zero opacity at an ADS fraction of 0.74 like every other weapon,
  which is S6.5's rule and is correct.

That leaves the player aiming at `bodyTubes`' scope geometry: a 12-sided cylinder of radius
0.016 centred exactly on `spec.sightHeight` — the line `ViewmodelAnim.adsY` puts on the screen
centre — built by `CylinderGeometry` with its **end caps on**, because `openEnded` defaults to
false and nothing had ever needed otherwise. Aiming the LONGBOW is aiming into the flat back of
a gunmetal disc. "כוונת סגורה" is a precise description of it.

This is the third time this codebase has shipped the same defect, and both previous ones are
commented in the file it happened in again: the M6 playtest's *"pistol viewmodel obscuring the
target"* (sight bases straddling the sight line) and *"the SMG optic rendering opaque, blocking
the target entirely"* (a solid box where the window should be). M7 rebuilt `irons` and `reddot`
around `sightHeight` and wrote down the rule — *"the aperture is clear on all twelve weapons by
construction"*. It was clear on ten. `scope` was exempted on the reasoning that its owners hand
off to the overlay, which is a statement about `WeaponDef.scope` made in a switch on
`WeaponModelSpec.optic`, and those two disagree on exactly one weapon.

**The fix makes the mesh honest rather than giving the rifle a `def.scope`.** A scope block is
scope-in time, an FOV pull, breath and sway; inventing those to unblock a sight picture would be
a simulation change made for a picture, and the LONGBOW was balanced without them. So the tube
and its objective bell are open-ended, and the ocular end gets what the red dot has had since
M7 — glass with `depthWrite: false`, and an emissive speck on the sight line. Both derive from
`scopeOcularZ`, which `bodyTubes` and `opticBoxes` now share, because a lens placed from a
re-typed copy of the tube's own expression is a lens four millimetres behind the eyepiece that
nobody can explain. For the two snipers the change is invisible — their viewmodel is gone before
the overlay arrives — and the cost of making the rule uniform is two quads.

**The floor, since the brief asked for one.** `MIN_GAP` already existed at 3 px and is now named
`CROSSHAIR_MIN_GAP` and documented as a legibility floor rather than a tuning constant. Measured:
**0 of 48 hip-fire states across all twelve weapons reach it**, so it is a guard against a future
weapon rather than a number the game is sitting on. The ADS column is reported and deliberately
excluded from that count, because `crosshairOpacity(1)` is `0.00` — a collapsed gap there is
invisible by design.

### B12 — the palette was right and three surfaces chose from it wrongly

*"In multiplayer I can end up on the red side, which is confusing because red normally means
enemy."*

`ui/Palette.ts` has been right since M8. It exposes `friendly` and `hostile` and has no concept
of a team A colour in any of its three colourblind modes; there is no absolute team colour in it
to leak. The leak is one level up, in the surfaces that decide *which of the two to ask for*, and
it is the same expression written three times:

| Surface | What it said |
|---|---|
| `Scoreboard` | `team === 'A' ? 'friendly' : 'hostile'`, and `'ALLIES' : 'AXIS'` |
| `Killfeed` | `team === 'A' ? '…--friendly' : '…--hostile'` |
| `HudBanner` | slot A built with `--friendly` and slot B with `--hostile`, at construction |

Each is correct for the seat the game was built from. `Match.smallerTeam` sends the **second
human to join** to team B, and from there the scoreboard paints your own side hostile red and
labels it AXIS on the right, the killfeed paints your team-mates as enemies for the whole match,
and the banner shows your score in the enemy's colour. `EndOfMatch` reuses `Scoreboard`, so the
summary screen was absolute too — at the one moment the player looks hardest at it.

Already relative and needing nothing: the minimap (*"resolved by the caller against the local
team, so the minimap needs no team logic"*), the objective meshes, zone ownership, and the alive
counter. The vote overlay carries no team colour, and there are no nameplates in the tree.

**The rule is enforced by types, which the brief asked for over a comment.** `shared/ui/
TeamColour.ts` holds `relationTo(viewer, subject)`, and `relationClass` — the only door from a
relation to a stylesheet suffix — accepts only a `TeamRelation`. A raw `ScoreTeam` no longer
type-checks anywhere a colour is chosen, so the broken expression cannot be written: there is
nothing for `team === 'A' ? …` to return that a caller can use. The audit agrees with the type
after the change — `grep` finds no `=== 'A'` left in `client/ui` at all.

Three decisions inside it that are not just a rename:

- **Order is part of the bug.** A team-B player was reading their own score on the right. Both
  two-slot surfaces put the viewer's own side on the left now, via `teamsInViewOrder`.
- **`ALLIES` / `AXIS` were absolute too**, and carried the same defect in words: a player seated
  into B was told they were the Axis. They follow the relation.
- **Free-for-All is inside the same function rather than beside it.** FFA keeps the two-team
  substrate deliberately, so half of every lobby shares the viewer's `ScoreTeam` without being a
  team-mate — the seam post-M8 closed in the minimap and the gunfire ping and left open in the
  killfeed, where four opponents were drawn green. `relationTo` takes `freeForAll` and answers
  `HOSTILE` for everybody, so the killfeed is fixed by the same change rather than by a second one.

The viewer is assembled once, in `MatchHud`, and handed to all three surfaces; `ClientMatch
.viewer` is the getter it comes from, beside `localTeam`, which already carries a comment about
this class of bug. The summary board takes it from `GameScreens.showSummary`, because that screen
is built at boot and outlives every match it shows.

### F9 — the fill was not the small number either, and this time the small number was not a light

*"The third map is very dark."* Reported after M8, again at round 2, and now a third time.

Round 2's work is right and I checked its arithmetic before touching anything: it found that
intensity was the wrong lever, re-derived Depot's hemisphere colours in linear space, and landed
the fill at about 42% of Foundry's sky term with a ground term that is actually *brighter* than
Foundry's. There is nothing left to find in `depot.ts`. So the analysis the brief asked for —
*"the problem was not the key light, it was the fill"*, applied to Depot — has an answer one
level further down, and it is not a light at all:

**Depot's yard is one `asphalt` span from wall to wall, and `asphalt` was `0x24262b` — a linear
luminance of 0.019, against Foundry's floor at 0.101.** A surface that returns two per cent of
what falls on it. Two rounds multiplied the light reaching it by 1.5 and 1.9; two per cent of
1.9 is still two per cent. That is why each pass looked partial, and why the third report says
what the first one said.

The number was in a painter in `client/engine`, where the word "lighting" does not appear and
where no Node process could read it. It is in `shared/world/maps/albedo.ts` now, one table, and
`ProceduralTextures` takes its fill from it — so the grain, aggregate, cracks and bay lines stay
exactly where they were and the number they are laid over can be measured.

Measured, and the red control is one flag rather than an edit-and-revert:
`npm run readability -- --ground 0x24262b` re-reads Depot with its shipped asphalt.

| Map | Ground | Albedo (linear) | Floor, as the screen shows it (0-255) |
|---|---|---|---|
| Foundry | `floor` | 0.1014 | 61 / **61.7** / 96 |
| Dunes | `sand` | 0.3818 | 185 / **185.0** / 185 |
| Depot — **before** | `asphalt` 0x24262b | 0.0194 | 3 / **4.4** / 10 |
| Depot — **after** | `asphalt` 0x474b53 | 0.0700 | 15 / **21.3** / 39 |

1188 samples across the nav grid, up-facing, sRGB decode through irradiance, Lambert, ACES and
exposure 1.25 — the same five multiplications the renderer performs. **The yard was a mean of
4.4 out of 255.** Four counts off black. The post-M8 note recording that the report came back
saying *"STILL pitch black"* was not an exaggeration; it was a reading.

**And the reason given for keeping it there is wrong**, which is worth writing down because it
survived two fixes. The old comment said a brighter ground would "flatten the pools into a
uniform grey". Albedo is a *multiplier*, so it cannot change the ratio between a mast pool and
the gap between two masts. Measured across the playable grid, that ratio is **2.60x on Depot**
before and after this change — against Foundry's 1.86x and Dunes' 1.00x, so Depot remains the
most pooled map in the game and by some distance the darkest. What flattens pools is *fill*,
which is added rather than multiplied, and fill is exactly what the two previous passes raised.

The first version of that ratio in the probe was wrong too, and it is a useful mistake: it
sampled "under a mast" against the world origin and reported 1.05x. The origin on Depot is six
metres from a mast. A ratio is only as good as the two places it was measured, so the probe takes
the extremes of the whole grid, which has no opinion.

**What this does not settle.** `MapLuminance` states its limits and they all point one way — no
shadowing, no baked vertex AO (whose floor is 0.32, so an enclosed corner is up to three times
darker than reported), no fog, no texture detail. Every number above is therefore an **upper
bound**, which is the direction that makes the *before* conclusive: a mean of 4.4 with the
sunniest possible assumptions is unarguable. It cannot be read backwards. Whether 21.3 is now
enough is a browser claim and it is on the list below with a screenshot, along with the honest
statement that if it is still dark the next lever is the irradiance floor — Depot's darkest floor
samples receive 0.705 against Foundry's 2.148, and at those samples the masts contribute nothing
at all.

### F2 — the bomb arrow, and where its boundary is

`MatchObjectives` opens by ruling out exactly this: objective markers are **world geometry, not
HUD markers**, because "a capture ring drawn on the HUD tells you a number, and a capture ring
drawn on the floor tells you where to stand". That argument is decisive for a capture ring and it
is not decisive here. For a bomb lying somewhere in a sixty-metre map that the round cannot start
without, *which way is it* is the entire question, and the world object answering it is a 0.3 m
box behind a container — which this same file already records as having been reported as
*"there is no physical bomb entity"*.

So route (a), an off-screen HUD indicator, and the rule in `MatchObjectives` is amended where it
was departed from rather than left contradicting the code.

**The intel filter is satisfied by construction, not by a check**, and the report's own wording
is what draws the line — *"the bomb **to pick up**"*:

| Bomb state | Arrow |
|---|---|
| `CARRIED`, `carrierId === -1` — on the floor, claimable | **yes.** A fixed public point that both sides already see blinking |
| `CARRIED`, `carrierId >= 0` | **no.** The bomb's position *is* a living player's position — `followCarrier` makes it true every tick so the mesh can ride its carrier, which is exactly what would make a HUD version a wallhack on whoever picked it up |
| `PLANTED` | **no.** The site is a world object with a ring and an accelerating light |

`readBombBearing` is the only source, it is written in the same pass that decides where the mesh
goes, and it is cleared every frame and re-asserted — so a pickup takes the arrow down on the
frame it happens rather than leaving it latched. There is no code path that can hand the HUD a
carried bomb's coordinates.

**One component, not two.** The brief named `showHitDirection`, which is the *transient* member
of this family — a chevron that fades over 1.1 s. The persistent member is `HudTactical`'s
grenade-threat arrow, which takes a world position, the player's position and yaw, and rotates a
ring-mounted element for as long as a condition holds. That is what a bomb marker is. Both are
`BearingIndicator` now, two instances rather than one element with two writers, because a grenade
can land beside the bomb you are running for. The bomb's arrow is deliberately calmer and further
out than the grenade's: one says *you are about to die* and the other says *the objective is that
way*, and a HUD that shouts both at the same volume has said nothing. It reads `--c-neutral`,
which is what an unclaimed objective is everywhere else in this game.

### F3 — the tag was a hologram because of its material

What made the dog tag read as a hologram was not its shape. It was one `MeshBasicMaterial` with
`toneMapped: false` shared by the plate and the chain, so the whole object was a flat fill of the
team colour that no light in the scene touched. A thing that does not respond to the light around
it is not in the world.

The plate and chain are lit steel now — one `MeshLambertMaterial` shared by all 24 pooled tags,
since none of them changes colour — with bevel strips that give a 16 mm plate visible thickness
at three metres, a 16-segment chain ring in place of the old 4-segment one that was a visible
square, and a bead at the clasp. It hangs off the chain on its own group and swings slightly out
of phase with the spin, which also fixes something the old one did: a flat card rotating about
its own axis presents zero area twice per revolution and flickered out of existence at those
angles.

**The colour moves to an emissive edge behind the plate**, and that is the part that needed
thinking about rather than re-skinning. Making the whole tag lit would have been the
honest-but-useless version: on Depot, at 21 counts out of 255, a steel plate on asphalt cannot be
seen, and Kill Confirmed is a mode built entirely on noticing these from across a room. The edge
keeps `toneMapped: false`, so the tag is exactly as findable as it was while the object in front
of it is solid, and friendly-to-deny stays one glance from enemy-to-confirm. Cosmetic only:
`check:cosmetics` is green, the snapshot is untouched, and nothing here goes near
`KillConfirmedConfig.pickupRadius`.

### Measured

Every number came out of a run in this session. **No protocol change** — nothing in P9 touches
the wire, so there is no version to bump and `netharness` has nothing new to exercise.

**`npm run readability`** — the new probe, and the source of every content number above.

| Probe | Result |
|---|---|
| Crosshair gaps, 12 weapons × 4 hip-fire states | **0 of 48** at the 3 px floor; AR family 18 / 22 / 16 / **26** px standing |
| Reticle opacity | hip **1.00**, half-ADS 0.32, full ADS **0.00** |
| Weapons offered the scope overlay | **2 of 12**; the other 10 must show a sight picture from their own geometry |
| Team colour, every (viewer, subject) pair | **0 violations of 12 pairs**, both seats, team modes and FFA |
| Depot's yard, before → after | **4.4 → 21.3** mean of 255, over 1188 samples |
| Depot pool-to-gap irradiance | **2.60x**, unchanged by the albedo (Foundry 1.86x, Dunes 1.00x) |

The team-colour half **exits non-zero on a violation**; the crosshair and lighting halves are
readings, because there is no threshold a human has agreed to and inventing one here would be the
magic number P0 bans.

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.** The regression control, and this
session is the one where it should be exact: everything above is presentation.

| | |
|---|---|
| Scores | **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5's baseline on the same seeds |
| Life-starts with partial grenade stock | **0** across all five (observed stock equals expected in every match) |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |
| Negative balances / kill-anchor resyncs | **0 / 0** |

**`npm run skirmish` — 3 headless clients, a real server, a real wire, shipped timings.** Also
presentation-only, so this is a control too: nothing here should have moved and nothing did.

| Probe | Result |
|---|---|
| The run | **FLOW CHECK PASSED** |
| Migrations | 3 of 3, **0 failed**; live roster 3H + 7B = 10, the mode's authored count |
| Mispredictions entering a live match | **0** (S8.9 requires 0); to the arena 0; spawn window 0 |
| Divergence checker | **0 / 7373** per client |
| Spectator invariants | 6620 selections while dead, **0 self / 0 enemy / 0 dead** |
| Quick loadout window | 10 079 ticks over 30 windows, **0 while alive** |
| Tab surviving `neutralise` while dead | 3280 of 6507 dead ticks; board open 3280 |
| Per-life grenade stock | 113 life-starts (24 human, 89 bot), **0 partial / 0 empty**, 274 held against 274 expected |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |

And one incidental confirmation that B12 was reachable exactly as reported: the server seated
**OP1 on team A, OP2 on team B, OP3 on team A**. The second human into a match is on the red
side, every time, which is `Match.smallerTeam` doing what it was written to do.

Unchanged and expected: `post-match hold: NOT EXERCISED` at shipped timings, for the reason the
B4 session recorded.

**`npm run leak` — 100 allocate/destroy cycles.** Subscriptions **29 -> 29 (+0)**, heap 12.73 ->
13.42 MiB (+0.69). **LEAK CHECK PASSED.** The baseline is P5's 29 unchanged: the two arrows are
pooled DOM owned by `HudTactical`, the tag pool is 24 groups built once per match, and nothing in
this session subscribes to anything.

**`npm run check`** and **`npm run build`** green — boundaries (294 files), the cosmetic audit
(19 snapshot fields) and the unlock audit all pass, and all three typecheck targets.

### What was not verified

Everything about how any of this looks. `HeadlessClient` builds no `ClientMatch`, no `Game` and
no DOM, and the preview pane never fires `requestAnimationFrame` — so of the five items here,
**four produce no harness number at all** and the fifth (F9) produces a number about arithmetic
rather than about a rendered frame.

That gap is the reason two of this session's five deliverables are instruments. What `readability`
buys is not a substitute for looking: it is that the next person to be told "the third map is
dark" can say by how much, in the units the eye uses, before touching a light.

Specifically unverified, and each was reasoned from the code:

- That the LONGBOW's sight picture is now clear. The geometry says the caps are gone and the
  glass is on the sight line; whether the aperture *reads* at ADS is pixels.
- That an open-ended tube looks right from outside at hip. Backface culling makes the interior
  invisible, which is the intent, but it is a claim about a rasteriser.
- That 21.3 / 255 is enough. See F9 above.
- That the dog tag is legible on Depot now that its body is lit.

### Needs a browser

- **B2, and it is the one to check first.** Equip `LONGBOW MK3` and aim. You must see *through*
  the scope — a clear tube with a small red dot on the sight line — rather than at a flat metal
  disc. Then aim a `KESTREL .338` and a `VANTAGE SR`: both must be exactly as they were, because
  their viewmodel is hidden before the overlay arrives and this change must be invisible on them.
  Then the M4 and the HALCYON, whose irons and red dot must be untouched.
- **B12, from the seat that has it.** You need to be the **second** human into a match, which is
  what puts you on team B. Your side must be on the **left**, in green, labelled ALLIES — on the
  scoreboard, on the score banner and on the end-of-match board. Your team-mates must be green in
  the killfeed and the enemy red. Then play an FFA: every other name in the feed must be hostile,
  including the half of the lobby that shares your substrate side, and the banner must read
  LEADER on the left and YOU on the right with your own number the friendly one.
- **F9, with a screenshot.** Vote Depot. Stand in the yard between two mast pools and photograph
  it; stand under a mast and photograph that. The pools must still read as pools — that is the
  claim the 2.60x ratio makes and the thing the previous fix was afraid of losing. If it is still
  too dark, the number to bring back is whether you can see a body against the asphalt at twenty
  metres, because that is what the next lever gets chosen against.
- **F2.** Play Search & Destroy as an attacker. At round start the arrow must point at the bomb
  and must go away the moment somebody picks it up — **watch for that specifically**, because an
  arrow that keeps tracking a carrier is the wallhack this design exists to avoid. It must not
  come back after a plant. Then get an enemy grenade thrown at you while the bomb is loose: two
  arrows, and they must be distinguishable at a glance.
- **F3.** Kill Confirmed. The tag must read as a solid object that catches the map's light and
  swings on its chain, and it must still be findable across a room — check that on Depot rather
  than Foundry, which is where it is hard.
- **The killfeed at its real size**, unchanged from P3's list and now also carrying B12's colours.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **`asphalt` is used by exactly one map**, which is what made raising it safe and local. It is
  also the only ground in the game whose base colour was chosen to be "correct for the material"
  rather than against the light it would sit under, and the comment that defended it was reasoning
  about a multiplier as though it were an addend. Worth keeping in mind for the next map: the
  question a ground colour has to answer is not *what colour is asphalt*, it is *what does this
  return under this map's light*.
- **`BotMesh` keys its bodies on the team letter too** — slate for A, sand for B — so which
  silhouette your side wears flips between matches. It is deliberate and documented as such
  ("neither team reading as the enemy by colour alone"), so it is *not* the B12 defect: those two
  colours are not the palette's friendly and hostile, and neither means "shoot this". Left,
  recorded, because it is the one remaining absolute team→appearance mapping in the client and
  the next person grepping for one will find it.
- **`WeaponModelSpec.optic` and `WeaponDef.scope` are two answers to "does this weapon have a
  scope"**, and B2 is what one disagreement between them cost. They are not merged here: one is a
  client-side model description and the other is shared simulation data, and merging them would
  put a rendering detail in `shared/` or a balance number in `client/`. What changed is that the
  disagreement is no longer *fatal* — every optic kind now builds a clear aperture, so a spec that
  says "scope" on a weapon the simulation does not scope is a cosmetic mismatch rather than a
  blind rifle. The next weapon to want a real scope still has to add both.
- **`DUNES` reads 185 / 185 / 185** — a perfectly flat floor, because it has no point lights at
  all. Not a defect (it is midday sun on open sand) and not this session's item, but it is the one
  map where the lighting has no spatial structure whatsoever, and it is worth knowing before
  anybody asks why it feels flat.

## Playtest round 4 — the waiting room, and two facts that were one flag

F7, F11, F12 and F13. Three of the four are the same shape, and it is the shape §6.3 was
written in: **a rule expressed as a limit rather than as an absence, and an effect hung on the
wrong thing.** The arena's "no score" was two zeroed numbers in `FFA_WARMUP_CONFIG`; F13's trap
is a cue hung on a broadcast instead of on a transition; F11 is a width hung on a positioned
layer instead of on its content. F7's own two halves turned out to be one fact with two
consequences, which is why they are one paragraph below rather than two sessions.

### F7 — "damage live" and "players killable" were never the same claim

§6.3 asked for the greybox room *"with damage live and instant respawn"*, and the fourth
playtest changed the requirement to no dying in the waiting area at all. The amended clause is
in "Deviations, and why" above; the code now says the same thing, which it did not before.

The distinction the brief asked to keep is real and it is already in the type. `Damageable.team`
has said since M2 that it is *"absent for anything that is not on one — M2's range dummies are
damageable and belong to nobody"*, so "is this a person" is a question the damage door can
already answer without being told anything new. `DamageSystem.combatantsInvulnerable` skips the
health deduction for a target that has a team and leaves everything else alone: the dummies take
damage, drop, and time a kill exactly as they did, which is what keeps the room a range rather
than a corridor with people standing in it.

**The damage is still computed and still reported, and that was the decision the brief asked
for.** It was made on what a networked client actually predicts, which is less than it looks:

- Another combatant's health is replicated (S4.15). The client holds no opinion about it.
- The client's own rounds already pass **through** remote bodies. `Ballistics.nearestTarget`
  selects from `DamageSystem.list`, and on a networked client that list holds the local body and
  the range's dummies — nothing registers a `RemoteActor`. Their rigs exist for drawing and for
  the rewind panel.
- So the hitmarker, the damage numbers and the hurt vignette all arrive from the server's
  `Ev.Damage`, and nothing local produces them.

Refusing the *deduction* therefore changes exactly one number, and it is one the client is told
rather than one it works out. Refusing the *computation* would have to happen in target
selection, and that moves where the round stops — `FiredEvent` carries the terminus, and every
client in the room draws a tracer and an impact from it. One of those two is invisible to
prediction and the other is a visible change to what everybody sees a bullet do.

### The room kept a leaderboard, and the limits were never what stopped it

The brief asked me to trace `ScoreSystem` and `MatchProgression` from the warmup path and report
what I found. They are opposite results.

**Progression, challenges and XP: not fed, and it is worth saying why not.** The server has no
`MatchProgression` at all — S4.16 gives it no store, and `Match.ts` says so. The client's banks
in exactly one place, `Profile.bankMatch`, reached only from the SUMMARY state's `enter`; the
arena cannot reach SUMMARY because `FFA_WARMUP_CONFIG` has no win condition, and `applyRotation`
tears the world down and rebuilds it on migration, so the in-memory tally is dropped rather than
carried into the match. All true, and all of it structural rather than intended: not one line
anywhere says *the arena does not bank*. It is now also true by construction, because a client in
the arena registers no row either and there is nothing for the progression to count.

**The scoreboard: fed, and reported as such.** `ServerMatch.seat` registers a `ScoreSystem` row
per human and per bot; the client mirrors it from the roster channel. The two subscriptions in
`ScoreSystem` then tally `shotsFired`, `shotsHit` and `damageDealt` into those rows for as long
as anybody is in the room, Tab renders them, and the Free-for-All banner puts a `LEADER` and a
`YOU` score over the crosshair. **The waiting room had a live ladder**, which is exactly the
*"rating and results"* F7 asks to be taken out of it. Zeroing `scoreLimit` and
`timeLimitSeconds` says there is nothing to count *toward*; it never said nothing is counted, and
the difference went unnoticed for three milestones because a ladder nobody can win looks like a
feature nobody has finished.

`ScoreSystem.records` is the absence, and it is enforced at `register` rather than in each
handler for one reason: every counter in that class already starts by looking a row up and gives
up when there is not one. One refusal at the top switches the whole class off and there is no
second place to forget — which is the failure mode this milestone keeps producing. `register`
returns `PlayerScore | undefined` now; no caller ever used the value, and putting the absence in
the type is better than handing back a row that nothing can find.

Both flags are set from `variant === 'WARMUP'` in `ServerMatch` and from `warmupArena` in
`ClientMatch`, beside `friendlyFire`, which is set in both runtimes for the reason its own
comment gives: they are one fact about the match, and setting it in one runtime and not the
other is what produced a mode where you could shoot somebody but not score them. The variant is
the source rather than the mode id, because a ballot can elect Free-for-All and a live FFA must
kill and score exactly as it always has.

### F12 — the caption is the room's, not the phase's

There is already a convention for centred-above-the-crosshair text and it already had a single
writer: `HudBanner` builds `hud-phase`, `Hud` mounts it, and `MatchHud.update` is the only thing
that writes `phaseLabel`. What it did not have was any notion of *which instance you are in* — it
derived the caption from `MatchFlow.currentPhase` alone, which in the arena means `GET READY` for
ten seconds and then nothing for as long as you stand there.

`matchCaption` moves into `shared/ui/HudSurfaces.ts` beside the round-4 rules, with the arena
outranking the phase. (**Amended below**: the arena fact was threaded to each surface as a loose
boolean, which is the shape the regression session collapsed into `HudSurfaceState.inWarmupArena`
and one predicate.) It is there for the reason everything else in that file is: the label is a
pure function of state that outlives the element, so a headless client with no DOM can count the
ticks it was up in the room and — the half that matters — assert it was never up anywhere else.

One detail that would have shipped as a bug: `MatchFlow.phaseSecondsRemaining` counts the
round-end hold down *through* `LIVE`, so a caption that took the seconds it was offered would
have opened on `WAITING · 5` and counted toward nothing. `captionHasCountdown` is the other half
of the rule, and `MatchHud.update` remains the single writer of both fields.

### F13 — the ballot is broadcast at 4 Hz, and the cue is not

The trap the brief named up front, and it is worth recording what it would have cost: measured
on a real cycle, a client receives **43** `MAP_VOTE` broadcasts. A sound played from the body of
`VoteOverlay.apply` plays 43 times over one ten-second ballot.

`mapBallotOpened(previous, next)` is the edge, in `shared/net/Skirmish.ts`, and `apply` takes it
from `this.info` **before** overwriting it — the previous phase is the whole rule, and `apply` is
the only thing that moves it, so there is no flag beside it and nothing to reset. `hide()` drops
`info` on migration, which re-arms the cue deliberately: a player put back in the arena during a
ballot has genuinely just had it appear in front of them.

It is the **map** ballot and not either ballot, which is what F13 asks for literally and is also
the only reading under which "one sound per cycle" is a fact about the phase machine rather than
a debounce somebody tuned. The sound itself is two rising notes on the `ui` bus in
`ProceduralAudio.playBallotOpen` — rising because every falling cue already in the project means
something bad, and it has to cut through a firefight without reading as a threat.

**Reversed below.** Choosing the map ballot alone bought that clean assertion by leaving the
*mode* ballot — the first one, and the one that opens the whole question — silent. `ballotOpened`
replaces `mapBallotOpened` and fires once per ballot *opening*, two per cycle, with the two
pitched differently from one generator. See "one edge over the ballot phase, and the mode ballot
was silent".

### F11 — the width was on the layer, so the layer stopped being full-screen

`.op-screen` is `position: absolute; inset: 0`, and `.op-screen--wide` put `max-width: 780px` on
it. That box is over-constrained — left, right and a width cannot all hold — and CSS resolves it
by dropping `right`. So the settings screen was a 780 px column **pinned to the left edge**. The
confirming detail is that the backdrop is painted by the same element: the right-hand two-thirds
of the screen was also undimmed, which is one rule producing both halves of the report.

The convention already in the file is the opposite one, and every other overlaid screen uses it:
the layer stays full-bleed and centres its children, and the *content* carries the cap —
`.sb`, `.sb--embedded`, `.eom__xp`, `.lo-head` and `.lo-columns` are all `width: min(px, vw)`.
`--wide` now caps the two elements that need the width and leaves the title and the Back row
shrink-to-fit, centred by the layer's own `align-items` as they already were.

### Measured

Every number came out of a run in this session, and the arena block is a new probe:
`reportArena` in the skirmish harness, printing each figure next to the control that makes it
mean something. **No protocol change** — every fact this session needs was already on the wire
(`Welcome.matchId` since v3), so there is no version to bump.

**`npm run skirmish` — 3 headless clients, a real server, a real wire, shipped timings.** Red
control first, on the same tree with the probes in and no behaviour changed:

| Probe | Red control | After |
|---|---|---|
| Score rows in the arena | **6** (3 humans + 3 bots) | **0** |
| Lowest health seen in the arena | **0** | **100** |
| Hits taken in the arena — *"damage live"*, and it must not go to zero | 20 | **85** |
| Deaths in the arena | **4** | **0** |
| Ballot cue fires, per client per cycle | — | **1** |
| `MAP_VOTE` broadcasts, per client — what a level-triggered cue would have fired | **43** | 43 |
| Caption ticks in the arena / `WAITING` ticks in a live match | — | 10 821 / **0** |

The hits number went *up*, which is the right direction and worth stating: a body that no longer
dies stays in front of the bots that are shooting it, so the room is now demonstrably more live
fire than it was, not less. It is also the number that stops the health floor being a green light
for a run in which nothing ever engaged.

Everything else in the same run is a control and none of it moved:

| Probe | Result |
|---|---|
| The run | **FLOW CHECK PASSED** |
| Migrations | 3 of 3, **0 failed**; live roster 3H + 7B = 10 |
| Mispredictions entering a live match | **0** (S8.9 requires 0); to the arena 0; spawn window 0 |
| Divergence checker | **0 / 7373** per client |
| Spectator invariants | 5223 selections while dead, **0 self / 0 enemy / 0 dead** |
| Quick loadout window | 8733 ticks over 25 windows, **0 while alive** |
| Per-life grenade stock | 106 life-starts (22 human, 84 bot), **0 partial / 0 empty**, 256 held against 256 expected |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.** The regression control, and the
one that has to be exact: nothing in this session may touch a live match.

| | |
|---|---|
| Scores | **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5's and P9's baseline on the same seeds |
| Life-starts with partial grenade stock | **0** across all five |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |
| Negative balances / kill-anchor resyncs | **0 / 0** |

**`npm run leak` — 100 allocate/destroy cycles.** Subscriptions **29 -> 29 (+0)**, heap 12.78 ->
13.44 MiB (+0.66). **LEAK CHECK PASSED.** The baseline is P9's 29 unchanged, which is the number
to watch here specifically: the leak harness builds the arena deliberately empty, and this
session put two new flags and a caption rule on that path without subscribing to anything.

**`npm run check`** and **`npm run build`** green — boundaries (294 files), the cosmetic audit
(19 snapshot fields) and the unlock audit all pass, and all three typecheck targets.

Unchanged and expected: `post-match hold: NOT EXERCISED` at shipped timings, for the reason the
B4 session recorded.

### What was not verified

**Every visual claim in this session, which is most of it.** Three of the four items are
presentation, `HeadlessClient` builds no `ClientMatch` and no DOM, and the preview pane never
fires `requestAnimationFrame`. Specifically:

- **The sound.** `ProceduralAudio` needs an `AudioContext`; the harness has none. What was
  measured is the **rate** — that the edge fires once where the broadcast fires 43 times — which
  is the half that could be wrong invisibly. Whether two rising notes are the right two notes is
  not a thing a number answers.
- **That the caption is where the human wants it.** 10 821 ticks says the rule is up in the room
  and the 0 says it is nowhere else; neither says a pixel was drawn. The B13 correction earlier in
  this file is the standing warning about exactly that confusion.
- **That the settings screen is centred.** Reasoned from the box model and from the convention the
  other four screens follow, and it compiles, which for CSS means nothing at all.
- **That being shot without losing health reads as intended rather than as broken.** The hurt
  vignette, the hit-direction chevron and the damage numbers all still fire in the arena, because
  they are driven from the server's damage event and the damage is still real. That is §6.3's
  "damage live" surviving the amendment, and it is a deliberate choice that only a person can
  judge.

### Needs a browser

- **F7, and it is the one to check first.** In the arena, get shot by a bot and stand there. The
  health bar must not move, you must not die, and you must still see the hit feedback — the
  vignette and the chevron. Then shoot a bot: hitmarker, damage numbers, and it does not drop.
  Then shoot a **target board**: it must take damage, fall, and print a time-to-kill exactly as it
  always has. That last one is the whole distinction this change is built on, and it is the one
  that fails silently if the `team` test is wrong.
- **F7's second half.** Press Tab in the arena. The board must be **empty** — no rows, not rows of
  zeroes — and the banner over the crosshair must show no `LEADER` and no `YOU` score. Then vote
  into a match and press Tab there: the full board must be back, with everybody on it. That pair
  is the test, because one flag set on the wrong instance would pass the first half.
- **F12.** The caption must read `WAITING`, centred, with **no number beside it**, for the whole
  time you are in the arena — including the first ten seconds, which is where a phase-derived
  caption would have said `GET READY`. It must be gone the moment you are migrated. If it wants to
  sit higher than the objective banner's line, that is one number in `.hud-phase`.
- **F13.** Stand in the arena through a full cycle. Exactly one cue, at the moment the **map**
  ballot replaces the mode ballot — not at the mode ballot, and not repeating for the ten seconds
  the map ballot is up. Then check it is audible over sustained fire, which is the condition it
  exists for.
- **F11.** Open Settings from the main menu and from the pause screen. It must be centred, and the
  darkened backdrop must cover the **whole** screen rather than a column down the left. Then check
  the Back button is still centred under the panel and that the binding list still scrolls and
  still holds its scroll position across a rebind, because the rule that moved is the one those
  two sit inside.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **Nothing in the codebase ever said "the arena does not bank progression".** It does not, and
  four separate structural facts have to stay true for that to hold: no server-side
  `MatchProgression`, no win condition, banking only from the SUMMARY `enter`, and a world rebuilt
  on migration. Any one of them changing — a warmup with a time limit, a banking call moved to
  teardown — turns the waiting room into an XP farm silently. It is now also enforced at the row,
  which is one guard instead of four coincidences, but the four coincidences are still
  load-bearing for everything else and are worth knowing about.
- **The arena's bots cannot be killed either, and that is the decision rather than a side
  effect.** F7 names player-to-player damage; the rule is written on "is this a combatant"
  because a bot dying in the waiting room produces exactly the things F7 removes — a killfeed
  line, a score row, a streak credit and a respawn. The room is a live-fire range with company:
  the bots shoot at you, you shoot back, the boards are what falls over.
- **`TargetRange` and `TargetDummy` are client-only.** The server has no dummies at all, so
  "dummies keep taking damage" is entirely a client-side claim about a client-side damage system,
  and the flag set on the client is the only one that could ever have broken it. Worth knowing
  before anyone tries to make the boards authoritative: the server does not know they exist.
- **`ScoreSystem.register`'s return value has never been used**, by any of its six call sites, in
  five milestones. That is what made changing its type free, and it is a small sign that the
  registration is a roster fact rather than a scoring one.

## Playtest round 4 — the seat a disconnect used to take with it

Covers **F8** (reconnect, and joining a match that is already running, after a disconnect). It
also amends **§6.7**; the amended clause is in "Deviations, and why" above, and the code now says
the same thing.

### There was no reconnect, and the comments that mention one are about something else

The brief points at three places and asks what actually happens today. All three turn out to be
about a different thing. `Session.ts:111` says *"a reconnect reseats the session"* while
describing the `afterIdentity` ordering contract for a **migration**; `Session.ts:271` names *"the
reconnect grace"* inside a comment about a bug that was fixed; `serve.ts:76` is about SIGTERM and
a *client's* reconnect loop. There is no registry, no token and no held seat anywhere in the tree.

The mechanism, in one line: **a returning client is a new connection, and every fact that
identified the old one — the `playerId`, the entity, the scoreboard row, the team — is minted
fresh, because the only things a `Hello` carried were a name and a class.** A name is not an
identity: two players may share one and anybody may claim yours.

Four consequences, all of them that one cause, and the last two were not in the report:

| Reported / observed | What it was |
|---|---|
| "I lose my seat when I drop" | `onLeave` to `router.release(_, 'disconnected')` to `replacePlayerWithBot`. Correct, and nothing ever gave it back |
| "I come back to the lobby" | `onJoin` called `warmup.seat` unconditionally. §6.7 made the arena the only entry point, so a return mid-match meant standing in the arena until the next ballot |
| **A returning player was on the end-of-match board twice** | `Match.removePlayer` keeps the score row on purpose, and `LiveMatch.buildSummary` derives `isBot` from *"no session sits on this entity"*. So the kills they earned stayed on the board attributed to a bot, while they accrued a second row from zero |
| **Three reconnects killed the match for everybody** | Measured, below. Each returning player landed in the arena, so the third one emptied the live instance and `maybeAbandonLive` tore it down — one reconnect each was enough to cost eight other people their match |

### The red control, before anything changed

`npm run skirmish -- --drop-return 3 --drop-hold 3000` on the untouched tree. Three clients, a
real server, a real wire, shipped timings; each client is dropped **uncleanly** mid-match, held
three seconds, and dialled back in.

| | Red (today's tree) |
|---|---|
| Kept the seat | **0 of 3** — entity 1/2/3 in match 1 became entity 4/5/6 in match 0 |
| Kept the score | **0 of 3** — `e1 0k/1d`, `e2 0k/1d`, `e3 0k/2d` before; **no row at all** after |
| Resynced | 3 of 3, in 48 / 62 / 82 ms |
| The live match | **abandoned** — "every human has left a running match", 10 bots discarded |
| The run | **FLOW CHECK FAILED**, twice |

The "no row at all" is the arena being the destination: since F7 the arena records nothing, so a
returning player has no row anywhere. The score half of that table took two attempts to be worth
reading, and both failures are the same kind — see "the probe was wrong twice" below.

### The decisions, and the shapes they were chosen against

**Identity: a 128-bit capability, minted per connection, carried on every seat assignment.**
`ReconnectRegistry.mint` is `randomBytes(16)` and nothing else — not a counter, not the
`playerId`, not a hash of a name and a tick, because each of those is guessable by somebody who
has watched a few connections. Three properties carry the whole of its security and each is a
line of code rather than a rule to remember:

1. **It cannot be guessed.** 128 bits of CSPRNG output, looked up by `Map.get` on the hex form —
   which is also what keeps the comparison free of a timing side channel without a constant-time
   routine somebody would forget to use.
2. **A live session's token opens nothing.** A reservation is created in `onLeave` and nowhere
   else, so while a player is connected there is no entry to match. A stolen token cannot evict
   somebody who is still playing, and that is a property of *when entries exist* rather than a
   check anybody has to write.
3. **It is good once.** `claim` deletes what it returns and the returning connection mints its
   own, so a token that has been redeemed — or observed and replayed later — matches nothing.

Never logged; log lines name the `playerId`, which is meaningless outside the process.

**Held for 30 s** (`RECONNECT_GRACE_MS`, in `shared/net/Protocol.ts` beside `CLIENT_TIMEOUT_MS`
because both ends reason about it — the server enforces it and the client is what tells the
player). Sized against what it is for: a page reload is two to five seconds and a wifi blip five
to twenty. A laptop lid is minutes and is deliberately not covered, because the cost of a longer
window is a seat reserved for somebody who has genuinely gone — a worse outcome for the eight
people still playing than a lost seat is for the one who left. It is longer than
`CLIENT_TIMEOUT_MS` on purpose: the grace starts when the server *notices*, and for an unclean
drop that is up to ten seconds after the fact.

**Only a lost connection is held, and only a seat in a `RUNNING` live match.** Both halves are
load-bearing:

- A `Bye` is the player saying they are done. `LeaveCause` carries that to `onLeave` the same way
  `UnseatCause` carries a departure to `unseat`, and for the same reason — *only the caller can
  tell the two apart*. Without it, quitting to the menu and pressing Play again inside thirty
  seconds would put you back in the match you had just left. The client states the same rule from
  its own side: `teardownWorld` drops the token unless a reconnect is the reason it is running.
- An **arena** seat is worth nothing to hold. Since F7 the arena records no score, holds no
  objective state and hands every arrival an instant seat, so a reservation for one would protect
  nothing. That is also what bounds the registry: it can hold at most as many entries as the live
  match has had players, and `forgetMatch` releases them at teardown.

**The body during the gap: the bot stays, and the return takes the seat rather than the body.**
Freezing or killing it would reintroduce exactly what `LiveMatch.releaseEntity` exists to prevent
— in Search & Destroy `anyAlive` decides the round, so the last human on a side dropping out ends
it for everybody, scored as an elimination nobody achieved. So the departure stays a real
departure to the simulation, and the return is a seat granted on the team they left, which
`LiveMatch.seat` already answers by taking a bot off that team (§6.7, §8.27). **One out, one in,
roster unchanged, with no "was this a reconnect" branch anywhere** — the existing rule about every
seat already says what F8 asks for about this one. Measured at 3H+7B=10 throughout every run.

The **team** is reserved as well as the entity id, and that is not symmetry:
`ServerMatch.addPlayer` balances arrivals onto the smaller side, so a returning player who was
merely re-seated could come back on the other one. In S&D that is a spawn inside the enemy half.

**The entity id is safe to hold, by construction.** `nextPlayerId` only ever increments and is
never decremented on removal, so an id handed out once is never handed out again inside that
instance. A held id cannot collide with a later joiner however long it is held.

**Score and progression: preserved, and preserving it costs nothing.** `ScoreSystem.register`
returns the existing row for an id it already holds, and the row survives `removePlayer` on
purpose — *"a leaver's kills already counted toward their team's score"*. So reclaiming the id
reclaims the row by construction rather than by copying anything, and the same line removes the
duplicate-row defect above.

**The killstreak wallet is *not* preserved, and that is the decision rather than an omission.**
`removePlayer` runs `StreakSystem.onOwnerRemoved`, which is `onDeath` plus `ledger.forget`. The
return is a **new life**: fresh spawn, zero balance, empty used-set. That is P4's model taken
literally — the balance belongs to a life, and the life they left was played out by the bot that
stood in for them. The alternative is a wallet surviving something that is not a death, which is
precisely what P5's `walletsAtLifeStart === walletsAtRoundBoundary` invariant exists to catch; it reads 0/0
in every run here.

**Failure: told, and seated anyway.** Grace expired, instance destroyed, match full or token
unknown — the player is seated as a new player and gets a `Notice` on the channel that already
reaches the HUD. Expiry is evaluated **at claim time** rather than by a sweeping timer, and that
is what makes *"your seat was held and ran out"* distinguishable from *"I have never seen this
token"*. They deserve different answers: the first is the failure F8 asks to be told about, the
second is an ordinary join where nothing was lost and there is nothing to say.

### The full resync was already there, and that is worth saying rather than assuming

The brief asks for *"a full resync on return — snapshot, mode state, the balance from P4, the
equipment from P5, the score"*. None of it is new code. `MatchInstance.seat` builds a fresh
`SnapshotEncoder` and zeroes both ack fields, so the next snapshot is a **full** one; the
objective, tag, bomb, streak and projectile channels are sent to every seat on every snapshot
tick; and `NetClient.onWelcome` resets prediction, reseeds the clock and clears interpolation. The
resync is a property of being seated, and the honest way to report that is to measure it rather
than to claim it — hence the resync times and the post-return divergence numbers below.

One thing there **was** wrong: `onWelcome`'s §4.18 discard ran only when the state was already
`'joined'`, on the reasoning that a fresh connection has nothing to clear. That is true of a fresh
*object* and false of a fresh *connection* — a reconnect re-dials on a `NetClient` that has been
through a whole match and arrives from `'disconnected'`. It is unconditional now. Every line of it
is provably a no-op on a genuinely fresh client (`remotes` empty, both snapshot ids 0, `localAlive`
true, `respawned` false, `ownSpawnSerial` -1 — each already its initialiser), so the condition
bought nothing and cost exactly the case it did not cover. The removals list cannot rescue it
either: a new encoder has no baseline and sends a **full** snapshot, which names who is present
and never who has gone.

### A pre-existing race under the new rule: a `Bye` that was thrown away

`LeaveCause` only means something if the `Bye` is read, and often it was not. `WsLink`'s `close`
handler cleared the receive queue, and `Session.receive` returned early on `closed` — which is
true when *either* the session or the **link** has gone. `ws` emits `message` and then `close` in
the same event-loop batch when a client sends a `Bye` and closes immediately after, which is what
a clean disconnect *is*, so unless the server's tick happened to land between the two the frame
was discarded and the departure was read as a pulled cable.

It has cost a ten-second timeout on a seat that could have been freed at once since M10, which is
invisible. Round 4 made it cost something visible. The fix is that the queue survives the socket
and `receive` gates on the *session's* state, so a `Bye` decoded in the same tick closes the
session as `'left'` before `checkTimeout` can close it as `'lost'`.

**Watched red, and it took four runs to catch it**, because it is a race rather than a rule:

| | Clean departures read as `client left` |
|---|---|
| Red control (both lines restored), 3 runs | **6 of 9** — one whole run reported 3 of 3 as `connection lost` |
| Green, 4 runs | **12 of 12** |

### Measured

Every number came out of a run in this session. **Protocol v11** — the seat body carries the token
out and `Hello` carries a claim back, both as trailing optional fields with an explicit presence
byte rather than "read if bytes remain", because a length inferred from what is left in a frame is
a length an attacker chooses.

**`npm run skirmish -- --drop-return 3 --drop-hold 3000`** — three clients, a real server, real
wire, shipped timings, one drop/return cycle each, held inside the grace.

| Probe | Red (before) | Green |
|---|---|---|
| Kept the seat | **0 of 3** | **3 of 3** — entity 1/2/3, same instance, same side |
| Kept the score | **0 of 3** (no row existed) | **3 of 3** — `e1 0k/1d`, `e2 0k/1d`, `e3 0k/3d`, unchanged across the gap |
| Resync, re-dial to first synchronised frame | 48 / 62 / 82 ms | **50 / 45 / 65 ms** |
| Divergence after a return | 0 / 17 779 | **0 / 11 874** |
| Registry: reserved / claimed / still held | — | **3 / 3 / 0** |
| The live match | **abandoned** | survived; roster 3H+7B=10 throughout |
| The run | **FLOW CHECK FAILED** twice | **PASSED** |

Both divergence figures are green, and the red one is green for a reason worth stating: a client
that came back as a *stranger* has nothing stale to disagree about. It is the return-to-the-same-
seat case that §4.18's discard list is actually about, which is why the samples are counted
separately from the run total.

**`npm run skirmish -- --drop-return 9 --drop-hold 1200`** — nine cycles, three per seat,
round-robin, so a seat that only survives when it is the *first* to drop cannot pass.

| | |
|---|---|
| Cycles / kept the seat / kept the score | **9 / 9 / 9** |
| Resync per cycle, ms | 76, 58, 82, 66, 94, 59, 34, 77, 75 |
| Divergence after return | **0 / 14 722** |
| Registry: reserved / claimed / expired / unknown / still held | **9 / 9 / 0 / 0 / 0** |
| Live roster | 3H + 7B = 10 |
| The run | **FLOW CHECK PASSED** |

**`npm run skirmish -- --drop-return 2 --drop-hold 35000`** — the failure branch, held five
seconds past the grace on purpose. The assertion **inverts** here, the same way a `--fault` run's
does: judged by the clean-run gate it would report a correct refusal as a failure.

| | |
|---|---|
| Got the seat back after the grace expired | **0 of 2** (must be 0) |
| Landed in the **running match** rather than the arena | **2 of 2** — this is join-in-progress |
| Were told | **2 of 2** — *"Your seat was given away — welcome back."* |
| Registry: reserved / claimed / expired / still held | **2 / 0 / 2 / 0** |
| The run | **FLOW CHECK PASSED** |

That run is where join-in-progress is measured, and the pairing is deliberate: *seat not kept* and
*joined the running match anyway* are two different questions, and before this session the answer
to the second was no either way.

**The rest of the gate.**

| Probe | Result |
|---|---|
| `npm run harness`, 5 matches, seeds 1-5 | Scores **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5/P9/P6 on the same seeds. Nothing here touches a bot-only match, so the regression control has to be exact and is |
| `npm run skirmish`, standing, no flags | **FLOW CHECK PASSED** — divergence 0/7369 per client, spectator 0 self / 0 enemy / 0 dead over 5599 picks, quick loadout 0 while alive over 9006 ticks, Tab 2689 of 5426 dead ticks, per-life stock 0 partial of 113, mispredictions into a live match **0** |
| `npm run leak`, 100 cycles | subscriptions **29 to 29 (+0)**, heap 12.89 to 13.58 MiB (+0.69). **LEAK CHECK PASSED**. The baseline is P6's 29 unchanged: the registry is a `Map` on `Server` and subscribes to nothing |
| `npm run netharness` at v11 | 2 clients, 30 s, **1800 ticks each, 0 snapshots lost, both still `joined`**, p99 0.43 m — the handshake accepts the bumped version at both ends, which is the half of a protocol bump that can silently reject everybody |
| `npm run check` and `npm run build` | boundaries (295 files), the cosmetic audit (19 snapshot fields) and the unlock audit all pass, and all three typecheck targets |

### One number moved, it was isolated, and it is **not** resolved

A standing run on this tree reported a misprediction p99 of **2.54 / 3.81 / 2.54 m** against a p50
of 0.082 / 0.123 — a fat tail with an unmoved centre. Isolated the way P1's stray misprediction
was, by stashing rather than by rebaselining, and this is every sample taken:

| Tree | p99 per client, one row per run |
|---|---|
| **This tree**, standing | 2.54 / 3.81 / 2.54 · 0.66 / 1.74 / 1.31 · 0.66 / 1.23 / 1.64 · 0.82 / 1.22 / 0.82 |
| **This tree**, `--drop-return` | 1.31 / 1.85 / 1.23 · 0.66 / 0.31 / 2.36 · 2.30 / 3.45 / 2.30 |
| **Clean tree**, standing | 0.82 / 1.35 / 0.90 · 0.90 / 1.46 / 0.74 · 0.80 / 1.23 / 0.82 |

Nine clean-tree samples all sit between 0.74 and 1.46; this tree produced two runs above 2.3 and
the rest inside that band. The two fat-tail runs were both **single** runs and two of the clean
triples were concurrent pairs, so the last clean run was taken single to remove that confound —
and it came back at 0.80 / 1.23 / 0.82.

**What is not in doubt:** the p50 is identical on both trees, `spawn window` is 0 in every run on
both, and §8.9's assertion — mispredictions in the 60 ticks after migrating into a live match — is
**0** in every run on both. The number that moved is the top one per cent of ordinary in-match
corrections, which on Foundry is a lift, a ledge or a spawn.

**And there is no mechanism.** The only change this session makes to a prediction path is the
discard in `NetClient.onWelcome` becoming unconditional, and a standing run takes exactly two
paths through it: a first join, where every field it writes already holds that value, and a
migration, where `rejoin` was already true and the old code ran the identical block. It is inert
in both. Nothing else this session touches runs between snapshots at all.

So: **unattributed rather than dismissed.** Two runs in six against zero in nine is not a
distribution anybody should conclude from, and a mechanism-free difference in a wall-clock-paced
harness is exactly what PLAN already documents moving ten per cent between runs of one tree — but
saying "noise" on this evidence would be the second half of a sentence the first half does not
support. It is on the next session's list, and the cheap way to settle it is a seeded run rather
than more samples of an unseeded one.

### The probe was wrong twice before it was right, and a third time after

Worth recording, because all three would have shipped as false greens and each is a different
species of the same mistake — a probe that cannot fail for the reason it claims.

1. **The drop waited six seconds after the match started.** That lands inside the **ten-second
   pre-match freeze**, where the movement axes are stripped and nobody has fired. Every cycle
   compared `0k/0d/0pt/0sh` against a missing row and declared the score lost: the right answer
   for the wrong reason, and one that would have gone green the day the row was reclaimed without
   ever having proved anything about a score.
2. **So it waited for `shotsFired > 0` instead.** This harness fields `strafe` and `runner`, and
   **neither pulls a trigger** — every shot in a flow run is fired by a bot. The gate never opened
   and no cycle ever ran, which the harness at least reported as *"no drop/return cycle
   completed"* rather than passing. It asks whether *any* counter on the row has moved now, rather
   than naming the one this harness happens to move; here that is `deaths`, and a death is exactly
   as much a part of the record a reconnect must preserve as a kill is.
3. **`seatAfterReturn` was a latch, and the probe waited on it.** Fine for one cycle and wrong for
   nine: left over from the previous cycle it is already non-null, so cycle two closed on the
   first frame it was looked at — before the socket had been re-opened — and reported cycle one's
   seat and cycle one's resync again. A nine-cycle run produced three genuine results and six
   copies of them, all green. Found by reading a report whose resync times repeated in threes.
   `dropForReconnect` clears it now.

The generalisation, since it is three for three: **a latch is the right shape for something that
happens once and the wrong shape for something that happens N times**, and a gate on "has this
seat earned anything" beats a gate on a clock every time, because the clock does not know what the
match was doing.

### What was not verified

**Every claim about the browser**, which is the whole client half of this session.
`HeadlessClient` drives `NetClient` and `Prediction` and builds no `ClientMatch`, no `Game` and no
DOM, and the preview pane never fires `requestAnimationFrame`. What the harness proves is the
*server's* answer — that a presented token gives the seat back, that the row survives, that the
returning client does not diverge — and every one of those is a rule rather than a picture.

Specifically unverified, each reasoned from the code:

- **That `Game.tryReconnect` fires at all.** The browser's disconnect path is `net.state ===
  'disconnected'` inside `simulate`, which no headless run reaches because `HeadlessClient` has no
  screen and no `Game`. The harness re-dials by calling `NetClient.connect` directly, which is the
  same code the browser reaches *through* `handshake` — but the decision to re-dial is
  browser-only.
- **That the world rebuilt from the returning `Welcome` is the right world.** A return after an
  expired grace can land on a different map from the one being torn down, and that is the case the
  M10 ordering fix exists for. It reuses `launchMatch` precisely so there is no second copy of that
  ordering, but reuse is an argument, not a run.
- **The `RECONNECTING…` screen, and the notices.** Both go through surfaces the harness cannot
  see.
- **A page reload.** The token is held in memory only, so a reload loses it and the player returns
  as somebody new. `sessionStorage` would cover it and would leave a live seat capability where
  any script on the origin can read it; that is a trade for the human to make rather than a
  default, and it is on the list below.

### Needs a browser

- **F8, the report itself.** Join a networked match, play until you have a kill or two, then kill
  the connection (dev tools' offline toggle, or pull the wifi). The screen must say
  `RECONNECTING…` rather than dropping you to the menu, and within a couple of seconds you must be
  **back in the same match**, on the same side, with your kills still on the board. Check the
  scoreboard specifically: there must be exactly one row with your name on it.
- **The grace expiring.** Same thing, but stay offline for more than thirty seconds. You must be
  told *"Your seat was given away — welcome back."* and land **in the running match** as a new
  player — not in the arena. This is the half that is easiest to get wrong silently.
- **Join-in-progress from cold.** With a match already running, press Play Multiplayer from a
  fresh tab. You must land in the match, not the arena, and the loading screen must build the
  *match's* map. Then check the frame cost of that first build: a direct join has no background
  build behind it and is the one path that builds a map on the critical path.
- **Quitting is not a disconnect.** Finish or leave a match with "Exit to main menu", then press
  Play Multiplayer again inside thirty seconds. You must **not** be put back in the match you just
  left; you should get an ordinary seat.
- **The bot handover, seen rather than counted.** Drop out and watch what the other players see: a
  bot takes your place and your body does not simply vanish or freeze. On your return the roster
  must still read ten.
- **Search & Destroy, which is the mode where the team matters.** Drop as an attacker mid-round
  and come back. You must return on the attacking side, and — because §6.7 blocks a mid-round join
  in a one-life mode — with no body until the next round starts. Confirm you are not spawned into
  the defenders' half.
- **The pause screen and the summary, unchanged.** Both were fixed in B4 and both now sit behind a
  reconnect that did not exist then; confirm a fifteen-second pause and a full post-match hold
  still keep the connection rather than triggering a reconnect.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **A returning player used to appear twice on the end-of-match board**, once as themselves with
  nothing and once as a bot holding their kills. Nobody reported it because nobody could get back
  into a match to see it. It is fixed by the same line that gives the seat back — `register`
  returns the existing row — but the *mechanism* is worth writing down on its own:
  `LiveMatch.buildSummary` derives `isBot` from "no session sits on this entity", which is the
  right derivation and silently mislabels anybody whose session went away. Any future feature that
  can leave a row seatless inherits it.
- **`NetClient.reconnectToken` is the second piece of client state that must outlive the world**,
  after round 4's `debugRequest`. Both are on `Game` for the same reason and by the same argument
  — the surface is thrown away and the fact is not — and it is now a pattern rather than a
  one-off. The next one should go beside them.
- **The reconnect grace and the summary hold do not interact today only because a `Bye` is sent
  on the way out of the summary.** A player who drops *during* the post-match hold has their seat
  reserved in a match that is about to be destroyed, and `forgetMatch` releases it at teardown —
  correct, and it means their reconnect lands in the arena with *"That match has finished"*.
  Worth knowing before anybody lengthens `SUMMARY_HOLD_SECONDS` or shortens `RECONNECT_GRACE_MS`.
- **Nothing in the project measures a reconnect under adverse conditions.** Every number above is
  loopback with `--net none`. `--net bad` layers 100 ms +/- 30 ms and 2% loss and would exercise
  the one thing this design leans on hardest — that the returning client's first full snapshot
  arrives — but HARD RULE 9 puts that class of claim against a deployed server rather than
  loopback, so it belongs with the §7 battery rather than here.

## Playtest round 4 — cheat codes, and the two authorities one store had to have

Covers **F14** — `DEBUG666`, `SPEC[]1` to `SPEC[]4`, `MO951357`, and taking the debug overlay out
of the ordinary options. Six codes in the report; one mechanism underneath them, and the shape of
it is the only interesting decision in the session.

### A code is input, an entitlement is state, and the partition is the security argument

The naive build is six booleans written by six keypress handlers. Every effect then has to ask
*"was the code typed"*, the server has no way to be the source of truth about any of it, and
turning the whole thing off is six edits. So there is **one store** — a mask of entitlements in
`shared/cheats/Cheats.ts` — a code is parsed into it exactly once, and every effect downstream
reads the mask and nothing else.

What made that more than tidiness is that the six codes do not have one authority. Four of them
change what the **simulation** says:

| Code | Entitlement | The line that reads it |
|---|---|---|
| `SPEC[]1` | god | `DamageSystem.apply`, at the `invulnerable` gate |
| `SPEC[]2` | unseen | `Combatant.participating` — `Perception`, `SpawnSelector`, `SearchAndDestroy.anyAlive` |
| `SPEC[]3` | noclip | `PlayerController.step` |
| `SPEC[]4` | all three | the set |
| `MO951357` | +30 kills | `StreakLedger.credit`, through `StreakSystem.creditKills` |

Against a dedicated server a client granting itself any of those is not a cheat code, it is an
exploit — it either does nothing, because the server keeps killing you, or it works and is a hole.
So those bits are `CHEAT_SIMULATION`, the **server is their only author**, and a client's copy is
replicated state it reads and never writes. `NetClient` masks the incoming byte with
`CHEAT_SIMULATION` on arrival, so the partition is enforced where the untrusted bytes land rather
than remembered at each reader.

`DEBUG666` is the other half. It decides a client surface and says nothing about the simulation, so
its bit is `CHEAT_LOCAL` and the client authors it for itself. That is not a convenience:

- in single-player there is no server to ask, and the QA spectator has worked exactly this way
  since M8;
- against a **deployed** server, gating it would make the debug overlay unreachable — which is
  precisely where every "needs a browser" list in this file sends somebody to read the NetPanel,
  the divergence panel and the build report.

The two masks are disjoint and every bit is in exactly one of them, which is what lets
`Game.cheatMask` be one expression instead of a rule somebody has to remember:

```
(localCheats & CHEAT_LOCAL) | ((net?.cheatMask ?? localCheats) & CHEAT_SIMULATION)
```

Connected, the simulation half is the server's answer and anything this process granted itself
offline is ignored — so cheating offline and then joining a server cleans up after itself.

### The input is a text field, and a key-sequence detector could not have worked

The brief left this open and asked for a decision. A key sequence is dead on arrival here:
`DEBUG666` shares D, E, B, U and G with movement and Use, so typing it in a match walks, uses and
reloads; and `SPEC[]n`'s brackets are not keystrokes at all on a keyboard that does not have them.

So the input is a **text field on the pause screen**, and the player types the literal code —
brackets included, case-insensitive. That home is not a compromise, it is the one place that
satisfies both standing input rules *by construction* rather than by a check somebody has to
write:

- **"a hidden surface never consumes a key"** (round 3) — the field is on one screen and only
  receives keys while it has focus. `Input.bindingsActive` is already false outside `MATCH`, and
  `Input.domFocusGuard` already stops the game seeing a key while a form control has focus, so
  nothing is taken from anybody. It is a `<form>`, so Enter submits as a form event and never
  reaches `Input` at all.
- **it is where the cursor is.** The pause screen is the only screen inside a match with a
  released pointer, which is the same reason M5 put the debug button there.

`PauseMenu.hide()` blurs the field beside the resume button, and that is the sharper of the two:
a text input that kept focus into a live match would eat W, A, S and D.

### DEBUG666 gates the button rather than deleting it, and the × is why

F14 asks for the overlay to leave the ordinary options. Two readings, and the obvious one is
wrong. Deleting `PauseMenu`'s button outright leaves the code as the only way in — and B1's
tri-state means the × and Escape close the panel *without* revoking the entitlement, so the code
would have to be retyped after every close and the × would have become exactly the one-way door
P7 asks to confirm it has not become.

So the button is **gated**: it exists only for a session that has typed `DEBUG666`. An ordinary
player never sees it, which is what "removed from the ordinary options" means, and every
documented B1 behaviour survives untouched.

That makes the entitlement and `debugRequest` two facts rather than one, and both are load-bearing
— *may they* and *do they want it, and from where*. The entitlement is read by the **predicate**,
not just by the route, because the code is a toggle: clearing it while the panel is up has to take
the panel down, and a gate that only guards the door cannot do that. `debugUnlocked` is that
reader, and `Game.updateHudSurfaces` sets the button's presence from it every frame — idempotent,
so it appears on the frame the code is typed with nobody having to remember to refresh it.

**That reasoning is wrong and the bit is gone; see "one fact in two places, twice" below.** Every
writer of the bit also wrote the request, so the two were always equal — except at the × , which
wrote only the request. The panel then sat closed with the bit still saying "unlocked", and typing
the code read as a revoke. It is round four's own B1, whose description is *"two copies of 'is the
debug overlay open', and the × wrote one of them"*, reintroduced by the session that quoted it.
`debugUnlocked` is `debugRequest !== 'none'` now.

### The wire (protocol v12), and why the mask is not carried by the reply alone

`MsgC.Cheat` carries the **text** a player typed, not a parsed code id. The decision and the log
line are then the server's: *"OP1 typed SPEC[]1 and this server has cheats off"* is a sentence
somebody can act on. `MsgS.Cheats` carries the **outcome** and the mask.

The outcome is the half that cannot be inferred, and it is what F14's *"if the server refuses, the
client says so"* actually needs: a refusal and a revoke both leave the mask without the bit, and a
player who cannot tell those apart retypes the code and reports it twice. It goes to the pause
screen's own line rather than through `voteOverlay.notice`, and that is not a preference — the
vote overlay sits under `.op-screen`'s near-opaque backdrop, so a notice raised while the player
is looking at the field they typed into would be painted over by the screen answering them.

**The entitlement mask also rides the owner block of every snapshot**, and that is the decision
worth recording. A reply-only mask is an **edge**, and an edge can be dropped: under `--net bad`
one lost frame would leave the client holding the wrong answer for the rest of the match. Two of
the three simulation entitlements are invisible to a client with the wrong answer; the third,
noclip, is a *permanent misprediction* — the server flying a body the client keeps in collision.
Replicated as state, once per snapshot, there is nothing to lose. It is P5's lesson about the
spawn serial met from a new direction: *a serial is still true on the tenth snapshot after the
spawn.* One byte per client per snapshot, written after the optional state and unconditionally, so
a player who switches free cam on while dead — when there is no owner block at all — is still
told.

It is discarded in `NetClient.onWelcome`, with the rest of §4.18's list. A migration keeps the
grants (they live on the `Session`) so the next snapshot re-states them; a **reconnect** is a new
connection with an empty store, and keeping the old bits would leave that client flying through
walls the server had put back. Discarding is right in both cases, which is what makes it belong in
the list rather than beside a test for which one happened.

### Where the grants live, and the one door every seat comes through

On the **`Session`**, beside `loadout` and `reconnectToken` and for the same reason: it is a fact
about the connection, and a `NetPlayer` is thrown away and rebuilt by every migration. A grant on
the seat would be lost the moment the player was moved from the arena into the match they typed
the code to look at.

**That last sentence was the bug, and the session below is the correction.** Losing the grant at
the migration is exactly right: an entitlement is granted against the entity whose `invulnerable`
and `participating` read it, and the migration destroys that entity. Held for the life of the
connection, a code typed in the arena — where god mode does nothing, because F7 spares every
combatant there — took effect in the match the ballot sent the player to. The store still lives on
the session; its **lifetime is the seat**, and `MatchInstance.unseat` clears it. Measured at 37 028
ticks of leaked entitlement and 313 refused hits before the fix.

`NetPlayerDeps.cheats` is **required**, not a field assigned afterwards, and that is the whole
safety argument: the type system asks the question at every construction site instead of leaving a
mutable field somebody has to remember. `MatchInstance.seat` is the single caller and it has the
session. Bots get `NO_CHEATS`, a frozen shared instance.

Every effect is then **derived**, never latched:

| Effect | Where | Why a getter and not a field |
|---|---|---|
| god | `NetPlayer.invulnerable` | nothing to re-apply; there was no previous writer at all (see below) |
| unseen | `NetPlayer.participating` | `spawn` sets `active = true`, so a field would be undone by the next life |
| noclip | `NetPlayer.step`, `Match.syncChopperBody` | `PlayerController.spawn` does **not** clear `noclip`, so a latch would survive a revoke into the next life |

The client's `godMode` and `hiddenFromBots` were two fields written by `debug/Spectator.ts`; they
are getters over the mask now, because a field beside the entitlement is a second copy of it — and
over a network a copy the client had written for itself while the server disagreed. `Spectator`
keeps the *toggle* and has no state of its own left.

**The cost, stated rather than glossed.** Free cam has a window of up to one snapshot interval —
50 ms at 20 Hz — between the server honouring the code and the client learning of it, during which
the two disagree about collision and prediction corrects. It happens on a toggle and nowhere else.
The alternative was bumping the spawn serial to make it a clean discontinuity, which would tell
P5's per-life reset that a new life had begun: a worse lie than a 50 ms correction.

### MO951357 was the test P7 said it would be, and P4's separation held

The brief said that if P4 had derived the balance from `PlayerScore.kills`, this code could not be
implemented cleanly — and that hitting that was the signal the separation there was wrong. It is
not wrong. P4 built `credit` as a **second door** for exactly this reason and said so at the time:
the balance is *credited from* the score rather than read out of it, so `foldKills` keeps the score
as the arbiter of what counts and unearned kills never appear in a match result.

`StreakSystem.creditKills` — private until now, and already applying the aliveness rule every
other unearned credit does — is that door made public. It is the third caller and the one it was
named for. No compensating deduction anywhere, and measured: **30 credited, 0 added to any
scoreboard row.**

### Two reversals, and both are about a measurement

**`SPEC[]2` no longer implies god mode.** `Spectator.setInvisible` has turned god mode on with it
since M8, with a good reason — a grenade already in the air does not know nobody is aiming at you,
and dying mid-observation drops you into a respawn timer. That reason is now served by `SPEC[]4`.
Coupled, the two entitlements were **indistinguishable**: an effect asking *"am I unseen"* would
have been answering *"am I unseen, or was god switched on beside it"*, and no probe could tell
perception from invulnerability — which is exactly what F14's verification has to do. An
entitlement that means two things is not an entitlement. `SpectatorPanel`'s help text is corrected
and its "toggle full" button now calls the same `toggleCheat` the code does, so the two cannot
disagree about what "full" means.

**Invisible means nothing looks for you; it does not delete your body.** The mesh stays in
everybody's snapshot. Removing an entity to hide a player is the mistake this milestone already
recorded about Ghost — *"removing the entity makes the body invisible, which is not what Ghost
does"* — and here it would additionally desync who can be shot from what the server resolves
rounds against. Measured below, and the measurement is the honest version of the claim: one hit in
a match where the control took twenty-six.

### The audit found the defect in its own session's code

`scripts/check-cheats.mjs`, wired into `npm run check`, tests the two things that would make the
design's own sentence false, and both are silent:

1. **No code string appears outside the table.** The failure that happens is not a second
   entitlement store, it is one `if (code === 'SPEC[]1')` written downstream in a hurry — at which
   point the server has stopped being the authority for whatever that line decides.
2. **Every bit is in exactly one half of the partition.** A bit in both would let a client author
   a simulation entitlement. A bit in neither could never be granted at all — the quieter failure,
   and the one a playtest reports as "the code does nothing".

It failed on its first real run, on this session's own code: `debug/Spectator.ts` named four codes
as literals to request them. That is precisely the shape rule 1 exists to catch, and the fix is
the better design — `SpectatorDeps.request` takes entitlement **bits** now, resolved to a code
through `cheatCodeToggling` against the same table, so there is still exactly one input to the
feature and still nothing downstream that can grant an entitlement without asking the authority.

Watched red three ways:

| Red control | What it said |
|---|---|
| `Cheat.God` added to `CHEAT_LOCAL` | *is in both CHEAT_SIMULATION and CHEAT_LOCAL … the bit is an exploit* |
| `Cheat.Wallet` removed from `CHEAT_SIMULATION` | *is in neither … so nothing can ever grant it* |
| an `=== 'SPEC[]1'` test added to `ClientMatch.godMode` | *names the cheat code SPEC[]1 as a literal* |

### Making it visible, because otherwise the next report cannot be attributed

A bug report from a player who had god mode on is indistinguishable from one from a player who did
not, and by the time anybody asks the match is over. So:

- **A HUD tag**, `CHEATS · GOD · UNSEEN · …`, bottom centre. `cheatTag` is a rule in
  `shared/ui/HudSurfaces.ts` with one writer in the per-frame pass — a row in round four's surface
  table rather than a new kind of thing — and it hides through a `--on` class rather than the
  `hidden` attribute, which is B13's lesson applied on the way in instead of after somebody
  reported it.
- **`Cheat.Wallet`**, an entitlement with no effect whose only job is that a wallet grant leaves a
  trace. Thirty free kills otherwise looks exactly like a good match. **Reversed in the session
  below**: a payment is a transaction and not a state, this file's own `CheatEffect` comment said
  so, and the bit outlived the ledger row it described. An instant cheat is announced for a
  display duration now and holds no bit at all.
- **`Cheat.Debug` is deliberately not on the tag.** Having the overlay unlocked says nothing about
  the simulation, and a warning that is up for most of a developer's session stops being one.
- **The server log**, at `warn`, on every grant, revoke and refusal, naming the player and the
  resulting entitlements; and `CHEAT CODES ENABLED` in the boot line, in the same shape as
  `FAULT INJECTION ON`.

### The HUD surface table, extended

One row, and the last two columns are where the failures live:

| Surface | Single writer | Derived from | Consumes from input | Hides by |
|---|---|---|---|---|
| Cheat tag | `Game.updateHudSurfaces` → `Match.setCheatTag` | `cheatTag` — the replicated mask, the instant caption's deadline, and the screen | nothing | `.hud-cheat--on` class |

The pause screen's debug button is driven from the same pass (`setDebugAvailable`) and is not a HUD
surface, but it obeys the same rule for the same reason: it is a presence decided per frame from
state that outlives it, so there is no moment at which somebody has to remember to refresh it.

### Measured

Every number below came out of a run in this session. **Protocol v12** — `MsgC.Cheat`,
`MsgS.Cheats`, and one byte on the snapshot's owner block.

**The refusal, which is the default and therefore the thing that matters most.**
`npm run skirmish -- --cheats` — three clients, a real server, a real wire, shipped timings, the
config flag left at its shipped **off**. One code each: `SPEC[]1`, `SPEC[]2`, `MO951357`.

| Probe | Red control (flag off) | Green (`--cheats-on`) |
|---|---|---|
| Codes typed / answered | **3 / 3** | 3 / 3 |
| Refused with *"cheats are disabled"* | **3 of 3** | 0 |
| Granted | **0** | **3 of 3** |
| Clients holding a non-zero entitlement | **0** | 3 — masks `god`, `unseen`, `wallet` |
| Hits refused at the server's damage door | **0** | **239** |
| The run | FLOW CHECK PASSED | FLOW CHECK PASSED |

Both halves block. A run in which no client reached a live match to type anything fails as *"no
client ever reached a live match to type a code"* rather than passing — the same shape as the
divergence checker's `hashSamples === 0` branch, and for the reason this milestone has now shipped
four probes that could not go red.

**The four seats, in one run, and the fourth is the control.**
`npm run skirmish -- --cheats --cheats-on --clients 4`, and the assignment is the whole design of
the probe: one cheat per client and one client with none, so the cheated and un-cheated numbers
come out of the same fight, on the same map, against the same bots.

| Client | Code | Mask | Live health floor | Hits taken (after the grant) | Deaths |
|---|---|---|---|---|---|
| OP1 | `SPEC[]1` | god | **100** | **0** (0) | **0** |
| OP2 | `SPEC[]2` | unseen | 49 | **1** (1) | **0** |
| OP3 | `MO951357` | wallet | 0 | 6 (6) | 1 |
| OP4 | — | none | 0 | **26** (0) | **6** |

Read the god row against the door count and not on its own: god mode returns **before** the damage
event, so from a client both the health and the hit count are absences, and a run where nobody
engaged reports the same pair. The server refused **239 hits** at the `invulnerable` gate in that
match. That is the claim *"god mode genuinely survives a damage tick on the server"*, measured on
the server, at the line that decides it.

And it is what tells the two cheats apart. The invisible client's zero is **not** the door's: 239
refusals are all attributable to OP1, and OP2's single hit went through the arithmetic normally.
One hit against the control's twenty-six is a **96% reduction**, with no deaths against six.

**The residual hit is real and is the honest form of the claim.** `liveHitsWhileCheated` was added
after the first green run reported three hits with no way to say when they landed — the count is
split at the moment the mask arrives now, so a hit taken in the seconds before the answer came back
cannot be mistaken for perception failing. The one hit landed *after* the grant, and that is
correct behaviour rather than a leak: invisibility removes the body from perception, target
selection and spawn scoring, and a bot firing at somebody else can still put a round through a body
standing in the line, exactly as a grenade can still catch it. Nothing looks for you; rounds do not
pass through you. That distinction is why `SPEC[]4` exists and why the two entitlements had to stop
implying one another.

**`MO951357`, against the scoreboard.** Same run: **70 kills banked and 30 credited**, spent 4,
peak balance 30, one activation, most streaks bought in any one life **1**, life-starts inheriting
a balance **0**. The thirty kills bought a streak and moved no scoreboard row — the separation P4
built, exercised by the code P7 said would test it.

**The standing run, which is the control for everything else.** `npm run skirmish`, three headless
clients, shipped timings, no flags. Nothing in this session may move any of it, and nothing did:

| Probe | Result |
|---|---|
| The run | **FLOW CHECK PASSED** |
| Divergence checker | **0 / 7372** per client |
| Mispredictions entering a live match | **0** (§8.9 requires 0); to the arena 0; spawn window 0 |
| Migrations / live roster | 3 of 3, 0 failed; **3H + 7B = 10** |
| Spectator invariants | 5742 selections while dead, **0 self / 0 enemy / 0 dead** |
| Quick loadout window | 9006 ticks over 26 windows, **0 while alive** |
| Tab surviving `neutralise` while dead | 2694 of 5425 dead ticks; board open 2694 |
| Per-life grenade stock | 114 life-starts (23 human, 91 bot), **0 partial / 0 empty**, 274 held against 274 expected |
| Arena (F7) | score rows **0**, health floor **100** over 89 hits taken, **0** deaths |
| Arena (F12) | caption up 10 823 ticks in the room, **0** ticks of `WAITING` in a live match |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |

**`npm run harness` — 5 matches, seeds 1-5, TDM on Foundry.** The regression control, and this
session is one where it has to be exact: nothing here touches a bot-only match, because a bot has
no session and therefore no entitlement.

| | |
|---|---|
| Scores | **75-59, 75-66, 62-75, 75-66, 60-75** — byte-identical to P5, P9, P6 and P8 on the same seeds |
| Life-starts with partial grenade stock | **0** across all five; observed stock equals expected in every match |
| Streak life-starts inheriting a balance / round carry-overs | **0 / 0** |
| Negative balances / kill-anchor resyncs | **0 / 0** |
| Kills credited (must be 0 — no cheat runs here) | **0** in all five |

**`npm run netharness` at v12.** Two clients, 30 s, against a real `serve.js`: **1800 ticks each,
0 snapshots lost, both still `joined`.** That is the half of a protocol bump that can silently
reject everybody, and it is the half that matters most for v12 because the bump changed the
snapshot's own layout rather than only adding a message.

**`npm run leak` — 100 cycles.** Subscriptions **29 → 29 (+0)**, heap 12.97 → 13.65 MiB (+0.68).
**LEAK CHECK PASSED.** The baseline is P8's 29 unchanged, which is the number to watch here: F14
adds a `CheatState` per session and subscribes to nothing.

**`npm run check` and `npm run build`** green — boundaries (296 files), the cosmetic audit (19
snapshot fields, unchanged), the unlock audit and the **cheat audit** (6 codes, 5 entitlement bits,
partition disjoint and complete) all pass, and all three typecheck targets.

Unchanged and expected: `post-match hold: NOT EXERCISED` at shipped timings, for the reason the B4
session recorded.

### The p99 misprediction tail: the recommended experiment could not have settled it

P8 left this open — a fat tail with an unmoved centre, isolated but unattributed, with the next
step recorded as *"the cheap way to settle it is a seeded run rather than more samples of an
unseeded one."*

**That recommendation rested on a wrong premise, and finding out cost one grep.** Every seed in
this harness is *already* fixed: `skirmishHarness` gives client *i* the seed `1000 + i * 37`, which
also seeds its link's condition simulator, and the server's bot seed comes from `SEED` with a
default of 1. There is no unseeded input anywhere in a standing run. So a seeded run is not a new
experiment — it is the experiment that has been running all along, and pinning `SEED` explicitly
cannot remove a variance that was never RNG.

Run anyway, because a control on the record is worth more than an argument. `SEED=7 npm run
skirmish`, three runs on this tree and three on a stashed clean tree, p99 per client:

| Tree | p99 per client, one row per run |
|---|---|
| **This tree**, `SEED=7` | 0.164 / 0.264 / 0.164 · 0.149 / 0.362 / 0.164 · 0.159 / 0.299 / 0.165 |
| **Clean tree**, `SEED=7` | 0.164 / 0.251 / 0.164 · 0.164 / 0.238 / 0.164 · 0.164 / 0.278 / 0.164 |
| This tree, standing (`SEED=1`) | 0.164 / 0.360 / 0.164 |

Three things fall out of that, and the third is the one worth having.

1. **The two trees are indistinguishable.** Every sample on both sits in 0.149-0.362, and clients
   1 and 3 return 0.164 to three decimal places in five runs out of six. Whatever P8 saw, it is
   not this tree.
2. **The seed is not a variable.** The standing run at the default `SEED=1` lands inside the
   `SEED=7` band, which is what the grep predicted: pinning a seed that was already pinned changes
   nothing.
3. **P8's numbers do not reproduce at all**, on either tree. P8 recorded nine clean-tree samples
   between 0.74 and 1.46 with two runs above 2.3; today's twenty-one samples across two trees have
   a maximum of 0.362. The level itself moved by a factor of four between sessions on the same
   machine, and no code explains that, because half of these runs *are* P8's own tree.

The conclusion is the one the seeds already implied: **the variance is temporal, not
stochastic.** This harness is driven by wall-clock timers against a real event loop, so what
differs between two runs of one tree with every seed pinned is *when* each client's update landed
relative to each server tick — which decides how many commands were in flight, how deep a replay
went and therefore what the worst one per cent of corrections looked like.

What is not in doubt, and is unchanged from P8: the p50 is the same on both trees, `spawn window`
is 0 in every run on both, and §8.9's assertion — mispredictions in the 60 ticks after migrating
into a live match — is **0** in every run on both.

**So it is attributed now, and the attribution is "the instrument".** The next lever is a stepped
clock rather than more samples: `installClock` is already the seam both runtimes take their time
through, and a harness that advanced it deterministically instead of sleeping on it would make this
number reproducible. That is a change to the instrument rather than to the game, it is not this
session's item, and it is the honest place to leave it — P8's "unattributed rather than dismissed"
can now say what it is attributed to.

### What was not verified

**Every claim about a screen, which is the whole client half of this session.**
`HeadlessClient` drives `NetClient` and `Prediction` and builds no `ClientMatch`, no `Game` and no
DOM, and the preview pane never fires `requestAnimationFrame`. What the harness proves is the
*server's* answer — that the flag refuses, that a granted entitlement reaches the simulation, that
the mask crosses the wire — and every one of those is a rule rather than a picture.

Specifically unverified, each reasoned from the code:

- **That the pause screen's field works at all.** It is a `<form>` whose submit never reaches
  `Input`, and `domFocusGuard` is what stops the game seeing the keys — both true of the code and
  neither observed.
- **That the debug button appears and disappears with the entitlement.** The predicate is
  measured; the button is a DOM node.
- **That the HUD tag is legible and in the right place.** `cheatTag` is a pure function and is run
  by the harness; whether it reads at the bottom of a screen is pixels. It is also the one surface
  in this session that no headless run puts a non-zero value into, because the harness never grants
  itself the debug bit and never renders.
- **The free-cam window.** One snapshot interval is arithmetic; whether it *feels* like a lurch
  when free cam is switched on mid-match is not a number.
- **`MO951357` in single-player**, which takes the local branch of `requestCheat` and reaches
  `ClientMatch.streaks` directly. The networked path is measured; the offline one compiles.

### Needs a browser

- **The refusal, and it is the one to check first.** Against a server without `CHEATS_ENABLED`,
  pause and type `SPEC[]1`. The line under the field must read *"This server has cheats
  disabled."* — not nothing, and not "code accepted". Then type `QWERTY`: it must read *"Unknown
  code."*, with no round trip.
- **`DEBUG666`.** Pause, type it. The overlay must come up **and** a "Debug overlay" button must
  appear on the pause screen. Click the × — the panel closes and the button stays. Press the
  button — it comes back. Type `DEBUG666` again: the panel goes and the button goes with it.
  Then the whole of B1's sequence again on top of it, because this session put a gate in front of
  that predicate: resume with the overlay up (it follows you in), pause (it goes off screen),
  resume (it comes back), Escape with it open in a match (it closes and you are **not** dropped
  onto the pause screen).
- **`SPEC[]1`, with cheats on.** Stand in the open in a live match and get shot. The health bar
  must not move, and — the part that distinguishes this from the arena's rule — you must see **no**
  hit feedback at all: no vignette, no chevron, no flinch. The tag must read `CHEATS · GOD`.
- **`SPEC[]2`.** Stand in front of a bot that is looking at you. It must lose interest and walk
  off. You are still shootable: expect to take the occasional round from a firefight you are
  standing in, and expect a grenade to hurt you. That is the design, not a leak.
- **`SPEC[]3`.** Fly. Then turn it off in mid-air and confirm you fall from where you were rather
  than being teleported back. Watch for a single correction at the moment of each toggle — one
  snapshot interval of disagreement about collision is expected and anything longer is not.
- **`SPEC[]4`, and moving between the modes**, which is what F14 asks for by name: `SPEC[]4` on,
  then `SPEC[]1` (god goes off and the other two stay), then `SPEC[]4` again (it completes the set
  rather than clearing it), then `SPEC[]4` once more (now it clears everything). The tag must
  track all of it.
- **`MO951357`.** Type it in a live match. The streak strip must go affordable, the balance must
  jump by 30, and — the half that matters — **the scoreboard must not move**. Press a streak key:
  it must fire and the balance must drop by its price. The tag must read `CHEATS · WALLET`.
- **Single-player.** Every code except the refusal, offline: `SPEC[]n` and `MO951357` must all work
  with no server involved, because this process is the authority there.
- **The QA spectator panel.** Open it against a server with cheats **off** and tick "God mode":
  the box must spring back. With cheats on it must stick, and the console's
  `__operator.spectate.state()` must agree with the panel.
- **Search & Destroy, invisible.** Confirm the round counts you as eliminated — it should, you are
  spectating — and that this is now true over the network as well as offline.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **`Damageable.invulnerable` had no server-side writer at all before this session**, and that is
  a real defect with a familiar shape. `ClientMatch.syncChopperBody` takes a Chopper Gunner's
  abandoned body out of play with `active` and `invulnerable`; `ServerMatch` does neither, and
  `NetPlayer` did not so much as declare the field. So over the network a gunner's body is
  invulnerable in its **own client's** opinion — which is not authoritative for anybody else's
  shots — and fully killable on the server, where the bots can also still see it. M7's *"the
  player body is out of play"* is a single-player claim that never crossed to the server. It is the
  standing authority-migration failure again, it is a different mechanism from F14 (a rule that did
  not migrate, not an entitlement), nobody reported it, and it is left. It is now at least
  *observable*: `blockedByInvulnerable` counts what the door refuses, and in a match with no cheats
  it should be zero — it is, in every run above.
- **The cosmetic audit does not cover the snapshot's owner block.** `check-cosmetics.mjs` pins
  `EntitySnapshot` and nothing else, so this session added a field to the owner block without the
  audit having an opinion. The field is §4.15 gameplay state by any reading — it decides
  invulnerability and collision — so nothing was smuggled past anything; but the gap is worth
  knowing before somebody puts a cosmetic there. The owner block is `PlayerSimState` plus one byte,
  and extending the audit to it is a ten-line change nobody has needed until now.
- **`npm run netharness` needs a server and does not start one.** It exits with
  `ECONNREFUSED 127.0.0.1:8080` in an empty environment, which is what a first run of it looks
  like: `npm run serve` has to be up first. Every previous session's netharness number was taken
  that way; nothing in `package.json` says so. Recorded rather than fixed, because the fix is a
  decision about whether the harness owns a server process.
- **`Session.cheats` is the third piece of connection state that must outlive the seat**, after
  `loadout` and `reconnectToken`. F8 noted that pattern forming on the client (`debugRequest`,
  `NetClient.reconnectToken`, both on `Game`); this is the server's side of the same shape, and the
  next one belongs beside these.

## Playtest round 4 — a difficulty table nothing could reach, and a mode that never said what it was for

F1 and F10, and they have nothing in common except the session. F1 is the shape rule 4 keeps
naming — one fact with three copies, of which one was dead and one consulted neither of the
others — and F10 is not a defect at all: it is something that was never built, so the interesting
part is where it was put rather than what was wrong with it.

### F1 — the system was finished at M3 and had no way in

`shared/ai/DifficultyTiers.ts` has held four tiers since M3: reaction time, aim cone, convergence
rate, turn rate, burst discipline, push aggression, peek rate, flank chance and, from M5, grenade
use. `BotArsenal` treats the weapon as a fifth lever. `BotDirector.populate` deals from whatever
list it is handed. Every part of a difficulty system was already there and measured.

**Nothing upstream of `populate` was ever a variable.** The server's one allocation site said
`botFill: { count: 10, tier: 'MIX' }` as a literal, the arena said `tier: 'MIX'` as a literal, and
the client read `this.deps.map.tierMix` directly. So this session built no difficulty system. It
deleted three literals and put one value where they had been.

There were **three** copies of the fact and they were in three different states:

| Where | State |
|---|---|
| `MatchRequest.botFill.tier` | Read. `InProcessMatchAllocator.allocate` passes it to `LiveMatch` |
| `InProcessAllocatorOptions.botTier` | **Never read by anything.** Declared, set to `'MIX'` at its one call site, and dead since the day it was written |
| `ServerMatch.replacePlayerWithBot` | Read `mapEntry.tierMix` directly, ignoring `options.tier` entirely |

The second is the familiar one: a knob that looks wired, is not, and reads as configuration to
anybody who greps for it. Deleted rather than made authoritative — a difficulty is a property of
the match being requested rather than of the allocator being asked, and the request already
carried it.

**The third is a real defect, and it was latent rather than harmless.** A player who leaves a
running match has their seat handed to a fresh bot, and that bot was dealt from the map's authored
spread whatever the match was configured for. It could not be observed before this session because
the configured value was always `'MIX'`, and the two expressions agree exactly then — which is how
a bypass survives: it is only wrong once somebody makes the thing it bypasses mean something. It
would have been the first report `BOT_DIFFICULTY=RECRUIT` produced, and the report would have read
*"the bots are inconsistent"*, which is unattributable. The replacement log line names the tier
now, for that reason and no other.

`tiersFor(difficulty, authoredMix)` is the one place a choice becomes a list. It is a function
rather than an expression written twice because three call sites read it — the server's
`populate`, the client's `populateDefault`, and the replacement above — and `ServerMatch` resolves
it once at construction and holds the result, so the two server readers cannot drift again.

The choice arrives from three places that do not overlap: `BOT_DIFFICULTY` for a dedicated server,
the Play Solo screen for a local match, and `--tier` for the harness. `BOT_DIFFICULTY` governs
**both** instances the process runs — the ballot's live match and the permanent waiting room —
because a room whose bots are harder than the match it feeds is a room that lies about the server.
A connected client's own preference reaches nothing at all: it populates no roster, and the bots it
is shooting at are the operator's.

**`--tier` was not validated, and the comment beside it said it was.** `newMatch` carried *"the
registry's tier union is checked inside `populate`; an unknown tier would throw there rather than
silently producing a roster of recruits."* It would not. `--tier VETRAN` resolved to a one-element
list holding `VETRAN`, `createBot` indexed `TierTable` with it and got `undefined`, and the run
produced ten bots with no config. It is checked at parse now, which is what the comment always
claimed.

### F10 — the brief belongs to the mode, and half of them can only be written by the map

The temptation the brief named up front is a map of strings in the HUD, and the argument against
it is not tidiness: a HUD that knows the name of every mode has to be edited when a mode is added,
and the sixth mode is the one that gets forgotten.

`GameMode.brief` is **abstract**, so a mode that forgets one is a compile error. That is the
strongest form this check can take and it needed no new script: `npm run check` already runs three
typecheck targets, and a class of bug that the type system can refuse outright does not need a
`.mjs` file to notice it afterwards.

It is not on `ModeEntry` beside `blurb`, and the reason is F10's own example — *"where to take the
bomb"*. Three of the six are getters that assemble the sentence from the objectives the **map**
authored: Search & Destroy names its actual sites, Domination its actual flags. A registry entry
knows a mode's rules and cannot know a map's letters, and writing `A, B and C` by hand would be a
sentence that is true of today's content and silently false the day a map authors two flags.

`blurb` stays and is not duplicated. It sells a mode to somebody choosing one, on a screen a player
migrated in by a ballot never sees. The brief instructs somebody already standing on the map with
ten seconds before the round starts. Different sentences, on purpose.

### The window, and the three surfaces that share it

`briefVisible(phase, round, inWarmupArena)` lives in `shared/ui/HudSurfaces.ts` beside the other
round-4 rules and for the same reason: it is a pure function of state that outlives the element, so
this process can count the ticks it was up without ever drawing one.

The window is round one's ten-second freeze — deliberately the *same expression* as
`quickLoadoutWindow`'s `prematch` arm, because it is the same window. Two rules that must agree and
are written twice are two rules that will eventually disagree. Later Search & Destroy rounds get
three seconds and no brief: by round two the player has played round one, and a banner over the
crosshair as a one-life round starts is a banner in front of an angle somebody is holding.

P10 asked for the priority between the surfaces in that window to be defined rather than
discovered. It is defined by **derivation and geometry, not by z-order**:

| Surface | Where | Why it does not collide |
|---|---|---|
| Quick class selector | left edge, vertically centred | Shares the window and shares no pixels. The player is choosing a class *and* being told what the match is for; those are not competing messages |
| Mode brief | centred, under the caption at 34% | — |
| Alive strip / objective banner | centred at 52px / 84px | Both above it, and neither moves |
| The ballot | the arena's | **Cannot be up here at all**, and that is a fact rather than a z-index. The server broadcasts the vote to `warmup.sessions` only and round three made `onMigrated` hide it, so a client in a live pre-match has been migrated by definition. The brief is off in the arena from the other side. Different instances: no ordering is needed, or possible |

The arena has no brief because it has nothing to brief. §6.3's room has no objective and no win
condition, F7 took the last consequence out of it, and `matchCaption` already ranks the room above
the phase there and reads `WAITING`. A permanent banner over the crosshair of a room nobody is
trying to win is exactly the *"present and empty"* element `HudStreaks` refuses to be.

The one place the geometry could still collide is the class panel, and its clearance is **derived
rather than eyeballed**: `.ql` sits at `left: var(--s-4)` with a 168px minimum and `border-box`
padding, so its right edge is about 216px, and a centred block clears that when its width is at
most `100vw - 440px`. That is the second term of the brief's `max-width`, which is why it is an
expression rather than a round number. It has still never been seen — the arithmetic says they
cannot overlap and only a browser can say whether it reads well, which is what the list below is
for.

### The F10 probe was written wrong first, and it is the mistake this file keeps recording

The first draft asserted that the brief was never up in the waiting room, and it would have failed
every run — for doing precisely what it is meant to do. `briefVisible` returns false in the arena
*by construction*, so the counter was measuring the arena term suppressing itself: a probe that can
only be green, dressed as one that blocks.

What is printed instead is the **control**, in the shape F13 established one session earlier: the
ticks the phase-and-round rule *alone* would have run for in the room, printed beside the ticks the
rule with the arena term actually ran for. The blocking assertion moved to the one question that is
not about the predicate but about what the predicate is fed — *"round one only"* means a client
that migrated into N matches may see at most N briefs, and more than that means the server sent
`WARMUP` with `round <= 1` again inside a match.

### Measured

Every number below came out of a run in this session. **No protocol change**: difficulty is server
configuration that never crosses the wire, and the brief is derived on the client from the mode it
already has.

**The mode briefs, and they are the F10 headline measurement.** Audited at the boot of every
`main.ts` run rather than behind a flag, because an audit somebody has to remember to pass is an
audit nobody runs. Each mode is constructed against the first map it can legally run on, and the
sentence is the one a player would read:

| Mode | Brief, as assembled |
|---|---|
| TDM | ELIMINATE THE ENEMY TEAM · FIRST TO 75 KILLS |
| DOM | CAPTURE AND HOLD A, B, C · 200 POINTS |
| KC | KILLS DROP TAGS · TAKE ENEMY TAGS TO SCORE, YOUR OWN TO DENY · 65 TAGS |
| FFA | NO TEAMS · EVERY OPERATOR FOR THEMSELVES · FIRST TO 30 KILLS |
| SND | ONE LIFE · ATTACKERS PLANT THE BOMB AT A OR B · DEFENDERS DEFUSE IT |
| RANGE | EVERY WEAPON UNLOCKED · STATIC AND POP-UP TARGETS · NOBODY SHOOTING BACK |

Six registered modes, six briefs, all non-empty and all distinct. The letters in the two objective
rows are read off the map's own zones, which is the half a type cannot check and the reason this is
a run rather than a grep.

**The difficulty sweep** — `npm run server -- --tier-sweep --asap --text --seed 1`. One TDM on
Foundry per choice, ten bots, same seed, everything else held.

| Choice | Roster it actually built | Time to 75 kills |
|---|---|---|
| RECRUIT | RECRUIT x10 | **523.4 s** |
| REGULAR | REGULAR x10 | **317.1 s** |
| HARDENED | HARDENED x10 | **264.0 s** |
| VETERAN | VETERAN x10 | **230.3 s** |
| MIX | RECRUIT x2, REGULAR x4, HARDENED x3, VETERAN x1 | 285.4 s |

The roster column is the wiring, and it is the half that answers *"if the tiers do not produce
different numbers, the selector is not wired"* without any argument about behaviour: an unwired
choice leaves five identical composition rows. The `MIX` row is the map's authored eight-entry
spread dealt round-robin over ten, wrapping onto its first two — which is what `populate` has
always done and is the check that `'MIX'` still means exactly what it meant.

**Hit rate and K/D are symmetric in a single-tier match, and reading them as the discriminator is
the trap.** K/D is exactly 1.00 in all four single-tier rows by construction — both sides are the
same tier, so every kill is also a death. Hit rate is symmetric for the same reason and came out
**non-monotonic**: 0.138 / 0.152 / 0.142 / 0.185, with Hardened *below* Regular, because a harder
tier is also harder to hit. The comment in `runTierSweep` said hit rate was what separated the
single-tier runs; the measurement said otherwise and the comment was rewritten to match it. What
separates them is the time column above, which a symmetric roster does not cancel.

The `MIX` row is where per-tier K/D means anything at all, and there it is monotonic in both:

| Tier | Bots | Hit rate | K / D | K/D |
|---|---|---|---|---|
| RECRUIT | 2 | 0.069 | 5 / 24 | **0.21** |
| REGULAR | 4 | 0.119 | 37 / 55 | **0.67** |
| HARDENED | 3 | 0.193 | 54 / 45 | **1.20** |
| VETERAN | 1 | 0.251 | 39 / 11 | **3.55** |

That is M3's acceptance claim holding, measured in one match rather than asserted.

**`npm run harness`** — five TDM matches on Foundry, unpaced, seeds 1-5. All five reached the
score limit (285.4 / 301.1 / 307.0 / 286.1 / 283.2 s of simulation). The two audits earlier
sessions left blocking are quoted because they are *unchanged*: `partialStock` **0** against 284
to 294 observed grenade stocks per match, and `negativeBalances` **0** with `resyncs` **0** in all
five. Neither F1 nor F10 touches the equipment or the streak economy, and a session that moved
one of them without meaning to would have moved it here.

**`npm run skirmish`** — three headless clients, a real server, a real wire, shipped timings, one
complete cycle through both ballots, a migration and a TDM. **FLOW CHECK PASSED.**

| Probe | Result |
|---|---|
| Mode brief up | **1 800 ticks over 3 windows** — one window per client, 600 ticks each, which is the ten-second freeze exactly |
| Brief windows against migrations into a live match | **3 of 3** — the round-one assertion, and it blocks |
| The control: the same rule without its arena term | **1 755 ticks** it would have run for in the waiting room |
| Quick loadout window (unchanged) | 8 351 ticks over 24 windows (4 796 respawn / 3 555 pre-match), **0** while alive |
| Tab surviving `neutralise` while dead (unchanged) | 2 365 of 4 805 dead ticks |
| Spectator invariants (unchanged) | 5 085 selections while dead, 0 self / 0 enemy / 0 dead |
| Divergence checker (unchanged) | 0 / 7 316 per client |
| Mispredictions into a live match (unchanged) | **0** |
| `arena (F12)` (unchanged) | 0 ticks of `WAITING` in a live match |

**The pre-match column is the measurement that says the two surfaces are genuinely different
rules, and it is the useful one.** The class panel's pre-match total is 3 555 ticks across three
clients — about 19.8 s each — and the brief's is 600 ticks each. The difference is one arena
warm-up: `quickLoadoutWindow` has no arena term and opens in the waiting room's first ten seconds
as well, because changing class there is exactly what a player is in that room to do. The brief
does not, because there is nothing to brief. Two surfaces in one window, derived from state that
differs by one term, measured differing by precisely that term.

**The first run of this failed, and it was the probe rather than the code**: the same tree with
the assertion written the wrong way round reported `FLOW CHECK FAILED: 1761 tick(s) with the mode
brief up in the waiting room`. That number is the control above, and reading it as a violation is
what the section on the probe describes. Everything else in that run was already green.

**`BOT_DIFFICULTY` end to end, and the replacement bug watched red.**
`BOT_DIFFICULTY=recruit npm run skirmish -- --drop-return 1` — lower case on purpose, since the
parser is case-insensitive. The value reaches every place this process makes a bot, in one run:

| Where it landed | Line |
|---|---|
| The boot line | `arena with 3 bots at RECRUIT` |
| The arena instance | `FREE-FOR-ALL on TESTBED: 1 vs 2 bots at RECRUIT` |
| The allocated live match | `match 1: TEAM DEATHMATCH on FOUNDRY, 10 bots at RECRUIT` |
| `ServerMatch.populate` | `5 vs 5 bots at RECRUIT, seed 40504` |
| **Four leavers' seats** | `ANVIL took over on team A at RECRUIT`, and three more at the teardown |

FLOW CHECK PASSED, and F8's reconnect is unaffected: 1 cycle, seat kept, score kept, divergence
after return 0/5235.

**The replacement was then watched red, and the first attempt at the control could not have
failed.** Run red at `RECRUIT` and the bug reports `RECRUIT` too — Foundry's authored mix is eight
entries, the index at that moment is seven, and `mix[7]` is `RECRUIT` by coincidence. A red control
that agrees with green is not a control, and the fix is to pick a value where the two answers
differ rather than to believe the one that agreed:

| Same drop, same seed, `BOT_DIFFICULTY=veteran` | The replacement bot came back at |
|---|---|
| Red — `replacePlayerWithBot` reading `mapEntry.tierMix`, one line, nothing else changed | **RECRUIT** |
| Green | **VETERAN** |

Which is the worst version of the defect and the reason it is worth a section: the *softest* tier
in the *hardest* match, arriving silently, on the side of whoever just lost a team-mate.

### What was not verified

- **Nothing on screen.** `HeadlessClient` builds no `ClientMatch` and the preview pane never fires
  `requestAnimationFrame`, so every F10 claim above is about a rule and none is about a pixel. The
  brief's text has been checked for content and never for legibility, and the `.hud-phase__brief`
  block — including its `[hidden]` companion rule, which is the B13 trap — has never been painted.
- **The single-tier hit-rate ordering.** One seed, one map, one mode. Four numbers within 0.05 of
  each other on a symmetric roster is not enough to claim an ordering in either direction, and
  none is claimed: the sweep is a wiring probe and the behavioural claim rests on the `MIX` row and
  on the time column.
- **`BOT_DIFFICULTY` against a deployed server.** It is exercised end to end through `loadConfig`
  and every instance-construction site in *this* process, at two different values; it has not been
  set on Render, and `deploy/operator.env` and `DEPLOY.md` are documentation until somebody does.
- **The solo path at a non-default difficulty.** `ClientMatch.populateDefault` calls the same
  `tiersFor` the server calls and typechecks against the same union, but `HeadlessClient` builds no
  `ClientMatch`, so *"pick Recruit in the menu and get ten Recruits"* is reasoned from one shared
  function and has not been run. It is the first item on the browser list for that reason.

### Needs a browser

- **The brief itself.** Start a solo TDM. During the ten-second freeze a second line must appear
  under `GET READY · 10`, reading `ELIMINATE THE ENEMY TEAM · FIRST TO 75 KILLS`, and it must
  **go away** when the countdown ends — that is the `.hud-phase__brief[hidden]` rule, and B13 is
  what happens when a block like this ships without one.
- **Search & Destroy, which is the report's own example.** The brief must name the map's real
  sites (`AT A OR B` on Foundry). Then let round one end: rounds two onward get a three-second
  freeze and **no brief**.
- **The three surfaces in one window.** In the pre-match freeze the class panel is on the left and
  the brief is centred under the caption; read both without either obscuring the other, then press
  a digit and confirm the class change still lands.
- **The waiting room.** Connect to a server and stand in the arena: the caption reads `WAITING`
  and there must be **no brief under it**, ever, including in the first ten seconds after
  connecting — which is exactly the window the control number above says the rule would otherwise
  have opened in.
- **Difficulty on the Play Solo screen.** Three columns now. Pick Recruit, start a match, and the
  bots should be visibly slower to react; pick Veteran and they should not. Then select the
  Shooting Range: the difficulty column must lock and read *"Difficulty — no bots in this mode"*,
  not *"fixed by this mode"*.
- **The picker at a narrow window.** The third column made `.op-pickers` `auto-fit` against
  `min(840px, 92vw)`; at a phone-width viewport the columns must fold rather than run off the side
  of the screen.
- **The setting surviving a reload.** Pick a difficulty, reload the page, and the Play Solo screen
  must come back on the same one. It is written on `pagehide` beside the mode and the map.

Unchanged from the earlier lists: the arena-return residual of 1-3 sub-25 cm mispredictions, and
everything under "Open, and all of one kind".

### Found while here

- **`MatchRequest.botFill.count` is not read either.** `allocate` takes only `botFill.tier`, and
  `LiveMatch.buildDeps` hard-codes `bots: 10` with a comment saying the mode's authored roster
  decides the count — which is true, and which makes the `count` field on the request a second
  dead knob beside the one this session deleted. Left, because unlike the tier it has no reader to
  disagree with and removing it is a change to the allocator's public shape for no defect.
- **`BotHarness` keeps its own four-tier `MIX` constant**, which is a flat spread rather than the
  map's authored one. That is right for a measurement lever — M3's per-tier table only means
  something if the roster is controlled — and it is now the only place in the tree that says
  "mixed" and means something other than `tiersFor`. Recorded rather than unified, because
  unifying them would make the debug harness measure the content instead of the tiers.
- **`npm run check` cannot see a mode brief and `npm run harness` can**, which is the same split
  `check-unlocks.mjs` documents about itself. The abstract member is what the gate enforces; the
  sentence being worth reading is enforced one layer out, at the boot of every simulation run.

---

