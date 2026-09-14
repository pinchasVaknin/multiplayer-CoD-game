<!-- Moved verbatim from PLAN.md lines 2585–2836 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# Post-M8 — Polish and Bugfix

A fix pass between M8 and M9, driven entirely by a playtest playbook rather than by a brief.
No new systems except two: a knife, and a QA spectator. Everything else is a defect.

Branch: `m8-hotfixes`.

## The through-line

Seven of the sixteen items turned out to be the *same class of bug*: **two things that are
supposed to describe one fact, disagreeing.** Worth stating up front, because it is the thing
to watch for in M9 — networking doubles the number of places a fact can live.

| Report | The two things that disagreed |
|---|---|
| ADS does not work until rebound | The binding table said `Mouse1`; the DOM says the right button is `Mouse2` |
| Respawn holding the pistol, firing the rifle | `Inventory.activeSlotIndex` reset; the visible mesh did not |
| Camera stuck zoomed after death | `adsFraction` frozen at 1; the weapon that would lower it had stopped stepping |
| Chopper drains primary ammo | The takeover consumed the command; the rifle consumed it too |
| ADS in the chopper hides the crosshair | Same cause — the scope overlay saw a "scoped" rifle nobody was holding |
| Bot colours mixed in FFA | The mode says there are no teams; the mesh and the minimap still read `team` |
| "HOLD P TO PLANT" | The prompt was a string literal; the binding was a table |

## What was built

**The QA spectator** (`debug/Spectator.ts`, `debug/SpectatorPanel.ts`). Three independent
switches, not one mode — god mode, invisibility and free-cam are wanted in different
combinations and the file argues the case. Reachable from F1 → *Spectator (QA)* and from
`__operator.spectate.*`. Invisibility implies god mode, because a grenade already in the air
does not care that nobody is aiming at you. Free-cam is a mode of `PlayerController` rather
than a second camera, so the rig, the viewmodel, the audio listener and the minimap keep
working with no knowledge that it is happening.

**Melee** (`weapons/Melee.ts`). Bound to `V`. Deliberately *not* an inventory slot: a slot is
something you swap to, with a put-away and a take-out, and a knife is something you do while
still holding the rifle. Windup → one-tick strike → recover, with the hitbox test on a single
tick rather than a window, because a swept test lets you knife somebody who walked behind you
mid-animation. Range 2.0 m, 190 damage flat across every zone, and a world segment check
behind the rig search so a knife cannot reach through a wall it is touching.

## Every item, and what it actually was

**1 · Settings scroll sticks.** `swapWeapon` is bound to `WheelUp`, and `Input.onWheel`
called `preventDefault` for anything that resolves to a bit — so the settings list scrolled
down and refused to scroll back up. Fixed at the level the bug lives at rather than with a
wheel special case: `Input.setBindingsActive(false)` while a front-end screen is up, driven
from the state machine. The sim already knew menus do not take input (`sampleNeutral`); this
is the same rule one layer earlier, where `preventDefault` lives.

**2 · Clicking a keybind jumps to the top.** `paint()` rebuilds the screen, so the element
holding `scrollTop` was being discarded. The offset is carried across the rebuild rather than
the rebuild being avoided — and restored *after* insertion, because `scrollTop` on a detached
element is silently ignored.

**3 · ADS dead until rebound.** `MouseEvent.button` is 0 left, **1 middle, 2 right**. M8
shipped ADS on `Mouse1` and labelled it "Right mouse", so the default never fired and
rebinding by right-clicking stored `Mouse2` and worked. Default corrected, `inputLabel`
corrected, and a **save migration v2 → v3** repairs stored tables. The migration is the
interesting part: `normaliseBindings` runs on every load, so a repair there would have
permanently prevented binding ADS to middle mouse. A migration runs once, which is the right
shape for "this stored value was written by a version that was wrong about what it meant".

**4 · Weapon desync on respawn.** `weapons.reset()` put the logic back on slot 0 correctly;
the mesh follows `weapon.swapped`, and a reset is not a swap. `Match.respawnPlayer` now
re-shows the active slot explicitly, asking the inventory which one that is rather than
hard-coding 0.

**5 · ADS stuck after death.** A dead player's weapon is not stepped, so `adsFraction` froze.
Nothing downstream could fix it because the thing that would have was the thing that stopped.
`WeaponSystem.clearAim()` on the tick of death, writing **both** snapshots — leaving `prev` at
full ADS would blend the camera out over a frame instead of cutting, which on a sniper reads
as the zoom sticking.

**6 · Grenades during reload.** Cancels the reload rather than blocking the throw: a blocked
throw is an input the game silently ate, and the magazine is not lost either way because
`Weapon` only banks ammunition on completion. Tested on the press edge, so it fires once.

**7 · Pre-match freeze.** Applied at the *sampler*, which is the only place it can be —
movement is integrated before the match sees the command. `sampleSpectating` is already
exactly the right command (zeroed axes and buttons, live view angles), so the countdown reuses
it. Bots freeze too, via `BotDirector.inputFrozen`: they keep *thinking* — perception,
tactical and pathing all run — and only the movement axes and action bits are stripped, so the
round going live reads as a starting gun rather than a room of statues booting up. Also covers
`ROUND_END`, so a decided S&D round stops producing deaths.

**8 · Bad spawns.** Two real bugs and one design gap:

- The least-bad fallback compared an *unpenalised* score against a *penalised* best — two
  scales either side of one `>`. Since a penalised best sits near -100, essentially every
  later candidate cleared it, so "best" collapsed to "nearly the last one examined". That is
  the tier that runs most often in FFA, and it was returning an arbitrary point.
- Proximity inside the 15 m rule was linear, so a 3 m spawn scored 3 against a 12 m spawn's
  12 — a gap the recency penalty could outvote. Now penalised at four points a metre.
- **FFA drew from half the map.** The two-team substrate confined eight independent hostiles
  to their own side's spawn zones. There are no sides in FFA, so there is no reason to hold
  half the candidates back.

Measured over 50 s of eight-way FFA on Foundry: **20 spawns, 0 least-bad, 0 visible to an
enemy, nearest enemy never closer than 18.7 m.**

**9 · FFA colours and minimap.** Bots draw from a palette-derived hostile material in FFA;
`MatchHud` draws no friendly chevrons and pings every shot but your own. TDM is untouched —
verified: two distinct team colours and four friendly dots.

**10 · S&D.**

- Interaction key `P` → `T`, and the HUD prompts now read the *live* binding instead of a
  hard-coded letter. The migration moves `KeyT` to the front of the pair so a migrated save
  is prompted with the key the playbook asked for.
- Auto-pickup off for the player, via `manualPickupId`. Bots keep walking onto the bomb, and
  not as a concession: a bot's entire interaction vocabulary is *arriving somewhere*, and
  giving it a synthetic key press would be inventing an input path for the one participant
  that does not have one.
- **The round already ended on the detonation tick** — `checkWinCondition` consults the
  outcome that `explode`/`stepDefuse` set, on the same tick. What read as a delay was the
  shared four-second round-end hold. `GameMode.roundEndSeconds` is now per mode and S&D
  holds for 1.5 s.
- Hard reset on `round.started`, gated on `ModeEntry.usesRoundReset`. Bypasses the respawn
  gate deliberately: with one life the gate's answer is permanently "no", which is correct
  for a death mid-round and exactly wrong for the round boundary. Living players are
  respawned too — a survivor left standing on a bomb site is a free plant.
- Defuse visuals: whoever is interacting is forced to crouch (`PlayerController.forceCrouch`,
  folded into `crouchHeld` so every existing crouch rule still applies), and a progress ring
  grows around the bomb — friendly green for a defuse, neutral amber for a plant. The
  "hold to defuse" prompt is replaced for everybody else by what is actually happening,
  because the mode would refuse a second defuser anyway.

**11 · Chopper Gunner.** `WeaponSystem.suspended` takes the trigger, the sights *and* the
reload away from the rifle standing on the ground — which fixes the ammo drain and the hidden
crosshair together, because they were one bug. ADS now zooms the gunship optic (55° → 22°).
The view is a three-pass render: grayscale world, then allies near-black, then enemies orange,
split by two scene-graph groups so the pass never learns what a team is. The world shader was
lifted substantially — ambient more than doubled, range falloff halved, and a second key added
because a single overhead key left every horizontal surface at one flat value and Depot read
as a sheet of grey.

**12 · Depot lighting.** The hemisphere goes 0.62 → 0.95 with a much lighter ground term. The
fix is in the *fill*, not the masts: the masts are `decay: 2` points, so raising them would
blow out the pools and leave the gaps between them just as dark. Lifting the hemisphere raises
the floor of the image and leaves the lit parts nearly untouched.

**13 · Shooting Range.** Three separate defects behind one report:

- The three bullseyes all sat at the same `z`, so from the firing line they were at 13.5°,
  7.6° and 5.5° — in a line. Re-fanned, with the laterals chosen so no board falls inside the
  shadow cone a nearer one casts, and each `x` solved so the straight-line range is exactly
  the number written on it. The measured dummies were re-fanned by the same rule (the 15 m
  dummy was standing in front of the 40 m one).
- **No decals appeared** because the ring plates were `solid: false`: rounds passed through
  every ring and stopped on the backing board, where the decal landed *behind* the plate that
  was supposed to be showing it. The rings are solid now. Static dummies also mark, via
  `Damageable.decals` — movers deliberately do not, because a decal is placed in world space
  and would slide off them.
- Dummies were **buried** — the near faller inside the 0.3 m step, the DPS dummy inside the
  1.5 m ledge. Fixed by probing the real collision world at construction rather than by
  hand-correcting two `y` values, because the range sits on a testbed whose geometry exists
  to be moved.

**14 · Step-up.** `stepHeight` 0.35 → 0.5, with `mantleMinHeight` moved to 0.55 so the two
ranges stay disjoint — an obstacle that is both silently stepped and vault-detected would give
you a different animation depending on your approach speed. The step-up gate also changed from
`rise > stepHeight * 0.5` to an absolute 4 cm: the old test scaled with the config, so raising
`stepHeight` also raised the *ceiling clearance* required before a step was attempted, and the
setting fought itself under a low soffit.

**15 · Z-fighting.** The authoring bug was in the range: 2 cm plates spaced 2 cm apart have
*precisely coincident* faces. Fixed there, and guarded generally — the two materials every map
uses for decorative overlays (`accent`, `hazard`) now carry a negative `polygonOffset`, so a
trim brush wins the depth test against whatever it decorates however flush the author left it.
Fixed-function, costs nothing, and moves no geometry — collision, AO and the navmesh are
untouched.

## Deviations, and why

**The round-end "30-second delay" was not found.** The decision has always been same-tick, and
the code path is short enough to state: `explode()` sets `roundOutcome`, `checkWinCondition`
returns it on the same tick, `MatchFlow.endRound` runs immediately. The only delay that
existed was the four-second hold, which is now 1.5 s for S&D. If a longer delay is still
observed in play, it is something this pass did not reproduce and it should come back with a
repro — that is a more useful bug report than a number.

**Melee is one damage value, not a front/back split.** The playbook asked for "lethal or
extremely high"; 190 flat across every zone is the former and is simpler than a directional
model nothing else in the project has.

**Bots do not knife.** Adding it means a new approach behaviour in `BotBrain`, which is
M9-sized work for a feature the playbook asked for as a player verb.

## Verification

Typecheck and production build clean. Driven in a real browser against the live sim
(`g.simulate(tick)` directly, because the pane was not compositing and rAF does not fire):

| Claim | Measured |
|---|---|
| Right mouse aims | `bitsFor('Mouse2')` = 8 (`Btn.Ads`); was 0 |
| Middle mouse is free | `bitsFor('Mouse1')` = 0 |
| Use is on T | `bitsFor('KeyT')` = 65536; `KeyP` = 0 |
| Melee is on V | `bitsFor('KeyV')` = 131072 |
| Migration repairs a v2 save | `ads: ['Mouse1'] → ['Mouse2']`, `use: ['KeyE','KeyP'] → ['KeyT','KeyE']` |
| Wheel reaches the settings list | `defaultPrevented` false both directions |
| Keybind click holds position | scrollTop 762 → 762, row armed |
| Countdown freezes | 0.00 m moved holding W during WARMUP; 3.43 m in the first second of LIVE |
| Bots freeze with you | `bots.inputFrozen` true in WARMUP, false in LIVE |
| Knife kills | 100 → 0 HP, `lethal: true`, at 1.2 m in the open |
| Knife respects walls | refused at 1.3 m with a collider at 0.75 m |
| Respawn resets the weapon | died on slot 1 (TALON 9, model 1) → slot 0, model 0, M4 CARBINE |
| Death drops the sights | ADS 1.0 → 0.0 in weapon, `prev`, `curr` and the interpolated visual |
| God mode | 12 lethal applications, 100 → 100 HP, not dead |
| Invisible | `active` false, `participating` false |
| Free-cam | rose exactly 10.0 m in 1 s on Space (`NOCLIP_SPEED`), not grounded |
| Spectator restores | all three flags back, `spectate.state()` = "off" |
| FFA is all-hostile | all 7 bots `#8f4138`; 0 friendly minimap dots |
| TDM is untouched | `#4a5a72` / `#6e5a44`; 4 friendly dots |
| FFA spawns | 50 s, 20 selections, **0 least-bad**, **0 visible**, min enemy 18.7 m |
| Candidate pool | 96 → 224 |

## Left for the human

1. **Look at the gunship.** The grey/black/orange split is argued from what a filter cannot
   do; whether allies actually read as *allies* at 60 m needs eyes. `__operator.giveStreak`.
2. **Depot at 0.95 hemisphere.** The number is chosen to lift the floor of the image without
   touching the pools. Whether it still reads as night is a judgement.
3. **The knife's reach and cooldown.** 2.0 m and 0.72 s are the two numbers that decide
   whether it is a panic button or a playstyle.
4. **Step height 0.5 m.** It should feel like nothing. If it feels like the player is
   floating up kerbs, it is 0.05 too high.
5. **Whether the S&D round-end still feels slow** at 1.5 s.

## What multiplayer needs to know

The seam is already real and has been since M1, which is the whole reason it was built that
way — this is the milestone that collects on it.

- **`InputCommand` is the wire format.** Fixed layout, no DOM types, edge detection computed
  in the sim from the bitfield. Every input added since — killstreaks, Use, and now Melee —
  went in as a bit rather than as a handler, so nothing bypasses it.
- **`INetworkTransport` is already in the path.** `LocalBotTransport` submits and drains every
  command in single player. A real transport replaces one object.
- **A bot already *is* a remote command source.** `Bot.advance` writes a command and hands it
  to the same `PlayerController` the human's goes to. There is no second movement code path to
  reconcile.
- **The sampler is the one place that decides what a player may send.** Neutral, spectating,
  frozen and live are four samplers behind one call site in `Game.simulate` — which is where a
  server's authority over a client's input belongs.
- **Two things are *not* ready and should be scoped honestly.** The spawn selector, the
  killstreak system and the mode flow all assume one local player (`PLAYER_ENTITY_ID`, and
  `Match` is built around a single `PlayerCombatant`). And nothing is currently
  server-authoritative: `Ballistics` applies damage directly on the shooter's machine.

---

