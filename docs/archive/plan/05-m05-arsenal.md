<!-- Moved verbatim from PLAN.md lines 1251–1672 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# Milestone 5 — Arsenal

Twelve weapons, five attachments, five pieces of equipment, and the balance work that makes
them mean something. M2 promised that "M5 adds eleven more entries to `WeaponDefs.ts` and
writes no new classes to do it". That held: **no weapon in this milestone is a subclass**, and
every behavioural difference between the twelve is a number on a `WeaponDef`.

The genuinely new code is four things the data could not express on its own — a pellet loop, a
scope, a two-slot inventory, and a pure attachment resolver — plus `equipment/`, which is a
subsystem rather than a weapon.

## What was built

**Weapons (`src/weapons/`)**
`WeaponDefs` reduced to the schema, the registry and the helpers; the twelve weapons moved to
`defs/` (`assaultRifles`, `smgs`, `shotguns`, `lmgs`, `snipers`, `pistols`), because twelve
hand-authored recoil patterns is four hundred lines of *content*. `Attachments` (the five
trade-offs, the pure resolver, and the purity verifier), `Inventory` (two slots and the swap
machine), `Scope` (breath sway, hold-breath, glint), `WeaponModelSpecs` + `WeaponMeshParts`
(twelve viewmodels as proportions rather than twelve coordinate lists). `Recoil` grew
`aimWithOffset` and `pelletOffset`; `WeaponSystem` grew the pellet loop, the swap and the
scope; `WeaponBase` grew `handlingSeconds` and `stepHolstered`; `WeaponTuning` grew the new
keys and a `scope.*` group; `ViewmodelAnim` grew a swap pose and per-weapon sight-height
compensation.

**Equipment (`src/equipment/`)** — a new directory. `EquipmentDefs` (frag, semtex, flashbang,
smoke, claymore, each carrying a `WeaponDef`-shaped `damageProfile`), `EquipmentConfig`,
`Projectile` (the integrated arc through the existing swept collision, plus
`previewTrajectory`), `SmokeField` (density-based occluder), `FlashField` (angle- and
LOS-scaled blindness), `EquipmentSystem` (fuses, detonation, claymore triggers, the threat
indicator), `ThrowController` (the player's cook and release), `BotThrower` (tier-gated, with
the self-safety check), `EquipmentFx`, `EquipmentAudio`.

**Combat (`src/combat/`)** `HitboxRig` gained an `upper` flag on the chest box and
`RigHit.upper`; `DamageSystem` gained `upperTorso` on the request and in `zoneMultiplier`;
`TargetDummy` gained a measured TTK read-out and a mutable position; `TargetRange` was
re-laid out at exactly 5/15/25/40 m.

**AI (`src/ai/`)** `Perception` gained a `SightOccluder` and a `BlindSource` (both null by
default, so every M3 measurement still describes the same system) and a glint bypass on the
cone; `Combatant` gained `glinting`; `DifficultyTiers` gained the four grenade fields S6.7
listed and M3 deliberately left out.

**UI (`src/ui/`)** `HudTactical` (weapon plate, equipment counters, cook timer, breath meter,
grenade indicator, flash white-out, scope overlay), `PauseMenu`. `Hud` composes both.

**Root** `MatchEquipment.ts`, the equipment composition root, split out of `Match` for the
same reason `MatchFeedback` was. `Game` gained the `PAUSED` state.

**Debug (`src/debug/`)** `ArsenalHarness` (the TTK table, attachment deltas, pellet spread,
the slide-cancel measurements), `ArsenalPanel` (weapon picker, attachment chips,
base-vs-resolved diff, twelve overlaid pattern plots, pellet plot, clipboard export),
`EquipmentPanel` (trajectory preview, smoke-occlusion visualisation, flash angle report,
sliders). `public/verify/arsenal.js` is the acceptance suite.

**Docs** `docs/BALANCE.md` — the measured TTK table and the slide-cancel retune report.

## Deviations, and why

### 1. `src/equipment/` is a directory S3 does not name — required

The alternative was `weapons/`, which is already the largest package in the project and whose
contents are all "a thing you shoot". A frag is a thrown, fused, bouncing volume that damages
by radius and blinds by angle; it shares exactly one thing with a rifle, and that one thing is
deliberate:

**An explosion is a `WeaponDef`.** Every piece of equipment carries a `damageProfile` shaped
like a weapon, so radial damage goes through `DamageSystem.apply` unchanged. M3's rule — damage
has exactly one door — survives, a grenade kill appears in the killfeed with no special case,
and the F1 read-out prints a grenade the same way it prints a bullet.

### 2. The headshot multiplier came down from 2.0 — predicted by M2

M2's own "problems found in the brief" note said: *"a 2.0x headshot multiplier is very strong
for an assault rifle… M5 should expect to bring it toward 1.3-1.5x when the arsenal has weapons
that are supposed to one-shot."* It is now 1.45–1.55 on everything except the snipers (1.8 and
1.95). This changes M2's verified head figure of 68.00 to 51.00 for the carbine; the mechanism
is untouched and `measureZones` still reads it back out of `DamageSystem.lastHit`.

### 3. "Upper torso" is a flag on a hitbox, not a fifth zone

S6.1 wants the snipers to one-shot the upper torso. The M2 rig already splits the torso into
`chest` and `abdomen`, so `HitboxDef.upper` marks the chest and `WeaponDef.upperTorsoMult`
applies to it. A weapon that leaves the multiplier at 1.0 — every weapon but the two snipers —
behaves *exactly* as it did in M2, which is what keeps every M2 number verified. A fifth
`HitZone` would have changed the meaning of `torso` everywhere and invalidated all of them.

### 4. `ScopeProfile` has no `scopeInTime`

S6.1 gives snipers "0.35 s scope-in". That is `adsTime`, and the KESTREL's is exactly 0.35.
A second timer beside it would be a field that either duplicates `adsTime` or lies about it;
the VANTAGE is slower (0.44 s) because it is semi-automatic, which is a balance decision
rather than a different mechanism.

### 5. Firing while sliding is now legal, and the slide no longer lowers the weapon

From the M4 playtest notes. The cost moved from "you cannot shoot" to a spread penalty — a
slide is treated as airborne in `SpreadContext`, so the cone opens by `airScale`. This is the
change that made S6.5's slide-cancel question worth asking, and it is why the answer had to be
measured rather than assumed.

### 6. Twelve viewmodels are a function of a spec, not twelve coordinate lists

M2 hand-placed the AR's boxes, which was right for one weapon. Twelve hand-placed weapons is
twelve lists that drift apart the first time a sight height changes, so the geometry became a
function of a `WeaponModelSpec` and the specs became the content. The carbine's spec reproduces
M2's proportions exactly. `ViewmodelConfig.adsY` is still one number: each weapon's ADS pose is
derived from it by the difference between its sight height and the carbine's.

### 7. The materials are process-wide, not per model

M2 built three 128 px canvases per weapon model. Twelve weapons rebuilt every match would be
thirty-six canvas generations and thirty-six GPU uploads on the frame a match starts, for three
distinct images. `sharedSurfaces` caches them; `disposeWeaponSurfaces` exists for a page
teardown that does not currently happen.

### 8. Bots carry no secondary

`WeaponSystem` takes `secondary: WeaponDef | null` and every bot passes null. Nothing in `ai/`
swaps weapons, and a holstered pistol a bot will never draw is a second magazine to keep in
sync for nothing.

### 9. Bot grenade policy lives outside `BotBrain`

`BotThrower` is driven from `MatchEquipment` at one bot per tick rather than from the 4 Hz
`decide` loop. `BotBrain` is already the largest file in `ai/` at 648 lines, and grenade policy
needs the collision world and the equipment system, neither of which the brain has. The safety
check runs the *real* integrator (`previewTrajectory`), so "where would this land" is answered
by the thing that decides where it lands.

### 10. Smoke has a render cull that the occluder does not share

`EquipmentFx` stops drawing a cloud's billboards past 38 m. `SmokeField.blocksSight` knows
nothing about it, so a cloud you cannot see still blocks the line of sight through it — only
the picture is culled, never the gameplay. Added after the first frame-time run: eight clouds
at eleven transparent quads each was measurably the largest cost equipment added.

## Bugs found by verification, and fixed

All four were found by measurement, and two of them were the *instrument* rather than the game —
which is worth recording, because both produced confident, wrong numbers first.

1. **Every cell of the first balance table was measured at 10 m.** `ArsenalHarness` moved the
   target's rig to the requested range, but `TargetDummy.step` re-wrote the transform from its
   *spec* position on the next tick. The table looked plausible — the carbine read 3 shots at
   40 m, which is impossible for 26 damage — and that impossibility is what gave it away.
   `TargetDummy` now has a mutable base position.
2. **The laser's measured hip cone was 3.99° for a 1.9° weapon.** The harness spawned the
   player at 0.2 m and read the spread on tick zero, while they were still airborne — and
   `airScale` is 2.1. The *delta* was right (exactly −20%) and the absolute figure was
   nonsense. It now steps thirty ticks to let them land.
3. **The pellet report counted misses as torso hits.** `lastPellets.zones` carries a default
   for pellets that found nothing, so the first run claimed eight zone hits out of five landed
   pellets. Filtered on `targets[i] >= 0`.
4. **The trigger cannot be held during a slide run-up.** M2 made firing suppress sprint, so the
   first version of `measureSlideEntry` never reached the 0.3 s slide gate and reported that no
   slide had happened at all. The policy now pulls the trigger on the tick the slide begins,
   which is also what a player does.

## Problems found in the brief

Deliverable 4 asks for these explicitly.

1. **"Lengthen the lockout" is aimed at the wrong number.** S6.5 asks whether sliding into a
   room beats the fastest ADS and says to lengthen the tac-sprint lockout if it does. Measured:
   it did, by 45 ms — and that 45 ms lived in `sprintOutTime` on three weapon defs, not in the
   movement rule. The lockout governs *chaining*, and chaining measured `fireableFraction =
   0.000` over thirty adversarial seconds: a player moving at 7.9 m/s cannot shoot at all. Both
   changes were made — the lockout went to 1.25 s as instructed, and the three fast weapons went
   to 0.18 s, which is where the problem actually was. See `docs/BALANCE.md`.
2. **"8 pellets, one-shot inside 6 m" is only satisfiable with a stated cone.** Eight pellets
   at 18 damage is 144, but what matters is how many land. At `pelletSpread` 2.6° the cone is
   0.27 m across at six metres against a 0.46 m chest, which puts six on target for 108 — a
   kill. At 3.5° it would not be. The pellet count and the damage are meaningless without the
   cone, and the brief gives only the first two.
3. **"Scope glint visible to enemies" needs a rule for what a bot does with it.** Implemented as
   a bypass of the vision cone but *not* of line of sight: a glint is what makes you turn round,
   and you still cannot see one through a wall. The brief says it is visible and not what
   visible means.
4. **A shotgun with a hard range wall is unusable, not spiky.** The first table had the BREACHER
   unable to kill *at all* at 15 m inside six seconds. That is maximally spiky and nobody would
   carry it; `far` went from 4 to 7 so it is a four-shell grind out there — hopeless, but a
   fight. "Spiky" needs a floor.
5. **Frame-time p99 still cannot be measured honestly in a non-compositing tab.** Same finding
   as M1–M4, and the numbers below say so plainly.

## Verification

`fetch('/verify/arsenal.js').then(r => r.text()).then(eval)` then
`await __verifyArsenal.all()`; see DEBUG.md. Every number was measured on this build.

| Criterion | Result |
|---|---|
| 1. Twelve weapons functional | All twelve equipped through `Match.equip` — which rebuilds the viewmodel — and fired through the real `WeaponSystem`. Rounds consumed over an identical 40-tick window track RPM exactly: 8 / 7 / 10 / 6 / 12 / 9 / 2 / 8 / 9 / 1 / 3 / 5 for 700 / 620 / 820 / 480 / 1000 / 780 / 90 / 650 / 800 / 48 / 200 / 400 RPM. Twelve distinct viewmodels build, with sight heights 0.042–0.118 m. |
| 1. Twelve distinct patterns | Pattern lengths 5–40 steps; 30-shot accumulated climb **6.24° to 129.90°**; lateral drift **−10.68° to +6.00°**; direction reversals **0 to 26**. Closest pair over all 66 comparisons is WASP 9 vs MERIDIAN P40 at **0.788° RMS**. All twelve are overlaid in one plot in the F1 *Arsenal* panel. |
| 1. Twelve distinct voices | Body bands span **395–1950 Hz** with the closest pair **75 Hz** apart. The LMG/SMG pair S6.1 names — BASTION 545 Hz / 0.68 s tail against WASP 1950 Hz / 0.17 s tail — is a 3.6x ratio in centre frequency and 4x in tail length. |
| 2. `docs/BALANCE.md` | Measured, 12 weapons x 4 ranges x 2 zones, both tables. Measurement takes ~40 ms and is one button in the F1 panel. |
| 3. Attachment purity | 5/5 checks pass: base unmodified; three distinct roots; `spread`/`recoil`/`damage`/`falloff`/`voice` all separately cloned; **writing 99 into one resolved def leaves the other and the base untouched**; effects landed. |
| 4. Attachment costs measured | Optic **+39.2 ms** ADS (280.0 → 319.2) for a 0.180° → 0.130° aimed cone. Foregrip **+24.3 ms** ADS (280.0 → 304.3) for recoil scale 1.00 → 0.75. Laser hip cone **1.900° → 1.520° (−0.380°)**, read out of a live `WeaponSystem.spreadDeg`. Suppressor range 42.0 → 37.8 m. Extended mag 30 → 45 rounds, reload 2.050 → 2.563 s. |
| 5. Mixed pellet spread | BREACHER aimed at the neck at 4 m and 6 m: **3 head + 2 torso pellets, 111.6 damage, lethal**. At 8 m: 2 head + 2 torso + 1 arm, 84.0, not lethal. At 10 m: 66.4. Every pellet is an independent hitscan ray resolved against the rig. |
| 6. Smoke blocks bot perception | VULTURE → KESTREL at 19.3 m. **Clear: optical depth 0.00, not blocked. Smoked: depth 5.38 against a threshold of 1.0, blocked, and 117 perception rejections. Cleared: depth 0.00, not blocked.** Measured through the real `Perception`, not by calling the occluder directly. |
| 7. Flash scales with angle | Point blank with line of sight: **0° = 1.000, 45° = 0.696, 90° = 0.403, 135° = 0.273, 180° = 0.213** — 3.00 s, 2.09 s, 1.21 s and 0.64 s of blindness. Without line of sight at 0°: **0.250**. At half range at 0°: **0.500**. |
| 8. Slide-cancel retune | Reported in full in `docs/BALANCE.md`. Slide entry 8.000 m/s, fireable after **0.217 s** and **1.702 m**, still doing 7.610 m/s. Fastest ADS 0.175 s; fastest sprint-out was 0.120 s and is now **0.180 s**. Lockout 1.00 → **1.25 s** (measured back at 1.250). Peak sustained 7.943 → **7.897 m/s**, peak instantaneous 8.200. **Chained slide-cancel `fireableFraction` = 0.000 over 30 s and 22 slides.** |
| 8. Bot aim at the tuned ceiling | 45 s, 10 bots, live firefight: **REGULAR 13.3% (27/203, 4 kills), HARDENED 15.3% (35/229, 6 kills), VETERAN 18.4% (50/272, 18 kills)** — monotonic in both hit rate and kills, which M3's live figures were not. AI **p50 0.20 ms, p99 1.00 ms, mean 0.224 ms** over 2701 samples. 0 stuck events. Spawns: 0 visible violations, minimum enemy distance 16.06 m. |
| 9. Frame time | See the note below. Sim-side, under a deliberate over-load: **equipment 0.0–0.2 ms, mode peak 0.7 ms, HUD peak 1.1 ms, sim 0.0–0.7 ms** against S4.7's 3.0 ms budget. In the one window where the pane genuinely composited, a 10-bot firefight held **p50 16.7 / p95 16.8 / p99 17.0 ms** — vsync-locked 60 Hz — both with bots throwing and with them not. |
| 10. `tsc --noEmit` | Clean, with M1's full strict set. Zero `any`, zero `!`, zero `@ts-expect-error`, zero TODOs. |
| 10. Console | Clean through all twelve weapons, a swap, all five pieces of equipment, a pause and a resume: Vite's own messages, the verify script's own `info` lines, and the embedded pane's pointer-lock rejection (`WrongDocumentError` — the canvas is in a nested document Chrome will not grant lock to). No pool warnings, no errors. |
| S4.5 audio graph | No `ConvolverNode` is constructed anywhere in `equipment/` or the twelve voices — every sound is `noiseBurst` or `oscHit` on the existing pooled voices and the one send. |

### The frame-time caveat, again

Under the substituted `MessageChannel` frame source the p95/p99 varied between 33 and 47 ms
across four runs of the *same* load, while the sim-side numbers stayed at 0.0–0.7 ms
throughout. That spread is the frame source and the environment, not the game — the same
finding M1 through M4 recorded. The two numbers worth trusting are the sim-side costs, which
are an order of magnitude inside budget, and the single genuinely-composited window at a
locked 60 Hz.

The load itself is deliberately unreasonable: three grenades every 0.9 s for thirty seconds on
top of a live ten-bot firefight, which fills the eight-cloud smoke pool and keeps it full. 106
thrown, 97 detonated. Ordinary play — bots throwing on their own 12–22 s cooldowns — produced
7 to 21 throws in the same window.

### Left for the human

The Browser pane composited for exactly one measurement window and was `visibilityState:
"hidden"` for the rest, so **almost nothing below was ever seen**. These need eyes:

1. **Do twelve weapons read as twelve weapons?** The specs are authored to be distinguishable
   at a glance in the lower right of a moving screen — drum and bipod on the LMGs, tube
   magazine and pump on the shotgun, no stock on the bullpup, a scope you can see the objective
   bell of on the snipers. Whether that survives contact with the actual FOV is unverified.
2. **Feel, which is Hard Rule 3 and the one thing no harness reaches.** Do the twelve patterns
   read as learnable and *different*? Does the WASP's 0.117 s kill feel like the reward its
   falloff cliff is paying for? Is the scope sway a mechanic or a nuisance? Every number is a
   slider under F1 and COPY CONFIG writes them back out as source.
3. **The audio.** Twelve voices were authored against three numbers and verified as *numbers*.
   "An LMG and an SMG identifiable with your eyes closed" is a claim about ears.
4. **The Foundry lighting fix.** Hemisphere 0.78 → 1.35 with the ground colour lifted, key
   2.0 → 2.35, exposure 1.05 → 1.25, fog pushed from 38 m to 55 m. The diagnosis — that the
   *fill* was the problem rather than the key — is an argument, not an observation.
5. **The pause screen, the scope overlay, the flash white-out and the grenade indicator.** All
   four are DOM and CSS that have been exercised in code and never rendered.
6. **Smoke as a picture.** The occlusion is verified as a number (117 perception rejections);
   whether the billboards read as a volume you cannot see through is a different question.
7. **`__operator.runMatches(10)`** with equipment live — the M4 heap harness has not been
   re-run since `equipment/` was added, and `MatchEquipment.dispose` is the new thing that
   could leak.

## M5 hotfixes — reported in playtesting, fixed immediately after the milestone commit

Three, and the first was a defect that had been latent since M1.

### 1. The pause menu's buttons were unclickable — a CSS specificity bug

`app.css` granted pointer events with `#ui-root > * { pointer-events: auto }`. That selector
is specificity (1,0,0) and therefore silently outranked `.hud { pointer-events: none }` at
(0,1,0) — so the HUD, which is a full-screen element, had been quietly *accepting* clicks for
four milestones. Nothing was underneath it until M5 put the pause screen there.

Measured before the fix, hit-testing the centre of the Resume button:

    stack: [hud-dirs, hud-hurt, hud-low, hud-numbers, hud, op-btn, op-screen--pause, CANVAS]

Five HUD layers above the button. Fixed by making interactive layers opt *in* by class
(`.op-screen, .sb, .dbg-root`) rather than being granted by an ID selector, so a child that
declares `pointer-events: none` is believed. `.op-screen` also gained `z-index: 10`, because
a modal state overlay should be above the in-match UI and the HUD is appended to `#ui-root`
later than the pause screen is.

After: all three buttons hit-test to themselves, and `.hud` computes to `pointer-events: none`
as its own rule always intended.

### 2. Pointer lock did not come back on resume

Two failure modes, one fix. Resuming with **Escape** has no user gesture at all, so
`requestPointerLock` can only ever be rejected; resuming with the **button** does have one,
but Chrome refuses a re-lock for a short window after the user has left the lock with Escape,
so it lands inside the cooldown often enough to feel broken.

`Input.armPointerLock(on)` now arms click-to-recapture for the whole time a match is live:
while armed and unlocked, a click re-acquires the lock. That click is **consumed** rather than
passed on — verified: magazine 30 before, 30 after, so the click that gets you back into the
game does not also fire your weapon. Armed in MATCH, disarmed in PAUSED (a click there belongs
to the buttons) and in MENU. The rejection warning is throttled to once per arming so a
platform that refuses lock outright does not fill the console.

### 3. The pistol filled the screen at ADS

Two causes, and the second was the bigger one.

- The shared ADS pose puts every weapon's receiver centre at the same distance. On a 0.17 m
  pistol that is far closer to the eye, in useful terms, than on a 0.75 m rifle.
- **The hands were a rifle's.** `bodyBoxes` placed a support hand and a 0.19 m forearm out on
  the handguard — and the pistol's `handguardLength` is 0, so `supportZ` collapsed back to the
  receiver and put a forearm between the sights and the camera.

Fixed by giving `WeaponModelSpec` an `adsOffsetZ` (pistol: −0.13 m, zero on everything else)
and by holding a weapon with no handguard in two hands *on the grip*. Measured at full ADS,
nearest point of the weapon to the eye:

| Weapon | Nearest point | Silhouette height |
|---|---:|---:|
| WASP 9 | 0.009 m | 0.330 m |
| M4 CARBINE | 0.035 m | 0.349 m |
| **TALON 9** | **0.134 m** | **0.318 m** |
| MONOLITH 60 | 0.189 m | 0.518 m |

The pistol is now further from the eye than seven of the other eleven weapons and has the
smallest silhouette of the twelve.

**A vertical correction was tried first and reverted.** `adsOffsetY: -0.012` moved the sights
12 mm off the screen centre — about 5 degrees at that distance. The sight-height compensation
has already put the sight line on the camera axis, and moving along that axis is the only
correction that does not leave it. `adsOffsetZ` is Z-only for that reason.

### A real bug the pistol measurement exposed

Checking that the fix had not moved the sights turned up that **M5's sight-height compensation
ignored `spec.scale`**. The viewmodel root is scaled, so a weapon at 1.08 has a sight line 8%
higher than its spec says, and the compensation was cancelling the unscaled number. Measured
error ran to 8.3 mm on the MONOLITH — roughly 2.5 degrees, a visibly misaligned sight picture
on the six weapons whose scale is not 1. `WeaponModel.sightHeight` is now the *effective*
height with scale applied; all twelve weapons now measure **−0.61 mm**, identically, which is
the residual of `ViewmodelConfig.adsY` itself. One number to tune, twelve weapons following it.

### Also

Entering PAUSED hides the F1 overlay and remembers whether it was open, because a large
interactive panel over a modal screen is the clash that was reported. The pause menu's DEBUG
OVERLAY button brings it back deliberately, and resuming restores whatever the player last
chose.

`__operator.pointer()` reports `{ locked, armed, keyboardCapture }` — pointer-lock state is
otherwise unobservable from a verification script.

## What Milestone 6 needs to know

**A weapon is still only data.** Twelve exist and none of them is a subclass. If M6's loadout
editor needs a thirteenth, it is a record in `weapons/defs/` and a `WeaponModelSpec` — nothing
else. `ALL_WEAPONS` is the registry and `weaponsOfClass` filters it.

**Attachment resolution is pure and that is load-bearing.** `resolveWeaponDef(base, ids)`
returns a new def every time. A loadout editor may call it per keystroke without caching, and
two players may hold the same base weapon with different attachments — which is exactly what
`verifyAttachmentPurity` checks and what M7's killstreaks must not break.

**`unlockLevel` is authored on all twelve and enforced nowhere**, as S9 requires. The values
run 1 to 38 and are ready for M6 to gate against.

**The inventory has two slots and the swap is `raise`.** `Inventory` drives `Weapon.raise` via
`handlingSeconds` rather than adding a parallel animation state, so `canFire` needed no new
clause — a weapon half-drawn is a weapon at `raise < 1`, which already cannot fire. A third
slot would be `weapons.push` and a new `Btn` bit.

**Equipment damage goes through the one door.** Every `EquipmentDef.damageProfile` is a
`WeaponDef`. A killstreak that wants to hurt somebody should do the same thing rather than
adding a second damage path — M3's note, still true, and now true of explosions too.

**`Perception` has two injection points and both default to null.** `occluder` and
`blindSource` are how smoke and flashes reach the AI. Anything else that should stop a bot
seeing — an M7 counter-UAV, a smokescreen killstreak — implements `SightOccluder` and assigns
it, and every M3 measurement remains a description of the same system with them null.

**The world is still per-match and `MatchEquipment` is new in that mirror.** It subscribes to
seven events and adds a group to the scene; `dispose` drops all of it and nulls the two
`Perception` hooks. The heap harness has not been re-run since it landed — see above.

**`PAUSED` sits beside `MATCH`, not inside it.** The world stays built and `Game.simulate`
returns early. Anything M6 adds that runs on the render pass will keep running while paused,
which is intended for the camera and the HUD and would be wrong for a progression timer.

**Housekeeping.** Twenty-two files are over S3's ~400-line guidance. This milestone split
`WeaponDefs` into six def files, `WeaponMesh` into `WeaponMesh` + `WeaponMeshParts`, `Match`
into `Match` + `MatchEquipment`, and `Hud` into `Hud` + `HudTactical` — but `Game.ts` (769),
`ArsenalHarness.ts` (688), `Match.ts` (681), `Hud.ts` (657) and `AudioGraph.ts` (653) are all
over, and `Game.ts` remains the one to split next along the world-lifecycle seam.
`public/verify/*.js` still ship in a production build — now six files.

### M5 Playtest Feedback (To be implemented DURING M6)
**Firing Range / Testing Map:** The user wants to test the 12 new weapons. 
Please re-enable the M2 grey-box firing range as a dedicated, 
selectable "Shooting Range" game mode in the main menu (with zero enemy bots and active DPS/damage dummies) 
so all weapons can be tested freely once the Loadout system is built.
**Bot Accuracy Scaling:** Although bot aim logic exists, they feel too accurate at long distances. 
Please verify that weapon-specific spread and distance-based accuracy falloff are effectively penalizing bot aim vectors at longer ranges.
**Debug Overlay (F1) UX Overhaul:** Remove the `F1` hotkey binding during active gameplay to prevent pointer lock and UI conflicts. 
The Tuning/Debug overlay should now *only* be accessible via a dedicated button inside the PAUSE menu. 
Add a clear "X" (Close) button to the overlay itself. 
Finally, fix the `ESC` stack: pressing `ESC` while the overlay is open should close the overlay and return to the PAUSE menu, not unpause the game entirely.

## What is playable right now

Drop into Foundry and there are twelve guns to pick from — press F1 and the *Arsenal* panel is
a row of names, and clicking one puts it in your hands with its own silhouette, its own rate,
its own sound and its own recoil. They are genuinely different: the WASP kills in an eighth of
a second inside seven metres and then falls off a cliff so hard it needs seven rounds at
twenty; the LONGBOW takes a quarter second to kill at *any* range up to forty and paints a
zig-zag if you hold the trigger; the KESTREL kills anything you can see with one round in the
chest and gives you 1.25 seconds to regret a miss, with a scope that sways until you hold Shift
and a glint every bot on the map can turn and find. Hang a suppressor on something and your
shots stop lighting up their minimap, at the cost of four metres of range; hang a foregrip on
it and the climb drops by a quarter, at the cost of twenty-four milliseconds of ADS — and the
panel prints the base and the resolved def side by side so you can see exactly what you traded.
Press Q and the pistol comes up in a quarter of a second, which is faster than reloading and is
the whole reason it exists. Hold G and a frag cooks in your hand with a bar under the crosshair
counting down; let go late and it goes off over their cover instead of at their feet, or hold
it too long and it goes off in your hand. Throw a smoke into a doorway and the bots on the
other side stop being able to see through it — actually stop, not visually — and start walking
to where they last heard you. Take a flashbang in the face and the screen goes white and the
world goes behind a wall of wool for three seconds; take one at ninety degrees and it is one
and a bit. Bots throw back, from Regular upward, and they check where their own grenade would
land before they let go. Press Esc and the match *pauses* now instead of ending, with the world
still there behind the glass and a button to open the overlay with a cursor that works. And
under F1 the whole arsenal is one screen: twelve recoil patterns overlaid on one plot, a real
shotgun shell drawn pellet by pellet and coloured by the zone each one found, a grenade arc
traced through the actual physics before you throw it, every sight line on the map drawn green
or red depending on whether smoke is stopping it — and a button that measures the entire
balance table and puts it on your clipboard.

---

