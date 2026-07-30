# OPERATOR — Balance

The reference for every future tuning argument (brief S6.5).

Every number below was **measured**, not calculated. `debug/ArsenalHarness.ts` drives a real
`WeaponSystem` through a real `Ballistics` into a real `DamageSystem` against a real
`TargetDummy` wearing the shared `HUMANOID_RIG`, and counts sim ticks. Nothing here
reimplements a damage rule in order to check it — if this table and the game ever disagree,
the table is the thing that is wrong.

Reproduce it:

```bash
npm run dev
```

then, in the browser console:

```js
fetch('/verify/arsenal.js').then(r => r.text()).then(eval)
__verifyArsenal.balance()      // the table, as a console table and as Markdown
__operator.balanceTable()      // just the Markdown, ready to paste back over this file
```

The debug overlay has a **MEASURE BALANCE TABLE** button in the *Arsenal* panel that runs
the same measurement and copies the Markdown to the clipboard.

---

## How to read it

Each cell is `seconds / trigger pulls`. The clock starts on **the first round that lands on
a full-health target** and stops on the one that drops it, so a one-shot kill is `0.000 / 1`
— the weapon needed no time at all, only one pull. A dash means the weapon could not kill
inside six seconds of continuous fire, which is a real result and not a failure to measure.

The shotgun's cells carry a second figure, `(Np)`: one shell is one trigger pull and eight
independent hitscan rays, and reporting "6 shots" for a single one-shot kill would be
describing the pellets rather than the weapon.

### What is held constant

- **Spread and recoil are zeroed for the measurement.** A TTK table answers *how fast can
  this weapon kill*, not *how likely is it to*. Leaving the cone in would make every figure
  a distribution and this a different document. Recoil still shapes the fight — it is what
  the pattern plots in the F1 overlay are for — but it does not belong in this table.
- **The pellet cone is not zeroed.** A shotgun's spread *is* the weapon. Its dash at 25 m is
  the honest answer, and it is exactly the spikiness S6.5 asks to be verified.
- **Health regeneration is off** for the target, so a slow weapon is measured against 100 HP
  rather than against 100 HP plus whatever came back while it was firing.
- **Reloads count.** A weapon that empties its magazine before it kills keeps firing through
  the reload, because that is what actually happens.
- Every shot is aimed at the centre of the chest box or the head box, from the eye, aimed
  down sights.

---

## Chest (upper torso)

| Weapon | Class | RPM | 5 m | 15 m | 25 m | 40 m |
|---|---|---:|---:|---:|---:|---:|
| M4 CARBINE | AR | 700 | 0.167 / 3 | 0.167 / 3 | 0.167 / 3 | 0.250 / 4 |
| VULCAN 74 | AR | 620 | 0.183 / 3 | 0.183 / 3 | 0.183 / 3 | 0.283 / 4 |
| HALCYON B5 | AR | 820 | 0.133 / 3 | 0.133 / 3 | 0.217 / 4 | 0.217 / 4 |
| LONGBOW MK3 | AR | 480 | 0.250 / 3 | 0.250 / 3 | 0.250 / 3 | 0.250 / 3 |
| WASP 9 | SMG | 1000 | 0.117 / 3 | 0.233 / 5 | 0.350 / 7 | 0.350 / 7 |
| MERIDIAN P40 | SMG | 780 | 0.150 / 3 | 0.217 / 4 | 0.383 / 6 | 0.383 / 6 |
| BREACHER 12 | SHOTGUN | 90 | 0.000 / 1 (6p) | 1.983 / 4 (16p) | — | — |
| BASTION 249 | LMG | 650 | 0.183 / 3 | 0.183 / 3 | 0.183 / 3 | 0.267 / 4 |
| MONOLITH 60 | LMG | 800 | 0.217 / 4 | 0.217 / 4 | 0.217 / 4 | 0.217 / 4 |
| KESTREL .338 | SNIPER | 48 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 |
| VANTAGE SR | SNIPER | 200 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 |
| TALON 9 | PISTOL | 400 | 0.450 / 4 | 0.450 / 4 | 0.600 / 5 | 0.600 / 5 |

## Head

| Weapon | Class | RPM | 5 m | 15 m | 25 m | 40 m |
|---|---|---:|---:|---:|---:|---:|
| M4 CARBINE | AR | 700 | 0.083 / 2 | 0.083 / 2 | 0.083 / 2 | 0.167 / 3 |
| VULCAN 74 | AR | 620 | 0.083 / 2 | 0.083 / 2 | 0.083 / 2 | 0.183 / 3 |
| HALCYON B5 | AR | 820 | 0.067 / 2 | 0.067 / 2 | 0.133 / 3 | 0.133 / 3 |
| LONGBOW MK3 | AR | 480 | 0.117 / 2 | 0.117 / 2 | 0.117 / 2 | 0.117 / 2 |
| WASP 9 | SMG | 1000 | 0.117 / 3 | 0.167 / 4 | 0.283 / 6 | 0.283 / 6 |
| MERIDIAN P40 | SMG | 780 | 0.150 / 3 | 0.150 / 3 | 0.300 / 5 | 0.300 / 5 |
| BREACHER 12 | SHOTGUN | 90 | 0.650 / 2 (5p) | 3.317 / 6 (15p) | — | — |
| BASTION 249 | LMG | 650 | 0.083 / 2 | 0.083 / 2 | 0.083 / 2 | 0.183 / 3 |
| MONOLITH 60 | LMG | 800 | 0.150 / 3 | 0.150 / 3 | 0.150 / 3 | 0.150 / 3 |
| KESTREL .338 | SNIPER | 48 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 |
| VANTAGE SR | SNIPER | 200 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 |
| TALON 9 | PISTOL | 400 | 0.300 / 3 | 0.300 / 3 | 0.450 / 4 | 0.450 / 4 |

The shotgun's head column is *worse* than its chest column at close range, which looks
backwards and is not: aiming at a head puts most of the cone past the silhouette, so fewer
pellets land. Aiming a shotgun at the chest is correct play and the table says so.

---

## Does anything dominate all ranges?

No. Every band has a different winner, and every winner loses another band.

| Band | Fastest chest kill | What it gives up |
|---|---|---|
| 0–7 m | **WASP 9**, 0.117 s | 0.350 s past 18 m — a lost fight |
| 7–15 m | **HALCYON B5**, 0.133 s | 4-shot past 15 m, worst AR falloff |
| 15–25 m | **CARBINE / BASTION**, 0.167 / 0.183 s | the BASTION's 0.42 s ADS and 4 s reload |
| 25–40 m | **LONGBOW MK3**, 0.250 s flat | slowest AR rate, hardest pattern to hold |
| any range, one shot | **KESTREL / VANTAGE** | 0.35–0.44 s scope-in, glint, sway, 48–200 RPM |

The two spiky classes behave the way S6.5 asks:

- **BREACHER 12** one-shots inside 6 m (6 of 8 pellets, 111.6 damage measured), needs four
  shells at 15 m, and cannot kill at all past its 13 m falloff end. The whole weapon is one
  band wide.
- **KESTREL .338 / VANTAGE SR** one-shot the chest at every range on this map, which is what
  "one-shot to upper torso" means — and pay for it with a 48/200 RPM cycle, the worst hip
  spread in the game (6.5° / 5.4°), a scope glint every enemy can see, and breath sway.

The ARs are the baseline: three of the four sit between 0.167 s and 0.250 s across the whole
table, and nothing else is that flat.

### Why "upper torso" and not "torso"

The M2 hitbox rig already splits the torso into a `chest` box and an `abdomen` box. M5 added
`upperTorsoMult` on the `WeaponDef`, applied to the chest only, and only the two snipers set
it away from 1.0 — so every M2-verified number is untouched. A KESTREL round to the gut does
98 and does *not* kill; the same round 30 cm higher does 112.7 and does. That distinction is
the whole of S6.1's sniper requirement.

---

## Attachments

Measured on the M4 CARBINE by `ArsenalHarness.measureAttachments`, which resolves the def
and reads the numbers back off it. The laser figure additionally comes out of a live
`WeaponSystem.spreadDeg` — the same value the crosshair and the ballistics use.

| Attachment | Benefit (measured) | Cost (measured) |
|---|---|---|
| HYBRID OPTIC | ADS cone 0.180° → **0.130°** (−0.050°, −28%) | ADS **280.0 → 319.2 ms** (**+39.2 ms**) |
| SUPPRESSOR | No minimap ping on fire | Falloff end **42.0 → 37.8 m** (−10%) |
| EXTENDED MAG | Magazine **30 → 45** (+50%) | Reload **2.050 → 2.563 s** (+25%) |
| VERTICAL FOREGRIP | Vertical recoil scale **1.00 → 0.75** (−25%) | ADS **280.0 → 304.3 ms** (**+24.3 ms**) |
| TACTICAL LASER | Hip cone **1.900° → 1.520°** (**−0.380°**, −20%) | Dot visible to enemies while aimed |

Nothing in that table is free, and nothing in it is cosmetic. Resolution is a pure function
(`resolveWeaponDef`) verified by `verifyAttachmentPurity`: five checks, including writing
into one resolved def and confirming the value does not appear in a second def resolved from
the same base.

---

## The slide-cancel retune

S6.5 asks whether sliding into a room beats the fastest ADS in the arsenal now that TTK
exists, and to lengthen the lockout if it does. Both halves were measured.

### What was measured

| Figure | Before | After |
|---|---|---|
| Slide entry speed | 8.000 m/s | 8.000 m/s |
| Slide-to-fire, M4 CARBINE | 0.217 s | 0.217 s |
| Distance travelled before the weapon is up | 1.702 m | 1.702 m |
| Speed at the moment it can fire | 7.610 m/s | 7.610 m/s |
| Fastest ADS in the arsenal | 0.175 s (WASP 9) | 0.175 s (WASP 9) |
| Fastest sprint-out in the arsenal | **0.120 s** (TALON 9) | **0.180 s** (HALCYON B5) |
| Tactical-sprint lockout after a slide | 1.000 s | **1.250 s** |
| Peak sustained speed, 60 s adversarial chain | 7.943 m/s | **7.897 m/s** |
| Peak instantaneous speed | 8.200 m/s | 8.200 m/s |
| **Fireable fraction across a 30 s slide-cancel chain** | — | **0.000** |

### What it says

Two findings, and only one of them is about the lockout.

**The chained exploit does not exist.** Across thirty adversarial seconds of slide-cancel
chaining — 22 slides, 7.897 m/s peak sustained — the weapon is fireable on **zero** ticks.
Chaining requires continuous sprint, sprint lowers the weapon, and the 0.12 s slide segments
before each jump-cancel are shorter than any weapon's sprint-out time. A player moving at
7.9 m/s is a player who cannot shoot, which is precisely what the rule exists to guarantee.

**The single entry was 45 ms inside the fastest ADS, and it was not the lockout's fault.**
Firing while sliding became legal in M5 (the M4 playtest note), so `sprintOutTime` is now
also slide-out time. At 0.12 s and 0.13 s the TALON and the WASP came up *before* a defender
who chose to aim could finish a 0.175 s ADS. That 45 ms lived in the weapon defs, not in the
movement rule.

### What changed

- `slideTacLockout` **1.00 → 1.25 s**. The literal instruction, taken even though the
  measurement says chaining was already fully paid for. It costs a quarter second on a
  manoeuvre nobody can shoot out of, and it moved peak sustained speed from 7.943 to 7.897.
- `WASP 9`, `MERIDIAN P40` and `TALON 9` `sprintOutTime` → **0.18 s**, so that **no weapon in
  the arsenal becomes fireable out of a slide faster than the fastest ADS in it**. This is
  where the 45 ms actually was.

Structure untouched: the rule is still "a slide sets a tactical-sprint lockout and a slide
cooldown on exit, both measured from the end of the slide". Only numbers moved.

### The ceiling still bounds bot aim leading

`tacSprintSpeed` was **not** changed — the ceiling is still 8.2 m/s instantaneous and now
7.897 m/s sustained, slightly *below* what M3 measured. Bot lead is
`leadFraction × target velocity`, so a ceiling that did not rise cannot break a lead that
held at the old one. Re-verified in play: see PLAN.md's M5 verification table.

---

## Changes this pass made, and why

Each of these was a *measurement* finding — the first run of the table produced a number
that was wrong, and the def moved to fix it.

| Weapon | Change | Why |
|---|---|---|
| WASP 9 | RPM 900 → **1000**, falloff start 8 → 7 m | At 900 its 3-shot took 0.133 s and so did the HALCYON's. An assault rifle matching the fastest SMG inside the SMG's own band is the one thing an SMG must not lose. Now 0.117 s. |
| MERIDIAN P40 | near damage 30 → **34** | At 30 it was a 4-shot everywhere and therefore worse than the baseline carbine at every range including its own — an SMG with no band it wins. Now a 3-shot inside 12 m. |
| BREACHER 12 | far damage 4 → **7**, falloff end 14 → **13 m** | At 4 the shotgun could not kill *at all* at 15 m inside six seconds. Spiky is the design; a hard wall past which the weapon literally cannot win is a weapon nobody carries. |
| All weapons | `headshotMult` 2.0 → **1.45–1.95** | M2's own PLAN.md note: a 2.0x multiplier on an AR makes a two-shot headshot kill at 26 m for a 0.086 s TTK, and M5 was told to expect bringing it toward 1.3–1.5x once weapons exist that are *supposed* to one-shot. Snipers keep 1.8–1.95. |
