<!-- Moved verbatim from PLAN.md lines 2034–2288 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# Milestone 7 — Killstreaks and Modes

Six killstreaks and four game modes, plus the refactor and the two hotfixes PLAN.md demanded
before any of it, and the M6 playtest items that were scheduled to land during it.

## What was built

**Root** — `MatchWorld.ts` (the per-match world lifecycle, lifted out of `Game.ts`),
`GameScreens.ts` (the front end), `MatchObjectives.ts` (flags, rings, tags and the bomb as
things in the world).

**Streaks (`src/streaks/`)** — a new package.
`KillstreakBase` (`onEarn`/`onActivate`/`onTick`/`onExpire` and the `StreakContext`),
`StreakDefs` (six definitions plus every tuning number), `StreakSystem` (earning, spending,
the three perk hooks, and the care-package objective provider), `Uav`, `CounterUav`,
`CarePackage`, `MortarStrike`, `SentryGun`, `ChopperGunner`, `StreakAudio` (the vocabulary,
composed from M2's two primitives), `StreakWeapons` (synthetic `WeaponDef`s so streak damage
goes through the one door).

**Modes (`src/modes/`)** — `Domination`, `KillConfirmed`, `FreeForAll`, `SearchAndDestroy`,
`ObjectiveZone` (the capture maths flags and bomb sites share).

**AI (`src/ai/`)** — `BotArsenal` (per-tier weapon draw), `WeaponProfile` (how a bot fights
with what it is holding), `ObjectiveIntent` (the seam that lets bots play objectives without
`ai/` importing a mode). `BotStates` gained `OBJECTIVE`; `BotBrain` gained `tryObjective` and
`tryFallBack`.

**UI (`src/ui/`)** — `HudStreaks` (the streak strip and the objective banner), `MortarOverlay`
(the targeting map). `Minimap` gained UAV contacts, the sweep beam, Counter-UAV interference
and flag ownership.

**Debug (`src/debug/`)** — `StreakPanel` (streak state, sentry targeting, care-package
contest, and a button per streak). `AiPanel` gained objective intent; `DebugOverlay` and
`FrameStats` gained streak ms and entity count; `BotHarness` gained a `mode` flag.

**Extended, not rewritten** — `ScoreSystem` (`captures`/`defends`/`plants`/`defuses`/`tags`
and `recordObjective`), `Renderer` (`renderThermal`), `Events` (fifteen M7 events, all
emitted), `Decals` (capacity 96 -> 192), `TargetDummy` (`infinite` and `faller`),
`TargetRange` (6 dummies -> 12), `greybox` (accuracy wall and lane stripes), `HitboxRig`
(`buildLayout` exported so a sentry can have its own rig).

## Deviations, and why

### 1. `Game.ts` was split twice, and the second half was not asked for

PLAN.md named the world lifecycle. Doing only that left 810 lines, so the front end went to
`GameScreens.ts` as well. 905 -> 770 + 280 + 144. The point was never line count: six fields
that were only ever all-present or all-absent became one `MatchWorld | null`, so the hot path
asks once instead of four times and `MatchWorld` itself has no optional members.

`game.map` and `game.player` became **public getters**. Six shipped `public/verify/*.js` read
those names, and TypeScript's `private` is compile-time only — the move would otherwise have
broken them silently.

### 2. `botWeaponDef` was renamed `playerBaseDef`, because the name was the bug

M6 fixed half of the loadout leak: it isolated attachments and perks but still handed bots
`loadout.primaryBase`, so equipping a sniper armed all nine. Bots now draw their own weapon
per tier from the director's seeded `Rng`, and the object M6 introduced is renamed for what it
actually is — the base of the *player's* primary, read only by the M6 modifier panel.

### 3. Iron sights are built relative to the sight line, not the rail

The rail-relative version used absolute box sizes authored against the AR's 0.082 m receiver.
On the pistol that put the sight line *inside* its own front and rear sight bases. Deriving
every block from `sightHeight` makes the aperture clear by construction on all twelve weapons.
The pistol's `sightHeight` went 0.042 -> 0.062, which also fixed the "sitting too high" pose:
ADS holds a weapon `sightHeight - 0.0915` lower, so a sight line 50 mm under the reference
lifted the whole gun up the screen.

### 4. A scoped weapon hands off to the scope overlay

A scope tube is a solid cylinder 0.17 m from the eye and was filling the clear centre of the
scope picture — the same defect as the red dot, unreported only because snipers unlock late.
Past `SCOPE_VIEWMODEL_HIDDEN` the viewmodel stops drawing and the overlay is the picture.

### 5. Free-for-All keeps the two-team substrate

`ScoreTeam` is `'A' | 'B'` and spawn safety, perception and the killfeed are all written
against it. FFA splits eight players across the two sides and makes the split *irrelevant*:
the win condition scans individual rows, the banner shows the best individual per side, and
there is no team-kill penalty. Rewriting the M4 foundation for one mode was the wrong trade,
and the brief says extend rather than rewrite.

### 6. The mortar is marked before it is spent

Pressing the key opens the overlay; the streak is consumed only on confirm. Cancelling keeps
it. A streak spent on a mis-click is a streak the player did not get to use.

### 7. Care packages ride a second objective-provider slot

A crate is contestable in *every* mode including Team Deathmatch, so it cannot be the mode's
business. `BotDirector` holds the mode's provider and the streak system's, and `BotBrain`
takes whichever offers the higher priority.

## Bugs found by running it

Three, and two had been latent since M3.

1. **`LOW_MAGAZINE` was an absolute 8.** Invisible while every bot carried the 30-round
   carbine; a hard lock the moment `BotArsenal` dealt a shotgun. A full 6-round magazine is
   already "low", so the bot asked for RELOAD on every decision — and `IDLE -> RELOAD` was not
   a legal edge, so it never left IDLE. Nine bots stood still for an entire match. Now
   `LOW_MAGAZINE_FRACTION = 0.28`, which reproduces the carbine's 8 exactly so no M3
   measurement moves, and the edge is legal.
2. **`OBJECTIVE` was not a firing state.** Bots crossed firefights with the trigger disabled.
   Found the first time S&D ran: defenders strolled past the attackers who had just planted
   and defused unopposed, five rounds out of five.
3. **The objective check sat after the target branch.** `hasTarget && !seeing` falls into
   SUPPRESS and returns, so a defender that had merely *heard* somebody never reached the
   check and never went for the bomb. Moved above the branch, with the priority gate deciding.

## Problems found in the brief

1. **"Best of 9 rounds, sides swap at 5" cannot always show the swap.** First to five ends a
   5-0 sweep *at* round five, so the swap after round five never runs. The rule is
   self-consistent; the swap is simply unreachable in a sweep. Verified directly instead —
   see below.
2. **Search & Destroy rounds are deterministic.** A fixed `AI_SEED` plus an identical round
   reset means rounds 2-5 replay round 1 almost exactly, so a bot-only best-of-nine is a sweep
   rather than a mixed match. Per-round spawn variation would fix it; it is not in this
   milestone.
3. **FFA's eight sides do not exist underneath.** See deviation 5.
4. **"The player body is out of play but not invulnerable to a lucky mortar"** is the clearest
   line in S6.1 and it is what forced the chopper's design: the body is left registered,
   visible and damageable, and only its *input* is taken away.
5. **The Shooting Range unlock note was already satisfied in M6** for both weapons and
   attachments — but the editor gates on the *currently selected mode*, so opening
   Create-a-Class while TDM is selected shows locks. Selecting the Range first works. Worth
   knowing before it is reported again.

## Verification

Everything below was measured on this build. The frame-time caveat from M1-M6 still applies
and is restated at the end.

| Criterion | Result |
|---|---|
| 1. Six streaks earn, activate, function, expire | All six activated and all six expired cleanly in one match. Care package **claimed by bot #102**. |
| 1. Hardline | Every requirement drops by exactly one: **4/5/5/7/8/12 -> 3/4/4/6/7/11**. |
| 1. Ghost | Player **absent** from an enemy UAV sweep while **4 other contacts still record** — the sweep is working, only the player is hidden. |
| 1. Cold-Blooded | Enemy sentry targeted the player **71 ticks / 6 shots** with the perk off; **0 ticks / 0 shots** with it on, nearest other combatant 21.5 m away in both runs. |
| 2. Chopper returns control | Three exits, all clean, no throws: **player killed mid-streak**, **match ended mid-streak**, **`endAll` during takeover**. Camera returned and 0 live streaks in every case, and the body stayed a registered damageable. |
| 3. Modes play to completion | DOM, KC, FFA and S&D all run; S&D plays a **full best-of-nine to SUMMARY**. |
| 4. Bots play the objective | **Domination: 13 bot captures**, roster split **4 capturing / 5 defending**. **Kill Confirmed: 51 tags dropped, 48 collected — 34 confirmed, 14 denied**. **S&D: plants and defuses both non-zero.** |
| 5. S&D one life | **Zero respawns during a live round** across a full best-of-nine; round transitions clean. |
| 6. Spawn safety after a swap | Spawn zones genuinely flip — team A mean spawn Z **+9.9 -> -8.3**, team B **-7.5 -> +9.3** — the round tally swaps, and afterwards **120 selections, minimum enemy distance 41.77 m, zero cone violations, zero visibility violations**. |
| 7. Sentries use the bot aim model | **2 hits / 29 shots = 6.9%**, 27 misses, against moving bots. At point-blank on a stationary target it lands 6/6, which is the same model behaving as it should. |
| 8. Heaviest scene | Chopper active + 2 sentries + 10 bots: **streak cost 1.10 ms peak**, mode 0.30 ms peak, HUD 1.50 ms peak, 3 streak entities. Frame p50/p95/p99 **3.1 / 22.9 / 27.6 ms** over 600 samples — see the caveat. |
| 9. Three matches, three modes, heap at each boundary | DOM -> KC -> SND: **29.04 -> 32.93 -> 37.95 -> 34.79 MB**, delta **+5.75 MB**, and the third boundary *fell* 3.16 MB. No monotonic growth. |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`. |
| 10. Console | Clean across TDM, DOM, KC, FFA and S&D — five modes built and torn down with zero errors and zero non-pointer-lock warnings. |
| Range overhaul | 12 dummies (3 movers, 2 fallers, 1 infinite). Infinite dummy **absorbed 2700 damage without dying** and tracked DPS. Unlock gate at a fresh level-1 account: a normal match locks **10/12 weapons and 5/5 carbine attachments**, the Range locks **none of either**. |
| Weapon-aware bots | Controlled single-class rosters: **shotgun median 9.0 m** (max 13.5), **sniper median 23.3 m** (max 51.5). Mixed roster: SMG 12.7 m, AR 20.4 m. |
| Bot loadout isolation | Player holding `sniper_vantage`, **0 of 9 bots** carrying it, five distinct bot weapons, tier-appropriate. |
| Sight lines | Ray-tested against the real viewmodel triangles at full ADS on all twelve weapons. Irons: centre ray hits the front blade, **clear at +/-5 and +/-6 mm**, notch posts at +/-10 mm. Red dots: **no opaque hit at any offset**. |

### Caveats worth stating plainly

**Frame percentiles are still not this build's.** The Browser pane reports
`visibilityState: "hidden"` and never composites, so `requestAnimationFrame` never fires and
the measurements substitute a `MessageChannel` frame source — the same workaround M4, M5 and
M6 used. That drives the real loop, sim, damage path, streaks and mode, but the resulting
frame numbers are mostly the source. **The numbers that describe this build are the sim-side
costs**: streak entities at 1.10 ms peak in the heaviest scene the brief could name, against
S4.7's 3.0 ms budget for all game logic.

**The heap run's matches were short.** Chrome throttles a tab that has been hidden for a
while, and the loop starved to about half a sim second per match. What the run therefore
measures is **build and teardown across three different modes**, which is what actually
leaks — the map, navmesh, collision hash, roster, HUD, streak entities and every subscription
are constructed and disposed three times. It is not a measurement of three *played* matches.

**Nothing here has been seen.** The pane does not composite, so no screenshot exists of the
thermal pass, the flag rings, the dog tags, the mortar overlay or the streak strip. Every
visual claim above is a DOM assertion or a geometric ray test, not a picture.

### Left for the human

1. **The thermal pass.** Whether a body reads as hot against cold terrain, and whether the
   depth ramp is legible at 40 m. `Renderer.renderThermal` is two small fragment shaders.
2. **The mortar overlay's feel.** `MORTAR_STEER_M_PER_RAD` is 42, tuned so a quarter-turn
   crosses Foundry. Whether that is precise enough to pick a doorway is a hands-on question.
3. **The streak strip and objective banner at a glance.** Both are built and driven by real
   state; neither has been looked at.
4. **The accuracy wall.** The whole point is comparing two groups by eye.
5. **Sentry feel.** 6.9% against moving targets is deliberately fallible. Whether it reads as
   "a turret I can push past" or "a turret that does nothing" is Hard Rule 3, and every number
   is in `DEFAULT_STREAK_CONFIG`.

## What Milestone 8 needs to know

**Streaks are entities with one exit.** `Killstreak.onExpire` is the only teardown, it is
idempotent, and `StreakSystem` guarantees it runs on the timer, on the owner's death, on
`MatchEnded`, on `RoundEnded` and on `dispose`. Anything M8 adds that takes over the camera
should copy that shape exactly — two things that can restore state are two things that can
disagree about whether it has been restored.

**`ObjectiveIntent` is the seam for bot behaviour.** A mode (or a streak) answers "where
should this combatant be and what should it do there"; `ai/` never imports either. A new mode
gets bots that play it by implementing two methods.

**The two-team substrate is load-bearing.** FFA works by making it irrelevant, not by removing
it. Anything that needs genuine N-way sides has to change `ScoreTeam`, `Combatant.team`,
`SpawnSelector`, `Perception` and the killfeed together.

**Determinism cuts both ways.** A fixed `AI_SEED` makes regressions reproducible and makes S&D
rounds repeat. If M8 wants varied rounds, vary the spawn selection per round rather than the
seed, so the *match* stays reproducible.

**Housekeeping.** `Game.ts` is 770 lines, `Match.ts` is 1050 and is now the largest file — the
same shape `Game.ts` had before this milestone, and the obvious next split is the per-frame
HUD filling. Thirty files are over S3's ~400-line guidance. `public/verify/*.js` still ship in
a production build.

### M7 Backlog & Polish (To be addressed alongside or before M8)
**Free For All (FFA):** Bot colors and minimap IFF need fixing. 
All bots must render as orange (enemies), and no friendly dots should appear on the radar.
**Search & Destroy (S&D):** Requires a stricter round loop. 
Change bomb interaction key to 'T'. 
Bomb must be manually picked up at spawn and manually planted. 
Rounds must end immediately upon defuse/explosion, followed by a hard reset where all players respawn at their bases.
**Chopper Gunner:** Fix the thermal shader to grayscale so the map is visible. 
Fix IFF so teammates appear dark and only enemies glow orange. Ensure the Chopper uses its own infinite ammo pool, not the player's weapon ammo.
**Shooting Range:** Spread the accuracy targets horizontally so they don't block each other. 
Ensure bullet decals render properly on these targets. Fix dummy placement clipping (e.g., Infinite DPS dummy spawning inside the ramp geometry).

## What is playable right now

Pick a mode and the game is a different game. Domination puts three flags on Foundry with a
ring on the floor around each one, and the bots genuinely fight over them — some rotate, some
stay home, and the flag you are standing on fills a bar over your crosshair while it changes
hands. Kill Confirmed litters the floor with dog tags that spin and bob and blink when they
are about to vanish, green ones you grab to deny and red ones you grab to score, and bots do
both. Search & Destroy gives you one life, two bomb sites and a best-of-nine, and a planted
bomb starts a light blinking faster and faster while a timer counts down over the crosshair.
Free-for-All is seven other operators and no friends. Underneath all of it, four consecutive
kills gets you a UAV and the minimap starts sweeping — a beam going round with enemies lighting
up as it crosses them and fading before it comes back — unless somebody drops a Counter-UAV and
your map dissolves into bands of interference. Five gets you a care package that falls out of
the sky on a beacon and can be stolen by anybody who stands on it for three seconds. Seven
opens a full map of Foundry you steer with your mouse to drop twelve shells in sequence.
Eight puts a sentry down that misses about as often as a Hardened bot does, which is the point,
and can be shot off its legs. Twelve takes the camera away entirely: you are in a gunship
orbiting the map looking through thermal optics with everything living glowing white, holding a
minigun that winds up before it reaches full rate — and your body is still standing where you
left it, still killable. Take Hardline and every one of those numbers drops by one. Take Ghost
and you stop appearing on their radar. Take Cold-Blooded and their sentries look straight
through you. And the shooting range is a real range now: twelve targets, a dummy that cannot
die so you can measure sustained damage, two that fall over when a burst kills them, a clean
wall at a measured twenty-five metres to shoot groups into, and every weapon and every
attachment unlocked while you are in there.

---

