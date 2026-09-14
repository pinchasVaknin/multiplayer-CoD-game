<!-- Moved verbatim from PLAN.md lines 2837–2997 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# Post-M8, round 2 — the re-opened reports

A second QA pass on `m8-hotfixes`. Ten items: three bugs the first round was supposed to have
fixed and had not, three Search & Destroy flaws, three Chopper Gunner items, and the knife.

## The through-line

**Four of the ten were fixed in the wrong layer the first time.** Round one read each report
as a tuning problem and moved a number; in four cases the number was never what was wrong, and
moving it produced a build that looked identical to the one QA had already rejected. That is
worse than not fixing it, because it costs a whole playtest cycle to discover.

| Report | Round 1 changed | What it actually was |
|---|---|---|
| "Depot is pitch black" | hemisphere 0.62 -> 0.95 | The *colour* was near-black in linear space. Intensity was the wrong lever by a factor of five. |
| "Stuck on small stairs" | step height 0.35 -> 0.5 | The step-up sequence probed forward by one tick of walking instead of one capsule radius, and rejected every tread it tried. |
| "Structures jitter" | fixed the range's plates, added a polygon offset | Real, and not enough: coincident faces elsewhere, plus a depth buffer that may have been 16-bit. |
| "Gunship shows a black void" | rewrote the grey shader | The shader was fine. `scene.background` was force-clearing the colour and depth buffers between the three passes. |

The lesson is the same one round one drew about facts that disagree, one level up: **when a
fix does not take, the next move is to measure the thing, not to move the number further.**
Every claim in the verification table below is a measurement, and four of them are of things
that were never measured the first time.

## Every item, and what it was

**Depot lighting.** `0x323d50` looks like a usable slate blue in a swatch and is linear
`(0.032, 0.047, 0.078)` — fourteen times darker than Foundry's fill. A 53% intensity bump on
that moves nothing an eye can see. The colours come up and the intensity comes back down; the
darkest surface in the yard goes from an 8-bit value of 10 to 54. The fog moved with it,
because a fog left at `0x151a22` would have put the far half of the map back where it started.

> **Corrected at round 4, and only the last sentence of the diagnosis is wrong.** The linear-space
> re-derivation above is right, and I re-checked its arithmetic before touching Depot again: the
> fill really was fourteen times darker and really is about 42% of Foundry's now. What the "10 to
> 54" describes is the **light**, not the picture. The surface it lands on — the `asphalt` span
> that is the entire yard — returned 0.019 of it, so the ground itself measured a mean of **4.4
> out of 255** on this tree, before round 4 touched anything. That is why the report came back a
> third time, and it is why the paragraph's closing claim about the fog is the only part of this
> fix that reached the player. The lesson this section already draws — *when a fix does not take,
> measure the thing rather than moving the number further* — is exactly right and was applied one
> level too high: the thing to measure was the pixel, not the lamp. See "reading the fight" under
> round 4, and `npm run readability`, which exists so the next round starts from a number.

**Step offset.** Rise, advance, drop is the classic three-sweep step-up and it works on an
*axis-aligned box*, whose flat underside is over a tread the moment it nudges forward. A
capsule's underside is a hemisphere and is only over a tread once its centre has passed the
lip — a full radius, 0.35 m, against a walking tick of 0.075 m. So the drop clipped the
tread's top corner, whose contact normal is outside `maxSlopeDeg`, so de-penetration pushed
the capsule back off it. Net progress zero, `steppedUp` reported true, velocity restored:
silently, every tick, for as long as forward was held. Measured headless, the shipped 0.5 m
config cleared *nothing* — a 0.30 m step blocked a walking capsule for three seconds. The
probe is a radius now; the acceptance test also checks the landing actually got somewhere.

**Z-fighting.** Two causes, both addressed. Coincident faces were found by scanning all four
maps for same-facing coplanar pairs — 122 of them, of which the ones on surfaces a player can
see were: Depot's shed roof (2.75 m2 at `y = 6`, which is what the gantry and the gunship look
down at), the gantry deck against the container cap and the leg tops at `y = 5.20`, the
stacked containers' sides, Dunes' perch parapets, and the range's pit trim. Fixed at source.
The rest are undersides on the ground, faces outside the playable volume, or geometry buried
inside other solids. Separately, the depth buffer: `stencil: false` lets a driver hand back
`DEPTH_COMPONENT16`, which across a 0.05-400 m frustum cannot separate a 1 cm trim lip from
its wall at combat range. Stencil is requested and the near plane is 0.12 m; measured 24-bit,
0.05 mm of depth resolution at 10 m.

**Search & Destroy.** Three separate faults.

- *The sites were in the attackers' half.* `swapAfterRound` and `SpawnSelector`'s swap are
  driven from the same constant, so the attacking end never changes — it is always the `-Z`
  end. Sites therefore belong at `+Z`, always, and do not move with the swap. They did not
  move before either; they were simply at the wrong end, in both rounds.
- *The bomb spawned at the far end after half-time.* It averaged the spawn zones of the
  attacking *team*, and after the swap that team plays out of the other team's zones. It also
  averaged in the deep fallback zones past the centre line. Maps now author a `bombspawn`
  point; nearest attacker spawn to it, measured live, 0.7 m.
- *The score was inverted.* `MatchFlow.swapSides` called `score.swapTeams()`, so the round
  Team B won before half-time was showing against Team A after it. `'A'` and `'B'` name teams
  of players, not ends of a map — nothing else about a swap moves with the ends, and
  `PlayerScore.team` does not change either. Measured before the fix: a 1-1 match reported
  2-0 and ended a round early.

**Chopper Gunner.** The grey world and the invisible team-mates were one line. Three passes
share one colour and depth buffer, which needs no clear between them — but `scene.background`
holding a `Color` makes three's background stage set `forceClear` and call `renderer.clear`
*regardless* of `autoClear`. Every pass wiped the one before it, so the player saw the last
pass only: orange enemies on a flat background. The optic's sky is the renderer's clear colour
now and the scene background is nulled for the duration. Two more: the override material
ignored `instanceMatrix`, so every crate, container and pillar collapsed onto the origin — on
Depot the containers *are* the map; and the belt, 50 rounds with a 2.4 s feed, because at 900
rpm the only bound on the streak's damage was its own timer and there was no decision in it.

**The knife.** Round one shipped melee as a weapon bash and said a second viewmodel was a lot
of machinery for a half-second arc. It is not: a knife has no magazine, no charging handle, no
muzzle and no sights, so it is one static group and one three-pose arc. The strike keyframe
sits at 0.222 through the swing because that is where `Melee`'s wind-up ends — the blade is
extended on the one frame the hitbox test runs, which is the only contract an animation owes a
hit. The state machine is untouched.

## Deviations, and why

**The range's accuracy wall is removed, not relocated.** It is 7.2 m wide, which is 3.6 m of
half-width, and at 25 m in that room there is no lateral that does not shadow the penetration
bay, the 40 m dummy or the bullseyes. The report called it irrelevant and it is: the bullseyes
do the same job with scoring rings on them.

**The bullseye boards are narrower.** 2.0 m -> 1.4 m. Three boards at 10/16/22 m cannot be
fanned inside the free lateral band without shadowing each other, which is exactly how the
post-M8 pass ended up putting two of them inside the north wall. A smaller face is the price
of three that are all usable from the firing line.

**Two barriers and a crate moved on the testbed.** They were cover props standing between the
firing line and four targets. The range is measured from one spot; things in front of it are
not cover, they are the report.

## Verification

Typecheck and production build clean. The four headless harnesses below were driven through
`esbuild` against the real modules; the live figures came from `__operator` in the browser
(the pane does not composite in this environment, so there are no screenshots and rAF never
fires — the same constraint round one worked under).

| Claim | Measured |
|---|---|
| Step-up, before | 0.30 m step **blocked** a walking capsule for 3 s; `steppedUp` fired 115 times |
| Step-up, after | 0.30-0.70 m cleared in 1-2 ticks, walking and sprinting; 0.75 m correctly refused |
| Effective step ceiling | 0.70 m (corner climb above `stepHeight` 0.55) — stated, not assumed |
| Depot fill, sky | linear 0.044 -> 0.250 (x5.7), 42% of Foundry |
| Depot fill, ground | linear 0.021 -> 0.112 (x5.2) |
| Depot key | linear 0.279 -> 0.517 (x1.9) |
| Darkest yard surface | 10/255 -> 54/255 after ACES at 1.25 exposure |
| Depth buffer | 24-bit + 8 stencil, 4x MSAA, near 0.12 m |
| Depth resolution | 0.002 mm at 2 m, 0.050 mm at 10 m, 0.79 mm at 40 m |
| Coincident faces | 122 -> 86; every remaining pair is buried, underground or out of bounds |
| S&D score, before | B wins R1, A wins R2 -> reported **A 2 : B 0**, match ended a round early |
| S&D score, after | detonate / defuse / both eliminations, across the swap, all credited correctly |
| S&D bomb, R1 | (0, -28.33), attackers B — their own base |
| S&D bomb, R2 (swapped) | (0, -28.33), attackers A — **still** their own base |
| Nearest attacker spawn to bomb | 0.7 m |
| S&D sites | z = +20 and +16 on Depot; 5.4 m and 6.1 m from a defender spawn |
| Range targets | 15/15 clear of geometry; 13/15 fully visible from the firing line |
| Range, the two partials | ankles behind the 0.9 m bay divider; penetration dummies behind their panels, by design |
| Bullseye boards | were at z = -18.6 and -17.6 against a wall face at -18; now 0.6 m clear |
| Knife | builds and merges to three meshes, one per shared surface |

## Left for the human

1. **All of it, on a screen.** Nothing here was seen rendered — the pane does not composite in
   this environment. The lighting, the gunship and the knife are argued from numbers and
   source, and the numbers are the honest part; whether Depot still reads as *night* at 5.7x
   the fill, whether a team-mate at 0.05-0.20 luminance reads as a team-mate at 60 m, and
   whether the slash sells are three judgements no measurement makes.
2. **The gunship belt.** 50 rounds and 2.4 s is a first guess at "a decision without being an
   annoyance". `StreakConfig.chopperMagSize` and `chopperReloadSeconds`.
3. **Step height 0.55 m.** The sequence is fixed, so this is now genuinely a feel number.
4. **The S&D decider.** Sides swap once, after round one, so Team A attacks in rounds two and
   three. That matches the genre and it is still a one-sided decider; worth a look before M9.
5. **The narrower bullseyes.** 1.4 m is wide enough for a rifle group at 22 m. A shotgun
   pattern will overhang it, and the wall that used to catch that is gone.

---

