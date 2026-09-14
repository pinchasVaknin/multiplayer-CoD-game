<!-- Moved verbatim from PLAN.md lines 2998–3131 at 29533b2 (2026-09-14). Part of the OPERATOR plan record; PLAN.md holds the index. -->
# Post-M8, round 3 — the regression, and two things that were never measured

Three items. One is a regression round 2 introduced, and the other two are round-2 fixes that
were aimed at the wrong thing — which is the same failure round 2 itself diagnosed, so it is
worth being blunt about it: **round 2 fixed four things by measuring them and two things by
reasoning about them, and the two it reasoned about are the two that came back.**

## 1. Wall-strafing super speed — the regression

Round 2 changed the step-up's forward probe from one tick of walking to one capsule radius,
because a capsule is only over a tread once its centre has passed the lip. That is right. What
it got wrong is that **a probe is a query and round 2 let its answer become the move.**

The sequence was attempted whenever the horizontal pass lost a millimetre of the requested
distance, which sliding along a wall does on every tick forever. It was then accepted whenever
the drop found walkable ground no lower than the start — which the floor the player was already
standing on satisfies. So it fired every tick, and each time it advanced the capsule by the
full probe distance, 0.355 m, instead of the 0.077 m a walking tick asks for.

Measured, walking into a flat wall at 45°: **20.59 m/s against a walk speed of 4.6**, with the
step-up firing on 120 of 120 ticks. Up an 18° ramp: 7.25 m/s.

The two bad cases fail for different reasons and no single test catches both, so there are two
gates:

```
                     achieved / desired      climbed
  real step               0.00 - 0.39      0.25 - 0.51 m
  wall, 45° into it       0.77 - 0.97      0.005 m
  ramp, walking up        0.91 - 0.99      0.05 - 0.11 m
```

- `STEP_BLOCKED_FRACTION` at 0.5 — a step *stops* you, a wall or a ramp only shaves you. This
  is what excludes ramps, which genuinely gain height and pass any climb test.
- an actual climb, above `MIN_STEP_RISE` — this is what excludes walls, which block hard
  enough to pass the first gate when you run at them steeply but climb five millimetres.

`sim.blockedHorizontally` keeps its old looser meaning, because `PlayerController` reads it for
the sprint auto-vault and that is a question about touching something, not about being stopped.

## 2. The jitter, which was probably never z-fighting

Round 2 answered "structures jitter" with a 24-bit depth buffer, a raised near plane and a
coincident-face sweep. The report came back unchanged, so this round measured instead of
reasoning again, and the depth explanation does not survive it:

- the buffer **is** 24-bit on the reporting machine, resolving 0.002 mm at 2 m and 0.050 mm at
  10 m — two to three orders of magnitude finer than the 1-2 cm a trim lip stands proud;
- the round-2 face sweep had a large blind spot: it skipped every rotated brush and every
  rotated prop placement. Redone with oriented boxes and plane clipping, and then filtered by
  whether the space just outside each face is actually open, the count on the two maps QA plays
  is **zero on Foundry and zero on Depot**. The twenty survivors are the testbed's wall
  exteriors and Dunes' 11 m skyline trim, none of which a player can see;
- decals cannot fight: `depthWrite: false`.

What was left is the step-up above. Pressed against a wall it ran three sweeps and took their
result **every tick**, so the camera was being re-seated every tick from a de-penetration chain
that lands a few millimetres differently each time. That is a per-tick camera wobble, and a
camera wobble is *most* visible on whatever is closest — which is exactly the shape of the
report, "when the player gets right up close to them". Measured against a wall, a ramp and a
corner, the unrequested per-tick camera movement is now identical to the step-up-disabled
baseline to the last digit.

Two changes went in alongside it. The near plane goes 0.12 -> 0.20 m because QA asked for it
and it is free — but it is not what fixed anything, and the note in `CameraRig` says so. And
`normalBias` now scales with the shadow tier: the distance it has to cover is one shadow texel,
a texel is `2 * extent / size`, so the **low** tier was running half a texel of bias on every
map. That is the textbook acne case — a fine moving speckle over large surfaces, worst at
grazing angles — and it is the one remaining thing in the renderer that flickers. Now 1.05
texels at every tier, verified live.

## 3. The knife was drawn behind the camera

The three-pose arc was fine; the poses were in the wrong coordinate space. The bash they
replaced was an *offset* on the rifle's pose, so its numbers were small displacements about a
weapon already at `hipZ = -0.33`. The keyframes kept that scale and lost the base:

```
  READY   depth  0.02 m   frame ±0.02   fist at (0.30, -0.26)   13.2x the half-width off frame
  WINDUP  depth -0.12 m   -> behind the camera, never drawn
  STRIKE  depth  0.40 m   frame ±0.45   fist at (-0.11, -0.02)  on screen
```

Only the strike instant was ever rasterised. The new poses keep the fist between 0.24 m and
0.46 m deep, where the frame is 0.28-0.53 m wide either side of centre; the fist is in frame on
61 of 61 sampled frames of the swing and sits 10% of the way from centre to the edge at the
strike. The strike yaw is 40° rather than 0 because a blade pointing straight down -Z is seen
end-on, which is a bright line and nothing else.

The model is also scaled 1.3x — 31 cm of blade rather than 24. Life size is the wrong size in
the corner of a screen; the rifle only gets away with it by being 700 mm long.

One bug fell out of driving the swing live: `Melee.fraction` is exactly 0 on the first tick of
a wind-up while `Melee.busy` is already true, and `poseKnife` early-returned on 0 — so the
first frame of the first swing of a match drew the blade at the viewmodel origin, *inside the
camera*. The blend reduces to `KNIFE_READY` at 0, so the early-out is simply gone.

## Verification

Typecheck and production build clean. Headless harnesses against the real modules, plus live
`__operator` reads in a running match.

| Claim | Measured |
|---|---|
| Wall 45°, before | **20.59 m/s** at a 4.6 walk speed; step-up fired 120/120 ticks |
| Wall 45°, after | 4.33 m/s, 0 step-ups |
| Ramp up, before / after | 7.25 -> 4.11 m/s, 0 step-ups |
| Ramp diagonal, before / after | 7.21 -> 4.35 m/s, 0 step-ups |
| Step-up on vs off | identical to the last digit on every wall, ramp, corner and open-ground case |
| Tactical sprint | 6.53-7.95 m/s everywhere, under the 8.2 cap, on and off identical |
| Camera wobble vs baseline | identical to step-up-disabled on wall, diagonal wall, corner and ramp |
| Steps still climb | 0.30 / 0.45 / 0.55 / 0.70 m cleared at walk *and* tactical sprint; 0.75 refused |
| Coincident faces, oriented + exposure-filtered | Foundry **0**, Depot **0**; 20 survivors all outside the playable volume |
| Depth buffer | 24-bit + 8 stencil, near 0.20 m, 0.002 mm at 2 m / 0.050 mm at 10 m |
| Shadow bias across tiers | was 0.53 / 1.05 / 2.10 texels; now 1.05 / 1.05 / 1.05 |
| Knife keyframes, before | READY 13.2x off frame; WINDUP behind the camera |
| Knife keyframes, after | fist in frame 61/61 frames; 10% from centre at the strike; 31 cm blade |
| Knife lifecycle, live | idle: rifle shown, knife hidden. First tick: knife at `READY`, rifle hidden. After: rifle back |

## Left for the human

1. **The jitter, again, and this is the one that matters.** The step-up wobble is the only
   candidate left standing and it is gone, but it was never seen on a screen from here — the
   preview pane does not composite in this environment. If anything still flickers, the next
   question is *what kind*: a hard per-pixel flicker that changes with camera angle is depth,
   a fine speckle that crawls on large surfaces is shadow acne, and a whole-image judder is the
   camera. They are three different bugs and knowing which one halves the work.
2. **`STEP_BLOCKED_FRACTION` at 0.5.** The measured gap is 0.39 to 0.77, so there is room
   either side, but a map with a very shallow ramp into a wall is the case that would squeeze
   it.
3. **The knife's 1.3x scale and 40° strike yaw.** Both are looks, not logic.

---

