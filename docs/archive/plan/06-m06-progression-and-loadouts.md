<!-- Moved verbatim from PLAN.md lines 1673–2033 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# Milestone 6 — Progression and Loadouts

The reason to open the build twice. Mechanically the least interesting milestone and the
one with the most places to be quietly wrong: a number that is not the number gameplay
uses, a perk that reads as an effect and is a cosmetic, a schema bump that eats somebody's
unlocks.

Three ideas carry the whole milestone.

**There is one resolution function.** M5's `resolveWeaponDef(base, attachments)` grew a
third parameter for perk modifiers, and every consumer goes through it — the loadout
editor's stat panel, the debug modifier table, and `Game.buildWorld` on the way into a
match. S6.3's "never a hand-written marketing bar chart that can drift from the actual
values" is therefore not a discipline anybody has to keep; there is nowhere else for a
number to come from.

**There is one save object, and it is repaired rather than reset.** `migrateSave` handles a
*version* change; `normaliseSave` handles *damage* and runs on every load, not only on a
version bump. Both return a list of what they had to touch.

**Progression cannot reach into gameplay.** `MatchProgression` counts events and
`MatchMeta` sets four fields on systems that already existed. Nothing in `meta/` is
consulted by the sim, which is what makes "progression costs nothing in the hot path" a
measurement (0.1 ms p99) rather than a hope.

## What was built

**Meta (`src/meta/`)** — a new package.
`Levels` (the authored 54-row curve, prestige, the badge), `XpRules` (the award table and
the report shapes), `Loadouts` (the slot record, the five defaults, `resolveLoadout`),
`Unlocks` (three gates, the permanent token, `sanitiseLoadout`), `Challenges` (thirty
definitions across five rule kinds), `ChallengeTracker` (the counters and the awards),
`Camos` (six `CanvasTexture` generators, each a different construction), `FieldUpgrades`
(four, each one call into a system that already exists), `SaveData` (`SaveV1`, the
migration, the repair), `Profile` (the one owner of the save), `MatchProgression` (the
per-match tally and the `KillFact` assembler).

**Perks (`src/perks/`)** — a new package.
`PerkDefs` (twelve, three tiers, each declaring its hook by name), `PerkState` (the pure
fold into weapon modifiers plus a flags record), `PerksRuntime` (Scavenger's pickups and
Tracker's trail — the two perks that need a group in the scene), `FieldUpgrade` (the
charge, the key and the four effects).

**Modes (`src/modes/`)** `Range` — the Shooting Range from the M5 playtest notes. `ModeEntry`
grew `populatesRoster`, `unrestricted`, `banksProgress` and `forcedMapId`.

**UI (`src/ui/`)** `LoadoutEditor` (the `LOADOUT` state's screen), `LoadoutStats` (base
against resolved, per stat), `XpSummary` (the animated breakdown and the level-up
flourish), `styles/meta.css`. `Menus` grew a Create-a-Class button, the profile line and
the two-step reset; `PauseMenu` grew a Create-a-Class button; `HudTactical` grew the field
upgrade's charge.

**Root** `MatchMeta` (the composition root for progression and perks), `GameLoadout` (the
loadout-to-match bridge, pulled out of `Game.ts`).

**Debug (`src/debug/`)** `MetaPanel` (progression, the modifier table, challenges, the
EventBus tap, the simulator), `SaveInspector` (S7's four asks), `XpSimulator` (the
projection arithmetic). `public/verify/progression.js` is the acceptance suite.

**Extended, not rewritten** — `Attachments` (`resolveWeaponDef` takes modifiers;
`applyEffects` exported as the single writer of a `WeaponDef` field), `SaveStore` (`touch`,
`replace`, `readRaw`, and a write counter), `ScoreSystem` (assists, off a fixed damage
ledger), `PlayerController` (`speedScale`), `Health` (`overhealth`, `healFull`),
`BotDirector` (`silentFootsteps`), `FlashField` (`resistance`), `WeaponBase`
(`addReserve`), `Inventory` (`all`), `WeaponMesh` (camo material sets),
`DifficultyTiers` + `CombatBehaviour` (the range-error term), `Events` (eight M6 events,
all of them emitted).

## Deviations, and why

### 1. `SettingsV1` moved into the one save object — required by S6.6, and migrated

S6.6's schema puts settings inside `SaveV1`, which means the first launch after M6 would
otherwise reset everybody's FOV, sensitivity and volume. `readLegacySettings` reads the
M1-M5 `operator.settings` blob once, before the store loads, and carries it across. The old
key is never written, so a downgrade still works.

### 2. Bots no longer carry the player's weapon object — a real bug the perks exposed

M5 handed `BotDirector` the same `WeaponDef` the player held. That was harmless when the
object was a base def and stopped being harmless the moment a loadout could fold Quickdraw
into it: the enemy team would have been issued the player's perks. `Game` now owns a third
def, `botWeaponDef`, cloned from the same registry entry. Measured: player ADS 196 ms with
Quickdraw, bots 280 ms, same match.

M5 already leaked *attachments* this way through the arsenal panel; that is fixed by the
same change.

### 3. The account level is derived from XP, never trusted from the save

`normaliseSave` recomputes the level from the XP ledger and reports the disagreement. This
is what makes acceptance criterion 5 hold against the obvious attack: a hand-edited save
claiming level 55 is corrected to the level its XP supports *before* `sanitiseLoadout` uses
that level to decide what may be equipped.

### 4. The default classes are all the same weapon, and that is correct

Everything in the shipped five is legal on a fresh level-1 profile. At level 1 the arsenal
is the carbine and the sidearm and tier 2 is empty until level 5, so all five start with the
same gun and differ in equipment, perks and field upgrade. A default set showing a sniper
the player cannot equip would be silently rewritten by `sanitiseLoadout` on first load, and
a rewritten default is indistinguishable from a bug.

### 5. `meta/` and `perks/` are S3's; `MatchMeta` is not

S3 names both directories. `MatchMeta.ts` sits beside `MatchEquipment.ts` and
`MatchFeedback.ts` for the reason those exist: `Match` is wiring, and a subsystem's worth of
wiring belongs next to it rather than inside it.

### 6. Weapon stats needed more fields than S6.6's sketch

S6.6 gives `weapons: Record<WeaponId, { xp, kills, headshots, unlockedAttachments }>` and
S6.2 asks for "kills, headshots, **accuracy, longest shot, time used**". Accuracy is stored
as its two inputs (`shotsFired`, `shotsHit`) so it can never drift from them, and
`longestShot`, `timeUsed`, `longshots` and `multikills` are added — the last two because the
TIGER and FRACTAL camos measure them.

### 7. Prestige keeps weapon stats and camos

S6.1 says "reset level and unlocks". Weapon kills and earned camos are neither: a player who
ground a weapon to GOLD earned the camo, and taking a hundred kills back would make prestige
a punishment rather than a choice. What resets is the account level and everything gated on
it — verified: VANTAGE SR relocks, the carbine's 120 kills and all six camos survive.

### 8. Field upgrades are four, and each is one call into an existing system

S6.3 lists a field upgrade as part of a class and says nothing about what one does; S9 defers
killstreaks. Hard Rule 1 rules out a dropdown of names, so these four are the ones that could
be built honestly out of what exists: MUNITIONS (`Weapon.addReserve` plus
`EquipmentSystem.refill`), STIM (`Health.healFull`), ARMOUR PLATE (`Health.grantOverhealth`,
a pool absorbed before health and never regenerated), and SMOKE SCREEN (`SmokeField.spawn` —
the same field a thrown smoke uses, so bots stop seeing through it through the M3 perception
path with no new code). Charged by time rather than by score, because score charging needs
the streak plumbing S9 defers.

### 9. Interpretations worth recording

- **`Match.equip`'s camo argument distinguishes `undefined` from `null`.** `undefined` keeps
  the slot's current finish and `null` strips it. Without that, M5's debug weapon picker —
  which calls the method with two arguments and has no idea camos exist — silently returned a
  gold rifle to grey every time the overlay was built. Found by inspecting the material maps,
  not by looking at the screen.
- **Challenge progress is held in memory and banked with the match.** Quitting mid-match
  loses that match's progress, which is the same contract the XP has and what S6.6's "write on
  match end" asks for.
- **`ChallengeTracker` subscribes to nothing.** `MatchProgression` owns the subscriptions and
  builds one `KillFact` per kill; thirty predicates are tested against it. Thirty separate
  subscriptions each rebuilding "was the player sliding" is thirty places for that answer to
  differ.
- **Subscription order is load-bearing and documented.** `MatchFlow` subscribes to
  `entity.killed` before `MatchProgression` does, so the streak read out of `ScoreSystem`
  includes the kill being described. That is what keeps the streak one tally rather than a
  private copy.

## M5 playtest items, closed

**Shooting Range — built.** A real mode: grey-box map, eight dummies, zero enemies, a clock
and a scoreboard about the weapon (hits, shots, accuracy, damage). `unrestricted` lifts every
unlock gate so all twelve weapons are testable, and `banksProgress` is false so nothing done
there can move the account — a range that awarded XP would be the fastest way to level.

**Bot long-range accuracy — retuned.** The note was right and the reason is that a *constant
angular* cone gets easier to shoot inside as range grows. `rangeErrorStart` and
`rangeErrorPerTenM` per tier add degrees past a start range, so nothing inside a room changes
and everything across a yard opens up. Veteran, measured as cone / linear miss radius:

| Range | Before | After |
|---|---|---|
| 10 m | 1.35 deg / 0.24 m | 1.35 deg / 0.24 m |
| 20 m | 1.35 deg / 0.47 m | 1.35 deg / 0.47 m |
| 30 m | 1.35 deg / 0.71 m | 1.90 deg / 1.00 m |
| 40 m | 1.35 deg / 0.94 m | 2.45 deg / 1.71 m |
| 50 m | 1.35 deg / 1.18 m | 3.00 deg / 2.62 m |

**F1 / pause / Esc — done.** F1 no longer opens the overlay; the pause menu's button does.
The overlay has a close button in its header. Esc with the overlay open closes the overlay
and stops, handled in `Game.onEscape` because `Input`'s window listener runs first and
nothing the overlay does could stop it.

## Problems found in the brief

Deliverable 4 asks for these explicitly.

1. **The 200/objective XP row has no producer in any shipped mode.** S6.1's table pays for
   objectives; S9 puts every mode that has one out of scope, and TDM has none. The award path
   is real and driven by `MatchProgression.noteObjective`, which the XP simulator and the
   verification script call — but in normal play the row is always zero and the summary omits
   it. M7's Domination should call it from `onCapture`. This is the one line of S6.1 that
   cannot be exercised by playing the build.
2. **S6.6's `SaveV1` sketch is missing fields S6.2 requires.** See deviation 6.
3. **"Prestige resets unlocks" does not say whether weapon stats and camos are unlocks.**
   See deviation 7; the reading matters a great deal to whether anybody presses the button.
4. **S6.4 lists three perks whose effect is "hook ready for M7".** Their flags are real and
   queried by real functions, and the debug panel labels them inert — but "each one needs an
   actual effect hook in the systems that already exist" and "hook ready for M7" are in
   tension, and three of the twelve are on the wrong side of it. They are the three the brief
   names.
5. **"Field upgrade" is a loadout slot with no specification.** See deviation 8.
6. **Frame-time p99 still cannot be measured honestly in a non-compositing tab.** Same finding
   as M1-M5. The numbers that describe this build are the sim-side costs.

## Verification

`fetch('/verify/progression.js').then(r => r.text()).then(eval)` then
`await __verifyProgression.all()`; see DEBUG.md. Everything below was measured on this build.

| Criterion | Result |
|---|---|
| 1. XP per the table, animated, with a level-up | A full match with 22 kills banked **+3,565 XP** and took the profile from level 1 to **level 5**. The breakdown animated in six rows — Kills x22 +2,200, Headshots x9 +225, Longshots x8 +240, Challenges x1 +100, Weapon levels +250, Best streak x22 +550 — and the total matches the amount banked exactly. The flourish fired on the crossing and read **"LEVEL 5 · UNLOCKED · DEAD SILENCE"**. Every figure is the S6.1 rate times the count. |
| 2. Five slots, persistent, and what actually spawns | Slot 3 renamed PERSIST with smoke and Dead Silence, equipped, then the page reloaded: **level 5, 3,565 XP, equipped index 2, name PERSIST, lethal smoke, perks [-, dead_silence, quickdraw]** all survived. In the match that followed, the player's ADS was **196 ms** (Quickdraw) while the bots' was **280 ms** — the equipped class is what spawned, and only on the player. |
| 3. One resolution function | Fitting the foregrip moved **ADS 196 -> 213 ms** and **vertical recoil 1.000 -> 0.750** in the same resolve the match consumes, with the base def byte-identical afterwards. The editor's panel and the debug modifier table both read that one call; there is no second computation to disagree with it. |
| 4. Twelve perks, measured | All twelve change something, measured through the systems that carry them. **Lightweight** through the real `PlayerController` in the headless harness: walk **4.600 -> 4.922**, sprint **6.900 -> 7.383**, crouch **2.800 -> 2.996**, tac sprint **8.200 -> 8.774** — exactly **+7.00%** on every mode. **Quickdraw** ADS **280.0 -> 196.0 ms** (-30%). **Sleight of Hand** reload **2050.0 -> 1332.5 ms** (-35%). **Amped** swap-in **520 -> 312 ms** (-40%). **Battle Hardened** flash intensity **1.000 -> 0.400x**. Scavenger, Tracker and Overkill flip their state flags; Ghost, Cold-Blooded and Hardline flip theirs and are labelled inert. |
| 4. Dead Silence against bot perception | Driven through the *real* `player.footstep` event and the director's own subscription: ungated, the noise field's serial advances; with the perk's gate installed, **it does not advance at all**. The step still sounds for the player — it is the enemy's hearing that is cut. |
| 4. Scavenger and Tracker, live | Six bot deaths dropped **7 pickups**; standing on one granted exactly **one magazine (30 rounds)**, incremented the collected counter and emitted `perk.scavenged` at the body's position. Tracker accumulated **136 footstep points** from enemy steps only, with the point cloud visible. |
| 5. Unlock gates | A save edited to name a locked weapon **and** to claim level 55: the level was corrected to **1** ("profile.level 55 disagreed with 0 XP"), and the weapon was then refused — *"ASSAULT primary ar_vulcan is locked (LEVEL 6); reverted to ar_carbine"*. Both reported, neither silent. |
| 6. Challenges and camos | Thirteen challenges accrued from one match's real events across five rule paths. **Three different rule kinds completed**: `kill` (FIRST BLOOD, REACH OUT, FROM THE HIP), `weaponBest` (DIGITAL, SPLINTER, TIGER, FRACTAL, GOLD), and `camoSet` (OBSIDIAN, which requires the other five and cannot be reached any other way). **All six camos unlocked**, and the gold pattern is on the viewmodel's receiver and furniture (256 px camo maps in place of the 128 px base, glove unchanged). |
| 7. Migration | The hand-written V0 payload through the real `migrateSave`: **xp 42,000 -> 42,000 (level 15), prestige 1 -> 1, ar_carbine 312 -> 312 kills, fov 103 -> 103, class 2 primary smg_wasp -> smg_wasp**, and the retired `ar_retired_prototype` **dropped and reported**. Then a save damaged in eight ways at once recovered with **seven repair lines** and no data loss beyond what was broken — a non-numeric XP, a level that contradicted it, a null weapon record, an unknown weapon, an unknown camo, a retired challenge, an unknown weapon id in a loadout, and a perk in two wrong tiers. |
| 8. Save write frequency | **One write per match**, plus one at page load. Two full matches back to back took the counter **1 -> 2 -> 3**. Counted at the point of writing rather than at the calls that might cause one, so a coalesced burst is one write. |
| 9. Frame time | `MatchMeta.simulate` over 12 s of a live ten-bot firefight: **p50 0.0 ms, p95 0.1 ms, p99 0.1 ms, max 0.1 ms**. Sim total p99 **2.4 ms** against S4.7's 3.0 ms budget, mode peak 0.2 ms, HUD peak 1.1 ms. See the frame-time caveat below for why the frame percentiles are not this build's. |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`, zero TODOs. |
| 10. Console | Clean across two full matches and three reloads: Vite's own messages, the `[Profile]` info line, and the embedded pane's `WrongDocumentError` pointer-lock rejection that M5 already documented. No errors, no new warnings. |
| S7. Pacing | 3,120 XP a match at the simulator's average performance. **Level 10 at match 5, level 20 at match 24, level 30 at match 59, level 55 at match 217 (36.2 h)**. Every weapon unlock lands inside the first 99 matches; the stretch past 40 is the wall prestige exists to make meaningful. |

### The frame-time caveat, again

The Browser pane reports `visibilityState: "hidden"` and never composites, so
`requestAnimationFrame` never fires on its own. The measurements substitute the frame source
with a `MessageChannel` the way M4 and M5 do — which drives the real loop, sim, damage path,
mode and audio graph — but the resulting frame percentiles (p50 3.3, p95 37.4, p99 41.0 ms)
are mostly the source and the environment. The numbers that describe this build are the
sim-side costs above, and `Meta ms` in particular: **0.1 ms at p99 is a rounding error against
a 3.0 ms budget**, which is what criterion 9 is asking about.

### Bugs found by verification, and fixed

1. **The arsenal panel silently stripped camos.** `ArsenalPanel` calls `Match.equip` on
   construction to sync its picker, with no camo argument — so building the debug suite
   returned a gold rifle to grey. Found by reading the material maps off the viewmodel rather
   than by looking at it, which is the uncomfortable part: nothing on screen would have said
   so in a non-compositing pane. `equip`'s camo parameter now distinguishes "keep" from
   "clear".
2. **The XP breakdown printed "Challenges x100" for a single 100 XP completion.** The row's
   count held its XP. It now counts challenges and reads its total from the tracker — the one
   row in the table whose XP is data rather than a rate.
3. **`normaliseSave` dropped two classes of damage silently.** A non-numeric `profile.xp` and
   a weapon record that was not an object were both repaired without a loss line. Found by
   corrupting a save and counting the reported repairs against the damage done.

### Left for the human

The pane never composited, so **nothing below was seen**. These need eyes:

1. **The level-up moment.** It is the payoff S6.1 asks for weight and timing on: rows landing
   on a 0.34 s cadence with a blip that climbs a fifth, the bar filling at one level per 1.1 s,
   then the interrupt — bar to the edge, flourish scaling in, a three-layer sting with a low
   body an octave under the sweep. Every number is at the top of `XpSummary.ts`.
2. **Six camos as pictures.** They were authored as six different *constructions* rather than
   six recolourings — aligned digital blocks, straight-edged splinter shards, warped tiger
   stripes, posterised fractal noise, brushed gold with a specular sweep, and lit Voronoi
   facets for obsidian. Whether they read as six things at viewmodel distance is unverified.
3. **The loadout editor at a glance.** Three columns, eleven accordion rows, and a sticky stat
   panel. The layout has been exercised in code and never rendered.
4. **Scavenger's pickups and Tracker's trail.** Both draw into the scene — a bobbing amber
   magazine that blinks in its last three seconds, and a point cloud that cools from accent to
   ember over nine seconds. Legibility at speed is not something a DOM assertion can answer.
5. **Bot long-range accuracy, as felt.** The table above says the cone doubled by 45 m. Whether
   that is the difference between "punishing" and "fair" is Hard Rule 3, and it is four sliders
   under F1 (`rangeErrorStart` and `rangeErrorPerTenM`, per tier).
6. **`__operator.runMatches(10)`** with progression live. `MatchMeta` and `PerksRuntime` are
   new things in the per-match mirror and both could leak; the heap harness has not been re-run
   since they landed.

## What Milestone 7 needs to know

**The three inert hooks are ready and named.** `PerkState.visibleToUav`, `.targetedByStreaks`
and `.streakDiscount` are real fields, folded by `resolvePerkState`, reported in the F1 panel
and labelled inert. A UAV asks the first, a sentry's target selection asks the second, and a
streak's requirement subtracts the third. Nothing else needs to change for Ghost, Cold-Blooded
and Hardline to start working.

**Damage still has exactly one door, and now so does modification.** `applyEffects` in
`weapons/Attachments.ts` is the only function in the project that writes a `WeaponDef` field.
A killstreak that buffs a weapon should pass an `AttachmentEffects` to `resolveWeaponDef`
rather than reaching for the def — and if it does, the loadout editor and the debug panel
report it for free.

**The objective XP path is waiting for a caller.** `MatchProgression.noteObjective(count)`
exists, is exercised, and is called by nothing in a shipped mode. Domination's `onCapture` and
Kill Confirmed's tag pickup are its intended callers; S6.1 already prices an objective at 200.

**A mode declares four things about progression.** `ModeEntry` carries `populatesRoster`,
`unrestricted`, `banksProgress` and `forcedMapId`. A new mode that forgets them gets the
defaults it should — bots, gated content, progress banked, any map — and the Shooting Range is
the one entry that says otherwise.

**The profile is process-wide; everything else is per-match.** `Profile` outlives every match
and is a direct handle on the console API for that reason. `MatchMeta` and `PerksRuntime` are
in the per-match mirror and both dispose: `MatchMeta.dispose` clears the three system hooks it
installed, because a perk predicate that outlives its match is exactly the leak shape M4's heap
harness was built to catch.

**Write on an event, never on a tick.** Every mutator on `Profile` ends in one `store.touch()`
and `SaveStore` coalesces. If M7 adds something that changes the save, put it behind a method
on `Profile` rather than reaching for `store.value` — the write counter is what acceptance
criterion 8 is read from and it only means something if there is one door.

**Housekeeping.** `Game.ts` is **905 lines** and remains the project's largest file and its
outstanding architectural debt. M6 took the cheap half of the split — `GameLoadout.ts` — and
deliberately left the expensive half: the world lifecycle (`buildWorld` / `teardownWorld` and
the six per-match fields) is woven through `simulate`, `draw`, the state handlers and eight
getters, and moving it is a ~30-call-site refactor of the hot path that deserves its own pass
rather than the end of a milestone. **That is the M7 job, and it should be done first.**
`Match.ts` is 796. Twenty-five files are over S3's ~400-line guidance.
`public/verify/*.js` still ship in a production build — now seven files.

### Critical Hotfixes (Action Required IMMEDIATELY after the Game.ts Refactor)
**Global Loadout Bug:** Selecting a weapon in Create-a-Class currently equips it on all bots in the match. 
Bots must retain their own independent, randomized (or tier-based) weapon loadouts. 
Fix the combatant instantiation so loadouts are strictly isolated per-actor.
**ADS Visibility & Opaque Sights:** The SMG sight/optic is rendering opaque, blocking the target entirely. 
The pistol viewmodel is still sitting too high and obscuring the target. 
Fix the optic material transparency/clipping and adjust the pistol's `adsY`/`adsZ` again for clear line-of-sight.

### M6 Playtest Feedback (To be implemented DURING M7)
**Shooting Range Overhaul:** 
  1. Force all weapons and attachments to be temporarily UNLOCKED when in the Shooting Range mode.
  2. Add a new "Infinite Health" dummy specifically for continuous DPS testing without it dying.
  3. Add a dedicated spread-testing wall/target that clearly retains bullet decals for accuracy testing.
  4. Expand the greybox room into a proper firing range layout (lanes, moving/falling targets, infinite DPS dummy area).
**Weapon-Aware Bot AI:** Bots currently do not adjust their playstyle to their weapon. 
Update `CombatBehaviour` so bots actively try to close the distance if holding a Shotgun/SMG, or maintain distance if holding a Sniper/AR.

## What is playable right now

Press Play and the menu now tells you what level you are and how far the next one is. Create
a class and you get five slots that are yours: a weapon, the attachments that weapon's own
kill count has earned, a camo when you have earned one, a sidearm, a lethal, a tactical,
three perks one per tier, and a field upgrade — and on the right of the screen, the actual
resolved rifle, so fitting a foregrip shows you 196 to 213 milliseconds of ADS and a quarter
less climb, because that is the same object the gun will be built from. Most of it is locked,
struck through with what it costs, which is the point. Then you play, and the things you do
are counted: a kill, a headshot, a shot past thirty-eight metres, two kills on one magazine, a
five-streak. When the match ends the summary fills in a row at a time with a blip that climbs,
the bar walks along behind it, and if you cross a level the bar slams into the right edge and
the whole thing stops to tell you that dead silence is now yours. Take it: your footsteps stop
existing to every bot on the map. Or take lightweight and run seven percent faster at
everything, or quickdraw and get your sights up in under two hundred milliseconds, or
scavenger and watch magazines drop off the bodies you leave behind so you can walk over them
and keep going. Press X when the corner of the HUD fills up and you get your ammunition back,
or your health, or fifty points of armour, or a smoke cloud on your own position that the
enemy genuinely cannot see through. Grind one weapon and it goes digital, then splinter, then
tiger, then fractal, then gold — and when it has all five it goes obsidian, which you cannot
get any other way. All of it survives closing the tab, and if the save is ever damaged the
game tells you exactly what it had to repair instead of quietly starting you over. There is a
shooting range now too, where every weapon is unlocked, nothing counts, and nobody shoots
back. And under the pause menu the overlay will show you every perk as a before and after,
every challenge as a fraction, every event the match has fired, and a button that plays four
hundred matches in a millisecond and tells you it takes thirty-six hours to reach fifty-five.

---

